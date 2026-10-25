"""Unit and integration tests for the LaTeX Snippet Manager."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

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

if __name__ == "__main__":
    unittest.main()
