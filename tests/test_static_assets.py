"""Static-resource update tests and a temporary browser fixture; no user files or model calls."""
import base64
import functools
import hashlib
import io
import json
import os
import re
import subprocess
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
TEMP_ROOT = ROOT / 'tests/results'
TEMP_ROOT.mkdir(exist_ok=True)
sys.path.insert(0, str(ROOT))
import server


class QuietReader(server.PDFReaderHandler):
    def log_message(self, *_):
        pass


class StaticAssetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reader-static-test-', dir=TEMP_ROOT)
        self.root = Path(self.temp.name) / 'webroot'
        self.assets = self.root / 'static'
        (self.assets / 'js').mkdir(parents=True)
        (self.assets / 'css').mkdir()
        self.html = ('<link href="./style.css?theme=1&amp;test=2#sheet" rel="stylesheet">'
                     '<script src="./js/app.js"></script>'
                     '<script src="https://example.invalid/external.js"></script>'
                     '<img src="data:image/svg+xml,test">')
        (self.assets / 'index.html').write_text(self.html, encoding='utf-8')
        (self.assets / 'js/app.js').write_text('window.version = "old";', encoding='utf-8')
        (self.assets / 'css/style.css').write_text('body{color:red}', encoding='utf-8')
        (self.root / 'LOCALPdfReader.html').write_text('STALE ROOT HTML', encoding='utf-8')
        (self.root / 'index.html').write_text('STALE ROOT INDEX', encoding='utf-8')
        (self.root / 'js').mkdir()
        (self.root / 'js/app.js').write_text('STALE ROOT JS', encoding='utf-8')
        (self.root / 'style.css').write_text('STALE ROOT CSS', encoding='utf-8')
        (self.assets / 'style.css').write_text('STALE FLAT CSS', encoding='utf-8')
        (Path(self.temp.name) / 'canary.txt').write_text('OUTSIDE WEBROOT', encoding='utf-8')
        (self.root / 'sample.pdf').write_bytes(b'%PDF test-only')
        (self.root / 'secret.json').write_text('{"key":"test-only"}', encoding='utf-8')
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietReader, directory=str(self.root)))
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.origin = 'http://127.0.0.1:%s' % self.httpd.server_port
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, method='GET', headers=None):
        req = urllib.request.Request(self.origin + path, method=method, headers=headers or {})
        try:
            response = self.opener.open(req, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def test_pages_are_not_stored_and_unversioned_assets_revalidate(self):
        for path in ('/LOCALPdfReader.html', '/LOCALPdfReader.html?open=A.pdf',
                     '/LOCALPdfReader.html?mode=receiver&sid=123', '/LOCALPdfReader.html?_readerLoad=test',
                     '/js/app.js', '/js/app.js?_readerAsset=test', '/style.css'):
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertEqual(int(headers['Content-Length']), len(body))
                if path.startswith('/LOCALPdfReader.html'):
                    self.assertEqual(headers.get('Cache-Control'), 'no-store, max-age=0')
                    self.assertEqual(headers.get('Pragma'), 'no-cache')
                    self.assertEqual(headers.get('Expires'), '0')
                    self.assertEqual(headers.get('Clear-Site-Data'), '"cache"')
                else:
                    self.assertEqual(headers.get('Cache-Control'), 'no-cache')
                    self.assertRegex(headers['ETag'], r'^"[a-f0-9]{64}"$')
                    self.assertIsNone(headers.get('Clear-Site-Data'))

    def test_old_conditional_headers_do_not_return_stale_304(self):
        path = self.assets / 'js/app.js'
        stat = path.stat()
        _, headers, _ = self.request('/js/app.js')
        path.write_text('window.version = "new";', encoding='utf-8')
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        status, _, body = self.request('/js/app.js', headers={'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT', 'If-None-Match': headers['ETag']})
        self.assertEqual(status, 200)
        self.assertIn(b'"new"', body)
        status, _, body = self.request('/LOCALPdfReader.html', headers={'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT', 'If-None-Match': '"old"'})
        self.assertEqual(status, 200)
        self.assertIn(b'_readerAsset=', body)

    def test_addresses_change_only_for_changed_content(self):
        import re
        _, _, first = self.request('/LOCALPdfReader.html')
        _, _, second = self.request('/LOCALPdfReader.html?open=B.pdf')
        versions = re.findall(rb'_readerAsset=([a-f0-9]+)', first)
        self.assertEqual(len(versions), 2)
        self.assertEqual(len(set(versions)), 2)
        self.assertEqual(first, second)
        (self.assets / 'js/app.js').write_text('window.version = "new";', encoding='utf-8')
        _, _, third = self.request('/LOCALPdfReader.html')
        changed = re.findall(rb'_readerAsset=([a-f0-9]+)', third)
        self.assertEqual(versions[0], changed[0], 'Unchanged CSS keeps its address')
        self.assertNotEqual(versions[1], changed[1], 'Changed JS gets a new address')
        self.assertIn(b'theme=1&amp;test=2&amp;_readerAsset=', first)
        self.assertIn(b'#sheet', first)
        self.assertIn(b'https://example.invalid/external.js', first)
        self.assertIn(b'data:image/svg+xml,test', first)

    def test_content_validators_and_immutable_addresses(self):
        _, headers, body = self.request('/js/app.js')
        status, unchanged, empty = self.request('/js/app.js', headers={'If-None-Match': 'W/' + headers['ETag']})
        self.assertEqual((status, empty), (304, b''))
        self.assertEqual(unchanged['ETag'], headers['ETag'])
        version = headers['ETag'].strip('"')
        status, cached, cached_body = self.request('/js/app.js?_readerAsset=' + version)
        self.assertEqual((status, cached_body), (200, body))
        self.assertEqual(cached['Cache-Control'], 'public, max-age=31536000, immutable')
        status, _, head = self.request('/js/app.js?_readerAsset=' + version, method='HEAD', headers={'If-None-Match': headers['ETag']})
        self.assertEqual((status, head), (304, b''))
        (self.assets / 'js/app.js').write_text('window.version = "new";', encoding='utf-8')
        status, changed, new_body = self.request('/js/app.js?_readerAsset=' + version, headers={'If-None-Match': headers['ETag']})
        self.assertEqual(status, 200)
        self.assertEqual(changed['Cache-Control'], 'no-cache', 'Stale fingerprint must not be cached as immutable')
        self.assertIn(b'"new"', new_body)

    def test_legacy_cache_cleanup_runs_only_once_per_browser(self):
        _, headers, _ = self.request('/LOCALPdfReader.html')
        self.assertEqual(headers['Clear-Site-Data'], '"cache"')
        cookie = headers['Set-Cookie'].split(';', 1)[0]
        _, again, _ = self.request('/LOCALPdfReader.html?open=B.pdf', headers={'Cookie': cookie})
        self.assertIsNone(again.get('Clear-Site-Data'))
        self.assertIsNone(again.get('Set-Cookie'))

    def test_entry_identifies_the_actual_served_directory(self):
        _, headers, _ = self.request('/index.html')
        expected = hashlib.sha256(os.path.normcase(os.path.realpath(self.root)).encode('utf-8')).hexdigest()
        self.assertEqual(headers.get('X-Reader-Root'), expected)

    def test_head_has_correct_transformed_length_and_no_body(self):
        _, get_headers, body = self.request('/LOCALPdfReader.html')
        status, head_headers, head_body = self.request('/LOCALPdfReader.html', method='HEAD', headers={'If-Modified-Since': get_headers['Last-Modified']})
        self.assertEqual(status, 200)
        self.assertEqual(int(head_headers['Content-Length']), len(body))
        self.assertEqual(head_headers['Cache-Control'], 'no-store, max-age=0')
        self.assertEqual(head_body, b'')

    def test_pdf_caching_and_private_file_protection_are_preserved(self):
        _, headers, _ = self.request('/sample.pdf')
        status, _, _ = self.request('/sample.pdf', headers={'If-Modified-Since': headers['Last-Modified']})
        self.assertEqual(status, 304)
        for path in ('/secret.json', '/secret.json?_readerAsset=test', '/js/../secret.json', '/%73ecret.json'):
            self.assertEqual(self.request(path)[0], 403)

    def test_all_page_aliases_serve_the_canonical_entry(self):
        for path in ('/', '/?open=A.pdf', '/index.html', '/index.html?_readerLoad=test',
                     '/LOCALPdfReader.html?open=A.pdf', '/static/', '/static/index.html'):
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertIn(b'_readerAsset=', body)
                self.assertNotIn(b'STALE', body)
                self.assertEqual(headers['Cache-Control'], 'no-store, max-age=0')
                status, head_headers, head = self.request(path, method='HEAD')
                self.assertEqual((status, head), (200, b''))
                self.assertEqual(int(head_headers['Content-Length']), len(body))

    def test_asset_aliases_share_content_and_never_fall_back_to_old_copies(self):
        assets = {'config.js': b'window.auditConfig = true;',
                  'lib/pdf.worker.min.js': b'// canonical PDF worker',
                  'js/annotation-worker.js': b'// canonical annotation worker',
                  'lib/font name.woff2': b'canonical font'}
        for relative, body in assets.items():
            target = self.assets / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
            legacy = self.root / relative
            legacy.parent.mkdir(parents=True, exist_ok=True)
            legacy.write_bytes(b'STALE ROOT ASSET')
        assets.update({'js/app.js': (self.assets / 'js/app.js').read_bytes(),
                       'style.css': b'body{color:red}', 'css/style.css': b'body{color:red}'})
        for relative, body in assets.items():
            etags = []
            for prefix in ('/', '/static/'):
                path = prefix + urllib.parse.quote(relative)
                with self.subTest(path=path):
                    status, headers, actual = self.request(path)
                    self.assertEqual((status, actual), (200, body))
                    etags.append(headers['ETag'])
            self.assertEqual(etags[0], etags[1])
        (self.assets / 'js/app.js').unlink()
        for path in ('/js/app.js', '/static/js/app.js'):
            self.assertEqual(self.request(path)[0], 404, 'Missing canonical assets must not serve old copies')

    def test_traversal_and_windows_absolute_paths_are_forbidden(self):
        paths = ('/../../canary.txt', '/%2e%2e/%2e%2e/canary.txt',
                 '/..%5c..%5ccanary.txt', '/static/js/../../../canary.txt',
                 '/C:/canary.txt', '/C%3a/canary.txt', '/%5c%5cserver/share/canary.txt',
                 '/config.js%3astream', '/%00')
        for path in paths:
            for method in ('GET', 'HEAD'):
                with self.subTest(path=path, method=method):
                    status, _, body = self.request(path, method=method)
                    self.assertEqual(status, 403)
                    self.assertNotIn(b'OUTSIDE WEBROOT', body)

    def test_static_symlinks_cannot_escape_the_asset_directory(self):
        link = self.assets / 'outside.txt'
        try:
            link.symlink_to(Path(self.temp.name) / 'canary.txt')
        except OSError as exc:
            self.skipTest('Symlinks unavailable: ' + str(exc))
        for path in ('/outside.txt', '/static/outside.txt'):
            self.assertEqual(self.request(path)[0], 403)

    def test_static_requests_reject_foreign_hosts(self):
        for path in ('/', '/js/app.js', '/sample.pdf'):
            for method in ('GET', 'HEAD'):
                with self.subTest(path=path, method=method):
                    self.assertEqual(self.request(path, method=method, headers={'Host': 'audit.invalid'})[0], 403)
        self.assertEqual(self.request('/', headers={'Host': 'localhost:%s' % self.httpd.server_port})[0], 200)

    @unittest.skipUnless(sys.platform == 'win32', 'Windows launcher')
    def test_launcher_generates_distinct_fresh_entry_ids(self):
        launcher = (ROOT / 'start.bat').read_text(encoding='ascii')
        line = next(line for line in launcher.splitlines() if line.startswith('for /f ') and 'READER_LAUNCH_ID' in line)
        self.assertIn('index.html?_readerLoad=%READER_LAUNCH_ID%', launcher)
        probe = self.root / 'launch-id-probe.bat'
        probe.write_bytes(('@echo off\r\n' + line + '\r\necho %READER_LAUNCH_ID%\r\n').encode('ascii'))
        ids = []
        for _ in range(2):
            result = subprocess.run(['cmd', '/d', '/c', probe.name], cwd=self.root,
                                    capture_output=True, text=True, timeout=15,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(result.returncode, 0, result.stderr)
            identity = result.stdout.strip()
            self.assertRegex(identity, r'^[a-f0-9]{32}$')
            ids.append(identity)
        self.assertNotEqual(ids[0], ids[1])

    @unittest.skipUnless(sys.platform == 'win32', 'Windows launcher')
    def test_launcher_sets_entry_url_for_server(self):
        launcher = (ROOT / 'start.bat').read_text(encoding='ascii')
        self.assertIn('set "READER_ENTRY_URL=http://127.0.0.1:8080/index.html?_readerLoad=%READER_LAUNCH_ID%"', launcher)
        self.assertNotIn('start "" "http://127.0.0.1:8080', launcher)
        self.assertNotIn('taskkill', launcher.lower(), 'Double launching must not kill the existing reader or unrelated services')

    def test_server_main_browser_launch_behavior(self):
        from unittest.mock import patch
        from app import server as app_server
        # 1. With PDF_READER_NO_BROWSER=1, browser should not be opened
        with patch('app.server.http.server.ThreadingHTTPServer') as mock_server, \
             patch('app.server._launch_browser') as mock_launch, \
             patch.dict('os.environ', {'PDF_READER_NO_BROWSER': '1'}):
            mock_inst = mock_server.return_value
            mock_inst.__enter__.return_value = mock_inst
            mock_inst.serve_forever.side_effect = KeyboardInterrupt
            try:
                app_server.main()
            except KeyboardInterrupt:
                pass
            mock_launch.assert_not_called()

        # 2. When socket is bound, browser is launched with entry URL
        test_url = 'http://127.0.0.1:8080/index.html?_readerLoad=test1234'
        with patch('app.server.http.server.ThreadingHTTPServer') as mock_server, \
             patch('app.server._launch_browser') as mock_launch, \
             patch.dict('os.environ', {'READER_ENTRY_URL': test_url}, clear=False):
            os.environ.pop('PDF_READER_NO_BROWSER', None)
            mock_inst = mock_server.return_value
            mock_inst.__enter__.return_value = mock_inst
            mock_inst.serve_forever.side_effect = KeyboardInterrupt
            try:
                app_server.main()
            except KeyboardInterrupt:
                pass
            mock_launch.assert_called_with(test_url)

        # 3. Port already in use exits cleanly and opens browser
        exc = OSError(10048, "Address already in use")
        exc.winerror = 10048
        with patch('app.server.http.server.ThreadingHTTPServer', side_effect=exc), \
             patch('app.server._launch_browser') as mock_launch, \
             patch('app.server.urllib.request.build_opener') as mock_opener, \
             patch.dict('os.environ', {'READER_ENTRY_URL': test_url}, clear=False):
            os.environ.pop('PDF_READER_NO_BROWSER', None)
            probe = mock_opener.return_value.open.return_value.__enter__.return_value
            probe.status = 200
            probe.headers = {'X-Reader-Root': hashlib.sha256(os.path.normcase(os.path.realpath(ROOT)).encode('utf-8')).hexdigest()}
            code = app_server.main()
            self.assertEqual(code, 0)
            mock_launch.assert_called_with(test_url)

        # An unrelated 200 response, another checkout, or an unreachable service is not a running reader.
        for headers in ({}, {'X-Reader-Root': 'another-checkout'}):
            with self.subTest(headers=headers), \
                 patch('app.server.http.server.ThreadingHTTPServer', side_effect=exc), \
                 patch('app.server._launch_browser') as mock_launch, \
                 patch('app.server.time.sleep'), \
                 patch('app.server.urllib.request.build_opener') as mock_opener:
                probe = mock_opener.return_value.open.return_value.__enter__.return_value
                probe.status = 200
                probe.headers = headers
                self.assertEqual(app_server.main(), 1)
                mock_launch.assert_not_called()
        with patch('app.server.http.server.ThreadingHTTPServer', side_effect=exc), \
             patch('app.server._launch_browser') as mock_launch, \
             patch('app.server.time.sleep'), \
             patch('app.server.urllib.request.build_opener') as mock_opener:
            mock_opener.return_value.open.side_effect = urllib.error.URLError('test-only unavailable')
            self.assertEqual(app_server.main(), 1)
            mock_launch.assert_not_called()


class BrowserFixture(QuietReader):
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        self.server.requests.append({'path': self.path, 'updated': self.server.updated})
        if url.path == '/api/read-file':
            self.send_response(200)
            self.send_header('Content-Type', 'application/pdf')
            self.end_headers()
            self.wfile.write(self.server.pdf)
            return
        if url.path.startswith('/api/'):
            self._json_response(200, {})
            return
        super().do_GET()

    def _reader_file_bytes(self, path):
        if os.path.basename(path) in ('__reader_cache_probe.js', '__reader_cache_probe.css'):
            version = self.server.asset_version
            return ('window.readerCacheProbe="%s";' % version if path.endswith('.js') else 'body{--reader-cache-probe:%s}' % version).encode()
        body = super()._reader_file_bytes(path)
        if self.server.updated and os.path.basename(path) in ('pdf.worker.min.js', 'annotation-worker.js'):
            body = ('// Worker content version: %s\n' % self.server.asset_version).encode() + body
        return body

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        if self.path == '/__cache_test/control':
            if 'pdf' in data:
                self.server.pdf = base64.b64decode(data['pdf'])
            if 'updated' in data:
                self.server.updated = data['updated']
                self.server.asset_version = 'new' if data['updated'] else 'old'
            if 'version' in data:
                self.server.asset_version = data['version']
            self._json_response(200, {'ok': True, 'requests': self.server.requests})
        elif self.path == '/api/pick-file':
            self._json_response(200, {'ok': True, 'path': r'D:\Test PDFs\cached.pdf', 'name': 'cached.pdf'})
        else:
            self._json_response(200, {})

    def _send_reader_asset(self, path):
        if self.server.updated:
            return super()._send_reader_asset(path)
        body = self._reader_file_bytes(path)
        self.send_response(200)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'public, max-age=3600')
        self.end_headers()
        return io.BytesIO(body)

    def _send_reader_html(self, path):
        if self.server.updated:
            return super()._send_reader_html(self.server.fixture_html)
        body = self.server.old_html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'public, max-age=3600')
        self.end_headers()
        return io.BytesIO(body)


