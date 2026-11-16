// 批注随时切换颜色 + 文本块一键复制回归测试
// 复用 reader-performance.cjs 的临时服务与固定样本，不启动正式服务、不读写用户教材。
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, loadFixture, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const fixtures = { 'a.pdf': await fixture('text', 4) };
    const server = await startServer(fixtures);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
        executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: true
    });
    const checks = [], errors = [];
    const pass = name => { checks.push(name); console.log('PASS ' + name); };

    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto(origin + '/LOCALPdfReader.html');
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.waitForTimeout(300);

        await page.evaluate(() => {
            state.annotations[1] = [];
            addAnnotation(1, { id: 'tb-main', type: 'text', color: '#000000', x: 0.12, y: 0.12, fontSizeScale: 1.4, text: '公式 $x^2 + y^2$', timestamp: '2026/11/16' });
            addAnnotation(1, { id: 'tb-edge', type: 'text', color: '#60a5fa', x: 0.88, y: 0.12, width: 0.08, height: 0.04, text: '右边距文本块', timestamp: '2026/11/16' });
            addAnnotation(1, { id: 'tb-sidecar', type: 'text', color: '#4ade80', x: 1.15, y: 0.25, text: '草稿本块', timestamp: '2026/11/16' });
            addAnnotation(1, { id: 'hl-1', type: 'highlight', color: '#fde047', text: '高亮句子', note: '', rects: [{ x: 0.12, y: 0.30, w: 0.25, h: 0.025 }], timestamp: '2026/11/16' });
            addAnnotation(1, { id: 'ul-1', type: 'underline', color: '#f87171', text: '下划线句子', note: '已有笔记内容', rects: [{ x: 0.12, y: 0.36, w: 0.25, h: 0.025 }], timestamp: '2026/11/16' });
            addAnnotation(1, { id: 'arr-1', type: 'arrow', color: '#f87171', start: { x: 0.15, y: 0.45 }, end: { x: 0.35, y: 0.50 }, note: '', text: '[箭头]', timestamp: '2026/11/16' });
            addAnnotation(1, { id: 'mk-1', type: 'star', color: '#ef4444', x: 0.45, y: 0.45, size: 8, note: '', text: '[红星]', timestamp: '2026/11/16' });
            addAnnotation(1, { id: 'hb-1', type: 'highlight-block', color: '#fde047', start: { x: 0.15, y: 0.56 }, end: { x: 0.35, y: 0.56 }, thickness: 0.03, note: '', text: '[自由高亮块]', timestamp: '2026/11/16' });
            renderAnnotations(1, true);
            updateSidebar();
            initHistory();
            state.unsavedChanges = false; updateSaveStatus(false);
        });
        await page.waitForTimeout(300);

        const openTextById = async id => {
            const pt = await page.evaluate(id => {
                const div = document.querySelector(`.text-annotation[data-id="${id}"]`);
                div.scrollIntoView({ block: 'center' });
                return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
                    const r = div.getBoundingClientRect();
                    res({ x: r.left + Math.min(12, r.width / 2), y: r.top + Math.min(8, r.height / 2) });
                })));
            }, id);
            await page.mouse.click(pt.x, pt.y);
            await page.waitForTimeout(250);
        };

        // 1. 文本块切换颜色（预设色 + 撤销/重做 + 取消不回滚已切换颜色）
        await openTextById('tb-main');
        assert.equal(await page.locator('#note-modal').isVisible(), true);
        assert.equal(await page.locator('#anno-color-btn').isVisible(), true);
        assert.equal(await page.locator('#duplicate-text-btn').isVisible(), true);
        assert.equal(await page.locator('#anno-color-popover').isVisible(), false);

        await page.locator('#anno-color-btn').click();
        assert.equal(await page.locator('#anno-color-popover').isVisible(), true);
        await page.locator('.anno-color-swatch[data-color="#f87171"]').click();
        await page.waitForTimeout(200);

        assert.equal(await page.locator('#anno-color-popover').isVisible(), false, '选色后色板自动收起');
        const tbColorAfter = await page.evaluate(() => ({
            annoColor: state.annotations[1].find(a => a.id === 'tb-main').color,
            domColor: getComputedStyle(document.querySelector('.text-annotation[data-id="tb-main"]')).color,
            btnColor: getComputedStyle(document.getElementById('anno-color-btn')).backgroundColor,
            dirty: state.unsavedChanges
        }));
        assert.equal(tbColorAfter.annoColor, '#f87171');
        assert.equal(tbColorAfter.domColor, 'rgb(248, 113, 113)');
        assert.equal(tbColorAfter.btnColor, 'rgb(248, 113, 113)');
        assert.equal(tbColorAfter.dirty, true);
        pass('文本块在编辑弹窗中可直接切换预设颜色并实时生效');

        // 改文本后点取消：仅回滚文本，保留已切换的颜色
        await page.locator('#note-input').fill('临时未保存文本');
        await page.waitForTimeout(100);
        await page.locator('#toggle-edit-btn').click();
        await page.waitForTimeout(150);
        const afterCancel = await page.evaluate(() => {
            const a = state.annotations[1].find(x => x.id === 'tb-main');
            return { text: a.text, color: a.color };
        });
        assert.equal(afterCancel.text, '公式 $x^2 + y^2$');
        assert.equal(afterCancel.color, '#f87171');
        await page.locator('#close-note-btn').click();
        await page.waitForTimeout(150);
        pass('取消未保存文本修改时，已提交的颜色切换不会丢失');

        // 撤销 / 重做颜色切换
        await page.evaluate(() => undo());
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => state.annotations[1].find(a => a.id === 'tb-main').color), '#000000');
        await page.evaluate(() => redo());
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => state.annotations[1].find(a => a.id === 'tb-main').color), '#f87171');
        pass('切换颜色进入撤销/重做栈且可正确回退恢复');

        // 2. 在编辑文本时切换颜色，且未修改文字时点关闭不丢失，修改文字后分别可撤销
        await openTextById('tb-main');
        await page.locator('#note-input').fill('公式 $x^2 + y^2$ 更新');
        await page.waitForTimeout(150);
        await page.locator('#anno-color-btn').click();
        await page.locator('.anno-color-swatch[data-color="#4ade80"]').click();
        await page.waitForTimeout(150);
        await page.mouse.click(1400, 500);
        await page.waitForTimeout(250);
        const storedTextAndColor = await page.evaluate(async () => {
            const saved = await localforage.getItem(`pdf_annos_${state.fingerprint}`);
            const a = saved[1].find(x => x.id === 'tb-main');
            return { text: a.text, color: a.color };
        });
        assert.equal(storedTextAndColor.text, '公式 $x^2 + y^2$ 更新');
        assert.equal(storedTextAndColor.color, '#4ade80');
        pass('编辑文字过程中切换颜色并点外部保存：文字与颜色均写入本地存储');

        // 3. 高亮（无笔记，编辑态）& 下划线（有笔记，预览态）切换颜色（含自定义颜色）
        const clickHl = await page.evaluate(() => {
            const el = document.querySelector('#annotation-layer-1 .highlight-rect');
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.click(clickHl.x, clickHl.y);
        await page.waitForTimeout(200);
        assert.equal(await page.locator('#duplicate-text-btn').isVisible(), false, '高亮弹窗不应显示文本块复制按钮');
        await page.locator('#anno-color-btn').click();
        await page.locator('.anno-color-swatch[data-color="#60a5fa"]').click();
        await page.waitForTimeout(200);
        await page.locator('#close-note-btn').click();
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#annotation-layer-1 .highlight-rect')).backgroundColor), 'rgb(96, 165, 250)');
        pass('高亮批注放置后可随时切换颜色（即使关闭弹窗也保持新颜色）');

        const clickUl = await page.evaluate(() => {
            const el = document.querySelector('#annotation-layer-1 .underline-rect');
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.click(clickUl.x, clickUl.y);
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => state.isEditingNote), false, '带笔记的下划线先以预览态打开');
        await page.locator('#anno-color-btn').click();
        await page.locator('#anno-custom-color-input').evaluate(el => {
            el.value = '#9333ea';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(200);
        await page.locator('#save-note-btn').click();
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#annotation-layer-1 .underline-rect')).borderBottomColor), 'rgb(147, 51, 234)');
        pass('下划线在预览态可通过自定义取色器切换任意颜色');

        // 4. 箭头、图章、自由高亮块颜色切换
        for (const [id, verifyFn] of [
            ['arr-1', () => document.querySelector('#annotation-layer-1 line.vector-path')?.getAttribute('stroke')],
            ['mk-1', () => state.annotations[1].find(a => a.id === 'mk-1').color],
            ['hb-1', () => document.querySelector('#annotation-layer-1 rect')?.getAttribute('fill')]
        ]) {
            await page.evaluate(id => {
                const a = state.annotations[1].find(x => x.id === id);
                els.modalTitle.textContent = '批注';
                openNoteModal(a, 1, 300, 300);
            }, id);
            await page.locator('#anno-color-btn').click();
            await page.locator('.anno-color-swatch[data-color="#4ade80"]').click();
            await page.waitForTimeout(150);
            assert.equal(await page.evaluate(verifyFn), '#4ade80', `${id} 颜色应切换为 #4ade80`);
            await page.locator('#close-note-btn').click();
        }
        pass('箭头、图章、自由高亮块均可在放置后随时切换颜色');

        // 5. 文本块一键复制：在旁边生成一模一样内容的文本块（继承内容/颜色/字号）
        await openTextById('tb-main');
        const beforeCount = await page.evaluate(() => state.annotations[1].filter(a => a.type === 'text').length);
        await page.locator('#duplicate-text-btn').click();
        await page.waitForTimeout(250);
        assert.equal(await page.locator('#note-modal').isVisible(), false, '点击一键复制后弹窗关闭，方便立即看到与拖拽新块');

        const dupInfo = await page.evaluate(() => {
            const texts = state.annotations[1].filter(a => a.type === 'text');
            const orig = texts.find(a => a.id === 'tb-main');
            const dup = texts[texts.length - 1];
            const origRect = document.querySelector(`.text-annotation[data-id="${orig.id}"]`).getBoundingClientRect();
            const dupRect = document.querySelector(`.text-annotation[data-id="${dup.id}"]`).getBoundingClientRect();
            const katexCount = document.querySelectorAll(`.text-annotation[data-id="${dup.id}"] .katex`).length;
            return { count: texts.length, orig, dup, origRect, dupRect, katexCount };
        });
        assert.equal(dupInfo.count, beforeCount + 1);
        assert.notEqual(dupInfo.dup.id, dupInfo.orig.id);
        assert.equal(dupInfo.dup.text, dupInfo.orig.text);
        assert.equal(dupInfo.dup.color, dupInfo.orig.color);
        assert.equal(dupInfo.dup.fontSizeScale, dupInfo.orig.fontSizeScale);
        assert.ok(dupInfo.katexCount >= 1, '复制出的文本块应正常渲染 KaTeX 公式');
        assert.ok(dupInfo.dup.x < 0.98, '正文页复制出的文本块不应越界进入草稿本隐藏区');
        const overlapX = Math.max(0, Math.min(dupInfo.origRect.right, dupInfo.dupRect.right) - Math.max(dupInfo.origRect.left, dupInfo.dupRect.left));
        const overlapY = Math.max(0, Math.min(dupInfo.origRect.bottom, dupInfo.dupRect.bottom) - Math.max(dupInfo.origRect.top, dupInfo.dupRect.top));
        assert.equal(overlapX * overlapY, 0, '复制出的文本块应在旁边出现且不与原块重叠');
        pass('文本块一键复制会在旁边生成内容/颜色/字号完全一致且不重叠的新文本块');

        // 连续再次复制同一文本块：防叠加到完全相同坐标
        await openTextById('tb-main');
        await page.locator('#duplicate-text-btn').click();
        await page.waitForTimeout(200);
        const dup2 = await page.evaluate(() => {
            const texts = state.annotations[1].filter(a => a.type === 'text');
            return { prev: texts[texts.length - 2], curr: texts[texts.length - 1] };
        });
        assert.ok(Math.hypot(dup2.curr.x - dup2.prev.x, dup2.curr.y - dup2.prev.y) > 0.01, '连续复制不应叠在同一坐标');
        pass('连续复制同一文本块时自动避开已有副本位置');

        // 撤销一键复制
        await page.evaluate(() => undo());
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => state.annotations[1].filter(a => a.type === 'text').length), beforeCount + 1);
        pass('文本块一键复制支持一键撤销');

        // 6. 右边距文本块复制不落入隐藏草稿本区；草稿本内文本块复制保持在草稿本内
        await openTextById('tb-edge');
        await page.locator('#duplicate-text-btn').click();
        await page.waitForTimeout(200);
        const edgeCopy = await page.evaluate(() => state.annotations[1].filter(a => a.type === 'text').pop());
        assert.ok(edgeCopy.x < 0.98 && edgeCopy.x >= 0.01, `靠右文本块副本 x=${edgeCopy.x} 应留在正文页内`);
        assert.equal(edgeCopy.width, 0.08);
        assert.equal(edgeCopy.height, 0.04);

        await page.evaluate(() => toggleSidecar(true, true));
        await page.waitForTimeout(150);
        await openTextById('tb-sidecar');
        await page.locator('#duplicate-text-btn').click();
        await page.waitForTimeout(200);
        const sidecarCopy = await page.evaluate(() => state.annotations[1].filter(a => a.type === 'text').pop());
        assert.ok(sidecarCopy.x >= 0.98 && sidecarCopy.x < 1.98, `草稿本文本块副本 x=${sidecarCopy.x} 应留在草稿本内`);
        pass('靠右文本块与草稿本内文本块复制均严格保持在各自区域内');

        // 7. 在编辑框改完字后直接点一键复制（无需先点保存）
        await openTextById('tb-main');
        await page.locator('#note-input').fill('直接修改并复制的内容');
        await page.locator('#duplicate-text-btn').click();
        await page.waitForTimeout(200);
        const editedClone = await page.evaluate(() => {
            const texts = state.annotations[1].filter(a => a.type === 'text');
            return { orig: texts.find(a => a.id === 'tb-main').text, copy: texts[texts.length - 1].text };
        });
        assert.equal(editedClone.orig, '直接修改并复制的内容');
        assert.equal(editedClone.copy, '直接修改并复制的内容');
        pass('编辑文字后直接点击一键复制，原块与新副本内容同步一致');

        assert.deepEqual(errors, []);
        pass('无未捕获的浏览器错误');
        console.log(`\n${checks.length} checks passed`);
    } finally {
        await browser.close();
        server.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
