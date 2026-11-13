// E2E verification: floating windows dragged to the bottom stay anchored to the bottom when entering/exiting fullscreen (or resizing viewport).
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, startServer, instrument, loadFixture, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

function approxEqual(actual, expected, tolerance = 2, label = '') {
    const diff = Math.abs(actual - expected);
    assert.ok(diff <= tolerance, `${label}: expected ${actual} within ${tolerance}px of ${expected} (diff=${diff.toFixed(2)})`);
}

async function waitSettled(page, id) {
    await page.waitForFunction((elId) => {
        const el = document.getElementById(elId);
        return el && getComputedStyle(el).transform === 'none';
    }, id);
}

async function dragTitle(page, locator, dx, dy) {
    const box = await locator.boundingBox();
    assert.ok(box, 'Drag target must have a bounding box');
    const sx = box.x + Math.min(box.width / 2, 60);
    const sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + dx, sy + dy, { steps: 8 });
    await page.mouse.up();
}

(async () => {
    const server = await startServer({ 'a.pdf': await fixture('text', 2) });
    const browser = await chromium.launch({
        executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: true
    });
    const errors = [];
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 820 } });
        page.on('pageerror', e => errors.push(String(e)));

        // Mock whiteboard pairing & dictionary API so both panels work offline cleanly.
        await page.route('**/api/formula/**', async route => {
            const body = route.request().postDataJSON() || {};
            if (body.action === 'start') {
                return route.fulfill({
                    json: {
                        ok: true,
                        session: 'bottom-anchor-session',
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
        await page.route('**/api/translate', async route => {
            return route.fulfill({
                json: { ok: true, kind: 'word', content: JSON.stringify({ word: 'theorem', phonetic: '', mean: '定理' }) }
            });
        });

        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await instrument(page);
        await loadFixture(page, 'a.pdf');

        // ---------- 1. Video (#video-panel), Companion PDF (#companion-pdf-panel), Whiteboard (#handwriting-whiteboard), Chat (#ds-chat-panel) ----------
        // Open Video (dragged to bottom), Companion (collapsed bar dragged to bottom), Chat (dragged to bottom), Whiteboard (kept at top/middle as control).
        await page.keyboard.press('F9');
        const vPanel = page.locator('#video-panel');
        await vPanel.waitFor({ state: 'visible' });
        await page.waitForFunction(() => getComputedStyle(document.getElementById('video-panel')).transform === 'none');
        await page.evaluate(() => {
            const vp = document.getElementById('video-panel');
            vp.style.left = '40px';
            vp.style.top = '180px';
            vp.style.width = '400px';
            vp.style.height = '260px';
        });
        const vBefore = await vPanel.boundingBox();
        await dragTitle(page, page.locator('#video-panel-title'), 0, (820 - 8) - (vBefore.y + vBefore.height));
        const vAtBottom = await vPanel.boundingBox();
        approxEqual(vAtBottom.y + vAtBottom.height, 812, 3, 'Video dragged to bottom of 820px viewport');

        await page.keyboard.press('F10');
        const cpPanel = page.locator('#companion-pdf-panel');
        await cpPanel.waitFor({ state: 'visible' });
        await page.locator('#cp-collapse-btn').click();
        const cpBarStart = await cpPanel.boundingBox();
        await dragTitle(page, page.locator('#companion-pdf-title'), 0, (820 - 8) - (cpBarStart.y + cpBarStart.height));
        const cpAtBottom = await cpPanel.boundingBox();
        approxEqual(cpAtBottom.y + cpAtBottom.height, 812, 3, 'Collapsed Companion PDF dragged to bottom of 820px viewport');

        await page.locator('#deepseek-chat-btn').click();
        const chatPanel = page.locator('#ds-chat-panel');
        await chatPanel.waitFor({ state: 'visible' });
        await waitSettled(page, 'ds-chat-panel');
        await page.evaluate(() => {
            const cp = document.getElementById('ds-chat-panel');
            cp.style.left = '940px';
            cp.style.top = '140px';
            cp.style.width = '360px';
            cp.style.height = '320px';
        });
        const chatStart = await chatPanel.boundingBox();
        await dragTitle(page, page.locator('.ds-chat-header .ds-chat-brand'), 0, (820 - 8) - (chatStart.y + chatStart.height));
        const chatAtBottom = await chatPanel.boundingBox();
        approxEqual(chatAtBottom.y + chatAtBottom.height, 812, 3, 'Chat panel dragged to bottom of 820px viewport');

        // Whiteboard stays in middle (NOT dragged to bottom) as negative control.
        const textTool = page.locator('button[data-tool="text"]');
        await textTool.click();
        await textTool.click();
        const wbPanel = page.locator('#handwriting-whiteboard');
        await wbPanel.waitFor({ state: 'visible' });
        await page.waitForFunction(() => getComputedStyle(document.getElementById('handwriting-whiteboard')).transform === 'none');
        await page.evaluate(() => {
            const wb = document.getElementById('handwriting-whiteboard');
            wb.style.left = '480px';
            wb.style.top = '140px';
            wb.style.width = '420px';
            wb.style.height = '300px';
        });
        const wbMid = await wbPanel.boundingBox();

        // Simulate entering fullscreen: viewport grows 820 -> 1080 (+260px).
        await page.setViewportSize({ width: 1440, height: 1080 });
        await page.waitForTimeout(80);

        const vFull = await vPanel.boundingBox();
        approxEqual(vFull.y + vFull.height, 1080 - (820 - (vAtBottom.y + vAtBottom.height)), 3, 'Video stays anchored to bottom in 1080px fullscreen');
        const cpFull = await cpPanel.boundingBox();
        approxEqual(cpFull.y + cpFull.height, 1080 - (820 - (cpAtBottom.y + cpAtBottom.height)), 3, 'Collapsed Companion PDF stays anchored to bottom in 1080px fullscreen');
        const chatFull = await chatPanel.boundingBox();
        approxEqual(chatFull.y + chatFull.height, 1080 - (820 - (chatAtBottom.y + chatAtBottom.height)), 3, 'Chat panel stays anchored to bottom in 1080px fullscreen');
        const wbFull = await wbPanel.boundingBox();
        approxEqual(wbFull.y, wbMid.y, 2, 'Mid-screen Whiteboard must NOT move downward on fullscreen');

        // Exit fullscreen back 1080 -> 820: bottom-anchored windows return cleanly without clipping off bottom.
        await page.setViewportSize({ width: 1440, height: 820 });
        await page.waitForTimeout(80);
        approxEqual((await vPanel.boundingBox()).y, vAtBottom.y, 3, 'Video restores pre-fullscreen bottom position');
        approxEqual((await cpPanel.boundingBox()).y, cpAtBottom.y, 3, 'Companion PDF restores pre-fullscreen bottom position');
        approxEqual((await chatPanel.boundingBox()).y, chatAtBottom.y, 3, 'Chat restores pre-fullscreen bottom position');

        // ---------- 2. Dragging away from bottom stops anchoring; Whiteboard dragged to bottom anchors ----------
        await dragTitle(page, page.locator('#video-panel-title'), 0, -300);
        const vMovedUp = await vPanel.boundingBox();
        await dragTitle(page, page.locator('#whiteboard-header strong'), 0, (820 - 8) - (wbMid.y + wbMid.height));
        const wbAtBottom = await wbPanel.boundingBox();
        approxEqual(wbAtBottom.y + wbAtBottom.height, 812, 3, 'Whiteboard dragged to bottom of 820px viewport');

        await page.setViewportSize({ width: 1440, height: 1080 });
        await page.waitForTimeout(80);
        approxEqual((await vPanel.boundingBox()).y, vMovedUp.y, 2, 'Video dragged away from bottom no longer moves on fullscreen');
        const wbFullBottom = await wbPanel.boundingBox();
        approxEqual(wbFullBottom.y + wbFullBottom.height, 1080 - (820 - (wbAtBottom.y + wbAtBottom.height)), 3, 'Whiteboard at bottom stays anchored in fullscreen');

        // ---------- 3. Hiding a bottom-anchored window at 820px, entering fullscreen 1080px, then reopening ----------
        await page.setViewportSize({ width: 1440, height: 820 });
        await page.waitForTimeout(80);
        await page.keyboard.press('F9'); // close video
        await page.keyboard.press('F9'); // reopen video, drag to bottom
        await vPanel.waitFor({ state: 'visible' });
        await page.waitForFunction(() => getComputedStyle(document.getElementById('video-panel')).transform === 'none');
        const vReopenStart = await vPanel.boundingBox();
        await dragTitle(page, page.locator('#video-panel-title'), 0, (820 - 8) - (vReopenStart.y + vReopenStart.height));
        const vBeforeHide = await vPanel.boundingBox();
        await page.keyboard.press('F9'); // hide while anchored at 820px bottom
        await page.setViewportSize({ width: 1440, height: 1080 });
        await page.waitForTimeout(60);
        await page.keyboard.press('F9'); // reopen in 1080px fullscreen
        await vPanel.waitFor({ state: 'visible' });
        await page.waitForFunction(() => getComputedStyle(document.getElementById('video-panel')).transform === 'none');
        const vAfterHideFull = await vPanel.boundingBox();
        approxEqual(vAfterHideFull.y + vAfterHideFull.height, 1080 - (820 - (vBeforeHide.y + vBeforeHide.height)), 3, 'Reopening hidden bottom-anchored Video in fullscreen places it at fullscreen bottom');

        // Cleanup open windows before next checks.
        await page.keyboard.press('F9');
        await page.locator('#cp-close-btn').click();
        await page.locator('#deepseek-chat-btn').click();
        await page.locator('#whiteboard-close').click();

        // ---------- 4. Dict panel (#dict-panel) and Note modal (#note-modal) ----------
        await page.setViewportSize({ width: 1440, height: 820 });
        await page.evaluate(() => {
            if (typeof state !== 'undefined' && state.currentTool !== 'cursor') {
                const activeBtn = document.querySelector(`.tool-btn[data-tool="${state.currentTool}"]`);
                if (activeBtn) activeBtn.click();
                else state.currentTool = 'cursor';
            }
        });
        await page.waitForFunction(() => {
            const tl = document.getElementById('text-layer-1') || document.querySelector('.page-wrapper .textLayer');
            if (!tl) return false;
            return Array.from(tl.querySelectorAll('span')).some((el) => (el.textContent || '').trim().length >= 2);
        }, { timeout: 10000 });

        // Open Dict panel by selecting text in textLayer and clicking word translate, drag it to bottom, then enter fullscreen.
        await page.evaluate(() => {
            const spans = Array.from(document.querySelectorAll('#text-layer-1 span, .page-wrapper .textLayer span'))
                .filter((el) => /[A-Za-z]{2,}|[\u4e00-\u9fa5]{1,}/.test((el.textContent || '').trim()));
            const target = spans[0] || document.querySelector('#text-layer-1 span, .page-wrapper .textLayer span');
            if (!target) throw new Error('No textLayer span found for dict test');
            const range = document.createRange();
            range.selectNodeContents(target);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            const rect = target.getBoundingClientRect();
            target.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true,
                clientX: rect.left + Math.max(4, Math.min(20, rect.width / 2)),
                clientY: rect.top + rect.height / 2,
            }));
        });
        const dictBubbleBtn = page.locator('#dict-bubble .dict-opt[data-mode="word"]');
        await dictBubbleBtn.waitFor({ state: 'visible' });
        await dictBubbleBtn.click();
        const dictPanel = page.locator('#dict-panel');
        await dictPanel.waitFor({ state: 'visible' });
        await waitSettled(page, 'dict-panel');
        await page.evaluate(() => {
            const dp = document.getElementById('dict-panel');
            dp.style.left = '520px';
            dp.style.top = '180px';
        });
        const dictStart = await dictPanel.boundingBox();
        await dragTitle(page, page.locator('#dict-panel-title'), 0, (820 - 8) - (dictStart.y + dictStart.height));
        const dictAtBottom = await dictPanel.boundingBox();
        approxEqual(dictAtBottom.y + dictAtBottom.height, 812, 3, 'Dict panel dragged to bottom of 820px viewport');

        await page.setViewportSize({ width: 1440, height: 1080 });
        await page.waitForTimeout(80);
        const dictFull = await dictPanel.boundingBox();
        approxEqual(dictFull.y + dictFull.height, 1080 - (820 - (dictAtBottom.y + dictAtBottom.height)), 3, 'Dragged Dict panel stays anchored to bottom in fullscreen');

        await page.setViewportSize({ width: 1440, height: 820 });
        await page.waitForTimeout(80);
        const dictBack = await dictPanel.boundingBox();
        approxEqual(dictBack.y + dictBack.height, dictAtBottom.y + dictAtBottom.height, 3, 'Dragged Dict panel returns after exiting fullscreen');
        await page.locator('#dict-panel-close').click();

        // Open Note Modal via existing saved annotation, drag it to bottom, then enter fullscreen.
        await page.evaluate(() => {
            const firstPage = document.getElementById('page-wrapper-1') || document.querySelector('.page-wrapper');
            const rect = firstPage.getBoundingClientRect();
            const anno = state.annotations[1][0];
            openNoteModal(anno, 1, rect.left + 120, rect.top + 120, false);
        });
        const noteModal = page.locator('#note-modal');
        await noteModal.waitFor({ state: 'visible' });
        await waitSettled(page, 'note-modal');
        const noteStart = await noteModal.boundingBox();
        await dragTitle(page, page.locator('#note-header'), 0, (820 - 8) - (noteStart.y + noteStart.height));
        const noteAtBottom = await noteModal.boundingBox();
        approxEqual(noteAtBottom.y + noteAtBottom.height, 812, 3, 'Note modal dragged to bottom of 820px viewport');

        await page.setViewportSize({ width: 1440, height: 1080 });
        await page.waitForTimeout(80);
        const noteFull = await noteModal.boundingBox();
        approxEqual(noteFull.y + noteFull.height, 1080 - (820 - (noteAtBottom.y + noteAtBottom.height)), 3, 'Dragged Note modal stays anchored to bottom in fullscreen');
        await page.locator('#close-note-btn').click();

        // ---------- 5. Default tall Whiteboard on short 720px viewport must NOT drop when entering 960px fullscreen ----------
        await page.evaluate(() => localStorage.removeItem('pdf_reader_handwriting_whiteboard'));
        await page.reload();
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.waitForTimeout(60);
        await textTool.click();
        await textTool.click();
        await wbPanel.waitFor({ state: 'visible' });
        await page.waitForFunction(() => getComputedStyle(document.getElementById('handwriting-whiteboard')).transform === 'none');
        const wbShortDefault = await wbPanel.boundingBox();
        await page.setViewportSize({ width: 1280, height: 960 });
        await page.waitForTimeout(80);
        approxEqual((await wbPanel.boundingBox()).y, wbShortDefault.y, 2, 'Default tall Whiteboard clamped on 720px screen must not drop down on fullscreen');

        assert.deepEqual(errors, [], 'Unexpected browser errors');
        console.log('PASS fullscreen bottom anchoring for Video, Companion PDF, Whiteboard, Chat, Dict panel, and Note modal');
    } finally {
        await browser.close();
        server.close();
    }
})();
