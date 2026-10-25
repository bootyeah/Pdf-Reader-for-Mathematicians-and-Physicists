// 启动回归：旧版 HTML + 新版脚本不得因缺少可选目录按钮而中断初始化。
// 使用临时 PDF 与本地模拟接口，不读取用户文件。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, startServer, deps, root } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const fixtures = { 'a.pdf': await fixture('text', 6), 'b.pdf': await fixture('text', 6, 'B') };
    const server = await startServer(fixtures);
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
        const html = fs.readFileSync(path.join(root, 'static/index.html'), 'utf8');
        // 可传入旧使用版脚本做只读对照，仍由测试服务提供临时 PDF。
        const outlineSource = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : null;
        const legacyHtml = html.replace(/<button\s+id="outline-locate-current-page"[\s\S]*?<\/button>/, '');
        assert.notEqual(legacyHtml, html);
        const scenarios = [
            { name: 'Current page opens a PDF by path on startup', entry: 'path' },
            { name: 'Cached page without the new outline button still opens by path', entry: 'path', legacy: true },
            { name: 'Cached page opens a PDF through the main file loader', entry: 'file', legacy: true },
            { name: 'Cached receiver page accepts a PDF from another window', entry: 'receiver', legacy: true },
            { name: 'Delayed module loading still opens by path', entry: 'path', delay: true }
        ];
        for (const scenario of scenarios) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
            try {
                const page = await context.newPage();
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.addInitScript(() => {
                    window.startupProbe = { alerts: [], rejections: [] };
                    window.alert = message => startupProbe.alerts.push(String(message));
                    window.addEventListener('unhandledrejection', event => startupProbe.rejections.push(String(event.reason)));
                });
                if (scenario.legacy) await page.route('**/LOCALPdfReader.html*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: legacyHtml }));
                if (outlineSource || scenario.delay) await page.route('**/js/outline-search.js', async route => {
                    if (scenario.delay) await new Promise(resolve => setTimeout(resolve, 250));
                    if (outlineSource) await route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: outlineSource });
                    else await route.continue();
                });
                const localPath = 'D:\\Test PDFs\\a%20book.pdf';
                await page.route('**/api/read-file?*', route => {
                    assert.equal(new URL(route.request().url()).searchParams.get('path'), localPath);
                    return route.fulfill({ contentType: 'application/pdf', body: fixtures['a.pdf'] });
                });
                const query = scenario.entry === 'path' ? '?open=' + encodeURIComponent(localPath) : scenario.entry === 'receiver' ? '?mode=receiver&sid=12345' : '';
                await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html${query}`);
                if (scenario.entry !== 'path') await page.evaluate(async entry => {
                    const file = new File([await (await fetch('/fixtures/a.pdf')).blob()], 'a.pdf', { type: 'application/pdf' });
                    if (entry === 'receiver') window.dispatchEvent(new MessageEvent('message', { origin: location.origin, data: { type: 'TRANSFER_FILE', file } }));
                    else await loadPDFFromFile(file);
                }, scenario.entry);
                await page.waitForFunction(() => startupProbe.alerts.length || state.pagesRendered.has(1));
                const alerts = await page.evaluate(() => startupProbe.alerts);
                if (errors.length || alerts.length) console.error(JSON.stringify({ scenario: scenario.name, firstScriptError: errors[0], followupAlerts: alerts }));
                assert.deepEqual(alerts, [], scenario.name + ': no open failure');
                assert.deepEqual(errors, [], scenario.name + ': no interrupted startup scripts');
                await page.evaluate(async () => { await state.annotationsReady; });
                assert.equal(await page.evaluate(() => state.pdfDoc.numPages), 6);
                assert.equal(await page.locator('#canvas-1').evaluate(canvas => canvas.width > 0), true);
                assert.equal(await page.evaluate(() => new URL(location.href).searchParams.has('open')), false);

                // 核心搜索必须真的可用；换文档后搜索视图与旧结果都应清空。
                await page.evaluate(async () => { els.searchInput.value = 'Document A'; await executeSearch(); });
                assert.equal(await page.evaluate(() => state.searchMatches.length), 6);
                assert((await page.locator('.pdf-search-row').count()) > 0);
                await page.evaluate(async () => {
                    const file = new File([await (await fetch('/fixtures/b.pdf')).blob()], 'b.pdf', { type: 'application/pdf' });
                    await loadPDFFromFile(file);
                    await state.annotationsReady;
                });
                await page.waitForFunction(() => state.pagesRendered.has(1));
                assert.equal(await page.evaluate(() => state.fileName), 'b.pdf');
                assert.equal(await page.evaluate(() => state.searchMatches.length), 0);
                assert.equal(await page.evaluate(() => searchSidebarView), null);
                await page.evaluate(async () => { els.searchInput.value = 'Document B'; await executeSearch(); });
                assert.equal(await page.evaluate(() => state.searchMatches.length), 6);
                if (!scenario.legacy) await page.locator('#outline-locate-current-page').click({ force: true });
                assert.deepEqual(errors, []);
                assert.deepEqual(await page.evaluate(() => startupProbe.alerts.concat(startupProbe.rejections)), []);
                console.log('PASS ' + scenario.name + '; search and document switching remain usable');
            } finally { await context.close(); }
        }
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
