"""Isolated LaTeX manager storage/API tests and a temporary browser fixture."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TEMP_ROOT = ROOT / 'tests/results'
TEMP_ROOT.mkdir(exist_ok=True)
sys.path.insert(0, str(ROOT))
from tools.latex_manager import manager, storage


class LatexManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='latex-manager-', dir=TEMP_ROOT)
        self.path = Path(self.temp.name) / 'config.js'
        self.path.write_bytes((ROOT / 'static/config.js').read_bytes())
        self.env = patch.dict(os.environ, {
            'PDF_READER_LATEX_CONFIG_JS': str(self.path),
            'PDF_READER_LATEX_STORAGE': str(Path(self.temp.name) / 'state'),
        })
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_original_config_and_literal_parser(self):
        config = storage.snapshot()['config']
        self.assertEqual(storage.validate(config), config)
        text = '''const LATEX_CONFIG = { // comment
            environments: ['tikzpicture',], packages: [], tikzLibraries: [],
            pgfplotsLibraries: [], /* comment */
            extra: {"quoted": "a { b, c: d }", ok: true, number: 12, empty: null},
        }; const LATEX_SNIPPETS = [() => { throw Error('never execute'); }];'''
        parsed, _, end = storage.parse(text)
        self.assertEqual(parsed['extra']['quoted'], 'a { b, c: d }')
        self.assertTrue(text[end:].startswith('; const LATEX_SNIPPETS'))

    def test_save_preserves_other_configuration_and_roundtrips_packages(self):
        before = self.path.read_bytes().decode('utf-8')
        _, start, end = storage.parse(before)
        current = storage.snapshot()
        current['config']['packages'].append('\\usepackage[version=4]{mhchem}')
        saved = storage.save(current['config'], current['revision'])
        after = self.path.read_bytes().decode('utf-8')
        _, new_start, new_end = storage.parse(after)
        self.assertEqual(after[:new_start], before[:start])
        self.assertEqual(after[new_end:], before[end:])
        self.assertEqual(saved['config']['packages'], current['config']['packages'])
        self.assertTrue(saved['has_backup'])
        self.assertEqual((storage.storage_dir() / 'config.js.previous').read_bytes(), before.encode('utf-8'))

    def test_restore_only_latex_config_preserves_later_snippet_changes(self):
        original = storage.snapshot()
        changed = copy.deepcopy(original['config'])
        changed['packages'].append('\\usepackage{siunitx}')
        storage.save(changed, original['revision'])
        self.path.write_bytes(self.path.read_bytes() + b'\n// later shortcut change\n')
        restored = storage.restore(storage.snapshot()['revision'])
        self.assertEqual(restored['config'], original['config'])
        self.assertTrue(self.path.read_bytes().endswith(b'// later shortcut change\n'))

    def test_rejects_stale_and_missing_revisions(self):
        first = storage.snapshot()
        saved = storage.save(first['config'], first['revision'])
        before = self.path.read_bytes()
        for revision in (first['revision'], '', None):
            with self.subTest(revision=revision), self.assertRaises(storage.StorageError):
                storage.save(saved['config'], revision)
        self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_configuration_does_not_write_files(self):
        original = storage.snapshot()
        invalid = [
            {'packages': ['']}, {'packages': ['a\nb']}, {'packages': ['a', 'a']},
            {'tikzLibraries': ['../calc']}, {'environments': 'tikzpicture'},
        ]
        for update in invalid:
            config = {**original['config'], **update}
            with self.subTest(update=update), self.assertRaises(storage.StorageError):
                storage.save(config, original['revision'])
        self.assertEqual(storage.snapshot()['revision'], original['revision'])
        self.assertFalse(storage.storage_dir().exists())

    def test_executable_or_broken_config_is_not_replaced(self):
        for text in ('const LATEX_CONFIG = makeConfig();', 'const LATEX_CONFIG = {packages: ['):
            self.path.write_text(text, encoding='utf-8')
            with self.assertRaises(storage.StorageError):
                storage.snapshot()
            self.assertEqual(self.path.read_text(encoding='utf-8'), text)

    def test_api_authentication_save_assets_and_traversal(self):
        with manager.ManagerServer() as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def request(path, body=None, token=True, headers=None):
                hdr = {'X-Manager-Token': server.token} if token else {}
                if body is not None:
                    hdr['Content-Type'] = 'application/json'
                hdr.update(headers or {})
                req = urllib.request.Request(server.origin + path, data=json.dumps(body).encode() if body is not None else None, headers=hdr)
                try:
                    response = opener.open(req, timeout=5)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    return response.status, response.headers, response.read()

            try:
                self.assertEqual(request('/api/config', token=False)[0], 403)
                self.assertEqual(request('/api/config', headers={'Origin': 'https://example.invalid'})[0], 403)
                self.assertEqual(request('/', headers={'Host': 'invalid.example'})[0], 403)
                status, _, raw = request('/api/config')
                self.assertEqual(status, 200)
                doc = json.loads(raw)
                doc['config']['packages'].append('\\usepackage{siunitx}')
                self.assertEqual(request('/api/save', {'config': doc['config'], 'revision': doc['revision']})[0], 200)
                self.assertEqual(request('/api/save', {'config': doc['config'], 'revision': doc['revision']})[0], 400)
                for path in ('/', '/manager.js', '/manager.css'):
                    status, headers, _ = request(path, token=False)
                    self.assertEqual(status, 200, path)
                    self.assertEqual(headers['Cache-Control'], 'no-store')
                for path in ('/lib/katex/../../config.js', '/lib/katex/%2e%2e/%2e%2e/config.js', '/config.js'):
                    self.assertEqual(request(path)[0], 404)
            finally:
                server.shutdown()
                thread.join()


def serve_fixture():
    with tempfile.TemporaryDirectory(prefix='latex-manager-browser-', dir=TEMP_ROOT) as directory:
        path = Path(directory) / 'config.js'
        path.write_bytes((ROOT / 'static/config.js').read_bytes())
        with patch.dict(os.environ, {'PDF_READER_LATEX_CONFIG_JS': str(path), 'PDF_READER_LATEX_STORAGE': str(Path(directory) / 'state')}):
            with manager.ManagerServer() as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                print(json.dumps({'url': server.url, 'origin': server.origin, 'token': server.token}), flush=True)
                try:
                    sys.stdin.read()
                finally:
                    server.shutdown()
                    thread.join()


if __name__ == '__main__':
    if '--serve-fixture' in sys.argv:
        serve_fixture()
    else:
        unittest.main()
