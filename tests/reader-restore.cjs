const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));
(async () => {
    const server = await startServer({ 'remembered.pdf': await fixture('remembered', 60), 'other.pdf': await fixture('text', 60, 'B') });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const results = [], checks = [];
    const open = (page, name) => page.evaluate(async name => {
        const blob = await (await fetch('/fixtures/' + name)).blob();
        readerTest.start = performance.now();
        await loadPDFFromFile(new File([blob], name, { type: 'application/pdf' }));
    }, name);
    try {
        for (let round = 1; round <= 3; round++) for (const variant of round % 2 ? ['baseline', 'current'] : ['current', 'baseline']) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
            const page = await context.newPage();
            await page.goto(origin + (variant === 'baseline' ? '/baseline' : '') + '/LOCALPdfReader.html');
            await instrument(page);
            await open(page, 'remembered.pdf');
            await page.waitForFunction(() => readerTest.renders.some(r => r.page === 20 && r.end));
            const ms = await page.evaluate(() => readerTest.renders.find(r => r.page === 20 && r.end).end - readerTest.start);
            results.push({ variant, round, restoredPageMs: ms }); console.log(JSON.stringify(results.at(-1)));
            if (variant === 'current' && round === 3) {
                await page.evaluate(() => { window.originalAnnotationReader = readEmbeddedAnnotations; readEmbeddedAnnotations = async (...args) => { await new Promise(r => setTimeout(r, 450)); return originalAnnotationReader(...args); }; });
                await open(page, 'remembered.pdf');
                await page.evaluate(() => scrollPdfPageIntoView(5));
                await page.evaluate(() => state.annotationsReady);
                await page.waitForTimeout(1000);
                assert.equal(await page.evaluate(() => state.currentPhysicalPage), 5);
                checks.push('A late restore does not move a user who already scrolled');
                await page.evaluate(() => { readEmbeddedAnnotations = originalAnnotationReader; });
                await open(page, 'remembered.pdf');
                await page.evaluate(() => state.annotationsReady);
                await open(page, 'other.pdf');
                await page.evaluate(() => state.annotationsReady);
                await page.waitForTimeout(1100);
                assert.equal(await page.evaluate(() => state.currentPhysicalPage), 1);
                checks.push('Old restore timers cannot move a newly opened document');
            }
            await context.close();
        }
        fs.writeFileSync(path.join(resultsDir, 'restore.json'), JSON.stringify({ results, checks }, null, 2));
    } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
