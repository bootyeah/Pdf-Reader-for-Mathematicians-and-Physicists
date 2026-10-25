"""Save interruption protection and compiler sharing; temporary files, no external APIs."""
import concurrent.futures
import functools
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server


class QuietReader(server.PDFReaderHandler):
    def log_message(self, *_):
        pass


class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reader-integrity-')
        self.root = Path(self.temp.name)
        self.target = self.root / 'Chapter%201.pdf'
        self.original = b'%PDF-original test document'
        self.target.write_bytes(self.original)
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

    def save(self, body, target=None, headers=None):
        url = self.origin + '/api/save-file?path=' + urllib.parse.quote(str(target or self.target), safe='')
        request = urllib.request.Request(url, data=body, headers=headers or {})
        try:
            response = self.opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read()

    def test_atomic_stream_and_no_fixed_temporary_collision(self):
        sentinel = Path(str(self.target) + '.tmp')
        sentinel.write_bytes(b'belongs to another process')
        content = b'%PDF-' + b'A' * (2 * 1024 * 1024)
        self.assertEqual(self.save(content)[0], 200)
        self.assertEqual(self.target.read_bytes(), content)
        self.assertEqual(sentinel.read_bytes(), b'belongs to another process')
        self.assertEqual(list(self.root.glob('.reader-save-*')), [])

    def test_partial_upload_preserves_original(self):
        path = '/api/save-file?path=' + urllib.parse.quote(str(self.target), safe='')
        with socket.create_connection(('127.0.0.1', self.httpd.server_port), timeout=10) as client:
            client.sendall(('POST %s HTTP/1.0\r\nHost: 127.0.0.1:%s\r\nContent-Length: 100\r\n\r\n'
                            % (path, self.httpd.server_port)).encode() + b'%PDF-partial')
            client.shutdown(socket.SHUT_WR)
            response = b''
            while chunk := client.recv(4096):
                response += chunk
        self.assertIn(b'500', response.split(b'\r\n', 1)[0])
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(list(self.root.glob('.reader-save-*')), [])

    def test_failed_replace_never_falls_back_to_truncation(self):
        with patch.object(server.os, 'replace', side_effect=PermissionError('file is locked')):
            self.assertEqual(self.save(b'%PDF-new')[0], 500)
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(list(self.root.glob('.reader-save-*')), [])

    def test_invalid_file_or_content_is_not_written(self):
        self.assertEqual(self.save(b'%PDF-data', self.root / 'secret.json')[0], 403)
        self.assertFalse((self.root / 'secret.json').exists())
        self.assertEqual(self.save(b'not a PDF')[0], 500)
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_cross_site_and_rebound_hosts_cannot_write(self):
        for headers in ({'Origin': 'https://evil.invalid'}, {'Origin': 'null'},
                        {'Sec-Fetch-Site': 'cross-site'}, {'Host': 'evil.invalid'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.save(b'%PDF-new', headers=headers)[0], 403)
                self.assertEqual(self.target.read_bytes(), self.original)

    def test_concurrent_identical_tikz_compiles_once(self):
        handler = object.__new__(QuietReader)
        for result in [('test-svg', ''), (None, 'syntax error')]:
            with server._TIKZ_CACHE_LOCK:
                server._TIKZ_CACHE.clear()
            with patch.object(handler, 'render_latex_to_svg', side_effect=lambda source: (time.sleep(.15), result)[1]) as compiler:
                with concurrent.futures.ThreadPoolExecutor(6) as pool:
                    values = list(pool.map(handler.render_tikz_cached, ['same source'] * 6))
                self.assertEqual(values, [result] * 6)
                self.assertEqual(compiler.call_count, 1)


if __name__ == '__main__':
    unittest.main()
