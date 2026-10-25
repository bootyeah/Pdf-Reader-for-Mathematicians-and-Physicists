// Run only from the explicit synthetic-board live test; URL/token arrive on stdin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const deps = process.env.READER_TEST_NODE_MODULES || 'node_modules';
const { chromium } = require(path.join(deps, 'playwright'));
(async () => {
    const { url } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 430, height: 900 }, isMobile: true, hasTouch: true });
        const messages = [];
        page.on('websocket', socket => socket.on('framereceived', frame => messages.push(frame.payload.toString())));
        await page.goto(url, { timeout: 45000 });
        for (let i = 0; i < 40 && !messages.some(message => message.includes('"state"')); i++) await page.waitForTimeout(250);
        assert.ok(messages.some(message => message.includes('"state"')), 'Public WSS must deliver board state');
        const board = await page.locator('#board').boundingBox();
        const update = page.waitForResponse(response => response.url().includes('/api/update') && response.status() === 200, { timeout: 20000 });
        await page.mouse.move(board.x + board.width * .2, board.y + board.height * .3);
        await page.mouse.down();
        await page.mouse.move(board.x + board.width * .6, board.y + board.height * .5, { steps: 10 });
        await page.mouse.up();
        assert.equal((await (await update).json()).accepted, true);
        const recognition = page.waitForResponse(response => response.url().includes('/api/recognize') && response.status() === 200, { timeout: 20000 });
        await page.locator('#recognizeBtn').click();
        assert.equal((await (await recognition).json()).started, true);
        console.log('PASS Mobile browser loads over public HTTPS, receives WSS state, and uploads drawn strokes');
    } finally { await browser.close(); }
})().catch(error => {
    console.error(String(error.message).replace(/https:\/\/[^\s"']+/g, '[private pairing URL]'));
    process.exitCode = 1;
});
