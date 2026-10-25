// Standalone real-browser regression/benchmark harness. No application server or user files required.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const deps = process.env.READER_TEST_NODE_MODULES || 'node_modules';
const { chromium } = require(path.join(deps, 'playwright'));
const { PDFDocument, StandardFonts, rgb, PDFName, PDFHexString } = require('../static/lib/pdf-lib.min.js');
const root = path.resolve(__dirname, '..');
const staticRoot = path.join(root, 'static');
const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

async function fixture(kind, count, marker = 'A') {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let scan;
    if (kind === 'scan') {
        const sharp = require(path.join(deps, 'sharp'));
        const rows = Array.from({ length: 75 }, (_, i) => `<text x="80" y="${100 + i * 27}" font-size="17">SCANNED MATHEMATICS ${i} : x + y = z; 0123456789</text>`).join('');
        scan = await doc.embedPng(await sharp(Buffer.from(`<svg width="1600" height="2200"><rect width="100%" height="100%" fill="white"/>${rows}</svg>`)).png().toBuffer());
    }
    for (let i = 0; i < count; i++) {
        const size = kind === 'mixed' && i % 5 === 0 ? [842, 595] : [595, 842];
        const page = doc.addPage(size);
        if (scan) page.drawImage(scan, { x: 0, y: 0, width: size[0], height: size[1] });
        page.drawRectangle({ x: 20, y: size[1] - 70, width: 140, height: 40, color: marker === 'A' ? rgb(.12, .35, .8) : rgb(.8, .2, .12) });
        page.drawText(`Document ${marker}, page ${i + 1}. Algebra and geometry.`, { x: 25, y: size[1] - 95, size: 16, font });
        if (!scan) for (let j = 0; j < 30; j++) page.drawText(`Line ${j}: integral(x) = x^2/2. Theorem 12345.`, { x: 25, y: size[1] - 125 - j * 17, size: 10, font });
        if (kind === 'vector') for (let j = 0; j < 2200; j++) page.drawLine({ start: { x: 20 + j % 510, y: 60 + j % 610 }, end: { x: 20 + (j * 13) % 510, y: 60 + (j * 7) % 610 }, thickness: .15, color: rgb((j % 13) / 13, .4, .6), opacity: .4 });
    }
    const annotations = { 1: [{ id: 'saved-highlight', type: 'highlight', text: 'Saved test highlight', color: '#fde047', rects: [{ x: .04, y: .11, w: .3, h: .025 }] }], settings: { lastPage: 1 } };
    if (kind === 'remembered') annotations.settings.lastPage = 20;
    if (kind === 'annotated') for (let i = 1; i <= count; i++) {
        annotations[i] = [...(annotations[i] || []), ...Array.from({ length: 30 }, (_, j) => ({ id: `note-${i}-${j}`, type: 'highlight', text: `Theorem ${j}`, note: 'A saved explanation.', color: '#fde047', rects: [{ x: .05, y: .16 + j * .018, w: .4, h: .012 }] }))];
    }
    doc.getInfoDict().set(PDFName.of('ReaderProAnnos'), PDFHexString.of(Buffer.from(JSON.stringify(annotations)).toString('hex')));
    return Buffer.from(await doc.save());
}

