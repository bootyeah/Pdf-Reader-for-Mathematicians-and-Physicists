// Real mobile browser geometry/touch regression; local responses only, no OCR calls.
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({});
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const errors = [];
    let remoteDoc = { w: 1000, h: 700, strokes: [] }, rev = 0, result = null, recognizedDoc = null;
    let failUpdates = false, updateDelay = 0, remoteMode = 'phone', phoneOnline = true;
    const snapshot = () => ({ doc: remoteDoc, rev, mode: remoteMode, session: 'mobile-test', clearedSeq: 0, result, online: phoneOnline });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        // Exercise LAN browsers where native Fullscreen API is unavailable/denied.
        Element.prototype.requestFullscreen = () => Promise.reject(new Error('Fullscreen unavailable'));
        window.WebSocket = class { constructor() { this.readyState = 0; } };
        window.__clipboardWrites = 0;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            writeText: () => { window.__clipboardWrites++; return Promise.resolve(); }
        } });
        document.execCommand = command => { if (command === 'copy') window.__clipboardWrites++; return true; };
    });
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const body = route.request().postDataJSON();
        if (url.pathname === '/api/update') {
            if (failUpdates) return route.abort('failed');
            remoteDoc = body.doc; rev++;
            const ack = { ok: true, accepted: true, ...snapshot() };
            if (updateDelay) await new Promise(resolve => setTimeout(resolve, updateDelay));
            return route.fulfill({ json: ack });
        }
        if (url.pathname === '/api/recognize') {
            recognizedDoc = body.doc;
            result = { latex: '$x+y=1$', mode: 'phone', model: 'test' };
        }
        if (url.pathname === '/api/clear') { remoteDoc = { ...remoteDoc, strokes: [] }; rev++; result = null; }
        await route.fulfill({ json: { ok: true, accepted: true, started: true, ...snapshot() } });
    });
    async function geometry() {
        return page.evaluate(() => {
            const b = document.getElementById('board').getBoundingClientRect();
            const app = document.getElementById('app');
            return { x: b.x, y: b.y, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight,
                doc: __airtex.size, view: __airtex.view, full: app.classList.contains('writing-fullscreen'), strokes: __airtex.strokes,
                overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight };
        });
    }
    async function settled() {
        await page.waitForFunction(() => {
            const b = document.getElementById('board'), s = document.getElementById('stage');
            return Math.abs(b.clientWidth - s.clientWidth) < 1 && Math.abs(b.clientHeight - s.clientHeight) < 1;
        });
        await page.waitForTimeout(220); // resize frame + the app's 180 ms sync debounce
    }
    async function rotate(width, height) {
        await page.setViewportSize({ width, height });
        await settled();
    }
    async function touch(points) {
        const g = await geometry();
        for (let i = 0; i < points.length; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: i ? 'touchMove' : 'touchStart',
                touchPoints: [{ x: g.x + points[i][0] * g.w, y: g.y + points[i][1] * g.h, id: 1 }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(240);
    }
    function fills(g) {
        assert.ok(!g.overflow, 'page must not overflow the viewport');
        assert.ok(g.view.scale > 0 && Number.isFinite(g.view.x) && Number.isFinite(g.view.y), 'infinite canvas keeps a valid independent camera');
        if (g.full) {
            assert.ok(g.w >= g.vw * .99 && g.h >= g.vh * .99, `fullscreen canvas should fill viewport: ${JSON.stringify(g)}`);
        }
    }
    async function inkColors() {
        const counts = await page.locator('#board').evaluate(canvas => {
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let blue = 0, red = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i + 2] > pixels[i] + 40 && pixels[i + 2] > pixels[i + 1] + 30) blue++;
                if (pixels[i] > pixels[i + 1] + 40 && pixels[i] > pixels[i + 2] + 40) red++;
            }
            return { blue, red };
        });
        assert.ok(counts.blue > 5 && counts.red > 5, 'canvas must render both original stroke colors after redraw/rotation');
    }
    async function fullscreenTools(g) {
        for (const id of ['dot', 'palmGuardBtn', 'fullscreenSelectBtn', 'fullscreenEraserBtn', 'fullscreenClearBtn', 'viewBtn']) {
            const box = await page.locator('#' + id).boundingBox();
            assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= g.vw && box.y + box.height <= g.vh, `${id} must be reachable in fullscreen`);
        }
    }
    function contained(doc) {
        for (const s of doc.strokes) for (const [x, y] of s.p) {
            assert.ok(Number.isFinite(x) && Number.isFinite(y), 'world ink coordinates remain finite');
        }
    }
    function sameShape(before, after) {
        assert.equal(after.strokes.length, before.strokes.length, 'rotation must preserve every stroke');
        assert.deepEqual(after.strokes, before.strokes, 'resize never rewrites world ink or pen widths');
        contained(after);
    }
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/airtex/web/index.html`);
        await settled();
        fills(await geometry());
        assert.equal((await geometry()).full, false);
        await page.locator('[data-color="#2563eb"]').tap();
        await touch([[.15, .15], [.3, .25], [.4, .2]]);
        assert.equal(remoteDoc.strokes.length, 1);
        assert.equal(remoteDoc.strokes[0].c, '#2563eb');
        const portraitInk = structuredClone(remoteDoc);

        await rotate(844, 390);
        let g = await geometry();
        assert.equal(g.full, true, 'landscape should automatically enter fullscreen writing');
        fills(g);
        await fullscreenTools(g);
        const beforeCollapse = structuredClone(remoteDoc);
        await page.locator('#dot').tap();
        assert.equal(await page.locator('#dot').getAttribute('aria-expanded'), 'false');
        for (const id of ['palmGuardBtn', 'fullscreenSelectBtn', 'fullscreenEraserBtn', 'fullscreenClearBtn', 'viewBtn', 'colorPalette', 'canvasView']) assert.equal(await page.locator('#' + id).isVisible(), false);
        assert.deepEqual(await page.evaluate(() => Array.from(document.querySelector('header').children).filter(el => getComputedStyle(el).display !== 'none').map(el => el.id)), ['dot']);
        assert.equal((await geometry()).full, true);
        assert.equal((await geometry()).h, g.h);
        assert.deepEqual(remoteDoc, beforeCollapse, 'folding must not change ink or canvas coordinates');
        phoneOnline = false;
        await page.waitForFunction(() => !document.getElementById('dot').classList.contains('on'));
        assert.match(await page.locator('#dot').getAttribute('aria-label'), /展开/);
        phoneOnline = true;
        await page.waitForFunction(() => document.getElementById('dot').classList.contains('on'));
        assert.equal(await page.locator('#viewBtn').isVisible(), false, 'connection polls must not unfold the toolbar');
        if (process.env.READER_TEST_ARTIFACTS === '1') {
            await page.waitForTimeout(350); // connection-light color transition
            await page.screenshot({ path: path.join(resultsDir, 'airtex-tools-collapsed.png') });
        }
        await page.locator('#dot').tap();
        assert.equal(await page.locator('#dot').getAttribute('aria-expanded'), 'true');
        await fullscreenTools(await geometry());
        console.log('PASS: fullscreen toolbar folds to connection light; light stays live and tap restores every tool');
        sameShape(portraitInk, remoteDoc);
        const colors = await page.locator('#colorPalette button').evaluateAll(buttons => buttons.map(button => {
            const box = button.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right };
        }));
        assert.ok(colors.every((box, i) => box.x > g.vw * .9 && box.right <= g.vw && (!i || box.y > colors[i - 1].y)), 'fullscreen palette must sit vertically at the right edge');
        await page.locator('[data-color="#dc2626"]').tap();
        g = await geometry();
        await touch([[.03, .6], [.5, .6], [.97, .6]]);
        assert.deepEqual(remoteDoc.strokes.map(s => s.c), ['#2563eb', '#dc2626']);
        await inkColors();
        const edgeStroke = remoteDoc.strokes[1];
        assert.ok(Math.abs(edgeStroke.p[0][0] - (g.view.x + .03 * g.w / g.view.scale)) < .03);
        assert.ok(Math.abs(edgeStroke.p.at(-1)[0] - (g.view.x + .97 * g.w / g.view.scale)) < .03, 'right edge is writable regardless of the original board bounds');
        console.log('PASS: landscape fills viewport; real touch works across both edges; existing ink retains its shape');
        if (process.env.READER_TEST_ARTIFACTS === '1') await page.screenshot({ path: path.join(resultsDir, 'airtex-mobile-landscape.png') });

        await page.locator('#viewBtn').click();
        await settled();
        g = await geometry(); fills(g);
        assert.equal(g.full, false);
        assert.ok(g.h > g.vh * .7, 'expanded landscape tools should still leave most of the height for writing');
        for (const id of ['width', 'selectBtn', 'undoBtn', 'clearBtn', 'eraserBtn', 'recognizeBtn', 'viewBtn']) {
            const box = await page.locator('#' + id).boundingBox();
            assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= g.vw && box.y + box.height <= g.vh, `${id} should be reachable`);
        }
        await page.locator('#recognizeBtn').click();
        await page.waitForFunction(latex => __airtex.latex === latex, result.latex);
        assert.equal(await page.locator('#result, #latex, #copyBtn, #insertBtn, #closeResultBtn').count(), 0, 'phone result panel and all its controls are removed');
        assert.equal(await page.evaluate(() => __clipboardWrites), 0, 'recognition must not overwrite the phone clipboard');
        assert.equal(await page.locator('#toast').textContent(), '', 'recognition must not show a copy notification');
        assert.equal((await geometry()).h, g.h, 'recognition must keep the landscape board height');
        assert.deepEqual(recognizedDoc, remoteDoc);
        await page.locator('#viewBtn').click();
        await settled(); fills(await geometry());
        assert.equal((await geometry()).full, true, 'page fullscreen must work even if native Fullscreen API rejects');
        console.log('PASS: tools remain reachable; recognition keeps canvas height; native fullscreen fallback works');

        const landscapeInk = structuredClone(remoteDoc);
        await rotate(390, 844);
        fills(await geometry());
        assert.equal((await geometry()).full, false);
        sameShape(landscapeInk, remoteDoc);
        await rotate(844, 390);
        await page.reload(); await settled();
        assert.equal((await geometry()).strokes, 2, 'reload must restore synchronized ink');
        assert.equal(await page.locator('[data-color="#dc2626"]').getAttribute('aria-pressed'), 'true', 'reload remembers selected pen color');
        await page.locator('#resetViewBtn').tap();
        await inkColors();
        fills(await geometry()); contained(remoteDoc);

        await touch([[.25, .7], [.3, .75]]);
        await page.locator('#viewBtn').click(); await settled();
        await page.locator('#undoBtn').click();
        await page.waitForTimeout(240);
        assert.equal(remoteDoc.strokes.length, 2, 'undo must still work after rotating/reloading');
        await page.locator('#viewBtn').click(); await settled();
        const fullscreenBeforeErase = await geometry();
        await page.locator('#fullscreenEraserBtn').tap();
        assert.equal(await page.locator('#fullscreenEraserBtn').getAttribute('aria-pressed'), 'true');
        g = await geometry();
        const point = remoteDoc.strokes[0].p[0];
        await touch([[(point[0] - g.view.x) * g.view.scale / g.w, (point[1] - g.view.y) * g.view.scale / g.h]]);
        assert.equal(remoteDoc.strokes.length, 1, 'eraser must still hit transformed strokes');
        assert.equal((await geometry()).full, true, 'eraser must work without exiting fullscreen');
        assert.equal((await geometry()).h, fullscreenBeforeErase.h);
        await page.locator('#viewBtn').click(); await settled();
        assert.equal(await page.locator('#eraserBtn').getAttribute('aria-pressed'), 'true', 'both eraser controls share the same state');
        await page.locator('#eraserBtn').click();
        assert.equal(await page.locator('#fullscreenEraserBtn').getAttribute('aria-pressed'), 'false');
        await page.locator('#eraserBtn').click();
        await page.locator('[data-color="#16a34a"]').tap();
        assert.equal(await page.locator('#eraserBtn').getAttribute('aria-pressed'), 'false', 'choosing a color returns from eraser to pen');
        await page.locator('#viewBtn').click(); await settled();
        console.log('PASS: orientation round trip, reload, undo and eraser preserve synchronized ink');

        for (const [w, h] of [[667, 320], [568, 320], [926, 428], [844, 300], [844, 390]]) {
            await rotate(w, h); fills(await geometry()); contained(remoteDoc);
            await fullscreenTools(await geometry());
        }
        // A resize during a stroke commits it before the coordinate system changes.
        g = await geometry();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g.w * .4, y: g.h * .5, id: 1 }] });
        await rotate(390, 844);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await settled();
        assert.equal(remoteDoc.strokes.length, 2);
        fills(await geometry()); contained(remoteDoc);
        failUpdates = true;
        await touch([[.1, .15], [.15, .2]]);
        await touch([[.2, .15], [.25, .2]]);
        await page.waitForTimeout(1700);
        assert.equal(remoteDoc.strokes.length, 2);
        assert.equal(await page.evaluate(() => __airtex.strokes), 4);
        assert.equal(await page.evaluate(() => __airtex.dirty), true);
        failUpdates = false;
        await page.waitForFunction(() => !__airtex.dirty);
        assert.equal(remoteDoc.strokes.length, 4, 'network recovery must retry without another stroke');
        updateDelay = 1000;
        await touch([[.3, .15], [.35, .2]]);
        await touch([[.4, .15], [.45, .2]]);
        assert.equal(await page.evaluate(() => __airtex.dirty), true, 'sending is not an acknowledgement');
        await page.waitForFunction(() => !__airtex.dirty);
        assert.equal(remoteDoc.strokes.length, 6, 'late acknowledgement must not clear newer unsent edits');
        console.log('PASS: offline ink retained; automatic retry without further input; edits during delayed acknowledgement delivered');
        updateDelay = 0;
        await page.locator('#viewBtn').tap(); await settled();
        g = await geometry(); fills(g); await fullscreenTools(g);
        assert.equal(g.full, true, 'portrait also supports fullscreen tools');
        page.once('dialog', dialog => dialog.dismiss());
        await page.locator('#fullscreenClearBtn').tap();
        assert.equal((await geometry()).strokes, 6, 'cancelled fullscreen clear preserves ink');
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#fullscreenClearBtn').tap();
        await page.waitForFunction(() => !__airtex.dirty);
        assert.equal(remoteDoc.strokes.length, 0, 'fullscreen clear synchronizes the empty board');
        assert.equal((await geometry()).full, true);
        assert.equal((await geometry()).h, g.h, 'clearing must preserve the fullscreen canvas size');
        console.log('PASS: fullscreen eraser and clear share existing behavior in both orientations; phone result controls are absent');

        // The reader's independent whiteboard uses this same page in paragraph mode.
        result = null;
        await page.addInitScript(() => { window.AIRTEX_PARAGRAPH = true; });
        await page.reload(); await settled();
        await page.locator('#viewBtn').tap(); await settled();
        await fullscreenTools(await geometry());
        await touch([[.2, .4], [.4, .4]]);
        await page.locator('#fullscreenEraserBtn').tap();
        await touch([[.2, .4]]);
        assert.equal(remoteDoc.strokes.length, 0);
        await page.locator('#fullscreenEraserBtn').tap();
        await touch([[.2, .4], [.4, .4]]);
        await page.locator('#viewBtn').tap(); await settled();
        assert.equal(await page.locator('#recognizeBtn').textContent(), '识别段落');
        await page.locator('#recognizeBtn').tap();
        await page.waitForFunction(latex => __airtex.latex === latex, result.latex);
        assert.equal(await page.locator('#result, #copyBtn, #insertBtn, #closeResultBtn').count(), 0);
        assert.equal(await page.evaluate(() => __clipboardWrites), 0, 'whiteboard recognition must not overwrite the phone clipboard');
        await page.locator('#viewBtn').tap(); await settled();
        await page.locator('#fullscreenEraserBtn').tap();
        remoteMode = 'pc';
        await page.waitForFunction(() => __airtex.locked);
        assert.equal(await page.locator('#colorPalette button:disabled').count(), 6);
        for (const id of ['fullscreenEraserBtn', 'fullscreenClearBtn']) assert.equal(await page.locator('#' + id).isDisabled(), true);
        assert.equal(await page.locator('#fullscreenEraserBtn').getAttribute('aria-pressed'), 'false');
        remoteMode = 'phone';
        await page.waitForFunction(() => !__airtex.locked);
        for (const id of ['fullscreenEraserBtn', 'fullscreenClearBtn']) assert.equal(await page.locator('#' + id).isEnabled(), true);
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#fullscreenClearBtn').tap();
        await page.waitForFunction(() => !__airtex.dirty);
        assert.equal(remoteDoc.strokes.length, 0);
        assert.equal((await geometry()).full, true);
        console.log('PASS: whiteboard recognition has no phone result panel or clipboard writes; PC mode disables both tools');
        assert.deepEqual(errors, []);
        console.log('PASS: small/wide viewports and mid-stroke rotation; no browser errors');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
