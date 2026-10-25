// Real browser touch identities/contact radii, with local sync responses only.
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
            const errors = [];
            let doc = { w: 1000, h: 700, strokes: [] }, rev = 0;
            page.on('pageerror', e => errors.push(e.message));
            await page.addInitScript(paragraph => {
                window.AIRTEX_PARAGRAPH = paragraph;
                window.WebSocket = class {};
                Element.prototype.requestFullscreen = () => Promise.reject(new Error('LAN fullscreen unavailable'));
            }, paragraph);
            await page.route('**/api/**', async route => {
                if (new URL(route.request().url()).pathname === '/api/update') {
                    doc = route.request().postDataJSON().doc; rev++;
                }
                await route.fulfill({ json: { ok: true, accepted: true, mode: 'phone', session: 'guard-test', online: true, doc, rev } });
            });
            const count = () => page.evaluate(() => __airtex.strokes);
            const settled = async () => { await page.waitForTimeout(260); await page.waitForFunction(() => !__airtex.dirty); };
            async function event(type, points) {
                const box = await page.locator('#board').boundingBox();
                await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y, radius = 1]) => ({ id,
                    x: box.x + box.width * x, y: box.y + box.height * y, radiusX: radius, radiusY: radius })) });
            }
            async function worldEvent(type, points) {
                const v = await page.evaluate(() => __airtex.view), b = await page.locator('#board').boundingBox();
                await event(type, points.map(([id, x, y, radius]) => [id, (x - v.x) * v.scale / b.width, (y - v.y) * v.scale / b.height, radius]));
            }
            async function stroke(radius) {
                await event('touchStart', [[1, .2, .45, radius]]);
                await event('touchMove', [[1, .4, .45, radius]]);
                await event('touchEnd', []); await settled();
            }
            const clear = async () => { await page.evaluate(() => __airtex.clear()); await settled(); };
            await page.goto(`http://127.0.0.1:${server.address().port}/airtex/web/index.html`);
            await settled();
            assert.equal(await page.evaluate(() => __airtex.palmGuard), false);
            await stroke(30);
            assert.equal(await count(), 1, 'default off preserves ordinary writing');
            await clear();
            await page.locator('#palmGuardBtn').tap();
            assert.equal(await page.locator('#palmGuardBtn').getAttribute('aria-pressed'), 'true');
            await stroke(30);
            assert.equal(await count(), 0, 'large contact cannot create ink or synthetic mouse ink');
            await stroke(8);
            assert.equal(doc.strokes.length, 1, 'small capacitive contact still writes and synchronizes');
            await stroke();
            assert.equal(doc.strokes.length, 2, 'missing/default contact size still permits writing');
            await clear();

            // A rejected palm can remain down while a newly placed small contact writes.
            await event('touchStart', [[1, .7, .7, 30]]);
            await event('touchStart', [[1, .7, .7, 30], [2, .2, .45, 8]]);
            await event('touchMove', [[1, .7, .7, 30], [2, .4, .45, 8]]);
            await event('touchEnd', [[2, .4, .45, 8]]); // CDP lists the released contacts here.
            await settled();
            assert.equal(doc.strokes.length, 1, 'pen can finish while the rejected palm stays down');
            assert.ok(doc.strokes[0].p.every(p => Math.abs(p[1] / doc.h - .45) < .01), 'palm coordinates never join pen ink');
            await event('touchMove', [[1, .6, .65, 30]]);
            await event('touchEnd', []); await settled();
            assert.equal(doc.strokes.length, 1);
            await clear();

            // Lifting a later rejected palm must not end the active pen stroke.
            await event('touchStart', [[1, .2, .45, 8]]);
            await event('touchStart', [[1, .2, .45, 8], [2, .7, .7, 30]]);
            await event('touchMove', [[2, .8, .8, 30], [1, .3, .45, 8]]);
            await event('touchEnd', [[2, .8, .8, 30]]);
            assert.equal(await count(), 0, 'unrelated finger lifting does not commit the pen');
            await event('touchMove', [[1, .5, .45, 8]]);
            await event('touchEnd', []); await settled();
            assert.equal(doc.strokes.length, 1);
            assert.ok(doc.strokes[0].p.every(p => Math.abs(p[1] / doc.h - .45) < .01));
            assert.ok(Math.abs(doc.strokes[0].p.at(-1)[0] / doc.w - .5) < .01, 'pen continues after the other finger lifts');

            // Contact that grows into a palm discards its provisional ink.
            await event('touchStart', [[1, .2, .65, 8]]);
            await event('touchMove', [[1, .3, .65, 8]]);
            await event('touchMove', [[1, .4, .65, 30]]);
            await event('touchMove', [[1, .5, .65, 8]]);
            await event('touchEnd', []); await settled();
            assert.equal(doc.strokes.length, 1, 'growing palm is discarded and cannot resume until it lifts');

            await page.locator('#viewBtn').tap(); await settled();
            await page.locator('#fullscreenEraserBtn').tap();
            const [inkX, inkY] = doc.strokes[0].p[0];
            await worldEvent('touchStart', [[1, inkX, inkY, 30]]);
            await event('touchEnd', []); await settled();
            assert.equal(doc.strokes.length, 1, 'palm must not erase ink');
            await worldEvent('touchStart', [[1, inkX, inkY, 8]]);
            await worldEvent('touchMove', [[1, inkX + 10, inkY, 30]]);
            await event('touchEnd', []); await settled();
            assert.equal(doc.strokes.length, 1, 'a growing palm restores any provisional erasure');
            await worldEvent('touchStart', [[1, inkX, inkY, 8]]);
            await event('touchEnd', []); await settled();
            assert.equal(doc.strokes.length, 0, 'intentional small contact still erases');
            await page.locator('#fullscreenEraserBtn').tap();

            // Toggling during a stroke commits once and does not join to subsequent movement.
            await event('touchStart', [[1, .2, .45, 8]]);
            await event('touchMove', [[1, .3, .45, 8]]);
            await page.locator('#palmGuardBtn').evaluate(el => el.click());
            await event('touchMove', [[1, .6, .65, 8]]);
            await event('touchEnd', []); await settled();
            assert.equal(doc.strokes.length, 1);
            assert.ok(doc.strokes[0].p.every(p => Math.abs(p[1] - doc.strokes[0].p[0][1]) < .03));
            await stroke(30);
            assert.equal(doc.strokes.length, 2, 'turning the guard off restores unfiltered input');
            await page.locator('#palmGuardBtn').tap();
            await page.reload(); await settled();
            assert.equal(await page.evaluate(() => __airtex.palmGuard), true, 'choice survives reload');
            assert.equal(await page.locator('#palmGuardBtn').getAttribute('aria-pressed'), 'true');

            const beforeRotation = await count();
            await event('touchStart', [[1, .2, .45, 8]]);
            await event('touchMove', [[1, .3, .45, 8]]);
            await page.setViewportSize({ width: 844, height: 390 }); await settled();
            await event('touchEnd', []); await settled();
            assert.equal(await count(), beforeRotation + 1, 'mid-stroke rotation commits the active pen once');
            await stroke(8);
            assert.equal(await count(), beforeRotation + 2, 'a fresh pen contact works after mid-stroke rotation');

            for (const [width, height] of [[320, 568], [568, 320], [844, 390]]) {
                await page.setViewportSize({ width, height }); await settled();
                if (!await page.evaluate(() => document.getElementById('app').classList.contains('writing-fullscreen'))) {
                    await page.locator('#viewBtn').tap(); await settled();
                }
                const box = await page.locator('#palmGuardBtn').boundingBox();
                assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                const beforeFold = await count();
                await page.locator('#dot').tap();
                assert.equal(await page.locator('#viewBtn').isVisible(), false);
                assert.equal(await page.locator('#palmGuardBtn').isVisible(), false);
                if (paragraph) assert.equal(await page.locator('#pageNav').isVisible(), false);
                const lamp = await page.locator('#dot').boundingBox();
                assert.ok(lamp && lamp.width >= 44 && lamp.height >= 44 && lamp.x >= 0 && lamp.y >= 0 && lamp.x + lamp.width <= width && lamp.y + lamp.height <= height, `collapsed light must stay reachable: ${JSON.stringify({ lamp, width, height })}`);
                await stroke(8);
                assert.equal(await count(), beforeFold + 1, 'folded tools must not interrupt handwriting or palm guard');
                assert.equal(await page.evaluate(() => __airtex.palmGuard), true);
                await page.locator('#dot').tap();
                assert.equal(await page.locator('#palmGuardBtn').getAttribute('aria-pressed'), 'true');
                assert.equal(await page.locator('#viewBtn').isVisible(), true);
                if (paragraph) assert.equal(await page.locator('#pageNav').isVisible(), true);
            }
            if (process.env.READER_TEST_ARTIFACTS === '1') {
                await page.waitForTimeout(1800);
                await page.screenshot({ path: path.join(resultsDir, `airtex-palm-guard-${paragraph ? 'whiteboard' : 'formula'}.png`) });
            }
            assert.deepEqual(errors, []);
            console.log(`PASS: ${paragraph ? 'whiteboard' : 'formula'} palm guard: contact size, touch identity, lift order, eraser, toggle, persistence and fullscreen geometry`);
            await context.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
