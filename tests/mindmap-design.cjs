// Isolated browser regression: generated PDF, temporary origin, no external services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(path.join(process.env.READER_TEST_NODE_MODULES ||
  'node_modules', 'playwright'));
const root = path.resolve(__dirname, '..');
const { PDFDocument } = require(path.join(root, 'static/lib/pdf-lib.min.js'));
const output = path.join(__dirname, 'results/mindmap-design');
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
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.READER_TEST_BROWSER ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]).drawText('Mind map regression fixture', { x: 40, y: 760, size: 20 });
    const bytes = Buffer.from(await pdf.save()).toString('base64');

    await page.goto(origin);
    await page.evaluate(async b64 => {
      await processSelectedFile(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'design-fixture.pdf', { type: 'application/pdf' }), null);
      await state.annotationsReady;
      window.MindMap.toggle(true);
    }, bytes);
    const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    async function fixture() {
      await page.evaluate(() => {
        const n = (id, text, extra = {}) => ({ id, text, children: [], branches: [], mergeTo: [], ...extra });
        const root = n('root', '紧性与连续性', { children: [n('stage', '等价条件', { tag: 'prop', children: [
          n('a', '开覆盖条件', { children: [n('ab', '有限子覆盖', { tag: 'thm', children: [n('result', '紧性判定')] })] }),
          n('b', '有限交性质', { convergeTo: ['ab'] }),
          n('c', '序列条件', { children: [n('c-result', '收敛子列', { tag: 'thm', convergeTo: ['result'] })] })
        ] })] });
        state.annotations.mindmap = { version: 3, root, nodes: [root], zoom: 1 };
        initHistory();
        document.getElementById('mindmap-panel').style.width = '860px';
        window.MindMap.render();
        window.MindMap.center(false, true);
      });
      await settle();
    }
    async function geometry() {
      return page.evaluate(() => {
        const cards = [...document.querySelectorAll('.mm-card')].map(el => ({ id: el.dataset.id, rect: el.getBoundingClientRect() }));
        const collisions = [], overlaps = [];
        for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
          const a = cards[i].rect, b = cards[j].rect;
          if (Math.min(a.right,b.right) > Math.max(a.left,b.left) + 1 && Math.min(a.bottom,b.bottom) > Math.max(a.top,b.top) + 1) overlaps.push([cards[i].id,cards[j].id]);
        }
        for (const line of document.querySelectorAll('.mm-connector-path, .mm-connector-converge')) {
          const matrix = line.getScreenCTM();
          for (let d = 2; d < line.getTotalLength(); d += 2) {
            const p = line.getPointAtLength(d).matrixTransform(matrix);
            const hit = cards.find(({ rect: r }) => p.x > r.left + 1 && p.x < r.right - 1 && p.y > r.top + 1 && p.y < r.bottom - 1);
            if (hit) { collisions.push(`${line.dataset.parentId}->${line.dataset.childId} crosses ${hit.id}`); break; }
          }
        }
        const rect = id => cards.find(c => c.id === id).rect;
        const cy = id => rect(id).top + rect(id).height / 2;
        return { collisions, overlaps, centered: Math.abs(cy('ab') - (cy('a') + cy('b')) / 2) < 1,
          resultCentered: Math.abs(cy('result') - (cy('ab') + cy('c-result')) / 2) < 1,
          unique: new Set(cards.map(c => c.id)).size === cards.length };
      });
    }
    await fixture();
    const saved = await page.evaluate(() => JSON.stringify(state.annotations.mindmap.nodes));
    assert.deepEqual(await geometry(), { collisions: [], overlaps: [], centered: true, resultCentered: true, unique: true });
    await page.mouse.move(1300, 950);
    await page.locator('#mindmap-panel').screenshot({ path: path.join(output, 'shared-conclusions.png') });
    await page.locator('.mm-spine-branch[data-id="stage"]').screenshot({ path: path.join(output, 'flow-arrows.png') });
    // The ownership edge and explicit convergeTo edge must look identical, including selection.
    await page.addStyleTag({ content: '.mm-connector-path, .mm-connector-converge { transition: none !important; }' });
    async function convergenceStyle(id) {
      return page.evaluate(target => [...document.querySelectorAll(`path[data-child-id="${target}"]`)].map(path => {
        const style = getComputedStyle(path);
        const markerId = path.getAttribute('marker-end')?.match(/#([^)]*)/)?.[1];
        const arrow = markerId && document.getElementById(markerId)?.querySelector('path');
        return { stroke: style.stroke, width: style.strokeWidth, opacity: style.opacity,
          arrowStroke: arrow && getComputedStyle(arrow).stroke, arrowWidth: arrow && getComputedStyle(arrow).strokeWidth,
          highlighted: path.classList.contains('highlighted') };
      }), id);
    }
    for (const eyeProtection of [false, true]) {
      await page.evaluate(eye => document.body.classList.toggle('eye-protection-mode', eye), eyeProtection);
      await page.locator('.mm-card[data-id="root"]').click();
      const idle = await convergenceStyle('ab');
      assert.equal(idle.length, 2);
      assert.deepEqual(idle[0], idle[1], 'all incoming edges use the same idle style');
      assert.equal(idle[0].highlighted, false);
      const ordinary = await convergenceStyle('c-result');
      assert.equal(ordinary.length, 1);
      assert.deepEqual(ordinary[0], idle[0], 'normal parent-child and convergence edges share exactly the same style');
      assert.equal(idle[0].arrowStroke, idle[0].stroke, 'idle arrow matches its line in both themes');
      assert.equal(idle[0].arrowWidth, idle[0].width);
      await page.locator('.mm-card[data-id="b"]').click();
      const selected = await convergenceStyle('ab');
      assert.deepEqual(selected[0], selected[1], 'selecting any source highlights the whole convergence');
      assert.equal(selected[0].highlighted, true);
      assert.notEqual(selected[0].stroke, idle[0].stroke);
      await page.locator('.mm-card[data-id="c"]').click({ modifiers: ['Control'] });
      assert.deepEqual((await convergenceStyle('c-result'))[0], selected[0], 'selected parent-child and convergence edges share the same style');
      assert.equal(selected[0].arrowStroke, selected[0].stroke, 'highlighted arrow matches its line');
      assert.equal(selected[0].arrowWidth, selected[0].width);
      await page.evaluate(() => MindMap.render());
      await settle();
      assert.deepEqual(await convergenceStyle('ab'), selected, 'redrawing retains the same group highlighting');
    }
    await page.evaluate(() => document.body.classList.remove('eye-protection-mode'));
    const arrows = await page.evaluate(() => [...document.querySelectorAll('.mm-connector-path, .mm-connector-spine, .mm-connector-converge')].map(line => {
      const markerId = line.getAttribute('marker-end')?.match(/#([^)]*)/)?.[1];
      const marker = markerId && document.getElementById(markerId);
      const target = document.querySelector(`.mm-card[data-id="${line.dataset.childId}"]`).getBoundingClientRect();
      const end = line.getPointAtLength(line.getTotalLength()).matrixTransform(line.getScreenCTM());
      const before = line.getPointAtLength(Math.max(0, line.getTotalLength() - 1)).matrixTransform(line.getScreenCTM());
      const towardTarget = (end.x - before.x) * (target.left + target.width / 2 - end.x)
        + (end.y - before.y) * (target.top + target.height / 2 - end.y);
      return { edge: `${line.dataset.parentId}->${line.dataset.childId}`, marker: !!marker,
        automatic: marker?.getAttribute('orient') === 'auto', pointsToTarget: towardTarget > 0,
        outsideCard: end.x < target.left || end.x > target.right || end.y < target.top || end.y > target.bottom };
    }));
    assert.ok(arrows.length >= 8);
    assert.deepEqual(arrows.filter(arrow => !arrow.marker || !arrow.automatic || !arrow.pointsToTarget || !arrow.outsideCard), [],
      'each solid edge has a forward arrow just outside its destination card');
    console.log('PASS: uniform parent-child/convergence strokes, matching direction arrows and group selection in both themes');
    await page.locator('.mm-card[data-id="ab"]').dblclick();
    await page.locator('.mm-inline-editor').fill('有限子覆盖\n每个开覆盖都存在有限子覆盖\n$K \\subset X$');
    await page.keyboard.press('Enter');
    await settle();
    assert.deepEqual((await geometry()).overlaps, [], 'editing a shared conclusion must reflow adjacent cards');
    await page.keyboard.press('Control+z');
    await settle();
    assert.equal(await page.evaluate(() => JSON.stringify(state.annotations.mindmap.nodes)), saved);
    assert.deepEqual(await geometry(), { collisions: [], overlaps: [], centered: true, resultCentered: true, unique: true });
    console.log('PASS: nested shared conclusions centered, no overlaps or line crossings, text reflow and undo');

    // Collapse/expand must reconstruct the original data tree even though the view is flattened.
    await page.locator('.mm-card[data-id="a"]').click();
    await page.locator('.mm-tree-branch[data-id="a"] > .mm-card-wrapper > .mm-branch-toggle').click();
    assert.equal(await page.locator('.mm-card[data-id="ab"]').count(), 0);
    await page.locator('.mm-tree-branch[data-id="a"] > .mm-card-wrapper > .mm-branch-toggle').click();
    await settle();
    assert.deepEqual(await geometry(), { collisions: [], overlaps: [], centered: true, resultCentered: true, unique: true });
    console.log('PASS: collapse and expand preserve all shared descendants');

    await page.locator('.mm-card[data-id="b"]').click();
    await page.locator('#mindmap-merge-btn').click();
    assert.match(await page.locator('.mm-pop-tabs [aria-selected="true"]').textContent(), /连线/);
    await page.locator('.mm-pop-tabs [data-mode="converge"]').click();
    assert.match(await page.locator('.mm-pop-tabs [aria-selected="true"]').textContent(), /合流/);
    await page.locator('#mm-connect-search').fill('序列条件');
    assert.equal(await page.locator('.mm-connect-list .mm-connect-row').count(), 1);
    await page.locator('.mm-connect-list input').check();
    assert.match(await page.locator('#mm-pop-converge-next').textContent(), /2 项/);
    await page.locator('#mm-connect-search').fill('');
    await page.locator('#mm-popover-dialog').screenshot({ path: path.join(output, 'connect-panel.png') });
    await page.locator('#mm-pop-close').click();
    // All streamlined node actions remain available with clean text labels.
    await page.locator('.mm-card[data-id="b"] .mm-act-more').click();
    assert.equal(await page.locator('#mm-context-menu [data-action="fork-branch"]').count(), 0);
    assert.equal(await page.locator('#mm-context-menu [data-action="edit"]').count(), 0);
    assert.equal(await page.locator('#mm-context-menu [data-action="add-child"]').count(), 0);
    assert.equal(await page.locator('#mm-context-menu [data-action="add-sibling"]').count(), 0);
    assert.equal(await page.locator('#mm-context-menu [data-action="merge-link"]').count(), 0);
    for (const action of ['pick-tag','pick-page','reparent','delete']) {
      assert.equal(await page.locator(`#mm-context-menu [data-action="${action}"]`).count(), 1);
    }
    await page.keyboard.press('Escape');
    await page.locator('.mm-card[data-id="c"]').click({ modifiers: ['Control'] });
    assert.equal(await page.locator('#mindmap-selection-label').textContent(), '已选 2 项');
    assert.equal(await page.locator('#mindmap-fork-btn').isDisabled(), true);
    const beforeMerge = await page.evaluate(() => JSON.stringify(state.annotations.mindmap.nodes));
    await page.locator('#mindmap-merge-btn').click();
    await page.waitForSelector('.mm-inline-editor');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => JSON.stringify(state.annotations.mindmap.nodes)), beforeMerge);
    console.log('PASS: searchable source selection, more menu, contextual multi-selection and atomic undo');

    await page.evaluate(() => {
      document.getElementById('mindmap-panel').style.width = '280px';
      window.MindMap.center(false, true);
      document.querySelector('.mm-card[data-id="b"]').click();
    });
    await page.locator('#mindmap-merge-btn').click();
    await page.locator('[data-mode="link"]').click();
    await page.locator('#mm-connect-search').fill('序列条件');
    await page.locator('.mm-connect-list button').click();
    assert.deepEqual(await page.evaluate(() => state.annotations.mindmap.root.children[0].children[1].mergeTo), ['c']);
    await page.locator('#mindmap-merge-btn').click();
    await page.locator('[data-mode="fuse"]').click();
    await page.locator('#mm-connect-search').fill('序列条件');
    await page.locator('.mm-connect-list button').click();
    assert.equal(await page.locator('.mm-card[data-id="b"]').count(), 0);
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('.mm-card[data-id="b"]').count(), 1);
    await page.evaluate(() => document.body.classList.add('eye-protection-mode'));
    await page.locator('#mindmap-panel').screenshot({ path: path.join(output, 'narrow-eye-protection.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: separate link/fuse actions, narrow layout, eye protection and no runtime errors');

    await fixture();
    await page.evaluate(() => {
      const [a, b, c] = state.annotations.mindmap.root.children[0].children;
      b.convergeTo = [];
      b.children = [{ id: 'between', text: '保留的独立论证', children: [] }];
      c.convergeTo = ['ab'];
      // Direct connections skipping a column must not cut through unrelated content.
      b.convergeTo = ['result'];
      window.MindMap.render();
      window.MindMap.center(false, true);
    });
    await settle();
    const sparse = await geometry();
    assert.deepEqual(sparse.overlaps, []);
    assert.deepEqual(sparse.collisions, [], 'nonadjacent sources and cross-column links avoid other cards');
    console.log('PASS: nonadjacent sources and cross-column connections');

    await fixture();
    await page.locator('.mm-card[data-id="b"]').click();
    assert.equal(await page.locator('#mindmap-fork-btn').isVisible(), false);
    const lateralData = await page.evaluate(() => JSON.stringify(state.annotations.mindmap.nodes));
    await page.keyboard.press('Shift+Enter');
    assert.equal(await page.evaluate(() => MindMap.forkBranch('b')), false);
    assert.equal(await page.evaluate(() => JSON.stringify(state.annotations.mindmap.nodes)), lateralData);
    await page.locator('#mindmap-merge-btn').click();
    assert.equal(await page.locator('#mm-pop-converge-fork').count(), 0);
    await page.locator('#mm-pop-close').click();

    await page.locator('.mm-card[data-id="root"]').click();
    assert.equal(await page.locator('#mindmap-fork-btn').isVisible(), true);
    await page.locator('#mindmap-fork-btn').click();
    await page.waitForSelector('.mm-inline-editor');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => ({ chains: state.annotations.mindmap.nodes.length,
      tracks: state.annotations.mindmap.root.branches.length })), { chains: 1, tracks: 2 });
    const rootFork = await page.evaluate(() => JSON.stringify(state.annotations.mindmap.nodes));
    await page.evaluate(() => MindMap.convergeBranches('root'));
    assert.equal(await page.evaluate(() => state.annotations.mindmap.nodes.length), 1);
    assert.equal(await page.evaluate(() => state.annotations.mindmap.root.children[0].id), 'stage');
    assert.equal(await page.evaluate(() => JSON.stringify(state.annotations.mindmap.nodes)), rootFork);
    // Empty roots also branch downward and create their convergence in the same main chain.
    await page.evaluate(() => {
      const root = state.annotations.mindmap.root;
      root.children = [];
      root.branches = [];
      MindMap.render();
      initHistory();
      MindMap.forkBranch('root');
    });
    await page.waitForSelector('.mm-inline-editor');
    await page.keyboard.press('Escape');
    const branchedRoot = await page.evaluate(() => JSON.stringify(state.annotations.mindmap.nodes));
    await page.evaluate(() => MindMap.convergeBranches('root'));
    await page.waitForSelector('.mm-inline-editor');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => state.annotations.mindmap.nodes.length), 1);
    assert.equal(await page.evaluate(() => state.annotations.mindmap.root.children.length), 1);
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => JSON.stringify(state.annotations.mindmap.nodes)), branchedRoot);
    assert.deepEqual(errors, []);
    console.log('PASS: lateral fork removed from UI/keyboard/API; root forks and convergence stay within the vertical chain');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
