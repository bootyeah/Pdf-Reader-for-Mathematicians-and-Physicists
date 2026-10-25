"""Unit tests for iPad handwriting whiteboard palm rest (防误触掌托) feature."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class TestIPadWhiteboardPalmRest(unittest.TestCase):
    def setUp(self):
        self.html_content = (ROOT / 'airtex/web/index.html').read_text(encoding='utf-8')

    def test_static_definitions(self):
        # 1. DOM 结构
        self.assertIn('id="palmRest"', self.html_content)
        self.assertIn('id="palmRestDivider"', self.html_content)
        self.assertIn('class="palm-rest-line"', self.html_content)
        self.assertIn('class="palm-rest-pill"', self.html_content)
        self.assertIn('id="palmRestArea"', self.html_content)

        # 2. CSS 样式
        self.assertIn('#palmRest{', self.html_content)
        self.assertIn('.palm-rest-divider{', self.html_content)
        self.assertIn('.palm-rest-line{', self.html_content)
        self.assertIn('.palm-rest-pill{', self.html_content)
        self.assertIn('.palm-rest-area{', self.html_content)

        # 3. JS 状态与逻辑
        self.assertIn('var palmRestRatio', self.html_content)
        self.assertIn('var palmRestHeight', self.html_content)
        self.assertIn('function updatePalmRestLayout()', self.html_content)
        self.assertIn('function isPointInPalmRest(', self.html_content)
        self.assertIn('function initPalmRestControls()', self.html_content)
        self.assertIn('isPointInPalmRest(t.clientX, t.clientY)', self.html_content)
        self.assertIn('isPointInPalmRest(t0.clientX, t0.clientY)', self.html_content)
        self.assertIn('localStorage.setItem("airtex_ipad_palm_rest_ratio"', self.html_content)

    def test_browser_runtime_behavior(self):
        edge_path = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            edge_path = Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            self.skipTest("Edge browser not found for headless testing")

        # 构造测试 HTML，模拟真实 iPad 环境与桌面环境
        test_html = self.html_content.replace(
            "<!--AIRTEX_BOOT-->",
            "<script>window.AIRTEX_TOKEN='test_token';window.AIRTEX_PROTOCOL=1;window.AIRTEX_PARAGRAPH=true;window.AIRTEX_NAME='reader';</script>"
        )

        test_script = """
<script>
(async function() {
  function assert(cond, msg) {
    if (!cond) {
      console.error("ASSERT_FAILED: " + msg);
      document.title = "FAIL: " + msg;
      throw new Error(msg);
    }
  }

  try {
    // 等待初始化
    await new Promise(r => setTimeout(r, 100));

    // 1. iPad 环境检测
    document.documentElement.classList.add("is-ipad");
    assert(window.__airtex.isIPad === true, "isIPad should be true when is-ipad class is present");

    // 2. 掌托布局初始化验证
    window.__airtex.palmRest.setLayout();
    const palmRestEl = document.getElementById("palmRest");
    const dividerEl = document.getElementById("palmRestDivider");
    const areaEl = document.getElementById("palmRestArea");
    assert(palmRestEl !== null, "palmRest element must exist");
    assert(dividerEl !== null, "palmRestDivider element must exist");
    assert(areaEl !== null, "palmRestArea element must exist");
    assert(palmRestEl.hidden === false, "palmRest should be visible on iPad by default");

    const stageEl = document.getElementById("stage");
    const stageH = stageEl.clientHeight || 400;
    const initialH = window.__airtex.palmRest.height;
    assert(initialH >= 0, "initial palmRest height must be valid");

    // 3. 坐标拦截测试 isPointInPalmRest
    const canvasEl = document.getElementById("board");
    const r = canvasEl.getBoundingClientRect();
    const lineY = r.bottom - window.__airtex.palmRest.height;

    // 横线上方坐标：不应在掌托区域
    assert(window.__airtex.palmRest.isPointInPalmRest(r.left + 50, lineY - 20) === false, "point above line should NOT be in palm rest");
    // 横线下方坐标：必须在掌托区域
    assert(window.__airtex.palmRest.isPointInPalmRest(r.left + 50, lineY + 20) === true, "point below line MUST be in palm rest");

    // 4. 下半部分落笔拦截测试 (防手掌误触)
    window.__airtex.clear();
    const palmTouchEvt = new MouseEvent("mousedown", {
      clientX: r.left + 60,
      clientY: lineY + 30,
      button: 0,
      bubbles: true,
      cancelable: true
    });
    canvasEl.dispatchEvent(palmTouchEvt);
    assert(window.__airtex.strokes === 0, "touching inside palm rest area must NOT create strokes");

    // 5. 拖动直线调整范围测试
    const newRatio = 0.50;
    window.__airtex.palmRest.setRatio(newRatio);
    assert(Math.abs(window.__airtex.palmRest.ratio - 0.50) < 0.05, "ratio should update when set");
    const updatedLineY = r.bottom - window.__airtex.palmRest.height;
    assert(window.__airtex.palmRest.isPointInPalmRest(r.left + 50, updatedLineY + 10) === true, "point below new line must be in palm rest");

    // 6. 防误触按钮联动测试
    const palmGuardBtn = document.getElementById("palmGuardBtn");
    palmGuardBtn.click(); // 关闭防误触
    assert(window.__airtex.palmGuard === false, "palmGuard should be turned off");
    assert(palmRestEl.hidden === true, "palmRest should be hidden when palmGuard is off");

    palmGuardBtn.click(); // 重新开启
    assert(window.__airtex.palmGuard === true, "palmGuard should be turned on");
    assert(palmRestEl.hidden === false, "palmRest should be visible when palmGuard is on");

    document.title = "TESTS_PASSED";
  } catch (err) {
    document.title = "TEST_ERROR: " + err.message;
  }
})();
</script>
"""
        test_html += test_script

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
