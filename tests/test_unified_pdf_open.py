"""Tests for unified PDF opening via backend native file picker and silent in-place saving."""
import functools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
import zlib
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server  # noqa: E402


def _minimal_pdf_bytes() -> bytes:
    """Construct a valid minimal 1-page PDF with valid xref offsets."""
    objects = [
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>\nendobj\n",
        b"4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
    ]
    buf = bytearray(b"%PDF-1.4\n")
    offsets = []
    for obj in objects:
        offsets.append(len(buf))
        buf.extend(obj)
    xref_pos = len(buf)
    buf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    buf.extend(b"0000000000 65535 f \n")
    for off in offsets:
        buf.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    buf.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
    )
    return bytes(buf)


class TestReaderHandler(server.PDFReaderHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.startswith("/api/cloud-anno"):
            self._json_response(200, {"ok": True, "configured": False, "enabled": False})
            return
        super().do_GET()

    def _send_reader_html(self, path):
        if getattr(self.server, "fixture_html", None):
            return super()._send_reader_html(str(self.server.fixture_html))
        return super()._send_reader_html(path)

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/__test_done":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            self.server.browser_result = json.loads(raw.decode("utf-8"))
            self.server.browser_done.set()
            self._json_response(200, {"ok": True})
            return
        super().do_POST()


class UnifiedPdfOpenTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="reader-unified-open-")
        self.temp_root = Path(self.temp.name)
        self.folder_a = self.temp_root / "CourseA"
        self.folder_b = self.temp_root / "CourseB"
        self.folder_a.mkdir()
        self.folder_b.mkdir()
        self.httpd = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            functools.partial(TestReaderHandler, directory=str(ROOT)),
        )
        self.httpd.fixture_html = None
        self.httpd.browser_result = None
        self.httpd.browser_done = threading.Event()
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.httpd.server_port}"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.temp.cleanup()

    def _post_json(self, path, payload):
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.origin + path,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with self.opener.open(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def test_document_js_uses_unified_backend_picker(self):
        doc_js = (ROOT / "static/js/document.js").read_text(encoding="utf-8")
        self.assertNotIn("window.showOpenFilePicker", doc_js)
        self.assertNotIn("els.fileInput.click()", doc_js)
        self.assertIn(
            "pickAndOpenFileFromFolder(loadLastOpenFolder(), newWindow, { rememberFolder: true })",
            doc_js,
        )

    def test_pick_file_initialdir_handling(self):
        chosen_pdf = str(self.folder_a / "algebra.pdf")
        fake_tk = MagicMock()
        with patch("tkinter.Tk", return_value=fake_tk), \
             patch("tkinter.filedialog.askopenfilename", return_value=chosen_pdf) as mock_ask:
            # 1. Empty folder -> initialdir is None (OS remembers last folder, never forces os.getcwd())
            status, data = self._post_json("/api/pick-file", {"folder": ""})
            self.assertEqual(status, 200)
            self.assertTrue(data["ok"])
            self.assertEqual(data["name"], "algebra.pdf")
            self.assertIsNone(mock_ask.call_args.kwargs["initialdir"])

            # 2. Non-existent folder -> initialdir falls back to None
            status, data = self._post_json("/api/pick-file", {"folder": str(self.temp_root / "MissingDir")})
            self.assertEqual(status, 200)
            self.assertIsNone(mock_ask.call_args.kwargs["initialdir"])

            # 3. Existing directory -> initialdir equals that directory
            status, data = self._post_json("/api/pick-file", {"folder": str(self.folder_b)})
            self.assertEqual(status, 200)
            self.assertEqual(
                os.path.normcase(mock_ask.call_args.kwargs["initialdir"]),
                os.path.normcase(str(self.folder_b)),
            )

            # 4. Existing file path -> initialdir equals its parent directory
            file_in_b = self.folder_b / "sample.pdf"
            file_in_b.write_bytes(_minimal_pdf_bytes())
            status, data = self._post_json("/api/pick-file", {"folder": str(file_in_b)})
            self.assertEqual(status, 200)
            self.assertEqual(
                os.path.normcase(mock_ask.call_args.kwargs["initialdir"]),
                os.path.normcase(str(self.folder_b)),
            )

    def _find_edge(self) -> Path:
        env_browser = os.environ.get("READER_TEST_BROWSER")
        candidates = [
            Path(env_browser) if env_browser else None,
            Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
            Path(shutil.which("msedge") or "") if shutil.which("msedge") else None,
        ]
        for candidate in candidates:
            if candidate and candidate.exists():
                return candidate
        self.skipTest("Microsoft Edge not found for headless browser verification")

    def test_browser_open_btn_and_new_tab_and_silent_save(self):
        edge = self._find_edge()
        pdf_1 = self.folder_a / "lecture-1.pdf"
        pdf_2 = self.folder_b / "lecture-2.pdf"
        pdf_1.write_bytes(_minimal_pdf_bytes())
        pdf_2.write_bytes(_minimal_pdf_bytes())

        folder_a_js = json.dumps(str(self.folder_a))
        pdf_1_js = json.dumps(str(pdf_1))
        pdf_2_js = json.dumps(str(pdf_2))

        injected_script = f"""
<script>
window.addEventListener('load', () => {{
    (async () => {{
        const report = async (payload) => {{
            try {{
                await fetch('/__test_done', {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/json' }},
                    body: JSON.stringify(payload)
                }});
            }} catch (_) {{}}
        }};
        try {{
            function assert(cond, msg) {{
                if (!cond) throw new Error(msg);
            }}
            const waitUntil = async (fn, timeoutMs = 15000) => {{
                const start = Date.now();
                while (Date.now() - start < timeoutMs) {{
                    if (await fn()) return;
                    await new Promise(r => setTimeout(r, 30));
                }}
                throw new Error('Timeout waiting for condition');
            }};

            let showOpenCalled = 0;
            let fileInputClicked = 0;
            window.showOpenFilePicker = async () => {{
                showOpenCalled++;
                throw new Error('showOpenFilePicker must NOT be called');
            }};
            document.getElementById('file-input').addEventListener('click', () => {{
                fileInputClicked++;
            }});

            const openedUrls = [];
            window.open = (url) => {{
                openedUrls.push(String(url));
                return {{ closed: false, postMessage() {{}} }};
            }};

            // 1. Click #open-btn -> opens lecture-1.pdf via backend picker
            document.getElementById('open-btn').click();
            await waitUntil(() => state.pdfDoc && state.pdfDoc.numPages === 1 && !state.annotationsLoading);

            assert(showOpenCalled === 0, 'window.showOpenFilePicker must not be called');
            assert(fileInputClicked === 0, '#file-input must not be clicked');
            assert(state.fileName === 'lecture-1.pdf', 'Expected lecture-1.pdf, got ' + state.fileName);
            assert(state.localFilePath === {pdf_1_js}, 'Expected localFilePath bound to pdf_1');
            assert(state.fileHandle === null, 'fileHandle must remain null');
            assert(document.getElementById('doc-title').classList.contains('text-green-600'), 'Doc title must turn green');
            assert(localStorage.getItem('pdf_reader_last_open_folder') === {folder_a_js}, 'Must remember folder_a');

            // 2. Add annotation and silently save in-place via /api/save-file
            performAction(() => {{
                state.annotations[1] = [{{
                    id: 'unified-open-save-check',
                    type: 'highlight',
                    color: '#fde047',
                    rects: [{{ x: 0.1, y: 0.1, w: 0.3, h: 0.03 }}],
                    text: 'note'
                }}];
            }}, [1]);
            assert(document.getElementById('save-status-btn').title.includes('覆盖保存到原文件'), 'Save tooltip must reflect local in-place save');
            await performSave();
            assert(!state.unsavedChanges && !state.isSaving, 'Save must complete cleanly');

            // 3. Click #open-new-btn -> opens lecture-2.pdf via ?open= URL in new tab
            document.getElementById('open-new-btn').click();
            await waitUntil(() => openedUrls.length === 1 && !quickFolderBusy);
            const parsedNewTab = new URL(openedUrls[0]);
            assert(parsedNewTab.searchParams.get('open') === {pdf_2_js}, 'New tab URL must carry ?open=pdf_2');

            // 4. Quick folder button still uses its own configured folder
            document.getElementById('quick-folder-btn-1').click();
            await waitUntil(() => !quickFolderBusy);

            await report({{ ok: true }});
        }} catch (err) {{
            await report({{ ok: false, error: String(err && err.stack ? err.stack : err) }});
        }}
    }})();
}});
</script>
"""
        fixture_html = self.temp_root / "fixture_index.html"
        base_html = (ROOT / "static/index.html").read_text(encoding="utf-8")
        fixture_html.write_text(base_html.replace("</body>", injected_script + "</body>", 1), encoding="utf-8")
        self.httpd.fixture_html = fixture_html

        recorded_initialdirs = []
        seq = [str(pdf_1), str(pdf_2), ""]

        def fake_ask(**kwargs):
            recorded_initialdirs.append(kwargs.get("initialdir"))
            return seq.pop(0) if seq else ""

        fake_tk = MagicMock()
        with tempfile.TemporaryDirectory(prefix="reader-edge-profile-") as profile_dir, \
             patch("tkinter.Tk", return_value=fake_tk), \
             patch("tkinter.filedialog.askopenfilename", side_effect=fake_ask):
            proc = subprocess.Popen(
                [
                    str(edge),
                    "--headless=new",
                    "--disable-gpu",
                    "--no-first-run",
                    f"--user-data-dir={profile_dir}",
                    "--window-size=1400,900",
                    f"{self.origin}/index.html",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                finished = self.httpd.browser_done.wait(timeout=20)
                self.assertTrue(finished, "Timed out waiting for headless browser test completion")
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)

        self.assertIsNotNone(self.httpd.browser_result)
        self.assertTrue(
            self.httpd.browser_result.get("ok"),
            msg=self.httpd.browser_result.get("error"),
        )

        # Verify initialdir sequence: 1st #open-btn -> None; 2nd #open-new-btn -> remembered folder_a
        self.assertGreaterEqual(len(recorded_initialdirs), 3)
        self.assertIsNone(recorded_initialdirs[0])
        self.assertEqual(os.path.normcase(recorded_initialdirs[1]), os.path.normcase(str(self.folder_a)))

        # Verify silent in-place save wrote ReaderProAnnos directly into pdf_1 on disk
        import re as _re

        saved_bytes = pdf_1.read_bytes()
        chunks = [saved_bytes]
        for m in _re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", saved_bytes, flags=_re.S):
            raw_stream = m.group(1)
            if raw_stream:
                try:
                    chunks.append(zlib.decompress(raw_stream))
                except zlib.error:
                    pass
        combined = b"".join(chunks)
        self.assertIn(b"ReaderProAnnos", combined)
        self.assertIn(b"unified-open-save-check".hex().encode("ascii"), combined.lower())


if __name__ == "__main__":
    unittest.main()
