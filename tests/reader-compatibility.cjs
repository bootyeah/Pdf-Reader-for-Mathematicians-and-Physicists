const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, loadFixture, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));
(async () => {
    const fixtures = { 'cjk.pdf': fs.readFileSync(path.join(__dirname, 'fixtures/cjk.pdf')), 'text.pdf': await fixture('text', 40) };
    const server = await startServer(fixtures);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const checks = [], hashes = {}, errors = [];
    const pass = text => { console.log('PASS ' + text); checks.push(text); };
    try {
        for (const variant of ['baseline', 'current']) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
            const page = await context.newPage();
            page.on('pageerror', e => errors.push(String(e)));
            await page.goto(origin + (variant === 'baseline' ? '/baseline' : '') + '/LOCALPdfReader.html');
            await instrument(page);
            await page.evaluate(async () => {
                const blob = await (await fetch('/fixtures/cjk.pdf')).blob();
                await loadPDFFromFile(new File([blob], 'cjk.pdf', { type: 'application/pdf' }));
            });
            hashes[variant] = {};
            for (const scale of [1, 2, 3, .5]) {
                await page.evaluate(scale => { updateZoom(scale); els.container.scrollTop = 0; }, scale);
                await page.waitForFunction(scale => readerTest.renders.some(r => r.scale === scale && r.page === 1 && r.end) && document.getElementById('text-layer-1').textContent.includes('中文阅读测试'), scale);
                await page.waitForFunction(() => document.querySelector('#link-layer-1 a'));
                const snapshot = await page.evaluate(() => {
                    const canvas = document.getElementById('canvas-1');
                    const layer = document.getElementById('text-layer-1');
                    const link = document.querySelector('#link-layer-1 a');
                    return { image: canvas.toDataURL(), text: layer.textContent, link: [link.style.left, link.style.top, link.style.width, link.style.height] };
                });
                hashes[variant][scale] = { image: crypto.createHash('sha256').update(snapshot.image).digest('hex'), text: snapshot.text, link: snapshot.link };
            }
            if (variant === 'current') {
                await page.evaluate(() => { updateZoom(1); els.container.scrollTop = 0; });
                await page.waitForFunction(() => renderedPageScales.get(1) === 1 && document.querySelector('#link-layer-1 a'));
                await page.screenshot({ path: path.join(resultsDir, 'cjk-verified.png') });
                await page.locator('#link-layer-1 a').click();
                await page.waitForFunction(() => state.currentPhysicalPage === 2);
                pass('Native internal PDF links navigate to the correct page');
            }
            await context.close();
        }
        assert.deepEqual(hashes.current, hashes.baseline);
        pass('CJK, math, text selection content and native-link coordinates match the baseline at 50%, 100%, 200% and 300%');
        pass('Completed PDF bitmap pixel hashes exactly match the baseline at all four scales');

        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto(origin + '/LOCALPdfReader.html');
        await instrument(page);
        await page.evaluate(() => {
            const original = pdfjsLib;
            window.pdfjsLib = { ...original, getDocument(...args) {
                const task = original.getDocument(...args);
                task.promise.then(doc => {
                    const getOutline = doc.getOutline.bind(doc);
                    doc.getOutline = async () => { await new Promise(r => setTimeout(r, 1600)); readerTest.outlineFinished = true; return getOutline(); };
                });
                return task;
            } };
        });
        await loadFixture(page, 'text.pdf');
        assert.equal(await page.evaluate(() => !!readerTest.outlineFinished), false);
        pass('A delayed outline does not delay the first readable page or annotation recovery');

        await page.evaluate(() => {
            const NativeWorker = window.Worker;
            window.Worker = class extends NativeWorker { constructor(url, ...args) { if (String(url).includes('annotation-worker')) throw new Error('INTENTIONAL_WORKER_UNAVAILABLE'); super(url, ...args); } };
        });
        await loadFixture(page, 'text.pdf');
        assert.equal(await page.evaluate(() => state.annotations[1][0].id === 'saved-highlight' && !('pdfData' in state)), true);
        pass('Annotation recovery falls back correctly when its Worker cannot start');

        // A late text response from a destroyed document must not populate the new search results.
        const searchSwap = await page.evaluate(async () => {
            const oldDoc = state.pdfDoc, getPage = oldDoc.getPage.bind(oldDoc);
            oldDoc.getPage = async n => { const p = await getPage(n); await new Promise(r => setTimeout(r, 300)); return p; };
            els.searchInput.value = 'Algebra';
            const search = executeSearch();
            const blob = await (await fetch('/fixtures/cjk.pdf')).blob();
            await loadPDFFromFile(new File([blob], 'cjk.pdf', { type: 'application/pdf' }));
            await search;
            return state.searchMatches.length;
        });
        assert.equal(searchSwap, 0);
        pass('Switching documents safely cancels a pending full-text search');
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => readerTest.errors), []);
        fs.writeFileSync(path.join(resultsDir, 'compatibility.json'), JSON.stringify({ checks, hashes, errors }, null, 2));
    } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
