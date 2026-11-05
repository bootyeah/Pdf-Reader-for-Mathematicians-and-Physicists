import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class TestToolbarCollapseAndMindmapPopover(unittest.TestCase):
    def test_static_markup_and_css_integrity(self):
        mindmap_js = (ROOT / "static/js/mindmap.js").read_text(encoding="utf-8")
        self.assertNotIn("Math Logic", mindmap_js)
        self.assertNotIn("标记该节点在推演论证中的角色定位", mindmap_js)
        self.assertIn("数学理论角色", mindmap_js)
        self.assertIn("清除角色", mindmap_js)

        index_html = (ROOT / "static/index.html").read_text(encoding="utf-8")
        for required_id in (
            'id="main-toolbar"',
            'id="toolbar-left-group"',
            'id="toolbar-right-group"',
            'id="toolbar-view-group"',
            'id="toolbar-anno-group"',
            'id="custom-color-wrapper"',
            'id="toolbar-file-divider"',
            'id="toolbar-file-group"',
            'id="toggle-toolbar-btn"',
        ):
            self.assertIn(required_id, index_html)

        style_css = (ROOT / "static/css/style.css").read_text(encoding="utf-8")
        self.assertIn("body.toolbar-collapsed #main-toolbar", style_css)
        for hover_rule in (
            "body.toolbar-collapsed #deepseek-chat-btn:hover::after { background-color: #2563eb !important; }",
            'body.toolbar-collapsed .tool-btn[data-tool="highlight"]:hover::after { background-color: #ca8a04 !important; }',
            'body.toolbar-collapsed .tool-btn[data-tool="underline"]:hover::after { background-color: #dc2626 !important; }',
            'body.toolbar-collapsed .tool-btn[data-tool="parenthesis"]:hover::after { background-color: #9333ea !important; }',
            'body.toolbar-collapsed .tool-btn[data-tool="brace"]:hover::after { background-color: #f97316 !important; }',
            'body.toolbar-collapsed .tool-btn[data-tool="text"]:hover::after { background-color: #1f2937 !important; }',
            'body.toolbar-collapsed .tool-btn[data-tool="arrow"]:hover::after { background-color: #2563eb !important; }',
            "body.toolbar-collapsed #marker-dropdown-wrapper:hover #active-marker-btn::after { background-color: #ef4444 !important; }",
            'body.toolbar-collapsed .color-btn[data-color="#fde047"]:hover::after { background-color: #fde047 !important; }',
            'body.toolbar-collapsed .color-btn[data-color="#f87171"]:hover::after { background-color: #f87171 !important; }',
            'body.toolbar-collapsed .color-btn[data-color="#4ade80"]:hover::after { background-color: #4ade80 !important; }',
            'body.toolbar-collapsed .color-btn[data-color="#60a5fa"]:hover::after { background-color: #60a5fa !important; }',
            'body.toolbar-collapsed .color-btn[data-color="#000000"]:hover::after { background-color: #000000 !important; }',
            "body.toolbar-collapsed #custom-color-wrapper:hover::after { background-color: var(--custom-color, #fde047) !important; }",
        ):
            self.assertIn(hover_rule, style_css)

        annotate_js = (ROOT / "static/js/annotate.js").read_text(encoding="utf-8")
        self.assertIn("toolbar-collapsed", annotate_js)

    def _find_edge(self) -> Path:
        for candidate in (
            Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        ):
            if candidate.exists():
                return candidate
        self.skipTest("Microsoft Edge not found for headless browser verification")

    def test_mindmap_tag_popover_and_collapsible_toolbar_runtime(self):
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

            // =================================================================
            // 1. MindMap Math Role Popover: verify removed texts & intact behavior
            // =================================================================
            window.MindMap.toggle(true);
            const firstCard = document.querySelector('#mindmap-tree-root .mm-card');
            assert(firstCard !== null, 'Mindmap card must exist');
            firstCard.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 160, clientY: 180 }));

            const ctxMenu = document.getElementById('mm-context-menu');
            assert(ctxMenu !== null, 'Context menu must open on right-click');
            const pickTagItem = ctxMenu.querySelector('.mm-menu-item[data-action="pick-tag"]');
            assert(pickTagItem !== null, 'pick-tag menu item must exist');
            pickTagItem.click();

            const pop = document.getElementById('mm-popover-dialog');
            assert(pop !== null, 'Math role popover must open');
            const popText = pop.textContent || '';
            assert(!popText.includes('Math Logic'), 'Popover must NOT contain "Math Logic"');
            assert(!popText.includes('标记该节点在推演论证中的角色定位'), 'Popover must NOT contain subtitle text');
            assert(popText.includes('数学理论角色'), 'Popover title "数学理论角色" must remain');
            assert(popText.includes('清除角色'), 'Clear button "清除角色" must remain');
            assert(pop.querySelectorAll('.mm-tag-pick-btn').length === 9, 'All 9 math role buttons must remain');

            const lemmaBtn = pop.querySelector('.mm-tag-pick-btn[data-key="lemma"]');
            assert(lemmaBtn !== null, 'Lemma tag button must exist');
            lemmaBtn.click();
            assert(document.getElementById('mm-popover-dialog') === null, 'Popover should close after picking tag');
            window.MindMap.toggle(false);

            // =================================================================
            // 2. Collapsible Top Toolbar: geometry, segment bars & actions
            // =================================================================
            const header = document.getElementById('main-toolbar');
            const toggleBtn = document.getElementById('toggle-toolbar-btn');
            assert(header !== null && toggleBtn !== null, 'Header and #toggle-toolbar-btn must exist');
            assert(header.offsetHeight === 72, 'Expanded header height must be 72px, got ' + header.offsetHeight);

            const targetControls = [
                document.getElementById('deepseek-chat-btn'),
                ...document.querySelectorAll('#tool-group .tool-btn'),
                ...document.querySelectorAll('#color-group .color-btn'),
                document.getElementById('custom-color-wrapper'),
            ];
            assert(targetControls.length === 14, 'Expected 14 interactive segment controls (1 AI + 7 tools + 5 preset colors + 1 custom color), got ' + targetControls.length);

            const expandedRects = targetControls.map(el => {
                const r = el.getBoundingClientRect();
                return { left: r.left, width: r.width, centerX: r.left + r.width / 2 };
            });

            // Collapse toolbar (disable transition temporarily for instant measurement)
            header.style.transition = 'none';
            toggleBtn.click();
            void header.offsetHeight;

            assert(document.body.classList.contains('toolbar-collapsed'), 'Body must have toolbar-collapsed class');
            assert(header.offsetHeight === 12, 'Collapsed header height must be 12px, got ' + header.offsetHeight);
            assert(toggleBtn.getAttribute('aria-expanded') === 'false', 'aria-expanded should be false when collapsed');
            assert(toggleBtn.title === '展开工具栏', 'Toggle button title should update to 展开工具栏');

            // Non-target groups must be hidden and collapsed vertically
            for (const sel of ['#toolbar-left-group', '#toolbar-view-group', '.toolbar-anno-divider', '#toolbar-file-divider', '#toolbar-file-group']) {
                const g = document.querySelector(sel);
                assert(g !== null, 'Group must exist: ' + sel);
                const cs = getComputedStyle(g);
                assert(cs.visibility === 'hidden', sel + ' must be visibility:hidden when collapsed');
                assert(g.getBoundingClientRect().height === 0, sel + ' height must be 0 when collapsed');
            }

            // Every retained control must stay at its exact horizontal X position (0px shift) and render ::after segment bar
            targetControls.forEach((el, idx) => {
                const r = el.getBoundingClientRect();
                const before = expandedRects[idx];
                const label = el.id || el.dataset.tool || el.dataset.color || ('idx-' + idx);
                const centerX = r.left + r.width / 2;
                assert(Math.abs(centerX - before.centerX) <= 0.5,
                    `Horizontal center shifted for ${label}: before=${before.centerX}, after=${centerX}`);
                if (!el.classList.contains('selected')) {
                    assert(Math.abs(r.left - before.left) <= 0.5,
                        `Horizontal X shifted for ${label}: before=${before.left}, after=${r.left}`);
                    assert(Math.abs(r.width - before.width) <= 0.5,
                        `Width changed for ${label}: before=${before.width}, after=${r.width}`);
                }
                assert(r.height >= 10 && r.height <= 12,
                    `Collapsed hit height for ${label} should fill thin strip, got ${r.height}`);

                const afterStyle = getComputedStyle(el, '::after');
                assert(afterStyle.content !== 'none' && afterStyle.content !== '',
                    `::after segment bar missing on ${label}`);
                assert(afterStyle.height === '3px',
                    `::after resting height should be 3px on ${label}, got ${afterStyle.height}`);
            });

            // Direct tool icons hidden, but marker dropdown icons remain visible
            assert(getComputedStyle(document.querySelector('#deepseek-chat-btn > svg')).display === 'none', 'AI svg icon should be hidden in collapsed mode');
            assert(getComputedStyle(document.querySelector('.tool-btn[data-tool="highlight"] > i')).display === 'none', 'Highlight icon should be hidden in collapsed mode');
            assert(getComputedStyle(document.querySelector('.marker-select-btn svg')).display !== 'none', 'Marker dropdown menu icons must remain visible');

            // Clicking collapsed segments invokes their functions properly
            // (a) AI chat toggle
            const aiBtn = document.getElementById('deepseek-chat-btn');
            aiBtn.click();
            const chatPanel = document.getElementById('ds-chat-panel');
            assert(chatPanel !== null && getComputedStyle(chatPanel).display === 'flex', 'Clicking collapsed AI segment must open DeepSeek chat');
            const chatTop = parseFloat(chatPanel.style.top);
            assert(chatTop >= 12 && chatTop <= 32, 'Chat panel should anchor right below 12px collapsed toolbar, got top=' + chatTop);
            aiBtn.click();
            assert(getComputedStyle(chatPanel).display === 'none', 'Clicking collapsed AI segment again must close DeepSeek chat');

            // (b) Multi-mode annotation tool cycling while collapsed
            const hlBtn = document.querySelector('.tool-btn[data-tool="highlight"]');
            hlBtn.click();
            assert(state.currentTool === 'highlight', '1st click on collapsed highlight segment should select highlight');
            hlBtn.click();
            assert(state.currentTool === 'highlight-block', '2nd click on collapsed highlight segment should cycle to highlight-block');
            hlBtn.click();
            assert(state.currentTool === 'cursor', '3rd click on collapsed highlight segment should return to cursor');

            const ulBtn = document.querySelector('.tool-btn[data-tool="underline"]');
            ulBtn.click();
            assert(state.currentTool === 'underline', 'Clicking collapsed underline segment should select underline');

            // (c) Preset & custom color selection while collapsed
            const greenBtn = document.querySelector('.color-btn[data-color="#4ade80"]');
            greenBtn.click();
            assert(state.currentColor === '#4ade80', 'Clicking collapsed green color segment should set currentColor to #4ade80');

            const customInput = document.getElementById('custom-color-input');
            customInput.value = '#8b5cf6';
            customInput.dispatchEvent(new Event('input', { bubbles: true }));
            assert(state.currentColor === '#8b5cf6', 'Custom color input in collapsed mode should set currentColor');
            assert(document.getElementById('custom-color-wrapper').style.getPropertyValue('--custom-color') === '#8b5cf6',
                'Custom color wrapper CSS var --custom-color must sync to #8b5cf6');

            // Expand toolbar back and verify full restoration
            toggleBtn.click();
            void header.offsetHeight;
            assert(!document.body.classList.contains('toolbar-collapsed'), 'Body should remove toolbar-collapsed when expanded');
            assert(header.offsetHeight === 72, 'Restored header height must be 72px, got ' + header.offsetHeight);

            document.title = 'TOOLBAR_AND_MINDMAP_OPT_OK';
        } catch (err) {
            document.title = 'TOOLBAR_AND_MINDMAP_OPT_ERR: ' + (err && err.stack ? err.stack : err);
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
            self.assertEqual(m.group(1), "TOOLBAR_AND_MINDMAP_OPT_OK")
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


if __name__ == "__main__":
    unittest.main()
