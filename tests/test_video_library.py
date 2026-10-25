"""Temporary videos and mocked native picker; no user files or GUI needed."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import video_library


class Reader(server.PDFReaderHandler):
    def log_message(self, *_):
        pass


class VideoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reader-video-test-')
        self.folder = Path(self.temp.name)
        self.content = bytes(range(256)) * 512
        for name in ['第10课.mp4', '第2课.WEBM', '第1课%20 #.mp4']:
            (self.folder / name).write_bytes(self.content)
        (self.folder / 'notes.txt').write_text('not a video')
        (self.folder / 'subfolder').mkdir()
        (self.folder / 'subfolder' / 'hidden.mp4').write_bytes(b'child')
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Reader)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.httpd.server_port}'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.temp.cleanup()

    def request(self, path, data=None, headers=None, method=None):
        req = urllib.request.Request(self.base + path, headers=headers or {}, method=method,
                                     data=json.dumps(data).encode() if data is not None else None)
        try:
            response = self.opener.open(req, timeout=5)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, response.headers, response.read()

    def choose(self):
        with patch.object(video_library, 'pick_file', return_value=str(self.folder / '第2课.WEBM')) as picker:
            status, _, body = self.request('/api/pick-video', {'initial_dir': str(self.folder)})
        picker.assert_called_once_with(str(self.folder))
        self.assertEqual(status, 200)
        return json.loads(body)

    def test_playlist_and_stream_ranges(self):
        data = self.choose()
        self.assertEqual(data['folder'], str(self.folder))
        self.assertEqual({v['name'] for v in data['videos']}, {'第10课.mp4', '第2课.WEBM', '第1课%20 #.mp4'})
        selected = next(v for v in data['videos'] if v['url'] == data['selected'])
        self.assertEqual(selected['name'], '第2课.WEBM')
        url = data['selected']
        status, headers, body = self.request(url)
        self.assertEqual((status, body), (200, self.content))
        self.assertEqual(headers['Accept-Ranges'], 'bytes')
        self.assertEqual(headers['Content-Type'], 'video/webm')
        for requested, start, end in [('bytes=7-100', 7, 100), ('bytes=100000-', 100000, len(self.content)-1),
                                       ('bytes=-37', len(self.content)-37, len(self.content)-1),
                                       ('bytes=131060-999999', 131060, len(self.content)-1)]:
            status, headers, body = self.request(url, headers={'Range': requested})
            self.assertEqual(status, 206)
            self.assertEqual(body, self.content[start:end+1])
            self.assertEqual(headers['Content-Range'], f'bytes {start}-{end}/{len(self.content)}')
        status, headers, body = self.request(url, method='HEAD')
        self.assertEqual((status, body), (200, b''))
        self.assertEqual(int(headers['Content-Length']), len(self.content))

    def test_invalid_requests_and_missing_files(self):
        data = self.choose()
        for requested in ['bytes=999999-', 'bytes=8-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4']:
            status, headers, body = self.request(data['selected'], headers={'Range': requested})
            self.assertEqual((status, body), (416, b''))
            self.assertEqual(headers['Content-Range'], f'bytes */{len(self.content)}')
        for url in ['/api/video?path=' + str(self.folder / 'notes.txt'),
                    data['selected'].split('&index=')[0] + '&index=-1', '/api/video?token=fake&index=0']:
            self.assertEqual(self.request(url)[0], 404)
        (self.folder / '第2课.WEBM').unlink()
        self.assertEqual(self.request(data['selected'])[0], 404)

    def test_cancel_busy_and_origin(self):
        with patch.object(video_library, 'pick_file', return_value=''):
            self.assertTrue(json.loads(self.request('/api/pick-video', {})[2])['cancelled'])
        with patch.object(video_library, 'pick_file') as picker:
            self.assertEqual(self.request('/api/pick-video', {}, headers={'Origin': 'https://example.com'})[0], 403)
            picker.assert_not_called()
        with server._DIALOG_LOCK:
            self.assertEqual(self.request('/api/pick-video', {})[0], 409)
        self.assertFalse(server._DIALOG_LOCK.locked())


if __name__ == '__main__':
    unittest.main()
