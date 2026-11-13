// E2E verification for Requirement 2: up/down collapse-direction toggle (↑↓) on all collapsible floating windows.
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, startServer, instrument, loadFixture, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

function approxEqual(actual, expected, tolerance = 1.5, label = '') {
    const diff = Math.abs(actual - expected);
    assert.ok(diff <= tolerance, `${label}: expected ${actual} to be within ${tolerance}px of ${expected} (diff=${diff.toFixed(2)})`);
}

async function readCollapseDirState(locator) {
    return locator.evaluate(group => {
        const up = group.querySelector('[data-collapse-dir="up"]');
        const down = group.querySelector('[data-collapse-dir="down"]');
        return {
            visible: getComputedStyle(group).display !== 'none' && group.getBoundingClientRect().width > 0,
            upPressed: up?.getAttribute('aria-pressed') === 'true',
            upActive: !!up?.classList.contains('is-active'),
            downPressed: down?.getAttribute('aria-pressed') === 'true',
            downActive: !!down?.classList.contains('is-active'),
            rect: group.getBoundingClientRect().toJSON()
        };
    });
}

(async () => {
    const server = await startServer({ 'a.pdf': await fixture('text', 2) });
    const browser = await chromium.launch({
        executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: true
    });
    const errors = [];
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on('pageerror', e => errors.push(String(e)));

        // Mock phone whiteboard API so Whiteboard opens offline without errors.
        await page.route('**/api/formula/**', async route => {
            const body = route.request().postDataJSON() || {};
            if (body.action === 'start') {
                return route.fulfill({
                    json: {
                        ok: true,
                        session: 'collapse-test-session',
                        connection: 'lan',
                        status: 'ready',
                        pairingRev: 1,
                        urls: ['http://127.0.0.1:8765/?t=test'],
                        qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII='
                    }
                });
            }
            return route.fulfill({
                json: {
                    ok: true,
                    pairing: { connection: 'lan', status: 'ready', pairingRev: 1, urls: ['http://127.0.0.1:8765/?t=test'], qr: '' },
                    online: false,
                    doc: { w: 1000, h: 700, strokes: [] },
                    result: null
                }
            });
        });

        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await instrument(page);
        await loadFixture(page, 'a.pdf');

        // ---------- 1. Companion PDF (#companion-pdf-panel) ----------
        await page.keyboard.press('F10');
        const cpPanel = page.locator('#companion-pdf-panel');
        await cpPanel.waitFor({ state: 'visible' });
        const cpDir = page.locator('#cp-collapse-dir-btn');

        let cpDirState = await readCollapseDirState(cpDir);
        assert.equal(cpDirState.visible, true);
        assert.equal(cpDirState.upPressed, true, 'Companion PDF defaults to ↑ pressed');
        assert.equal(cpDirState.upActive, true);
        assert.equal(cpDirState.downPressed, false);
        assert.equal(cpDirState.downActive, false);

        // Move Companion PDF to a clear mid-screen rectangle before testing.
        await page.evaluate(() => {
            const p = document.getElementById('companion-pdf-panel');
            p.style.left = '120px';
            p.style.top = '110px';
            p.style.width = '520px';
            p.style.height = '440px';
        });
        const cpExp = await cpPanel.boundingBox();
        approxEqual(cpExp.y, 110, 1.5, 'Companion initial top');
        approxEqual(cpExp.height, 440, 1.5, 'Companion initial height');

        // Default UP collapse keeps top fixed.
        await page.locator('#cp-collapse-btn').click();
        const cpUpCol = await cpPanel.boundingBox();
        approxEqual(cpUpCol.height, 40, 1.5, 'Companion UP collapsed height');
        approxEqual(cpUpCol.y, cpExp.y, 1.5, 'Companion UP collapse keeps top fixed');
        await page.locator('#cp-collapse-btn').click();
        const cpUpReexp = await cpPanel.boundingBox();
        approxEqual(cpUpReexp.y, cpExp.y, 1.5, 'Companion UP expand restores top');
        approxEqual(cpUpReexp.height, cpExp.height, 1.5, 'Companion UP expand restores height');

        // Click ↓ and verify active UI, no accidental drag/dock on double-click.
        await cpDir.locator('[data-collapse-dir="down"]').dblclick();
        cpDirState = await readCollapseDirState(cpDir);
        assert.equal(cpDirState.upPressed, false);
        assert.equal(cpDirState.upActive, false);
        assert.equal(cpDirState.downPressed, true, 'Companion PDF switches to ↓ pressed');
        assert.equal(cpDirState.downActive, true);
        assert.equal(await cpPanel.evaluate(el => el.classList.contains('cp-docked')), false, 'dblclick on ↑↓ must not dock');
        const cpAfterToggleBox = await cpPanel.boundingBox();
        approxEqual(cpAfterToggleBox.y, cpUpReexp.y, 1.5, 'clicking ↓ does not move expanded window');

        // Downward collapse keeps bottom fixed.
        await page.locator('#cp-collapse-btn').click();
        const cpDownCol = await cpPanel.boundingBox();
        approxEqual(cpDownCol.height, 40, 1.5, 'Companion DOWN collapsed height');
        approxEqual(cpDownCol.y + cpDownCol.height, cpExp.y + cpExp.height, 1.5, 'Companion DOWN collapse sticks to bottom edge');

        // Reload while DOWN-collapsed: zero drift & preserved ↓ state.
        await page.reload();
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.keyboard.press('F10');
        await cpPanel.waitFor({ state: 'visible' });
        const cpReloadCol = await cpPanel.boundingBox();
        approxEqual(cpReloadCol.height, 40, 1.5, 'Companion reload preserves collapsed height');
        approxEqual(cpReloadCol.y, cpDownCol.y, 1.5, 'Companion reload while DOWN-collapsed must not drift downward');
        cpDirState = await readCollapseDirState(cpDir);
        assert.equal(cpDirState.downPressed, true, 'Companion reload preserves ↓ state');

        // Expand after reload anchors bottom edge.
        await page.locator('#cp-collapse-btn').click();
        const cpReloadExp = await cpPanel.boundingBox();
        approxEqual(cpReloadExp.y + cpReloadExp.height, cpReloadCol.y + cpReloadCol.height, 1.5, 'Companion expand after reload anchors bottom');
        approxEqual(cpReloadExp.height, cpExp.height, 2, 'Companion expand after reload restores height');
        approxEqual(cpReloadExp.y, cpExp.y, 2, 'Companion expand after reload restores original top');

        // Drag DOWN-collapsed bar near viewport top (y=12) and expand: must clamp top >= 0.
        await page.keyboard.press('p');
        const barNearBottom = await cpPanel.boundingBox();
        const headerBox = await cpPanel.locator('.companion-pdf-header').boundingBox();
        await page.mouse.move(headerBox.x + 80, headerBox.y + 18);
        await page.mouse.down();
        await page.mouse.move(headerBox.x + 80, 12 + 18, { steps: 6 });
        await page.mouse.up();
        const barAtTop = await cpPanel.boundingBox();
        assert.ok(barAtTop.y < barNearBottom.y - 100);
        await page.keyboard.press('p');
        const clampedExpand = await cpPanel.boundingBox();
        assert.ok(clampedExpand.y >= 0, 'Expanding DOWN-collapsed bar near top clamps cleanly within viewport');

        // Docked mode + downward collapse.
        await page.locator('#cp-dock-btn').click();
        const dockedExp = await cpPanel.boundingBox();
        assert.equal(await cpPanel.evaluate(el => el.classList.contains('cp-docked')), true);
        await cpDir.locator('[data-collapse-dir="down"]').click();
        await page.locator('#cp-collapse-btn').click();
        const dockedDownCol = await cpPanel.boundingBox();
        approxEqual(dockedDownCol.height, 40, 1.5, 'Docked DOWN collapsed height');
        approxEqual(dockedDownCol.y + dockedDownCol.height, dockedExp.y + dockedExp.height, 2, 'Docked DOWN collapse anchors bottom edge');

        // Toggling ↓ -> ↑ while docked & collapsed moves bar to dock top cleanly.
        await cpDir.locator('[data-collapse-dir="up"]').click();
        const dockedUpCol = await cpPanel.boundingBox();
        approxEqual(dockedUpCol.y, dockedExp.y, 2, 'Docked toggle to ↑ moves collapsed bar to dock top');
        await page.locator('#cp-collapse-btn').click();
        await page.locator('#cp-dock-btn').click();
        await page.locator('#cp-close-btn').click();
        console.log('PASS Companion PDF ↑↓ default, up/down anchor, reload zero-drift, clamping & docked support');

        // ---------- 2. Handwriting Whiteboard (#handwriting-whiteboard) ----------
        const textTool = page.locator('button[data-tool="text"]');
        await textTool.click();
        await textTool.click();
        const wbPanel = page.locator('#handwriting-whiteboard');
        await wbPanel.waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
            const el = document.getElementById('handwriting-whiteboard');
            return el && getComputedStyle(el).transform === 'none';
        });
        const wbDir = page.locator('#whiteboard-collapse-dir');

        let wbDirState = await readCollapseDirState(wbDir);
        assert.equal(wbDirState.upPressed, true, 'Whiteboard defaults to ↑ pressed');
        assert.equal(wbDirState.downPressed, false);

        await page.evaluate(() => {
            const wb = document.getElementById('handwriting-whiteboard');
            wb.style.left = '160px';
            wb.style.top = '120px';
            wb.style.width = '760px';
            wb.style.height = '480px';
        });
        const wbExp = await wbPanel.boundingBox();

        // Upward collapse keeps top.
        await page.keyboard.press('v');
        const wbUpCol = await wbPanel.boundingBox();
        approxEqual(wbUpCol.height, 42, 1.5, 'Whiteboard UP collapsed height');
        approxEqual(wbUpCol.y, wbExp.y, 1.5, 'Whiteboard UP collapse keeps top');
        await page.keyboard.press('v');
        approxEqual((await wbPanel.boundingBox()).y, wbExp.y, 1.5, 'Whiteboard UP expand restores top');

        // Drag attempt from ↓ button shouldn't drag window, then real click switches to ↓.
        const wbDownBtn = wbDir.locator('[data-collapse-dir="down"]');
        const downBtnBox = await wbDownBtn.boundingBox();
        await page.mouse.move(downBtnBox.x + downBtnBox.width / 2, downBtnBox.y + downBtnBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(downBtnBox.x + 60, downBtnBox.y + 40);
        await page.mouse.up();
        approxEqual((await wbPanel.boundingBox()).x, wbExp.x, 1.5, 'Dragging from ↑↓ control must not drag whiteboard');
        await wbDownBtn.click();
        wbDirState = await readCollapseDirState(wbDir);
        assert.equal(wbDirState.downPressed, true, 'Whiteboard switches to ↓ pressed');

        // Downward collapse keeps bottom fixed.
        await page.locator('#whiteboard-collapse').click();
        const wbDownCol = await wbPanel.boundingBox();
        approxEqual(wbDownCol.height, 42, 1.5, 'Whiteboard DOWN collapsed height');
        approxEqual(wbDownCol.y + wbDownCol.height, wbExp.y + wbExp.height, 1.5, 'Whiteboard DOWN collapse sticks to bottom edge');

        // Toggle ↑ <-> ↓ while collapsed must NOT jump the collapsed bar; whichever is active when expanding wins.
        await wbDir.locator('[data-collapse-dir="up"]').click();
        approxEqual((await wbPanel.boundingBox()).y, wbDownCol.y, 1.5, 'Toggling direction while collapsed keeps bar stationary');
        await wbDir.locator('[data-collapse-dir="down"]').click();
        approxEqual((await wbPanel.boundingBox()).y, wbDownCol.y, 1.5, 'Toggling back to ↓ while collapsed keeps bar stationary');

        // Expand restores top & height anchoring bottom.
        await page.locator('#whiteboard-collapse').click();
        const wbReexp = await wbPanel.boundingBox();
        approxEqual(wbReexp.y, wbExp.y, 1.5, 'Whiteboard DOWN expand restores original top');
        approxEqual(wbReexp.height, wbExp.height, 1.5, 'Whiteboard DOWN expand restores original height');

        // Pure mode hides ↑↓ pill while expanded, preserves ↓ collapse behavior via V hotkey.
        await page.locator('#whiteboard-pure').click();
        assert.equal(await wbDir.isVisible(), false, 'Whiteboard pure mode hides ↑↓ control');
        await page.keyboard.press('v');
        const wbPureDown = await wbPanel.boundingBox();
        approxEqual(wbPureDown.y + wbPureDown.height, wbExp.y + wbExp.height, 1.5, 'Pure mode V collapse still anchors bottom for ↓');
        await page.keyboard.press('v');
        await page.locator('#whiteboard-pure').click();

        // Reload persists ↓ preference in Whiteboard localStorage.
        await page.reload();
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await textTool.click();
        await textTool.click();
        await wbPanel.waitFor({ state: 'visible' });
        wbDirState = await readCollapseDirState(wbDir);
        assert.equal(wbDirState.downPressed, true, 'Whiteboard reload persists ↓ direction');
        await page.locator('#whiteboard-close').click();
        console.log('PASS Whiteboard ↑↓ default, up/down anchor, pure mode, drag-guard & persistence');

        // ---------- 3. Video Player (#video-panel) ----------
        await page.keyboard.press('F9');
        const vPanel = page.locator('#video-panel');
        await vPanel.waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
            const el = document.getElementById('video-panel');
            return el && getComputedStyle(el).transform === 'none';
        });
        const vDir = page.locator('#video-collapse-dir-btn');

        let vDirState = await readCollapseDirState(vDir);
        assert.equal(vDirState.visible, true);
        assert.equal(vDirState.upPressed, true, 'Video player defaults to ↑ pressed');
        assert.equal(vDirState.downPressed, false);

        await page.evaluate(() => {
            const vp = document.getElementById('video-panel');
            vp.style.left = '220px';
            vp.style.top = '140px';
            vp.style.width = '480px';
            vp.style.height = '310px';
        });
        const vExp = await vPanel.boundingBox();

        // Default UP collapse via Shift keeps top fixed.
        await page.keyboard.press('Shift');
        const vUpCol = await vPanel.boundingBox();
        approxEqual(vUpCol.height, 38, 1.5, 'Video UP collapsed height');
        approxEqual(vUpCol.y, vExp.y, 1.5, 'Video UP collapse keeps top fixed');
        await page.keyboard.press('Shift');
        const vUpReexp = await vPanel.boundingBox();
        approxEqual(vUpReexp.y, vExp.y, 1.5, 'Video UP expand restores top');
        approxEqual(vUpReexp.height, vExp.height, 1.5, 'Video UP expand restores height');

        // Drag-guard check + real click on ↓.
        const vDownBtn = vDir.locator('[data-collapse-dir="down"]');
        const vDownBox = await vDownBtn.boundingBox();
        await page.mouse.move(vDownBox.x + vDownBox.width / 2, vDownBox.y + vDownBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(vDownBox.x + 70, vDownBox.y + 45);
        await page.mouse.up();
        approxEqual((await vPanel.boundingBox()).x, vExp.x, 1.5, 'Clicking/dragging from Video ↑↓ control must not drag window');
        await vDownBtn.click();
        vDirState = await readCollapseDirState(vDir);
        assert.equal(vDirState.downPressed, true, 'Video player switches to ↓ pressed');

        // Downward collapse keeps bottom fixed.
        await page.locator('#video-collapse-btn').click();
        const vDownCol = await vPanel.boundingBox();
        approxEqual(vDownCol.height, 38, 1.5, 'Video DOWN collapsed height');
        approxEqual(vDownCol.y + vDownCol.height, vExp.y + vExp.height, 1.5, 'Video DOWN collapse sticks to bottom edge');

        // Reload while DOWN-collapsed: zero drift & preserved ↓ state.
        await page.reload();
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.keyboard.press('F9');
        await vPanel.waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
            const el = document.getElementById('video-panel');
            return el && getComputedStyle(el).transform === 'none';
        });
        const vReloadCol = await vPanel.boundingBox();
        approxEqual(vReloadCol.height, 38, 1.5, 'Video reload preserves collapsed height');
        approxEqual(vReloadCol.y, vDownCol.y, 1.5, 'Video reload while DOWN-collapsed must not drift downward');
        vDirState = await readCollapseDirState(vDir);
        assert.equal(vDirState.downPressed, true, 'Video reload preserves ↓ state');

        // Expand after reload anchors bottom.
        await page.keyboard.press('Shift');
        const vReloadExp = await vPanel.boundingBox();
        approxEqual(vReloadExp.y + vReloadExp.height, vReloadCol.y + vReloadCol.height, 2, 'Video expand after reload anchors bottom');
        approxEqual(vReloadExp.height, vExp.height, 2, 'Video expand after reload restores height');
        approxEqual(vReloadExp.y, vExp.y, 2, 'Video expand after reload restores original top');

        // Narrow 280px video width + eye-protection mode check across all 3 windows.
        await page.evaluate(() => {
            document.body.classList.add('eye-protection-mode');
            const vp = document.getElementById('video-panel');
            vp.style.width = '280px';
            CompanionPdf.show();
        });
        await textTool.click();
        await textTool.click();
        for (const sel of ['#cp-collapse-dir-btn', '#whiteboard-collapse-dir', '#video-collapse-dir-btn']) {
            const state = await readCollapseDirState(page.locator(sel));
            assert.equal(state.visible, true, `${sel} stays visible`);
            assert.ok(state.rect.width >= 24 && state.rect.height >= 18, `${sel} keeps usable hit box at compact/eye-protection mode`);
        }

        assert.deepEqual(errors, [], 'Unexpected browser errors');
        console.log('PASS Video player ↑↓, reload zero-drift, eye-protection & compact widths');
    } finally {
        await browser.close();
        server.close();
    }
})();
