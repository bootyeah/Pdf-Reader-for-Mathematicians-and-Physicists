import os
import unittest
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class TestWindowShortcutHints(unittest.TestCase):
    def test_css_rules_exist(self):
        css_path = ROOT / 'static/css/style.css'
        content = css_path.read_text(encoding='utf-8')

        self.assertIn('.window-shortcut-btn', content)
        self.assertIn('.ws-action', content)
        self.assertIn('.ws-key', content)
        self.assertIn('.video-shortcut-btn', content)
        self.assertIn('.wb-shortcut-btn', content)
        self.assertIn('.cp-shortcut-btn', content)
        self.assertIn('.mm-shortcut-btn', content)
        self.assertIn('.video-panel-title', content)
        self.assertIn('body.eye-protection-mode .wb-shortcut-btn', content)

    def test_html_mindmap_shortcut_btn(self):
        html_path = ROOT / 'static/index.html'
        content = html_path.read_text(encoding='utf-8')

        self.assertIn('id="mindmap-shortcut-btn"', content)
        self.assertIn('mm-shortcut-btn', content)
        self.assertIn('<kbd class="ws-key">T</kbd>', content)
        self.assertIn('<span class="ws-action">收起</span>', content)

    def test_js_sources_have_shortcut_buttons(self):
        wb_content = (ROOT / 'static/js/handwriting-whiteboard.js').read_text(encoding='utf-8')
        self.assertIn('whiteboard-shortcut-btn', wb_content)
        self.assertIn('wb-shortcut-btn', wb_content)
        self.assertIn('<kbd class="ws-key">V</kbd>', wb_content)

        cp_content = (ROOT / 'static/js/companion-pdf.js').read_text(encoding='utf-8')
        self.assertIn('cp-shortcut-btn', cp_content)
        self.assertIn('<kbd class="ws-key">P</kbd>', cp_content)

        video_content = (ROOT / 'static/js/video.js').read_text(encoding='utf-8')
        self.assertIn('video-header-shortcut-btn', video_content)
        self.assertIn('video-shortcut-btn', video_content)
        self.assertIn('<kbd class="ws-key">Shift</kbd>', video_content)
        self.assertIn('视频伴读', video_content)

        mm_content = (ROOT / 'static/js/mindmap.js').read_text(encoding='utf-8')
        self.assertIn('shortcutBtn: document.getElementById(\'mindmap-shortcut-btn\')', mm_content)

    def test_browser_dom_and_interactions(self):
        edge_path = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            edge_path = Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            self.skipTest("Edge browser not found for headless testing")

        index_html = (ROOT / "static/index.html").read_text(encoding="utf-8")
        base_tag = f'<base href="{(ROOT / "static").as_uri()}/">'
        test_script = """
<script>
window.addEventListener('load', () => {
    try {
        function assert(cond, msg) {
            if (!cond) throw new Error(msg);
        }

        // 1. Mindmap
        window.MindMap.toggle(true);
        const mmBtn = document.getElementById('mindmap-shortcut-btn');
        assert(mmBtn, 'mindmap-shortcut-btn should exist in DOM');
        assert(mmBtn.querySelector('.ws-key').textContent.trim() === 'T', 'Mindmap key should be T');
        assert(mmBtn.querySelector('.ws-action').textContent.trim() === '收起', 'Mindmap action should be 收起');

        // Clicking mindmap shortcut button should close mindmap
        mmBtn.click();
        assert(document.getElementById('mindmap-panel').classList.contains('hidden'), 'Clicking mmBtn should hide mindmap');

        // 2. Whiteboard
        window.HandwritingWhiteboard.show();
        const wbBtn = document.getElementById('whiteboard-shortcut-btn');
        assert(wbBtn, 'whiteboard-shortcut-btn should exist in DOM');
        assert(wbBtn.querySelector('.ws-key').textContent.trim() === 'V', 'Whiteboard key should be V');
        assert(wbBtn.querySelector('.ws-action').textContent.trim() === '折叠', 'Whiteboard initial action should be 折叠');

        // Clicking whiteboard shortcut button should collapse it
        wbBtn.click();
        assert(wbBtn.querySelector('.ws-action').textContent.trim() === '展开', 'Whiteboard action should update to 展开 when collapsed');
        wbBtn.click();
        assert(wbBtn.querySelector('.ws-action').textContent.trim() === '折叠', 'Whiteboard action should update back to 折叠');

        // 3. Video companion
        const videoToolbarBtn = document.getElementById('video-btn');
        if (videoToolbarBtn) videoToolbarBtn.click();
        const videoBtn = document.getElementById('video-header-shortcut-btn');
        assert(videoBtn, 'video-header-shortcut-btn should exist in DOM');
        assert(videoBtn.querySelector('.ws-key').textContent.trim() === 'Shift', 'Video key should be Shift');
        assert(videoBtn.querySelector('.ws-action').textContent.trim() === '折叠', 'Video action should be 折叠');

        videoBtn.click();
        assert(videoBtn.querySelector('.ws-action').textContent.trim() === '展开', 'Video action should update to 展开 when collapsed');
        videoBtn.click();
        assert(videoBtn.querySelector('.ws-action').textContent.trim() === '折叠', 'Video action should update back to 折叠');

        // 4. Companion PDF
        const compToolbarBtn = document.getElementById('open-companion-btn');
        if (compToolbarBtn) compToolbarBtn.click();
        const cpBtn = document.getElementById('cp-shortcut-btn');
        assert(cpBtn, 'cp-shortcut-btn should exist in DOM');
        assert(cpBtn.querySelector('.ws-key').textContent.trim() === 'P', 'Companion key should be P');
        assert(cpBtn.querySelector('.ws-action').textContent.trim() === '折叠', 'Companion action should be 折叠');

        cpBtn.click();
        assert(cpBtn.querySelector('.ws-action').textContent.trim() === '展开', 'Companion action should update to 展开 when collapsed');
        cpBtn.click();
        assert(cpBtn.querySelector('.ws-action').textContent.trim() === '折叠', 'Companion action should update back to 折叠');

        document.title = 'SHORTCUT_HINTS_ALL_OK';
    } catch (e) {
        document.title = 'SHORTCUT_HINTS_ERR: ' + (e && e.message ? e.message : e);
    }
});
</script>
"""
        patched_html = index_html.replace("<head>", "<head>" + base_tag, 1).replace("</body>", test_script + "</body>", 1)
        with tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w", encoding="utf-8") as f:
            f.write(patched_html)
            temp_path = f.name

        try:
            cmd = [
                str(edge_path),
                "--headless=new",
                "--disable-gpu",
                "--virtual-time-budget=2500",
                "--dump-dom",
                temp_path
            ]
            res = subprocess.run(cmd, capture_output=True, timeout=25)
            stdout = res.stdout.decode("utf-8", errors="replace")
            self.assertIn("SHORTCUT_HINTS_ALL_OK", stdout)
        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

if __name__ == '__main__':
    unittest.main()
