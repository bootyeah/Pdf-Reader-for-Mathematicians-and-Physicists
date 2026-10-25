// 真实 Python 阅读器服务 + 真实 Edge 缓存。临时 PDF，不启动/修改正式使用版。
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const { fixture, deps, root } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const child = spawn(process.env.READER_TEST_PYTHON || 'python', ['-u', 'tests/test_static_assets.py', '--serve-fixture'], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    const lines = createInterface({ input: child.stdout });
    const exited = new Promise(resolve => child.once('close', resolve));
    const log = [];
    child.stderr.on('data', data => log.push(String(data)));
    let browser, timer;
    try {
        const info = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Fixture timeout: ' + log.join(''))), 15000);
            lines.on('line', line => { if (line.startsWith('{')) resolve(JSON.parse(line)); });
            child.once('error', reject);
            child.once('exit', code => reject(new Error('Fixture exited: ' + code + log.join(''))));
        });
        clearTimeout(timer);
        const pdf = (await fixture('text', 6)).toString('base64');
        const control = async data => {
            const response = await fetch(info.origin + '/__cache_test/control', { method: 'POST', body: JSON.stringify(data) });
            assert(response.ok);
            return response.json();
        };
        await control({ pdf });
        browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
        await context.addInitScript(() => {
            window.resourceUpdateProbe = { alerts: [], rejections: [] };
            window.alert = message => resourceUpdateProbe.alerts.push(String(message));
            window.addEventListener('unhandledrejection', event => resourceUpdateProbe.rejections.push(String(event.reason)));
        });
        const check = async (page, version, pdfName = null) => {
            if (pdfName) await page.waitForFunction(() => document.querySelector('#viewer-container') && typeof state !== 'undefined' && state.pagesRendered.has(1));
            await page.evaluate(async () => { await state.annotationsReady; });
            const snapshot = await page.evaluate(() => ({
                js: window.readerCacheProbe,
                css: getComputedStyle(document.body).getPropertyValue('--reader-cache-probe').trim(),
                assetVersion: readerAssetVersion,
                jsUrl: document.querySelector('script[src*="__reader_cache_probe.js"]').src,
                cssUrl: document.querySelector('link[href*="__reader_cache_probe.css"]').href,
                workerAssets: window.__readerWorkerAssets,
                assetTransfer: performance.getEntriesByType('resource').filter(r => /\.(js|css)\?_readerAsset=/.test(r.name) && !/(pdf\.worker\.min|annotation-worker)\.js\?/.test(r.name)).reduce((n, r) => n + r.transferSize, 0),
                worker: pdfjsLib.GlobalWorkerOptions.workerSrc,
                name: state.fileName,
                failures: resourceUpdateProbe.alerts.concat(resourceUpdateProbe.rejections)
            }));
            assert.equal(snapshot.js, version);
            assert.equal(snapshot.css, version);
            assert.deepEqual(snapshot.failures, []);
            if (pdfName) assert.equal(snapshot.name, pdfName);
            if (version !== 'old') {
                assert.match(snapshot.assetVersion, /^[a-f0-9]{64}$/);
                assert.match(new URL(snapshot.worker).searchParams.get('_readerAsset'), /^[a-f0-9]{64}$/);
                assert.equal(new URL(snapshot.workerAssets['./lib/pdf.worker.min.js'], page.url()).href, snapshot.worker);
                assert.equal(await page.locator('#outline-locate-current-page').count(), 1);
            }
            return snapshot;
        };

        const oldPath = '/LOCALPdfReader.html?open=' + encodeURIComponent('D:\\Test PDFs\\cached.pdf');
        const oldPage = await context.newPage();
        await oldPage.goto(info.origin + oldPath);
        await check(oldPage, 'old', 'cached.pdf');
        await oldPage.evaluate(async () => {
            localStorage.setItem('reader-update-storage-probe', 'keep');
            await localforage.setItem('reader-update-storage-probe', { note: 'keep this annotation' });
        });
        await oldPage.close();
        const cachedPage = await context.newPage();
        await cachedPage.goto(info.origin + oldPath);
        await check(cachedPage, 'old', 'cached.pdf');
        assert.equal((await control({})).requests.filter(r => r.path === oldPath).length, 1, 'Legacy HTML was really cached');
        await cachedPage.close();
        console.log('PASS Upgrade fixture contains actual cached old HTML, JS, CSS and workers');

        await control({ updated: true });
        const main = await context.newPage();
        const launchUrl = info.origin + '/LOCALPdfReader.html?_readerLoad=' + randomUUID();
        const launched = await main.goto(launchUrl);
        assert.equal(launched.headers()['cache-control'], 'no-store, max-age=0');
        assert.equal((await launched.allHeaders())['clear-site-data'], '"cache"');
        const first = await check(main, 'new');
        const storage = await main.evaluate(async () => ({ local: localStorage.getItem('reader-update-storage-probe'), indexed: await localforage.getItem('reader-update-storage-probe') }));
        assert.deepEqual(storage, { local: 'keep', indexed: { note: 'keep this annotation' } });
        console.log('PASS Fresh launcher URL bypasses legacy caches and cache cleanup preserves browser annotation storage');

        const reopened = await context.newPage();
        const reopenedResponse = await reopened.goto(info.origin + oldPath);
        const reused = await check(reopened, 'new', 'cached.pdf');
        assert.equal((await reopenedResponse.allHeaders())['clear-site-data'], undefined, 'Cache migration runs once');
        assert.equal(reused.assetTransfer, 0, 'New windows reuse unchanged page JS/CSS without downloading again');
        assert((await control({})).requests.some(r => r.path === oldPath && r.updated), 'The old ?open= HTML cache was cleared');
        await reopened.close();
        console.log('PASS Previously cached PDF URLs load current HTML and reuse fingerprinted JS/CSS with zero transfer');

        const loads = [];
        for (let i = 0; i < 2; i++) {
            const [popup] = await Promise.all([
                context.waitForEvent('page'),
                main.evaluate(() => pickAndOpenFileFromFolder('D:\\Test PDFs', true))
            ]);
            const popupSnapshot = await check(popup, 'new', 'cached.pdf');
            assert.equal(popupSnapshot.assetTransfer, 0);
            loads.push(new URL(popup.url()).searchParams.get('_readerLoad'));
            await popup.close();
        }
        assert(loads.every(Boolean));
        assert.notEqual(loads[0], loads[1]);
        console.log('PASS Repeated shortcut openings use distinct fresh URLs and keep PDF path transfer intact');

        const [receiver] = await Promise.all([
            context.waitForEvent('page'),
            main.evaluate(base64 => {
                const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                return processSelectedFile(new File([bytes], 'transferred.pdf', { type: 'application/pdf' }), null, true);
            }, pdf)
        ]);
        await check(receiver, 'new', 'transferred.pdf');
        assert(new URL(receiver.url()).searchParams.get('_readerLoad'));
        await receiver.close();
        console.log('PASS Main-file new-window receiver loads current assets and receives the PDF');

        await control({ version: 'next' });
        await main.reload();
        const next = await check(main, 'next');
        assert.equal(next.assetVersion, first.assetVersion, 'Unchanged foundation keeps its fingerprint');
        assert.notEqual(next.worker, first.worker, 'Changed worker gets its own new fingerprint');
        assert.notEqual(next.jsUrl, first.jsUrl);
        assert.notEqual(next.cssUrl, first.cssUrl);
        await main.reload();
        const again = await check(main, 'next');
        assert.equal(again.jsUrl, next.jsUrl);
        assert.equal(again.cssUrl, next.cssUrl);
        assert.equal(again.assetVersion, next.assetVersion);
        assert.equal(again.worker, next.worker);
        await main.evaluate(async base64 => {
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            await loadPDFFromFile(new File([bytes], 'after-update.pdf', { type: 'application/pdf' }));
        }, pdf);
        await check(main, 'next', 'after-update.pdf');
        console.log('PASS Ordinary refreshes update only changed resource addresses and preserve unchanged fingerprints');

        const { requests } = await control({});
        for (const name of ['/lib/pdf.worker.min.js', '/js/annotation-worker.js']) {
            assert(requests.some(r => r.updated && r.path.startsWith(name + '?_readerAsset=')), 'Worker cache bypass: ' + name);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(log, []);
        console.log('PASS No startup errors, browser promise rejections or fixture errors');
    } finally {
        clearTimeout(timer);
        if (browser) await browser.close();
        child.stdin.end();
        await exited;
        lines.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
