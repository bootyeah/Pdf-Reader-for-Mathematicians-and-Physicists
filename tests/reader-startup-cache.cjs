// 真实浏览器缓存对照：Ctrl+F5 刷新主地址，不会更新另一个 ?open= 地址的 HTML。
// 只使用测试服务器、临时 PDF，以及作为参数只读传入的脚本。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { fixture, deps, root } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const currentHtml = fs.readFileSync(path.join(root, 'static/index.html'), 'utf8');
    const oldHtml = currentHtml.replace(/<button\s+id="outline-locate-current-page"[\s\S]*?<\/button>/, '');
    const currentScript = fs.readFileSync(process.argv[2] || path.join(root, 'static/js/outline-search.js'), 'utf8');
    const oldScript = currentScript.replace(/        const locateCurrentOutlineButton[\s\S]*?(?=        \/\/ 2\. 状态开关)/, '');
    assert.notEqual(oldScript, currentScript);
    const pdf = await fixture('text', 6);
    let updated = false;
    const htmlRequests = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/api/read-file') {
            res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(pdf);
            return;
        }
        if (url.pathname.startsWith('/api/')) {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
            return;
        }
        if (url.pathname === '/LOCALPdfReader.html') {
            htmlRequests.push({ url: req.url, updated });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }).end(updated ? currentHtml : oldHtml);
            return;
        }
        if (url.pathname === '/js/outline-search.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }).end(updated ? currentScript : oldScript);
            return;
        }
        const staticRoot = path.join(root, 'static');
        const file = path.resolve(staticRoot, '.' + decodeURIComponent(url.pathname));
        if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404).end(); return;
        }
        res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.bcmap': 'application/octet-stream' })[path.extname(file)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
        const context = await browser.newContext();
        await context.addInitScript(() => {
            window.startupProbe = { alerts: [], errors: [] };
            window.alert = message => startupProbe.alerts.push(String(message));
            window.addEventListener('error', event => startupProbe.errors.push(event.message));
        });
        const origin = `http://127.0.0.1:${server.address().port}`;
        const childPath = '/LOCALPdfReader.html?open=' + encodeURIComponent('D:\\Test PDFs\\cached.pdf');
        const main = await context.newPage();
        await main.goto(origin + '/LOCALPdfReader.html');
        const firstChild = await context.newPage();
        await firstChild.goto(origin + childPath);
        await firstChild.waitForFunction(() => state.pagesRendered.has(1));
        assert.deepEqual(await firstChild.evaluate(() => startupProbe), { alerts: [], errors: [] });
        await firstChild.close();

        updated = true;
        const cdp = await context.newCDPSession(main);
        await Promise.all([main.waitForNavigation(), cdp.send('Page.reload', { ignoreCache: true })]);
        assert.equal(await main.locator('#outline-locate-current-page').count(), 1);
        assert.deepEqual(await main.evaluate(() => startupProbe), { alerts: [], errors: [] });

        const reopened = await context.newPage();
        await reopened.goto(origin + childPath);
        await reopened.waitForFunction(() => startupProbe.alerts.length || state.pagesRendered.has(1));
        assert.equal(await reopened.locator('#outline-locate-current-page').count(), 0, 'New tab still has cached old HTML');
        assert.equal(htmlRequests.filter(r => r.url === childPath).length, 1, 'Hard reloading the main URL did not fetch the child URL again');
        const result = await reopened.evaluate(() => startupProbe);
        if (process.argv[2]) {
            assert(result.errors.some(e => e.includes("null") && e.includes('addEventListener')));
            assert(result.alerts.some(e => e.includes("Cannot access 'searchSidebarView' before initialization")));
            console.log('REPRODUCED ' + JSON.stringify(result));
        } else {
            assert.deepEqual(result, { alerts: [], errors: [] });
            await reopened.evaluate(async () => { await state.annotationsReady; });
            assert.equal(await reopened.evaluate(() => state.pdfDoc.numPages), 6);
            console.log('PASS Harness fix opens the PDF despite cached child HTML after a main-window hard reload');
        }
        console.log('PASS Main URL has the new outline button, reopened child URL still has old HTML; distinct URL caches verified');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
