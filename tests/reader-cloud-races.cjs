// Queue acknowledgement and delayed document switches. All cloud responses are mocked locally.
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({});
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const context = await browser.newContext();
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        window.cloudRequests = [];
        const original = window.fetch;
        const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        window.fetch = (url, options) => {
            if (String(url).startsWith('/api/cloud-anno/status')) return Promise.resolve(response({ ok: true, configured: true, total: 0, exists: false }));
            if (url === '/api/cloud-anno') return new Promise(resolve => {
                cloudRequests.push({ payload: JSON.parse(options.body), respond: data => resolve(response(data)) });
            });
            return original(url, options);
        };
    });
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await page.waitForFunction(() => typeof CloudSync !== 'undefined');
        await page.waitForTimeout(100);
        const queue = await page.evaluate(async () => {
            const key = 'pdf_cloud_queue_v1';
            const old = { name: 'old.pdf', fingerprint: 'old', annotations: { 1: [{ id: 'old' }] }, queuedAt: 'old' };
            await localforage.setItem(key, [old]);
            const pending = CloudSync.flushQueue();
            while (cloudRequests.length < 1) await new Promise(resolve => setTimeout(resolve, 5));
            const newer = { ...old, annotations: { 1: [{ id: 'newer' }] }, queuedAt: 'newer' };
            const other = { name: 'other.pdf', fingerprint: 'other', annotations: {}, queuedAt: 'other' };
            await localforage.setItem(key, [newer, other]);
            cloudRequests[0].respond({ ok: true, timestamp: new Date().toISOString(), key: 'old_annotations.json' });
            const flushed = await pending;
            return { flushed, queue: await localforage.getItem(key) };
        });
        assert.equal(queue.flushed, false);
        assert.deepEqual(queue.queue.map(item => item.queuedAt), ['newer', 'other']);
        console.log('PASS an old cloud acknowledgement cannot delete a newer snapshot or another document queued during transfer');

        const captured = await page.evaluate(async () => {
            state.fileName = 'captured.pdf'; state.fingerprint = 'captured';
            state.annotations = { 1: [{ id: 'captured-annotation' }] };
            const before = cloudRequests.length;
            const pending = CloudSync.upload();
            state.fileName = 'next.pdf'; state.fingerprint = 'next';
            state.annotations = { 1: [{ id: 'next-annotation' }] };
            state.loadToken++; CloudSync.resetForDocument();
            while (cloudRequests.length === before) await new Promise(resolve => setTimeout(resolve, 5));
            const request = cloudRequests[before];
            request.respond({ ok: true, timestamp: new Date().toISOString(), key: 'captured_annotations.json' });
            await pending;
            return { payload: request.payload, fileName: state.fileName, phase: state.cloudSync.phase };
        });
        assert.equal(captured.payload.name, 'captured.pdf');
        assert.equal(captured.payload.annotations[1][0].id, 'captured-annotation');
        assert.equal(captured.fileName, 'next.pdf');
        assert.equal(captured.phase, 'idle');
        console.log('PASS delayed cloud uploads use their captured document and cannot change the next document status');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        assert.deepEqual(errors, []);
        console.log('PASS cloud transfer bookkeeping has no uncaught browser errors');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
