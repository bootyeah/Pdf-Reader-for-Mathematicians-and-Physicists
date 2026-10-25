// iPad-specific pinch-to-zoom, two-finger pan, and trackpad zoom regression test.
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({});
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    try {
        // iPad Pro 11" (834 x 1194) and iPad Pro 12.9" (1024 x 1366)
        for (const [w, h, orient] of [[1024, 768, 'landscape'], [834, 1194, 'portrait']]) {
            const context = await browser.newContext({
                viewport: { width: w, height: h },
                deviceScaleFactor: 2,
                hasTouch: true,
                userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
            });
            const page = await context.newPage();
            const cdp = await context.newCDPSession(page);
            const errors = [];
            let remoteDoc = { w: 1000, h: 700, strokes: [] }, rev = 0;
            page.on('pageerror', err => errors.push(err.message));
            await page.addInitScript(() => {
                window.WebSocket = class {};
                Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
                Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
            });
            await page.route('**/api/**', async route => {
                if (new URL(route.request().url()).pathname === '/api/update') {
                    remoteDoc = route.request().postDataJSON().doc;
                    rev++;
                }
                await route.fulfill({ json: { ok: true, accepted: true, mode: 'phone', session: 'ipad-zoom-test', online: true, doc: remoteDoc, rev } });
            });

            const settled = async () => {
                await page.waitForTimeout(200);
                await page.waitForFunction(() => !__airtex.dirty);
            };
            const camera = () => page.evaluate(() => __airtex.view);
            const zoomLevelText = () => page.locator('#zoomLevel').textContent();

            async function dispatchTouches(type, points) {
                const b = await page.locator('#board').boundingBox();
                await cdp.send('Input.dispatchTouchEvent', {
                    type,
                    touchPoints: points.map(([id, x, y, radius = 26]) => ({
                        id,
                        x: b.x + b.width * x,
                        y: b.y + b.height * y,
                        radiusX: radius,
                        radiusY: radius
                    }))
                });
            }

            await page.goto(`http://127.0.0.1:${server.address().port}/airtex/web/index.html`);
            await settled();

            assert.equal(await page.evaluate(() => __airtex.isIPad), true, 'iPad device detected');

            // 1. First write an initial stroke (e.g. with Apple Pencil or finger)
            await dispatchTouches('touchStart', [[1, .3, .3, 2]]);
            await dispatchTouches('touchMove', [[1, .4, .35, 2]]);
            await dispatchTouches('touchEnd', []);
            await settled();
            assert.equal(remoteDoc.strokes.length, 1, 'stroke committed');
            const initialInk = structuredClone(remoteDoc);

            const c0 = await camera();
            const initialZoomText = await zoomLevelText();
            assert.equal(initialZoomText, '100%', 'initial zoom is 100%');

            // 2. Perform two-finger pinch to zoom on iPad with realistic finger radius (26px)
            // Staggered landing: finger 1 touches first, finger 2 touches next
            await dispatchTouches('touchStart', [[1, .3, .5, 26]]);
            await dispatchTouches('touchStart', [[1, .3, .5, 26], [2, .7, .5, 26]]);
            // Move fingers outward to zoom in (pinch out)
            await dispatchTouches('touchMove', [[1, .2, .5, 26], [2, .8, .5, 26]]);
            // Release one finger first, then the second
            await dispatchTouches('touchEnd', [[1, .2, .5, 26]]);
            await dispatchTouches('touchEnd', []);
            await settled();

            const c1 = await camera();
            assert.ok(c1.scale > c0.scale * 1.4, `iPad pinch-to-zoom must scale camera: ${c1.scale} vs ${c0.scale}`);
            assert.deepEqual(remoteDoc, initialInk, 'zooming must not alter handwriting world ink coordinates');
            const zoomedText = await zoomLevelText();
            assert.notEqual(zoomedText, '100%', 'zoom indicator reflects zoomed state');
            assert.match(zoomedText, /\d+%/, 'zoom indicator format is valid');

            // 3. Two-finger pan on iPad
            const beforePan = await camera();
            await dispatchTouches('touchStart', [[1, .3, .5, 28], [2, .4, .5, 28]]);
            await dispatchTouches('touchMove', [[1, .5, .6, 28], [2, .6, .6, 28]]);
            await dispatchTouches('touchEnd', []);
            await settled();

            const c2 = await camera();
            assert.ok(c2.x < beforePan.x && c2.y < beforePan.y, 'two-finger pan shifts camera position');
            assert.deepEqual(remoteDoc, initialInk, 'pan must not distort ink');

            // 4. Two-finger zoom with palmGuard enabled on iPad
            await page.locator('#palmGuardBtn').tap();
            assert.equal(await page.locator('#palmGuardBtn').getAttribute('aria-pressed'), 'true');
            const beforeGuardedZoom = await camera();
            await dispatchTouches('touchStart', [[1, .25, .5, 30], [2, .75, .5, 30]]);
            await dispatchTouches('touchMove', [[1, .35, .5, 30], [2, .65, .5, 30]]);
            await dispatchTouches('touchEnd', []);
            await settled();

            const c3 = await camera();
            assert.ok(c3.scale < beforeGuardedZoom.scale, 'pinch in reduces scale even with palmGuard enabled on iPad');

            // 5. Reset view button returns camera to view all strokes
            await page.locator('#resetViewBtn').tap();
            await settled();
            const cReset = await camera();
            assert.ok(cReset.scale > 0 && Number.isFinite(cReset.x) && Number.isFinite(cReset.y));
            assert.match(await zoomLevelText(), /\d+%/, 'reset view sets valid zoom percentage');

            // 6. Magic Keyboard trackpad pinch zoom (Ctrl + wheel)
            const stageBox = await page.locator('#stage').boundingBox();
            await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
            await page.evaluate(() => {
                const stage = document.getElementById('stage');
                const wheelEvt = new WheelEvent('wheel', {
                    deltaY: -100,
                    ctrlKey: true,
                    clientX: 400,
                    clientY: 300,
                    bubbles: true,
                    cancelable: true
                });
                stage.dispatchEvent(wheelEvt);
            });
            await settled();
            const cTrackpad = await camera();
            assert.ok(cTrackpad.scale > cReset.scale, 'Magic Keyboard trackpad pinch zooms canvas');

            assert.deepEqual(errors, []);
            console.log(`PASS: iPad ${orient} (${w}x${h}) two-finger pinch-to-zoom, pan, palm guard, reset view, and trackpad zoom`);
            await context.close();
        }
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
