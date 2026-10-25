// 跨页箭头独立显示的浏览器回归：使用临时 PDF，不读写用户文档。
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, loadFixture, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));
const { PDFDocument, PDFName, PDFHexString } = require('../static/lib/pdf-lib.min.js');

(async () => {
    const fixtures = { 'arrows.pdf': await fixture('text', 30), 'clean.pdf': await fixture('text', 30, 'B'), 'mixed.pdf': await fixture('mixed', 8) };
    const server = await startServer(fixtures);
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const errors = [];
    const pass = name => console.log('PASS ' + name);
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await instrument(page);
        await loadFixture(page, 'arrows.pdf');
        await page.evaluate(async () => { await state.annotationsReady; updateZoom(1); });
        await page.waitForFunction(() => !state.isZooming);

        const jump = async num => {
            await page.evaluate(num => scrollPdfPageIntoView(num), num);
            await page.waitForFunction(num => state.pagesRendered.has(num), num);
        };
        const linePoint = selector => page.evaluate(selector => {
            const line = document.querySelector(selector);
            if (!line) return null;
            const matrix = line.getScreenCTM();
            const a = new DOMPoint(line.x1.baseVal.value, line.y1.baseVal.value).matrixTransform(matrix);
            const b = new DOMPoint(line.x2.baseVal.value, line.y2.baseVal.value).matrixTransform(matrix);
            const root = els.container.getBoundingClientRect();
            const lo = Math.max(root.top + 50, Math.min(a.y, b.y));
            const hi = Math.min(root.bottom - 50, Math.max(a.y, b.y));
            const y = (lo + hi) / 2, x = a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y);
            return { x, y, hit: hi > lo && document.elementFromPoint(x, y) === line };
        }, selector);
        const tipOnPage = (source, target, color, mounted = false) => page.evaluate(({ source, target, color, mounted }) => {
            if (mounted) ensurePdfPage(source);
            const targetWrapper = ensurePdfPage(target);
            const layer = document.getElementById(`annotation-layer-${source}`) ||
                document.querySelector(`.cross-page-arrow-layer[data-page-num="${source}"]`);
            const line = layer?.querySelector(`line[stroke="${color}"]`);
            const shape = line ? line.parentNode.querySelector('polygon') : layer?.querySelector(`path[stroke="${color}"]`);
            if (!shape) return null;
            const point = line ? shape.points.getItem(0) :
                [...shape.getAttribute('d').matchAll(/[ML]\s*([-\d.eE+]+)\s*([-\d.eE+]+)/g)][5].slice(1).map(Number);
            const tip = new DOMPoint(line ? point.x : point[0], line ? point.y : point[1]).matrixTransform(shape.getScreenCTM());
            const rect = targetWrapper.getBoundingClientRect();
            return { x: (tip.x - rect.left) / rect.width, y: (tip.y - rect.top) / rect.height };
        }, { source, target, color, mounted });
        const assertTip = async (source, target, color, expected, label, mounted = false) => {
            const actual = await tipOnPage(source, target, color, mounted);
            assert(actual, label + ': arrow exists');
            assert(Math.abs(actual.x - expected.x) < .001 && Math.abs(actual.y - expected.y) < .001,
                `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        };

        // 真正按下鼠标，从第 1 页画到第 6 页，松开后再触发回收。
        await page.locator('[data-tool="arrow"]').click();
        const start = await page.locator('#page-wrapper-1').boundingBox();
        await page.mouse.move(start.x + start.width * .35, start.y + 200);
        await page.mouse.down();
        await jump(6);
        assert.equal(await page.evaluate(() => state.drawingArrow.isDrawing && pageWrappers.has(1)), true);
        const end = await page.locator('#page-wrapper-6').boundingBox();
        await page.mouse.move(end.x + end.width * .65, end.y + 350);
        await page.mouse.up();
        await page.evaluate(() => { state.currentTool = 'cursor'; updateToolButtons(); refreshPdfRenderWindow(true); });
        const drawn = await page.evaluate(() => state.annotations[1].find(a => a.type === 'arrow'));
        assert(drawn.end.y > 5);
        assert.equal(await page.locator('#page-wrapper-1').count(), 0);
        const selector = '.cross-page-arrow-layer[data-page-num="1"] line';
        assert.equal((await linePoint(selector)).hit, true);
        assert.equal(await page.locator('.cross-page-arrow-layer canvas, .cross-page-arrow-layer .highlight-rect, .cross-page-arrow-layer .text-annotation').count(), 0);
        pass('Drawing across five pages survives source-page reclamation and remains hittable');

        const point = await linePoint(selector);
        await page.mouse.click(point.x, point.y);
        assert.equal(await page.evaluate(() => state.activeAnnotationId), drawn.id);
        await page.evaluate(() => els.toggleEditBtn.click());
        await page.locator('#delete-note-btn').click();
        assert.equal(await page.locator(selector).count(), 0);
        await page.evaluate(() => { undo(); refreshPdfRenderWindow(true); });
        assert.equal((await linePoint(selector)).hit, true);
        await page.evaluate(() => redo());
        assert.equal(await page.locator(selector).count(), 0);
        await page.evaluate(() => undo());
        pass('Remote arrow supports clicking, deletion, undo and redo');

        const drawnTip = await tipOnPage(1, 6, drawn.color);
        for (const scale of [.5, 1.7, 3, 1.25, 1]) {
            await page.evaluate(scale => { updateZoom(scale); scrollPdfPageIntoView(6); }, scale);
            await assertTip(1, 6, drawn.color, drawnTip, `Detached arrow during zoom ${scale}`);
            await page.waitForFunction(() => !state.isZooming);
            await assertTip(1, 6, drawn.color, drawnTip, `Detached arrow after zoom ${scale}`);
        }
        pass('A drawn arrow keeps its exact target-page position during and after repeated zooms');

        // 同一源页混放普通批注；另加反向箭头、两种双线箭头和超过十页的箭头。
        await page.evaluate(() => {
            const arrow = (id, type, source, target, x, color) => ({
                id, type, color, text: id, note: '', start: { x, y: .2 },
                end: { x, y: (pdfPageTop(target) - pdfPageTop(source)) / (state.pageDimensions[source - 1].height * state.scale) + .5 }
            });
            performAction(() => {
                state.annotations[1] = [
                    state.annotations[1].find(a => a.id === 'saved-highlight'),
                    arrow('long', 'arrow', 1, 16, .4, '#aa1100'),
                    arrow('double', 'equivalence', 1, 16, .55, '#008811'),
                    arrow('ordinary-line', 'line', 1, 16, .7, '#111111'),
                    { id: 'ordinary-text', type: 'text', x: .1, y: 6, text: 'Do not retain this text' }
                ];
                state.annotations[12] = [arrow('reverse', 'implies', 12, 2, .8, '#0011aa')];
            }, [1, 12]);
        });
        await jump(8);
        assert.equal(await page.locator('.cross-page-arrow-layer .vector-svg').count(), 3);
        assert.equal(await page.locator('[stroke="#111111"], .text-annotation[data-id="ordinary-text"]').count(), 0);
        assert.equal(await page.locator('#page-wrapper-1, #page-wrapper-12, #canvas-1, #canvas-12').count(), 0);
        assert((await page.locator('.page-wrapper').count()) < 8);
        assert.equal((await linePoint('.cross-page-arrow-layer line[stroke="#aa1100"]')).hit, true);
        assert.equal(await page.evaluate(() => {
            const path = document.querySelector('.cross-page-arrow-layer path[stroke="#0011aa"]');
            const point = path.getPointAtLength(path.getTotalLength() / 4).matrixTransform(path.getScreenCTM());
            const root = els.container.getBoundingClientRect();
            // 反向双线箭头在当前页的任一笔画必须能被命中。
            const x = point.x, y = root.top + 300;
            return [-3, -2, -1, 0, 1, 2, 3].some(dx => document.elementFromPoint(x + dx, y) === path);
        }), true);
        pass('Only arrow variants stay visible in both directions; ordinary annotations and PDF pages are reclaimed');

        for (const scale of [.5, 2, 1]) {
            await page.evaluate(scale => updateZoom(scale), scale);
            await page.waitForFunction(() => !state.isZooming);
            await jump(14);
            assert.equal((await linePoint('.cross-page-arrow-layer line[stroke="#aa1100"]')).hit, true);
        }
        pass('Arrow geometry survives zooming and remains visible more than ten pages from its origin');

        await page.evaluate(() => els.toggleVisBtn.click());
        assert.equal(await page.locator('.cross-page-arrow-layer').first().isVisible(), false);
        await page.evaluate(() => els.toggleVisBtn.click());
        assert.equal((await linePoint('.cross-page-arrow-layer line[stroke="#aa1100"]')).hit, true);
        await jump(1);
        assert.equal(await page.locator('.cross-page-arrow-layer[data-page-num="1"]').count(), 0);
        assert.equal(await page.locator('#annotation-layer-1 line[stroke="#aa1100"]').count(), 1);
        await jump(25);
        assert.equal(await page.locator('.cross-page-arrow-layer').count(), 0);
        pass('Visibility toggle, source-page remounting and leaving the arrow range do not leave duplicates or stale layers');

        // 保存后的页内锚点必须在不同初始缩放下恢复；旧格式也要兼容。
        const annotations = await page.evaluate(() => JSON.stringify(state.annotations));
        const pdf = await PDFDocument.load(fixtures['arrows.pdf']);
        pdf.getInfoDict().set(PDFName.of('ReaderProAnnos'), PDFHexString.of(Buffer.from(annotations).toString('hex')));
        fixtures['restored.pdf'] = Buffer.from(await pdf.save());
        const legacy = JSON.parse(annotations);
        for (const list of Object.values(legacy)) if (Array.isArray(list)) for (const anno of list) {
            if (anno.start) delete anno.start.pageAnchor;
            if (anno.end) delete anno.end.pageAnchor;
        }
        pdf.getInfoDict().set(PDFName.of('ReaderProAnnos'), PDFHexString.of(Buffer.from(JSON.stringify(legacy)).toString('hex')));
        fixtures['legacy.pdf'] = Buffer.from(await pdf.save());
        await loadFixture(page, 'clean.pdf');
        assert.equal(await page.locator('.cross-page-arrow-layer').count(), 0);
        await page.evaluate(() => updateZoom(2.4));
        await loadFixture(page, 'restored.pdf');
        await page.evaluate(async () => { await state.annotationsReady; });
        await jump(16);
        await assertTip(1, 16, '#aa1100', { x: .4, y: .5 }, 'Saved arrow reopened at 240%');
        await page.evaluate(() => updateZoom(1));
        await page.waitForFunction(() => !state.isZooming);
        await loadFixture(page, 'legacy.pdf');
        await page.evaluate(async () => { await state.annotationsReady; });
        await jump(16);
        await assertTip(1, 16, '#aa1100', { x: .4, y: .5 }, 'Legacy arrow before zoom');
        await page.evaluate(() => updateZoom(3));
        await page.waitForFunction(() => !state.isZooming);
        await jump(16);
        await assertTip(1, 16, '#aa1100', { x: .4, y: .5 }, 'Legacy arrow after zoom');
        await jump(8);
        assert.equal((await linePoint('.cross-page-arrow-layer line[stroke="#aa1100"]')).hit, true);
        await loadFixture(page, 'clean.pdf');
        await jump(8);
        assert.equal(await page.locator('.cross-page-arrow-layer').count(), 0);
        pass('Saved anchors reopen at a different zoom, legacy arrows remain compatible, and document switching clears detached arrows');

        // 在非 100% 下真实绘制相邻页三种箭头，覆盖仍挂载的批注层临时缩放。
        await page.evaluate(() => updateZoom(1.6));
        await page.waitForFunction(() => !state.isZooming);
        const adjacent = [];
        for (const [index, type] of ['arrow', 'implies', 'equivalence'].entries()) {
            await jump(2);
            await page.locator('[data-tool="arrow"]').click();
            assert.equal(await page.evaluate(() => state.currentTool), type);
            const start = await page.locator('#page-wrapper-2').boundingBox();
            await page.mouse.move(start.x + start.width * (.2 + index * .12), start.y + 180);
            await page.mouse.down();
            await jump(3);
            const end = await page.locator('#page-wrapper-3').boundingBox();
            await page.mouse.move(end.x + end.width * (.4 + index * .12), end.y + 250);
            await page.mouse.up();
            const anno = await page.evaluate(type => state.annotations[2].filter(a => a.type === type).at(-1), type);
            assert.equal(anno.end.pageAnchor.pageNum, 3);
            // 分配不同颜色，独立读取每种箭头尖端。
            const color = ['#aa2200', '#00aa22', '#2200aa'][index];
            await page.evaluate(({ id, color }) => performAction(() => { state.annotations[2].find(a => a.id === id).color = color; }, [2]), { id: anno.id, color });
            adjacent.push({ source: 2, target: 3, color, tip: await tipOnPage(2, 3, color), type });
        }
        await page.evaluate(() => { state.currentTool = 'cursor'; updateToolButtons(); });
        const arrowState = await page.evaluate(() => JSON.stringify(state.annotations[2]));
        for (const scale of [.5, 1, 1.7, 3, 5, 1.6]) {
            await jump(2);
            await page.evaluate(scale => updateZoom(scale), scale);
            for (const a of adjacent) await assertTip(a.source, a.target, a.color, a.tip, `${a.type} mounted during zoom ${scale}`, true);
            await page.waitForFunction(() => !state.isZooming);
            for (const a of adjacent) await assertTip(a.source, a.target, a.color, a.tip, `${a.type} mounted after zoom ${scale}`, true);
        }
        assert.equal(await page.evaluate(() => JSON.stringify(state.annotations[2])), arrowState, 'Zoom must not rewrite stored endpoints');
        pass('All three arrow tools drawn at 160% keep their target points through mounted-layer zooms from 50% to 500%');

        // 横竖混排、反向箭头、同页箭头、页顶边界和落在页间空白的箭头。
        await loadFixture(page, 'mixed.pdf');
        await page.evaluate(async () => {
            await state.annotationsReady;
            for (let n = 1; n <= state.pdfDoc.numPages; n++) {
                const viewport = (await state.pdfDoc.getPage(n)).getViewport({ scale: 1 });
                updatePdfPageDimensions(n, viewport.width, viewport.height);
            }
        });
        await page.waitForFunction(() => !state.isZooming);
        const cases = [
            { source: 1, target: 7, type: 'arrow', x: .4, y: .3, color: '#bb1100' },
            { source: 7, target: 1, type: 'equivalence', x: .6, y: .7, color: '#00bb11' },
            { source: 2, target: 2, type: 'implies', x: .55, y: .7, color: '#1100bb' },
            { source: 1, target: 7, type: 'arrow', x: .7, y: 0, color: '#bb7711' },
            { source: 2, target: 2, type: 'arrow', x: .45, gap: .6, color: '#bb00bb' }
        ];
        await page.evaluate(cases => performAction(() => {
            for (const a of cases) {
                const source = ensurePdfPage(a.source).getBoundingClientRect();
                const target = ensurePdfPage(a.target).getBoundingClientRect();
                const targetY = a.gap ? target.height + a.gap * PDF_PAGE_GAP : a.y * target.height;
                addAnnotation(a.source, { id: a.color, type: a.type, color: a.color, note: 'Endpoint note', text: 'Zoom test',
                    start: { x: .3, y: .2 }, end: { x: (target.left + a.x * target.width - source.left) / source.width,
                        y: (target.top + targetY - source.top) / source.height } });
            }
        }, [1, 2, 7]), cases);
        for (const scale of [.5, 2.3, 5, 1]) {
            await page.evaluate(scale => updateZoom(scale), scale);
            await page.waitForFunction(() => !state.isZooming);
            for (const a of cases) {
                await jump(a.target);
                const expected = { x: a.x, y: a.gap ? 1 + a.gap * 24 / (842 * scale) : a.y };
                await assertTip(a.source, a.target, a.color, expected, `Mixed-page ${a.color} at ${scale}`);
                // 笔记气泡的锚点也必须跟随箭头尖端。
                const aligned = await page.evaluate(({ source, color }) => {
                    const layer = document.getElementById(`annotation-layer-${source}`) || document.querySelector(`.cross-page-arrow-layer[data-page-num="${source}"]`);
                    const shape = layer.querySelector(`[stroke="${color}"]`).closest('svg');
                    const indicator = shape.previousElementSibling;
                    return indicator?.querySelector('.bubble-tail') && Math.abs(parseFloat(indicator.style.top) -
                        (shape.querySelector('polygon')?.points.getItem(0).y ?? Number([...shape.querySelector('path').getAttribute('d').matchAll(/[ML]\s*([-\d.eE+]+)\s*([-\d.eE+]+)/g)][5][2]))) < 1;
                }, a);
                assert(aligned, 'Note bubble follows arrow endpoint');
            }
        }
        await page.evaluate(() => undo());
        assert.equal(await page.evaluate(() => state.annotations[7]?.some(a => a.id === '#00bb11') || false), false);
        await page.evaluate(() => redo());
        await jump(1);
        await assertTip(7, 1, '#00bb11', { x: .6, y: .7 }, 'Reverse arrow restored by redo after zoom');
        pass('Mixed page sizes, reverse and same-page arrows, fixed gaps, note bubbles and undo/redo all keep endpoint alignment');

        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => readerTest.errors), []);
        pass('No uncaught browser errors or unhandled promise rejections');
    } finally {
        await browser.close();
        server.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
