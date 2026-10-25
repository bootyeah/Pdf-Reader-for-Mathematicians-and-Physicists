// 复现/回归：编辑框光标（虚拟红光标）只能跟随"当前正在编辑的那个文本块"。
// 场景来自用户报告：编辑块 A 后关闭，再打开块 B 时红光标停在块 A 上；
// 缩放页面（重排）后才恢复正常。
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

        // 两个文本块，块 A 和块 B 都在页 1，保证两者都在视口里可比对坐标。
        await page.evaluate(() => {
            clearTimeout(state.livePreviewTimer);
            els.noteModal.classList.add('hidden');
            state.activeAnnotationId = null;
            state.isEditingNote = false;
            state.originalAnnoSnapshot = null;
            state.annotations[1] = [
                { id: 'box-a', type: 'text', color: '#000000', x: .06, y: .10, width: .38, fontSizeScale: 2, text: 'alpha alpha alpha' },
                { id: 'box-b', type: 'text', color: '#000000', x: .58, y: .42, width: .38, fontSizeScale: 2, text: 'bravo bravo bravo' },
            ];
            renderAnnotations(1, true);
            state.history.length = 0;
            state.historyIndex = -1;
        });
        await page.locator('.text-annotation[data-id="box-a"]').scrollIntoViewIfNeeded();
        await page.waitForTimeout(120);

        // 真实点击文本块：弹窗打开并进入编辑态（与 render.js 的 click 处理器同一路径）。
        async function clickBox(id) {
            const box = await page.locator(`.text-annotation[data-id="${id}"]`).boundingBox();
            await page.mouse.click(box.x + 10, box.y + 8);
            await page.waitForTimeout(120);
        }

        // 光标/幻影节点状态探针：不依赖 data-id（幻影注入会重写 innerHTML 把它抹掉），
        // 改用渲染层自己维护的源码映射 textAnnotationSources 指认文本块。
        async function readCursor(idA, idB) {
            return page.evaluate(({ idA, idB }) => {
                const divOf = id => {
                    const anno = (state.annotations[1] || []).concat(state.annotations[2] || []).find(a => a.id === id);
                    if (!anno) return null;
                    const source = (anno.text || '').replace(/\r\n?/g, '\n');
                    for (const div of document.querySelectorAll('.text-annotation')) {
                        if (textAnnotationSources.get(div) === source) return div;
                    }
                    return null;
                };
                const cursor = document.getElementById('virtual-cursor');
                const box = cursor && cursor.style.display !== 'none' ? cursor.getBoundingClientRect() : null;
                const inside = rect => !!box && !!rect && box.left >= rect.left - 4 && box.right <= rect.right + 4
                    && box.top >= rect.top - 4 && box.bottom <= rect.bottom + 4;
                const divA = divOf(idA), divB = divOf(idB);
                return {
                    visible: !!box,
                    onA: inside(divA?.getBoundingClientRect()), onB: inside(divB?.getBoundingClientRect()),
                    active: state.activeAnnotationId,
                    editing: state.isEditingNote,
                    anA: !!divA?.querySelector('#phantom-cursor, #phantom-cursor-block'),
                    anB: !!divB?.querySelector('#phantom-cursor, #phantom-cursor-block'),
                };
            }, { idA, idB });
        }

        const save = async () => { await page.locator('#save-note-btn').click(); await page.waitForTimeout(160); };

        // 1) 编辑块 A：光标应在 A 上，且幻影节点只存在于 A。
        await clickBox('box-a');
        await page.keyboard.type('X');
        await page.waitForTimeout(200);
        let seen = await readCursor('box-a', 'box-b');
        assert.equal(seen.active, 'box-a');
        assert.equal(seen.editing, true, JSON.stringify(seen));
        assert.equal(seen.onA, true, JSON.stringify(seen));
        assert.equal(seen.anB, false, JSON.stringify(seen));
        pass('编辑块 A 时光标落在块 A 上');

        // 2) 关闭编辑（点「确定」保存，退回预览态）：不允许在任何块里留下幻影节点。
        await save();
        const leftover = await page.evaluate(() => ({
            editing: state.isEditingNote,
            phantoms: document.querySelectorAll('#phantom-cursor, #phantom-cursor-block').length,
            hidden: document.getElementById('virtual-cursor')?.style.display === 'none',
        }));
        assert.equal(leftover.editing, false);
        assert.equal(leftover.hidden, true, JSON.stringify(leftover));
        assert.equal(leftover.phantoms, 0, '关闭编辑后仍残留幻影光标节点：' + JSON.stringify(leftover));
        pass('关闭编辑后不再残留幻影光标节点');

        // 3) 直接打开块 B：光标必须立刻落在 B 上，而不是停在块 A。
        await clickBox('box-b');
        await page.keyboard.type('Y');
        await page.waitForTimeout(200);
        seen = await readCursor('box-a', 'box-b');
        assert.equal(seen.active, 'box-b');
        assert.equal(seen.editing, true, JSON.stringify(seen));
        assert.equal(seen.anA, false, '块 A 出现了幻影光标：' + JSON.stringify(seen));
        assert.equal(seen.anB, true, JSON.stringify(seen));
        assert.equal(seen.onB, true, '红光标停在了上一个文本块上：' + JSON.stringify(seen));
        pass('切换文本块后光标立刻跟随新块');

        // 4) 块 B 编辑中再点回块 A，同样必须立刻跟随。
        await clickBox('box-a');
        await page.waitForTimeout(200);
        seen = await readCursor('box-a', 'box-b');
        assert.equal(seen.active, 'box-a');
        assert.equal(seen.anB, false, JSON.stringify(seen));
        assert.equal(seen.onA, true, '切回块 A 时光标仍留在块 B：' + JSON.stringify(seen));
        pass('来回切换文本块时光标始终跟随当前块');

        // 5) 取消（回滚）退出后再打开另一块，也不应留下幻影光标。
        await page.locator('#toggle-edit-btn').click();
        await page.waitForTimeout(120);
        await clickBox('box-b');
        await page.waitForTimeout(200);
        seen = await readCursor('box-a', 'box-b');
        assert.equal(seen.onB, true, JSON.stringify(seen));
        assert.equal(seen.anA, false, JSON.stringify(seen));
        pass('取消编辑后再打开另一块，光标仍正确');

        // 6) 跨页切换：页 1 的块编辑后关闭，再编辑页 2 的块，光标不得停在页 1。
        await page.evaluate(() => {
            els.noteModal.classList.add('hidden');
            state.activeAnnotationId = null;
            state.isEditingNote = false;
            state.originalAnnoSnapshot = null;
            state.annotations[2] = [{ id: 'box-c', type: 'text', color: '#000000', x: .06, y: .10, width: .38, fontSizeScale: 2, text: 'charlie charlie' }];
            renderAnnotations(1, true);
            renderAnnotations(2, true);
        });
        await page.locator('.text-annotation[data-id="box-c"]').scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        await clickBox('box-c');
        await page.keyboard.type('Z');
        await page.waitForTimeout(200);
        const crossPage = await page.evaluate(() => {
            const anno = state.annotations[2].find(a => a.id === 'box-c');
            const source = (anno.text || '').replace(/\r\n?/g, '\n');
            let rectC = null;
            for (const div of document.querySelectorAll('.text-annotation')) {
                if (textAnnotationSources.get(div) === source) { rectC = div.getBoundingClientRect(); break; }
            }
            const cursor = document.getElementById('virtual-cursor');
            const box = cursor && cursor.style.display !== 'none' ? cursor.getBoundingClientRect() : null;
            return {
                visible: !!box,
                onC: !!box && !!rectC && box.left >= rectC.left - 4 && box.right <= rectC.right + 4
                    && box.top >= rectC.top - 4 && box.bottom <= rectC.bottom + 4,
                phantoms: document.querySelectorAll('#phantom-cursor, #phantom-cursor-block').length,
            };
        });
        assert.equal(crossPage.onC, true, JSON.stringify(crossPage));
        assert.equal(crossPage.phantoms, 1, '跨页后幻影节点不唯一：' + JSON.stringify(crossPage));
        pass('跨页切换文本块时光标跟随新页的块');

        // 7) 非文本批注（如高亮）弹窗不应绘制文本光标。
        await page.evaluate(() => {
            els.noteModal.classList.add('hidden');
            state.activeAnnotationId = null;
            state.isEditingNote = false;
            state.originalAnnoSnapshot = null;
            state.annotations[1].push({ id: 'hl', type: 'highlight', color: '#fde047', note: 'note text', rects: [{ x: .1, y: .8, w: .3, h: .025 }] });
            renderAnnotations(1, true);
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => {
            const anno = state.annotations[1].find(a => a.id === 'hl');
            openNoteModal(anno, 1, 200, 700);
        });
        await page.waitForTimeout(150);
        const highlight = await page.evaluate(() => ({
            visible: (() => { const c = document.getElementById('virtual-cursor'); return !!c && c.style.display !== 'none'; })(),
            phantoms: document.querySelectorAll('#phantom-cursor, #phantom-cursor-block').length,
        }));
        assert.equal(highlight.visible, false, JSON.stringify(highlight));
        assert.equal(highlight.phantoms, 0, JSON.stringify(highlight));
        pass('高亮等非文本批注不绘制文本光标');

        // 8) 空文本块：打开后光标出现在块首，打字后随文字前进；方向键也要同步。
        await page.evaluate(() => {
            els.noteModal.classList.add('hidden');
            state.activeAnnotationId = null;
            state.isEditingNote = false;
            state.originalAnnoSnapshot = null;
            state.annotations[1] = [
                { id: 'box-empty', type: 'text', color: '#000000', x: .06, y: .10, width: .38, fontSizeScale: 2, text: '' },
                { id: 'box-full', type: 'text', color: '#000000', x: .58, y: .42, width: .38, fontSizeScale: 2, text: 'bravo' },
            ];
            renderAnnotations(1, true);
        });
        await page.locator('.text-annotation[data-id="box-empty"]').scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        await clickBox('box-empty');
        const emptyStart = await page.evaluate(() => {
            const div = document.querySelector('.text-annotation[data-id="box-empty"]');
            const cursor = document.getElementById('virtual-cursor');
            const box = cursor && cursor.style.display !== 'none' ? cursor.getBoundingClientRect() : null;
            const rect = div.getBoundingClientRect();
            const padLeft = parseFloat(getComputedStyle(div).paddingLeft);
            return { visible: !!box, atLeft: !!box && Math.abs(box.left - (rect.left + padLeft)) < 6 };
        });
        assert.equal(emptyStart.visible, true, JSON.stringify(emptyStart));
        assert.equal(emptyStart.atLeft, true, JSON.stringify(emptyStart));
        await page.keyboard.type('hello');
        await page.waitForTimeout(250);
        const typedLeft = await page.evaluate(() => ({
            start: els.noteInput.selectionStart,
            cursorLeft: Math.round(document.getElementById('virtual-cursor').getBoundingClientRect().left),
            boxLeft: Math.round(document.querySelector('.text-annotation[data-id="box-empty"]').getBoundingClientRect().left),
        }));
        assert.equal(typedLeft.start, 5, JSON.stringify(typedLeft));
        assert.ok(typedLeft.cursorLeft > typedLeft.boxLeft + 10, '打字后光标未跟随文字前进：' + JSON.stringify(typedLeft));
        for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(250);
        const homeLeft = await page.evaluate(() => ({
            start: els.noteInput.selectionStart,
            cursorLeft: Math.round(document.getElementById('virtual-cursor').getBoundingClientRect().left),
        }));
        assert.equal(homeLeft.start, 0, JSON.stringify(homeLeft));
        assert.ok(Math.abs(homeLeft.cursorLeft - typedLeft.cursorLeft) > 10, '方向键移动后光标没有跟着回到行首：' + JSON.stringify(homeLeft) + ' vs ' + typedLeft.cursorLeft);
        pass('空文本块从块首开始，打字与方向键移动时光标同步跟随');

        // 9) 未定尺寸（自动宽高）的文本块切换后同样跟随。
        await page.evaluate(() => {
            els.noteModal.classList.add('hidden');
            state.activeAnnotationId = null;
            state.isEditingNote = false;
            state.originalAnnoSnapshot = null;
            state.annotations[1] = [
                { id: 'box-loose', type: 'text', color: '#000000', x: .06, y: .10, fontSizeScale: 2, text: 'one two three' },
                { id: 'box-next', type: 'text', color: '#000000', x: .58, y: .42, fontSizeScale: 2, text: 'second block' },
            ];
            renderAnnotations(1, true);
        });
        await page.locator('.text-annotation[data-id="box-loose"]').scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        await clickBox('box-loose');
        await page.keyboard.type('Q');
        await page.waitForTimeout(250);
        await clickBox('box-next');
        await page.waitForTimeout(250);
        const loose = await readCursor('box-loose', 'box-next');
        assert.equal(loose.onB, true, JSON.stringify(loose));
        assert.equal(loose.anA, false, JSON.stringify(loose));
        pass('自动宽高的文本块切换后光标同样跟随');

        // 10) 用户报的那条主路径：打字后用「点击空白处」关闭编辑，再打开另一块。
        await page.evaluate(() => {
            els.noteModal.classList.add('hidden');
            state.activeAnnotationId = null;
            state.isEditingNote = false;
            state.originalAnnoSnapshot = null;
            state.annotations[1] = [
                { id: 'box-p', type: 'text', color: '#000000', x: .06, y: .10, width: .38, fontSizeScale: 2, text: 'first block text' },
                { id: 'box-q', type: 'text', color: '#000000', x: .58, y: .42, width: .38, fontSizeScale: 2, text: 'second block text' },
            ];
            renderAnnotations(1, true);
        });
        await page.locator('.text-annotation[data-id="box-p"]').scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        await clickBox('box-p');
        await page.keyboard.type('!');
        await page.waitForTimeout(250);
        await page.mouse.click(1420, 880); // 画布空白处：与「确定」同一条落库路径
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => state.isEditingNote), false);
        assert.equal(await page.evaluate(() => document.querySelectorAll('#phantom-cursor, #phantom-cursor-block').length), 0);
        await clickBox('box-q');
        await page.keyboard.type('?');
        await page.waitForTimeout(250);
        const outside = await readCursor('box-p', 'box-q');
        assert.equal(outside.active, 'box-q');
        assert.equal(outside.anA, false, '点外部关闭后，块 P 仍留下幻影光标：' + JSON.stringify(outside));
        assert.equal(outside.onB, true, '点外部关闭后再开新块，红光标停在了上一个块上：' + JSON.stringify(outside));
        assert.equal(await page.evaluate(() => state.annotations[1].find(a => a.id === 'box-p').text), 'first block text!');
        pass('点空白处关闭编辑后再打开另一块，光标正确且内容照常落库');

        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
