import unittest
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class TestMindMapFeature(unittest.TestCase):
    def test_html_buttons_split(self):
        html_path = os.path.join(ROOT, 'static', 'index.html')
        with open(html_path, 'r', encoding='utf-8') as f:
            content = f.read()

        # Both buttons must exist
        self.assertIn('id="mindmap-btn"', content)
        self.assertIn('id="sidecar-btn"', content)

        # Left button must have viewBox="0 0 12 24"
        self.assertIn('viewBox="0 0 12 24"', content)
        # Right button must have viewBox="12 0 12 24"
        self.assertIn('viewBox="12 0 12 24"', content)

        # Width of each button is 16px, total width 32px
        self.assertIn('w-[16px] h-[32px]', content)
        self.assertIn('width: 32px; height: 32px;', content)

    def test_html_mindmap_panel(self):
        html_path = os.path.join(ROOT, 'static', 'index.html')
        with open(html_path, 'r', encoding='utf-8') as f:
            content = f.read()

        self.assertIn('id="mindmap-panel"', content)
        self.assertIn('id="mindmap-viewport"', content)
        self.assertIn('id="mindmap-canvas"', content)
        self.assertIn('id="mindmap-tree-root"', content)
        self.assertIn('id="mindmap-resizer"', content)
        self.assertIn('src="./js/mindmap.js"', content)

        # Lightbulb hint must be removed
        self.assertNotIn('ph-lightbulb', content)

    def test_foundation_els(self):
        foundation_path = os.path.join(ROOT, 'static', 'js', 'foundation.js')
        with open(foundation_path, 'r', encoding='utf-8') as f:
            content = f.read()

        self.assertIn('mindmapBtn: document.getElementById(\'mindmap-btn\')', content)
        self.assertIn('mindmapPanel: document.getElementById(\'mindmap-panel\')', content)
        self.assertIn('sidecarBtn: document.getElementById(\'sidecar-btn\')', content)

    def test_document_undo_redo_and_restore(self):
        doc_path = os.path.join(ROOT, 'static', 'js', 'document.js')
        with open(doc_path, 'r', encoding='utf-8') as f:
            content = f.read()

        self.assertIn("k !== 'mindmap'", content)
        self.assertIn("window.MindMap?.render?.()", content)
        self.assertIn("window.MindMap?.onAnnotationsLoaded?.()", content)

    def test_note_sidebar_filter(self):
        sidebar_path = os.path.join(ROOT, 'static', 'js', 'note-sidebar.js')
        with open(sidebar_path, 'r', encoding='utf-8') as f:
            content = f.read()

        self.assertIn("k !== 'mindmap'", content)

    def test_boot_import(self):
        boot_path = os.path.join(ROOT, 'static', 'js', 'boot.js')
        with open(boot_path, 'r', encoding='utf-8') as f:
            content = f.read()

        self.assertIn("incoming.mindmap", content)
        self.assertIn("window.MindMap?.render?.()", content)

    def test_mindmap_js_content(self):
        mm_path = os.path.join(ROOT, 'static', 'js', 'mindmap.js')
        with open(mm_path, 'r', encoding='utf-8') as f:
            content = f.read()

        # Key functions
        self.assertIn("function getMindMapData", content)
        self.assertIn("function addChildNode", content)
        self.assertIn("function addSiblingNode", content)
        self.assertIn("function deleteNode", content)
        self.assertIn("function reparentNode", content)
        self.assertIn("function locatePdfPage", content)
        self.assertIn("function startEditingNode", content)
        self.assertIn("renderMathInElement", content)
        self.assertIn("function applyZoom", content)
        self.assertIn("function centerView", content)
        self.assertIn("toggleMindmap", content)
        self.assertIn("window.MindMap", content)
        # Multi-chain, branching, and merging functions
        self.assertIn("function addMainChain", content)
        self.assertIn("function forkNodeBranch", content)
        self.assertIn("function convergeBranches", content)
        self.assertIn("function toggleMergeLink", content)
        self.assertIn("function fuseNodeInto", content)
        # Event stop propagation for wheel
        self.assertIn("e.stopPropagation()", content)
        # Default page must be null (optional page binding)
        self.assertIn("page: null", content)
        self.assertIn("function countCollapsedDescendants", content)
        self.assertIn("countCollapsedDescendants(node, isSpine)", content)

    def test_style_css(self):
        css_path = os.path.join(ROOT, 'static', 'css', 'style.css')
        with open(css_path, 'r', encoding='utf-8') as f:
            content = f.read()

        self.assertIn("#mindmap-panel", content)
        self.assertIn(".mm-tree-branch", content)
        self.assertIn(".mm-children-row", content)
        self.assertIn(".mm-stem-down", content)
        self.assertIn(".mm-card", content)
        self.assertIn(".mm-page-badge", content)
        self.assertIn(".page-locate-highlight", content)
        self.assertIn("body.eye-protection-mode #mindmap-panel", content)
        self.assertIn(".mm-fork-branches-row", content)
        self.assertIn(".mm-connector-merge", content)
        self.assertIn(".mm-merge-badge", content)

    def test_multi_chain_branch_and_merge_runtime(self):
        import subprocess
        import tempfile
        from pathlib import Path

        edge_path = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            edge_path = Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            self.skipTest("Edge browser not found for headless testing")

        root_path = Path(ROOT)
        index_html = (root_path / "static/index.html").read_text(encoding="utf-8")
        base_tag = f'<base href="{(root_path / "static").as_uri()}/">'
        test_script = """
<script>
window.addEventListener('load', () => {
    try {
        function assert(cond, msg) {
            if (!cond) throw new Error(msg);
        }

        window.MindMap.toggle(true);
        const data = state.annotations['mindmap'];
        assert(Array.isArray(data.nodes) && data.nodes.length === 1, 'Default should have 1 main chain');

        // Add second main chain
        window.MindMap.addMainChain('主链 II：算子谱理论脉络');
        assert(data.nodes.length === 2, 'Should have 2 main chains after addMainChain');
        assert(document.querySelectorAll('.mm-root-branch').length === 2, 'Should render 2 root branches');

        // Fork a node into parallel branches
        const stepId = data.nodes[1].children[0].id;
        window.MindMap.forkBranch(stepId);
        assert(Array.isArray(data.nodes[1].children[0].branches) && data.nodes[1].children[0].branches.length === 2, 'Should fork into 2 parallel tracks');

        // Converge branches into downstream node
        window.MindMap.convergeBranches(stepId);
        assert(data.nodes[1].children.length >= 2, 'Should create downstream convergence node');

        // Cross-chain merge link
        const targetId = data.nodes[0].children[1].id;
        window.MindMap.toggleMergeLink(stepId, targetId);
        assert(data.nodes[1].children[0].mergeTo.includes(targetId), 'mergeTo should link across chains');
        window.MindMap.render();
        assert(document.querySelectorAll('.mm-connector-merge').length >= 1, 'Should render merge SVG connector');

        document.title = 'MINDMAP_RUNTIME_OK';
    } catch (e) {
        document.title = 'MINDMAP_RUNTIME_ERR: ' + (e && e.message ? e.message : e);
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
            res = subprocess.run(cmd, capture_output=True, timeout=20)
            stdout = res.stdout.decode("utf-8", errors="replace")
            self.assertIn("MINDMAP_RUNTIME_OK", stdout)
        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    def test_mindmap_text_input_quantum_snippets(self):
        import subprocess
        import tempfile
        from pathlib import Path

        edge_path = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            edge_path = Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            self.skipTest("Edge browser not found for headless testing")

        root_path = Path(ROOT)
        index_html = (root_path / "static/index.html").read_text(encoding="utf-8")
        base_tag = f'<base href="{(root_path / "static").as_uri()}/">'
        test_script = r"""
