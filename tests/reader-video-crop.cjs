// Real video frames + real Edge pointer gestures. No course files or backend required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));
const sharp = require(path.join(deps, 'sharp'));

async function recordFixture(page, width = 800, height = 450) {
    return Buffer.from(await page.evaluate(async ({ width, height }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        const stream = canvas.captureStream(30);
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
        const chunks = [];
        recorder.ondataavailable = e => chunks.push(e.data);
        const done = new Promise(resolve => recorder.onstop = resolve);
        recorder.start();
        let frame = 0;
        const timer = setInterval(() => {
            ctx.fillStyle = '#d83232'; ctx.fillRect(0, 0, width, height);
            ctx.fillStyle = '#169449'; ctx.fillRect(width * .2, height * .2, width * .6, height * .6);
            ctx.fillStyle = 'white'; ctx.font = `${width / 25}px sans-serif`;
            ctx.fillText(`LESSON ${++frame}`, width * .4, height * .55);
        }, 30);
        await new Promise(resolve => setTimeout(resolve, 1500));
        recorder.stop(); await done;
        clearInterval(timer); stream.getTracks().forEach(track => track.stop());
        const blob = new Blob(chunks, { type: 'video/webm' });
        return await new Promise(resolve => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob);
        });
    }, { width, height }), 'base64');
}

