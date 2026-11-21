"""Regression tests verifying free-parenthesis bracket curvature remains invariant under zoom."""
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FreeParenthesisZoomTests(unittest.TestCase):
    def _find_edge(self) -> Path:
        for candidate in (
            Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        ):
            if candidate.exists():
                return candidate
        self.skipTest("Microsoft Edge not found for headless browser verification")

    def test_free_parenthesis_curvature_invariant_across_scales(self):
        edge_path = self._find_edge()
        index_html = (ROOT / "static/index.html").read_text(encoding="utf-8")
        base_tag = f'<base href="{(ROOT / "static").as_uri()}/">'

        test_script = r"""
<script>
window.addEventListener('load', () => {
    setTimeout(() => {
        try {
            function assert(cond, msg) {
                if (!cond) throw new Error(msg);
            }
            function parseQuadPath(d) {
                const m = /^M\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+Q\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)$/.exec((d || '').trim());
                assert(m, 'Unexpected quadratic Bezier path: ' + d);
                const nums = m.slice(1).map(Number);
                return {
                    x0: nums[0], y0: nums[1],
                    cx: nums[2], cy: nums[3],
                    x1: nums[4], y1: nums[5],
                };
            }
            function curvatureRatio(q) {
                const height = Math.abs(q.y1 - q.y0);
                // Horizontal sagitta of quadratic Bezier M(x0,y0) Q(cx,cy) (x0,y1) is |cx - x0| / 2
                const depth = Math.abs(q.cx - q.x0) / 2;
                assert(height > 0, 'Height must be positive');
                return depth / height;
            }

            const baseW = 600;
            const baseH = 800;
            const anno = {
                id: 'fp-zoom-1',
                type: 'free-parenthesis',
                color: '#f87171',
                start: { x: 0.2, y: 0.3 },
                end: { x: 0.6, y: 0.3 },
                thickness: 0.05,
                localX: 0.35,
                lineOffset: 0.5,
                note: '',
                text: '[自由括号]',
            };

            const scales = [0.5, 1.0, 1.5, 2.0, 3.0];
            let baselineLeftRatio = null;
            let baselineRightRatio = null;
            let baselineTipHeightRatio = null;

            for (const scale of scales) {
                const container = document.createElement('div');
                const w = baseW * scale;
                const h = baseH * scale;
                appendAnnotationNodes(anno, 1, container, w, h, scale);
                const paths = container.querySelectorAll('svg g path');
                assert(paths.length === 2, `Expected 2 paths for free-parenthesis at scale ${scale}, got ${paths.length}`);

                const leftQ = parseQuadPath(paths[0].getAttribute('d'));
                const rightQ = parseQuadPath(paths[1].getAttribute('d'));
                const leftRatio = curvatureRatio(leftQ);
                const rightRatio = curvatureRatio(rightQ);
                const tipHeightRatio = leftQ.x0 / (leftQ.y1 - leftQ.y0);

                assert(Math.abs(leftRatio - rightRatio) < 1e-9,
                    `Left (${leftRatio}) and right (${rightRatio}) bracket curvature ratios must match at scale ${scale}`);

                if (baselineLeftRatio === null) {
                    baselineLeftRatio = leftRatio;
                    baselineRightRatio = rightRatio;
                    baselineTipHeightRatio = tipHeightRatio;
                } else {
                    assert(Math.abs(leftRatio - baselineLeftRatio) < 1e-9,
                        `Left bracket curvature changed at scale ${scale}: ${leftRatio} vs ${baselineLeftRatio}`);
                    assert(Math.abs(rightRatio - baselineRightRatio) < 1e-9,
                        `Right bracket curvature changed at scale ${scale}: ${rightRatio} vs ${baselineRightRatio}`);
                    assert(Math.abs(tipHeightRatio - baselineTipHeightRatio) < 1e-9,
                        `Tip offset proportion changed at scale ${scale}: ${tipHeightRatio} vs ${baselineTipHeightRatio}`);
                }
            }

            // Also verify live drawing preview uses the exact same metrics at scale 2.0
            const host = document.createElement('div');
            host.className = 'page-wrapper';
            host.dataset.pageNum = '1';
            host.style.position = 'fixed';
            host.style.left = '0px';
            host.style.top = '0px';
            host.style.width = (baseW * 2.0) + 'px';
            host.style.height = (baseH * 2.0) + 'px';
            const layer = document.createElement('div');
            layer.className = 'annotation-layer';
            layer.id = 'annotation-layer-1';
            host.appendChild(layer);
            document.body.appendChild(host);

            state.scale = 2.0;
            state.currentTool = 'free-parenthesis';
            state.currentColor = '#f87171';

            // Phase 1: drag axis from (240, 480) to (720, 480)
            host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 240, clientY: 480 }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 720, clientY: 480 }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 720, clientY: 480 }));

            // Phase 2: move vertically by thickness = 0.05 * (800 * 2) = 80px -> clientY = 560
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 720, clientY: 560 }));
            const tempSvg = document.getElementById('temp-drawing-svg');
            assert(tempSvg, 'Expected temporary SVG during phase 2');
            const previewLeftQ = parseQuadPath(tempSvg.querySelector('.fp-left').getAttribute('d'));
            const previewLeftRatio = curvatureRatio(previewLeftQ);
            assert(Math.abs(previewLeftRatio - baselineLeftRatio) < 1e-9,
                `Phase 2 preview curvature (${previewLeftRatio}) must match rendered curvature (${baselineLeftRatio})`);

            // Phase 2 click -> Phase 3, move right bracket to localX = 420 (clientX = 660), yOffset = 40 -> clientY = 560
            host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 660, clientY: 560 }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 660, clientY: 560 }));
            const previewRightQ = parseQuadPath(tempSvg.querySelector('.fp-right').getAttribute('d'));
            const previewRightRatio = curvatureRatio(previewRightQ);
            assert(Math.abs(previewRightRatio - baselineRightRatio) < 1e-9,
                `Phase 3 preview curvature (${previewRightRatio}) must match rendered curvature (${baselineRightRatio})`);

            cancelActiveDrawing();
            host.remove();

            document.title = 'FREE_PARENTHESIS_ZOOM_TEST_OK';
        } catch (err) {
            document.title = 'FREE_PARENTHESIS_ZOOM_TEST_ERR: ' + (err && err.stack ? err.stack : err);
        }
    }, 100);
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
                "--window-size=1440,920",
                "--virtual-time-budget=3000",
                "--dump-dom",
                temp_path,
            ]
            res = subprocess.run(cmd, capture_output=True, timeout=25)
            stdout = res.stdout.decode("utf-8", errors="replace")
            m = re.search(r"<title>(.*?)</title>", stdout, re.S)
            self.assertIsNotNone(m, "Headless browser did not produce a <title>")
            self.assertEqual(m.group(1), "FREE_PARENTHESIS_ZOOM_TEST_OK")
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


if __name__ == "__main__":
    unittest.main()