function startServer(fixtures) {
    const server = http.createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname.startsWith('/fixtures/')) {
            const data = fixtures[pathname.slice(10)];
            if (!data) { res.writeHead(404).end(); return; }
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': data.length }); res.end(data); return;
        }
        if (pathname.includes('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
        let relative = pathname.replace(/^\/(?:static\/)?/, '');
        if (!relative || /^(?:LOCALPdfReader|index)\.html$/i.test(relative)) relative = 'index.html';
        if (relative === 'style.css') relative = 'css/style.css';
        let file = path.resolve(staticRoot, relative);
        if (pathname.startsWith('/airtex/')) {
            file = path.resolve(root, pathname.slice(1));
        } else if (pathname.startsWith('/baseline/')) {
            const part = pathname.slice(10);
            file = part.startsWith('lib/') ? path.resolve(staticRoot, part) : path.resolve(root, 'tests/baseline-20260912/' + part);
        }
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.bcmap': 'application/octet-stream' })[path.extname(file)] || 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function instrument(page) {
    await page.evaluate(() => {
        window.readerTest = { renders: [], frames: [], longTasks: [], clears: [], errors: [], completed: new WeakSet(), start: 0 };
        const t = readerTest;
        for (const prop of ['width', 'height']) {
            const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
            Object.defineProperty(HTMLCanvasElement.prototype, prop, { ...desc, set(value) {
                if (this.isConnected && t.completed.has(this)) {
                    const rect = this.getBoundingClientRect();
                    const visible = rect.bottom > 100 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
                    t.clears.push({ at: performance.now(), id: this.id, visible });
                    t.completed.delete(this);
                }
                desc.set.call(this, value);
            } });
        }
        const original = pdfjsLib;
        window.pdfjsLib = { ...original, getDocument(...args) {
            const task = original.getDocument(...args);
            task.promise.then(doc => {
                const getPage = doc.getPage.bind(doc);
                doc.getPage = (...pageArgs) => getPage(...pageArgs).then(p => {
                    if (!p.__testRender) {
                        p.__testRender = true;
                        const render = p.render.bind(p);
                        p.render = options => {
                            const event = { page: p.pageNumber, scale: options.viewport.scale, start: performance.now(), end: null };
                            t.renders.push(event);
                            const renderTask = render(options);
                            renderTask.promise.then(() => { event.end = performance.now(); t.completed.add(options.canvasContext.canvas); }, () => { event.cancelled = true; });
                            return renderTask;
                        };
                    }
                    return p;
                });
            }, () => {});
            return task;
        } };
        let last;
        function frame(now) { if (last !== undefined) t.frames.push({ at: now, ms: now - last }); last = now; requestAnimationFrame(frame); }
        requestAnimationFrame(frame);
        new PerformanceObserver(list => list.getEntries().forEach(e => t.longTasks.push({ at: e.startTime, ms: e.duration }))).observe({ type: 'longtask', buffered: true });
        window.addEventListener('unhandledrejection', e => t.errors.push(String(e.reason?.stack || e.reason)));
    });
}

async function loadFixture(page, name) {
    await page.evaluate(async name => {
        const blob = await (await fetch('/fixtures/' + name)).blob();
        readerTest.start = performance.now();
        await loadPDFFromFile(new File([blob], name, { type: 'application/pdf' }));
    }, name);
    await page.waitForFunction(() => readerTest.renders.some(r => r.end && r.page === 1), { timeout: 30000 });
    await page.waitForFunction(() => state.annotations[1]?.some(a => a.id === 'saved-highlight'), { timeout: 30000 });
}

async function benchmark(browser, origin, variant, name) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(origin + (variant === 'baseline' ? '/baseline' : '') + '/LOCALPdfReader.html');
    await instrument(page);
    await loadFixture(page, name);
    await page.waitForTimeout(350);
    const opened = await page.evaluate(() => {
        const r = readerTest.renders.find(r => r.end && r.page === 1);
        return { firstPageMs: r.end - readerTest.start, skeletonPixels: [...document.querySelectorAll('canvas[id^="canvas-"]')].filter(c => !readerTest.completed.has(c)).reduce((sum, c) => sum + c.width * c.height, 0) };
    });
    await page.evaluate(() => { readerTest.zoomStart = performance.now(); readerTest.clears = []; });
    for (const scale of [1.4, 2, 3, 2.6, 2, 1.2, 1]) {
        await page.evaluate(scale => updateZoom(scale), scale);
        await page.waitForTimeout(65);
    }
    await page.waitForFunction(() => {
        const c = document.getElementById('canvas-1');
        return readerTest.renders.some(r => r.start > readerTest.zoomStart && r.scale === state.scale && r.page === 1 && r.end) && c.width === Math.floor(parseFloat(c.style.width) * Math.max(devicePixelRatio, 2));
    }, { timeout: 30000 });
    await page.waitForTimeout(500);
    const zoom = await page.evaluate(() => {
        const t = readerTest, from = t.zoomStart;
        const frames = t.frames.filter(f => f.at >= from).map(f => f.ms).sort((a, b) => a - b);
        return { zoomVisibleClears: t.clears.filter(c => c.visible).length, zoomP95FrameMs: frames[Math.floor(frames.length * .95)], zoomMaxFrameMs: Math.max(...frames), zoomLongTasks: t.longTasks.filter(t => t.at >= from), zoomRenderStarts: t.renders.filter(r => r.start >= from).length };
    });
    await page.evaluate(async () => {
        readerTest.scrollStart = performance.now();
        for (let i = 0; i < 35; i++) { els.container.scrollTop += 145; await new Promise(r => setTimeout(r, 20)); }
        for (let i = 0; i < 35; i++) { els.container.scrollTop -= 145; await new Promise(r => setTimeout(r, 20)); }
    });
    await page.waitForTimeout(650);
    const scroll = await page.evaluate(() => {
        const frames = readerTest.frames.filter(f => f.at >= readerTest.scrollStart).map(f => f.ms).sort((a,b) => a-b);
        return { scrollP95FrameMs: frames[Math.floor(frames.length * .95)], scrollMaxFrameMs: Math.max(...frames), errors: readerTest.errors, finalCanvasReady: document.getElementById('canvas-1').width > 0, textSpans: document.getElementById('text-layer-1').children.length };
    });
    if (variant !== 'baseline') {
        assert.equal(zoom.zoomVisibleClears, 0, 'A readable visible canvas must never be cleared during zoom');
        assert.equal(scroll.finalCanvasReady, true, 'Return scrolling must restore a canvas');
        assert(scroll.textSpans > 0, 'Text selection layer must recover after zoom and scroll');
        assert.deepEqual(errors.concat(scroll.errors), [], 'No browser errors');
    }
    const result = { variant, fixture: name, ...opened, ...zoom, ...scroll, pageErrors: errors };
    await context.close();
    return result;
}

module.exports = { fixture, startServer, instrument, loadFixture, benchmark, root, resultsDir, deps };
if (require.main === module) (async () => {
    const mode = process.argv[2] || 'compare';
    const fixtures = { 'text.pdf': await fixture('text', 80), 'long.pdf': await fixture('text', 1000), 'mixed.pdf': await fixture('mixed', 50), 'vector.pdf': await fixture('vector', 16), 'scan.pdf': await fixture('scan', 24), 'annotated.pdf': await fixture('annotated', 80) };
    const server = await startServer(fixtures);
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const output = [];
    try {
        for (let round = 0; round < Number(process.env.READER_TEST_REPEAT || 1); round++) {
        for (const name of Object.keys(fixtures).filter(name => !process.argv[3] || name.includes(process.argv[3]))) {
            for (const variant of mode === 'compare' ? (round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) : [mode]) {
                const result = await benchmark(browser, `http://127.0.0.1:${server.address().port}`, variant, name);
                result.round = round + 1;
                output.push(result); console.log(JSON.stringify(result));
                fs.writeFileSync(path.join(resultsDir, `performance-${mode}.json`), JSON.stringify(output, null, 2));
            }
        }
        }
    } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
