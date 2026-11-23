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
            'id="toggle-sidebar"',
            'id="toolbar-visibility-group"',
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
        self.assertIn("body.toolbar-collapsed #toggle-sidebar::after", style_css)
        self.assertIn("body.toolbar-collapsed #toggle-sidebar:hover::after", style_css)
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
    setTimeout(async () => {
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
            const nodeId = firstCard.dataset.id;
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
            // 2. Collapsible Top Toolbar: geometry, segment bars, hover rules & actions
            // =================================================================
            const header = document.getElementById('main-toolbar');
            const toggleBtn = document.getElementById('toggle-toolbar-btn');
            assert(header !== null && toggleBtn !== null, 'Header and #toggle-toolbar-btn must exist');
            const initialExpandedHeight = header.offsetHeight;
            assert(initialExpandedHeight >= 60 && initialExpandedHeight <= 80,
                'Expanded header height should be compact (60-80px), got ' + initialExpandedHeight);

            const scaleDownBtn = document.getElementById('toolbar-scale-down');
            const scaleUpBtn = document.getElementById('toolbar-scale-up');
            assert(scaleDownBtn !== null && scaleUpBtn !== null, 'Toolbar scale -/+ bars must exist');
            assert(scaleDownBtn.classList.contains('is-default') && scaleUpBtn.classList.contains('is-default'),
                'Scale bars must highlight default size on load');

            const sidebarBtn = document.getElementById('toggle-sidebar');
            const sidebarEl = document.getElementById('sidebar');
            assert(sidebarBtn !== null && sidebarEl !== null, '#toggle-sidebar and #sidebar must exist');
            const sidebarBtnBefore = (() => {
                const r = sidebarBtn.getBoundingClientRect();
                return { left: r.left, width: r.width, centerX: r.left + r.width / 2 };
            })();

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
            sidebarEl.style.transition = 'none';
            toggleBtn.click();
            void header.offsetHeight;

            assert(document.body.classList.contains('toolbar-collapsed'), 'Body must have toolbar-collapsed class');
            assert(header.offsetHeight === 12, 'Collapsed header height must be 12px, got ' + header.offsetHeight);
            assert(toggleBtn.getAttribute('aria-expanded') === 'false', 'aria-expanded should be false when collapsed');
            assert(toggleBtn.title === '展开工具栏', 'Toggle button title should update to 展开工具栏');

            // Non-target groups must be hidden and collapsed vertically
            for (const sel of ['#toolbar-visibility-group', '#toolbar-view-group', '.toolbar-anno-divider', '#toolbar-file-divider', '#toolbar-file-group']) {
                const g = document.querySelector(sel);
                assert(g !== null, 'Group must exist: ' + sel);
                const cs = getComputedStyle(g);
                assert(cs.visibility === 'hidden', sel + ' must be visibility:hidden when collapsed');
                assert(g.getBoundingClientRect().height === 0, sel + ' height must be 0 when collapsed');
            }

            // Leftmost sidebar button must collapse in-place into a circular dot of the exact same color as segment bars
            const sbRect = sidebarBtn.getBoundingClientRect();
            const sbCenterX = sbRect.left + sbRect.width / 2;
            assert(Math.abs(sbRect.left - sidebarBtnBefore.left) <= 0.5,
                `Sidebar button left shifted: before=${sidebarBtnBefore.left}, after=${sbRect.left}`);
            assert(Math.abs(sbRect.width - sidebarBtnBefore.width) <= 0.5,
                `Sidebar button width changed: before=${sidebarBtnBefore.width}, after=${sbRect.width}`);
            assert(Math.abs(sbCenterX - sidebarBtnBefore.centerX) <= 0.5,
                `Sidebar button centerX shifted: before=${sidebarBtnBefore.centerX}, after=${sbCenterX}`);
            assert(sbRect.height >= 10 && sbRect.height <= 12,
                `Collapsed hit height for #toggle-sidebar should fill thin strip, got ${sbRect.height}`);
            assert(sbRect.right < targetControls[0].getBoundingClientRect().left,
                '#toggle-sidebar dot must sit to the left of all segment controls');
            assert(getComputedStyle(document.querySelector('#toggle-sidebar > i')).display === 'none',
                'Sidebar icon should be hidden in collapsed mode');

            const dotStyle = getComputedStyle(sidebarBtn, '::after');
            const segStyle = getComputedStyle(targetControls[0], '::after');
            assert(dotStyle.content !== 'none' && dotStyle.content !== '', '::after dot missing on #toggle-sidebar');
            assert(dotStyle.width === '5px' && dotStyle.height === '5px',
                `#toggle-sidebar::after should be a 5x5 round dot, got ${dotStyle.width}x${dotStyle.height}`);
            assert(dotStyle.borderRadius === '9999px',
                `#toggle-sidebar::after should have 9999px border-radius, got ${dotStyle.borderRadius}`);
            assert(dotStyle.backgroundColor === segStyle.backgroundColor,
                `Dot color (${dotStyle.backgroundColor}) must match segment color (${segStyle.backgroundColor})`);

            // Eye-protection mode color parity between dot and segment bars
            document.body.classList.add('eye-protection-mode');
            assert(getComputedStyle(sidebarBtn, '::after').backgroundColor === getComputedStyle(targetControls[0], '::after').backgroundColor,
                'Eye-protection dot color must match segment color');
            document.body.classList.remove('eye-protection-mode');

            // Clicking leftmost dot button while collapsed toggles annotation sidebar collapse & expand
            assert(state.sidebarOpen === true && sidebarEl.offsetWidth === 256,
                'Sidebar should start expanded (256px), got ' + sidebarEl.offsetWidth);
            sidebarBtn.click();
            await new Promise(r => setTimeout(r, 40));
            assert(state.sidebarOpen === false && sidebarEl.classList.contains('w-0') && sidebarEl.offsetWidth <= 1,
                '1st click on collapsed dot button must collapse sidebar, got width=' + sidebarEl.offsetWidth);
            sidebarBtn.click();
            await new Promise(r => setTimeout(r, 40));
            assert(state.sidebarOpen === true && sidebarEl.classList.contains('w-64') && sidebarEl.offsetWidth === 256,
                '2nd click on collapsed dot button must expand sidebar back to 256px, got ' + sidebarEl.offsetWidth);

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
            assert(header.offsetHeight === initialExpandedHeight,
                'Restored header height must match initial ' + initialExpandedHeight + 'px, got ' + header.offsetHeight);

            // (d) Keyboard shortcut: '-_' (Minus key right of 0) toggles toolbar collapse/expand
            document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', code: 'Minus', bubbles: true, cancelable: true }));
            void header.offsetHeight;
            assert(document.body.classList.contains('toolbar-collapsed') && header.offsetHeight === 12,
                'Pressing Minus (-) key must collapse toolbar');

            // Typing '-' inside an input must NOT toggle toolbar
            const searchInput = document.getElementById('search-input');
            searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: '-', code: 'Minus', bubbles: true, cancelable: true }));
            assert(document.body.classList.contains('toolbar-collapsed'),
                'Typing Minus (-) inside an input must not toggle toolbar');

            // Pressing Ctrl + '-' (zoom out) must NOT toggle toolbar
            document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', code: 'Minus', ctrlKey: true, bubbles: true, cancelable: true }));
            assert(document.body.classList.contains('toolbar-collapsed'),
                'Pressing Ctrl + Minus must not toggle toolbar');

            // Pressing Shift + Minus ('_') expands toolbar back
            document.dispatchEvent(new KeyboardEvent('keydown', { key: '_', code: 'Minus', shiftKey: true, bubbles: true, cancelable: true }));
            void header.offsetHeight;
            assert(!document.body.classList.contains('toolbar-collapsed') && header.offsetHeight === initialExpandedHeight,
                'Pressing Shift + Minus (_) key must expand toolbar back');

            // =================================================================
            // 3. AI Chat Toolbar Button Status: streaming blink & error red state
            //    (in both expanded toolbar and collapsed horizontal bar modes)
            // =================================================================
            await new Promise(r => setTimeout(r, 30));
            assert(aiBtn.dataset.chatStatus === 'idle', 'Initial AI button status should be idle');
            assert(!aiBtn.classList.contains('is-streaming') && !aiBtn.classList.contains('is-error'),
                'Initial AI button should not have streaming or error class');

            let activeStreamCtrl = null;
            let shouldFailHttp = false;
            const origFetch = window.fetch.bind(window);
            window.fetch = (input, init) => {
                const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
                if (urlStr.includes('/api/ai-config')) {
                    return Promise.resolve(new Response(JSON.stringify({
                        model: 'deepseek-flash',
                        models: ['deepseek-flash'],
                        thinking: 'disabled',
                        revision: 'test-rev'
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }
                if (urlStr.includes('/api/chat')) {
                    if (shouldFailHttp) {
                        return Promise.resolve(new Response(JSON.stringify({ error: '模拟服务异常' }), {
                            status: 500,
                            headers: { 'Content-Type': 'application/json' }
                        }));
                    }
                    return Promise.resolve(new Response(new ReadableStream({
                        start(controller) {
                            activeStreamCtrl = controller;
                            if (init && init.signal) {
                                init.signal.addEventListener('abort', () => {
                                    try { controller.error(new DOMException('Stopped', 'AbortError')); } catch (e) {}
                                }, { once: true });
                            }
                        }
                    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
                }
                return origFetch(input, init);
            };

            // 3a. Open chat, send message -> button starts blinking in expanded mode
            aiBtn.click();
            assert(getComputedStyle(chatPanel).display === 'flex', 'Chat panel should be open');
            const chatInput = document.getElementById('ds-chat-input');
            const chatSendBtn = document.getElementById('ds-chat-send-btn');
            const chatCloseBtn = document.getElementById('ds-chat-close-btn');
            const chatClearBtn = document.getElementById('ds-chat-clear-btn');

            chatInput.value = '测试回答中闪烁';
            chatSendBtn.click();
            await new Promise(r => setTimeout(r, 40));

            assert(aiBtn.classList.contains('is-streaming'),
                'AI button must have is-streaming while answering; status=' + aiBtn.dataset.chatStatus + ' body=' + document.getElementById('ds-chat-body').textContent);
            assert(!aiBtn.classList.contains('is-error'), 'AI button must not have is-error while answering');
            assert(aiBtn.dataset.chatStatus === 'streaming', 'dataset.chatStatus should be streaming');
            assert(getComputedStyle(aiBtn).animationName === 'dsChatBtnBlink',
                'Expanded AI button should run dsChatBtnBlink animation, got ' + getComputedStyle(aiBtn).animationName);
            assert(getComputedStyle(aiBtn.querySelector('svg')).animationName === 'dsChatIconBlink',
                'Expanded AI button svg should run dsChatIconBlink animation');

            // Close chat window while AI is still answering -> button keeps blinking
            chatCloseBtn.click();
            assert(getComputedStyle(chatPanel).display === 'none', 'Chat panel should be closed');
            assert(aiBtn.classList.contains('is-streaming'), 'AI button must keep blinking after closing chat panel');
            assert(getComputedStyle(aiBtn).animationName === 'dsChatBtnBlink',
                'Closed panel AI button must continue dsChatBtnBlink animation');

            // Collapse toolbar while AI is still answering -> collapsed bar blinks
            toggleBtn.click();
            void header.offsetHeight;
            assert(document.body.classList.contains('toolbar-collapsed'), 'Toolbar should be collapsed');
            assert(getComputedStyle(aiBtn, '::after').animationName === 'dsChatBarBlink',
                'Collapsed AI horizontal bar ::after should run dsChatBarBlink animation, got ' + getComputedStyle(aiBtn, '::after').animationName);
            assert(getComputedStyle(aiBtn).backgroundColor === 'rgba(0, 0, 0, 0)',
                'Collapsed AI button container background must stay transparent');

            // Finish stream -> blinking stops immediately in collapsed mode & expanded mode
            const enc = new TextEncoder();
            activeStreamCtrl.enqueue(enc.encode('data: {"delta":"回答完毕"}\n\ndata: {"done":true}\n\n'));
            activeStreamCtrl.close();
            await new Promise(r => setTimeout(r, 50));

            assert(!aiBtn.classList.contains('is-streaming'), 'AI button must stop blinking when answer completes');
            assert(!aiBtn.classList.contains('is-error'), 'AI button must not be in error state on normal completion');
            assert(aiBtn.dataset.chatStatus === 'idle', 'dataset.chatStatus should return to idle');
            assert(getComputedStyle(aiBtn, '::after').animationName === 'none',
                'Collapsed AI bar animation should stop after completion');

            // Expand toolbar back
            toggleBtn.click();
            void header.offsetHeight;
            assert(getComputedStyle(aiBtn).animationName === 'none',
                'Expanded AI button animation should be none after completion');

            // 3b. Send a message that returns an error -> button turns red in both expanded and collapsed modes
            shouldFailHttp = true;
            aiBtn.click();
            chatInput.value = '测试报错变红';
            chatSendBtn.click();
            await new Promise(r => setTimeout(r, 50));

            assert(!aiBtn.classList.contains('is-streaming'), 'AI button must not be streaming after error');
            assert(aiBtn.classList.contains('is-error'), 'AI button must have is-error class on error');
            assert(aiBtn.dataset.chatStatus === 'error', 'dataset.chatStatus should be error');
            assert(getComputedStyle(aiBtn).color === 'rgb(220, 38, 38)',
                'Expanded AI button icon color should be red rgb(220, 38, 38), got ' + getComputedStyle(aiBtn).color);
            assert(getComputedStyle(aiBtn).backgroundColor === 'rgb(254, 242, 242)',
                'Expanded AI button background should be soft red rgb(254, 242, 242), got ' + getComputedStyle(aiBtn).backgroundColor);

            // Collapse toolbar while in error state -> horizontal bar is red
            toggleBtn.click();
            void header.offsetHeight;
            assert(getComputedStyle(aiBtn, '::after').backgroundColor === 'rgb(220, 38, 38)',
                'Collapsed AI horizontal bar ::after should be red rgb(220, 38, 38), got ' + getComputedStyle(aiBtn, '::after').backgroundColor);
            assert(getComputedStyle(aiBtn, '::after').animationName === 'none',
                'Collapsed AI horizontal bar ::after should not blink in error state');
            assert(getComputedStyle(aiBtn).backgroundColor === 'rgba(0, 0, 0, 0)',
                'Collapsed AI button container background must remain transparent in error state');

            // Eye-protection mode in collapsed error state -> horizontal bar remains red
            document.body.classList.add('eye-protection-mode');
            assert(getComputedStyle(aiBtn, '::after').backgroundColor === 'rgb(220, 38, 38)',
                'Eye-protection collapsed AI bar ::after should be red rgb(220, 38, 38)');
            document.body.classList.remove('eye-protection-mode');

            // Expand toolbar and click Retry button -> transitions from error (red) to streaming (blinking) -> idle
            toggleBtn.click();
            void header.offsetHeight;
            shouldFailHttp = false;
            const retryBtn = document.querySelector('#ds-chat-body .ds-chat-retry');
            assert(retryBtn !== null, 'Retry button should exist after error');
            retryBtn.click();
            await new Promise(r => setTimeout(r, 30));
            assert(aiBtn.classList.contains('is-streaming') && !aiBtn.classList.contains('is-error'),
                'Retrying should transition AI button from error to streaming');
            activeStreamCtrl.enqueue(enc.encode('data: {"delta":"重试成功"}\n\ndata: {"done":true}\n\n'));
            activeStreamCtrl.close();
            await new Promise(r => setTimeout(r, 40));
            assert(!aiBtn.classList.contains('is-streaming') && !aiBtn.classList.contains('is-error') && aiBtn.dataset.chatStatus === 'idle',
                'Successful retry should return AI button to idle');

            // 3c. Manual stop button -> stops blinking and returns to idle (not error)
            chatInput.value = '测试手动停止';
            chatSendBtn.click();
            await new Promise(r => setTimeout(r, 30));
            assert(aiBtn.classList.contains('is-streaming'), 'AI button should be streaming before stop');
            document.getElementById('ds-chat-stop-btn').click();
            await new Promise(r => setTimeout(r, 40));
            assert(!aiBtn.classList.contains('is-streaming') && !aiBtn.classList.contains('is-error') && aiBtn.dataset.chatStatus === 'idle',
                'Manual stop should return AI button to idle without error');

            chatClearBtn.click();
            assert(!aiBtn.classList.contains('is-error') && aiBtn.dataset.chatStatus === 'idle',
                'Clearing chat should keep AI button in idle');

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
