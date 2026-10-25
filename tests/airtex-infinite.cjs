// Real mobile touch + desktop rendering; local synchronization and OCR responses only.
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
            let remote = { w: 1000, h: 700, strokes: [] }, rev = 0, clearedSeq = 0, fail = false, recognized;
            const errors = [], uploads = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.addInitScript(paragraph => {
                window.AIRTEX_PARAGRAPH = paragraph;
                window.WebSocket = class {};
                Element.prototype.requestFullscreen = () => Promise.reject(new Error('Unavailable over LAN'));
            }, paragraph);
            await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                if (url.pathname === '/api/update') {
                    if (fail) return route.abort('failed');
                    remote = route.request().postDataJSON().doc; uploads.push(structuredClone(remote)); rev++;
                }
                if (url.pathname === '/api/recognize') recognized = route.request().postDataJSON().doc;
                await route.fulfill({ json: { ok: true, accepted: true, started: true, recognizing: false, online: true, mode: 'phone', session: 'infinite-test', doc: remote, rev, clearedSeq } });
            });
            const settled = async () => { await page.waitForTimeout(240); await page.waitForFunction(() => !__airtex.dirty); };
            const camera = () => page.evaluate(() => __airtex.view);
            async function event(type, points) {
                const b = await page.locator('#board').boundingBox();
                await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y, radius = 8]) => ({ id,
                    x: b.x + b.width * x, y: b.y + b.height * y, radiusX: radius, radiusY: radius })) });
            }
            async function stroke(points, end = true) {
                for (let i = 0; i < points.length; i++) await event(i ? 'touchMove' : 'touchStart', [[1, ...points[i]]]);
                if (end) { await event('touchEnd', []); await settled(); }
            }
            async function gesture(before, after) {
                await event('touchStart', before); await event('touchMove', after); await event('touchEnd', []); await settled();
            }
            async function screenPoint(p) {
                const v = await camera(), b = await page.locator('#board').boundingBox();
                return [(p[0] - v.x) * v.scale / b.width, (p[1] - v.y) * v.scale / b.height];
            }
            await page.goto(`http://127.0.0.1:${server.address().port}/airtex/web/index.html`); await settled();
            await page.locator('#viewBtn').tap(); await settled();
            await page.locator('[data-color="#dc2626"]').tap();
            await stroke([[.22, .38], [.32, .38]]);
            await page.locator('[data-color="#2563eb"]').tap();
            await stroke([[.23, .43], [.31, .43]]);
            const original = structuredClone(remote);
            assert.equal(remote.infinite, true);
            const c0 = await camera();
            // A second finger replaces the provisional first-finger mark with navigation.
            await event('touchStart', [[1, .3, .5]]);
            await event('touchStart', [[1, .3, .5], [2, .7, .5]]);
            await event('touchMove', [[2, .8, .5], [1, .2, .5]]);
            await event('touchEnd', [[2, .8, .5]]); // Release second finger only.
            await event('touchMove', [[1, .4, .6]]);
            await event('touchEnd', []); await settled();
            assert.ok(Math.abs((await camera()).scale / c0.scale - 1.5) < .02, 'pinch scales around midpoint');
            assert.deepEqual(remote, original, 'navigation and staggered finger release never alter ink or upload');
            const beforePan = await camera();
            await gesture([[1, .25, .65], [2, .65, .65]], [[1, .4, .75], [2, .8, .75]]);
            assert.ok((await camera()).x < beforePan.x && (await camera()).y < beforePan.y, 'two fingers pan both axes');
            assert.deepEqual(remote, original);
            await page.locator('#palmGuardBtn').tap();
            const guarded = await camera();
            await gesture([[1, .35, .7], [2, .65, .7]], [[1, .25, .7], [2, .75, .7]]);
            assert.ok((await camera()).scale > guarded.scale, 'palm guard still permits two ordinary fingers');
            assert.deepEqual(remote, original);

            // Move two selected colored strokes after pinch/pan, using world-to-screen mapping.
            await page.locator('#fullscreenSelectBtn').tap();
            await page.locator('#rectSelectBtn').tap();
            const pens = original.strokes, points = pens.flatMap(s => s.p);
            const left = Math.min(...points.map(p => p[0])), right = Math.max(...points.map(p => p[0]));
            const top = Math.min(...points.map(p => p[1])), bottom = Math.max(...points.map(p => p[1]));
            // Reframe before selecting so the zoomed ink is reachable on small portrait screens.
            await page.locator('#resetViewBtn').tap();
            await stroke([await screenPoint([left - 5, top - 5]), await screenPoint([right + 5, bottom + 5])]);
            assert.equal(await page.evaluate(() => __airtex.selection), 2, 'dashed rectangle selects the whole group');
            assert.deepEqual(remote, original, 'selection overlay is never serialized as ink');
            const moveStart = [(left + right) / 2, (top + bottom) / 2];
            const moveEnd = [moveStart[0] + 25, moveStart[1] + 35];
            fail = true;
            await stroke([await screenPoint(moveStart), await screenPoint(moveEnd)], false);
            await event('touchEnd', []); await page.waitForTimeout(300);
            assert.equal(await page.evaluate(() => __airtex.dirty), true);
            assert.deepEqual(remote, original, 'failed upload preserves remote last acknowledged version');
            const selectedPoint = await screenPoint([moveEnd[0], moveEnd[1]]);
            await stroke([selectedPoint, [selectedPoint[0] + .04, selectedPoint[1] + .03]], false);
            fail = false; await page.waitForFunction(() => !__airtex.dirty);
            assert.equal(remote.strokes.length, 2);
            remote.strokes.forEach((s, i) => {
                assert.equal(s.c, original.strokes[i].c); assert.equal(s.w, original.strokes[i].w);
                s.p.forEach((p, j) => {
                    assert.ok(Math.abs(p[0] - original.strokes[i].p[j][0] - 25) < .03);
                    assert.ok(Math.abs(p[1] - original.strokes[i].p[j][1] - 35) < .03);
                });
            });
            // The retry happened during a new drag; only the previous committed move was sent.
            // Starting a two-finger gesture while moving rolls back only the provisional move.
            const moved = structuredClone(remote);
            await event('touchStart', [[1, selectedPoint[0] + .04, selectedPoint[1] + .03], [2, .8, .8]]);
            await event('touchMove', [[1, selectedPoint[0] + .06, selectedPoint[1] + .03], [2, .85, .8]]);
            await event('touchEnd', []); await settled();
            assert.deepEqual(remote, moved, 'navigation cancels an uncommitted move');
            if (process.env.READER_TEST_ARTIFACTS === '1') {
                await page.locator('#resetViewBtn').tap();
                await page.waitForTimeout(1800);
                await page.screenshot({ path: path.join(resultsDir, `airtex-selection-${paragraph ? 'whiteboard' : 'formula'}.png`) });
            }
            if (paragraph) {
                const savedView = await camera();
                await page.reload(); await settled();
                assert.deepEqual(await camera(), savedView, 'whiteboard saves its camera locally');
                await page.locator('#undoBtn').tap(); await settled();
                assert.deepEqual(remote.strokes, original.strokes, 'reload preserves move undo, not just pen undo');
                await page.locator('#nextPageBtn').tap(); await settled();
                assert.equal(remote.strokes.length, 0);
                await stroke([[.2, .4], [.35, .4]]);
                await page.locator('#prevPageBtn').tap(); await settled();
                assert.deepEqual(remote.strokes, original.strokes, 'page switching preserves independent ink');
                assert.deepEqual(await camera(), savedView, 'page switching restores the page camera');
            } else {
                await page.locator('#viewBtn').tap(); await settled();
                await page.locator('#undoBtn').tap(); await settled();
                assert.deepEqual(remote.strokes, original.strokes, 'one undo reverts the group move');
            }
            // Move the camera repeatedly; writing can cross the original bounds in both directions.
            if (await page.evaluate(() => __airtex.selecting)) await page.locator('#selectBtn').tap();
            if (!await page.evaluate(() => document.getElementById('app').classList.contains('writing-fullscreen'))) {
                await page.locator('#viewBtn').tap(); await settled();
            }
            for (let i = 0; i < 14; i++) await gesture([[1, .2, .45], [2, .55, .45]], [[1, .55, .75], [2, .9, .75]]);
            await stroke([[.2, .45], [.35, .5]]);
            assert.ok(remote.strokes.at(-1).p.every(p => p[0] < 0 && p[1] < 0), 'negative world coordinates are writable');
            for (let i = 0; i < 45; i++) await gesture([[1, .55, .75], [2, .9, .75]], [[1, .2, .45], [2, .55, .45]]);
            await stroke([[.4, .45], [.5, .5]]);
            assert.ok(remote.strokes.at(-1).p.some(p => p[0] > remote.w || p[1] > remote.h), 'ink beyond original width/height is writable');
            const distant = structuredClone(remote);
            await page.setViewportSize({ width: 844, height: 390 }); await settled();
            assert.deepEqual(remote, distant, 'rotation never rescales or moves world ink');
            await page.locator('#resetViewBtn').tap();
            await page.locator('#viewBtn').tap(); await settled();
            const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/recognize');
            await page.locator('#recognizeBtn').tap(); await response;
            assert.deepEqual(recognized, distant, 'recognition receives all world ink, with no viewport or selection overlay');

            // Render real desktop preview code in both views and inspect pixels for each color.
            await page.addScriptTag({ url: `http://127.0.0.1:${server.address().port}/js/phone-handwriting.js` });
            for (const whole of [false, true]) {
                const counts = await page.evaluate(({ board, whole }) => {
                    const preview = document.createElement('canvas');
                    preview.style.cssText = 'position:fixed;width:700px;height:320px;top:0;left:0';
                    document.body.appendChild(preview); PhoneHandwriting.draw(preview, board, whole);
                    const data = preview.getContext('2d').getImageData(0, 0, preview.width, preview.height).data;
                    let red = 0, blue = 0;
                    for (let i = 0; i < data.length; i += 4) {
                        if (data[i] > data[i + 1] + 40 && data[i] > data[i + 2] + 40) red++;
                        if (data[i + 2] > data[i] + 40 && data[i + 2] > data[i + 1] + 40) blue++;
                    }
                    preview.remove(); return { red, blue };
                }, { board: distant, whole });
                assert.ok(counts.red > 0 && counts.blue > 0, `desktop ${whole ? 'whole' : 'ink'} view includes colored ink`);
            }
            assert.ok(uploads.every(d => d.infinite && !('view' in d) && !('selection' in d)), 'view and selection never travel to desktop');
            await page.waitForFunction(() => !__airtex.busy);
            await page.locator('#viewBtn').tap(); await settled();
            // The selection tests geometry rather than only testing bounding-box overlap.
            await page.evaluate(() => __airtex.clear()); await settled();
            await stroke([[.2, .45], [.8, .45]]);
            await page.locator('#fullscreenSelectBtn').tap();
            await stroke([[.48, .42], [.52, .48]]);
            assert.equal(await page.evaluate(() => __airtex.selection), 1, 'rectangle selects a segment whose two endpoints are outside');
            await page.locator('#fullscreenSelectBtn').tap();
            await page.evaluate(() => __airtex.clear()); await settled();
            await stroke([[.1, .1], [.9, .9]]);
            await page.locator('#fullscreenSelectBtn').tap();
            await stroke([[.8, .1], [.9, .2]]);
            assert.equal(await page.evaluate(() => __airtex.selection), 0, 'empty corner of a diagonal bounding box is not selected');
            await page.locator('#fullscreenSelectBtn').tap();
            await page.evaluate(() => __airtex.clear()); await settled();
            await stroke([[.3, .45], [.6, .45]]);
            await page.locator('#fullscreenEraserBtn').tap();
            const beforeErase = structuredClone(remote);
            await event('touchStart', [[1, .3, .45]]);
            await event('touchStart', [[1, .3, .45], [2, .7, .45]]);
            await event('touchEnd', []); await settled();
            assert.deepEqual(remote, beforeErase, 'two fingers roll back provisional erasure');
            await event('touchStart', [[1, .3, .45]]);
            await page.waitForTimeout(1400);
            assert.equal(await page.evaluate(() => __airtex.strokes), 0, 'polls cannot restore the last stroke while erasure is provisional');
            await event('touchEnd', []); await settled();
            assert.equal(remote.strokes.length, 0);
            await page.locator('#viewBtn').tap(); await settled();
            await page.locator('#undoBtn').tap(); await settled();
            assert.deepEqual(remote, beforeErase, 'erasing the final stroke is undoable');
            for (const [width, height] of [[320, 568], [568, 320]]) {
                await page.setViewportSize({ width, height }); await settled();
                if (await page.evaluate(() => document.getElementById('app').classList.contains('writing-fullscreen'))) {
                    await page.locator('#viewBtn').tap(); await settled();
                }
                for (const id of ['selectBtn', 'eraserBtn', 'undoBtn', 'clearBtn', 'viewBtn']) {
                    const box = await page.locator('#' + id).boundingBox();
                    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `${id} reachable in ${width}x${height}`);
                }
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                await page.locator('#viewBtn').tap(); await settled();
                const box = await page.locator('#fullscreenSelectBtn').boundingBox();
                assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
                const lamp = await page.locator('#dot').boundingBox();
                assert.ok(box.x + box.width <= lamp.x, 'fullscreen selector and connection lamp never overlap');
            }
            if (!paragraph) {
                remote = { w: 1000, h: 700, infinite: true, strokes: [
                    { k: 'pen', w: 3, p: [[-1000000, -1000000], [-999000, -999000]] },
                    { k: 'pen', w: 3, p: [[1000000, 1000000], [1001000, 1001000]] }] };
                rev++;
                await page.reload(); await settled();
                await page.locator('#resetViewBtn').tap();
                for (const s of remote.strokes) for (const p of s.p) {
                    const [x, y] = await screenPoint(p);
                    assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, 'view-all fits extremely distant ink');
                }
                const before = await camera();
                await gesture([[1, .3, .4], [2, .6, .4]], [[1, .4, .5], [2, .7, .5]]);
                assert.ok(Math.abs((await camera()).scale / before.scale - 1) < .01, 'panning a distant overview never jumps to the normal minimum zoom');
            }
            assert.deepEqual(errors, []);
            console.log(`PASS: ${paragraph ? 'whiteboard' : 'formula'} infinite coordinates, pinch/pan, guarded touch, selection/move/undo, offline retry, rotation, desktop preview and OCR payload`);
            await context.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
