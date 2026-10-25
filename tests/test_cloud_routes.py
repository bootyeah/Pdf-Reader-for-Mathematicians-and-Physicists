"""Cloud HTTP error contracts; no remote repositories or user configuration."""
import functools
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.server import PDFReaderHandler
from app.services import cloud_sync


class CloudErrorContractTests(unittest.TestCase):
    def test_invalid_and_missing_resources_keep_ok_false(self):
        class Handler(PDFReaderHandler):
            def log_message(self, *_):
                pass

            def _cloud_cfg_or_error(self):
                return {'enabled': True, 'provider': 'github'}, None

        cases = [
            ('/api/cloud-anno/meta', None, 400),
            ('/api/cloud-anno/meta?keys=../../canary.txt', None, 400),
            ('/api/cloud-anno/get', None, 400),
            ('/api/cloud-anno/get?key=../canary.json', None, 400),
            ('/api/cloud-anno/get?key=canary.txt', None, 400),
            ('/api/cloud-anno/get?key=missing.json', None, 404),
            ('/api/cloud-anno', {}, 400),
            ('/api/cloud-anno', {'name': 'test.pdf', 'annotations': []}, 400),
        ]
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with patch.object(cloud_sync, '_cloud_get_file', return_value=None) as get_file, \
                patch.object(cloud_sync, '_cloud_save') as save, \
                patch.object(cloud_sync, '_cloud_list_files') as listing, \
                ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT))) as httpd:
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                for path, data, expected in cases:
                    with self.subTest(path=path, data=data):
                        request = urllib.request.Request(
                            'http://127.0.0.1:%s%s' % (httpd.server_port, path),
                            data=None if data is None else json.dumps(data).encode(),
                            headers={'Content-Type': 'application/json'})
                        with self.assertRaises(urllib.error.HTTPError) as raised:
                            opener.open(request, timeout=5)
                        with raised.exception as response:
                            self.assertEqual(response.code, expected)
                            result = json.loads(response.read())
                            self.assertIs(result.get('ok'), False)
                            self.assertTrue(result.get('error'))
                            self.assertNotIn('status', result)
                get_file.assert_called_once_with({'enabled': True, 'provider': 'github'}, 'missing.json')
                save.assert_not_called()
                listing.assert_not_called()
            finally:
                httpd.shutdown()
                thread.join()


if __name__ == '__main__':
    unittest.main()
