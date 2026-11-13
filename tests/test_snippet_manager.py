"""Unit and integration tests for the LaTeX Snippet Manager."""
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from tools.snippet_manager import manager as snippet_manager
from tools.snippet_manager import storage

class TestSnippetStorage(unittest.TestCase):
    def test_load_existing_snippets(self):
        doc = storage.load_data()
        self.assertIn("snippets", doc)
        self.assertGreaterEqual(len(doc["snippets"]), 200)
        self.assertTrue(doc.get("revision"))

    def test_snippet_categorization(self):
        self.assertEqual(storage.categorize_snippet("@a", "\\alpha", "mA"), "greek")
        self.assertEqual(storage.categorize_snippet("beg", "\\begin{$0}\\end{$0}", "mA"), "env")
        self.assertEqual(storage.categorize_snippet("fr", "\\dfrac{$0}{$1}", "mA"), "calculus")
        self.assertEqual(storage.categorize_snippet("([A-Za-z])(\\d)", "[[0]]_{[[1]]}", "rmA"), "regex")
        self.assertEqual(storage.categorize_snippet("subset", "\\subset", "mAw"), "logic_relation")
        self.assertEqual(storage.categorize_snippet("foo", "\\foo", "MA"), "math_symbol")
        self.assertEqual(storage.categorize_snippet("qux", "\\qux", "nA"), "math_symbol")

    def test_optimized_snippets_integrity(self):
        doc = storage.load_data()
        by_trig_opts = {(s["trigger"], s["options"]): s for s in doc["snippets"] if s["enabled"]}
        triggers = {s["trigger"] for s in doc["snippets"]}

        # Removed Obsidian-only / broken / conflicting triggers
        for removed in ("box", "sts", "simm", "mathc", "([^\\\\])int"):
            self.assertNotIn(removed, triggers)

        # Core rules & fixes
        self.assertIn(("int", "mAw"), by_trig_opts)
        self.assertEqual(by_trig_opts[("int", "mAw")]["replacement"], "\\int $0 \\,\\mathrm{d}${1:x} $2")
        self.assertEqual(by_trig_opts[("subset", "mAw")]["replacement"], "\\subset")
        self.assertEqual(by_trig_opts[("supset", "mAw")]["replacement"], "\\supset")
        self.assertEqual(by_trig_opts[("red", "mAw")]["replacement"], "\\textcolor{${0:red}}{$1}$2")
        self.assertIn("{${0:c}}", by_trig_opts[("array", "mAw")]["replacement"])

        # Option B rescue rules for dd / ii / xinvs
        for rescue_trig in ("\\xi nvs", "\\,\\mathrm{d}ot", "\\,\\mathrm{d}t", "\\mathrm{i}nt", "\\mathrm{i}int"):
            self.assertIn(rescue_trig, triggers)

    def test_format_snippet_js(self):
        snip = {
            "trigger": "test",
            "replacement": "\\test{$0}",
            "options": "mA",
            "description": "测试",
            "priority": 1,
            "enabled": True
        }
        js = storage.format_snippet_to_js(snip)
        self.assertIn('trigger: "test"', js)
        self.assertIn('replacement: "\\\\test{$0}"', js)
        self.assertIn('options: "mA"', js)
        self.assertIn('priority: 1', js)

    def test_backslash_and_template_regex_roundtrip(self):
        raw_setminus = '{trigger: "\\\\\\\\\\\\", replacement: "\\\\setminus", options: "mA"}'
        parsed = storage.parse_snippet_object(raw_setminus, 0)
        self.assertEqual(parsed["trigger"], "\\\\\\")
        self.assertEqual(parsed["replacement"], "\\setminus")
        formatted = storage.format_snippet_to_js(parsed)
        self.assertEqual(formatted, '{trigger: "\\\\\\\\\\\\", replacement: "\\\\setminus", options: "mA"}')

        raw_greek = '{trigger: "(^|[^a-zA-Z\\\\\\\\])(${GREEK})", replacement: "[[0]]\\\\[[1]]", options: "rmA"}'
        parsed_greek = storage.parse_snippet_object(raw_greek, 1)
        self.assertEqual(parsed_greek["trigger"], "(^|[^a-zA-Z\\\\])(${GREEK})")
        self.assertTrue(parsed_greek["is_regex"])
        formatted_greek = storage.format_snippet_to_js(parsed_greek)
        self.assertIn('trigger: "(^|[^a-zA-Z\\\\\\\\])(${GREEK})"', formatted_greek)

    def test_save_and_backup(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            tmp_storage = tmp_path / ".snippet-manager"
            tmp_config_js = tmp_path / "config.js"
            shutil.copy2(storage.CONFIG_JS_PATH, tmp_config_js)

            with patch.dict(os.environ, {
                "PDF_READER_SNIPPET_STORAGE": str(tmp_storage),
                "PDF_READER_SNIPPET_CONFIG_JS": str(tmp_config_js),
            }):
                current = storage.load_data()
                snippets = list(current["snippets"])
                orig_count = len(snippets)
                rev = current["revision"]

                # Append dummy snippet
                dummy = {
                    "id": "snip_dummy_test",
                    "trigger": "xyztest123",
                    "replacement": "\\xyz",
                    "options": "mA",
                    "description": "test",
                    "priority": 0,
                    "enabled": True,
                    "category": "custom"
                }
                snippets.append(dummy)
                saved = storage.save_data(snippets, current_revision=rev)
                self.assertEqual(len(saved["snippets"]), orig_count + 1)

                # Restore from backup
                restored = storage.restore_backup()
                self.assertEqual(len(restored["snippets"]), orig_count)
                self.assertFalse(any(s["trigger"] == "xyztest123" for s in restored["snippets"]))

    def test_regex_flags_roundtrip(self):
        raw_regex = '{trigger: /([a-z]+)/im, replacement: "X", options: "rmA"}'
        parsed = storage.parse_snippet_object(raw_regex, 0)
        self.assertTrue(parsed["is_regex"])
        self.assertEqual(parsed["trigger"], "([a-z]+)")
        self.assertEqual(parsed.get("regex_flags"), "im")
        formatted = storage.format_snippet_to_js(parsed)
        self.assertEqual(formatted, '{trigger: /([a-z]+)/im, replacement: "X", options: "rmA"}')

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            tmp_storage = tmp_path / ".snippet-manager"
            tmp_config_js = tmp_path / "config.js"
            shutil.copy2(storage.CONFIG_JS_PATH, tmp_config_js)
            with patch.dict(os.environ, {
                "PDF_READER_SNIPPET_STORAGE": str(tmp_storage),
                "PDF_READER_SNIPPET_CONFIG_JS": str(tmp_config_js),
            }):
                current = storage.load_data()
                snippets = list(current["snippets"]) + [parsed]
                saved = storage.save_data(snippets, current_revision=current["revision"])
                self.assertEqual(saved["snippets"][-1].get("regex_flags"), "im")
                self.assertIn("trigger: /([a-z]+)/im", tmp_config_js.read_text(encoding="utf-8"))

    def test_manager_traversal_and_oversized_unauth_post(self):
        srv = snippet_manager.ManagerServer()
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"{srv.origin}/static/lib/../../server.py"
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=3)
            self.assertEqual(ctx.exception.code, 403)
            ctx.exception.close()

            req = (
                f"POST /api/save HTTP/1.0\r\n"
                f"Host: 127.0.0.1:{srv.server_port}\r\n"
                f"Content-Type: application/json\r\n"
                f"Origin: https://evil.test\r\n"
                f"Content-Length: 999999999\r\n\r\n{{}}"
            ).encode("ascii")
            with socket.create_connection(("127.0.0.1", srv.server_port), timeout=3) as sock:
                sock.sendall(req)
                resp = sock.recv(1024)
            self.assertIn(b" 403 ", resp)
        finally:
            srv.shutdown()
            srv.server_close()

if __name__ == "__main__":
    unittest.main()