def serve_fixture():
    with tempfile.TemporaryDirectory(prefix='reader-cache-browser-', dir=TEMP_ROOT) as directory:
        html = (ROOT / 'static/index.html').read_text(encoding='utf-8')
        html = html.replace('</head>', '<script src="./__reader_cache_probe.js"></script><link rel="stylesheet" href="./__reader_cache_probe.css"></head>')
        fixture_html = Path(directory) / 'LOCALPdfReader.html'
        fixture_html.write_text(html, encoding='utf-8')
        handler = functools.partial(BrowserFixture, directory=str(ROOT))
        with ThreadingHTTPServer(('127.0.0.1', 0), handler) as httpd:
            httpd.updated = False
            httpd.asset_version = 'old'
            httpd.pdf = b''
            httpd.requests = []
            httpd.fixture_html = str(fixture_html)
            httpd.old_html = re.sub(r'<button\s+id="outline-locate-current-page"[\s\S]*?</button>', '', html)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            print(json.dumps({'origin': 'http://127.0.0.1:%s' % httpd.server_port}), flush=True)
            try:
                sys.stdin.read()
            finally:
                httpd.shutdown()
                thread.join()


if __name__ == '__main__':
    if '--serve-fixture' in sys.argv:
        serve_fixture()
    else:
        unittest.main()
