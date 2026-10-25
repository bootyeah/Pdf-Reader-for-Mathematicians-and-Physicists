"""真实 HTTP + 本地假视觉接口；不读取用户密钥、不调用外网模型。"""
import base64
import io
import json
import os
import sys
import threading
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import formula_bridge as bridge
import server
from server import PDFReaderHandler
from airtex import core, web
from tex import latex_ocr
from PIL import Image


class Upstream(BaseHTTPRequestHandler):
    requests = []
    auths = []
    reply = '```latex\n\\[x^2+y^2=1\\]\n```'
    def log_message(self, *_):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.requests.append(body)
        self.auths.append(self.headers.get('Authorization', ''))
        overloaded = body['model'] == 'busy-model'
        data = ({'error': {'code': '1305', 'message': 'busy'}} if overloaded else
                {'model': body['model'], 'choices': [{'message': {'content': self.reply}}]})
        raw = json.dumps(data).encode()
        self.send_response(429 if overloaded else 200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class QuietReader(PDFReaderHandler):
    access_logs = []
    def log_message(self, *_):
        self.access_logs.append(_)


class FormulaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # This suite tests legacy constants, independently of the user's manager settings.
        cls.config_dir = tempfile.TemporaryDirectory(prefix='formula-legacy-test-')
        cls.config_env = patch.dict(os.environ, {'PDF_READER_API_CONFIG': str(Path(cls.config_dir.name) / 'absent.json')})
        cls.config_env.start()
        cls.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        cls.reader = ThreadingHTTPServer(('127.0.0.1', 0), QuietReader)
        for server in (cls.upstream, cls.reader):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        cls.origin = 'http://127.0.0.1:%d' % cls.reader.server_port
        def config(kind):
            cfg = dict(latex_ocr.DEFAULT_CONFIG if kind == 'image' else core.DEFAULT_CONFIG)
            cfg.update(api_key='test-only', base_url='http://127.0.0.1:%d' % cls.upstream.server_port,
                       model='busy-model', fallback_model='test-fallback', debug_keep_png=False)
            return cfg
        cls.patches = [patch.object(bridge, '_config', config), patch.object(core, 'get_lan_ips', return_value=['127.0.0.1']),
                       patch.object(core, 'log'), patch.object(web, 'log'), patch.object(latex_ocr, 'log')]
        for p in cls.patches:
            p.start()
        buf = io.BytesIO()
        Image.new('RGB', (200, 80), 'white').save(buf, 'PNG')
        cls.image = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
        cls.doc = {'w': 400, 'h': 200, 'strokes': [{'k': 'pen', 'w': 4, 'p': [[10, 10], [100, 100]]}]}

    @classmethod
    def tearDownClass(cls):
        for sid in list(bridge._sessions):
            bridge._close(sid)
        for p in cls.patches:
            p.stop()
        for server in (cls.upstream, cls.reader):
            server.shutdown()
            server.server_close()
        cls.config_env.stop()
        cls.config_dir.cleanup()

    def request(self, url, data=None, headers=None):
        headers = headers or {}
        if data is not None:
            data = json.dumps(data).encode()
            headers.setdefault('Content-Type', 'application/json')
        req = urllib.request.Request(url, data=data, headers=headers)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            resp = opener.open(req, timeout=10)
        except urllib.error.HTTPError as error:
            resp = error
        with resp:
            body = resp.read()
            return resp.status, json.loads(body) if 'application/json' in resp.headers.get('Content-Type', '') else body

    def post(self, path, data):
        return self.request(self.origin + '/api/formula/' + path, data)

    def test_image_uses_tex_and_fallback(self):
        status, data = self.post('recognize', {'kind': 'image', 'image': self.image})
        self.assertEqual(status, 200)
        self.assertEqual(data['latex'], '$$x^2+y^2=1$$')
        self.assertEqual(data['model'], 'test-fallback')
        self.assertEqual([r['model'] for r in Upstream.requests[-2:]], ['busy-model', 'test-fallback'])
        self.assertNotIn('test-only', json.dumps(data))

    def test_handwriting_rasterizes_and_uses_airtex(self):
        status, data = self.post('recognize', {'kind': 'handwriting', 'doc': self.doc})
        self.assertEqual(status, 200)
        self.assertEqual(data['latex'], '$$x^2+y^2=1$$')
        self.assertIn('鼠标手写', Upstream.requests[-1]['messages'][0]['content'][0]['text'])
        status, data = self.post('recognize', {'kind': 'handwriting', 'doc': {}})
        self.assertFalse(data['ok'])
        self.assertTrue(data['empty'])

    def phone_pair(self, **extra):
        """开一个手机配对会话，返回 (手机页地址前缀, token, 会话号)。"""
        _, session = self.post('phone', dict({'action': 'start'}, **extra))
        parsed = urllib.parse.urlsplit(session['urls'][0])
        return ('%s://%s' % (parsed.scheme, parsed.netloc),
                urllib.parse.parse_qs(parsed.query)['t'][0], session['session'])

    def test_successful_state_polls_are_quiet_but_operations_and_errors_are_logged(self):
        QuietReader.access_logs.clear()
        _, _, sid = self.phone_pair()
        try:
            self.assertEqual(len(QuietReader.access_logs), 1, 'Pairing is logged')
            self.assertEqual(self.post('phone', {'action': 'state', 'session': sid})[0], 200)
            self.assertEqual(len(QuietReader.access_logs), 1, 'Successful state query is quiet')
            self.assertEqual(self.post('phone', {'action': 'clear', 'session': sid})[0], 200)
            self.assertEqual(len(QuietReader.access_logs), 2, 'Explicit clear is logged')
            self.assertEqual(self.post('phone', {'action': 'state', 'session': 'invalid-session'})[0], 400)
            self.assertEqual(len(QuietReader.access_logs), 3, 'State query errors remain visible')
        finally:
            self.post('phone', {'action': 'close', 'session': sid})

    def test_deepseek_engine_switches_vision_model(self):
        """编辑框里的「DeepSeek」按钮：三条识别都改用 V4.1 Flash + 对话那支 Key。"""
        vision = {'base_url': 'http://127.0.0.1:%d' % self.upstream.server_port,
                  'model': 'deepseek-vision-test', 'fallback_model': ''}
        with patch.object(server, 'DEEPSEEK_VISION', vision), \
                patch.object(server, 'CHAT_API_KEY', 'chat-only-key'):
            _, data = self.post('recognize', {'kind': 'image', 'image': self.image,
                                              'engine': 'deepseek'})
            self.assertEqual(data['model'], 'deepseek-vision-test')
            self.assertEqual(Upstream.requests[-1]['model'], 'deepseek-vision-test')
            self.assertEqual(Upstream.auths[-1], 'Bearer chat-only-key')

            _, data = self.post('recognize', {'kind': 'handwriting', 'doc': self.doc,
                                              'engine': 'deepseek'})
            self.assertEqual(data['model'], 'deepseek-vision-test')

            # 手机配对：连接之后再按按钮（轮询每次都带上当前选择）同样要生效
            origin, token, sid = self.phone_pair(engine='deepseek')
            self.request(origin + '/api/update?t=' + token, {'doc': self.doc})
            self.post('phone', {'action': 'recognize', 'session': sid, 'engine': 'deepseek'})
            for _ in range(60):
                _, state = self.post('phone', {'action': 'state', 'session': sid,
                                               'engine': 'deepseek'})
                if not state['recognizing']:
                    break
                time.sleep(.05)
            self.assertEqual(state['result']['model'], 'deepseek-vision-test')
            # 再按一次切回 GLM：同一个会话立刻改回 config.json 里的模型
            self.post('phone', {'action': 'recognize', 'session': sid})
            for _ in range(60):
                _, state = self.post('phone', {'action': 'state', 'session': sid})
                if not state['recognizing']:
                    break
                time.sleep(.05)
            self.assertEqual(state['result']['model'], 'test-fallback')
            self.post('phone', {'action': 'close', 'session': sid})

            # 不按按钮（不带 engine）时，行为与以前完全一致：仍旧走 config.json
            _, data = self.post('recognize', {'kind': 'image', 'image': self.image})
            self.assertEqual(data['model'], 'test-fallback')
            self.assertEqual(Upstream.auths[-1], 'Bearer test-only')

    def test_phone_pairing_real_http_and_isolation(self):
        _, first = self.post('phone', {'action': 'start'})
        _, second = self.post('phone', {'action': 'start'})
        self.assertNotEqual(first['session'], second['session'])
        self.assertTrue(first['qr'].startswith('data:image/png;base64,'))
        parsed = urllib.parse.urlsplit(first['urls'][0])
        phone_origin = '%s://%s' % (parsed.scheme, parsed.netloc)
        token = urllib.parse.parse_qs(parsed.query)['t'][0]
        self.assertEqual(self.request(phone_origin + '/')[0], 403)
        self.assertEqual(self.request(first['urls'][0])[0], 200)
        self.assertEqual(self.request(phone_origin + '/api/state')[0], 403)
        status, update = self.request(phone_origin + '/api/update?t=' + token, {'doc': self.doc})
        self.assertTrue(update['accepted'])
        _, first_state = self.post('phone', {'action': 'state', 'session': first['session']})
        _, second_state = self.post('phone', {'action': 'state', 'session': second['session']})
        self.assertEqual(first_state['strokes'], 1)
        self.assertEqual(second_state['strokes'], 0)
        self.post('phone', {'action': 'recognize', 'session': first['session']})
        for _ in range(60):
            _, state = self.post('phone', {'action': 'state', 'session': first['session']})
            if not state['recognizing']:
                break
            time.sleep(.05)
        self.assertEqual(state['result']['latex'], '$$x^2+y^2=1$$')
        self.assertIn('手机上手写', Upstream.requests[-1]['messages'][0]['content'][0]['text'])
        self.post('phone', {'action': 'clear', 'session': first['session']})
        _, state = self.post('phone', {'action': 'state', 'session': first['session']})
        self.assertEqual(state['strokes'], 0)
        for data in (first, second):
            self.post('phone', {'action': 'close', 'session': data['session']})
            self.assertEqual(self.post('phone', {'action': 'state', 'session': data['session']})[0], 400)

    def test_internet_pairing_switch_retry_and_revision_preserve_board(self):
        class FakeTunnel:
            instances = []
            def __init__(self, port):
                self.port, self.stopped = port, False
                self.state = {'status': 'connecting', 'message': '正在建立互联网连接…', 'url': ''}
                self.instances.append(self)
            def start(self):
                pass
            def stop(self):
                self.stopped = True
            def snapshot(self):
                return dict(self.state)
        with patch.object(bridge, 'QuickTunnel', FakeTunnel):
            origin, token, sid = self.phone_pair(purpose='whiteboard')
            try:
                self.request(origin + '/api/update?t=' + token, {'doc': self.doc})
                _, answer = self.post('phone', {'action': 'connection', 'session': sid, 'connection': 'internet'})
                pending = answer['pairing']
                self.assertEqual(pending['urls'], [])
                self.assertEqual(pending['qr'], '')
                self.assertEqual(len(FakeTunnel.instances), 1)
                self.assertEqual(FakeTunnel.instances[0].port, urllib.parse.urlsplit(origin).port)
                FakeTunnel.instances[0].state.update(status='ready', message='手机可使用任意网络',
                                                     url='https://synthetic-board.trycloudflare.com')
                _, state = self.post('phone', {'action': 'state', 'session': sid, 'pairingRev': pending['pairingRev']})
                ready = state['pairing']
                self.assertGreater(ready['pairingRev'], pending['pairingRev'])
                self.assertEqual(ready['urls'][0], 'https://synthetic-board.trycloudflare.com/?t=' + token)
                self.assertTrue(ready['qr'].startswith('data:image/png;base64,'))
                self.assertEqual(state['doc']['strokes'], self.doc['strokes'])
                _, unchanged = self.post('phone', {'action': 'state', 'session': sid, 'pairingRev': ready['pairingRev']})
                self.assertNotIn('pairing', unchanged, 'Unchanged polls must not retransmit QR images')
                self.post('phone', {'action': 'connection', 'session': sid, 'connection': 'internet'})
                self.assertEqual(len(FakeTunnel.instances), 1, 'Repeated mode selection reuses the tunnel')
                _, answer = self.post('phone', {'action': 'connection', 'session': sid, 'connection': 'internet', 'retry': True})
                self.assertTrue(FakeTunnel.instances[0].stopped)
                self.assertEqual(len(FakeTunnel.instances), 2)
                self.assertEqual(answer['pairing']['urls'], [], 'Retry invalidates the old public QR')
                _, answer = self.post('phone', {'action': 'connection', 'session': sid, 'connection': 'lan'})
                self.assertTrue(FakeTunnel.instances[1].stopped)
                self.assertEqual(answer['pairing']['urls'][0], origin + '/?t=' + token)
                _, state = self.post('phone', {'action': 'state', 'session': sid})
                self.assertEqual(state['doc']['strokes'], self.doc['strokes'])
            finally:
                entry = bridge._sessions[sid]
                self.post('phone', {'action': 'close', 'session': sid})
                with self.assertRaises(ValueError):
                    bridge._set_connection(entry, 'internet')

    def test_internet_mode_start_validation_and_cleanup(self):
        from unittest.mock import MagicMock
        tunnel = MagicMock()
        tunnel.snapshot.return_value = {'status': 'error', 'message': '模拟隧道失败', 'url': ''}
        with patch.object(bridge, 'QuickTunnel', return_value=tunnel):
            status, data = self.post('phone', {'action': 'start', 'connection': 'internet'})
            self.assertEqual(status, 200)
            self.assertEqual(data['status'], 'error')
            self.assertEqual(data['urls'], [])
            self.assertNotIn('test-only', json.dumps(data))
            self.post('phone', {'action': 'close', 'session': data['session']})
            tunnel.stop.assert_called_once()
        count = len(bridge._sessions)
        status, _ = self.post('phone', {'action': 'start', 'connection': 'invalid'})
        self.assertEqual(status, 400)
        self.assertEqual(len(bridge._sessions), count)

    def test_phone_colors_survive_sync_and_render(self):
        origin, token, sid = self.phone_pair()
        try:
            strokes = [dict(self.doc['strokes'][0], c='#DC2626'),
                       {'k': 'pen', 'c': '#2563eb', 'w': 6, 'p': [[200, 100]]},
                       {'k': 'pen', 'c': 'invalid', 'w': 6, 'p': [[300, 100]]}]
            self.request(origin + '/api/update?t=' + token,
                         {'doc': dict(self.doc, strokes=strokes)})
            _, state = self.post('phone', {'action': 'state', 'session': sid})
            sanitized = state['doc']['strokes']
            self.assertEqual(sanitized[0]['c'], '#dc2626')
            self.assertEqual(sanitized[1]['c'], '#2563eb')
            self.assertNotIn('c', sanitized[2])
            image = core.rasterize(state['doc'], target_w=400, crop=False)
            self.assertEqual(image.getpixel((50, 50)), (220, 38, 38))
            self.assertEqual(image.getpixel((200, 100)), (37, 99, 235))
            self.assertEqual(image.getpixel((300, 100)), (17, 17, 17))
            erased = dict(state['doc'], strokes=sanitized + [
                {'k': 'eraser', 'c': '#dc2626', 'w': 10, 'p': [[200, 100]]}])
            self.assertEqual(core.rasterize(erased, target_w=400, crop=False).getpixel((200, 100)), (255, 255, 255))
        finally:
            self.post('phone', {'action': 'close', 'session': sid})

    def test_infinite_phone_coordinates_render_and_recognize(self):
        origin, token, sid = self.phone_pair()
        try:
            doc = {'w': 400, 'h': 200, 'infinite': True, 'strokes': [
                {'k': 'pen', 'c': '#dc2626', 'w': 8, 'p': [[-12500, -8300], [-12400, -8200]]},
                {'k': 'pen', 'c': '#2563eb', 'w': 8, 'p': [[12300, 9700], [12400, 9800]]}]}
            status, ack = self.request(origin + '/api/update?t=' + token, {'doc': doc})
            self.assertEqual(status, 200)
            self.assertTrue(ack['accepted'])
            _, state = self.post('phone', {'action': 'state', 'session': sid})
            self.assertEqual(state['doc'], doc, 'world coordinates must not be clamped to nominal w/h')
            for crop in (True, False):
                image = core.rasterize(state['doc'], crop=crop)
                self.assertIsNotNone(image)
                self.assertLessEqual(max(image.size), 2400, 'infinite coordinates never allocate an unbounded bitmap')
                colors = [color for _, color in image.getcolors(image.width * image.height)]
                self.assertTrue(any(r > g + 40 and r > b + 40 for r, g, b in colors))
                self.assertTrue(any(b > r + 40 and b > g + 40 for r, g, b in colors))
            # Cropped OCR depends on relative ink positions, not distance from the origin.
            shifted = dict(doc, strokes=[dict(s, p=[[x + 1000000, y - 1000000] for x, y in s['p']]) for s in doc['strokes']])
            self.assertEqual(core.rasterize(doc).tobytes(), core.rasterize(shifted).tobytes())
            bounded = core.sanitize_doc({k: v for k, v in doc.items() if k != 'infinite'})
            self.assertEqual(bounded['strokes'][0]['p'], [[0, 0], [0, 0]], 'legacy finite boards retain their bounds')
            self.assertEqual(bounded['strokes'][1]['p'], [[400, 200], [400, 200]])
            self.post('phone', {'action': 'recognize', 'session': sid})
            for _ in range(60):
                _, result = self.post('phone', {'action': 'state', 'session': sid})
                if not result['recognizing']:
                    break
                time.sleep(.05)
            self.assertTrue(result['result'])
            image_url = Upstream.requests[-1]['messages'][0]['content'][1]['image_url']['url']
            image = Image.open(io.BytesIO(base64.b64decode(image_url.split(',')[1])))
            expected_image = core.rasterize(doc)
            self.assertEqual(image.size, expected_image.size, 'OCR must retain the full world-coordinate layout')
            self.assertEqual(image.tobytes(), expected_image.tobytes(), 'colored boundary dots are not intact handwriting')
            colors = [color for _, color in image.getcolors(image.width * image.height)]
            self.assertTrue(any(r > g + 40 and r > b + 40 for r, g, b in colors))
            self.assertTrue(any(b > r + 40 and b > g + 40 for r, g, b in colors))
        finally:
            self.post('phone', {'action': 'close', 'session': sid})

    def test_phone_ocr_after_pan_and_zoom(self):
        # E=mc^2, with the complete formula outside the initial viewport.
        strokes = [
            {'k': 'pen', 'w': 4, 'p': [[100, 80], [100, 180], [170, 180]]},
            {'k': 'pen', 'w': 4, 'p': [[100, 80], [170, 80]]},
            {'k': 'pen', 'w': 4, 'p': [[100, 125], [160, 125]]},
            {'k': 'pen', 'w': 4, 'p': [[210, 115], [260, 115]]},
            {'k': 'pen', 'w': 4, 'p': [[210, 145], [260, 145]]},
            {'k': 'pen', 'w': 4, 'p': [[300, 170], [300, 110], [325, 140], [340, 110], [365, 170]]},
            {'k': 'pen', 'w': 4, 'p': [[435, 115], [410, 105], [390, 120], [390, 155], [410, 170], [435, 160]]},
            {'k': 'pen', 'w': 4, 'p': [[450, 70], [460, 60], [475, 65], [450, 90], [478, 90]]}]
        with patch.object(Upstream, 'reply', '$E=mc^2$'):
            for purpose in ('formula', 'whiteboard'):
                origin, token, sid = self.phone_pair(purpose=purpose)
                try:
                    for factor, dx, dy in ((.25, -12000, -9000), (16, 12000, 9000)):
                        doc = {'w': 1000, 'h': 700, 'infinite': True, 'strokes': [
                            dict(s, w=s['w'] * factor,
                                 p=[[x * factor + dx, y * factor + dy] for x, y in s['p']])
                            for s in strokes]}
                        _, ack = self.request(origin + '/api/update?t=' + token, {'doc': doc})
                        self.assertTrue(ack['accepted'])
                        for remote in (False, True):
                            with self.subTest(purpose=purpose, factor=factor, remote=remote):
                                if remote:
                                    _, accepted = self.request(origin + '/api/recognize?t=' + token, {'doc': doc})
                                    self.assertTrue(accepted['started'])
                                else:
                                    self.post('phone', {'action': 'recognize', 'session': sid})
                                for _ in range(80):
                                    _, state = self.post('phone', {'action': 'state', 'session': sid})
                                    if not state['recognizing']:
                                        break
                                    time.sleep(.05)
                                self.assertFalse(state['recognizing'])
                                self.assertEqual(state['result']['latex'], '$E=mc^2$')
                                image_url = Upstream.requests[-1]['messages'][0]['content'][1]['image_url']['url']
                                image = Image.open(io.BytesIO(base64.b64decode(image_url.split(',')[1])))
                                expected = core.rasterize(doc)
                                self.assertEqual(image.size, expected.size)
                                self.assertEqual(image.tobytes(), expected.tobytes(),
                                                 'desktop and phone OCR must see every formula stroke in its original layout')
                                self.assertEqual(state['doc'], doc)
                finally:
                    self.post('phone', {'action': 'close', 'session': sid})

    def test_infinite_document_snapshots(self):
        doc = {'w': 400, 'h': 200, 'infinite': True, 'strokes': [
            {'k': 'pen', 'w': 4, 'p': [[-12000, 9000], [-11900, 9050]]}]}
        app = web.AppCore(dict(core.DEFAULT_CONFIG))
        app.set_doc(doc)
        expected = deepcopy(doc)
        preview = app.active_doc()
        self.assertEqual(preview, expected)
        preview['strokes'][0]['p'][0][0] = 0
        self.assertEqual(app.snapshot()['doc'], expected, 'preview must not mutate the live document')
        entered, release = threading.Event(), threading.Event()
        captured = []
        def recognize(_cfg, snapshot, _mode):
            entered.set()
            release.wait(3)
            captured.append(snapshot)
            return {'ok': True, 'empty': False, 'latex': '$x=1$'}
        with patch.object(core, 'recognize_doc', side_effect=recognize):
            try:
                self.assertTrue(app.start_recognize())
                self.assertTrue(entered.wait(3))
                with app.lock:
                    app.doc['strokes'][0]['p'][0][0] = 0
            finally:
                release.set()
                if app._recog_thread:
                    app._recog_thread.join(3)
        self.assertEqual(captured, [expected], 'recognition must preserve metadata and an isolated copy of coordinates')
        app.clear(from_pc=True)
        self.assertTrue(app.active_doc()['infinite'])
        self.assertEqual(app.active_doc()['strokes'], [])
        app.set_mode(core.MODE_PC, save=False)
        self.assertNotIn('infinite', app.active_doc(), 'mouse handwriting keeps its finite canvas')

    def test_whiteboard_no_content_response(self):
        for reply in ('未检测到内容', '未检测到内容。', '未检测到内容！', '未检测到公式。', ''):
            with self.subTest(reply=reply), patch.object(Upstream, 'reply', reply):
                _, result = self.post('recognize', {'kind': 'handwriting', 'purpose': 'whiteboard', 'doc': self.doc})
                self.assertTrue(result['empty'])
                self.assertEqual(result['latex'], '')
                self.assertIn('内容', result['error'])
        with patch.object(Upstream, 'reply', '说明：未检测到内容。然后写下 $E=mc^2$。'):
            _, result = self.post('recognize', {'kind': 'handwriting', 'purpose': 'whiteboard', 'doc': self.doc})
            self.assertFalse(result['empty'], 'a phrase within real paragraph content is not a no-content sentinel')

    def test_long_phone_draft_and_acknowledged_order(self):
        origin, token, sid = self.phone_pair()
        try:
            stroke = {'k': 'pen', 'w': 3, 'p': [[100.25, 120.75], [125.25, 130.75]] * 45}
            doc = {'w': 400, 'h': 200, 'strokes': [stroke] * 4205 + [
                {'k': 'pen', 'w': 3, 'p': [[200.5, 150.25]] * 4501 + [[345.5, 155.25]]}]}
            payload = {'doc': doc, 'client': 'long-draft', 'updateId': 2, 'clearedSeq': 0}
            self.assertGreater(len(json.dumps(payload)), 4 * 1024 * 1024)
            status, ack = self.request(origin + '/api/update?t=' + token, payload)
            self.assertEqual(status, 200)
            self.assertTrue(ack['accepted'])
            _, state = self.post('phone', {'action': 'state', 'session': sid})
            self.assertEqual(len(state['doc']['strokes']), 4206)
            self.assertEqual(len(state['doc']['strokes'][-1]['p']), 4502)
            self.assertEqual(state['doc']['strokes'][-1]['p'][-1], [345.5, 155.25])
            _, unchanged = self.post('phone', {'action': 'state', 'session': sid, 'rev': state['rev']})
            self.assertNotIn('doc', unchanged)
            # A timed-out older write must not replace the newer acknowledged draft.
            self.request(origin + '/api/update?t=' + token,
                         {'doc': self.doc, 'client': 'long-draft', 'updateId': 1})
            self.assertEqual(bridge._sessions[sid]['server'].app.snapshot()['strokes'], 4206)
            self.post('phone', {'action': 'clear', 'session': sid})
            _, ack = self.request(origin + '/api/update?t=' + token,
                                 {'doc': self.doc, 'clearedSeq': 0, 'client': 'long-draft', 'updateId': 3})
            self.assertFalse(ack['accepted'])
            self.assertEqual(bridge._sessions[sid]['server'].app.snapshot()['strokes'], 0)
        finally:
            self.post('phone', {'action': 'close', 'session': sid})

    def test_whiteboard_current_page_and_late_recognition(self):
        origin, token, sid = self.phone_pair(purpose='whiteboard')
        app = bridge._sessions[sid]['server'].app
        page_a = self.doc
        page_b = {'w': 400, 'h': 200, 'strokes': [{'k': 'pen', 'w': 4, 'p': [[220, 80], [300, 140]]}]}
        started, release = threading.Event(), threading.Event()
        recognized = []
        def recognize(_cfg, doc, _mode):
            recognized.append(doc)
            started.set()
            release.wait(5)
            return {'ok': True, 'latex': '当前页文字', 'model': 'local-test', 'empty': False}
        def update(page_id, doc, version):
            return self.request(origin + '/api/update?t=' + token,
                                {'doc': doc, 'pageId': page_id, 'client': 'page-test', 'updateId': version})
        try:
            with patch.object(core, 'recognize_doc', side_effect=recognize):
                self.assertTrue(update('page-a', page_a, 1)[1]['accepted'])
                self.assertTrue(self.request(origin + '/api/recognize?t=' + token,
                                             {'pageId': 'page-a', 'doc': page_a})[1]['started'])
                self.assertTrue(started.wait(2))
                self.assertTrue(update('page-b', page_b, 2)[1]['accepted'])
                # 旧上传及旧识别请求都不能将当前页换回去。
                update('page-a', page_a, 1)
                state = app.snapshot()
                self.assertEqual(state['pageId'], 'page-b')
                self.assertEqual(state['doc'], page_b)
                self.assertIsNone(state['result'])
                self.assertNotIn('pages', state)
                self.assertFalse(self.request(origin + '/api/recognize?t=' + token,
                                              {'pageId': 'page-a', 'doc': page_a})[1]['started'])
                release.set(); app._recog_thread.join(2)
                self.assertFalse(app.snapshot()['recognizing'])
                self.assertIsNone(app.snapshot()['result'], '迟到的上一页结果必须丢弃')
                self.assertEqual(recognized, [page_a])
                # 电脑发起识别也只读取手机当前页。
                self.post('phone', {'action': 'recognize', 'session': sid})
                app._recog_thread.join(2)
                self.assertEqual(recognized[-1], page_b)
                self.assertEqual(app.snapshot()['result']['pageId'], 'page-b')
                update('page-a', page_a, 3)
                self.assertIsNone(app.snapshot()['result'])
                self.post('phone', {'action': 'clear', 'session': sid})
                self.assertEqual(app.snapshot()['pageId'], 'page-a')
                self.assertEqual(app.snapshot()['doc']['strokes'], [])
                self.assertEqual(page_b['strokes'][0]['p'][0], [220, 80])
        finally:
            release.set()
            self.post('phone', {'action': 'close', 'session': sid})

    def test_idle_cleanup_keeps_hidden_reader_and_active_phone(self):
        _, _, sid = self.phone_pair()
        entry = bridge._sessions[sid]
        entry['seen'] = time.monotonic() - 300
        bridge._reap_idle()
        self.assertIn(sid, bridge._sessions)
        entry['seen'] = time.monotonic() - 1900
        entry['server'].app.touch()
        bridge._reap_idle()
        self.assertIn(sid, bridge._sessions)
        entry['server'].app.online_ts = time.time() - 1900
        bridge._reap_idle()
        self.assertNotIn(sid, bridge._sessions)

    def test_whiteboard_paragraph_prompt_and_two_models(self):
        vision = {'base_url': 'http://127.0.0.1:%d' % self.upstream.server_port,
                  'model': 'deepseek-draft-test', 'fallback_model': '', 'prompt': 'FORMULA ONLY'}
        answer = '设 \\(x=1\\)，这是文字草稿。\n\n\\[y=x+2\\]'
        expected = '设 $x=1$，这是文字草稿。\n\n$$y=x+2$$'
        with patch.object(server, 'DEEPSEEK_VISION', vision), \
                patch.object(server, 'CHAT_API_KEY', 'test-draft-key'), \
                patch.object(Upstream, 'reply', '```latex\n' + answer + '\n```'):
            for engine in ('', 'deepseek'):
                origin, token, sid = self.phone_pair(purpose='whiteboard', engine=engine)
                try:
                    # Phone button uses the same independent paragraph prompt as desktop.
                    _, accepted = self.request(origin + '/api/recognize?t=' + token, {'doc': self.doc})
                    self.assertTrue(accepted['started'])
                    for _ in range(80):
                        _, state = self.post('phone', {'action': 'state', 'session': sid, 'engine': engine, 'purpose': 'formula'})
                        if not state['recognizing']:
                            break
                        time.sleep(.05)
                    self.assertEqual(state['result']['latex'], expected)
                    self.assertEqual(state['result']['model'], 'deepseek-draft-test' if engine else 'test-fallback')
                    prompt = Upstream.requests[-1]['messages'][0]['content'][0]['text']
                    self.assertEqual(prompt, bridge.WHITEBOARD_PROMPT)
                finally:
                    self.post('phone', {'action': 'close', 'session': sid})
            # Pure text is valid, and the ordinary formula path still uses its own prompt.
            with patch.object(Upstream, 'reply', '这是一段没有公式的草稿。'):
                _, res = self.post('recognize', {'kind': 'handwriting', 'purpose': 'whiteboard', 'doc': self.doc})
                self.assertEqual(res['latex'], '这是一段没有公式的草稿。')
            self.post('recognize', {'kind': 'handwriting', 'doc': self.doc})
            self.assertNotIn('相应段落', Upstream.requests[-1]['messages'][0]['content'][0]['text'])

    def test_capacity_error_keeps_previous_draft(self):
        app = web.AppCore(core.DEFAULT_CONFIG)
        app.set_doc(self.doc)
        with self.assertRaises(ValueError):
            app.set_doc({'w': 400, 'h': 200, 'strokes': self.doc['strokes'] * 50001})
        self.assertEqual(app.snapshot()['strokes'], 1)

    def test_validation_and_private_configs(self):
        self.assertEqual(self.post('recognize', {'kind': 'image', 'image': 'bad'})[0], 400)
        self.assertEqual(self.post('recognize', {'kind': 'other'})[0], 400)
        self.assertEqual(self.request(self.origin + '/api/formula/phone', {'action': 'start'}, {'Origin': 'http://evil.invalid'})[0], 403)
        for path in ('/tex/config.json', '/airtex/config.json', '/airtex/airtex.log', '/%74ex/config.json'):
            self.assertEqual(self.request(self.origin + path)[0], 403)


if __name__ == '__main__':
    unittest.main(verbosity=2)
