// Explicit real-network smoke test using this project's saved Bilibili login.
// Does not read PDFs, export cookies, or change the saved login.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

if (!process.argv.includes('--live')) {
    console.log('Run with --live after signing in through this reader. Requires real network and an account with 1080P access.');
    process.exit(0);
}

(async () => {
    const simulateStoppedProxy = process.argv.includes('--dead-proxy');
    const backendEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !simulateStoppedProxy || !/^(http|https|all|no)_proxy$/i.test(key)));
    if (simulateStoppedProxy) Object.assign(backendEnv, {
        HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
        ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost'
    });
    const script = "from http.server import ThreadingHTTPServer; import server; h=ThreadingHTTPServer(('127.0.0.1',0),server.PDFReaderHandler); print(h.server_port,flush=True); h.serve_forever()";
    const child = spawn(process.env.READER_TEST_PYTHON || 'python', ['-u', '-c', script], {
        cwd: path.resolve(__dirname, '..'), env: backendEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    let browser;
    try {
        const port = await new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(new Error('Reader startup timed out')), 10000);
            child.stdout.on('data', chunk => {
                output += chunk;
                if (/^\d+\r?\n/.test(output)) { clearTimeout(timer); resolve(Number(output.trim())); }
            });
            child.on('error', error => { clearTimeout(timer); reject(error); });
            child.on('exit', code => { clearTimeout(timer); reject(new Error(`Reader exited: ${code}`)); });
        });
        browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = []; let popups = 0, audioRequests = 0;
        page.on('pageerror', error => errors.push(String(error)));
        page.on('popup', popup => { popups++; popup.close(); });
        page.on('request', request => {
            if (request.url().includes('/api/bilibili/media?') && request.url().includes('track=audio')) audioRequests++;
        });
        await page.goto(`http://127.0.0.1:${port}/`);
        if (simulateStoppedProxy) {
            const generated = await page.request.post(`http://127.0.0.1:${port}/api/bilibili`, { data: { action: 'login' } });
            const qr = await generated.json();
            assert(generated.ok() && qr.ok && qr.image.startsWith('data:image/png;base64,'), 'QR generation must work despite the stopped proxy');
            const polled = await page.request.post(`http://127.0.0.1:${port}/api/bilibili`, { data: { action: 'poll', token: qr.token } });
            const state = await polled.json();
            assert(polled.ok() && state.ok && ['waiting', 'confirm'].includes(state.state));
            console.log('PASS real QR generation and polling with unreachable HTTP/HTTPS proxy in isolated backend');
        }
        await page.keyboard.press('F9');
        await page.click('#video-url-btn');
        await page.fill('#video-url-input', 'https://www.bilibili.com/video/BV18j7NzZEve/?p=2');
        await page.click('#video-url-submit');
        async function waitQuality(width, paused = false) {
            await page.waitForFunction(({ width, paused }) => {
                const v = document.getElementById('video-element');
                return v.videoWidth === width && v.readyState >= 2 && !v.seeking && (!paused || v.paused);
            }, { width, paused }, { timeout: 45000 });
        }
        const video = page.locator('#video-element');
        await waitQuality(1920);
        assert.equal(await video.evaluate(v => v.videoHeight), 1080);
        assert.equal(await page.locator('#video-bili-actual').textContent(), '当前 1080P');
        await video.evaluate(v => { v.muted = true; return v.play(); });
        await page.waitForFunction(() => document.getElementById('video-element').currentTime > 2);
        const audioTracks = await video.evaluate(v => {
            const capture = v.captureStream();
            const count = capture.getAudioTracks().length;
            capture.getTracks().forEach(track => track.stop());
            return count;
        });
        assert(audioRequests > 0 && audioTracks > 0, 'DASH audio must be attached to the same video element');
        console.log('PASS real 1920x1080 frames and attached DASH audio (not only a 1080P label)');

        await page.click('#video-overlay');
        await page.waitForFunction(() => document.getElementById('video-element').paused);
        await video.evaluate(v => { v.currentTime = 120; });
        await page.waitForFunction(() => !document.getElementById('video-element').seeking && document.getElementById('video-element').currentTime >= 119);
        await page.selectOption('#video-speed', '2.0');
        const chooser = page.waitForEvent('filechooser');
        await page.click('#video-subtitle-btn');
        await (await chooser).setFiles({ name: 'live-test.vtt', mimeType: 'text/vtt', buffer: Buffer.from('WEBVTT\n\n00:01:00.000 --> 00:10:00.000\nLive test subtitle\n') });
        await page.waitForFunction(() => document.getElementById('video-element').textTracks[0]?.mode === 'showing');
        const subtitleUrl = await page.locator('#video-element track').getAttribute('src');
        await page.click('#video-crop-btn');
        const crop = await page.locator('#video-crop-surface').boundingBox();
        await page.mouse.move(crop.x + crop.width * .2, crop.y + crop.height * .2);
        await page.mouse.down();
        await page.mouse.move(crop.x + crop.width * .8, crop.y + crop.height * .8, { steps: 5 });
        await page.mouse.up();
        assert.equal(await page.locator('#video-crop-btn').getAttribute('aria-pressed'), 'true');
        const alpha = await page.locator('#video-crop-preview').evaluate(c => c.getContext('2d').getImageData(2, 2, 1, 1).data[3]);
        assert(alpha > 0, 'preview must contain actual video pixels and remain readable');

        for (const [quality, width] of [['64', 1280], ['80', 1920]]) {
            await page.click('#video-url-btn');
            await page.selectOption('#video-bili-quality', quality);
            await waitQuality(width, true);
            await page.waitForFunction(() => Math.abs(document.getElementById('video-element').currentTime - 120) < 2);
            assert.equal(await video.evaluate(v => v.playbackRate), 2);
            assert.equal(await page.locator('#video-crop-btn').getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('#video-element track').getAttribute('src'), subtitleUrl);
            assert.equal(await video.evaluate(v => v.textTracks[0].mode), 'showing');
        }
        await page.locator('#video-panel').screenshot({ path: path.join(resultsDir, 'bilibili-1080-live.png') });
        console.log('PASS seek to 120s, crop pixels, 1080P → 720P → 1080P retain time, pause, rate, subtitles and crop');

        await page.click('#video-next-btn');
        await page.waitForFunction(() => document.getElementById('video-panel-filename').textContent === 'Advanced quantum theory, Lecture 3');
        await waitQuality(1920);
        await page.click('#video-fullscreen-btn');
        await page.waitForFunction(() => document.fullscreenElement?.id === 'video-panel');
        await page.click('#video-previous-btn');
        await page.waitForFunction(() => document.getElementById('video-panel-filename').textContent === 'Advanced quantum theory, Lecture 2');
        await waitQuality(1920);
        assert.equal(await page.evaluate(() => document.fullscreenElement?.id), 'video-panel');
        await page.click('#video-fullscreen-btn');
        await page.waitForFunction(() => !document.fullscreenElement);
        await page.click('#video-close-btn');
        assert(await video.evaluate(v => v.paused));
        await page.keyboard.press('F9');
        assert(await video.evaluate(v => v.paused));
        assert.equal(popups, 0);
        assert.deepEqual(errors, []);
        console.log('PASS real HD episodes switch within fullscreen, close pauses audio, clicks never navigate, no page errors');
    } finally {
        if (browser) await browser.close();
        child.kill();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
