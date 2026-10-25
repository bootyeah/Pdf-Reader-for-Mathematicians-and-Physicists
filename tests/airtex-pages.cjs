// Phone-only notebooks and desktop current-page preview, with local mock sync/OCR.
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));
(async () => {
    const server = await startServer({});
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let doc = { w: 1000, h: 700, strokes: [] }, pageId = '', result = null, rev = 0, clearedSeq = 0;
    let failUpdates = false, delay = 0, recognizing = false;
    const uploads = [], recognized = [], errors = [];
    const snapshot = () => ({ ok: true, online: true, mode: 'phone', session: 'pages-test', doc, pageId, result, recognizing, rev, seq: rev, clearedSeq });
    function recognize() {
        recognized.push(structuredClone(doc));
        result = { latex: '当前页 $x=1$', mode: 'phone', pageId }; rev++;
    }
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const phone = await context.newPage(), cdp = await context.newCDPSession(phone);
    for (const p of [desktop, phone]) p.on('pageerror', e => errors.push(e.message));
    await phone.addInitScript(() => {
        window.AIRTEX_PARAGRAPH = true; window.AIRTEX_TOKEN = 'phone-local-pages';
        window.WebSocket = class {};
        Element.prototype.requestFullscreen = () => Promise.reject(new Error('LAN browser'));
    });
    await desktop.route('**/api/formula/phone', async route => {
        const body = route.request().postDataJSON();
        if (body.action === 'start') return route.fulfill({ json: { ok: true, session: 'pages-test', urls: [origin + '/airtex/web/index.html'], qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=' } });
        if (body.action === 'recognize') recognize();
        if (body.action === 'clear') { doc = { ...doc, strokes: [] }; result = null; clearedSeq++; rev++; }
        await route.fulfill({ json: snapshot() });
    });
    await phone.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        const body = route.request().postDataJSON();
        if (pathname === '/api/update') {
            uploads.push(structuredClone(body));
            if (failUpdates) return route.abort('failed');
            if (pageId !== body.pageId) result = null;
            doc = body.doc; pageId = body.pageId; rev++;
            const ack = { ...snapshot(), accepted: true };
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            return route.fulfill({ json: ack });
        }
        if (pathname === '/api/recognize') {
            assert.equal(body.pageId, pageId);
            assert.deepEqual(body.doc, doc);
            recognize();
        }
        const data = snapshot();
        await route.fulfill({ json: pathname === '/api/hello' ? { ...data, state: data } : { ...data, started: true } });
    });
    const shortcut = repeat => desktop.evaluate(repeat => {
        const target = document.activeElement || document;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', repeat, bubbles: true, cancelable: true }));
    }, !!repeat);
    const settled = async () => { await phone.waitForTimeout(260); await phone.waitForFunction(() => !__airtex.dirty); };
    async function touch(points, end = true) {
        const box = await phone.locator('#board').boundingBox();
        for (let i = 0; i < points.length; i++) await cdp.send('Input.dispatchTouchEvent', { type: i ? 'touchMove' : 'touchStart', touchPoints: [{ id: 1, x: box.x + points[i][0] * box.width, y: box.y + points[i][1] * box.height, radiusX: 8, radiusY: 8 }] });
        if (end) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settled(); }
    }
    async function preview(expected) {
        await desktop.waitForFunction(expected => JSON.stringify(window.__previewDoc) === JSON.stringify(expected), expected);
    }
    async function page(step) { await phone.locator(step < 0 ? '#prevPageBtn' : '#nextPageBtn').tap(); await settled(); }
    try {
        await desktop.goto(origin + '/LOCALPdfReader.html');
        await desktop.waitForFunction(() => window.HandwritingWhiteboard);
        await shortcut(); assert.equal(await desktop.locator('#handwriting-whiteboard').count(), 0, 'V never creates a whiteboard');
        await desktop.evaluate(() => {
            const draw = PhoneHandwriting.draw;
            PhoneHandwriting.draw = function (canvas, board, whole) { if (canvas.id === 'whiteboard-pad') window.__previewDoc = structuredClone(board); return draw(canvas, board, whole); };
            HandwritingWhiteboard.show();
        });
        const board = desktop.locator('#handwriting-whiteboard');
        await board.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
        const before = await board.boundingBox();
        await shortcut(); assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), true);
        await shortcut(true); assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), true, 'held V does not toggle repeatedly');
        await shortcut(); assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), false);
        assert.ok(Math.abs((await board.boundingBox()).height - before.height) < 2);
        assert.equal(await desktop.locator('#whiteboard-stroke-chip, #whiteboard-stroke-count').count(), 0);
        await desktop.keyboard.press('v');
        assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), true, 'real V key folds the board');
        await desktop.keyboard.press('Shift+v');
        assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), false, 'uppercase V unfolds the board');
        for (const key of ['z', 'Control+v', 'Alt+v', 'Meta+v']) {
            await desktop.keyboard.press(key);
            assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), false, key + ' does not toggle');
        }
        await desktop.evaluate(() => HandwritingWhiteboard.setPureMode(true)); await shortcut();
        assert.equal(await desktop.evaluate(() => HandwritingWhiteboard.isPureMode()), true, 'folding retains the chosen pure-board mode');
        assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), true);
        await shortcut();
        assert.equal(await board.evaluate(el => el.classList.contains('wb-pure-mode')), true);
        await desktop.evaluate(() => HandwritingWhiteboard.setPureMode(false));

        await phone.goto(origin + '/airtex/web/index.html'); await phone.locator('#pageNav').waitFor(); await settled();
        assert.equal(await phone.locator('#pageNumber').textContent(), '1 / 1');
        assert.equal(await phone.locator('#prevPageBtn').isDisabled(), true);
        await phone.locator('#viewBtn').tap(); await settled();
        await phone.locator('[data-color="#16a34a"]').tap();
        await touch([[.2, .45], [.4, .45]]);
        assert.equal(doc.strokes[0].c, '#16a34a');
        const pageA = structuredClone(doc), idA = pageId; await preview(pageA);
        assert.ok(await desktop.locator('#whiteboard-pad').evaluate(canvas => {
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i + 1] > pixels[i] + 40 && pixels[i + 1] > pixels[i + 2] + 40) return true;
            }
            return false;
        }), 'desktop preview must render green phone ink');
        assert.equal(await desktop.locator('#whiteboard-stroke-chip, #whiteboard-stroke-count').count(), 0, 'stroke counter stays absent after writing');
        assert.equal(await desktop.locator('#whiteboard-empty-hint').isVisible(), false);
        await desktop.locator('#whiteboard-recognize').click(); await desktop.locator('#whiteboard-result').waitFor({ state: 'visible' });
        await phone.waitForFunction(() => __airtex.latex === '当前页 $x=1$');
        assert.equal(await phone.locator('#result, #copyBtn, #insertBtn, #closeResultBtn').count(), 0, 'desktop recognition must not create a phone result panel');
        await desktop.locator('#whiteboard-code').focus();
        assert.equal(await desktop.evaluate(() => document.activeElement.id), 'whiteboard-code');
        await desktop.locator('#whiteboard-code').evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
        await desktop.keyboard.press('v');
        assert.ok((await desktop.locator('#whiteboard-code').inputValue()).endsWith('v'), 'normal V typing is preserved');
        assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), false);
        await desktop.keyboard.press('Control+v');
        assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), false, 'Ctrl+V remains an editing command');
        await shortcut();
        assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), false, 'V typing in code input does not fold');
        await desktop.locator('#whiteboard-recognize').focus();
        await shortcut(); await shortcut();
        assert.equal(await board.evaluate(el => el.classList.contains('collapsed')), false, 'V works when a toolbar button has focus');
        assert.deepEqual(recognized.at(-1), pageA);
        await page(1); assert.equal(await phone.locator('#pageNumber').textContent(), '2 / 2');
        assert.equal(doc.strokes.length, 0); assert.notEqual(pageId, idA); await preview(doc);
        await desktop.locator('#whiteboard-result').waitFor({ state: 'hidden' });
        await phone.locator('[data-color="#9333ea"]').tap();
        await touch([[.6, .65], [.8, .65]]);
        assert.equal(doc.strokes[0].c, '#9333ea');
        let pageB = structuredClone(doc); await preview(pageB);
        await page(-1); assert.deepEqual(doc, pageA); await preview(pageA);
        await page(1); assert.deepEqual(doc, pageB); await preview(pageB);
        await phone.locator('#viewBtn').tap(); await settled();
        const phoneRecognitionDoc = structuredClone(doc);
        const beforeRecognition = await phone.locator('#board').boundingBox();
        await phone.locator('#recognizeBtn').tap(); await phone.waitForFunction(() => __airtex.latex === '当前页 $x=1$');
        assert.deepEqual(recognized.at(-1), phoneRecognitionDoc, 'recognition uses the current page');
        assert.equal(await phone.locator('#result, #copyBtn, #insertBtn, #closeResultBtn').count(), 0, 'phone recognition must not create a result panel');
        assert.deepEqual(await phone.locator('#board').boundingBox(), beforeRecognition, 'recognition does not resize the portrait canvas');
        await phone.locator('#viewBtn').tap(); await settled();
        pageB = structuredClone(doc);

        delay = 800;
        await phone.locator('#prevPageBtn').tap(); await phone.locator('#nextPageBtn').tap(); await settled();
        assert.deepEqual(doc, pageB, 'delayed confirmation must leave the final selected page on the desktop');
        delay = 0;
        failUpdates = true; await phone.locator('#prevPageBtn').tap(); await phone.waitForTimeout(1800);
        assert.equal(await phone.evaluate(() => __airtex.page), 1);
        failUpdates = false; await phone.waitForFunction(() => !__airtex.dirty);
        assert.deepEqual(doc, pageA, 'offline page selection retries without another pen stroke');
        await phone.reload(); await phone.locator('#pageNav').waitFor(); await settled();
        assert.equal(await phone.locator('#pageNumber').textContent(), '1 / 2'); assert.deepEqual(doc.strokes, pageA.strokes);
        await phone.locator('#viewBtn').tap(); await settled();
        await page(1); assert.deepEqual(doc.strokes, pageB.strokes);
        await desktop.locator('#whiteboard-clear').click(); await phone.waitForFunction(() => __airtex.strokes === 0);
        await page(-1); assert.deepEqual(doc.strokes, pageA.strokes, 'desktop clear only affects the selected page');
        await page(1); assert.equal(doc.strokes.length, 0);

        await phone.locator('#dot').tap();
        const foldedPage = await phone.evaluate(() => __airtex.page);
        for (const id of ['pageNav', 'prevPageBtn', 'nextPageBtn']) assert.equal(await phone.locator('#' + id).isVisible(), false, 'folding hides page navigation too');
        await phone.locator('#dot').tap();
        assert.equal(await phone.locator('#pageNav').isVisible(), true);
        assert.equal(await phone.evaluate(() => __airtex.page), foldedPage, 'folding never changes the selected page');
        await touch([[.2, .45], [.4, .45]], false);
        await phone.locator('#nextPageBtn').evaluate(el => el.click());
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settled();
        assert.equal(await phone.locator('#pageNumber').textContent(), '3 / 3'); assert.equal(doc.strokes.length, 0);
        await page(-1); assert.equal(doc.strokes.length, 1, 'page turn commits an in-progress stroke to the old page');
        await phone.locator('#fullscreenEraserBtn').tap();
        // 抬起旧页的橡皮之前，移动触点不能擦掉刚翻回来的上一页。
        await touch([[.6, .7]], false);
        await phone.locator('#prevPageBtn').evaluate(el => el.click());
        await phone.waitForTimeout(250);
        const box = await phone.locator('#board').boundingBox();
        const [x, y] = pageA.strokes[0].p[0];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: box.x + x / doc.w * box.width, y: box.y + y / doc.h * box.height }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settled();
        assert.equal(doc.strokes.length, 1, 'held eraser cannot touch the new page until lifted');
        await phone.locator('#fullscreenEraserBtn').tap();
        assert.ok(uploads.every(p => !('pages' in p) && !('redo' in p) && p.pageId && p.doc), 'uploads contain only the selected page, with no notebook/history');
        for (const [width, height] of [[320, 568], [568, 320]]) {
            await phone.setViewportSize({ width, height }); await settled();
            for (const id of ['prevPageBtn', 'nextPageBtn']) {
                const b = await phone.locator('#' + id).boundingBox();
                assert.ok(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= width && b.y + b.height <= height);
            }
        }
        if (process.env.READER_TEST_ARTIFACTS === '1') {
            await phone.waitForTimeout(1800);
            await phone.screenshot({ path: path.join(resultsDir, 'airtex-pages.png') });
        }
        await desktop.locator('#whiteboard-close').click(); await shortcut(); assert.equal(await board.isVisible(), false);
        assert.deepEqual(errors, []);
        console.log('PASS: V folding, typing/paste protection, no stroke counter; phone-only pages, current-page desktop preview/OCR, delayed/offline sync, reload, per-page clear, mid-stroke turn and small viewports');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
