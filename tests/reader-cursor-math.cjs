// 复现/回归：光标停在公式里时关闭编辑框，公式必须照常渲染，不能只剩源码。
// 幻影光标会把 $$…$$ / $…$ 包进一个节点，若画布带着这份注入后的 HTML 被重绘，
// KaTeX 就再也认不出定界符（只留下 data-katex-pending 和裸 $ 源码）。
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

        // 画布上这个文本块的公式渲染状态
        async function mathState() {
            return page.evaluate(() => {
                const div = document.querySelector('.text-annotation');
                if (!div) return { missing: true };
                const text = div.textContent;
                return {
                    katex: div.querySelectorAll('.katex').length,
                    errors: div.querySelectorAll('.katex-error').length,
                    pending: div.querySelectorAll('[data-katex-pending]').length,
                    raw: /\$\$[\s\S]*?\$\$|\$[^$]*\$/.test(text),
                    phantom: div.querySelectorAll('#phantom-cursor, #phantom-cursor-block').length,
                    text: text,
                };
            });
        }

        async function seed(text) {
            await page.evaluate(text => {
                clearTimeout(state.livePreviewTimer);
                els.noteModal.classList.add('hidden');
                state.activeAnnotationId = null;
                state.isEditingNote = false;
                state.originalAnnoSnapshot = null;
                state.annotations[1] = [{ id: 'math-box', type: 'text', color: '#000000', x: .06, y: .10, width: .5, fontSizeScale: 2, text }];
                renderAnnotations(1, true);
                state.history.length = 0;
                state.historyIndex = -1;
            }, text);
            await page.locator('.text-annotation').scrollIntoViewIfNeeded();
            await page.waitForTimeout(150);
        }

        async function clickBox() {
            const box = await page.locator('.text-annotation').boundingBox();
            await page.mouse.click(box.x + 10, box.y + 8);
            await page.waitForTimeout(150);
        }

        // 真实点击公式渲染结果内部，把输入框光标放进公式里。
        async function clickInsideMath(which = 0) {
            const rect = await page.locator('.text-annotation .katex').nth(which).boundingBox();
            await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
            await page.waitForTimeout(200);
        }

        // 把输入框光标确定性地放进公式内部（模拟用户在公式里点了/移动了光标）。
        async function setCaretInsideFormula(source, offset = 2) {
            const target = source.indexOf('$') + offset;
            await page.evaluate(index => {
                els.noteInput.focus();
                els.noteInput.setSelectionRange(index, index);
                els.noteInput.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof window.syncVirtualCursor === 'function') window.syncVirtualCursor();
            }, target);
            await page.waitForTimeout(250);
            return target;
        }

        async function cursorInsideFormula() {
            return page.evaluate(() => {
                const value = els.noteInput.value, index = els.noteInput.selectionStart;
                const blocks = [];
                const re = /\$\$[\s\S]*?\$\$|\$[\s\S]*?\$/g;
                let m;
                while ((m = re.exec(value)) !== null) blocks.push([m.index, re.lastIndex]);
                return { index, text: value, inside: blocks.some(([s, e]) => index >= s && index <= e) };
            });
        }

        const blockMath = 'head $$x^2 + y^2 = z^2$$ tail';
        const inlineMath = 'head $a+b$ tail';

        for (const [label, source] of [['块级 $$…$$', blockMath], ['行内 $…$', inlineMath]]) {
            // 两条退出路径：点「确定」退回预览（弹窗还在，只是不再编辑），或点画布空白处关闭弹窗。
            for (const close of ['save', 'outside']) {
                await seed(source);
                await clickBox();
                await setCaretInsideFormula(source, 2); // 把光标放进公式内部
                const caret = await cursorInsideFormula();
                assert.equal(caret.inside, true, label + ' 光标未进入公式：' + JSON.stringify(caret));
                const dirty = await mathState();
                assert.equal(dirty.phantom, 1, label + ' 公式内应注入幻影节点：' + JSON.stringify(dirty));

                if (close === 'save') await page.locator('#save-note-btn').click();
                else await page.mouse.click(1420, 880);
                await page.waitForTimeout(350);

                const after = await mathState();
                const modalState = await page.evaluate(() => ({ hidden: els.noteModal.classList.contains('hidden'), editing: state.isEditingNote }));
                assert.equal(after.katex, 1, label + ' / ' + close + ' 关闭后公式未重新渲染：' + JSON.stringify(after));
                assert.equal(after.pending, 0, label + ' / ' + close + ' 留下未完成的 KaTeX 标记：' + JSON.stringify(after));
                assert.equal(after.raw, false, label + ' / ' + close + ' 画布上残留公式源码：' + JSON.stringify(after));
                assert.equal(after.phantom, 0, label + ' / ' + close + ' 残留幻影节点：' + JSON.stringify(after));
                assert.equal(modalState.editing, false, label + ' / ' + close + ' 仍处于编辑态：' + JSON.stringify(modalState));
                // 点「确定」只是退回预览，弹窗仍在；点外部才连弹窗一起关掉。
                assert.equal(modalState.hidden, close === 'outside', label + ' / ' + close + ' 弹窗状态不对：' + JSON.stringify(modalState));
            }
            pass('光标停在' + label + '公式里时关闭编辑（保存 / 点外部），公式仍正常渲染');
        }

        // 鼠标直接点公式渲染结果：同样不能把公式弄丢。（行内公式的点击中心落在公式内部）
        await seed(inlineMath);
        await clickBox();
        await clickInsideMath(0);
        const byMouse = await cursorInsideFormula();
        assert.equal(byMouse.inside, true, '鼠标点击公式后光标未进入公式：' + JSON.stringify(byMouse));
        await page.locator('#save-note-btn').click();
        await page.waitForTimeout(350);
        const mouseAfter = await mathState();
        assert.equal(mouseAfter.katex, 1, '鼠标点进公式后关闭，公式丢失：' + JSON.stringify(mouseAfter));
        assert.equal(mouseAfter.raw, false, JSON.stringify(mouseAfter));
        pass('鼠标点进公式后关闭编辑，公式仍正常渲染');

        // 光标停在公式里然后「取消」：回滚后同样要重新渲染。
        await seed(blockMath);
        await clickBox();
        await setCaretInsideFormula(blockMath, 3);
        assert.equal((await cursorInsideFormula()).inside, true);
        await page.locator('#toggle-edit-btn').click();
        await page.waitForTimeout(350);
        const cancelAfter = await mathState();
        assert.equal(cancelAfter.katex, 1, '取消后公式丢失：' + JSON.stringify(cancelAfter));
        assert.equal(cancelAfter.raw, false, JSON.stringify(cancelAfter));
        pass('光标停在公式里时取消编辑，公式仍正常渲染');

        // 公式里打字（含 TikZ 的 300ms 防抖路径）后立刻关闭，也不能把公式弄坏。
        await seed(blockMath);
        await clickBox();
        await setCaretInsideFormula(blockMath, 2);
        await page.keyboard.type('1');
        await page.locator('#save-note-btn').click(); // 不等防抖完成就关
        await page.waitForTimeout(450);
        const early = await mathState();
        assert.equal(early.katex, 1, '防抖未完成就关闭，公式丢失：' + JSON.stringify(early));
        assert.equal(early.raw, false, JSON.stringify(early));
        // 注意：replace 的替换串里 $$ 表示一个字面 $，要输出两个 $ 得写 $$$$
        assert.equal(await page.evaluate(() => state.annotations[1][0].text), blockMath.replace('$$x', '$$$$1x'), '公式内打字的字符未落到公式里');
        pass('公式内打字后不等防抖就关闭编辑，内容落库且公式正常渲染');

        // 两个公式：光标停在第二个里，关闭后两个都要在。
        const twoMath = 'first $p$ middle $$q+r$$ last';
        await seed(twoMath);
        await clickBox();
        await page.evaluate(() => {
            // 行内公式 $p$ 在前，块级公式 $$q+r$$ 在后：从开头找 $$ 命中的就是块级公式的开定界符。
            const value = els.noteInput.value;
            const index = value.indexOf('$$') + 2;
            els.noteInput.focus();
            els.noteInput.setSelectionRange(index, index);
            els.noteInput.dispatchEvent(new Event('input', { bubbles: true }));
            if (typeof window.syncVirtualCursor === 'function') window.syncVirtualCursor();
        });
        await page.waitForTimeout(250);
        assert.equal((await cursorInsideFormula()).inside, true, '光标未落在第二个公式内');
        await page.locator('#save-note-btn').click();
        await page.waitForTimeout(350);
        const both = await mathState();
        assert.equal(both.katex, 2, '多公式场景关闭后渲染数量不对：' + JSON.stringify(both));
        assert.equal(both.raw, false, JSON.stringify(both));
        pass('同一文本块内多个公式，关闭编辑后全部正常渲染');

        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
