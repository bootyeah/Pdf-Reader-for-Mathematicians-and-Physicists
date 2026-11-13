"""Local HTTP integration coverage. Temporary config and fake keys only; no paid API calls."""
import copy
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api_manager
import api_settings as settings
import formula_bridge
import server


class Upstream(BaseHTTPRequestHandler):
    calls = []
    overrides = {}
    def log_message(self, *_):
        pass
    def do_GET(self):
        raw = json.dumps({'data': [{'id': 'local-model-a'}, {'id': 'local-model-b'}]}).encode()
        self.send_response(200); self.end_headers(); self.wfile.write(raw)
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append({'path': self.path, 'auth': self.headers.get('Authorization'), 'body': data})
        if data['model'] in self.overrides:
            response = self.overrides[data['model']]
            self.send_response(response.get('status', 200))
            self.send_header('Content-Type', 'text/event-stream' if 'sse' in response else 'application/json')
            self.end_headers()
            self.wfile.write(response['sse'].encode() if 'sse' in response else json.dumps(response['json']).encode())
        elif data['model'] in ('denied', 'busy'):
            self.send_response(401 if data['model'] == 'denied' else 429)
            self.end_headers()
            self.wfile.write(json.dumps({'error': {'message': self.headers.get('Authorization')}}).encode())
        elif data.get('stream'):
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
        else:
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'model': data['model'], 'choices': [{'message': {'content': '$1+1$'}}]}).encode())


class Reader(server.PDFReaderHandler):
    def log_message(self, *_):
        pass


class Fixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reader-api-test-')
        self.env = patch.dict(os.environ, {'PDF_READER_API_CONFIG': str(Path(self.temp.name) / 'settings.json')})
        self.env.start()
        self.cloud = patch.object(server, '_cloud_config', return_value=dict(server.CLOUD_SYNC, enabled=False))
        self.cloud.start()
        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.reader = ThreadingHTTPServer(('127.0.0.1', 0), Reader)
        self.manager = api_manager.ManagerServer()
        self.url = 'http://127.0.0.1:%s' % self.upstream.server_port
        doc = settings.legacy_document()
        for fid, cfg in doc['features'].items():
            cfg.update(base_url=self.url + '/v1', api_key='test-key-' + fid, key_source='',
                       model='model-' + fid, fallback_model='', models=[], thinking='omit')
        doc['features']['chat']['models'] = ['choice-chat']
        self.doc = settings.save_document(doc, 'legacy')
        for httpd in (self.upstream, self.reader, self.manager):
            threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def close(self):
        for sid in list(formula_bridge._sessions):
            formula_bridge._close(sid)
        for httpd in (self.upstream, self.reader, self.manager):
            httpd.shutdown(); httpd.server_close()
        self.cloud.stop(); self.env.stop(); self.temp.cleanup()


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.close)
        Upstream.calls.clear()
        Upstream.overrides.clear()

    def request(self, path, data=None, manager=False, headers=None, method=None):
        base = self.fx.manager.origin if manager else 'http://127.0.0.1:%s' % self.fx.reader.server_port
        hdr = {'Content-Type': 'application/json'}
        if manager:
            hdr['X-Manager-Token'] = self.fx.manager.token
        hdr.update(headers or {})
        req = urllib.request.Request(base + path, headers=hdr, method=method,
                                     data=json.dumps(data).encode() if data is not None else None)
        try:
            response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw and 'application/json' in response.headers.get('Content-Type', '') else raw

    def update(self, fid, **changes):
        doc = settings.load_document()
        doc['features'][fid].update(changes)
        return settings.save_document(doc, doc['revision'])

    def test_plaintext_roundtrip_atomic_backup_restore_and_conflict(self):
        status, data = self.request('/api/config', manager=True)
        self.assertEqual(status, 200)
        self.assertEqual(data['document']['features']['chat']['api_key'], 'test-key-chat')
        self.assertEqual(data['document']['features']['chat']['resolved_key'], 'test-key-chat')
        original = settings.load_document()
        public = data['document']
        public['features']['chat']['model'] = 'new-model'
        public['features']['chat']['api_key'] = 'new-test-key'
        status, saved = self.request('/api/save', {'document': public}, manager=True)
        self.assertEqual(status, 200)
        self.assertEqual(saved['document']['features']['chat']['api_key'], 'new-test-key')
        self.assertEqual(saved['document']['features']['chat']['resolved_key'], 'new-test-key')
        self.assertEqual(settings.load_document()['features']['dictionary'], original['features']['dictionary'])
        self.assertEqual(self.request('/api/save', {'document': public}, manager=True)[0], 400)
        status, restored = self.request('/api/restore', {'revision': saved['document']['revision']}, manager=True)
        self.assertEqual(status, 200)
        self.assertEqual(settings.load_document()['features'], original['features'])

    def test_invalid_config_never_overwrites_and_shared_key_cycles(self):
        raw = settings.config_path().read_bytes()
        for changes in ({'temperature': float('nan')}, {'base_url': 'https://x/v1?key=secret'},
                        {'timeout': 0}, {'api_key': 'header\ninjection'}, {'model': ''}):
            with self.assertRaises(settings.ConfigError):
                self.update('chat', **changes)
            self.assertEqual(settings.config_path().read_bytes(), raw)
        self.update('formula_alt', key_source='chat')
        self.assertEqual(settings.resolve('formula_alt', {})['api_key'], 'test-key-chat')
        with self.assertRaises(settings.ConfigError):
            self.update('chat', key_source='formula_alt')

    def test_clear_key_and_recover_damaged_file_from_manager(self):
        public = settings.public_document(settings.load_document())
        public['features']['chat']['api_key'] = ''
        self.assertEqual(self.request('/api/save', {'document': public}, manager=True)[0], 200)
        self.assertEqual(settings.resolve('chat', {})['api_key'], '')
        settings.config_path().write_text('{ broken', encoding='utf-8')
        status, data = self.request('/api/config', manager=True)
        self.assertEqual(status, 200); self.assertIn('recovery', data)
        status, restored = self.request('/api/restore', {'revision': data['document']['revision']}, manager=True)
        self.assertEqual(status, 200)
        self.assertEqual(settings.resolve('chat', {})['api_key'], 'test-key-chat')

    def test_retry_uses_configured_fallback_without_retrying_bad_keys(self):
        for fid, path, body in [('chat', '/api/chat', {'messages': [{'role': 'user', 'content': 'test'}]}),
                                ('translation', '/api/translate', {'text': 'test', 'mode': 'sentence'})]:
            self.update(fid, model='busy', fallback_model='fallback-test')
            status, result = self.request(path, body)
            self.assertEqual(status, 200)
            self.assertEqual([c['body']['model'] for c in Upstream.calls[-2:]], ['busy', 'fallback-test'])
            self.update(fid, model='denied')
            count = len(Upstream.calls)
            status, result = self.request(path, body)
            self.assertEqual(status, 502)
            self.assertEqual(len(Upstream.calls), count + 1)
            self.assertNotIn('test-key-', json.dumps(result))

    def test_manager_origin_host_token_and_static_secrets(self):
        for headers in ({'X-Manager-Token': ''}, {'Origin': 'https://evil.test'}, {'Host': 'evil.test'}):
            self.assertEqual(self.request('/api/config', manager=True, headers=headers)[0], 403)
        self.assertEqual(self.request('/settings.json', manager=True)[0], 404)
        self.assertEqual(self.request('/api/save', {}, manager=True, headers={'Origin': 'null'})[0], 403)
        for path in ('/server.py', '/%73erver.py', '/.api-manager/settings.json', '/airtex/config.json', '/cloud_config.json'):
            self.assertEqual(self.request(path)[0], 403, path)
            self.assertEqual(self.request(path, method='HEAD')[0], 403, path)
        path = '/api/read-file?path=' + urllib.parse.quote(str(settings.config_path()))
        self.assertEqual(self.request(path)[0], 403)
        for path in ('/', '/index.html', '/LOCALPdfReader.html'):
            self.assertEqual(self.request(path)[0], 200)
            self.assertEqual(self.request(path, method='HEAD')[0], 200)

    def test_probe_uses_unsaved_draft_vision_and_redacts_upstream(self):
        public = settings.public_document(settings.load_document())
        public['features']['chat'].update(model='draft-model', api_key='draft-test-key')
        status, result = self.request('/api/test', {'feature': 'chat', 'document': public}, manager=True)
        self.assertEqual(status, 200); self.assertTrue(result['ok'])
        self.assertEqual(Upstream.calls[-1]['body']['model'], 'draft-model')
        self.assertEqual(Upstream.calls[-1]['auth'], 'Bearer draft-test-key')
        self.assertEqual(settings.load_document()['features']['chat']['model'], 'model-chat')
        public['features']['chat']['model'] = 'denied'
        _, result = self.request('/api/test', {'feature': 'chat', 'document': public}, manager=True)
        self.assertFalse(result['ok']); self.assertNotIn('draft-test-key', json.dumps(result))
        _, result = self.request('/api/test', {'feature': 'formula_image', 'document': public}, manager=True)
        self.assertTrue(result['ok'])
        self.assertEqual(Upstream.calls[-1]['body']['messages'][0]['content'][1]['type'], 'image_url')
        _, result = self.request('/api/models', {'feature': 'chat', 'document': public}, manager=True)
        self.assertEqual(result['models'], ['local-model-a', 'local-model-b'])

    def test_chat_hot_reload_stream_custom_models_and_parameters(self):
        self.update('chat', model='custom-chat', base_url=self.fx.url + '/v1/chat/completions',
                    temperature=0.45, max_tokens=123, prompt='custom prompt')
        status, cfg = self.request('/api/ai-config')
        self.assertEqual(status, 200); self.assertEqual(cfg['model'], 'custom-chat')
        self.assertNotIn('test-key', json.dumps(cfg))
        body = {'messages': [{'role': 'user', 'content': 'hello'}], 'model': 'old-cached-model'}
        status, result = self.request('/api/chat', body)
        self.assertEqual(status, 200)
        req = Upstream.calls[-1]
        self.assertEqual(req['path'], '/v1/chat/completions')
        self.assertEqual(req['body']['model'], 'custom-chat')
        self.assertEqual(req['body']['temperature'], 0.45)
        self.assertEqual(req['body']['max_tokens'], 123)
        self.assertEqual(req['body']['messages'][0]['content'], 'custom prompt')
        self.assertNotIn('thinking', req['body'])
        self.update('chat', api_key='rotated-test-key')
        status, raw = self.request('/api/chat', dict(body, model='choice-chat', stream=True))
        self.assertEqual(status, 200); self.assertIn(b'"delta": "ok"', raw)
        self.assertEqual(Upstream.calls[-1]['auth'], 'Bearer rotated-test-key')
        self.assertEqual(Upstream.calls[-1]['body']['model'], 'choice-chat')

    def test_dictionary_and_translation_use_distinct_configuration(self):
        for mode, fid in [('word', 'dictionary'), ('sentence', 'translation')]:
            self.update(fid, model=fid + '-new', temperature=0.25, prompt='prompt ' + fid, thinking='enabled')
            status, result = self.request('/api/translate', {'text': 'example', 'mode': mode})
            self.assertEqual(status, 200)
            req = Upstream.calls[-1]
            self.assertEqual(req['auth'], 'Bearer test-key-' + fid)
            self.assertEqual(req['body']['model'], fid + '-new')
            self.assertEqual(req['body']['messages'][0]['content'], 'prompt ' + fid)
            self.assertEqual(req['body']['thinking'], {'type': 'enabled'})

    def test_automatic_temperature_follows_actual_model_across_ai_paths(self):
        self.update('chat', model='GLM-5.3-Flash', models=['Kimi-K3.1-Pro'], temperature=None, thinking='high')
        message = {'messages': [{'role': 'user', 'content': 'hello'}]}
        for model, expected in [('GLM-5.3-Flash', 1.0), ('Kimi-K3.1-Pro', None)]:
            status, _ = self.request('/api/chat', dict(message, model=model))
            self.assertEqual(status, 200)
            self.assertEqual(Upstream.calls[-1]['body'].get('temperature'), expected)
            if expected is None:
                self.assertNotIn('temperature', Upstream.calls[-1]['body'])
        # A fallback must get its own recommendation, not retain the primary's temperature.
        self.update('chat', model='busy', fallback_model='GLM-5.3-Flash', temperature=None)
        status, _ = self.request('/api/chat', dict(message, stream=True))
        self.assertEqual(status, 200)
        self.assertEqual(Upstream.calls[-1]['body']['temperature'], 1.0)
        self.update('chat', fallback_model='gemini-4-argon', temperature=0.3)
        status, _ = self.request('/api/chat', message)
        self.assertEqual(status, 200)
        self.assertNotIn('temperature', Upstream.calls[-1]['body'])
        for mode, fid in [('word', 'dictionary'), ('sentence', 'translation')]:
            self.update(fid, model='GLM-5.3-Flash', temperature=None)
            status, _ = self.request('/api/translate', {'text': 'example', 'mode': mode})
            self.assertEqual(status, 200)
            self.assertEqual(Upstream.calls[-1]['body']['temperature'], 1.0)
        for fid in ('formula_image', 'formula_handwriting', 'formula_alt'):
            self.update(fid, model='GLM-5.3-Flash', temperature=None)
        stroke = {'w': 200, 'h': 100, 'strokes': [{'k': 'pen', 'w': 4, 'p': [[10, 10], [100, 70]]}]}
        for kind, engine in [('image', ''), ('handwriting', ''), ('image', 'deepseek')]:
            status, _ = self.request('/api/formula/recognize', {
                'kind': kind, 'engine': engine, 'image': api_manager.test_image(), 'doc': stroke})
            self.assertEqual(status, 200)
            self.assertEqual(Upstream.calls[-1]['body']['temperature'], 1.0)
        for model in ('Kimi-K3.1-Pro', 'gemini-4-argon', 'gemini-3.8-flash'):
            self.update('chat', model=model, fallback_model='', temperature=0.2)
            doc = settings.public_document(settings.load_document())
            status, result = self.request('/api/test', {'feature': 'chat', 'document': doc}, manager=True)
            self.assertEqual(status, 200)
            self.assertTrue(result['ok'])
            self.assertNotIn('temperature', Upstream.calls[-1]['body'])

    def test_formula_model_labels_hot_reload_without_resetting_chat_revision(self):
        status, initial = self.request('/api/ai-config')
        self.assertEqual(status, 200)
        self.assertEqual(initial['formula_models']['formula_alt'], 'model-formula_alt')
        self.update('formula_alt', model='Kimi-K3.1-Pro')
        status, updated = self.request('/api/ai-config')
        self.assertEqual(status, 200)
        self.assertEqual(updated['formula_models']['formula_alt'], 'Kimi-K3.1-Pro')
        self.assertEqual(updated['revision'], initial['revision'])
        self.assertEqual(set(updated['formula_models']), {'formula_image', 'formula_handwriting', 'formula_alt'})

    def test_temperature_policy_validation_and_manual_values(self):
        doc = settings.load_document()
        doc['features']['chat']['temperature'] = None
        settings.validate(doc)
        for bad in (True, float('nan'), -1, 2.1, 'auto'):
            doc['features']['chat']['temperature'] = bad
            with self.assertRaises(settings.ConfigError):
                settings.validate(doc)
        for model, configured, thinking, expected in [
            ('GLM-5.3-Flash', None, 'max', 1.0),
            ('GLM-5.3-Flash', 0, 'max', 0),
            ('private-model', None, 'omit', None),
            ('private-model', 0.35, 'omit', 0.35),
            ('Kimi-K3.1-Pro', 0.2, 'max', None),
            ('gemini-4-argon', 0.2, 'high', None),
            ('gemini-3.8-flash', None, 'high', None),
            ('gemini-3.1-pro-preview', None, 'high', 1.0),
            ('gpt-5', 0.2, 'high', None),
            ('gpt-5.4', 0.2, 'high', None),
            ('gpt-5.4', 0.2, 'disabled', 0.2),
        ]:
            with self.subTest(model=model, configured=configured, thinking=thinking):
                payload = settings.apply_parameters({'model': model, 'temperature': 0.7}, {
                    'temperature': configured, 'thinking': thinking})
                self.assertEqual(payload.get('temperature'), expected)
                if expected is None:
                    self.assertNotIn('temperature', payload)
        status, policy = self.request('/api/temperature', {'model': 'GLM-5.3-Flash', 'thinking': 'max'}, manager=True)
        self.assertEqual(status, 200)
        self.assertEqual(policy['value'], 1.0)

    def test_all_formula_paths_and_live_phone_refresh(self):
        image = api_manager.test_image()
        doc = {'w': 200, 'h': 100, 'strokes': [{'k': 'pen', 'w': 4, 'p': [[10, 10], [100, 70]]}]}
        for kind, fid in [('image', 'formula_image'), ('handwriting', 'formula_handwriting')]:
            self.update(fid, temperature=0.35, max_tokens=99)
            status, result = self.request('/api/formula/recognize', {'kind': kind, 'image': image, 'doc': doc})
            self.assertEqual(status, 200); self.assertTrue(result['ok'])
            req = Upstream.calls[-1]
            self.assertEqual(req['body']['model'], 'model-' + fid)
            self.assertEqual(req['body']['max_tokens'], 99)
            self.assertNotIn('thinking', req['body'])
        self.update('formula_alt', key_source='chat')
        status, result = self.request('/api/formula/recognize', {'kind': 'image', 'image': image, 'engine': 'deepseek'})
        self.assertEqual(status, 200); self.assertEqual(result['model'], 'model-formula_alt')
        self.assertEqual(Upstream.calls[-1]['auth'], 'Bearer test-key-chat')
        from airtex import core
        with patch.object(core, 'get_lan_ips', return_value=['127.0.0.1']):
            status, pair = self.request('/api/formula/phone', {'action': 'start'})
        self.assertEqual(status, 200)
        entry = formula_bridge._sessions[pair['session']]
        self.update('formula_handwriting', model='phone-after-save')
        # Invoke the phone worker without a reader state poll: refresh must happen at request start.
        entry['server'].app._recognize_worker(doc)
        self.assertEqual(Upstream.calls[-1]['body']['model'], 'phone-after-save')
        self.request('/api/formula/phone', {'action': 'state', 'session': pair['session'], 'engine': 'deepseek'})
        self.update('formula_alt', model='alt-after-save')
        entry['server'].app._recognize_worker(doc)
        self.assertEqual(Upstream.calls[-1]['body']['model'], 'alt-after-save')

    def test_thinking_mode_adaptation_for_kimi_glm_gemini_and_deepseek(self):
        p = settings.apply_parameters({'model': 'Kimi-K3.1-Pro'}, {'thinking': 'low'})
        self.assertEqual(p['reasoning_effort'], 'low')
        self.assertNotIn('thinking', p)
        self.assertNotIn('chat_template_kwargs', p)
        p_gemini = settings.apply_parameters({'model': 'gemini-4-argon'}, {'thinking': 'high'})
        self.assertEqual(p_gemini['reasoning_effort'], 'high')
        self.assertNotIn('thinking', p_gemini)
        p_glm = settings.apply_parameters({'model': 'GLM-5.3-Flash'}, {'thinking': 'max'})
        self.assertEqual(p_glm['thinking']['type'], 'enabled')
        self.assertEqual(p_glm['reasoning_effort'], 'max')
        for model, unsupported in [('Kimi-K3.1-Pro', 'disabled'), ('GLM-5.3-Flash', 'medium'),
                                   ('GLM-5.3-Flash', 'disabled'), ('gemini-4-argon', 'max'),
                                   ('gemini-4-argon', 'disabled'), ('gpt-5', 'max')]:
            with self.subTest(model=model, mode=unsupported), self.assertRaises(settings.ConfigError):
                settings.apply_parameters({'model': model}, {'thinking': unsupported})
        for model, level in [('gpt-5', 'minimal'), ('gpt-5.4', 'xhigh'), ('gpt-6-astra', 'max')]:
            p = settings.apply_parameters({'model': model}, {'thinking': level, 'max_tokens': 77})
            self.assertEqual(p['reasoning_effort'], level)
            self.assertEqual(p['max_completion_tokens'], 77)
            self.assertNotIn('max_tokens', p)
        p_omit = settings.apply_parameters({'model': 'Kimi-K3.1-Pro'}, {'thinking': 'omit'})
        self.assertNotIn('thinking', p_omit)
        self.assertNotIn('reasoning_effort', p_omit)
        self.assertNotIn('chat_template_kwargs', p_omit)

    def test_shared_prompts_displayed_and_effective(self):
        self.update('chat', prompt='Master Assistant Prompt')
        self.update('chat_gemini', prompt='')
        self.update('formula_handwriting', prompt='')
        self.update('formula_alt', prompt='')

        status, data = self.request('/api/config', manager=True)
        self.assertEqual(status, 200)
        feats = data['document']['features']

        # chat_gemini 留空时共用 chat 的生效提示词
        self.assertEqual(feats['chat_gemini']['effective_prompt'], 'Master Assistant Prompt')
        self.assertEqual(feats['chat_gemini']['prompt_source'], 'chat')

        # Handwriting keeps its native mode-aware prompt; the alternate image path inherits image.
        self.assertTrue(bool(feats['formula_handwriting']['effective_prompt']))
        self.assertEqual(feats['formula_handwriting']['prompt_source'], '内置识别提示词')
        self.assertIn('电脑', feats['formula_handwriting']['effective_prompt'])
        self.assertEqual(feats['formula_alt']['prompt_source'], 'formula_image')

    def test_prompt_preview_matches_image_pc_phone_and_whiteboard_requests(self):
        from airtex import core
        self.update('formula_image', prompt='CUSTOM_IMAGE_PROMPT')
        self.update('formula_handwriting', prompt='')
        self.update('formula_alt', prompt='')
        draft = settings.public_document(settings.load_document())
        draft['features']['formula_image']['prompt'] = 'UNSAVED_IMAGE_PROMPT'
        status, preview = self.request('/api/prompt-preview', {
            'document': draft, 'feature': 'formula_alt', 'context': 'image'}, manager=True)
        self.assertEqual(status, 200)
        self.assertEqual(preview['text'], 'UNSAVED_IMAGE_PROMPT')
        stroke = {'w': 200, 'h': 100, 'strokes': [{'k': 'pen', 'w': 4, 'p': [[10, 10], [100, 70]]}]}
        saved = settings.load_document()
        for fid, engine in [('formula_handwriting', ''), ('formula_alt', 'deepseek')]:
            for context, kind, purpose in [('image', 'image', ''), ('pc', 'handwriting', ''), ('whiteboard', 'handwriting', 'whiteboard')]:
                if fid == 'formula_handwriting' and context == 'image':
                    continue
                preview = settings.prompt_preview(saved, fid, context)
                status, result = self.request('/api/formula/recognize', {
                    'kind': kind, 'engine': engine, 'purpose': purpose, 'image': api_manager.test_image(), 'doc': stroke})
                self.assertEqual(status, 200, result)
                sent = Upstream.calls[-1]['body']['messages'][0]['content'][0]['text']
                self.assertEqual(preview['text'], sent)
            cfg = formula_bridge._config('handwriting')
            cfg = formula_bridge._apply_engine(cfg, engine, settings.resolve('formula_alt', {}))
            self.assertEqual(settings.prompt_preview(saved, fid, 'phone')['text'], core.build_prompt(cfg, 'phone'))

    def test_kimi_history_survives_validation_and_is_filtered_on_model_switch_and_fallback(self):
        self.update('chat', model='Kimi-K3.1-Pro', models=['GLM-5.3-Flash'], thinking='high', max_tokens=700)
        messages = [{'role': 'user', 'content': 'one'},
                    {'role': 'assistant', 'content': ' answer \n', 'reasoning_content': ' preserved reasoning \n', '_reader_model': 'Kimi-K3.1-Pro'},
                    {'role': 'user', 'content': 'two'}]
        for model, keep in [('Kimi-K3.1-Pro', True), ('GLM-5.3-Flash', False)]:
            status, result = self.request('/api/chat', {'messages': messages, 'model': model})
            self.assertEqual(status, 200, result)
            sent = Upstream.calls[-1]['body']['messages'][2]
            self.assertEqual(sent['content'], ' answer \n')
            self.assertEqual('reasoning_content' in sent, keep)
            self.assertNotIn('_reader_model', sent)
            if keep:
                self.assertEqual(sent['reasoning_content'], messages[1]['reasoning_content'])
                self.assertEqual(Upstream.calls[-1]['body']['max_completion_tokens'], 700)
                self.assertNotIn('max_tokens', Upstream.calls[-1]['body'])
        Upstream.overrides['Kimi-K3.1-Pro'] = {'status': 503, 'json': {'error': {'code': 'overloaded'}}}
        self.update('chat', fallback_model='GLM-5.3-Flash')
        status, result = self.request('/api/chat', {'messages': messages})
        self.assertEqual(status, 200)
        self.assertEqual(result['model'], 'GLM-5.3-Flash')
        self.assertNotIn('reasoning_content', Upstream.calls[-1]['body']['messages'][2])
        self.assertEqual(Upstream.calls[-1]['body']['max_tokens'], 700)
        self.assertNotIn('max_completion_tokens', Upstream.calls[-1]['body'])

    def test_stream_checks_finish_reasons_empty_body_and_incomplete_eof(self):
        self.update('chat', model='stream-test')
        def event(obj):
            return 'data: ' + json.dumps(obj) + '\n\n'
        delta = event({'choices': [{'delta': {'content': 'partial answer'}}]})
        for suffix, expected in [
            (event({'choices': [{'delta': {}, 'finish_reason': 'length'}]}), 'token'),
            ('', '提前结束'),
            (event({'choices': [{'delta': {'refusal': 'refused'}, 'finish_reason': 'stop'}]}), '拒绝'),
            (event({'choices': [{'delta': {'tool_calls': [{'id': 'a'}]}, 'finish_reason': 'tool_calls'}]}), '工具调用'),
            ('data: malformed\n\n', '解析'),
        ]:
            Upstream.overrides['stream-test'] = {'sse': delta + suffix}
            status, raw = self.request('/api/chat', {'messages': [{'role': 'user', 'content': 'test'}], 'stream': True})
            self.assertEqual(status, 200)
            self.assertIn(expected, raw.decode())
            self.assertNotIn(b'"done": true', raw)
        Upstream.overrides['stream-test'] = {'sse': event({'choices': [{'delta': {'reasoning_content': 'thinking'}}]}) + 'data: [DONE]\n\n'}
        _, raw = self.request('/api/chat', {'messages': [{'role': 'user', 'content': 'test'}], 'stream': True})
        self.assertIn('未返回正文', raw.decode())
        self.assertNotIn(b'"done": true', raw)
        Upstream.overrides['stream-test'] = {'sse': delta + event({'choices': [{'delta': {}, 'finish_reason': 'stop'}]}) + event({'choices': [], 'usage': {'completion_tokens': 17}}) + 'data: [DONE]\n\n'}
        _, raw = self.request('/api/chat', {'messages': [{'role': 'user', 'content': 'test'}], 'stream': True})
        self.assertIn(b'"completion_tokens": 17', raw)
        self.assertIn(b'"done": true', raw)

    def test_probe_omit_uses_reasoning_budget_and_reports_incomplete_separately(self):
        self.update('chat', model='Kimi-K3.1-Pro', thinking='omit', max_tokens=0)
        Upstream.overrides['Kimi-K3.1-Pro'] = {'json': {'choices': [{'message': {'content': None, 'reasoning_content': 'thinking'}, 'finish_reason': 'length'}]}}
        for configured, expected in [(0, 4096), (96, 96)]:
            self.update('chat', max_tokens=configured)
            status, result = self.request('/api/test', {'feature': 'chat', 'document': settings.public_document(settings.load_document())}, manager=True)
            self.assertEqual(status, 200)
            self.assertTrue(result['ok'])
            self.assertTrue(result['connected'])
            self.assertFalse(result['complete'])
            self.assertIn(str(expected), result['warning'])
            self.assertNotIn('关闭思考', result['warning'])
            self.assertEqual(Upstream.calls[-1]['body']['max_completion_tokens'], expected)
            self.assertNotIn('max_tokens', Upstream.calls[-1]['body'])

    def test_unsupported_search_fails_before_request_without_offline_retry(self):
        for fid, path, body in [('chat', '/api/chat', {'messages': [{'role': 'user', 'content': 'test'}]}),
                                ('translation', '/api/translate', {'text': 'test', 'mode': 'sentence'})]:
            self.update(fid, model='Kimi-K3.1-Pro', thinking='high', web_search=True, fallback_model='some-fallback')
            count = len(Upstream.calls)
            status, result = self.request(path, body)
            self.assertEqual(status, 502)
            self.assertIn('联网搜索', result['error'])
            self.assertEqual(len(Upstream.calls), count)
        supported = dict(model='GLM-5.3-Flash', base_url='https://open.bigmodel.cn/api/paas/v4', web_search=True)
        self.assertEqual(settings.protocol.apply_search({}, supported)['tools'], [{'type': 'web_search', 'web_search': {'enable': True}}])
        for url in ['https://gateway.example/v1', 'https://api.z.ai/api/coding/paas/v4']:
            with self.assertRaises(ValueError):
                settings.protocol.apply_search({}, dict(supported, base_url=url))

    def test_chat_and_translation_reject_incomplete_answers_and_do_not_retry_quota(self):
        for fid, path, body in [('chat', '/api/chat', {'messages': [{'role': 'user', 'content': 'test'}]}),
                                ('translation', '/api/translate', {'text': 'test', 'mode': 'sentence'})]:
            self.update(fid, model='reply-test', fallback_model='unused-fallback')
            for content, reason in [(None, 'stop'), ('partial', 'length'), ('', 'stop')]:
                Upstream.overrides['reply-test'] = {'json': {'choices': [{'message': {'content': content}, 'finish_reason': reason}]}}
                count = len(Upstream.calls)
                status, result = self.request(path, body)
                self.assertEqual(status, 502)
                self.assertFalse(result['ok'])
                self.assertEqual(len(Upstream.calls), count + 1)
            Upstream.overrides['reply-test'] = {'status': 429, 'json': {'error': {'code': 'insufficient_quota', 'message': 'quota exhausted'}}}
            count = len(Upstream.calls)
            status, result = self.request(path, body)
            self.assertEqual(status, 502)
            self.assertEqual(len(Upstream.calls), count + 1)

    def test_ocr_response_validation_and_bounded_overload_fallback(self):
        stroke = {'w': 200, 'h': 100, 'strokes': [{'k': 'pen', 'w': 4, 'p': [[10, 10], [100, 70]]}]}
        for kind, fid in [('image', 'formula_image'), ('handwriting', 'formula_handwriting')]:
            self.update(fid, model='ocr-test', fallback_model='ocr-fallback')
            body = {'kind': kind, 'image': api_manager.test_image(), 'doc': stroke}
            for status, code, retry in [(429, '', True), (503, '', True), (401, '', False), (429, '1308', False), (429, 'insufficient_quota', False)]:
                Upstream.overrides['ocr-test'] = {'status': status, 'json': {'error': {'code': code, 'message': 'test error'}}}
                count = len(Upstream.calls)
                _, result = self.request('/api/formula/recognize', body)
                self.assertEqual(result['ok'], retry, (kind, status, code, result))
                self.assertEqual(len(Upstream.calls) - count, 2 if retry else 1)
            for content, reason in [(None, 'stop'), (None, 'length'), ('$partial$', 'length'), (None, 'content_filter')]:
                Upstream.overrides['ocr-test'] = {'json': {'choices': [{'message': {'content': content}, 'finish_reason': reason}]}}
                count = len(Upstream.calls)
                _, result = self.request('/api/formula/recognize', body)
                self.assertFalse(result['ok'])
                self.assertNotIn('None', result['error'])
                self.assertEqual(len(Upstream.calls), count + 1)

    def test_max_tokens_route_cap_disable_thinking_and_fallback_adaptation(self):
        self.update('chat', model='busy', fallback_model='GLM-5.3-Flash', thinking='high', max_tokens=100000)
        # /api/chat must not silently clamp max_tokens at 65536 when API Manager allows up to 1,000,000.
        status, result = self.request('/api/chat', {
            'messages': [{'role': 'user', 'content': 'hi'}],
            'thinking': False,
            'max_tokens': 100000,
        })
        self.assertEqual(status, 200)
        self.assertEqual(result['model'], 'GLM-5.3-Flash')
        last_body = Upstream.calls[-1]['body']
        self.assertEqual(last_body['max_tokens'], 100000)
        self.assertEqual(last_body['thinking'], {'type': 'enabled'})
        self.assertEqual(last_body['reasoning_effort'], 'low')
        # Strict validation still rejects incompatible primary configuration.
        with self.assertRaises(settings.ConfigError):
            settings.apply_parameters({'model': 'GLM-5.3-Flash'}, {'thinking': 'disabled'})
        # Verify disable_thinking polarity in Reader._call_deepseek.
        handler = Reader.__new__(Reader)
        handler._active_translate_config = settings.resolve('dictionary', {})
        handler._active_translate_config['thinking'] = 'disabled'
        handler._call_deepseek([{'role': 'user', 'content': 'hello'}], disable_thinking=True)
        self.assertEqual(Upstream.calls[-1]['body']['thinking'], {'type': 'disabled'})
        handler._call_deepseek([{'role': 'user', 'content': 'hello'}], disable_thinking=False)
        self.assertEqual(Upstream.calls[-1]['body']['thinking'], {'type': 'enabled'})

    def test_unauthenticated_oversized_post_rejected_immediately(self):
        req = (
            f'POST /api/save HTTP/1.0\r\n'
            f'Host: 127.0.0.1:{self.fx.manager.server_port}\r\n'
            f'Content-Type: application/json\r\n'
            f'Origin: https://evil.test\r\n'
            f'Content-Length: 999999999\r\n\r\n{{}}'
        ).encode('ascii')
        with socket.create_connection(('127.0.0.1', self.fx.manager.server_port), timeout=3) as sock:
            sock.sendall(req)
            resp = sock.recv(1024)
        self.assertIn(b' 403 ', resp)


if __name__ == '__main__':
    if '--serve-fixture' in sys.argv:
        fixture = Fixture()
        print(json.dumps({'manager': fixture.manager.url, 'reader': 'http://127.0.0.1:%s' % fixture.reader.server_port}), flush=True)
        try:
            sys.stdin.read()
        finally:
            fixture.close()
    else:
        unittest.main()
