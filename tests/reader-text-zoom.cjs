// 文本块缩放：保留真实排版与图片节点，覆盖多图缓存、异步加载和缩放后的手势。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, loadFixture, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({ 'a.pdf': await fixture('text', 3) });
    let browser;
    const errors = [], requests = [];
    let finishSlow;
    const slow = new Promise(resolve => { finishSlow = resolve; });
    try {
        browser = await chromium.launch({
            executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            headless: true
        });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
        page.on('pageerror', error => errors.push(String(error)));
        if (process.env.READER_TEST_RENDER_SOURCE) {
            await page.route('**/js/render.js*', route => route.fulfill({
                contentType: 'text/javascript', body: fs.readFileSync(process.env.READER_TEST_RENDER_SOURCE)
            }));
        }
        await page.route('**/api/render-tikz', async route => {
            const source = route.request().postData();
            requests.push(source);
            if (source.includes('SLOW')) await slow;
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48" viewBox="0 0 120 48"><path d="M4 44L60 4L116 44Z" fill="none" stroke="blue"/></svg>';
            await route.fulfill({ contentType: 'text/plain', body: Buffer.from(svg).toString('base64') });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.evaluate(() => {
            const picture = label => String.raw`\begin{tikzpicture}\node {${label}};\end{tikzpicture}`;
            state.annotations[1] = [
                { id: 'mixed', type: 'text', x: .08, y: .12, color: '#000000', fontSizeScale: 1.7,
                    text: '多图与公式 $x^2+\\frac{1}{3}$\n' + picture('A') + '\n中间文字\n' + picture('B') },
                { id: 'single', type: 'text', x: .62, y: .1, color: '#000000', text: picture('C') },
                { id: 'formula', type: 'text', x: .1, y: .54, color: '#000000', fontSizeScale: 1.9,
                    text: '行内 $\\frac{x^2}{1+y}$\n$$\\int_0^1 x^2 dx = \\frac13$$' },
                { id: 'manual', type: 'text', x: .58, y: .6, width: .3, height: .08,
                    color: '#000000', text: '缩放后仍可拖动和调整大小' }
            ];
            renderAnnotations(1, true);
            initHistory();
        });
        await page.waitForFunction(() => document.querySelectorAll('#annotation-layer-1 img').length === 3 &&
            [...document.querySelectorAll('#annotation-layer-1 img')].every(img => img.complete && img.naturalHeight));
        await page.evaluate(() => {
            window.zoomNodes = [...document.querySelectorAll('#annotation-layer-1 .text-annotation, #annotation-layer-1 img, #annotation-layer-1 .katex')];
            window.zoomFlashes = 0;
            window.zoomObserver = new MutationObserver(() => {
                if (document.getElementById('annotation-layer-1').textContent.includes('渲染图形中')) zoomFlashes++;
            });
            zoomObserver.observe(document.getElementById('annotation-layer-1'), { childList: true, subtree: true });
        });
        const geometry = () => page.evaluate(() => {
            const wrapper = document.getElementById('page-wrapper-1').getBoundingClientRect();
            return zoomNodes.map(node => {
                const rect = node.getBoundingClientRect();
                return { connected: node.isConnected,
                    box: [(rect.left - wrapper.left) / state.scale, (rect.top - wrapper.top) / state.scale,
                        rect.width / state.scale, rect.height / state.scale] };
            });
        });
        const stable = (actual, expected) => {
            assert.equal(actual.length, expected.length);
            actual.forEach((entry, i) => {
                assert.equal(entry.connected, true, `缩放销毁了第 ${i} 个已渲染节点`);
                entry.box.forEach((value, j) => assert.ok(Math.abs(value - expected[i].box[j]) < .08,
                    `节点 ${i} 的几何 ${j} 漂移：${value} vs ${expected[i].box[j]}`));
            });
        };
        const baseline = await geometry();
        for (const scale of [1.17, 2.33, .67, 3, 1]) {
            await page.evaluate(scale => updateZoom(scale), scale);
            stable(await geometry(), baseline);
            await page.waitForFunction(() => !state.isZooming);
            stable(await geometry(), baseline);
        }
        assert.equal(await page.evaluate(() => zoomFlashes), 0);
        assert.equal(requests.length, 3);
        console.log('PASS 多图、单图和公式在连续缩放中保留节点，无加载闪烁和排版漂移');

        // 撤销或恢复导致节点重建时，多图也直接显示已完成的缓存。
        const rebuilt = await page.evaluate(() => {
            zoomObserver.disconnect();
            for (const entry of TIKZ_CACHE.values()) delete entry.imgH;
            document.querySelector('[data-id="mixed"]').remove();
            renderAnnotations(1, true);
            const div = document.querySelector('[data-id="mixed"]');
            return { images: div.querySelectorAll('img').length, pending: div.textContent.includes('渲染图形中') };
        });
        assert.deepEqual(rebuilt, { images: 2, pending: false });
        await page.waitForFunction(() => [...document.querySelectorAll('[data-id="mixed"] img')]
            .every(img => img.complete && img.naturalHeight && img.style.height.endsWith('em')));
        const imageHeight = await page.locator('[data-id="mixed"] img').first().evaluate(img => img.getBoundingClientRect().height);
        assert.ok(Math.abs(imageHeight - 48 * 1.7) < .08, `共享缓存的图形高度 ${imageHeight}`);
        assert.equal(requests.length, 3);
        console.log('PASS 多张 TikZ 重建时同步命中缓存，共享缓存图形按文本字号显示');

        await page.evaluate(() => {
            state.annotations[1].push({ id: 'slow', type: 'text', x: .58, y: .28, color: '#000000',
                fontSizeScale: 1.6, text: String.raw`\begin{tikzpicture}\node {SLOW};\end{tikzpicture}` });
            renderAnnotations(1, true);
            window.slowNode = document.querySelector('[data-id="slow"]');
        });
        await page.waitForFunction(() => slowNode.textContent.includes('渲染图形中'));
        const pendingGeometry = () => page.evaluate(() => {
            const r = slowNode.getBoundingClientRect(), wrapper = document.getElementById('page-wrapper-1').getBoundingClientRect();
            return [{ connected: slowNode.isConnected, box: [(r.left - wrapper.left) / state.scale,
                (r.top - wrapper.top) / state.scale, r.width / state.scale, r.height / state.scale] }];
        });
        const pendingBaseline = await pendingGeometry();
        for (const scale of [1.6, .8, 2.4, 1]) {
            await page.evaluate(scale => updateZoom(scale), scale);
            stable(await pendingGeometry(), pendingBaseline);
            await page.waitForFunction(() => !state.isZooming);
            stable(await pendingGeometry(), pendingBaseline);
        }
        assert.equal(requests.filter(source => source.includes('SLOW')).length, 1);
        finishSlow();
        await page.waitForFunction(() => slowNode.querySelector('img')?.naturalHeight > 0);
        assert.equal(await page.evaluate(() => slowNode === document.querySelector('[data-id="slow"]')), true);
        console.log('PASS 慢速编译期间文本框按同一比例固定在页面中，缩放不重建也不重复请求');

        // 已完成图形即使退出编译缓存，单纯缩放仍不重新请求。
        await page.evaluate(() => { TIKZ_CACHE.clear(); updateZoom(1.8); });
        await page.waitForFunction(() => !state.isZooming);
        assert.equal(requests.length, 4);
        await page.evaluate(() => {
            const a = state.annotations[1].find(a => a.id === 'manual');
            createSidebarAnnoDom(a, 1, text => text || '').click();
        });
        await page.waitForFunction(() => document.querySelector('#page-wrapper-1 > div[style*="z-index: 99999"]'));
        const highlight = await page.evaluate(() => {
            const frame = document.querySelector('#page-wrapper-1 > div[style*="z-index: 99999"]').getBoundingClientRect();
            const text = document.querySelector('[data-id="manual"]').getBoundingClientRect();
            return [frame.width - text.width, frame.height - text.height];
        });
        assert.ok(highlight.every(padding => Math.abs(padding - 24) < .1));
        await page.locator('[data-id="manual"]').scrollIntoViewIfNeeded();
        const rect = async () => page.locator('[data-id="manual"]').boundingBox();
        const beforeMove = await rect();
        await page.mouse.move(beforeMove.x + 12, beforeMove.y + 8);
        await page.mouse.down();
        await page.mouse.move(beforeMove.x + 32, beforeMove.y + 20, { steps: 5 });
        const floating = await page.evaluate(() => {
            const r = draggingElement.getBoundingClientRect(); return { w: r.width, h: r.height };
        });
        assert.ok(Math.abs(floating.w - beforeMove.width) < .1 && Math.abs(floating.h - beforeMove.height) < .1);
        await page.mouse.up();
        const moved = await rect();
        assert.ok(Math.abs(moved.x - beforeMove.x - 20) < 1 && Math.abs(moved.y - beforeMove.y - 12) < 1);
        await page.mouse.move(moved.x + moved.width - 6, moved.y + moved.height - 6);
        await page.mouse.down();
        await page.mouse.move(moved.x + moved.width + 26, moved.y + moved.height + 12, { steps: 6 });
        await page.mouse.up();
        const resized = await rect();
        assert.ok(Math.abs(resized.width - moved.width - 32) < 1 && Math.abs(resized.height - moved.height - 18) < 1);
        const saved = await page.evaluate(() => {
            const a = state.annotations[1].find(a => a.id === 'manual');
            const r = document.querySelector('[data-id="manual"]').getBoundingClientRect();
            const w = document.getElementById('page-wrapper-1').getBoundingClientRect();
            return [r.width / w.width - a.width, r.height / w.height - a.height];
        });
        assert.ok(saved.every(delta => Math.abs(delta) < .001));
        console.log('PASS 缓存淘汰后缩放无需编译；定位高亮、拖动预览、位置和尺寸落库正确');
        assert.deepEqual(errors, []);
    } finally {
        finishSlow();
        await browser?.close();
        server.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
