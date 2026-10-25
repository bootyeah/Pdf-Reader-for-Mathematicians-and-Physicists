// Real Edge, generated PDF and mocked TikZ; no user data or external services.
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, startServer, instrument, loadFixture, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({ 'a.pdf': await fixture('text', 2) });
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [], calls = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.route('**/api/render-tikz', async route => {
            calls.push(route.request().postData());
            await new Promise(resolve => setTimeout(resolve, 180));
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="lightblue"/></svg>';
            await route.fulfill({ contentType: 'text/plain', body: Buffer.from(svg).toString('base64') });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.evaluate(() => {
            const anno = state.annotations[1][0];
            anno.note = '原始附注 $x=1$';
            initHistory();
            openNoteModal(anno, 1, 360, 200, true);
        });
        const preview = page.locator('.latex-live-preview');
        await preview.waitFor();
        await page.waitForFunction(() => document.querySelector('.latex-live-preview .katex'));
        const right = await page.evaluate(() => {
            const editor = els.noteModal.getBoundingClientRect(), panel = document.querySelector('.latex-live-preview').getBoundingClientRect();
            return panel.left >= editor.right && panel.right <= innerWidth;
        });
        assert(right, 'preview opens to the right of the editor');
        const note = page.locator('#note-input');
        async function redMark(input, index, formula = false) {
            await input.evaluate((el, index) => new Promise(resolve => {
                el.focus();
                el.setSelectionRange(index, index);
                requestAnimationFrame(() => requestAnimationFrame(resolve));
            }), index);
            const value = await preview.evaluate(panel => {
                const cursor = panel.querySelector('.latex-preview-cursor');
                const phantom = panel.querySelector('#latex-preview-phantom, #latex-preview-phantom-block');
                return { hidden: cursor.hidden, box: cursor.getBoundingClientRect().toJSON(), target: phantom?.getBoundingClientRect().toJSON(),
                    border: getComputedStyle(cursor).borderTopStyle, color: cursor.style.backgroundColor, pulse: cursor.classList.contains('animate-pulse') };
            });
            assert.equal(value.hidden, false);
            assert(value.target);
            assert.equal(value.border, formula ? 'dashed' : 'none');
            assert.equal(value.color, formula ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.7)');
            assert.equal(value.pulse, !formula);
            assert(Math.abs(value.box.x - value.target.x + (formula ? 2 : 0)) <= 1);
            assert(Math.abs(value.box.y - value.target.y + (formula ? 2 : 0)) <= 1);
            return value;
        }
        await note.fill('高亮附注 $\\mathbb{R}$ 与 $\\mathbf{x}$\n<img src=x onerror=alert(1)>');
        await page.waitForFunction(() => document.querySelectorAll('.latex-live-preview .katex').length === 2);
        assert.equal(await preview.locator('img').count(), 0, 'source HTML remains plain text');
        assert.equal(await page.evaluate(() => state.annotations[1][0].note), '原始附注 $x=1$', 'preview leaves the saved note unchanged');
        assert.equal(await preview.locator('.katex-error').count(), 0);
        assert.equal(await preview.locator('.latex-preview-title').count(), 0);
        await preview.locator('.latex-preview-body').click();
        assert.equal(await note.evaluate(el => el === document.activeElement), true, 'preview does not steal focus or close the editor');
        await page.locator('#toggle-edit-btn').click();
        await page.waitForFunction(() => !document.querySelector('.latex-live-preview'));
        assert.equal(await page.evaluate(() => state.annotations[1][0].note), '原始附注 $x=1$');
        await page.locator('#toggle-edit-btn').click();
        await note.fill('已保存 $\\mathbb{R}$');
        await page.locator('#save-note-btn').click();
        assert.equal(await preview.count(), 0);
        assert.equal(await page.locator('#note-preview .katex').count(), 1);
        await page.evaluate(() => { undo(); });
        assert.equal(await page.evaluate(() => state.annotations[1][0].note), '原始附注 $x=1$');
        await page.evaluate(() => { redo(); });
        assert.equal(await page.evaluate(() => state.annotations[1][0].note), '已保存 $\\mathbb{R}$');
        await page.locator('#close-note-btn').click();
        console.log('PASS highlight note live preview, safe text, focus, save/cancel and undo/redo');

        await page.evaluate(() => openNoteModal(state.annotations[1][0], 1, 360, 200, true));
        const cursorSource = '开头 ABCD\n行内 $x^2$ 与 \\(y+1\\)\n独立 $$a+b$$ 和 \\[c+d\\]\n结尾';
        await note.fill(cursorSource);
        await page.waitForFunction(() => document.querySelectorAll('.latex-live-preview .katex').length === 4);
        const firstCaret = await redMark(note, 5);
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction(x => document.querySelector('.latex-preview-cursor').getBoundingClientRect().x < x, firstCaret.box.x);
        await redMark(note, 4);
        for (const text of ['$x^2$', '\\(y+1\\)', '$$a+b$$', '\\[c+d\\]']) {
            await redMark(note, cursorSource.indexOf(text) + 3, true);
            assert.equal(await preview.locator('.katex').count(), 4, 'cursor movement keeps every formula rendered');
            assert.equal(await preview.locator('.katex-error').count(), 0);
        }
        assert.equal(await page.locator('#phantom-cursor, #phantom-cursor-block').count(), 0, 'note preview uses independent cursor markers');
        await note.fill(Array.from({ length: 60 }, (_, i) => `Line ${i} 文本`).join('\n'));
        await page.waitForFunction(() => document.querySelector('.latex-preview-body').scrollTop > 100);
        await redMark(note, 0);
        assert.equal(await preview.locator('.latex-preview-body').evaluate(el => el.scrollTop), 0);
        await note.fill('');
        await page.waitForFunction(() => document.querySelector('.latex-preview-body')?.classList.contains('is-empty'));
        await redMark(note, 0);
        await page.locator('#close-note-btn').click();
        assert.equal(await preview.count(), 0);
        console.log('PASS red caret, all four formula delimiters, arrow/selection tracking, scroll following and empty input');

        await page.evaluate(() => {
            state.annotations[1].push({ id: 'latex-text', type: 'text', text: '原始文本 $a$', color: '#000', x: .1, y: .2 });
            renderAnnotations(1, true);
            openNoteModal(state.annotations[1].at(-1), 1, 600, 250, true);
        });
        await note.fill('$\\mathbf{u}$ 与正文');
        await page.waitForFunction(() => document.querySelector('.latex-live-preview .katex'));
        await page.waitForFunction(() => document.querySelector('.text-annotation .katex'));
        await redMark(note, 5, true);
        const sharedStyle = await page.evaluate(() => {
            const original = document.getElementById('virtual-cursor');
            const side = document.querySelector('.latex-preview-cursor');
            return ['backgroundColor', 'border', 'boxShadow'].every(key => original.style[key] === side.style[key]);
        });
        assert.equal(sharedStyle, true, 'page and side preview use identical red marker styles');
        assert.equal(await preview.locator('.katex').count(), 1);
        await page.locator('#toggle-edit-btn').click();
        assert.equal(await page.evaluate(() => state.annotations[1].at(-1).text), '原始文本 $a$');
        assert.equal(await preview.count(), 0);
        await page.locator('#close-note-btn').click();
        console.log('PASS text block retains its page preview and cancellation restores its content');

        await page.evaluate(() => {
            window.MindMap.toggle(true);
            const root = state.annotations.mindmap.nodes[0];
            root.text = '导图原文 $x$';
            root.id = 'preview-node';
            root.children = [];
            window.MindMap.render();
            initHistory();
        });
        const card = page.locator('.mm-card[data-id="preview-node"]');
        await card.dispatchEvent('dblclick');
        const editor = page.locator('.mm-inline-editor');
        await editor.fill('导图 $\\mathbb{R}$ 与 $\\mathbf{x}$');
        await page.waitForFunction(() => document.querySelectorAll('.latex-live-preview .katex').length === 2);
        assert.equal(await page.evaluate(() => state.annotations.mindmap.nodes[0].text), '导图原文 $x$');
        assert.equal(await preview.locator('.katex-error').count(), 0);
        await redMark(editor, 5, true);
        await redMark(editor, 1);
        await preview.locator('.latex-preview-body').click();
        assert.equal(await editor.count(), 1);
        assert(await editor.evaluate(el => el === document.activeElement));
        if (process.env.READER_TEST_ARTIFACTS) await page.screenshot({ path: path.join(resultsDir, 'latex-preview-mindmap.png') });
        await page.keyboard.press('Escape');
        assert.equal(await preview.count(), 0);
        assert.equal(await page.evaluate(() => state.annotations.mindmap.nodes[0].text), '导图原文 $x$');
        await card.dispatchEvent('dblclick');
        await editor.fill('');
        await editor.pressSequentially('mk');
        assert.equal(await editor.inputValue(), '$$');
        await page.keyboard.insertText('x+1');
        await page.waitForFunction(() => document.querySelector('.latex-live-preview .katex'));
        await redMark(editor, 2, true);
        await page.keyboard.press('Control+Enter');
        assert.equal(await preview.count(), 0);
        assert.equal(await card.locator('.katex').count(), 1);
        assert.equal(await page.evaluate(() => state.annotations.mindmap.nodes[0].text), '$x+1$');
        await page.evaluate(() => undo());
        assert.equal(await page.evaluate(() => state.annotations.mindmap.nodes[0].text), '导图原文 $x$');
        await page.evaluate(() => redo());
        assert.equal(await page.evaluate(() => state.annotations.mindmap.nodes[0].text), '$x+1$');
        console.log('PASS mind map preview, snippet expansion, focus, cancel, save and undo/redo');

        await card.dispatchEvent('dblclick');
        const graph = '\\begin{tikzpicture}\\draw(0,0)--(1,1);\\end{tikzpicture}';
        await editor.fill(graph);
        await page.waitForFunction(() => document.querySelector('.latex-live-preview img'));
        assert.equal(calls.length, 1);
        await page.keyboard.press('Control+Enter');
        await page.waitForFunction(() => document.querySelector('.mm-card img'));
        assert.equal(calls.length, 1, 'preview and saved node share the TikZ cache');
        await card.dispatchEvent('dblclick');
        await editor.fill(graph.replace('(1,1)', '(2,2)'));
        await page.waitForFunction(() => document.querySelector('.latex-live-preview .ignored-by-katex'));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        assert.equal(await preview.count(), 0, 'late TikZ result cannot reopen preview');
        console.log('PASS TikZ debounce, compilation cache and late-result cleanup');

        await card.dispatchEvent('dblclick');
        await page.evaluate(() => window.MindMap.toggle(false));
        await page.waitForFunction(() => !document.querySelector('.latex-live-preview'));
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 700, height: 650 }, { width: 390, height: 700 }]) {
            await page.setViewportSize(viewport);
            await page.evaluate(() => {
                const anno = state.annotations[1][0];
                openNoteModal(anno, 1, innerWidth - 30, 250, true);
            });
            await note.fill('边界测试 $$x^2+y^2=z^2$$');
            await page.waitForFunction(() => document.querySelector('.latex-live-preview .katex'));
            const bounds = await preview.boundingBox();
            assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, JSON.stringify({ viewport, bounds }));
            if (process.env.READER_TEST_ARTIFACTS) await page.screenshot({ path: path.join(resultsDir, `latex-preview-${viewport.width}.png`) });
            await page.locator('#close-note-btn').click();
            assert.equal(await preview.count(), 0);
        }
        assert.deepEqual(errors, []);
        console.log('PASS hidden editor cleanup and preview containment at 1440/700/390px; no browser errors');
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
