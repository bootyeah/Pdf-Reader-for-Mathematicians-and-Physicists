// 真实右键事件验证预览 -> 源码光标定位，以及已有编辑、取消和保存语义。
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, loadFixture, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({ 'a.pdf': await fixture('text', 2) });
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        const pass = message => console.log('PASS ' + message);
        const selector = '.text-annotation[data-id="cursor-box"]';

        async function seed(text, extra = {}) {
            await page.evaluate(({ text, extra }) => {
                clearTimeout(state.livePreviewTimer);
                els.noteModal.classList.add('hidden');
                state.activeAnnotationId = null;
                state.isEditingNote = false;
                state.originalAnnoSnapshot = null;
                state.annotations[1] = [{ id: 'cursor-box', type: 'text', color: '#000000', x: .08, y: .12,
                    width: .45, fontSizeScale: 2, text, ...extra }];
                renderAnnotations(1, true);
                state.history.length = 0;
                state.historyIndex = -1;
            }, { text, extra });
            await page.locator(selector).scrollIntoViewIfNeeded();
            await page.waitForTimeout(100);
        }

        async function textPoint(needle, local = 0, side = .15) {
            return page.evaluate(({ selector, needle, local, side }) => {
                const div = document.querySelector(selector);
                const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    if (node.parentElement.closest('.katex, .katex-error, .ignored-by-katex, #phantom-cursor')) continue;
                    const start = node.data.indexOf(needle);
                    if (start < 0) continue;
                    const range = document.createRange();
                    range.setStart(node, start + local);
                    range.setEnd(node, start + local + (node.data.codePointAt(start + local) > 0xffff ? 2 : 1));
                    const rect = range.getBoundingClientRect();
                    return { x: rect.left + rect.width * side, y: rect.top + rect.height / 2 };
                }
                throw new Error('找不到文字：' + needle);
            }, { selector, needle, local, side });
        }

        async function rightClick(point, expected, expectedText) {
            await page.mouse.click(point.x, point.y, { button: 'right' });
            await page.waitForTimeout(100);
            const result = await page.evaluate(() => ({
                start: els.noteInput.selectionStart, end: els.noteInput.selectionEnd,
                focused: document.activeElement === els.noteInput,
                editing: state.isEditingNote && !els.noteModal.classList.contains('hidden'),
                text: els.noteInput.value, dragging: state.draggingText.isPressed,
            }));
            assert.equal(result.start, expected, JSON.stringify(result));
            assert.equal(result.end, expected);
            assert.equal(result.focused, true);
            assert.equal(result.editing, true);
            assert.equal(result.dragging, false);
            if (expectedText !== undefined) assert.equal(result.text, expectedText);
            // 为下一次真实点击腾出空间，不改变被测文本块的位置。
            await page.evaluate(() => { els.noteModal.style.left = '1080px'; els.noteModal.style.top = '100px'; });
        }

        const plain = '甲乙丙 ABCDE & <tag>\n第二行 😀 tail end';
        await seed(plain);
        await rightClick(await textPoint('ABCDE', 2), plain.indexOf('C'), plain);
        await rightClick(await textPoint('tail', 2, .85), plain.indexOf('tail') + 3, plain);
        await rightClick(await textPoint('😀', 0, .85), plain.indexOf('😀') + 2, plain);
        assert.equal(await page.evaluate(() => state.history.length), 0);
        pass('右键打开编辑并精确定位中英文、换行、HTML 字符和 emoji，不产生撤销记录');

        await rightClick(await textPoint('<tag>', 2), plain.indexOf('<tag>') + 2, plain);
        await page.keyboard.type('NEW');
        const edited = plain.slice(0, plain.indexOf('<tag>') + 2) + 'NEW' + plain.slice(plain.indexOf('<tag>') + 2);
        await page.waitForTimeout(100);
        await rightClick(await textPoint('tail', 1), edited.indexOf('tail') + 1, edited);
        await page.locator('#toggle-edit-btn').click();
        assert.equal(await page.evaluate(() => state.annotations[1][0].text), plain);
        pass('右键后可直接输入；再次定位保留未保存内容，取消仍回滚到首次编辑前');

        const math = 'before $x^2$ middle $$\\frac{a}{b}$$ after $x^2$ end \\(q+1\\) more \\[r^2\\] last';
        await seed(math);
        await rightClick(await textPoint('last', 2), math.indexOf('last') + 2, math);
        for (const [i, start] of [math.indexOf('$x^2$'), math.indexOf('$$'), math.lastIndexOf('$x^2$'), math.indexOf('\\('), math.indexOf('\\[')].entries()) {
            const rect = await page.locator(selector + ' .katex').nth(i).boundingBox();
            await rightClick({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, start, math);
            assert.equal(await page.locator(selector + ' .katex').count(), 5);
        }
        await rightClick(await textPoint('middle', 3), math.indexOf('middle') + 3, math);
        await rightClick(await textPoint('after', 3), math.indexOf('after') + 3, math);
        pass('四种公式定界符、重复公式及公式前后文字均对应正确源码位置，公式渲染保持完整');

        const brokenMath = 'head $\\frac{a}$ tail';
        await seed(brokenMath);
        await rightClick(await textPoint('tail', 2), brokenMath.indexOf('tail') + 2, brokenMath);
        const errorRect = await page.locator(selector + ' .katex-error').boundingBox();
        await rightClick({ x: errorRect.x + 5, y: errorRect.y + errorRect.height / 2 }, brokenMath.indexOf('$'), brokenMath);
        pass('未成功编译的公式也能定位，后续文字偏移不受影响');

        const wrapped = 'wrap words '.repeat(8) + '\n\nfinal line';
        await seed(wrapped, { width: .23 });
        await rightClick(await textPoint('wrap words '.repeat(8), 60), 60, wrapped);
        await rightClick(await textPoint('final', 3), wrapped.indexOf('final') + 3, wrapped);
        for (const scale of [.5, 2, 1]) {
            await page.evaluate(scale => updateZoom(scale), scale);
            await page.waitForTimeout(650);
            await page.locator(selector).scrollIntoViewIfNeeded();
            await rightClick(await textPoint('final', 2), wrapped.indexOf('final') + 2, wrapped);
        }
        pass('自动折行、空行、页面缩放和滚动后仍定位正确');

        await seed('first\n\nthird\n');
        const blankPoint = await page.evaluate(selector => {
            const node = document.querySelector(selector).firstChild;
            const range = document.createRange();
            range.setStart(node, 6); range.setEnd(node, 7);
            const rect = range.getBoundingClientRect();
            return { x: rect.left + 1, y: rect.top + rect.height / 2 };
        }, selector);
        await rightClick(blankPoint, 6, 'first\n\nthird\n');
        pass('右键空行对应输入框的空行位置');

        const longText = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} content`).join('\n');
        await seed(longText);
        await rightClick(await textPoint('Line 1 ', 2), 2, longText);
        await page.evaluate(() => { els.noteInput.scrollTop = 0; });
        await rightClick(await textPoint('Line 20 ', 2), longText.indexOf('Line 20 ') + 2, longText);
        assert.ok(await page.evaluate(() => els.noteInput.scrollTop > 0), '长文本输入框应滚动到新的光标位置');
        await rightClick(await textPoint('Line 1 ', 2), 2, longText);
        assert.ok(await page.evaluate(() => els.noteInput.scrollTop < parseFloat(getComputedStyle(els.noteInput).lineHeight)), '返回首行时首行应可见');
        pass('长文本输入框随光标定位滚动到对应内容');

        await seed('alpha beta gamma');
        await rightClick(await textPoint('alpha', 1), 1);
        const stalePoint = await textPoint('gamma', 2);
        await page.evaluate(() => {
            els.noteInput.value = 'NEW alpha beta gamma';
            els.noteInput.dispatchEvent(new Event('input', { bubbles: true }));
            clearTimeout(state.livePreviewTimer); // 保持旧预览，模拟防抖尚未完成。
        });
        await rightClick(stalePoint, 'NEW alpha beta ga'.length, 'NEW alpha beta gamma');
        await page.mouse.click(1420, 850);
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => state.annotations[1][0].text), 'NEW alpha beta gamma');
        assert.equal(await page.evaluate(() => els.noteModal.classList.contains('hidden')), true);
        pass('预览滞后时按新输入换算光标，点击外部仍正常保存');

        await seed('first block');
        await rightClick(await textPoint('first', 1), 1);
        await page.keyboard.type('EDIT');
        await page.waitForTimeout(100);
        await page.evaluate(() => {
            addAnnotation(1, { id: 'other-box', type: 'text', color: '#000000', x: .65, y: .35,
                text: 'second block', fontSizeScale: 2 });
            renderAnnotations(1, true);
        });
        const other = await page.locator('.text-annotation[data-id="other-box"]').boundingBox();
        await page.mouse.click(other.x + 8, other.y + 8, { button: 'right' });
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => state.activeAnnotationId), 'other-box');
        assert.equal(await page.evaluate(() => els.noteInput.value), 'second block');
        assert.equal(await page.evaluate(() => state.annotations[1].find(a => a.id === 'cursor-box').text), 'fEDITirst block');
        assert.equal(await page.evaluate(async () => (await localforage.getItem(`pdf_annos_${state.fingerprint}`))[1].find(a => a.id === 'cursor-box').text), 'fEDITirst block');
        pass('右键切换到另一文本块时保留并保存上一块的未保存输入');

        const tikz = 'head\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\ntail';
        const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><path d="M0 32L64 0" stroke="black"/></svg>').toString('base64');
        await seed(tikz, { tikzBase64: svg, imgH: 32 });
        const tikzRect = await page.locator(selector + ' .ignored-by-katex').boundingBox();
        await rightClick({ x: tikzRect.x + tikzRect.width / 2, y: tikzRect.y + tikzRect.height / 2 }, tikz.indexOf('\\begin'), tikz);
        await page.waitForTimeout(400);
        await rightClick(await textPoint('tail', 2), tikz.indexOf('tail') + 2, tikz);
        pass('编译图形定位到源码块，图形之后的文字偏移正确');

        await seed('');
        const emptyRect = await page.locator(selector).boundingBox();
        await rightClick({ x: emptyRect.x + 10, y: emptyRect.y + 8 }, 0, '');
        pass('空文本块定位到开头');
        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
