"""Authenticated playback, credential persistence and Range proxy contracts (offline)."""
import http.cookiejar
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from email.message import Message
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from app.services import bilibili_service as bili
from app.services import online_video_service as online

BV = 'BV18j7NzZEve'
CDN = 'https://test.bilivideo.com/video.mp4?sign=test'


def cookie():
    return http.cookiejar.Cookie(0, 'SESSDATA', 'test-session-only', None, False,
        '.bilibili.com', True, True, '/', True, True, None, True, None, None, {})


def dash_payload():
    def track(quality, kind, height=0):
        return {'id': quality, 'baseUrl': CDN + '&track=' + kind + str(quality),
            'codecs': 'avc1.640033' if kind == 'video' else 'mp4a.40.2',
            'bandwidth': 100000 if kind == 'video' else 64000,
            'width': round(height * 16 / 9), 'height': height,
            'SegmentBase': {'Initialization': '0-999', 'indexRange': '1000-1999'}}
    return {'code': 0, 'data': {'quality': 80, 'timelength': 60000, 'dash': {'duration': 60,
        'video': [track(64, 'video', 720), track(80, 'video', 1080)],
        'audio': [track(30280, 'audio')]}}}


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}


class Reader(server.PDFReaderHandler):
    def log_message(self, *_):
        pass


class BilibiliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reader-bilibili-')
        self.patchers = [patch.object(bili, 'SESSION_FILE', Path(self.temp.name) / 'session.json'),
                         patch.object(bili, '_jar', http.cookiejar.CookieJar()),
                         patch.object(bili, '_streams', {}), patch.object(bili, '_qr', {})]
        # Stream registry needs insertion-order eviction, just like production.
        from collections import OrderedDict
        self.patchers[2] = patch.object(bili, '_streams', OrderedDict())
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.temp.cleanup)
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Reader)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.base = f'http://127.0.0.1:{self.httpd.server_port}'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, path='/api/bilibili', data=None, method=None, headers=None):
        req = urllib.request.Request(self.base + path, method=method, headers=headers or {},
                                     data=json.dumps(data).encode() if data is not None else None)
        try:
            response = self.opener.open(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def test_prepare_exposes_actual_quality_without_remote_url_or_cookie(self):
        bili._cookies().set_cookie(cookie())
        payload = {'code': 0, 'data': {'quality': 80, 'format': 'mp4', 'durl': [{'url': CDN}]}}
        with patch.object(bili, 'fetch_api', return_value=payload) as api:
            status, _, body = self.request(data={'action': 'play', 'bvid': BV, 'cid': 123, 'quality': 80})
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data['loggedIn'])
        self.assertEqual(data['qualityLabel'], '1080P')
        self.assertTrue(data['url'].startswith('/api/bilibili/media?token='))
        self.assertNotIn('test-session', body.decode())
        self.assertNotIn('bilivideo.com', body.decode())
        self.assertIn('qn=80', api.call_args.args[0])

    def test_guest_quality_is_honest_and_missing_cid_resolves(self):
        docs = [{'code': 0, 'data': {'pages': [{'cid': 42}]}},
                {'code': 0, 'data': {'dash': {}}},
                {'code': 0, 'data': {'quality': 64, 'format': 'mp4720', 'durl': [{'url': CDN}]}}]
        with patch.object(bili, 'fetch_api', side_effect=docs):
            data = bili.prepare({'bvid': BV, 'quality': 80})
        self.assertFalse(data['loggedIn'])
        self.assertEqual(data['qualityLabel'], '720P')

    def test_bilibili_login_media_and_short_links_ignore_dead_system_proxy(self):
        """Exercise real urllib handler selection, including a failing proxy control."""
        calls = []
        closed_proxy = 'http://127.0.0.1:1'
        allowed_hosts = {'api.bilibili.com', 'passport.bilibili.com', 'b23.tv',
                         'www.bilibili.com', 'test.bilivideo.com'}

        def fake_https(handler, request):
            if request.host not in allowed_hosts:
                raise urllib.error.URLError('Test proxy is stopped')
            calls.append(request)
            headers = Message()
            code = 200
            if 'qrcode/generate' in request.full_url:
                body = json.dumps({'code': 0, 'data': {'qrcode_key': 'direct-test',
                    'url': 'https://passport.bilibili.com/login?test=1'}}).encode()
            elif 'qrcode/poll' in request.full_url:
                body = b'{"code":0,"data":{"code":86101}}'
            elif request.host == 'b23.tv':
                code = 302
                headers['Location'] = 'https://www.bilibili.com/video/' + BV + '/'
                body = b''
            elif request.host == 'test.bilivideo.com':
                code = 206
                headers['Content-Range'] = 'bytes 0-4/100'
                body = b'video'
            else:
                body = b'{"code":0,"data":{"isLogin":false}}'
            headers['Content-Length'] = str(len(body))
            response = urllib.response.addinfourl(io.BytesIO(body), headers, request.full_url, code)
            response.msg = 'OK' if code != 302 else 'Found'
            return response

        with patch.dict(os.environ, {'HTTP_PROXY': closed_proxy, 'HTTPS_PROXY': closed_proxy, 'NO_PROXY': ''}), \
             patch.object(urllib.request, 'getproxies', return_value={'http': closed_proxy, 'https': closed_proxy}), \
             patch.object(urllib.request, 'proxy_bypass', return_value=False), \
             patch.object(urllib.request.HTTPSHandler, 'https_open', fake_https):
            with self.assertRaises(urllib.error.URLError):
                urllib.request.build_opener().open('https://passport.bilibili.com/test')
            qr = bili.login_start()
            self.assertTrue(qr['image'].startswith('data:image/png;base64,'))
            self.assertEqual(bili.login_poll(qr['token'])['state'], 'waiting')
            self.assertFalse(bili.account_status()['loggedIn'])
            with patch.object(bili, '_play_info', return_value=(CDN, {'quality': 80})):
                source = bili.prepare({'bvid': BV, 'cid': 42})['url']
            status, headers, body = self.request(source, headers={'Range': 'bytes=0-4'})
            self.assertEqual((status, body), (206, b'video'))
            self.assertEqual(headers['Content-Range'], 'bytes 0-4/100')
            self.assertEqual(online._fetch('https://b23.tv/direct-test', json_body=False),
                             'https://www.bilibili.com/video/' + BV + '/')
        self.assertTrue(any(request.host == 'test.bilivideo.com' for request in calls))
        self.assertTrue(any(request.host == 'passport.bilibili.com' for request in calls))

    def test_realistic_logged_in_1080_uses_dash_and_local_manifest(self):
        bili._cookies().set_cookie(cookie())
        with patch.object(bili, 'fetch_api', return_value=dash_payload()) as api:
            data = bili.prepare({'bvid': BV, 'cid': 42, 'quality': 80})
        self.assertEqual(data['transport'], 'dash')
        self.assertEqual(data['qualityLabel'], '1080P')
        self.assertIn('fnval=16', api.call_args.args[0])
        status, headers, body = self.request(data['url'])
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/dash+xml')
        self.assertNotIn(b'bilivideo.com', body)
        self.assertNotIn(b'test-session', body)
        ns = {'d': 'urn:mpeg:dash:schema:mpd:2011'}
        manifest = ET.fromstring(body)
        self.assertEqual(manifest.find('.//d:Representation', ns).attrib['height'], '1080')
        tracks = manifest.findall('.//d:BaseURL', ns)
        self.assertEqual(len(tracks), 2)
        self.assertTrue(all(t.text.startswith('/api/bilibili/media?') for t in tracks))
        status, head_headers, head_body = self.request(data['url'], method='HEAD')
        self.assertEqual((status, head_body), (200, b''))
        self.assertEqual(head_headers['Content-Length'], str(len(body)))
        calls = []

        class CDNOpener:
            def open(self, req, timeout):
                calls.append(req)
                return Response(b'audio', 206, {'Content-Length': '5', 'Content-Range': 'bytes 0-4/2000'})

        with patch.object(bili.urllib.request, 'build_opener', return_value=CDNOpener()):
            status, audio_headers, body = self.request(tracks[1].text, headers={'Range': 'bytes=0-4'})
        self.assertEqual((status, body), (206, b'audio'))
        self.assertEqual(audio_headers['Content-Type'], 'audio/mp4')
        self.assertIsNone(calls[0].get_header('Cookie'))
        self.assertIn('track=audio30280', calls[0].full_url)
        self.assertEqual(self.request(tracks[1].text.replace('track=audio', 'track=invalid'))[0], 404)

    def test_dash_quality_is_selected_from_available_representations(self):
        doc = dash_payload()
        doc['data']['quality'] = 80  # Top-level quality is not proof an 1080P representation exists.
        doc['data']['dash']['video'] = doc['data']['dash']['video'][:1]
        with patch.object(bili, 'fetch_api', return_value=doc):
            _, info = bili._dash_info({'bvid': BV, 'cid': 42, 'qn': 80})
        self.assertEqual(info['quality'], 64)
        with patch.object(bili, '_dash_info', return_value=(CDN, {'quality': 32})), \
             patch.object(bili, '_mp4_info', return_value=(CDN, {'quality': 64})):
            _, info = bili._play_info({'bvid': BV, 'cid': 42, 'qn': 80})
        self.assertEqual(info['quality'], 64)

    def test_invalid_dash_byte_ranges_and_cdn_are_rejected(self):
        for bad in ['3-1', '0-999999999999', 'invalid']:
            doc = dash_payload()
            doc['data']['dash']['video'][1]['SegmentBase']['indexRange'] = bad
            with patch.object(bili, 'fetch_api', return_value=doc), self.assertRaises(ValueError):
                bili._dash_info({'bvid': BV, 'cid': 42, 'qn': 80})
        doc = dash_payload()
        doc['data']['dash']['audio'][0]['baseUrl'] = 'https://evil.example/audio.m4s'
        with patch.object(bili, 'fetch_api', return_value=doc), self.assertRaises(ValueError):
            bili._dash_info({'bvid': BV, 'cid': 42, 'qn': 80})

    def test_dash_expiration_refreshes_video_and_audio_together(self):
        with patch.object(bili, 'fetch_api', return_value=dash_payload()):
            data = bili.prepare({'bvid': BV, 'cid': 42, 'quality': 80})
        from urllib.parse import parse_qs, urlsplit
        token = parse_qs(urlsplit(data['url']).query)['token'][0]
        item = bili._streams[token]
        item['time'] -= 4000
        import copy
        renewed = copy.deepcopy(item['info'])
        for track in renewed['tracks'].values():
            track['url'] += '&renewed=1'
        from unittest.mock import Mock
        opener = Mock()
        opener.open.side_effect = [Response(b'v', headers={'Content-Length': '1'}),
                                   Response(b'a', headers={'Content-Length': '1'})]
        with patch.object(bili.urllib.request, 'build_opener', return_value=opener), \
             patch.object(bili, '_play_info', return_value=(renewed['tracks']['video']['url'], renewed)) as refresh:
            for kind in ('video', 'audio'):
                self.assertEqual(self.request('/api/bilibili/media?token=' + token + '&track=' + kind)[0], 200)
        refresh.assert_called_once()
        self.assertTrue(all('renewed=1' in call.args[0].full_url for call in opener.open.call_args_list))

    def test_proxy_range_head_and_no_credentials_forwarded(self):
        content = bytes(range(256)) * 30
        with patch.object(bili, '_play_info', return_value=(CDN, {'quality': 80})):
            url = bili.prepare({'bvid': BV, 'cid': 42})['url']
        calls = []

        class CDNOpener:
            def open(self, req, timeout):
                calls.append(req)
                requested = req.get_header('Range')
                if requested:
                    return Response(content[10:50], 206, {'Content-Length': '40', 'Content-Range': f'bytes 10-49/{len(content)}'})
                return Response(b'' if req.method == 'HEAD' else content, headers={'Content-Length': str(len(content))})

        with patch.object(bili.urllib.request, 'build_opener', return_value=CDNOpener()):
            status, headers, body = self.request(url, headers={'Range': 'bytes=10-49'})
            self.assertEqual((status, body), (206, content[10:50]))
            self.assertEqual(headers['Content-Range'], f'bytes 10-49/{len(content)}')
            status, headers, body = self.request(url, method='HEAD')
            self.assertEqual((status, body), (200, b''))
            self.assertEqual(int(headers['Content-Length']), len(content))
        self.assertEqual(calls[0].get_header('Referer'), 'https://www.bilibili.com/')
        self.assertIsNone(calls[0].get_header('Cookie'))
        self.assertEqual(self.request('/api/bilibili/media?token=unknown')[0], 404)
        self.assertEqual(self.request(url, headers={'Range': 'bytes=1-2,4-5'})[0], 416)

    def test_expired_cdn_url_refreshes_once(self):
        with patch.object(bili, '_play_info', return_value=(CDN, {'quality': 80})):
            url = bili.prepare({'bvid': BV, 'cid': 42})['url']
        from unittest.mock import Mock
        opener = Mock()
        opener.open.side_effect = [urllib.error.HTTPError(CDN, 403, 'expired', {}, io.BytesIO()),
                                   Response(b'fresh', headers={'Content-Length': '5'})]
        with patch.object(bili.urllib.request, 'build_opener', return_value=opener), \
             patch.object(bili, '_play_info', return_value=(CDN + '&fresh=1', {})) as refresh:
            self.assertEqual(self.request(url)[2], b'fresh')
        refresh.assert_called_once()

    def test_qr_login_cookie_encryption_reload_and_logout(self):
        with patch.object(bili, 'fetch_api', return_value={'code': 0, 'data': {
                'url': 'https://passport.bilibili.com/login?test=1', 'qrcode_key': 'qr-test-key'}}):
            data = bili.login_start()
        self.assertTrue(data['image'].startswith('data:image/png;base64,'))
        self.assertNotIn('qr-test-key', json.dumps(data))
        bili._cookies().set_cookie(cookie())
        with patch.object(bili, 'fetch_api', return_value={'code': 0, 'data': {'code': 0}}):
            self.assertEqual(bili.login_poll(data['token'])['state'], 'success')
        self.assertNotIn('test-session-only', bili.SESSION_FILE.read_text())
        bili._jar = None
        self.assertEqual(next(iter(bili._cookies())).value, 'test-session-only')
        bili.logout()
        self.assertFalse(bili.SESSION_FILE.exists())
        self.assertEqual(list(bili._cookies()), [])
        self.assertEqual(bili.login_poll(data['token'])['state'], 'expired')

    def test_qr_pending_expiration_and_no_cookie_false_success(self):
        bili._qr['test'] = ('key', float('inf'))
        for code, state in [(86101, 'waiting'), (86090, 'confirm'), (86038, 'expired')]:
            with patch.object(bili, 'fetch_api', return_value={'code': 0, 'data': {'code': code}}):
                self.assertEqual(bili.login_poll('test')['state'], state)
        bili._qr['test'] = ('key', float('inf'))
        with patch.object(bili, 'fetch_api', return_value={'code': 0, 'data': {'code': 0}}):
            with self.assertRaises(ValueError):
                bili.login_poll('test')

    def test_permissions_validation_and_cdn_allowlist(self):
        self.assertEqual(self.request(data={'action': 'status'}, headers={'Origin': 'https://example.com'})[0], 403)
        with patch.object(bili, 'fetch_api') as api:
            for data in [{'action': 'play', 'bvid': 'invalid', 'cid': 42},
                         {'action': 'play', 'bvid': BV, 'cid': 42, 'quality': 999}, []]:
                self.assertEqual(self.request(data=data)[0], 400)
            api.assert_not_called()
        for url in ['https://evil.example/video.mp4', 'https://bilivideo.com.evil/video',
                    'http://127.0.0.1/private', 'https://user:pass@x.bilivideo.com/video']:
            with self.assertRaises(ValueError):
                bili._cdn_url(url)
        self.assertEqual(self.request('/.api-manager/bilibili-session.json')[0], 403)


if __name__ == '__main__':
    unittest.main()