(async () => {
    const server = await startServer({});
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const errors = [];
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on('pageerror', e => errors.push(String(e)));
        await page.addInitScript(() => { window.showOpenFilePicker = undefined; });
        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await page.evaluate(() => {
            window.readerFullscreenChanges = 0;
            document.addEventListener('fullscreenchange', () => readerFullscreenChanges++);
        });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
        await page.keyboard.down('Backquote');
        await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
        await page.keyboard.down('Backquote'); // Holding must not toggle fullscreen.
        await page.keyboard.up('Backquote');
        await page.waitForTimeout(600);
        assert.equal(await page.evaluate(() => readerFullscreenChanges), 1, 'Backquote must enter stable fullscreen without toggling on repeat');
        assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
        await page.keyboard.press('Backquote');
        assert.equal(await page.evaluate(() => readerFullscreenChanges), 1, 'Backquote must do nothing when already fullscreen');

        // Simulate the browser's native Escape exit between keydown and keyup.
        await page.keyboard.down('Escape');
        if (await page.evaluate(() => !!document.fullscreenElement)) await page.evaluate(() => document.exitFullscreen());
        await page.waitForFunction(() => !document.fullscreenElement);
        await page.keyboard.up('Escape');
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => !!document.fullscreenElement), false, 'Escape release after native exit must not reenter fullscreen');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => !!document.fullscreenElement), false, 'Escape no longer enters fullscreen');
        await page.evaluate(() => {
            const input = document.createElement('input'); input.id = 'fullscreen-test-input'; document.body.appendChild(input); input.focus();
        });
        await page.keyboard.press('Backquote');
        assert.equal(await page.locator('#fullscreen-test-input').inputValue(), '`');
        assert.equal(await page.evaluate(() => !!document.fullscreenElement), false, 'typing a backquote must not enter fullscreen');
        await page.evaluate(() => document.getElementById('fullscreen-test-input').remove());
        await page.keyboard.press('Shift+Backquote');
        await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
        await page.click('#fullscreen-btn');
        await page.waitForFunction(() => !document.fullscreenElement);
        console.log('PASS Backquote/tilde enters stable fullscreen; repeat/fullscreen/input guards; Escape never enters');
        await page.keyboard.press('F9');
        assert.equal(await page.locator('#video-crop-btn').isDisabled(), true);
        const landscape = await recordFixture(page);
        const portrait = await recordFixture(page, 450, 800);

        async function openVideo(buffer, name) {
            const chooser = page.waitForEvent('filechooser');
            await page.click('#video-open-btn');
            await (await chooser).setFiles({ name, mimeType: 'video/webm', buffer });
            await page.waitForFunction(() => document.getElementById('video-element').readyState >= 2 && !document.getElementById('video-crop-btn').disabled);
            await page.evaluate(() => { const v = document.getElementById('video-element'); v.pause(); v.loop = true; });
        }
        async function region() {
            return await page.evaluate(() => {
                const box = document.getElementById('video-crop-box');
                const v = document.getElementById('video-element');
                return {
                    x: parseFloat(box.style.left) / 100, y: parseFloat(box.style.top) / 100,
                    w: parseFloat(box.style.width) / 100, h: parseFloat(box.style.height) / 100,
                    inset: v.style.getPropertyValue('object-view-box'), paused: v.paused,
                    playerRatio: v.clientWidth / v.clientHeight, sourceRatio: v.videoWidth / v.videoHeight
                };
            });
        }
        function checkRegion(r) {
            assert(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= 1.000001 && r.y + r.h <= 1.000001);
            assert(Math.abs(r.w / r.h * r.sourceRatio - r.playerRatio) < .002, 'selection must have the player aspect ratio');
            assert(r.inset.startsWith('inset('));
        }
        async function select(from = [.28, .28], to = [.72, .72]) {
            await page.click('#video-crop-btn');
            const rect = await page.locator('#video-crop-surface').boundingBox();
            await page.mouse.move(rect.x + from[0] * rect.width, rect.y + from[1] * rect.height);
            await page.mouse.down();
            await page.mouse.move(rect.x + to[0] * rect.width, rect.y + to[1] * rect.height, { steps: 8 });
            await page.mouse.up();
            assert.equal(await page.locator('#video-panel').evaluate(el => el.classList.contains('is-crop-zoomed')), true);
            const r = await region(); checkRegion(r); return r;
        }
        async function cancel() {
            await page.click('#video-crop-btn');
            assert.equal(await page.locator('#video-crop-surface').isHidden(), true);
            assert.equal(await page.locator('#video-element').evaluate(el => el.style.getPropertyValue('object-view-box')), '');
            assert.equal(await page.locator('#video-crop-btn').getAttribute('aria-pressed'), 'false');
        }

        await openVideo(landscape, 'lesson.webm');
        await page.evaluate(() => {
            window.previewDraws = 0;
            const ctx = document.getElementById('video-crop-preview').getContext('2d');
            const draw = ctx.drawImage.bind(ctx);
            ctx.drawImage = (...args) => { previewDraws++; return draw(...args); };
            document.addEventListener('keydown', e => {
                if (e.key === 'Escape') window.videoEscapePrevented = e.defaultPrevented;
            });
        });
        const initial = await select();
        assert.equal(initial.paused, true, 'selection must not toggle playback');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
        assert.equal((await region()).inset, initial.inset, 'Escape must retain the crop');
        assert.equal(await page.evaluate(() => videoEscapePrevented), false, 'video must not consume Escape');
        await page.keyboard.press('Backquote');
        await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
        assert.equal((await region()).inset, initial.inset, 'Backquote fullscreen must retain the crop');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => videoEscapePrevented), false, 'fullscreen Escape must remain available to the browser');
        if (await page.evaluate(() => !!document.fullscreenElement)) await page.click('#fullscreen-btn');
        await page.waitForFunction(() => !document.fullscreenElement);
        const videoRect = await page.locator('#video-element').boundingBox();
        await page.mouse.move(videoRect.x + 20, videoRect.y + 20);
        await page.waitForTimeout(850); // Let the transient HUD fade before checking pixels.
        assert.equal(await page.locator('#video-crop-surface').evaluate(el => getComputedStyle(el).opacity), '0');
        const screenshot = await page.locator('#video-element').screenshot();
        const pixels = await sharp(screenshot).raw().toBuffer({ resolveWithObject: true });
        const offset = (14 * pixels.info.width + 14) * pixels.info.channels;
        const rgb = [...pixels.data.subarray(offset, offset + 3)];
        assert(rgb[1] > rgb[0] * 2 && rgb[1] > rgb[2] * 1.5, 'actual zoomed video corner must show the green board, not the red full-frame background');
        let map = await page.locator('#video-crop-surface').boundingBox();
        const mapOffset = (Math.round(map.y - videoRect.y + 3) * pixels.info.width + Math.round(map.x - videoRect.x + 3)) * pixels.info.channels;
        const mapRgb = [...pixels.data.subarray(mapOffset, mapOffset + 3)];
        assert(mapRgb[1] > mapRgb[0] * 2, 'transparent preview must not obscure the board');
        await page.locator('#video-crop-surface').hover();
        await page.waitForFunction(() => getComputedStyle(document.getElementById('video-crop-surface')).opacity === '1');
        const preview = await page.locator('#video-crop-preview').evaluate(el => [...el.getContext('2d').getImageData(3, 3, 1, 1).data]);
        assert(preview[0] > preview[1] * 2, 'preview must retain the uncropped original frame');
        console.log('PASS real video crop fills the player; preview shows original frames; fixed aspect');

        // Pan via the selection box; captured pointer movement outside the preview clamps at edges.
        map = await page.locator('#video-crop-surface').boundingBox();
        await page.mouse.move(map.x + (initial.x + initial.w / 2) * map.width, map.y + (initial.y + initial.h / 2) * map.height);
        await page.mouse.down();
        await page.mouse.move(map.x - 100, map.y - 100, { steps: 6 });
        assert.equal(await page.locator('#video-crop-surface').evaluate(el => getComputedStyle(el).opacity), '1', 'preview stays visible during a captured drag');
        await page.mouse.up();
        await page.waitForFunction(() => getComputedStyle(document.getElementById('video-crop-surface')).opacity === '0');
        let moved = await region(); checkRegion(moved);
        assert(moved.x < .001 && moved.y < .001);
        assert(Math.abs(moved.w - initial.w) < .0001 && Math.abs(moved.h - initial.h) < .0001);
        assert.equal(moved.paused, true);
        await page.mouse.click(map.x + map.width * .98, map.y + map.height * .98);
        moved = await region(); checkRegion(moved);
        assert(Math.abs(moved.x + moved.w - 1) < .001 && Math.abs(moved.y + moved.h - 1) < .001);
        console.log('PASS hover reveals preview, drag stays visible, leaving hides it; panning and boundaries');

        await cancel();
        for (const [from, to] of [ [[.72, .72], [.28, .28]], [[.28, .72], [.72, .28]], [[.72, .28], [.28, .72]] ]) {
            await select(from, to); await cancel();
        }
        await page.click('#video-crop-btn');
        let surface = await page.locator('#video-crop-surface').boundingBox();
        await page.mouse.click(surface.x + 50, surface.y + 50);
        assert.equal(await page.locator('#video-crop-box').isHidden(), true);
        assert.equal(await page.locator('#video-panel').evaluate(el => el.classList.contains('is-crop-selecting')), true);
        await page.mouse.move(surface.x + 80, surface.y + 80); await page.mouse.down();
        await page.mouse.move(surface.x + 180, surface.y + 180);
        await page.locator('#video-crop-surface').dispatchEvent('pointercancel');
        await page.mouse.up();
        assert.equal(await page.locator('#video-crop-box').isHidden(), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
        assert.equal(await page.locator('#video-panel').evaluate(el => el.classList.contains('is-crop-selecting')), true);
        await cancel();
        console.log('PASS reverse drags, interrupted gestures, button cancellation; Escape retains selection without entering fullscreen');

        await select();
        const resize = await page.locator('.video-resize-handle').boundingBox();
        await page.mouse.move(resize.x + 8, resize.y + 8); await page.mouse.down();
        await page.mouse.move(resize.x + 158, resize.y + 90, { steps: 8 }); await page.mouse.up();
        await page.waitForTimeout(100);
        checkRegion(await region());
        const beforeCollapse = (await region()).inset;
        await page.keyboard.press('Shift');
        assert.equal(await page.locator('#video-crop-surface').isVisible(), false);
        await page.keyboard.press('Shift');
        assert.equal(await page.locator('#video-crop-surface').isVisible(), true);
        assert.equal((await region()).inset, beforeCollapse);
        await page.keyboard.press('F9'); await page.keyboard.press('F9');
        assert.equal((await region()).inset, beforeCollapse);
        console.log('PASS crop survives player resizing, collapse/expand and hide/reopen');

        // Test native controls and live thumbnail updates, then pause/seek/collapse cleanup.
        await page.waitForTimeout(200); // Let the reopen animation finish before measuring the control position.
        const vbox = await page.locator('#video-element').boundingBox();
        await page.mouse.move(vbox.x + 24, vbox.y + vbox.height - 40);
        await page.waitForTimeout(400);
        if (process.env.READER_TEST_ARTIFACTS === '1') await page.locator('#video-panel').screenshot({ path: path.join(resultsDir, 'video-crop-controls.png') });
        await page.mouse.click(vbox.x + 24, vbox.y + vbox.height - 40);
        await page.waitForFunction(() => !document.getElementById('video-element').paused);
        const drawCount = await page.evaluate(() => previewDraws);
        await page.waitForFunction(count => previewDraws > count + 1, drawCount);
        await page.click('#video-collapse-btn');
        const collapsedCount = await page.evaluate(() => previewDraws);
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => previewDraws), collapsedCount);
        assert.equal(await page.locator('#video-element').evaluate(el => el.paused), false);
        await page.click('#video-collapse-btn');
        await page.evaluate(async () => {
            document.getElementById('video-element').pause();
            // pause and the expand ResizeObserver each repaint once; let those events settle.
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const pausedCount = await page.evaluate(() => previewDraws);
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => previewDraws), pausedCount);
        await page.evaluate(() => { document.getElementById('video-element').currentTime = .4; });
        await page.waitForFunction(count => previewDraws > count, pausedCount);
        console.log('PASS native playback control works; preview animates, stops when paused/collapsed, updates after seek');

        const chooser = page.waitForEvent('filechooser');
        await page.click('#video-subtitle-btn');
        await (await chooser).setFiles({ name: 'lesson.vtt', mimeType: 'text/vtt', buffer: Buffer.from('WEBVTT\n\n00:00.000 --> 00:10.000\nBoard caption\n') });
        await page.waitForFunction(() => document.getElementById('video-element').textTracks[0]?.mode === 'showing');
        assert((await region()).inset);
        await page.selectOption('#video-speed', '2.0');
        assert.equal(await page.locator('#video-element').evaluate(el => el.playbackRate), 2);
        await page.click('#fullscreen-btn');
        await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
        await page.locator('#video-overlay').dblclick({ position: { x: 100, y: 100 } });
        await page.waitForFunction(() => document.fullscreenElement?.id === 'video-panel');
        await page.waitForTimeout(150);
        checkRegion(await region());
        assert.equal(await page.locator('#video-crop-surface').isVisible(), true);
        map = await page.locator('#video-crop-surface').boundingBox();
        await page.mouse.click(map.x + 2, map.y + 2);
        const fullscreenMoved = await region(); checkRegion(fullscreenMoved);
        assert(fullscreenMoved.x < .001 && fullscreenMoved.y < .001);
        await page.keyboard.press('Shift');
        assert.equal(await page.locator('#video-panel').evaluate(el => el.classList.contains('is-collapsed')), false);
        if (process.env.READER_TEST_ARTIFACTS === '1') {
            fs.mkdirSync(resultsDir, { recursive: true });
            await page.screenshot({ path: path.join(resultsDir, 'video-crop-fullscreen.png') });
        }
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#video-crop-btn').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.evaluate(() => videoEscapePrevented), false);
        await cancel();
        if (await page.evaluate(() => document.fullscreenElement?.id === 'video-panel')) {
            await page.evaluate(() => document.exitFullscreen());
            await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
        }
        if (await page.evaluate(() => !!document.fullscreenElement)) await page.click('#fullscreen-btn');
        await page.waitForFunction(() => !document.fullscreenElement);
        await page.waitForTimeout(150);
        console.log('PASS subtitles, playback rate, fullscreen panning/cancellation and nested reader fullscreen');

        await select();
        await openVideo(portrait, 'portrait.webm');
        assert.equal(await page.locator('#video-crop-surface').isHidden(), true);
        assert.equal((await region()).inset, '');
        const vertical = await select();
        assert(vertical.playerRatio < 1);
        checkRegion(vertical);
        if (process.env.READER_TEST_ARTIFACTS === '1') {
            await page.waitForTimeout(850);
            await page.locator('#video-panel').screenshot({ path: path.join(resultsDir, 'video-crop-portrait.png') });
        }
        await cancel();
        // Browser fallback accepts several files and sorts titles naturally.
        const multiChooser = page.waitForEvent('filechooser');
        await page.click('#video-open-btn');
        await (await multiChooser).setFiles([
            { name: '第2课.webm', mimeType: 'video/webm', buffer: landscape },
            { name: '第10课.webm', mimeType: 'video/webm', buffer: landscape },
            { name: '第1课.webm', mimeType: 'video/webm', buffer: landscape }
        ]);
        await page.waitForFunction(() => document.getElementById('video-element').readyState >= 2);
        assert.equal(await page.locator('#video-panel-filename').textContent(), '第2课.webm');
        await page.click('#video-next-btn');
        assert.equal(await page.locator('#video-panel-filename').textContent(), '第10课.webm');
        assert.equal(await page.locator('#video-next-btn').isDisabled(), true);
        await page.click('#video-previous-btn'); await page.click('#video-previous-btn');
        assert.equal(await page.locator('#video-panel-filename').textContent(), '第1课.webm');
        assert.equal(await page.locator('#video-previous-btn').isDisabled(), true);
        console.log('PASS multi-file fallback, natural title order and playlist boundaries');

        const pickerRequests = []; let cancelPicker = false;
        await page.route('**/api/pick-video', async route => {
            pickerRequests.push(route.request().postDataJSON());
            await route.fulfill({ json: cancelPicker ? { ok: false, cancelled: true } : {
                ok: true, folder: 'D:/mock-video-folder', selected: '/api/video?token=test&index=2',
                videos: [
                    { name: '第10课.webm', url: '/api/video?token=test&index=10' },
                    { name: '第1课.webm', url: '/api/video?token=test&index=1' },
                    { name: '第2课.webm', url: '/api/video?token=test&index=2' }
                ]
            } });
        });
        await page.route('**/api/video?*', route => route.fulfill({ contentType: 'video/webm', body: landscape }));
        await page.click('#video-open-btn');
        await page.waitForFunction(() => document.getElementById('video-element').readyState >= 2 && document.getElementById('video-element').src.includes('token=test'));
        assert.equal(await page.locator('#video-panel-filename').textContent(), '第2课.webm');
        await page.selectOption('#video-speed', '2.0');
        await page.evaluate(() => document.getElementById('video-element').pause());
        await select();
        await page.click('#fullscreen-btn');
        await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
        await page.click('#video-fullscreen-btn');
        await page.waitForFunction(() => document.fullscreenElement?.id === 'video-panel');
        await page.click('#video-next-btn');
        await page.waitForFunction(() => document.getElementById('video-element').readyState >= 2);
        assert.equal(await page.locator('#video-panel-filename').textContent(), '第10课.webm');
        assert.equal(await page.evaluate(() => document.fullscreenElement?.id), 'video-panel');
        assert.equal(await page.locator('#video-element').evaluate(v => v.playbackRate), 2);
        assert.equal(await page.locator('#video-crop-surface').isHidden(), true);
        assert.equal(await page.locator('#video-next-btn').isDisabled(), true);
        await page.click('#video-previous-btn'); await page.click('#video-previous-btn');
        assert.equal(await page.locator('#video-panel-filename').textContent(), '第1课.webm');
        assert.equal(await page.evaluate(() => document.fullscreenElement?.id), 'video-panel');
        cancelPicker = true;
        const sourceBeforeCancel = await page.locator('#video-element').getAttribute('src');
        await page.click('#video-open-btn');
        await page.waitForFunction(() => !document.getElementById('video-open-btn').disabled);
        assert.equal(pickerRequests.at(-1).initial_dir, 'D:/mock-video-folder');
        assert.equal(await page.locator('#video-element').getAttribute('src'), sourceBeforeCancel);
        await page.click('#video-fullscreen-btn');
        await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
        await page.click('#fullscreen-btn');
        await page.waitForFunction(() => !document.fullscreenElement);
        await page.locator('#video-panel').evaluate(el => { el.style.width = '280px'; });
        assert.equal(await page.locator('#video-next-btn').isVisible(), true);
        assert.equal(await page.locator('#video-close-btn').evaluate(el => {
            const panel = el.closest('#video-panel').getBoundingClientRect(), button = el.getBoundingClientRect();
            return button.right <= panel.right;
        }), true, 'buttons must fit the smallest player');
        console.log('PASS folder playlist, fullscreen switching, retained rate, crop reset, cancellation and compact controls');
        assert.deepEqual(errors, []);
        console.log('PASS video replacement clears crop; portrait aspect; no browser errors');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
