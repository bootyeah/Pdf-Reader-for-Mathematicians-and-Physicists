// 文本块内容自适应：用真实排版验证输入、字号、公式、持久化及撤销，使用临时 PDF。
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, loadFixture, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({ 'a.pdf': await fixture('text', 3) });
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const errors = [];
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.evaluate(() => {
            state.annotations[1] = [{ id: 'fit', type: 'text', color: '#000000', x: .1, y: .16, width: .13, height: .025, fontSizeScale: 2, text: '原来的文字' }];
            renderAnnotations(1, true);
            initHistory();
        });
        const open = () => page.evaluate(() => {
            const a = state.annotations[1].find(a => a.id === 'fit');
            openNoteModal({ ...a, note: a.text }, 1, 950, 150, true);
        });
        const snap = () => page.evaluate(() => {
            const d = document.querySelector('.text-annotation[data-id="fit"]');
            const a = state.annotations[1].find(a => a.id === 'fit');
            const r = d.getBoundingClientRect(), cs = getComputedStyle(d);
            const range = document.createRange(); range.selectNodeContents(d);
            const content = range.getBoundingClientRect();
            return {
                w: r.width, h: r.height, font: parseFloat(cs.fontSize), line: parseFloat(cs.lineHeight),
                padW: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight),
                padH: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom), contentW: content.width,
                overflowW: d.scrollWidth - d.clientWidth, overflowH: d.scrollHeight - d.clientHeight,
                ratioW: r.width / parseFloat(d.closest('.page-wrapper').style.width),
                ratioH: r.height / parseFloat(d.closest('.page-wrapper').style.height), anno: { ...a }
            };
        });
        const fits = s => {
            assert.ok(s.overflowW <= 1 && s.overflowH <= 1, `内容被裁切: ${JSON.stringify(s)}`);
            assert.equal(s.anno.width, undefined);
            assert.equal(s.anno.height, undefined);
        };
        const type = async text => {
            await page.locator('#note-input').fill(text);
            await page.waitForTimeout(180);
            const s = await snap(); fits(s); return s;
        };
        const outside = async () => { await page.mouse.click(1400, 750); await page.waitForTimeout(180); };
        const original = await snap();
        await open();
        await page.locator('#font-plus-btn').click();
        fits(await snap());
        assert.equal((await snap()).anno.text, original.anno.text);
        await page.locator('#toggle-edit-btn').click();
        await outside();
        await open();
        const multiline = await type('第一行较长的中文与 English 文字\n第二行：自动增高\n\n最后一行完整显示');
        assert.ok(multiline.h > original.h * 2);
        assert.ok(Math.abs(multiline.h - (multiline.line * 4 + multiline.padH)) < 1);
        const short = await type('短文本');
        assert.ok(short.w < multiline.w && short.h < multiline.h);
        assert.ok(Math.abs(short.w - short.contentW - short.padW) < 1);
        assert.ok(Math.abs(short.h - short.line - short.padH) < 1);
        for (const text of ['内容持续增加且不会锁定为第一次测量的尺寸', '又缩短', '再增加一整段文字验证边框仍然实时扩展\n再加一行', '短文本']) await type(text);
        console.log('PASS 固定旧框输入后自动贴合；多行、空行、重复增加和删除都完整显示');

        for (let i = 0; i < 4; i++) await page.locator('#font-plus-btn').click();
        await page.waitForTimeout(100);
        const larger = await snap(); fits(larger);
        assert.ok(larger.font > short.font && larger.w > short.w && larger.h > short.h);
        for (let i = 0; i < 4; i++) await page.locator('#font-minus-btn').click();
        await page.waitForTimeout(100);
        const smaller = await snap(); fits(smaller);
        assert.ok(Math.abs(smaller.w - short.w) < 1 && Math.abs(smaller.h - short.h) < 1);
        console.log('PASS A+/A- 同步调整字体和边框，缩回后没有多余空白');

        await page.locator('#toggle-edit-btn').click();
        await page.waitForTimeout(100);
        const cancelled = await snap();
        assert.equal(cancelled.anno.text, original.anno.text);
        assert.equal(cancelled.anno.width, original.anno.width);
        assert.equal(cancelled.anno.height, original.anno.height);
        assert.equal(cancelled.anno.fontSizeScale, original.anno.fontSizeScale);
        await outside();
        await open();
        await type('保存后的内容应当完整显示\n第二行');
        await page.locator('#font-plus-btn').click();
        await outside();
        const saved = await snap(); fits(saved);
        const stored = await page.evaluate(async () => (await localforage.getItem(`pdf_annos_${state.fingerprint}`))[1].find(a => a.id === 'fit'));
        assert.equal(stored.text, saved.anno.text);
        assert.equal(stored.width, undefined); assert.equal(stored.height, undefined);
        assert.equal(stored.fontSizeScale, saved.anno.fontSizeScale);
        await page.evaluate(() => undo());
        const undone = await snap();
        for (const key of ['text', 'width', 'height', 'fontSizeScale']) assert.equal(undone.anno[key], original.anno[key]);
        await page.evaluate(() => redo());
        const redone = await snap(); fits(redone);
        assert.equal(redone.anno.text, saved.anno.text);
        assert.equal(redone.anno.fontSizeScale, saved.anno.fontSizeScale);
        console.log('PASS 取消、外部保存、本地存储、撤销/重做同步保留内容和尺寸状态');

        await open();
        await type('还没等预览就保存的长内容\n第二行\n第三行');
        await page.evaluate(() => {
            els.noteInput.value = '立即保存\n不能被旧尺寸截断';
            els.noteInput.dispatchEvent(new Event('input', { bubbles: true }));
            els.saveNoteBtn.click();
        });
        await outside(); fits(await snap());
        await open();
        const long = await type('这是一段需要在页面剩余宽度内自动换行的内容 English '.repeat(16));
        assert.ok(long.ratioW <= .901 && long.h > long.line * 3);
        await type('LongWord'.repeat(80));
        assert.ok((await snap()).ratioW <= .901);
        console.log('PASS 长段落及无空格长串自动换行，快速保存同样自适应');

        await type('行内 $x^2+1$ 与公式\n$$\\frac{\\sum_{i=1}^n i^2}{\\sqrt{1+x^2}}$$\n公式后的完整末行');
        await outside();
        const math = await snap(); fits(math);
        assert.equal(await page.locator('.text-annotation .katex').count(), 2);
        const base = await snap();
        for (const scale of [.5, 2, 3, 1]) {
            await page.evaluate(scale => updateZoom(scale), scale);
            await page.waitForTimeout(650);
            const zoomed = await snap(); fits(zoomed);
            assert.ok(Math.abs(zoomed.ratioW - base.ratioW) < .001);
            assert.ok(Math.abs(zoomed.ratioH - base.ratioH) < .001);
        }
        console.log('PASS 行内/独立公式完整显示，50%～300% 页面缩放不锁定或漂移');

        await page.route('**/api/render-tikz', async route => {
            await new Promise(resolve => setTimeout(resolve, 200));
            await route.fulfill({ contentType: 'text/plain', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="lightblue"/></svg>').toString('base64') });
        });
        await open();
        await page.locator('#note-input').fill('图形上方\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\n图形下方');
        await page.waitForFunction(() => {
            const img = document.querySelector('.text-annotation img');
            return img && img.complete && img.naturalHeight === 90;
        });
        fits(await snap());
        await outside();
        await page.waitForTimeout(250);
        const graphic = await snap(); fits(graphic);
        assert.ok(graphic.h > 160 && graphic.w >= 300);
        await page.locator('.text-annotation[data-id="fit"]').screenshot({ path: path.join(resultsDir, 'text-autofit.png') });
        console.log('PASS 异步图形加载后边框继续自适应，不裁掉图片及下方文字');

        await open();
        await type('手动调整边框后继续输入');
        await outside();
        const beforeDrag = await snap();
        const box = await page.locator('.text-annotation[data-id="fit"]').boundingBox();
        await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width + 40, box.y + box.height + 30, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(250);
        const manual = await snap();
        assert.ok(manual.w > beforeDrag.w + 30 && manual.h > beforeDrag.h + 20);
        assert.ok(manual.anno.width > 0 && manual.anno.height > 0);
        await open();
        const resumed = await type('重新贴合');
        assert.ok(resumed.w < manual.w && resumed.h < manual.h);
        await outside();
        console.log('PASS 自动框仍可手动拖动尺寸，下一次输入恢复内容自适应');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
