// Real Edge + local XeLaTeX regression; generated PDF and isolated browser storage only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startBackend } = require('./chat-backend.cjs');
const deps = process.env.READER_TEST_NODE_MODULES ||
  'node_modules';
const { chromium } = require(path.join(deps, 'playwright'));
const { PDFDocument } = require('../static/lib/pdf-lib.min.js');
const output = path.join(__dirname, 'results/mindmap-tikz');
const graph = String.raw`\begin{tikzpicture}
  \draw[<->] (-1,0) -- (8,0) node[right] {$x$};
  \draw[->] (0,-1) -- (0,4) node[above] {$y$};
  \draw[blue,thick] (0,0) -- (4,3);
  \node at (3,1) {中文坐标};
\end{tikzpicture}`;
const diagram = String.raw`\begin{tikzcd}
  A \arrow[r] \arrow[d] & B \arrow[d] \\
  C \arrow[r] & D
\end{tikzcd}`;
const source = `前文 <b>原样文本</b> $x<y$\n${graph}\n中间公式 $a+b$\n${diagram}\n后文 $$E=mc^2$$`;
const lateSource = String.raw`\begin{tikzpicture}
  % MINDMAP_DELAY
  \draw (0,0) -- (1,1);
\end{tikzpicture}`;
const lateDocumentSource = lateSource.replace('MINDMAP_DELAY', 'MINDMAP_DOCUMENT_DELAY');
const broken = String.raw`保留前文 $x^2$
\begin{tikzpicture}
  \draw (0,0) -- (2,2;
\end{tikzpicture}
保留后文 $y^2$`;

