"""Unit tests for handwriting whiteboard copy-image button and bounding-crop logic."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class TestWhiteboardCopyButton(unittest.TestCase):
    def setUp(self):
        self.phone_js = (ROOT / 'static/js/phone-handwriting.js').read_text(encoding='utf-8')
        self.wb_js = (ROOT / 'static/js/handwriting-whiteboard.js').read_text(encoding='utf-8')
        self.style_css = (ROOT / 'static/css/style.css').read_text(encoding='utf-8')

    def test_static_definitions(self):
        # 1. phone-handwriting.js
        self.assertIn('function getContentBounds(board)', self.phone_js)
        self.assertIn('function renderCroppedCanvas(board', self.phone_js)
        self.assertIn('async function copyBoardImage(board', self.phone_js)
        self.assertIn('getContentBounds, renderCroppedCanvas, copyBoardImage', self.phone_js)

        # 2. handwriting-whiteboard.js
        self.assertIn('id="whiteboard-copy-image"', self.wb_js)
        self.assertIn('复制图片', self.wb_js)
        self.assertIn('$(\'copy-image\').onclick = copyBoardImage', self.wb_js)
        self.assertIn('PhoneHandwriting.copyBoardImage(board)', self.wb_js)
        self.assertIn('已复制充满状态的画板图片', self.wb_js)
        self.assertIn('画板暂无手写笔迹可复制', self.wb_js)

        # 3. style.css
        self.assertIn('.wb-tool-btn.copied', self.style_css)

    def test_browser_runtime_behavior(self):
        edge_path = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            edge_path = Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            self.skipTest("Edge browser not found for headless testing")

        test_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<script>
{self.phone_js}
</script>
<script>
window.testResults = [];
function assert(cond, msg) {{
    if (!cond) throw new Error(msg);
}}

// 1. 空白画板边界
assert(PhoneHandwriting.getContentBounds(null) === null, "null board should return null bounds");
assert(PhoneHandwriting.getContentBounds({{ strokes: [] }}) === null, "empty board should return null bounds");
assert(PhoneHandwriting.getContentBounds({{ strokes: [{{ k: 'eraser', p: [[10, 10]], w: 10 }}] }}) === null, "eraser-only should return null bounds");

// 2. 笔迹边界测试
const board = {{
    w: 900,
    h: 400,
    strokes: [
        {{ k: 'pen', c: '#000000', w: 4, p: [[100, 100], [200, 150]] }},
        {{ k: 'eraser', c: '#ffffff', w: 20, p: [[150, 120]] }}
    ]
}};
const bounds = PhoneHandwriting.getContentBounds(board);
assert(bounds !== null, "valid board must have bounds");
// r = 2, x in [100, 200] => [98, 202]; y in [100, 150] => [98, 152]
assert(Math.abs(bounds.left - 98) < 0.01, "left bound should be 98");
assert(Math.abs(bounds.right - 202) < 0.01, "right bound should be 202");
assert(Math.abs(bounds.top - 98) < 0.01, "top bound should be 98");
assert(Math.abs(bounds.bottom - 152) < 0.01, "bottom bound should be 152");

// 3. 裁剪充满画布生成
const canvas = PhoneHandwriting.renderCroppedCanvas(board);
assert(canvas instanceof HTMLCanvasElement, "renderCroppedCanvas should return a canvas");
assert(canvas.width >= 500 && canvas.width <= 2400, "canvas width should be scaled appropriately: " + canvas.width);
assert(canvas.height >= 200 && canvas.height <= 2400, "canvas height should be scaled appropriately: " + canvas.height);

// 验证背景底色为纯白 (#ffffff)
const ctx = canvas.getContext('2d');
const pixel = ctx.getImageData(0, 0, 1, 1).data;
assert(pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255 && pixel[3] === 255, "canvas corner background should be white");
</script>
<script>
// 4. 白板 DOM 注入与按钮测试
window.state = {{ currentTool: 'cursor' }};
window.updateToolButtons = function() {{}};
window.renderLatex = function() {{}};
{self.wb_js}
HandwritingWhiteboard.show();

const copyBtn = document.getElementById('whiteboard-copy-image');
assert(copyBtn !== null, "copy image button must exist in DOM");
assert(copyBtn.closest('#whiteboard-actions') !== null, "copy button must be inside #whiteboard-actions");
assert(copyBtn.querySelector('span')?.textContent === '复制图片', "button text should be '复制图片'");
assert(copyBtn.querySelector('.ph-copy') !== null, "button should have ph-copy icon");
assert(copyBtn.title.includes('复制'), "button should have descriptive title");

// 点击空画板测试防护提示
copyBtn.click();
const statusEl = document.getElementById('whiteboard-status');
assert(statusEl.textContent.includes('暂无手写笔迹'), "empty board click should show notice toast: " + statusEl.textContent);

document.title = "TESTS_PASSED";
</script>
</body>
</html>
"""
        with tempfile.NamedTemporaryFile(suffix='.html', delete=False, mode='w', encoding='utf-8') as f:
            f.write(test_html)
            temp_path = f.name

        try:
            cmd = [
                str(edge_path),
                "--headless=new",
                "--disable-gpu",
                "--dump-dom",
                temp_path
            ]
            res = subprocess.run(cmd, capture_output=True, timeout=15)
            stdout = res.stdout.decode('utf-8', errors='replace')
            stderr = res.stderr.decode('utf-8', errors='replace')
            self.assertIn("TESTS_PASSED", stdout, f"Headless browser test failed: {stdout}\n{stderr}")
        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

if __name__ == '__main__':
    unittest.main()
