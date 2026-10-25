// Isolated browser regression: generated PDF, temporary origin, no external services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(path.join(process.env.READER_TEST_NODE_MODULES ||
  'node_modules', 'playwright'));
const root = path.resolve(__dirname, '..');
const { PDFDocument } = require(path.join(root, 'static/lib/pdf-lib.min.js'));
const output = path.join(__dirname, 'results/mindmap');
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
    async function open() {
      await page.goto(origin);
      await page.evaluate(async b64 => {
        const file = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'mindmap-fixture.pdf', { type: 'application/pdf' });
        await processSelectedFile(file, null);
        await state.annotationsReady;
        window.MindMap.toggle(true);
      }, bytes);
    }
    async function settle() {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function snapshot() {
      return page.evaluate(() => JSON.parse(JSON.stringify(state.annotations.mindmap.nodes)));
    }
    async function integrity(expected) {
      const value = await page.evaluate(() => {
        const d = state.annotations.mindmap;
        const ids = [...document.querySelectorAll('.mm-card')].map(el => el.dataset.id);
        return { chains: d.nodes.length, domChains: document.querySelectorAll('.mm-root-branch').length,
          alias: d.root === d.nodes[0], unique: new Set(ids).size === ids.length };
      });
      assert.deepEqual(value, { chains: expected, domChains: expected, alias: true, unique: true });
    }
    await open();
    await integrity(1);
    assert.equal(await page.locator('.mm-card').count(), 1, 'new mind maps start with only a root node');
    assert.deepEqual(await page.evaluate(() => state.annotations.mindmap.root.children), []);
    const before = await snapshot();
    await page.evaluate(() => window.MindMap.addMainChain('独立主链'));
    const twoChains = await snapshot();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Control+z');
      await integrity(1);
      assert.deepEqual(await snapshot(), before, 'undo must restore the full node structure');
      await page.keyboard.press('Control+y');
      await integrity(2);
      assert.deepEqual(await snapshot(), twoChains, 'redo must restore exactly two chains');
    }
    // Same title, different IDs must remain separate; serialized duplicate IDs must not multiply.
    await page.evaluate(() => {
      const data = state.annotations.mindmap;
      data.nodes[1].text = data.nodes[0].text;
      const restored = JSON.parse(JSON.stringify(data));
      restored.nodes.push(JSON.parse(JSON.stringify(restored.nodes[0])));
      state.annotations.mindmap = restored;
      window.MindMap.render();
    });
    await integrity(2);
    const persisted = await snapshot();
    await page.evaluate(async () => {
      updateSaveStatus(true);
      await saveAnnotationsToStorage();
    });
    await open();
    await integrity(2);
    assert.deepEqual(await snapshot(), persisted, 'IndexedDB draft reload must retain both distinct chains');
    console.log('PASS: keyboard undo/redo, duplicate IDs, same-title chains and persisted reload');
    await page.evaluate(() => {
      const data = state.annotations.mindmap;
      window.MindMap.fuseNodeInto(data.nodes[1].id, data.nodes[0].id);
    });
    await integrity(1);
    await page.keyboard.press('Control+z');
    await integrity(2);
    assert.deepEqual(await snapshot(), persisted, 'fusion undo restores the original independent chains');
    await page.keyboard.press('Control+y');
    await integrity(1);
    console.log('PASS: main-chain fusion and undo/redo preserve list references and content');

    // Uneven parallel proof tracks, nested forks, lateral details, root forks and convergence.
    await page.evaluate(() => {
      const n = (id, text, extra = {}) => ({ id, text, page: null, children: [], branches: [], mergeTo: [], ...extra });
      const lateral = n('detail', '等价刻画', { tag: 'prop', branches: [
        [n('h1', '必要性', { tag: 'proof' }), n('h2', '推出有界性')],
        [n('h3', '充分性', { tag: 'proof', branches: [[n('nested1', '构造逼近')], [n('nested2', '控制误差')]],
          convergeChildren: [n('nested-conclusion', '收敛成立')] })]
      ], convergeChildren: [n('h-result', '等价条件成立', { tag: 'thm' })] });
      const chain = n('root', '泛函分析 · 证明脉络', { branches: [[n('r1', '线性空间')], [n('r2', '度量空间')]], children: [
        n('definition', '赋范线性空间 $\\|x\\|$', { tag: 'def', children: [lateral], branches: [
          [n('v1', '连续性', { tag: 'lemma' }), n('v2', '一致有界')],
          [n('v3', '紧性', { tag: 'lemma', children: [n('v-detail', '抽取有限覆盖')] })]
        ] }),
        n('conclusion', '连续线性算子的等价刻画', { tag: 'thm', children: [n('corollary', '推论：有限维情形', { tag: 'cor' })] })
      ] });
      state.annotations.mindmap = { version: 3, root: chain, nodes: [chain], zoom: 1 };
      initHistory();
      document.getElementById('mindmap-panel').style.width = '860px';
      window.MindMap.render();
      window.MindMap.center(false, true);
    });
    await settle();
    const routing = await page.evaluate(() => {
      const svg = document.getElementById('mindmap-svg-canvas');
      const cards = [...document.querySelectorAll('.mm-card')].map(el => ({ id: el.dataset.id, rect: el.getBoundingClientRect() }));
      const collisions = [];
      for (const line of svg.querySelectorAll('.mm-connector-path, .mm-connector-spine')) {
        const length = line.getTotalLength();
        const matrix = line.getScreenCTM();
        for (let d = 3; d < length; d += 3) {
          const p = line.getPointAtLength(d).matrixTransform(matrix);
          const hit = cards.find(({ rect: r }) => p.x > r.left + 2 && p.x < r.right - 2 && p.y > r.top + 2 && p.y < r.bottom - 2);
          if (hit) { collisions.push(`${line.dataset.parentId}->${line.dataset.childId} crosses ${hit.id}`); break; }
        }
      }
      const card = id => document.querySelector(`.mm-card[data-id="${id}"]`).getBoundingClientRect();
      return { collisions, forwardRoot: card('r1').bottom < card('definition').top,
        markers: [...svg.querySelectorAll('marker')].every(el => el.getAttribute('markerUnits') === 'userSpaceOnUse' && el.querySelector('path').getAttribute('fill') === 'none') };
    });
    await page.locator('#mindmap-panel').screenshot({ path: path.join(output, 'complex-layout.png') });
    assert.deepEqual(routing.collisions, [], 'automatic connectors must avoid node interiors');
    assert.equal(routing.forwardRoot, true, 'root fork must precede its convergence');
    assert.equal(routing.markers, true);
    console.log('PASS: nested vertical/horizontal routing, root order and open arrowheads');

    const pdfView = await page.evaluate(() => ({ scale: state.scale, scroll: document.getElementById('viewer-container').scrollTop }));
    const oldZoom = await page.locator('#mindmap-zoom-val').textContent();
    await page.locator('#mindmap-viewport').hover({ position: { x: 12, y: 600 } });
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForFunction(old => document.getElementById('mindmap-zoom-val').textContent !== old, oldZoom);
    assert.deepEqual(await page.evaluate(() => ({ scale: state.scale, scroll: document.getElementById('viewer-container').scrollTop })), pdfView);
    await page.evaluate(() => window.MindMap.center(false, true));
    console.log('PASS: mind-map zoom leaves PDF zoom and scroll position unchanged');

    // Merge preview snaps to the target, and cancel removes both line and target state.
    await page.locator('.mm-card[data-id="conclusion"]').click();
    await page.keyboard.press('m');
    await page.locator('.mm-card[data-id="v1"]').hover();
    await settle();
    assert.equal(await page.locator('.mm-merge-target').getAttribute('data-id'), 'v1');
    assert.equal(await page.locator('.mm-connector-merge-preview').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.mm-connector-merge-preview').count(), 0);
    assert.equal(await page.locator('.mm-merge-target').count(), 0);
    await page.keyboard.press('m');
    await page.locator('.mm-card[data-id="v1"]').click();
    assert.deepEqual(await page.evaluate(() => state.annotations.mindmap.root.children[1].mergeTo), ['v1']);
    await page.keyboard.press('Control+z');
    await integrity(1);
    assert.deepEqual(await page.evaluate(() => state.annotations.mindmap.root.children[1].mergeTo), []);
    await page.keyboard.press('Control+y');
    await integrity(1);
    assert.deepEqual(await page.evaluate(() => state.annotations.mindmap.root.children[1].mergeTo), ['v1']);
    console.log('PASS: interactive merge, snapped preview, Escape cleanup and merge undo/redo');

    // Actual fork/converge controls retain content through history (cancel default auto-edit first).
    await page.evaluate(() => window.MindMap.forkBranch('conclusion'));
    await page.waitForSelector('.mm-inline-editor');
    await page.keyboard.press('Escape');
    const forked = await snapshot();
    await page.evaluate(() => window.MindMap.convergeBranches('conclusion'));
    await page.waitForSelector('.mm-inline-editor');
    await page.keyboard.press('Escape');
    const converged = await snapshot();
    await page.keyboard.press('Control+z');
    assert.deepEqual(await snapshot(), forked);
    await page.keyboard.press('Control+y');
    assert.deepEqual(await snapshot(), converged);
    await integrity(1);
    console.log('PASS: vertical fork/convergence undo and redo');

    // Sweep breakpoints with both visible/hidden fork controls and longer node counts.
    for (const selectedId of ['root', 'v-detail']) {
      await page.evaluate(id => document.querySelector(`.mm-card[data-id="${id}"]`).click(), selectedId);
      for (const width of [860, 560, 480, 441, 440, 420, 400, 393, 392, 360, 341, 340, 320, 300, 280]) {
        await page.evaluate(width => {
          document.getElementById('mindmap-panel').style.width = `${width}px`;
          document.getElementById('mindmap-node-count').textContent = '12·12345';
          document.getElementById('mindmap-zoom-val').textContent = '250%';
        }, width);
        await settle();
        const layout = await page.evaluate(() => {
          const toolbar = document.getElementById('mindmap-toolbar');
          const panel = document.getElementById('mindmap-panel').getBoundingClientRect();
          const controls = [...toolbar.querySelectorAll('button, #mindmap-zoom-val')]
            .map(el => ({ el, rect: el.getBoundingClientRect() })).filter(({ rect }) => rect.width && rect.height);
          const clipped = controls.filter(({ rect: r }) => r.left < panel.left || r.right > panel.right).map(({ el }) => el.id);
          const blocked = controls.filter(({ el, rect: r }) => !el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)))
            .map(({ el }) => el.id);
          const overlap = [];
          controls.forEach((a, i) => controls.slice(i + 1).forEach(b => {
            if (Math.min(a.rect.right, b.rect.right) > Math.max(a.rect.left, b.rect.left) + 0.5 &&
                Math.min(a.rect.bottom, b.rect.bottom) > Math.max(a.rect.top, b.rect.top) + 0.5) overlap.push(`${a.el.id}/${b.el.id}`);
          }));
          return { clipped, blocked, overlap, overflow: toolbar.scrollWidth > toolbar.clientWidth + 1 };
        });
        assert.deepEqual(layout, { clipped: [], blocked: [], overlap: [], overflow: false }, `toolbar at ${width}px, selected ${selectedId}`);
      }
    }
    console.log('PASS: toolbar fits 280–860px with all buttons reachable, long counts and both fork states');

    // Drag the actual resize handle to its minimum, then use the right-hand controls.
    await page.evaluate(() => {
      document.getElementById('mindmap-panel').style.width = '400px';
      window.MindMap.render();
    });
    const handle = await page.locator('#mindmap-resizer').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
    await page.mouse.down();
    await page.mouse.move(handle.x - 200, handle.y + 100, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.locator('#mindmap-panel').evaluate(el => el.offsetWidth), 280);
    const zoomBefore = await page.locator('#mindmap-zoom-val').textContent();
    await page.locator('#mindmap-zoom-in').click();
    assert.notEqual(await page.locator('#mindmap-zoom-val').textContent(), zoomBefore);
    await page.locator('#mindmap-zoom-out').click();
    assert.equal(await page.locator('#mindmap-zoom-val').textContent(), zoomBefore);
    await page.locator('#mindmap-center-btn').click();
    await page.locator('#mindmap-close-btn').click();
    assert.equal(await page.locator('#mindmap-panel').isHidden(), true);
    await page.keyboard.press('t');
    await page.locator('#mindmap-shortcut-btn').click();
    assert.equal(await page.locator('#mindmap-panel').isHidden(), true);
    await page.keyboard.press('t');
    console.log('PASS: minimum-width resize, zoom, center, close and shortcut buttons');

    await page.evaluate(() => {
      document.getElementById('mindmap-panel').style.width = '280px';
      window.MindMap.center(false, true);
      document.querySelector('.mm-card[data-id="definition"]').click();
    });
    await page.locator('#mindmap-merge-btn').click();
    await page.locator('#mm-pop-pick-canvas').click();
    await page.waitForSelector('#mm-merge-banner');
    await settle();
    const contained = await page.evaluate(() => {
      const panel = document.getElementById('mindmap-panel').getBoundingClientRect();
      const brand = document.querySelector('#mindmap-toolbar .mm-toolbar-brand')?.getBoundingClientRect();
      const actions = document.querySelector('#mindmap-toolbar .mm-toolbar-actions')?.getBoundingClientRect();
      const noHeaderOverlap = Boolean(brand && actions && (brand.right <= actions.left || brand.bottom <= actions.top));
      return noHeaderOverlap && [...document.querySelectorAll('#mindmap-toolbar button, #mm-merge-banner')].every(el => {
        const r = el.getBoundingClientRect();
        return !r.width || (r.left >= panel.left && r.right <= panel.right);
      });
    });
    assert.equal(contained, true, 'toolbar and merge instruction must fit the minimum panel width without overlapping');
    await page.locator('#mindmap-panel').screenshot({ path: path.join(output, 'narrow-panel.png') });
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      document.body.classList.add('eye-protection-mode');
      document.getElementById('mindmap-panel').style.width = '860px';
      window.MindMap.center(false, true);
    });
    await page.locator('#mindmap-panel').screenshot({ path: path.join(output, 'eye-protection.png') });
    await page.keyboard.press('t');
    assert.equal(await page.locator('#mindmap-panel').isHidden(), true, 'pressing T must close the mindmap panel');
    await page.keyboard.press('t');
    assert.equal(await page.locator('#mindmap-panel').isHidden(), false, 'pressing T again must reopen the mindmap panel');
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log('PASS: narrow panel, eye-protection rendering, T toggle shortcut and no browser errors');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
