// Real browser touches: freehand/concave/self-crossing selection and existing movement/sync.
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({});
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    try {
        for (const paragraph of [false, true]) {
            const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
            const page = await context.newPage(), cdp = await context.newCDPSession(page);
            const errors = [], uploads = [];
            let doc = { w: 1000, h: 700, strokes: [] }, rev = 0, mode = 'phone';
            page.on('pageerror', e => errors.push(e.message));
            await page.addInitScript(paragraph => {
                window.AIRTEX_PARAGRAPH = paragraph;
                window.WebSocket = class {};
                Element.prototype.requestFullscreen = () => Promise.reject(new Error('LAN fullscreen unavailable'));
            }, paragraph);
            await page.route('**/api/**', async route => {
                if (new URL(route.request().url()).pathname === '/api/update') {
                    doc = route.request().postDataJSON().doc; rev++; uploads.push(structuredClone(doc));
                }
                await route.fulfill({ json: { ok: true, accepted: true, online: true, session: 'lasso-test', mode, recognizing: false, doc, rev } });
            });
            const settled = async () => { await page.waitForTimeout(240); await page.waitForFunction(() => !__airtex.dirty); };
            const selected = () => page.evaluate(() => __airtex.selection);
            async function event(type, points) {
                const b = await page.locator('#board').boundingBox();
                await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id,
                    x: b.x + b.width * x, y: b.y + b.height * y, radiusX: 8, radiusY: 8 })) });
            }
            async function trace(points, end = true) {
                for (let i = 0; i < points.length; i++) await event(i ? 'touchMove' : 'touchStart', [[1, ...points[i]]]);
                if (end) { await event('touchEnd', []); await settled(); }
            }
            async function clear() { await page.evaluate(() => __airtex.clear()); await settled(); }
            await page.goto(`http://127.0.0.1:${server.address().port}/airtex/web/index.html`); await settled();
            assert.equal(await page.evaluate(() => __airtex.selectionMode), 'lasso', 'free lasso is the initial selection mode');
            await page.locator('#viewBtn').tap(); await settled();
            for (const [color, points] of [
                ['#dc2626', [[.2, .36], [.35, .36]]],
                ['#2563eb', [[.6, .52], [.68, .52]]],
                ['#16a34a', [[.35, .7], [.7, .7]]]
            ]) { await page.locator(`[data-color="${color}"]`).tap(); await trace(points); }
            const original = structuredClone(doc);
            await page.locator('#fullscreenSelectBtn').tap();
            assert.equal(await page.locator('#lassoSelectBtn').getAttribute('aria-pressed'), 'true');
            const uploadsBefore = uploads.length;
            // An unclosed L-shaped loop excludes the stroke in its concave notch.
            await trace([[.1, .25], [.48, .25], [.48, .62], [.8, .62], [.8, .8], [.1, .8]]);
            assert.equal(await selected(), 2, 'free lasso closes automatically and respects concavity');
            assert.equal(uploads.length, uploadsBefore, 'drawing a lasso is never an ink edit');
            assert.deepEqual(doc, original);
            if (process.env.READER_TEST_ARTIFACTS === '1') {
                await page.waitForTimeout(1800);
                await page.screenshot({ path: path.join(resultsDir, `airtex-lasso-${paragraph ? 'whiteboard' : 'formula'}.png`) });
            }
            const camera = await page.evaluate(() => __airtex.view), b = await page.locator('#board').boundingBox();
            // Drag from an empty part of the polygon, not directly from an ink stroke.
            await trace([[.25, .4], [.3, .43]]);
            const dx = .05 * b.width / camera.scale, dy = .03 * b.height / camera.scale;
            for (const i of [0, 2]) doc.strokes[i].p.forEach((p, j) => {
                assert.ok(Math.abs(p[0] - original.strokes[i].p[j][0] - dx) < .03);
                assert.ok(Math.abs(p[1] - original.strokes[i].p[j][1] - dy) < .03);
            });
            assert.deepEqual(doc.strokes[1], original.strokes[1], 'unselected ink in the notch stays still');
            const moved = structuredClone(doc);
            await trace([[.3, .45], [.34, .45]], false);
            await event('touchStart', [[1, .34, .45], [2, .7, .45]]);
            await event('touchEnd', []); await settled();
            assert.deepEqual(doc, moved, 'two fingers roll back provisional lasso movement and its outline');
            // The notch is inside the group's bounding box but outside its moved lasso.
            await trace([[.545, .48], [.75, .48], [.75, .58]]);
            assert.equal(await selected(), 1, 'a new loop from the concave notch selects instead of moving the old group');
            assert.deepEqual(doc, moved);
            await page.locator('#viewBtn').tap(); await settled();
            await page.locator('#undoBtn').tap(); await settled();
            assert.deepEqual(doc, original, 'one undo restores the lasso group move');
            await page.locator('#viewBtn').tap(); await settled();
            await page.locator('#fullscreenSelectBtn').tap(); // pen mode

            await clear();
            await trace([[.2, .49], [.8, .49]]);
            await page.locator('#fullscreenSelectBtn').tap();
            await trace([[.49, .45], [.54, .52], [.46, .52]]);
            assert.equal(await selected(), 1, 'a line crossing the polygon is selected even with both endpoints outside');
            await page.locator('#fullscreenSelectBtn').tap();

            await clear();
            await trace([[.4, .42]]); await trace([[.4, .68]]); await trace([[.3, .55]]);
            const crossing = structuredClone(doc);
            await page.locator('#fullscreenSelectBtn').tap();
            await trace([[.2, .35], [.7, .75], [.2, .75], [.7, .35]]);
            assert.equal(await selected(), 2, 'self-crossing loops use the same even-odd rule as the displayed fill');
            assert.deepEqual(doc, crossing);
            // Invalid open/straight traces and tiny taps must not select ink.
            await trace([[.1, .42], [.75, .42]]);
            assert.equal(await selected(), 0, 'a straight line has no selection area');
            await trace([[.4, .42]]);
            assert.equal(await selected(), 0, 'tap alone does not select a dot');
            // A second finger cancels the provisional lasso and only changes the camera.
            await trace([[.1, .25], [.4, .25], [.4, .55]], false);
            await event('touchStart', [[1, .4, .55], [2, .7, .55]]);
            await event('touchMove', [[1, .35, .55], [2, .75, .55]]);
            await event('touchEnd', []); await settled();
            assert.equal(await selected(), 0);
            assert.deepEqual(doc, crossing, 'gesture cancellation never serializes the lasso');

            await page.locator('#rectSelectBtn').tap();
            assert.equal(await page.evaluate(() => __airtex.selectionMode), 'rect');
            await page.reload(); await settled();
            assert.equal(await page.evaluate(() => __airtex.selectionMode), 'rect', 'selection shape is remembered');
            await page.locator('#selectBtn').tap();
            await page.locator('#lassoSelectBtn').tap();
            assert.equal(await page.evaluate(() => __airtex.selectionMode), 'lasso');
            if (paragraph) {
                await page.locator('#nextPageBtn').tap(); await settled();
                await page.locator('#prevPageBtn').tap(); await settled();
                assert.deepEqual(doc.strokes, crossing.strokes, 'page turn preserves ink and discards the old selection');
                assert.equal(await selected(), 0);
            }
            for (const [width, height] of [[320, 568], [568, 320]]) {
                await page.setViewportSize({ width, height }); await settled();
                if (!await page.evaluate(() => document.getElementById('app').classList.contains('writing-fullscreen'))) {
                    await page.locator('#viewBtn').tap(); await settled();
                }
                for (const id of ['lassoSelectBtn', 'rectSelectBtn']) {
                    const box = await page.locator('#' + id).boundingBox();
                    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
                }
                await page.locator('#dot').tap();
                assert.equal(await page.locator('#selectionModes').isVisible(), false);
                await page.locator('#dot').tap();
                assert.equal(await page.locator('#selectionModes').isVisible(), true);
            }
            mode = 'pc'; await page.waitForFunction(() => __airtex.locked);
            assert.equal(await page.locator('#selectionModes').isVisible(), false);
            mode = 'phone'; await page.waitForFunction(() => !__airtex.locked);
            assert.equal(await page.evaluate(() => __airtex.selectionMode), 'lasso');
            assert.deepEqual(errors, []);
            assert.ok(uploads.every(d => !('selection' in d) && !('path' in d)), 'only ink travels to the desktop');
            console.log(`PASS: ${paragraph ? 'whiteboard' : 'formula'} free lasso, automatic closure, concavity, crossed segments, group movement/undo, gesture cancellation, shape persistence and small-screen controls`);
            await context.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