<script>
window.addEventListener('load', () => {
    try {
        function assert(cond, msg) {
            if (!cond) throw new Error(msg);
        }

        // 1. Ensure QuantumSnippetEngine is globally shared
        assert(typeof window.QuantumSnippetEngine === 'function', 'QuantumSnippetEngine must be exported on window');

        // 2. Open MindMap
        window.MindMap.toggle(true);
        const data = state.annotations['mindmap'];
        const firstNodeId = data.nodes[0].children[0].id;

        // 3. Double-click or trigger inline editing on first node
        const firstCard = document.querySelector(`.mm-tree-branch[data-id="${firstNodeId}"] > .mm-card-wrapper > .mm-card`);
        assert(firstCard !== null, 'First node card must exist');
        firstCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

        const editor = firstCard.querySelector('.mm-inline-editor');
        assert(editor !== null, 'Inline editor textarea must be rendered');

        // 4. Test LaTeX snippet expansion in mindmap editor (e.g., "mk" -> "$ $")
        editor.value = "mk";
        editor.selectionStart = 2;
        editor.selectionEnd = 2;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'k' }));

        assert(editor.value === "$$", 'Snippet "mk" should expand to "$$" in mindmap editor');
        assert(editor.selectionStart === 1, 'Cursor should be positioned between $$');

        // 5. Test tab-stop jumping with a multi-placeholder snippet (e.g., "fr" -> \dfrac{$0}{$1})
        editor.value = "$fr";
        editor.selectionStart = 3;
        editor.selectionEnd = 3;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'r' }));

        assert(editor.value.includes('\\dfrac{'), 'Snippet "fr" should expand to \\dfrac{$0}{$1}');

        // Type numerator, then press Tab to leap to denominator
        document.execCommand('insertText', false, '1');
        const posBeforeTab = editor.selectionStart;
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        const posAfterTab = editor.selectionStart;
        assert(posAfterTab > posBeforeTab, 'Tab should jump to next tabstop, not add child node');

        // 6. Test Ctrl+Enter commit/save
        editor.value = "测试公式 $\\\\alpha + \\\\beta$";
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));

        assert(!firstCard.classList.contains('is-editing'), 'Ctrl+Enter should commit and exit editing mode');
        const updatedNode = window.MindMap.getMindMapData ? window.MindMap.getMindMapData() : state.annotations['mindmap'];
        assert(data.nodes[0].children[0].text === "测试公式 $\\\\alpha + \\\\beta$", 'Committed text should match editor value');

        document.title = 'MINDMAP_SNIPPETS_OK';
    } catch (e) {
        document.title = 'MINDMAP_SNIPPETS_ERR: ' + (e && e.stack ? e.stack : e);
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
            res = subprocess.run(cmd, capture_output=True, timeout=20)
            stdout = res.stdout.decode("utf-8", errors="replace")
            self.assertIn("MINDMAP_SNIPPETS_OK", stdout)
        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    def test_mindmap_spine_collapse_count_only_hides_lateral_children(self):
        import subprocess
        import tempfile
        from pathlib import Path

        edge_path = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            edge_path = Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            self.skipTest("Edge browser not found for headless testing")

        root_path = Path(ROOT)
        index_html = (root_path / "static/index.html").read_text(encoding="utf-8")
        base_tag = f'<base href="{(root_path / "static").as_uri()}/">'
        test_script = r"""
<script>
window.addEventListener('load', () => {
    try {
        function assert(cond, msg) {
            if (!cond) throw new Error(msg);
        }

        window.MindMap.toggle(true);
        const data = state.annotations['mindmap'];
        
        // Construct a spine node with 3 right-side descendants and downstream fork branches
        const spineNode = {
            id: 'spine-stage-1',
            text: '§1 主干推演阶段',
            collapsed: false,
            // Right-side lateral children: Child 1 (with 1 subchild) + Child 2 = 3 descendants
            children: [
                {
                    id: 'lat-child-1',
                    text: '侧向论证 1',
                    children: [
                        { id: 'lat-child-1-1', text: '论证细节 1.1', children: [] }
                    ]
                },
                {
                    id: 'lat-child-2',
                    text: '侧向论证 2',
                    children: []
                }
            ],
            // Downward parallel branches: Track A (2 nodes, 1 child) + Track B (1 node, 2 children) = 6 nodes
            branches: [
                [
                    { 
                        id: 'fork-a-1', 
                        text: '并行支线 A1', 
                        children: [{ id: 'fork-a-1-c', text: '支线A细节', children: [] }] 
                    },
                    { id: 'fork-a-2', text: '并行支线 A2', children: [] }
                ],
                [
                    { 
                        id: 'fork-b-1', 
                        text: '并行支线 B1', 
                        children: [
                            { id: 'fork-b-1-c1', text: '支线B细节1', children: [] },
                            { id: 'fork-b-1-c2', text: '支线B细节2', children: [] }
                        ] 
                    }
                ]
            ]
        };

        data.root.children = [spineNode];
        window.MindMap.render();

        // 1. Verify countCollapsedDescendants function directly
        assert(typeof window.MindMap.countCollapsedDescendants === 'function', 'countCollapsedDescendants must be exposed');
        const calculatedSpineCount = window.MindMap.countCollapsedDescendants(spineNode, true);
        assert(calculatedSpineCount === 3, 'Spine node collapse count must be exactly 3 (right-side children only), got: ' + calculatedSpineCount);

        const calculatedLateralCount = window.MindMap.countCollapsedDescendants(spineNode.children[0], false);
        assert(calculatedLateralCount === 1, 'Lateral child 1 collapse count must be 1, got: ' + calculatedLateralCount);

        // 2. Collapse the spine node and render
        spineNode.collapsed = true;
        window.MindMap.render();

        // 3. Inspect DOM for spine node toggle badge
        const spineBranchEl = document.querySelector('.mm-tree-branch[data-id="spine-stage-1"]');
        assert(spineBranchEl !== null, 'Spine branch element must exist');
        const toggleBtn = spineBranchEl.querySelector('.mm-branch-toggle.is-collapsed');
        assert(toggleBtn !== null, 'Toggle button must have is-collapsed class');
        
        const countSpan = toggleBtn.querySelector('span');
        assert(countSpan !== null, 'Toggle badge count span must exist');
        assert(countSpan.textContent.trim() === '3', 'Toggle badge must display exactly 3, got: ' + countSpan.textContent.trim());
        assert(toggleBtn.title.includes('3'), 'Toggle button tooltip must mention 3 nodes');

        // 4. Verify right-side children are hidden, but downward fork branches are still rendered
        const childrenRow = spineBranchEl.querySelector(':scope > .mm-children-row');
        assert(childrenRow === null, 'Children row must be hidden when collapsed');
        const forkRow = spineBranchEl.querySelector(':scope > .mm-fork-branches-row');
        assert(forkRow !== null, 'Downward fork branches row must remain rendered and visible');

        // 5. Expand spine node again and verify children return
        toggleBtn.click();
        assert(spineNode.collapsed === false, 'Clicking toggleBtn should un-collapse node');
        const refreshedSpineBranchEl = document.querySelector('.mm-tree-branch[data-id="spine-stage-1"]');
        assert(refreshedSpineBranchEl !== null, 'Refreshed spine branch must exist');
        const childrenRowAfter = refreshedSpineBranchEl.querySelector(':scope > .mm-children-row');
        assert(childrenRowAfter !== null, 'Children row must reappear after expanding');

        document.title = 'MINDMAP_COLLAPSE_COUNT_OK';
    } catch (e) {
        document.title = 'MINDMAP_COLLAPSE_COUNT_ERR: ' + (e && e.stack ? e.stack : e);
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
            res = subprocess.run(cmd, capture_output=True, timeout=20)
            stdout = res.stdout.decode("utf-8", errors="replace")
            title = re.search(r"<title>(.*?)</title>", stdout, re.S)
            self.assertIsNotNone(title, "Browser did not return a document title")
            self.assertEqual(title.group(1), "MINDMAP_COLLAPSE_COUNT_OK")
        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    def test_mindmap_ux_and_routing_optimizations(self):
        import subprocess
        import tempfile
        from pathlib import Path

        edge_path = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            edge_path = Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            self.skipTest("Edge browser not found for headless testing")

        root_path = Path(ROOT)
        index_html = (root_path / "static/index.html").read_text(encoding="utf-8")
        base_tag = f'<base href="{(root_path / "static").as_uri()}/">'
        test_script = r"""
<script>
window.addEventListener('load', () => {
    setTimeout(() => {
        try {
            function assert(cond, msg) {
                if (!cond) throw new Error(msg);
            }

            window.MindMap.toggle(true);
            const panel = document.getElementById('mindmap-panel');
            panel.style.width = '820px';

            // 1. Verify single-child lateral branch vertical alignment (no S-bend jog)
            state.annotations.mindmap = {
                zoom: 1,
                root: null,
                nodes: [{
                    id: 'r1',
                    text: '主链 I：泛函分析核心定理',
                    children: [{
                        id: 's1',
                        text: '§1 紧算子谱分解',
                        tag: 'theorem',
                        page: 12,
                        children: [{
                            id: 'l1',
                            text: '抽取有限维逼近子空间',
                            children: []
                        }]
                    }]
                }]
            };
            state.annotations.mindmap.root = state.annotations.mindmap.nodes[0];
            window.MindMap.render();

            const s1Card = document.querySelector('.mm-card[data-id="s1"]');
            const l1Card = document.querySelector('.mm-card[data-id="l1"]');
            const s1Rect = s1Card.getBoundingClientRect();
            const l1Rect = l1Card.getBoundingClientRect();
            const s1Cy = s1Rect.top + s1Rect.height / 2;
            const l1Cy = l1Rect.top + l1Rect.height / 2;
            assert(Math.abs(s1Cy - l1Cy) <= 1.5, `Single lateral child should be vertically centered with spine parent: s1Cy=${s1Cy}, l1Cy=${l1Cy}`);

            const s1ToL1Path = document.querySelector('.mm-connector-path[data-parent-id="s1"][data-child-id="l1"]');
            assert(s1ToL1Path !== null, 'Connector from s1 to l1 must exist');
            const dAttr = s1ToL1Path.getAttribute('d');
            assert(!dAttr.includes('Q'), `Straight aligned single-child connector should not contain quadratic bends, got: ${dAttr}`);

            // Verify right-edge quick-add button is hidden when .has-toggle is present
            const s1Wrapper = s1Card.closest('.mm-card-wrapper');
            assert(s1Wrapper.classList.contains('has-toggle'), 's1 wrapper should have .has-toggle');
            const s1QuickRight = s1Wrapper.querySelector('.mm-quick-add-sibling');
            assert(getComputedStyle(s1QuickRight).display === 'none', 'Right quick-add button must be hidden when toggle button exists');

            // 2. Verify complex convergence layout geometry, arrows, and lane de-collision
            const root = {
                id: 'root',
                text: '中心极限定理与自由汇合验证',
                page: 1,
                tag: 'theorem',
                collapsed: false,
                branches: [],
                convergeChildren: [],
                convergeTo: [],
                mergeTo: [],
                children: [{
                    id: 'stage-1',
                    text: '特征函数展开与控制收敛',
                    page: 4,
                    tag: 'lemma',
                    collapsed: false,
                    branches: [],
                    convergeChildren: [],
                    convergeTo: [],
                    mergeTo: [],
                    children: [
                        {
                            id: 'a',
                            text: '二阶矩有限给出局部泰勒展开',
                            page: 5,
                            tag: 'Axiom',
                            collapsed: false,
                            branches: [],
                            convergeChildren: [],
                            convergeTo: [],
                            mergeTo: [],
                            children: [{
                                id: 'ab',
                                text: '由 A 与 B 共同推出对数特征函数主部',
                                page: 7,
                                tag: 'lemma',
                                collapsed: false,
                                branches: [],
                                convergeChildren: [],
                                convergeTo: [],
                                mergeTo: [],
                                children: [{
                                    id: 'result',
                                    text: '高阶余项一致收敛到高斯核',
                                    page: 9,
                                    tag: 'corollary',
                                    collapsed: false,
                                    branches: [],
                                    convergeChildren: [],
                                    convergeTo: [],
                                    mergeTo: [],
                                    children: []
                                }]
                            }]
                        },
                        {
                            id: 'b',
                            text: '独立同分布控制尾概率一致小',
                            page: 6,
                            tag: 'Def',
                            collapsed: false,
                            branches: [],
                            convergeChildren: [],
                            convergeTo: ['ab'],
                            mergeTo: [],
                            children: []
                        },
                        {
                            id: 'c',
                            text: 'Lindeberg 条件消去极端项影响',
                            page: 8,
                            tag: 'proof',
                            collapsed: false,
                            branches: [],
                            convergeChildren: [],
                            convergeTo: [],
                            mergeTo: [],
                            children: [{
                                id: 'c-result',
                                text: '截断序列满足渐近正态条件',
                                page: 8,
                                tag: 'lemma',
                                collapsed: false,
                                branches: [],
                                convergeChildren: [],
                                convergeTo: ['result'],
                                mergeTo: [],
                                children: []
                            }]
                        }
                    ]
                }]
            };
            state.annotations.mindmap = { zoom: 1, root, nodes: [root] };
            window.MindMap.render();
            window.MindMap.center(false, true);

            const canvasRect = document.getElementById('mindmap-canvas').getBoundingClientRect();
            const zoom = state.annotations.mindmap.zoom || 1;
            const cards = [...document.querySelectorAll('#mindmap-tree-root .mm-card')].map(el => {
                const r = el.getBoundingClientRect();
                return {
                    id: el.dataset.id,
                    left: (r.left - canvasRect.left) / zoom,
                    right: (r.right - canvasRect.left) / zoom,
                    top: (r.top - canvasRect.top) / zoom,
                    bottom: (r.bottom - canvasRect.top) / zoom,
                    cx: (r.left + r.width / 2 - canvasRect.left) / zoom,
                    cy: (r.top + r.height / 2 - canvasRect.top) / zoom
                };
            });
            const byId = Object.fromEntries(cards.map(c => [c.id, c]));
            assert(Math.abs(byId['ab'].cy - (byId['a'].cy + byId['b'].cy) / 2) < 1, 'ab must be centered between a and b');
            assert(Math.abs(byId['result'].cy - (byId['ab'].cy + byId['c-result'].cy) / 2) < 1, 'result must be centered between ab and c-result');

            // Verify arrows point toward target and stop outside card
            const flowPaths = [...document.querySelectorAll('#mindmap-svg-canvas .mm-connector-path, #mindmap-svg-canvas .mm-connector-spine, #mindmap-svg-canvas .mm-connector-converge')];
            flowPaths.forEach(p => {
                const len = p.getTotalLength();
                const end = p.getPointAtLength(len);
                const prev = p.getPointAtLength(Math.max(0, len - 6));
                const target = byId[p.dataset.childId];
                const toCard = { x: target.cx - end.x, y: target.cy - end.y };
                const tangent = { x: end.x - prev.x, y: end.y - prev.y };
                const dot = tangent.x * toCard.x + tangent.y * toCard.y;
                assert(dot > 0, `Arrow for ${p.dataset.parentId}->${p.dataset.childId} must point to target, dot=${dot}`);
            });

            // 3. Verify sibling reordering (moveNodeStep)
            assert(typeof window.MindMap.moveNodeStep === 'function', 'moveNodeStep must be exported');
            window.MindMap.moveNodeStep('a', 1);
            const stage1ChildrenAfterDown = state.annotations.mindmap.nodes[0].children[0].children.map(n => n.id);
            assert(stage1ChildrenAfterDown[0] === 'b' && stage1ChildrenAfterDown[1] === 'a', 'moveNodeStep(a, 1) should swap a and b');
            window.MindMap.moveNodeStep('a', -1);
            const stage1ChildrenRestored = state.annotations.mindmap.nodes[0].children[0].children.map(n => n.id);
            assert(stage1ChildrenRestored[0] === 'a' && stage1ChildrenRestored[1] === 'b', 'moveNodeStep(a, -1) should restore a before b');

            // 4. Verify card action bar buttons: up/down + reparent on the right, non-duplicate icon, and main-node fork
            const centerBtnIcon = document.querySelector('#mindmap-center-btn i');
            const bCardEl = document.querySelector('.mm-card[data-id="b"]');
            const bActionBtns = [...bCardEl.querySelectorAll('.mm-card-actions .mm-act-btn')];
            const bBtnClasses = bActionBtns.map(btn => btn.className);
            assert(bBtnClasses[0].includes('mm-act-move-up'), 'First action button on non-root node must be move-up');
            assert(bBtnClasses[1].includes('mm-act-move-down'), 'Second action button on non-root node must be move-down');
            assert(bBtnClasses[2].includes('mm-act-reparent'), 'Reparent button must be immediately to the right of up/down buttons');
            const reparentIcon = bCardEl.querySelector('.mm-act-reparent i');
            assert(reparentIcon.classList.contains('ph-arrow-bend-up-left'), 'Reparent button must use ph-arrow-bend-up-left icon');
            assert(!reparentIcon.classList.contains('ph-crosshair') && reparentIcon.className !== centerBtnIcon.className, 'Reparent button icon must not duplicate center view icon');

            // Verify redundant top-bar buttons are removed
            assert(document.getElementById('mindmap-fork-btn') === null, 'Redundant top-bar fork button should be removed');
            assert(document.getElementById('mindmap-merge-btn') === null, 'Redundant top-bar merge button should be removed');
            assert(document.getElementById('mindmap-bind-current-btn') === null, 'Redundant top-bar bind-current button should be removed');

            // 5. Verify interactive canvas reparenting via card action button (.mm-act-reparent)
            const cReparentBtn = document.querySelector('.mm-card[data-id="c"] .mm-act-reparent');
            assert(cReparentBtn !== null, 'Card c must have .mm-act-reparent button');
            cReparentBtn.click();
            const reparentBanner = document.getElementById('mm-reparent-banner');
            assert(reparentBanner !== null, 'Clicking .mm-act-reparent must start interactive reparent mode');
            assert(reparentBanner.querySelector('#mm-reparent-promote-btn') === null, 'Promote button must not exist in reparent banner');
            assert(reparentBanner.querySelector('#mm-reparent-demote-btn') === null, 'Demote button must not exist in reparent banner');
            const bCard = document.querySelector('.mm-card[data-id="b"]');
            bCard.click();
            assert(document.getElementById('mm-reparent-banner') === null, 'Clicking target card should finish interactive reparent mode');
            const bChildrenAfterClickReparent = state.annotations.mindmap.nodes[0].children[0].children[1].children.map(n => n.id);
            assert(bChildrenAfterClickReparent.includes('c'), 'Clicking card b in reparent mode should mount c under b');

            // 6. Verify context menu structure: no inline 9 math role buttons, main-node has fork-branch, lateral node does not
            const moreBtn = document.querySelector('.mm-card[data-id="b"] .mm-act-more');
            moreBtn.click();
            let ctxMenu = document.getElementById('mm-context-menu');
            assert(ctxMenu !== null, 'Context menu must open');
            assert(ctxMenu.querySelector('.mm-ctx-icon-bar') === null, 'Context menu must not duplicate card action bar icons');
            assert(ctxMenu.querySelector('.mm-ctx-tag-grid') === null, 'Context menu must not expose 9 inline math role buttons');
            assert(ctxMenu.querySelectorAll('[data-action="fork-branch"]').length === 0, 'Lateral node context menu must not have fork-branch');
            assert(ctxMenu.querySelectorAll('[data-action="pick-tag"]').length === 1, 'pick-tag item must exist');
            assert(ctxMenu.querySelectorAll('[data-action="reparent"]').length === 1, 'reparent item must exist');
            assert(ctxMenu.querySelectorAll('[data-action="delete"]').length === 1, 'delete item must exist');

            // Main-chain node (stage-1) must have both .mm-act-fork and context menu [data-action="fork-branch"]
            const stage1Card = document.querySelector('.mm-card[data-id="stage-1"]');
            assert(stage1Card.querySelector('.mm-act-fork') !== null, 'Main spine node must have .mm-act-fork button in card action bar');
            stage1Card.querySelector('.mm-act-more').click();
            ctxMenu = document.getElementById('mm-context-menu');
            assert(ctxMenu.querySelectorAll('[data-action="fork-branch"]').length === 1, 'Main spine node context menu must include fork-branch');

            // 7. Verify M-key dashed mergeTo arrows avoid overlapping solid lines
            window.MindMap.toggleMergeLink('a', 'ab');
            window.MindMap.toggleMergeLink('stage-1', 'a');
            window.MindMap.toggleMergeLink('root', 'stage-1');
            window.MindMap.render();

            const solidPaths = [...document.querySelectorAll('#mindmap-svg-canvas .mm-connector-path, #mindmap-svg-canvas .mm-connector-spine, #mindmap-svg-canvas .mm-connector-converge')];
            const mergePaths = [...document.querySelectorAll('#mindmap-svg-canvas .mm-connector-merge')];
            assert(mergePaths.length === 3, `Expected 3 dashed merge paths, got ${mergePaths.length}`);

            mergePaths.forEach(mp => {
                const mLen = mp.getTotalLength();
                const mMid = mp.getPointAtLength(mLen * 0.5);
                const mStart = mp.getPointAtLength(0);
                const mEnd = mp.getPointAtLength(mLen);
                const samePairSolids = solidPaths.filter(sp =>
                    (sp.dataset.parentId === mp.dataset.parentId && sp.dataset.childId === mp.dataset.childId) ||
                    (sp.dataset.parentId === mp.dataset.childId && sp.dataset.childId === mp.dataset.parentId)
                );
                samePairSolids.forEach(sp => {
                    const sLen = sp.getTotalLength();
                    const sMid = sp.getPointAtLength(sLen * 0.5);
                    const sStart = sp.getPointAtLength(0);
                    const sEnd = sp.getPointAtLength(sLen);
                    const midDist = Math.hypot(mMid.x - sMid.x, mMid.y - sMid.y);
                    const startDist = Math.hypot(mStart.x - sStart.x, mStart.y - sStart.y);
                    const endDist = Math.hypot(mEnd.x - sEnd.x, mEnd.y - sEnd.y);
                    assert(midDist > 14, `Dashed merge path ${mp.dataset.parentId}->${mp.dataset.childId} midpoint must not overlap solid line (midDist=${midDist})`);
                    assert(startDist > 8 || endDist > 8, `Dashed merge path ${mp.dataset.parentId}->${mp.dataset.childId} ports must not coincide with solid line ports`);
                });
            });

            document.title = 'MINDMAP_UX_AND_ROUTING_OK';
        } catch (e) {
            document.title = 'MINDMAP_UX_AND_ROUTING_ERR: ' + (e && e.stack ? e.stack : e);
        }
    }, 120);
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
                temp_path
            ]
            res = subprocess.run(cmd, capture_output=True, timeout=25)
            stdout = res.stdout.decode("utf-8", errors="replace")
            title = re.search(r"<title>(.*?)</title>", stdout, re.S)
            self.assertIsNotNone(title, "Browser did not return a document title")
            self.assertEqual(title.group(1), "MINDMAP_UX_AND_ROUTING_OK")
        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    def test_multi_page_mindmap_and_pdf_page_binding(self):
        import subprocess
        import tempfile
        from pathlib import Path
        root_path = Path(ROOT)
        html_content = (root_path / 'static/index.html').read_text(encoding='utf-8')
        self.assertIn('id="mindmap-pages-bar"', html_content)
        self.assertIn('id="mindmap-pages-list"', html_content)
        self.assertIn('id="mindmap-add-page-btn"', html_content)
        self.assertIn('id="mindmap-bind-page-btn"', html_content)

        css_content = (root_path / 'static/css/style.css').read_text(encoding='utf-8')
        self.assertIn('#mindmap-pages-bar', css_content)
        self.assertIn('.mm-page-tab', css_content)
        self.assertIn('.mm-tab-page-badge', css_content)

        edge_path = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            edge_path = Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")
        if not edge_path.exists():
            self.skipTest("Edge browser not found for headless testing")

        index_html = (root_path / "static/index.html").read_text(encoding="utf-8")
        base_tag = f'<base href="{(root_path / "static").as_uri()}/">'
        test_script = r"""
<script>
window.addEventListener('load', () => {
    setTimeout(() => {
        try {
            function assert(cond, msg) {
                if (!cond) throw new Error(msg);
            }

            state.currentPhysicalPage = 5;
            state.pageDimensions = Array.from({ length: 20 }, () => ({ width: 600, height: 800 }));
            let locatedPage = null;
            window.scrollPdfPageIntoView = (targetPage) => {
                locatedPage = targetPage;
            };

            window.MindMap.toggle(true);

            // Verify #mindmap-pages-bar is merged into the middle of #mindmap-toolbar (only one top bar)
            const toolbar = document.getElementById('mindmap-toolbar');
            const pagesBar = document.getElementById('mindmap-pages-bar');
            const brand = toolbar.querySelector('.mm-toolbar-brand');
            const actions = toolbar.querySelector('.mm-toolbar-actions');
            assert(pagesBar.parentElement === toolbar, '#mindmap-pages-bar must be inside #mindmap-toolbar');
            const brandRect = brand.getBoundingClientRect();
            const pagesRect = pagesBar.getBoundingClientRect();
            const actionsRect = actions.getBoundingClientRect();
            assert(brandRect.right <= pagesRect.left + 1 && pagesRect.right <= actionsRect.left + 1,
                `#mindmap-pages-bar must sit in the middle between brand and actions on a single row (brand.right=${brandRect.right}, pages.left=${pagesRect.left}, pages.right=${pagesRect.right}, actions.left=${actionsRect.left})`);

            // 1. Default page 1 exists and renders in #mindmap-pages-list
            const pages1 = window.MindMap.getPages();
            assert(pages1.length === 1, 'Should start with 1 mindmap page');
            const page1Id = pages1[0].id;
            const page1RootId = pages1[0].root.id;
            pages1[0].root.text = '第一页核心脉络';
            window.MindMap.render();

            let tabs = document.querySelectorAll('#mindmap-pages-list .mm-page-tab');
            assert(tabs.length === 1, 'Should render 1 page tab');
            assert(tabs[0].classList.contains('is-active'), 'First tab must be active');

            // 2. Bind PDF page 3 to MindMap Page 1 and test locatePdfPage click
            window.MindMap.setPagePdfPage(page1Id, 3);
            assert(window.MindMap.getActivePage().page === 3, 'Page 1 bound PDF page must be 3');
            assert(state.annotations.mindmap.page === 3, 'Top-level mindmap.page alias must sync to 3');
            assert(document.getElementById('mindmap-bind-page-text').textContent === 'P.3', 'Bind button text must show P.3');

            const tab1Badge = document.querySelector(`.mm-page-tab[data-page-id="${page1Id}"] .mm-page-badge`);
            assert(tab1Badge !== null, 'Page 1 tab must render .mm-page-badge when bound to PDF page');
            assert(tab1Badge.textContent.includes('P.3'), 'Page 1 tab badge must show P.3');
            tab1Badge.click();
            assert(locatedPage === 3, `Clicking page tab badge must locate PDF page 3, got ${locatedPage}`);

            // 3. Add MindMap Page 2 via button and draw independent nodes on Page 2
            document.getElementById('mindmap-add-page-btn').click();
            const pagesAfterAdd = window.MindMap.getPages();
            assert(pagesAfterAdd.length === 2, 'Should have 2 mindmap pages after clicking add page button');
            const page2 = window.MindMap.getActivePage();
            const page2Id = page2.id;
            assert(page2Id !== page1Id, 'Active page should switch to newly added page 2');
            assert(page2.root.id !== page1RootId, 'Page 2 must have its own independent root node');

            // Add a parallel main chain on Page 2
            window.MindMap.addMainChain('第二页专属主链 II');
            assert(state.annotations.mindmap.nodes.length === 2, 'Page 2 should have 2 main chains');

            // Bind Page 2 to PDF page 5 (current reading page) via page picker popover
            document.getElementById('mindmap-bind-page-btn').click();
            const pop = document.getElementById('mm-popover-dialog');
            assert(pop !== null, 'Clicking #mindmap-bind-page-btn must open page picker popover');
            pop.querySelector('#mm-pop-bind-cur').click();
            assert(window.MindMap.getActivePage().page === 5, 'Page 2 should bind to current reading page 5');

            const tab2BadgeGroup = document.querySelector(`.mm-page-tab[data-page-id="${page2Id}"] .mm-tab-page-badge`);
            assert(tab2BadgeGroup !== null && tab2BadgeGroup.classList.contains('is-active-page'), 'Page 2 badge should highlight as active reading page 5');
            assert(tab2BadgeGroup.textContent.includes('P.5 · 当前'), 'Page 2 badge should indicate current page');

            // 4. Switch back to Page 1 by clicking its tab and verify independent trees
            const tab1El = document.querySelector(`.mm-page-tab[data-page-id="${page1Id}"]`);
            tab1El.click();
            assert(window.MindMap.getActivePage().id === page1Id, 'Clicking Page 1 tab must switch active page to Page 1');
            assert(state.annotations.mindmap.nodes.length === 1, 'Page 1 must still have only 1 main chain');
            assert(state.annotations.mindmap.root.text === '第一页核心脉络', 'Page 1 root text must be preserved');
            assert(state.annotations.mindmap.page === 3, 'Top-level page alias must reflect Page 1 bound PDF page 3');

            // Clicking inactive Page 2's badge should switch to Page 2 AND jump to PDF page 5
            const tab2Badge = document.querySelector(`.mm-page-tab[data-page-id="${page2Id}"] .mm-page-badge`);
            tab2Badge.click();
            assert(window.MindMap.getActivePage().id === page2Id, 'Clicking Page 2 badge must switch to Page 2');
            assert(locatedPage === 5, `Clicking Page 2 badge must locate PDF page 5, got ${locatedPage}`);
            assert(state.annotations.mindmap.nodes.length === 2, 'Page 2 must still have its 2 main chains');

            // 5. Rename Page 2 and unbind its PDF page via clear button
            window.MindMap.renamePage(page2Id, '第二章 拓扑空间');
            const tab2Title = document.querySelector(`.mm-page-tab[data-page-id="${page2Id}"] .mm-page-tab-title`);
            assert(tab2Title.textContent === '第二章 拓扑空间', 'Page 2 tab title must update after renamePage');

            const tab2ClearBtn = document.querySelector(`.mm-page-tab[data-page-id="${page2Id}"] .mm-page-clear-btn`);
            tab2ClearBtn.click();
            assert(window.MindMap.getActivePage().page === null, 'Clicking clear button on page tab badge must unbind PDF page');

            // 6. Delete Page 2 and verify Undo restores it
            window.MindMap.deletePage(page2Id);
            assert(window.MindMap.getPages().length === 1, 'Deleting Page 2 should leave 1 page');
            assert(window.MindMap.getActivePage().id === page1Id, 'Active page should fall back to Page 1');

            if (typeof performUndo === 'function') {
                performUndo();
                window.MindMap.onAnnotationsLoaded();
                assert(window.MindMap.getPages().length === 2, 'Undo should restore deleted Page 2');
            }

            // 7. Verify adding many pages never wraps right buttons and keeps add/bind buttons fixed
            const pagesActions = toolbar.querySelector('.mm-pages-actions');
            const pagesList = document.getElementById('mindmap-pages-list');
            const initialActionsRect = actions.getBoundingClientRect();
            const initialAddBtnRect = document.getElementById('mindmap-add-page-btn').getBoundingClientRect();
            for (let i = 0; i < 7; i++) {
                window.MindMap.addPage({ title: `测试长页签标题_${i + 3}` });
            }
            const afterBrandRect = brand.getBoundingClientRect();
            const afterActionsRect = actions.getBoundingClientRect();
            const afterPagesActionsRect = pagesActions.getBoundingClientRect();
            const afterPagesListRect = pagesList.getBoundingClientRect();
            const afterAddBtnRect = document.getElementById('mindmap-add-page-btn').getBoundingClientRect();
            assert(Math.abs(afterBrandRect.top - afterActionsRect.top) < 10,
                `Right toolbar buttons must not wrap to a new line when many pages are added (brand.top=${afterBrandRect.top}, actions.top=${afterActionsRect.top})`);
            assert(Math.abs(afterActionsRect.left - initialActionsRect.left) < 2,
                `Right toolbar buttons must remain fixed horizontally (before=${initialActionsRect.left}, after=${afterActionsRect.left})`);
            assert(Math.abs(afterAddBtnRect.left - initialAddBtnRect.left) < 2,
                `Add-page button must remain fixed horizontally (before=${initialAddBtnRect.left}, after=${afterAddBtnRect.left})`);
            assert(afterPagesListRect.right <= afterPagesActionsRect.left + 1,
                `Pages list max rightward extent must stop at the fixed bind/add buttons (list.right=${afterPagesListRect.right}, pagesActions.left=${afterPagesActionsRect.left})`);
            assert(pagesList.scrollWidth > pagesList.clientWidth,
                'Pages list should scroll horizontally when many pages are added');

            document.title = 'MULTI_PAGE_MINDMAP_OK';
        } catch (e) {
            document.title = 'MULTI_PAGE_MINDMAP_ERR: ' + (e && e.stack ? e.stack : e);
        }
    }, 120);
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
                temp_path
            ]
            res = subprocess.run(cmd, capture_output=True, timeout=25)
            stdout = res.stdout.decode("utf-8", errors="replace")
            title = re.search(r"<title>(.*?)</title>", stdout, re.S)
            self.assertIsNotNone(title, "Browser did not return a document title")
            self.assertEqual(title.group(1), "MULTI_PAGE_MINDMAP_OK")
        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

if __name__ == '__main__':
    unittest.main()


