// Phone: the draggable palm-rest bar is available only in fullscreen landscape writing.
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({});
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
        const errors = [];
        let doc = { w: 1000, h: 700, strokes: [] }, rev = 0;
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(() => {
            window.WebSocket = class {};
            Element.prototype.requestFullscreen = () => Promise.reject(new Error('LAN fullscreen unavailable'));
        });
        await page.route('**/api/**', async route => {
            if (new URL(route.request().url()).pathname === '/api/update') { doc = route.request().postDataJSON().doc; rev++; }
            await route.fulfill({ json: { ok: true, accepted: true, mode: 'phone', session: 'rest-test', online: true, doc, rev } });
        });
        const settled = async () => { await page.waitForTimeout(260); await page.waitForFunction(() => !__airtex.dirty); };
        const hidden = () => page.evaluate(() => document.getElementById('palmRest').hidden);
        const count = () => page.evaluate(() => __airtex.strokes);
        async function stroke(y) {
            const box = await page.locator('#board').boundingBox();
            const pt = x => [{ id: 1, x: box.x + box.width * x, y: box.y + box.height * y, radiusX: 1, radiusY: 1 }];
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(.2) });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(.4) });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await settled();
        }

        await page.goto(`http://127.0.0.1:${server.address().port}/airtex/web/index.html`);
        await settled();
        await page.locator('#palmGuardBtn').tap();
        assert.equal(await page.evaluate(() => __airtex.palmGuard), true);
        assert.equal(await hidden(), true, 'portrait phone keeps the original guard without palm rest');

        await page.setViewportSize({ width: 844, height: 390 }); await settled();
        assert.equal(await page.evaluate(() => document.getElementById('app').classList.contains('writing-fullscreen')), true);
        assert.equal(await hidden(), false, 'fullscreen landscape phone shows the palm rest');
        const h = await page.evaluate(() => __airtex.palmRest.height);
        assert.ok(h > 0, 'palm rest has height');

        const before = await count();
        await stroke(.95);
        assert.equal(await count(), before, 'touch inside palm rest cannot write');
        await stroke(.3);
        assert.equal(await count(), before + 1, 'touch above palm rest writes');

        // Palm resting on the bar must not block writing above it.
        {
            const box = await page.locator('#board').boundingBox();
            const P = (id, x, y, r = 1) => ({ id, x: box.x + box.width * x, y: box.y + box.height * y, radiusX: r, radiusY: r });
            const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
            const palm = P(2, .6, .95, 12);
            await send('touchStart', [palm]);
            const c0 = await count();
            await send('touchStart', [palm, P(1, .2, .3)]);
            await send('touchMove', [palm, P(1, .4, .3)]);
            await send('touchEnd', [P(1, .4, .3)]); await settled();
            assert.equal(await count(), c0 + 1, 'writing works while palm rests on the bar');
            // A second stroke with the palm still down.
            await send('touchStart', [palm, P(3, .2, .4)]);
            await send('touchMove', [palm, P(3, .4, .4)]);
            await send('touchEnd', [P(3, .4, .4)]); await settled();
            assert.equal(await count(), c0 + 2, 'consecutive strokes work while palm rests');
            // Pinch with two fingers, then write again — palm still down.
            await send('touchStart', [palm, P(4, .3, .3), P(5, .5, .3)]);
            await send('touchMove', [palm, P(4, .28, .3), P(5, .52, .3)]);
            await send('touchEnd', [P(4, .28, .3), P(5, .52, .3)]); await settled();
            await send('touchStart', [palm, P(6, .2, .35)]);
            await send('touchMove', [palm, P(6, .4, .35)]);
            await send('touchEnd', [P(6, .4, .35)]); await settled();
            assert.equal(await count(), c0 + 3, 'writing resumes after pinch while palm rests');
            await send('touchEnd', []); await settled();
        }

        // Drag the divider up by 40px.
        const d = await page.locator('#palmRestDivider').boundingBox();
        const cx = d.x + d.width / 2, cy = d.y + d.height / 2;
        await page.mouse.move(cx, cy); await page.mouse.down();
        await page.mouse.move(cx, cy - 40, { steps: 4 }); await page.mouse.up();
        const h2 = await page.evaluate(() => __airtex.palmRest.height);
        assert.ok(Math.abs(h2 - (h + 40)) <= 2, `drag adjusts height: ${h} -> ${h2}`);

        // Leaving fullscreen (显示工具) in landscape hides it.
        await page.locator('#viewBtn').tap(); await settled();
        assert.equal(await hidden(), true, 'non-fullscreen landscape phone hides palm rest');
        await page.locator('#viewBtn').tap(); await settled();
        assert.equal(await hidden(), false);

        // Turning guard off hides it.
        await page.locator('#palmGuardBtn').tap();
        assert.equal(await hidden(), true, 'guard off hides palm rest');
        await page.locator('#palmGuardBtn').tap();
        assert.equal(await hidden(), false);

        await page.setViewportSize({ width: 390, height: 844 }); await settled();
        assert.equal(await hidden(), true, 'rotating back to portrait hides palm rest');
        assert.deepEqual(errors, []);
        console.log('PASS: phone palm rest only in fullscreen landscape; blocks ink; draggable; toggles correctly');
        await context.close();
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
