// Real Edge, synthetic video and mocked Bilibili responses; no user data or external media.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

const bv = 'BV18j7NzZEve';
const source = `https://www.bilibili.com/video/${bv}/?p=2`;
const episodes = ['Z first', 'A second', '<Third episode>'].map((name, i) => ({
    kind: 'bilibili', name,
    bvid: bv, cid: 101 + i, page: i + 1,
    url: `https://player.bilibili.com/player.html?bvid=${bv}&p=${i + 1}&cid=${101 + i}&autoplay=1&danmaku=0`,
    pageUrl: `https://www.bilibili.com/video/${bv}/?p=${i + 1}`
}));

async function fixture(page) {
    return Buffer.from(await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d');
        const stream = canvas.captureStream(20);
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
        const chunks = [];
        recorder.ondataavailable = e => chunks.push(e.data);
        const stopped = new Promise(resolve => recorder.onstop = resolve);
        recorder.start();
        let n = 0;
        const timer = setInterval(() => {
            ctx.fillStyle = '#19394b'; ctx.fillRect(0, 0, 640, 360);
            ctx.fillStyle = 'white'; ctx.font = '28px sans-serif'; ctx.fillText(`Video test ${++n}`, 40, 150);
        }, 40);
        await new Promise(resolve => setTimeout(resolve, 1500));
        recorder.stop(); await stopped;
        clearInterval(timer); stream.getTracks().forEach(t => t.stop());
        return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    }));
}

