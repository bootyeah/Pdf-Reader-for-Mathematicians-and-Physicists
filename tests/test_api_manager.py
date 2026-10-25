"""Local HTTP integration coverage. Temporary config and fake keys only; no paid API calls."""
import copy
import io
import json
import os
from pathlib import Path
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
    def log_message(self, *_):
        pass
    def do_GET(self):
        raw = json.dumps({'data': [{'id': 'local-model-a'}, {'id': 'local-model-b'}]}).encode()
        self.send_response(200); self.end_headers(); self.wfile.write(raw)
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append({'path': self.path, 'auth': self.headers.get('Authorization'), 'body': data})
        if data['model'] in ('denied', 'busy'):
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
