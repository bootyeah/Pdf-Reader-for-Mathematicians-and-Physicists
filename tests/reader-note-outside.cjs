// 笔记弹窗「点击输入框外部」回归测试：
// 打字后点到弹窗外面，弹窗关闭时输入框里的内容必须和按「保存」一样落库（写数据 + 存本地 + 刷新界面），
// 不能再被回滚丢弃；同时「取消」按钮的丢弃语义、未修改时点外部不产生空撤销等行为保持不变。
// 复用 reader-performance.cjs 的临时服务与固定样本，不启动正式服务、不读写用户教材。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, loadFixture, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const fixtures = { 'a.pdf': await fixture('text', 3) };
    const server = await startServer(fixtures);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const checks = [], errors = [];
    const pass = name => { checks.push(name); console.log('PASS ' + name); };
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto(origin + '/LOCALPdfReader.html');
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.waitForTimeout(300);

        // 一个文本块（内容即 text）与一条带笔记的普通标记（内容即 note），覆盖两条落库分支
        await page.evaluate(() => {
            addAnnotation(1, { id: 'box', type: 'text', color: '#000000', x: 0.12, y: 0.1, text: '原标题 original', timestamp: '' });
            addAnnotation(1, { id: 'mark', type: 'highlight', color: '#fde047', x: 0.2, y: 0.5, text: '被划线的句子', note: '旧笔记 old note', rects: [{ x: .2, y: .5, w: .2, h: .02 }], timestamp: '' });
            renderAnnotations(1, true);
            state.unsavedChanges = false; updateSaveStatus(false);
            state.history.length = 0; state.historyIndex = -1;
        });
        await page.waitForTimeout(200);

        const annoField = (id, field) => page.evaluate(([id, field]) => {
            const a = state.annotations[1].find(x => x.id === id);
            return a ? a[field] : null;
        }, [id, field]);
        const storedField = (id, field) => page.evaluate(async ([id, field]) => {
            const data = await localforage.getItem(`pdf_annos_${state.fingerprint}`);
            const a = data && data[1] ? data[1].find(x => x.id === id) : null;
            return a ? a[field] : null;
        }, [id, field]);
        const domText = id => page.evaluate(id => (document.querySelector(`.text-annotation[data-id="${id}"]`) || {}).textContent, id);
        const modalHidden = () => page.evaluate(() => document.getElementById('note-modal').classList.contains('hidden'));
        const historyIndex = () => page.evaluate(() => state.historyIndex);

        // 真实鼠标点开文本块（居中后点左上角内侧）
        const openTextBlock = async id => {
            const r = await page.evaluate(id => {
                const div = document.querySelector(`.text-annotation[data-id="${id}"]`);
                div.scrollIntoView({ block: 'center' });
                return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
                    const b = div.getBoundingClientRect(); res({ left: b.left, top: b.top });
                })));
            }, id);
            await page.mouse.click(r.left + 12, r.top + 8);
            await page.waitForTimeout(300);
        };
        // 点开普通标记的笔记气泡
        const openBubble = async () => {
            const r = await page.evaluate(() => {
                const el = document.querySelector('.annotation-layer .z-30.cursor-pointer');
                el.scrollIntoView({ block: 'center' });
                return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
                    const b = el.getBoundingClientRect(); res({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
                })));
            });
            await page.mouse.click(r.x, r.y);
            await page.waitForTimeout(300);
        };
        const retype = async text => {
            await page.evaluate(() => document.getElementById('note-input').focus());
            await page.keyboard.press('Control+a');
            await page.keyboard.type(text);
            await page.waitForTimeout(450);   // 越过实时预览防抖
        };
        // 点弹窗外的空白区
        const clickOutside = async () => { await page.mouse.click(1400, 520); await page.waitForTimeout(600); };

        // ---------- 1. 文本块：打字后点外部，内容必须落库 ----------
        await openTextBlock('box');
        assert.equal(await modalHidden(), false, '点击文本块应打开编辑弹窗');
        assert.equal(await page.evaluate(() => document.getElementById('note-input').value), '原标题 original');
        const typed = '我打了一大串很长很长的批注文字 hello world';
        await retype(typed);
        await clickOutside();
        assert.equal(await modalHidden(), true, '点击外部后弹窗应该关闭');
        assert.equal(await annoField('box', 'text'), typed, '点击外部后批注数据必须保留刚打的字');
        assert.equal(await domText('box'), typed, '点击外部后画布上的文本块必须还是刚打的字');
        assert.equal(await storedField('box', 'text'), typed, '点击外部后必须已经写入本地存储');
        assert.equal(await page.evaluate(() => state.unsavedChanges), true, '点击外部保存后应标记为未保存改动');
        pass('文本块打字后点击外部：内容落库、画布与本地存储同步');

        await page.waitForFunction(() => {
            const c = document.getElementById('virtual-cursor');
            return !c || getComputedStyle(c).display === 'none';
        }, { timeout: 5000 });
        const cleared = await page.evaluate(() => {
            const div = document.querySelector('.text-annotation[data-id="box"]');
            return {
                editing: state.isEditingNote, active: state.activeAnnotationId,
                phantom: !!document.getElementById('phantom-cursor') || !!document.getElementById('phantom-cursor-block'),
                text: div.textContent,
            };
        });
        assert.equal(cleared.editing, false);
        assert.equal(cleared.active, null);
        assert.equal(cleared.phantom, false, '关闭后画布上不该残留幻影光标节点');
        assert.equal(cleared.text, typed);
        pass('点击外部关闭后编辑状态与虚拟光标一并清理干净');

        // ---------- 2. 重新打开能读回刚保存的内容（点开自己的路径没被破坏） ----------
        await openTextBlock('box');
        assert.equal(await page.evaluate(() => document.getElementById('note-input').value), typed, '再次打开应读回刚保存的内容');
        await clickOutside();
        pass('再次点击文本块仍能打开编辑弹窗并读回已保存内容');

        // ---------- 3. 普通标记：进入编辑态写笔记后点外部，笔记同样是"点外部即保存" ----------
        await openBubble();
        assert.equal(await modalHidden(), false, '点击笔记气泡应打开弹窗');
        // 已有笔记的标记先以预览态打开（不自动进编辑态），点「编辑」才出输入框
        assert.equal(await page.evaluate(() => state.isEditingNote), false, '已有笔记的标记应先以预览态打开');
        assert.equal(await page.evaluate(() => document.getElementById('note-input').value), '旧笔记 old note');
        await page.evaluate(() => document.getElementById('toggle-edit-btn').click());
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => state.isEditingNote), true, '点「编辑」后应进入编辑态');
        await retype('新写的笔记 new note');
        await clickOutside();
        assert.equal(await annoField('mark', 'note'), '新写的笔记 new note', '普通标记的笔记也必须保留');
        assert.equal(await storedField('mark', 'note'), '新写的笔记 new note', '普通标记的笔记也必须写入本地存储');
        pass('普通标记写笔记后点击外部：笔记同样落库');

        // ---------- 4. 「取消」按钮仍然是丢弃改动 ----------
        await openTextBlock('box');
        await retype('这段文字应该被取消掉');
        await page.evaluate(() => document.getElementById('toggle-edit-btn').click());
        await page.waitForTimeout(300);
        assert.equal(await annoField('box', 'text'), typed, '点「取消」必须回滚到编辑前的内容');
        assert.equal(await domText('box'), typed, '点「取消」后画布也要回滚');
        assert.equal(await page.evaluate(() => document.getElementById('note-input').value), typed);
        await page.evaluate(() => document.getElementById('close-note-btn').click());
        await page.waitForTimeout(200);
        pass('「取消」按钮的回滚语义保持不变');

        // ---------- 5. 打开后什么都没改就点外部：不写数据、不产生空撤销 ----------
        await page.evaluate(() => { state.history.length = 0; state.historyIndex = -1; });
        await openTextBlock('box');
        await clickOutside();
        assert.equal(await historyIndex(), -1, '未做任何修改时不该往撤销栈里塞空记录');
        assert.equal(await annoField('box', 'text'), typed);
        pass('打开后未修改就点外部：不产生空撤销记录');

        // ---------- 6. 点弹窗内部（标题栏）不该触发关闭与保存 ----------
        await page.evaluate(() => { state.history.length = 0; state.historyIndex = -1; });
        await openTextBlock('box');
        await retype('弹窗内部点击测试');
        await page.evaluate(() => document.getElementById('note-header').click());
        await page.waitForTimeout(300);
        assert.equal(await modalHidden(), false, '点弹窗内部不该关闭弹窗');
        await page.evaluate(() => document.getElementById('save-note-btn').click());
        await page.waitForTimeout(400);
        assert.equal(await annoField('box', 'text'), '弹窗内部点击测试');
        assert.equal(await storedField('box', 'text'), '弹窗内部点击测试');
        pass('点弹窗内部不关闭；「保存」按钮路径行为不变');

        // ---------- 7. 保存按钮关闭后，点外部不该误伤别人 ----------
        await page.evaluate(() => document.getElementById('save-note-btn').click());  // 预览态下的「确定」＝关闭
        await page.waitForTimeout(300);
        assert.equal(await modalHidden(), true);
        await clickOutside();
        assert.equal(await annoField('box', 'text'), '弹窗内部点击测试', '弹窗已关闭时点外部不应改动数据');
        pass('弹窗关闭后点击外部不会误改数据');

        assert.deepEqual(errors, []);
        pass('无未捕获的浏览器错误');

        // ---------- 8. 真实入口走一遍：文本工具新建 → 编辑 → 点外部 ----------
        await page.evaluate(() => {
            state.history.length = 0; state.historyIndex = -1;
            document.querySelector('button[data-tool="text"]').click();
        });
        assert.equal(await page.evaluate(() => state.currentTool), 'text', '文本工具应被选中');
        const fresh = await page.evaluate(() => {
            const wrapper = document.getElementById('page-wrapper-1');
            wrapper.scrollIntoView({ block: 'center' });
            return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
                const b = wrapper.getBoundingClientRect();
                res({ x: b.left + b.width * 0.35, y: b.top + b.height * 0.55, id: wrapper.dataset.pageNum });
            })));
        });
        await page.mouse.click(fresh.x, fresh.y);
        await page.waitForTimeout(400);
        const created = await page.evaluate(() => {
            const page = state.annotations[1] || [];
            const text = page.filter(a => a.type === 'text');
            return { count: text.length, last: text[text.length - 1] ? text[text.length - 1].text : null, tool: state.currentTool };
        });
        assert.equal(created.tool, 'cursor', '放下文本块后工具应自动回到光标');
        assert.equal(created.count, 2, '应新建一个文本块');
        const newId = await page.evaluate(() => {
            const page = state.annotations[1] || [];
            const text = page.filter(a => a.type === 'text');
            return text[text.length - 1].id;
        });
        await openTextBlock(newId);
        await retype('新建文本块后打的一长串内容');
        await clickOutside();
        assert.equal(await annoField(newId, 'text'), '新建文本块后打的一长串内容');
        assert.equal(await storedField(newId, 'text'), '新建文本块后打的一长串内容');
        assert.equal(await domText(newId), '新建文本块后打的一长串内容');
        pass('文本工具新建的文本块：打字后点外部同样落库');
        fs.mkdirSync(resultsDir, { recursive: true });
        fs.writeFileSync(path.join(resultsDir, 'note-outside.json'), JSON.stringify({ checks, errors }, null, 2));
        console.log(`\n${checks.length} checks passed`);
    } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