(async () => {
  let backend;
  let browser;
  let releaseLate;
  const lateResult = new Promise(resolve => { releaseLate = resolve; });
  let releaseDocument;
  const documentResult = new Promise(resolve => { releaseDocument = resolve; });
  const calls = [];
  try {
    backend = await startBackend();
    browser = await chromium.launch({ headless: true, executablePath: process.env.READER_TEST_BROWSER ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    // Keep API settings and background services isolated from the user's configuration.
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== backend.origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
      if (url.pathname === '/api/render-tikz') {
        const body = request.postData();
        calls.push(body);
        if (body.includes('MINDMAP_DELAY') || body.includes('MINDMAP_DOCUMENT_DELAY')) {
          await (body.includes('MINDMAP_DOCUMENT_DELAY') ? documentResult : lateResult);
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><path d="M0 0L400 300" stroke="blue"/></svg>';
          return route.fulfill({ contentType: 'text/plain', body: Buffer.from(svg).toString('base64') });
        }
        return route.continue();
      }
      if (url.pathname.startsWith('/api/')) {
        return route.fulfill({ json: { ok: true, configured: false, enabled: false, models: [], files: [] } });
      }
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]).drawText('Mind map TikZ fixture');
    const bytes = Buffer.from(await pdf.save()).toString('base64');
    async function open() {
      await page.goto(backend.origin + '/LOCALPdfReader.html');
      await page.evaluate(async b64 => {
        const file = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'mindmap-tikz-fixture.pdf', { type: 'application/pdf' });
        await processSelectedFile(file, null);
        await state.annotationsReady;
        window.MindMap.toggle(true);
        document.getElementById('mindmap-panel').style.width = '720px';
      }, bytes);
    }
    async function settle() {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function imagesReady(count) {
      await page.waitForFunction(expected => {
        const images = [...document.querySelectorAll('.mm-tikz img')];
        const error = document.querySelector('.mm-tikz-error');
        if (error) throw new Error(error.textContent);
        return images.length === expected && images.every(img => img.complete && img.naturalWidth > 0);
      }, count, { timeout: 60000 });
      await settle();
    }
    async function edit(id, text) {
      await page.locator(`.mm-card[data-id="${id}"]`).dispatchEvent('dblclick');
      await page.locator('.mm-inline-editor').fill(text);
      await page.keyboard.press('Control+Enter');
    }

    await open();
    await page.evaluate(({ source, graph }) => {
      const makeNode = (id, text, children = []) => ({ id, text, children, page: null, branches: [], mergeTo: [], collapsed: false });
      const root = makeNode('tikz-root', source, [makeNode('tikz-copy', graph), makeNode('tikz-tail', '后续节点')]);
      state.annotations.mindmap = { version: 3, root, nodes: [root], zoom: 1 };
      initHistory();
      window.MindMap.render();
    }, { source, graph });
    await imagesReady(3);
    assert.equal(calls.length, 2, 'duplicate graphs share one in-flight compile');
    assert.ok(calls.some(body => body.includes(graph) && body.includes('\\usepackage[UTF8]{ctex}')));
    assert.ok(calls.some(body => body.includes(diagram)), 'ampersands and backslashes reach the engine unchanged');
    const mixed = await page.locator('.mm-card[data-id="tikz-root"] .mm-card-body').evaluate(body => ({
      figures: body.querySelectorAll('.mm-tikz').length,
      formulas: body.querySelectorAll('.katex').length,
      text: body.textContent,
      injected: !!body.querySelector('b'),
      contained: [...body.querySelectorAll('img')].every(img => img.getBoundingClientRect().width <= body.getBoundingClientRect().width + 1)
    }));
    assert.equal(mixed.figures, 2);
    assert.equal(mixed.formulas, 3);
    assert.match(mixed.text, /前文 <b>原样文本<\/b>/);
    assert.match(mixed.text, /后文/);
    assert.equal(mixed.injected, false);
    assert.equal(mixed.contained, true, 'large diagrams fit the node');
    console.log('PASS: real TikZ/tikzcd SVGs, Chinese labels, mixed formulas, safe text and shared compilation');

    const anchored = await page.evaluate(() => {
      const root = document.querySelector('.mm-card[data-id="tikz-root"]').getBoundingClientRect();
      const path = document.querySelector('.mm-connector-spine[data-parent-id="tikz-root"]');
      const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
      return Math.abs(start.y - root.bottom - 2) < 1;
    });
    assert.equal(anchored, true, 'connectors follow the final asynchronous image size');
    await page.evaluate(() => window.MindMap.render());
    await imagesReady(3);
    assert.equal(calls.length, 2, 'tree reconstruction reuses the shared cache');
    await page.evaluate(code => {
      const div = document.createElement('div');
      div.id = 'tikz-annotation-check';
      div.textContent = code;
      document.body.appendChild(div);
      renderLatex(div);
    }, graph);
    await page.waitForFunction(() => document.querySelector('#tikz-annotation-check img')?.naturalWidth > 0);
    assert.equal(calls.length, 2, 'text annotations reuse the same compiled graph');
    await page.evaluate(() => document.getElementById('tikz-annotation-check').remove());
    console.log('PASS: image completion updates connectors; rerender and text annotations reuse the cache');

    await page.locator('.mm-card[data-id="tikz-root"]').dispatchEvent('dblclick');
    assert.equal(await page.locator('.mm-inline-editor').inputValue(), source, 'editing restores the original TeX');
    await page.keyboard.press('Escape');
    await edit('tikz-copy', '改为普通内容 $z^2$');
    await page.keyboard.press('Control+z');
    await imagesReady(3);
    await page.keyboard.press('Control+y');
    await imagesReady(2);
    assert.equal(await page.evaluate(() => state.annotations.mindmap.root.children[0].text), '改为普通内容 $z^2$');
    await page.evaluate(() => saveAnnotationsToStorage());
    await open();
    await imagesReady(2);
    assert.equal(await page.evaluate(() => state.annotations.mindmap.root.text), source);
    console.log('PASS: source editing, undo/redo and document reload preserve diagrams');

    await edit('tikz-copy', lateSource);
    await page.waitForFunction(code => window.TikzRender.requestTikzSvg(code, { extractBody: false }).status === 'pending', lateSource);
    await page.locator('.mm-card[data-id="tikz-copy"]').dispatchEvent('dblclick');
    await page.locator('.mm-inline-editor').fill('编译期间的新草稿 $w$');
    releaseLate();
    await page.waitForFunction(code => window.TikzRender.requestTikzSvg(code, { extractBody: false }).status === 'done', lateSource);
    assert.equal(await page.locator('.mm-inline-editor').inputValue(), '编译期间的新草稿 $w$');
    assert.equal(await page.locator('.mm-card[data-id="tikz-copy"] .mm-tikz').count(), 0);
    await page.keyboard.press('Control+Enter');
    console.log('PASS: delayed compilation cannot replace an active editor or its draft');

    const beforeIncomplete = calls.length;
    const incomplete = '\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);';
    await edit('tikz-copy', incomplete);
    assert.match(await page.locator('.mm-card[data-id="tikz-copy"] .mm-card-body').textContent(), /begin\{tikzpicture\}/);
    assert.equal(calls.length, beforeIncomplete, 'incomplete environments remain editable text');
    await edit('tikz-copy', broken);
    await page.waitForSelector('.mm-card[data-id="tikz-copy"] .mm-tikz-error', { timeout: 60000 });
    assert.equal(await page.locator('.mm-card[data-id="tikz-copy"] .katex').count(), 2);
    assert.match(await page.locator('.mm-card[data-id="tikz-copy"] .mm-card-body').textContent(), /保留后文/);
    await page.locator('.mm-card[data-id="tikz-copy"]').dispatchEvent('dblclick');
    assert.equal(await page.locator('.mm-inline-editor').inputValue(), broken);
    await page.keyboard.press('Escape');
    console.log('PASS: incomplete input and compile errors preserve surrounding text, formulas and editable source');

    if (process.env.READER_TEST_ARTIFACTS === '1') {
      fs.mkdirSync(output, { recursive: true });
      await page.evaluate(() => window.MindMap.center(false, true));
      await page.locator('#mindmap-panel').screenshot({ path: path.join(output, 'mixed-tikz.png') });
    }

    await edit('tikz-copy', lateDocumentSource);
    await page.waitForFunction(code => window.TikzRender.requestTikzSvg(code, { extractBody: false }).status === 'pending', lateDocumentSource);
    await page.evaluate(() => {
      window.__oldMindMapFigure = document.querySelector('.mm-card[data-id="tikz-copy"] .mm-tikz');
      window.MindMap.toggle(false);
    });
    const otherPdf = await PDFDocument.create();
    otherPdf.addPage([595, 842]).drawText('Another document, no diagrams');
    await page.evaluate(async b64 => {
      const file = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'other-tikz-fixture.pdf', { type: 'application/pdf' });
      await processSelectedFile(file, null);
      await state.annotationsReady;
    }, Buffer.from(await otherPdf.save()).toString('base64'));
    releaseDocument();
    await page.waitForFunction(code => window.TikzRender.requestTikzSvg(code, { extractBody: false }).status === 'done', lateDocumentSource);
    assert.equal(await page.evaluate(() => window.__oldMindMapFigure.textContent), '图形渲染中…', 'previous document DOM ignores the old result');
    await page.evaluate(() => window.MindMap.toggle(true));
    assert.equal(await page.locator('.mm-tikz').count(), 0, 'the new document receives no stale diagram');
    assert.deepEqual(errors, []);
    console.log('PASS: switching documents isolates delayed compilation results');
  } finally {
    releaseLate();
    releaseDocument();
    if (browser) await browser.close();
    if (backend) await backend.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