(async () => {
    const server = await startServer({});
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.addInitScript(() => { window.showOpenFilePicker = undefined; });
        let popups = 0;
        page.on('popup', popup => { popups++; popup.close(); });
        let loggedIn = false, polls = 0;
        const playRequests = [];
        await page.route('**/api/bilibili', async route => {
            const data = route.request().postDataJSON();
            let answer;
            if (data.action === 'status') answer = { ok: true, loggedIn, name: loggedIn ? 'Test user' : '' };
            else if (data.action === 'login') answer = { ok: true, token: 'qr-test', image: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect width="150" height="150" fill="white"/></svg>').toString('base64') };
            else if (data.action === 'poll') { polls++; loggedIn = polls >= 2; answer = { ok: true, state: loggedIn ? 'success' : 'confirm' }; }
            else if (data.action === 'logout') { loggedIn = false; answer = { ok: true, loggedIn: false }; }
            else {
                playRequests.push(data);
                const quality = Math.min(data.quality, loggedIn ? 80 : 64);
                answer = { ok: true, url: `/bili-test-${data.cid}.webm?quality=${quality}`, quality,
                    qualityLabel: quality === 80 ? '1080P' : quality === 64 ? '720P' : '480P', loggedIn };
                if (mode === 'playDelayed') await new Promise(resolve => { release = resolve; });
            }
            try { await route.fulfill({ json: answer }); } catch (_) { /* Deliberate cancellation. */ }
        });
        let mode = 'success', release, requested;
        await page.route('**/api/online-video', async route => {
            requested = route.request().postDataJSON();
            if (mode === 'delayed') await new Promise(resolve => { release = resolve; });
            try {
                await route.fulfill(mode === 'error' ? { status: 502, json: { ok: false, error: '暂时无法连接 B 站' } } :
                    { json: { ok: true, videos: episodes, selected: episodes[1].url } });
            } catch (_) { /* The UI deliberately aborted a delayed request. */ }
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        const media = await fixture(page);
        async function serveMedia(route) {
            const requested = route.request().headers().range;
            const range = requested && /^bytes=(\d+)-(\d*)$/.exec(requested);
            if (!range) return route.fulfill({ contentType: 'video/webm', headers: { 'Accept-Ranges': 'bytes' }, body: media });
            const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : media.length - 1, media.length - 1);
            if (start >= media.length) return route.fulfill({ status: 416, headers: { 'Content-Range': `bytes */${media.length}` }, body: '' });
            return route.fulfill({ status: 206, contentType: 'video/webm', headers: {
                'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${media.length}`
            }, body: media.subarray(start, end + 1) });
        }
        await page.route('**/bili-test-*.webm?*', serveMedia);
        await page.route('**/api/pick-video', route => route.fulfill({ json: {
            ok: true, videos: [{ name: 'Local 1', url: '/test-1.webm' }, { name: 'Local 2', url: '/test-2.webm' }], selected: '/test-1.webm'
        } }));
        await page.route('**/test-*.webm', route => route.fulfill({ contentType: 'video/webm', body: media }));
        await page.route('https://media.example/**', route => route.fulfill({ contentType: 'video/webm', body: media }));
        await page.keyboard.press('F9');
        await page.click('#video-open-btn');
        await page.waitForFunction(() => document.getElementById('video-element').src.endsWith('/test-1.webm') && document.getElementById('video-element').readyState >= 2);
        await page.selectOption('#video-speed', '2.0');

        async function openUrl(url = source) {
            if (await page.locator('#video-url-form').isHidden()) await page.click('#video-url-btn');
            await page.fill('#video-url-input', url);
            await page.click('#video-url-submit');
        }
        await openUrl();
        async function waitEpisode(cid) {
            await page.waitForFunction(cid => document.getElementById('video-element').src.includes(`/bili-test-${cid}.webm`) && document.getElementById('video-element').readyState >= 2, cid);
        }
        await waitEpisode(102);
        assert.equal(requested.url, source);
        assert.equal(await page.locator('#video-panel-filename').textContent(), 'A second');
        assert.equal(await page.locator('#video-url-form').isHidden(), true);
        assert.equal(await page.locator('#video-online-frame').count(), 0);
        for (const id of ['video-speed', 'video-subtitle-btn', 'video-crop-btn']) assert.equal(await page.locator('#' + id).isDisabled(), false);
        assert(await page.locator('#video-overlay').isVisible());
        assert.equal(await page.locator('#video-bili-actual').textContent(), '当前 720P');
        await page.locator('#video-element').evaluate(v => { v.loop = true; v.pause(); });
        await page.click('#video-overlay');
        await page.waitForFunction(() => !document.getElementById('video-element').paused);
        assert.equal(popups, 0, 'clicking video must never open Bilibili');
        await page.click('#video-previous-btn');
        await waitEpisode(101);
        assert.equal(await page.locator('#video-panel-filename').textContent(), 'Z first');
        assert(await page.locator('#video-previous-btn').isDisabled());
        await page.click('#video-next-btn'); await waitEpisode(102);
        await page.click('#video-next-btn'); await waitEpisode(103);
        assert.equal(await page.locator('#video-panel-filename').textContent(), '<Third episode>');
        assert(await page.locator('#video-next-btn').isDisabled());
        console.log('PASS native Bilibili playback, click without navigation, actual quality, site order and boundaries');

        await page.click('#video-fullscreen-btn');
        await page.waitForFunction(() => document.fullscreenElement?.id === 'video-panel');
        await page.click('#video-previous-btn');
        await waitEpisode(102);
        assert.equal(await page.evaluate(() => document.fullscreenElement.id), 'video-panel');
        await page.click('#video-url-btn');
        await page.click('#video-url-input');
        await page.keyboard.press('Control+A');
        await page.keyboard.type(source);
        assert.equal(await page.inputValue('#video-url-input'), source);
        await page.click('#video-url-cancel');
        assert(await page.locator('#video-url-form').isHidden());
        assert.equal(await page.evaluate(() => document.fullscreenElement?.id), 'video-panel');
        await page.click('#video-fullscreen-btn');
        await page.waitForFunction(() => !document.fullscreenElement);
        await page.click('#video-url-btn');
        await page.keyboard.press('Escape');
        assert(await page.locator('#video-url-form').isHidden());
        const originalSource = await page.locator('#video-element').getAttribute('src');
        await page.click('#video-collapse-btn'); await page.click('#video-collapse-btn');
        assert.equal(await page.locator('#video-element').getAttribute('src'), originalSource);
        await page.locator('#video-element').evaluate(v => { v.pause(); v.currentTime = .2; });
        await page.waitForFunction(() => !document.getElementById('video-element').seeking && Math.abs(document.getElementById('video-element').currentTime - .2) < .1, null, { timeout: 3000 }).catch(async error => {
            console.log('Seek state', await page.locator('#video-element').evaluate(v => ({time:v.currentTime, duration:v.duration, seeking:v.seeking, paused:v.paused, ready:v.readyState, buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)])})));
            throw error;
        });
        await page.click('#video-close-btn');
        assert(await page.locator('#video-element').evaluate(v => v.paused), 'close must pause the audio source');
        await page.keyboard.press('F9');
        assert.equal(await page.locator('#video-element').getAttribute('src'), originalSource);
        assert(Math.abs(await page.locator('#video-element').evaluate(v => v.currentTime) - .2) < .1);
        console.log('PASS fullscreen episode switching, editable input, collapse retention and silent close');

        await page.click('#video-crop-btn');
        const crop = await page.locator('#video-crop-surface').boundingBox();
        await page.mouse.move(crop.x + crop.width * .2, crop.y + crop.height * .2);
        await page.mouse.down();
        await page.mouse.move(crop.x + crop.width * .8, crop.y + crop.height * .8, { steps: 4 });
        await page.mouse.up();
        assert.equal(await page.locator('#video-crop-btn').getAttribute('aria-pressed'), 'true');
        const biliSubtitleChooser = page.waitForEvent('filechooser');
        await page.click('#video-subtitle-btn');
        await (await biliSubtitleChooser).setFiles({ name: 'course.vtt', mimeType: 'text/vtt', buffer: Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nCourse subtitle\n') });
        await page.waitForFunction(() => document.getElementById('video-element').textTracks[0]?.mode === 'showing');
        const subtitleSource = await page.locator('#video-element track').getAttribute('src');
        await page.click('#video-url-btn');
        await page.click('#video-bili-login');
        await page.waitForSelector('#video-bili-qr[src]');
        await page.waitForFunction(() => document.getElementById('video-bili-login-status').textContent.includes('确认登录'));
        await page.waitForFunction(() => document.getElementById('video-bili-login').dataset.loggedIn === 'true' && document.getElementById('video-bili-actual').textContent.includes('1080P'));
        await page.waitForFunction(() => document.getElementById('video-element').readyState >= 2);
        assert.equal(await page.locator('#video-crop-btn').getAttribute('aria-pressed'), 'true', 'login quality refresh keeps crop');
        assert(await page.locator('#video-element').evaluate(v => v.paused), 'login must retain paused state');
        assert(Math.abs(await page.locator('#video-element').evaluate(v => v.currentTime) - .2) < .1);
        await page.click('#video-url-btn');
        await page.selectOption('#video-bili-quality', '64');
        await page.waitForFunction(() => document.getElementById('video-bili-actual').textContent === '当前 720P' && document.getElementById('video-element').readyState >= 2);
        assert.equal(playRequests.at(-1).quality, 64);
        assert.equal(await page.locator('#video-element').evaluate(v => v.playbackRate), 2);
        assert.equal(await page.locator('#video-crop-btn').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#video-element track').getAttribute('src'), subtitleSource, 'login and quality refresh retain custom subtitles');
        await page.click('#video-crop-btn');
        console.log('PASS Bilibili crop, QR login, actual HD quality and quality switching retain time, pause, rate and crop');

        mode = 'error';
        await openUrl();
        await page.waitForFunction(() => document.getElementById('video-url-error').textContent.includes('无法连接'));
        assert.match(await page.locator('#video-element').getAttribute('src'), /bili-test-102/);
        assert.equal(await page.locator('#video-url-submit').isDisabled(), false);
        await openUrl('javascript:alert(1)');
        assert.match(await page.locator('#video-url-error').textContent(), /http/);
        mode = 'playDelayed'; release = null;
        await openUrl();
        while (!release) await page.waitForTimeout(10);
        await page.click('#video-open-btn');
        await page.waitForFunction(() => document.getElementById('video-element').src.endsWith('/test-1.webm') && document.getElementById('video-element').readyState >= 2);
        release();
        await page.waitForTimeout(100);
        assert.equal(await page.locator('#video-online-frame').count(), 0);
        assert.equal(await page.locator('#video-bili-actual').textContent(), '', 'local video must not display stale Bilibili quality');
        assert.equal(await page.locator('#video-panel-filename').textContent(), 'Local 1');
        assert.equal(await page.locator('#video-element').evaluate(v => v.playbackRate), 2);
        assert.equal(await page.locator('#video-speed').isDisabled(), false);
        assert.equal(await page.locator('#video-subtitle-btn').isDisabled(), false);
        assert.equal(await page.locator('#video-crop-btn').isDisabled(), false);
        console.log('PASS network failure keeps current video; delayed online results cannot replace local selection');

        release = null;
        await openUrl();
        while (!release) await page.waitForTimeout(10);
        await page.click('#video-close-btn');
        release();
        await page.waitForTimeout(100);
        assert(await page.locator('#video-panel').isHidden());
        assert.equal(await page.locator('#video-online-frame').count(), 0);
        await page.keyboard.press('F9');
        await openUrl('https://media.example/course.webm?token=a%2Bb');
        await page.waitForFunction(() => document.getElementById('video-element').src.includes('media.example') && document.getElementById('video-element').readyState >= 2);
        assert.equal(await page.locator('#video-element').getAttribute('src'), 'https://media.example/course.webm?token=a%2Bb');
        assert.equal(await page.locator('#video-online-frame').count(), 0);
        assert.equal(await page.locator('#video-element').evaluate(v => v.playbackRate), 2);
        assert(await page.locator('#video-previous-btn').isDisabled());
        assert(await page.locator('#video-next-btn').isDisabled());
        console.log('PASS closing cancels pending load; direct URLs preserve query strings and native playback');

        await page.click('#video-open-btn');
        await page.waitForFunction(() => document.getElementById('video-element').src.endsWith('/test-1.webm') && document.getElementById('video-element').readyState >= 2);
        const chooser = page.waitForEvent('filechooser');
        await page.click('#video-subtitle-btn');
        await (await chooser).setFiles({ name: 'test.vtt', mimeType: 'text/vtt', buffer: Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nTest subtitle\n') });
        await page.waitForSelector('#video-subtitle-replace-btn', { state: 'visible' });
        await page.locator('#video-panel').evaluate(el => { el.style.width = '280px'; });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const narrowLayout = await page.locator('#video-panel-header').evaluate(el => Array.from(el.children).map(c => ({
            id:c.id, width:c.getBoundingClientRect().width, left:c.getBoundingClientRect().left,
            right:c.getBoundingClientRect().right, display:getComputedStyle(c).display
        })));
        for (const id of ['video-url-btn', 'video-next-btn', 'video-subtitle-replace-btn', 'video-close-btn']) {
            assert(await page.locator('#' + id).evaluate(el => {
                const p = el.closest('#video-panel').getBoundingClientRect(), r = el.getBoundingClientRect();
                return r.left >= p.left && r.right <= p.right;
            }), `${id} must fit at minimum width: ${JSON.stringify(narrowLayout)}`);
        }
        await page.click('#video-url-btn');
        assert(await page.locator('#video-url-input').isVisible());
        assert(await page.locator('#video-url-submit').evaluate(el => el.getBoundingClientRect().right <= el.closest('#video-panel').getBoundingClientRect().right));
        if (process.env.READER_TEST_ARTIFACTS === '1') {
            fs.mkdirSync(resultsDir, { recursive: true });
            await page.locator('#video-panel').screenshot({ path: path.join(resultsDir, 'video-online-compact.png') });
            await page.locator('#video-panel').evaluate(el => { el.style.width = '560px'; el.style.height = '353px'; });
            mode = 'success'; await openUrl();
            await waitEpisode(102);
            await page.locator('#video-panel').screenshot({ path: path.join(resultsDir, 'video-online-player.png') });
        }
        assert.deepEqual(errors, []);
        console.log('PASS all buttons and input fit at 280px, local subtitles still work, no browser errors');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
