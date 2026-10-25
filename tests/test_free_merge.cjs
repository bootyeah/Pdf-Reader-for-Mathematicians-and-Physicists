const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(path.join(process.env.READER_TEST_NODE_MODULES ||
  'node_modules', 'playwright'));

const root = path.resolve(__dirname, '..');
const { PDFDocument } = require(path.join(root, 'static/lib/pdf-lib.min.js'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, configured: false, enabled: false, models: [], files: [] }));
    return;
  }
  const base = path.join(root, 'static');
  const file = path.resolve(base, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  console.log('Starting solid free merge / converge test...');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const page = await context.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.error('Browser Error:', msg.text());
    });
    page.on('pageerror', err => console.error('Page Error:', err));

    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]).drawText('Free merge test fixture', { x: 40, y: 760, size: 20 });
    const bytes = Buffer.from(await pdf.save()).toString('base64');

    await page.goto(origin);
    await page.evaluate(async b64 => {
      const file = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'mindmap-fixture.pdf', { type: 'application/pdf' });
      await processSelectedFile(file, null);
      await state.annotationsReady;
      window.MindMap.toggle(true);
    }, bytes);
    await page.waitForTimeout(400);

    // 2. 准备场景：一个主节点下开三个子节点 (C1, C2, C3)
    const setupResult = await page.evaluate(() => {
      performAction(() => {
        state.annotations.mindmap.root.children = [
          { id: 'c1', text: '子节点 1', children: [], branches: [], convergeTo: [], mergeTo: [] },
          { id: 'c2', text: '子节点 2', children: [], branches: [], convergeTo: [], mergeTo: [] },
          { id: 'c3', text: '子节点 3', children: [], branches: [], convergeTo: [], mergeTo: [] }
        ];
        MindMap.render();
      }, ['mindmap']);
      return {
        childCount: state.annotations.mindmap.root.children.length
      };
    });
    assert.strictEqual(setupResult.childCount, 3, 'Root should have 3 children');
    await page.waitForTimeout(200);

    // 验证 DOM 中渲染了 3 个子节点
    const c1El = await page.$('.mm-card[data-id="c1"]');
    const c2El = await page.$('.mm-card[data-id="c2"]');
    const c3El = await page.$('.mm-card[data-id="c3"]');
    assert.ok(c1El && c2El && c3El, 'All 3 children cards must be rendered');

    // 3. 测试场景 A：选择其中两个子节点 (c1, c2) 实线合流到“进一步子节点”
    console.log('Testing Scene A: Select 2 children (c1, c2) and converge to further child node with solid line...');
    const convResultA = await page.evaluate(() => {
      MindMap.convergeNodesToNext(['c1', 'c2']);
      const data = state.annotations.mindmap;
      const c1 = data.root.children.find(c => c.id === 'c1');
      const c2 = data.root.children.find(c => c.id === 'c2');
      const c3 = data.root.children.find(c => c.id === 'c3');
      const furtherNode = c1.children[0];
      return {
        c1ChildCount: c1.children.length,
        furtherNodeId: furtherNode?.id,
        furtherNodeText: furtherNode?.text,
        c2ConvergeTo: c2.convergeTo,
        c2MergeTo: c2.mergeTo,
        c3ConvergeTo: c3.convergeTo,
        c3ChildCount: c3.children.length
      };
    });

    assert.strictEqual(convResultA.c1ChildCount, 1, 'c1 should have 1 child (further child node)');
    assert.ok(convResultA.furtherNodeId, 'Further child node should have an ID');
    assert.strictEqual(convResultA.furtherNodeText, '进一步子节点', 'Further child node default text');
    assert.deepStrictEqual(convResultA.c2ConvergeTo, [convResultA.furtherNodeId], 'c2 should have convergeTo pointing to further child node (solid line)');
    assert.deepStrictEqual(convResultA.c2MergeTo || [], [], 'c2 should NOT have mergeTo (no dashed line)');
    assert.deepStrictEqual(convResultA.c3ConvergeTo || [], [], 'c3 should be untouched');
    assert.strictEqual(convResultA.c3ChildCount, 0, 'c3 should have 0 children');
    await page.waitForTimeout(200);

    // 验证 SVG 连线：应该有一条 c2 -> furtherNode 的实线合流连线，绝无虚线
    const convPathA = await page.$(`.mm-connector-converge[data-parent-id="c2"][data-child-id="${convResultA.furtherNodeId}"]`);
    assert.ok(convPathA, 'SVG solid converge path (.mm-connector-converge) from c2 to furtherNode should exist');
    const mergePathA = await page.$(`.mm-connector-merge[data-parent-id="c2"][data-child-id="${convResultA.furtherNodeId}"]`);
    assert.strictEqual(mergePathA, null, 'No dashed merge path (.mm-connector-merge) should exist for converge');

    // 4. 测试撤销与重做
    console.log('Testing Undo / Redo for Scene A...');
    // 退出新节点的内联编辑，让全局快捷键生效
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    await page.hover('#mindmap-viewport');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);

    const undoCheck = await page.evaluate(() => {
      const data = state.annotations.mindmap;
      const c1 = data.root.children.find(c => c.id === 'c1');
      const c2 = data.root.children.find(c => c.id === 'c2');
      return {
        c1ChildCount: c1.children ? c1.children.length : 0,
        c2ConvergeCount: c2.convergeTo ? c2.convergeTo.length : 0
      };
    });
    assert.strictEqual(undoCheck.c1ChildCount, 0, 'Undo should revert further child node');
    assert.strictEqual(undoCheck.c2ConvergeCount, 0, 'Undo should revert c2 convergeTo');

    // 5. 测试场景 B：选择其中两个子节点 (c1, c2) 实线合流连到已有的下一个子节点 c3
    console.log('Testing Scene B: Select 2 children (c1, c2) and converge to existing sibling c3 with solid line...');
    const convResultB = await page.evaluate(() => {
      MindMap.convergeNodesToNext(['c1', 'c2'], 'c3');
      const data = state.annotations.mindmap;
      const c1 = data.root.children.find(c => c.id === 'c1');
      const c2 = data.root.children.find(c => c.id === 'c2');
      return {
        c1ConvergeTo: c1.convergeTo,
        c2ConvergeTo: c2.convergeTo,
        c1MergeTo: c1.mergeTo,
        c2MergeTo: c2.mergeTo
      };
    });
    assert.deepStrictEqual(convResultB.c1ConvergeTo, ['c3'], 'c1 should solid converge into c3');
    assert.deepStrictEqual(convResultB.c2ConvergeTo, ['c3'], 'c2 should solid converge into c3');
    assert.deepStrictEqual(convResultB.c1MergeTo || [], [], 'c1 should have no dashed mergeTo');
    assert.deepStrictEqual(convResultB.c2MergeTo || [], [], 'c2 should have no dashed mergeTo');
    await page.waitForTimeout(200);

    const convPathB1 = await page.$('.mm-connector-converge[data-parent-id="c1"][data-child-id="c3"]');
    const convPathB2 = await page.$('.mm-connector-converge[data-parent-id="c2"][data-child-id="c3"]');
    assert.ok(convPathB1, 'SVG solid converge path from c1 to c3 should exist');
    assert.ok(convPathB2, 'SVG solid converge path from c2 to c3 should exist');

    // 重置连线
    await page.evaluate(() => {
      performAction(() => {
        state.annotations.mindmap.root.children.forEach(c => { c.convergeTo = []; c.mergeTo = []; c.children = []; });
        MindMap.render();
      }, ['mindmap']);
    });
    await page.waitForTimeout(100);

    // 6. 测试场景 C：将全部三个子节点 (c1, c2, c3) 直接实线合流连到进一步子节点
    console.log('Testing Scene C: Converge all 3 children (c1, c2, c3) to further child node with solid lines...');
    const convResultC = await page.evaluate(() => {
      MindMap.convergeNodesToNext(['c1', 'c2', 'c3']);
      const data = state.annotations.mindmap;
      const c1 = data.root.children.find(c => c.id === 'c1');
      const c2 = data.root.children.find(c => c.id === 'c2');
      const c3 = data.root.children.find(c => c.id === 'c3');
      const furtherNode = c1.children[0];
      return {
        furtherNodeId: furtherNode?.id,
        c2ConvergeTo: c2.convergeTo,
        c3ConvergeTo: c3.convergeTo,
        c2MergeTo: c2.mergeTo,
        c3MergeTo: c3.mergeTo
      };
    });
    assert.ok(convResultC.furtherNodeId, 'Further node should exist');
    assert.deepStrictEqual(convResultC.c2ConvergeTo, [convResultC.furtherNodeId], 'c2 solid converges into further node');
    assert.deepStrictEqual(convResultC.c3ConvergeTo, [convResultC.furtherNodeId], 'c3 solid converges into further node');
    assert.deepStrictEqual(convResultC.c2MergeTo || [], [], 'No dashed lines');
    assert.deepStrictEqual(convResultC.c3MergeTo || [], [], 'No dashed lines');
    await page.waitForTimeout(200);

    const convPathC2 = await page.$(`.mm-connector-converge[data-parent-id="c2"][data-child-id="${convResultC.furtherNodeId}"]`);
    const convPathC3 = await page.$(`.mm-connector-converge[data-parent-id="c3"][data-child-id="${convResultC.furtherNodeId}"]`);
    assert.ok(convPathC2, 'SVG solid converge path from c2 to furtherNode exists');
    assert.ok(convPathC3, 'SVG solid converge path from c3 to furtherNode exists');

    // 7. 测试 UI 多选交互与快捷键 (Ctrl+Click 多选两节点 + Enter 合流)
    console.log('Testing UI Multi-selection & Enter keyboard shortcut...');
    await page.evaluate(() => {
      performAction(() => {
        state.annotations.mindmap.root.children = [
          { id: 'u1', text: '子节点 A', children: [], branches: [], convergeTo: [], mergeTo: [] },
          { id: 'u2', text: '子节点 B', children: [], branches: [], convergeTo: [], mergeTo: [] },
          { id: 'u3', text: '子节点 C', children: [], branches: [], convergeTo: [], mergeTo: [] }
        ];
        MindMap.render();
      }, ['mindmap']);
    });
    await page.waitForTimeout(200);

    // 单击 u1
    await page.click('.mm-card[data-id="u1"]');
    // Ctrl+单击 u2
    await page.click('.mm-card[data-id="u2"]', { modifiers: ['Control'] });

    const multiSelectCheck = await page.evaluate(() => {
      const u1 = document.querySelector('.mm-card[data-id="u1"]');
      const u2 = document.querySelector('.mm-card[data-id="u2"]');
      const u3 = document.querySelector('.mm-card[data-id="u3"]');
      return {
        u1Selected: u1.classList.contains('selected') && u1.classList.contains('is-multi-selected'),
        u2Selected: u2.classList.contains('selected') && u2.classList.contains('is-multi-selected'),
        u3Selected: u3.classList.contains('selected')
      };
    });
    assert.strictEqual(multiSelectCheck.u1Selected, true, 'u1 should be multi-selected');
    assert.strictEqual(multiSelectCheck.u2Selected, true, 'u2 should be multi-selected');
    assert.strictEqual(multiSelectCheck.u3Selected, false, 'u3 should not be selected');

    // 悬停在导图视口并按 Enter
    await page.hover('#mindmap-viewport');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const enterConvCheck = await page.evaluate(() => {
      const data = state.annotations.mindmap;
      const u1 = data.root.children.find(c => c.id === 'u1');
      const u2 = data.root.children.find(c => c.id === 'u2');
      const further = u1.children[0];
      const activeEditing = document.querySelector('.mm-card.is-editing');
      return {
        u1ChildCount: u1.children.length,
        furtherId: further?.id,
        u2ConvergeTo: u2.convergeTo,
        u2MergeTo: u2.mergeTo,
        isEditingFurther: activeEditing ? activeEditing.dataset.id === further?.id : false
      };
    });
    assert.strictEqual(enterConvCheck.u1ChildCount, 1, 'Pressing Enter on multi-selection creates further child');
    assert.deepStrictEqual(enterConvCheck.u2ConvergeTo, [enterConvCheck.furtherId], 'u2 solid converged into further node');
    assert.deepStrictEqual(enterConvCheck.u2MergeTo || [], [], 'u2 has no dashed mergeTo');
    assert.strictEqual(enterConvCheck.isEditingFurther, true, 'Further child node should enter inline editing');

    // 8. 测试场景 D：验证按 M 键的虚线引用功能完好保留（虚线连接另有用处）
    console.log('Testing Scene D: Verify dashed merge (按 M 虚线引用) is fully retained and independent...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const dashedResult = await page.evaluate(() => {
      // 建立跨节点虚线引用 u3 -> u1
      MindMap.toggleMergeLink('u3', 'u1');
      const data = state.annotations.mindmap;
      const u3 = data.root.children.find(c => c.id === 'u3');
      return {
        u3MergeTo: u3.mergeTo,
        u3ConvergeTo: u3.convergeTo
      };
    });
    assert.deepStrictEqual(dashedResult.u3MergeTo, ['u1'], 'u3 should have mergeTo pointing to u1 (dashed reference)');
    assert.deepStrictEqual(dashedResult.u3ConvergeTo || [], [], 'u3 should not have convergeTo');
    await page.waitForTimeout(200);

    // 验证同时存在：u2 -> further 的实线合流，以及 u3 -> u1 的虚线引用
    const dashedPath = await page.$('.mm-connector-merge[data-parent-id="u3"][data-child-id="u1"]');
    assert.ok(dashedPath, 'Dashed line (.mm-connector-merge) from u3 to u1 exists and is independent');

    console.log('ALL FREE SOLID MERGE / CONVERGE TESTS PASSED SUCCESSFULLY!');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
