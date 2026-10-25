const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, loadFixture, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const fixtures = { 'a.pdf': await fixture('text', 60), 'b.pdf': await fixture('text', 60, 'B'), 'mixed.pdf': await fixture('mixed', 35) };
    const server = await startServer(fixtures);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const checks = [], errors = [];
    const pass = name => { checks.push(name); console.log('PASS ' + name); };
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto(origin + '/LOCALPdfReader.html');
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => 'pdfData' in state), false);
        pass('Opening does not retain a second full PDF byte buffer');

        const slowZoom = await page.evaluate(async () => {
            const p = await state.pdfDoc.getPage(1);
            const original = p.render;
            p.render = function (options) {
                const task = original.call(this, options);
                return { promise: task.promise.then(() => new Promise(resolve => setTimeout(resolve, 550))), cancel: () => task.cancel() };
            };
            const oldCanvas = document.getElementById('canvas-1');
            const oldImage = oldCanvas.toDataURL();
            updateZoom(2);
            await new Promise(r => setTimeout(r, 420));
            const retained = document.getElementById('canvas-1') === oldCanvas && oldCanvas.toDataURL() === oldImage;
            await renderPageHighQuality(1);
            p.render = original;
            return { retained, replaced: document.getElementById('canvas-1') !== oldCanvas, scale: renderedPageScales.get(1) };
        });
        assert.deepEqual(slowZoom, { retained: true, replaced: true, scale: 2 });
        pass('Slow high quality rendering keeps the old bitmap beyond the 300ms zoom guard');

        const failure = await page.evaluate(async () => {
            const p = await state.pdfDoc.getPage(1), original = p.render;
            const old = document.getElementById('canvas-1'), image = old.toDataURL();
            p.render = () => { throw new Error('INTENTIONAL_TEST_RENDER_FAILURE'); };
            const failed = await renderPageHighQuality(1, true);
            const retained = old.isConnected && old.toDataURL() === image;
            p.render = original;
            const recovered = await renderPageHighQuality(1);
            return { failed, retained, recovered, ready: state.pagesRendered.has(1) };
        });
        assert.deepEqual(failure, { failed: false, retained: true, recovered: true, ready: true });
        pass('Render failure preserves the old image and allows a clean retry');

        await page.evaluate(async () => {
            const p = await state.pdfDoc.getPage(1), original = p.render;
            readerTest.retryAttempts = 0;
            p.render = function (...args) {
                if (++readerTest.retryAttempts === 1) throw new Error('INTENTIONAL_TRANSIENT_FAILURE');
                p.render = original;
                return original.apply(this, args);
            };
            await renderPageHighQuality(1, true);
        });
        await page.waitForFunction(() => readerTest.retryAttempts === 2 && state.pagesRendered.has(1) && !pageRenderJobs.has(1));
        pass('A transient visible-page render failure recovers automatically');

        const burst = await page.evaluate(async () => {
            readerTest.clears = [];
            const centers = [];
            for (const scale of [3, 1, 2.6, .5, 1, 5, 2, 1]) {
                updateZoom(scale);
                centers.push(els.container.scrollTop);
                await new Promise(r => setTimeout(r, 35));
            }
            await new Promise(r => setTimeout(r, 160));
            await renderPageHighQuality(1);
            return { ready: state.pagesRendered.has(1), scale: renderedPageScales.get(1), visibleClears: readerTest.clears.filter(c => c.visible).length };
        });
        assert.deepEqual(burst, { ready: true, scale: 1, visibleClears: 0 });
        pass('Rapid zoom including 50% and 500% ends at the latest scale without clearing visible canvases');

        await page.evaluate(() => { scrollPdfPageIntoView(20); });
        await page.waitForFunction(() => state.pagesRendered.has(20));
        const anchor = await page.evaluate(async () => {
            const position = () => {
                const center = els.container.scrollTop + els.container.clientHeight / 2;
                let y = 0;
                for (let i = 0; i < state.pageDimensions.length; i++) {
                    const height = state.pageDimensions[i].height * state.scale + 24;
                    if (y + height >= center) return { page: i + 1, ratio: (center - y) / height };
                    y += height;
                }
            };
            const before = position();
            for (const scale of [1.8, 3, .8, 1]) { updateZoom(scale); await new Promise(r => setTimeout(r, 45)); }
            const after = position();
            return { before, after };
        });
        assert.equal(anchor.before.page, anchor.after.page);
        assert(Math.abs(anchor.before.ratio - anchor.after.ratio) < .004);
        pass('Zoom preserves the page and relative vertical reading position');

        await page.evaluate(async () => {
            updateZoom(2.2);
            scrollPdfPageIntoView(45);
            await new Promise(r => setTimeout(r, 80));
            updateZoom(1.4);
            await new Promise(r => setTimeout(r, 80));
            scrollPdfPageIntoView(20);
        });
        await page.waitForFunction(() => state.pagesRendered.has(20) && renderedPageScales.get(20) === 1.4 && document.getElementById('text-layer-20').children.length > 0);
        await page.waitForTimeout(800);
        assert.equal(await page.evaluate(() => pageRenderJobs.size === 0 && repaintCount === 0 && repaintBytes === 0 && repaintQueue.length === 0), true);
        pass('Zoom, jump and reverse scroll recover all layers and release temporary render slots');

        // Capture a getPage result before switching documents, then let the obsolete result arrive late.
        const swapped = await page.evaluate(async () => {
            const originalDoc = state.pdfDoc, getPage = originalDoc.getPage.bind(originalDoc);
            originalDoc.getPage = async n => { const page = await getPage(n); if (n === 48) await new Promise(r => setTimeout(r, 400)); return page; };
            const pending = renderPageHighQuality(48, true);
            const file = new File([await (await fetch('/fixtures/b.pdf')).blob()], 'b.pdf', { type: 'application/pdf' });
            await loadPDFFromFile(file);
            await pending;
            await state.annotationsReady;
            await renderPageHighQuality(1);
            return { name: state.fileName, text: document.getElementById('text-layer-1').textContent, numPages: state.pdfDoc.numPages };
        });
        assert.equal(swapped.name, 'b.pdf'); assert.equal(swapped.numPages, 60); assert(swapped.text.includes('Document B'));
        pass('A delayed old-page result cannot overwrite a new document with the same page count');

        const editRecovery = await page.evaluate(async () => {
            const original = readEmbeddedAnnotations;
            readEmbeddedAnnotations = async (...args) => { await new Promise(r => setTimeout(r, 450)); return original(...args); };
            const blob = await (await fetch('/fixtures/a.pdf')).blob();
            await loadPDFFromFile(new File([blob], 'a.pdf', { type: 'application/pdf' }));
            const anno = id => ({ id, type: 'highlight', color: '#bbf7d0', rects: [{ x: .1, y: .2, w: .2, h: .02 }] });
            performAction(() => { state.annotations[1] = [anno('early-1')]; });
            performAction(() => { state.annotations[1].push(anno('early-2')); });
            await state.annotationsReady;
            const loaded = state.annotations[1].map(a => a.id).sort();
            undo(); const once = state.annotations[1].map(a => a.id).sort();
            undo(); const twice = state.annotations[1].map(a => a.id).sort();
            redo(); redo(); const redone = state.annotations[1].map(a => a.id).sort();
            readEmbeddedAnnotations = original;
            return { loaded, once, twice, redone };
        });
        assert.deepEqual(editRecovery.loaded, ['early-1', 'early-2', 'saved-highlight']);
        assert.deepEqual(editRecovery.once, ['early-1', 'saved-highlight']);
        assert.deepEqual(editRecovery.twice, ['saved-highlight']);
        assert.deepEqual(editRecovery.redone, editRecovery.loaded);
        pass('Edits made during annotation recovery survive with correct undo and redo');

        const saved = await page.evaluate(async () => {
            let savedBytes;
            state.fileHandle = { queryPermission: async () => 'granted', createWritable: async () => ({ truncate: async () => {}, write: async data => { savedBytes = data instanceof Blob ? await data.arrayBuffer() : data; }, close: async () => {} }) };
            await performSave();
            const doc = await PDFLib.PDFDocument.load(savedBytes, { ignoreEncryption: true });
            const obj = doc.getInfoDict().get(PDFLib.PDFName.of('ReaderProAnnos'));
            const bytes = new Uint8Array(obj.value.length / 2);
            for (let i = 0; i < obj.value.length; i += 2) bytes[i / 2] = parseInt(obj.value.substring(i, i + 2), 16);
            return JSON.parse(new TextDecoder().decode(bytes))[1].map(a => a.id).sort();
        });
        assert.deepEqual(saved, editRecovery.loaded);
        pass('Saving round-trips both restored and new annotations into the PDF');

        await loadFixture(page, 'mixed.pdf');
        for (const num of [6, 15, 26, 1]) {
            await page.evaluate(num => { scrollPdfPageIntoView(num); updateZoom(state.scale === 1 ? 2 : 1); }, num);
            await page.waitForFunction(num => state.pagesRendered.has(num) && renderedPageScales.get(num) === state.scale && document.getElementById(`text-layer-${num}`).children.length > 0, num);
            const size = await page.evaluate(num => {
                const c = document.getElementById(`canvas-${num}`), w = document.getElementById(`page-wrapper-${num}`);
                return { cw: c.width, expected: Math.floor(parseFloat(w.style.width) * Math.max(devicePixelRatio, 2)), textScale: Number(document.getElementById(`text-layer-${num}`).style.getPropertyValue('--scale-factor')), scale: state.scale };
            }, num);
            assert.equal(size.cw, size.expected); assert.equal(size.textScale, size.scale);
        }
        pass('Mixed portrait and landscape pages retain correct canvas and text-layer dimensions');

        await page.screenshot({ path: path.join(resultsDir, 'reader-verified.png') });
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => readerTest.errors), []);
        pass('No uncaught browser errors or unhandled promise rejections');
        fs.writeFileSync(path.join(resultsDir, 'regression.json'), JSON.stringify({ checks, errors }, null, 2));
    } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
