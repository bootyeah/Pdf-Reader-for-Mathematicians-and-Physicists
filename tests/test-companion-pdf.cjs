// E2E test for Companion PDF (In-page floating Pip reader window)
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const nodeBin = 'node';
const deps = process.env.READER_TEST_NODE_MODULES || 'node_modules';
const { chromium } = require(path.join(deps, 'playwright'));
const { PDFDocument, StandardFonts, PDFName, PDFString } = require(path.join(root, 'static/lib/pdf-lib.min.js'));

const serverSource = `
import functools, json, sys, threading
from http.server import ThreadingHTTPServer
from app.server import PDFReaderHandler

class TestHandler(PDFReaderHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path.startswith('/api/cloud-anno'):
            self._json_response(200, {'ok': True, 'configured': False, 'enabled': False}); return
        if self.path.startswith('/api/ai-config'):
            self._json_response(200, {'model': 'test', 'models': [], 'thinking': 'omit', 'revision': 'test'}); return
        super().do_GET()

with ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(TestHandler, directory=${JSON.stringify(root)})) as s:
    t = threading.Thread(target=s.serve_forever, daemon=True)
    t.start()
    print(json.dumps({'origin': 'http://127.0.0.1:' + str(s.server_port)}), flush=True)
    try: sys.stdin.read()
    finally: s.shutdown(); t.join()
`;

(async () => {
    const child = spawn(process.env.READER_TEST_PYTHON || 'python', ['-u', '-c', serverSource], {
        cwd: root,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let browser;
    child.stderr.on('data', b => process.stderr.write(b));

    try {
        const origin = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('server startup timeout')), 15000);
            readline.createInterface({ input: child.stdout }).on('line', line => {
                try {
                    const j = JSON.parse(line);
                    if (j.origin) {
                        clearTimeout(timer);
                        resolve(j.origin);
                    }
                } catch {}
            });
            child.once('error', reject);
            child.once('exit', code => {
                clearTimeout(timer);
                reject(new Error('server exited with code ' + code));
            });
        });

        // 构造主文档 (3页) 和 副文档 (5页)
        const doc1 = await PDFDocument.create();
        const font = await doc1.embedFont(StandardFonts.Helvetica);
        for (let i = 1; i <= 3; i++) {
            doc1.addPage([595, 842]).drawText('Main Document Page ' + i, { x: 40, y: 700, font, size: 20 });
        }
        const mainPdfB64 = Buffer.from(await doc1.save()).toString('base64');

        const doc2 = await PDFDocument.create();
        const font2 = await doc2.embedFont(StandardFonts.Helvetica);
        for (let i = 1; i <= 5; i++) {
            doc2.addPage([595, 842]).drawText('Companion Sub Document Page ' + i, { x: 40, y: 700, font: font2, size: 20 });
        }
        const companionPdfB64 = Buffer.from(await doc2.save()).toString('base64');

        const mixed = await PDFDocument.create();
        const mixedFont = await mixed.embedFont(StandardFonts.Helvetica);
        for (const [i, size] of [[400, 1000], [1000, 400], [600, 800]].entries()) {
            mixed.addPage(size).drawText('Mixed Page ' + (i + 1), { x: 30, y: size[1] - 80, font: mixedFont, size: 20 });
        }
        const outlineRoot = mixed.context.register(mixed.context.obj({ Type: 'Outlines', Count: 1 }));
        const outlineEntry = mixed.context.register(mixed.context.obj({ Title: PDFString.of('Landscape section'), Parent: outlineRoot, Dest: [mixed.getPage(1).ref, PDFName.of('Fit')] }));
        mixed.context.lookup(outlineRoot).set(PDFName.of('First'), outlineEntry);
        mixed.context.lookup(outlineRoot).set(PDFName.of('Last'), outlineEntry);
        mixed.catalog.set(PDFName.of('Outlines'), outlineRoot);
        const mixedPdfB64 = Buffer.from(await mixed.save()).toString('base64');

        browser = await chromium.launch({
            executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            headless: true
        });

        const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => {
            console.error('PAGE ERROR EVENT:', e);
            errors.push(e.message || String(e));
        });
        const renderErrors = [];
        page.on('console', msg => {
            if (/same canvas|渲染受挫|Unhandled|字体.*失败/i.test(msg.text())) renderErrors.push(msg.text());
        });

        await page.goto(origin + '/index.html');
        const resultsDir = path.join(root, 'tests/results');
        fs.mkdirSync(resultsDir, { recursive: true });
        const loadCompanion = (b64, name = 'companion-notes.pdf') => page.evaluate(async ({ b64, name }) => {
            await CompanionPdf.loadFile(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type: 'application/pdf' }));
        }, { b64, name });
        const waitRendered = pageNum => page.waitForFunction(n => {
            const card = document.querySelector(`.cp-page-card[data-page-num="${n}"]`);
            return card?.dataset.renderedScale && card.querySelector('canvas').width > 1 && card.querySelector('.cp-text-layer span');
        }, pageNum);

        // 全局快捷键必须在惰性窗口 DOM 创建前生效。
        assert.equal(await page.locator('#companion-pdf-panel').count(), 0);
        await page.keyboard.press('F10');
        assert.equal(await page.evaluate(() => CompanionPdf.isOpen()), true);
        await page.keyboard.press('F10');
        assert.equal(await page.evaluate(() => CompanionPdf.isOpen()), false);

        // 1. 打开主文档
        await page.evaluate(async b64 => {
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const file = new File([bytes], 'main-document.pdf', { type: 'application/pdf' });
            await processSelectedFile(file, null);
        }, mainPdfB64);
        await page.waitForFunction(() => state.pdfDoc?.numPages === 3);
        console.log('✔ 主文档加载成功: 3页');

        // 2. 检查打开下拉入口
        const openCompanionBtn = await page.$('#open-companion-btn');
        assert.ok(openCompanionBtn, '打开下拉应存在 #open-companion-btn 按钮');

        // 3. 悬停打开按钮并点击小窗对照阅读入口
        let pickerCalls = 0;
        let pickerFolder = '';
        await page.route('**/api/pick-file', async route => {
            pickerCalls++;
            pickerFolder = route.request().postDataJSON().folder;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: false, cancelled: true })
            });
        });
        await page.hover('#open-dropdown-wrapper');
        await page.waitForSelector('#open-companion-btn', { state: 'visible' });
        await page.click('#open-companion-btn');
        await page.waitForFunction(() => window.CompanionPdf && window.CompanionPdf.isOpen());
        const isPanelVisible = await page.$eval('#companion-pdf-panel', el => !el.hidden);
        assert.ok(isPanelVisible, '小窗应已展示');
        assert.equal(await page.locator('#companion-pdf-btn').count(), 0, '工具栏新增按钮应移除');
        assert.equal(pickerCalls, 0, '菜单只显示小窗，不应打开文件选择器');
        assert.equal(await page.locator('#companion-pdf-loading').isVisible(), false);
        assert.equal(await page.locator('#companion-pdf-outline-drawer').isVisible(), false);

        // 验证全新极简磨砂空状态界面
        const emptyCard = await page.$('.cp-empty-card');
        assert.ok(emptyCard, '空状态应展示现代极简磨砂卡片');
        const quickBtn1 = await page.$('#cp-quick-btn-1');
        assert.ok(quickBtn1, '空状态应展示快捷文件夹胶囊按钮');
        await page.screenshot({ path: path.join(resultsDir, 'companion-empty.png') });
        await page.click('#cp-empty-open-btn');
        await page.waitForFunction(() => !document.querySelector('#cp-empty-open-btn').disabled);
        assert.equal(pickerCalls, 1, '窗内选择文件按钮才发起一次选择');
        await page.click('#cp-quick-btn-2');
        await page.waitForFunction(() => !document.querySelector('#cp-quick-btn-2').disabled);
        assert.equal(pickerFolder, await page.evaluate(() => loadQuickFoldersConfig().btn2.path), '快捷文件夹沿用主阅读器的默认路径');
        await page.evaluate(() => { localStorage.setItem('pdf_reader_quick_folders', JSON.stringify({ btn2: { label: '课', name: 'Reference', path: 'D:\\Test\\Reference' } })); CompanionPdf.show(); });
        assert.equal(await page.textContent('#cp-quick-btn-2'), '课');
        await page.click('#cp-quick-btn-2');
        await page.waitForFunction(() => !document.querySelector('#cp-quick-btn-2').disabled);
        assert.equal(pickerFolder, 'D:\\Test\\Reference', '配置改变后使用最新路径');
        await page.evaluate(() => localStorage.removeItem('pdf_reader_quick_folders'));
        console.log('✔ 下拉菜单按钮唤出小窗与极简空状态验证成功');

        // 4. 在小窗内加载副文档 PDF
        await page.evaluate(async b64 => {
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const file = new File([bytes], 'companion-notes.pdf', { type: 'application/pdf' });
            await window.CompanionPdf.loadFile(file);
        }, companionPdfB64);

        // 验证副文档已渲染
        await page.waitForFunction(() => {
            const total = document.getElementById('cp-page-total');
            return total && total.textContent === '5';
        });
        const companionTitle = await page.$eval('#companion-pdf-title', el => el.textContent);
        assert.equal(companionTitle, 'companion-notes.pdf', '副文档标题应正确更新');
        console.log('✔ 小窗内副文档加载成功: 5页');
        await waitRendered(1);
        // 实际鼠标拖动与拉伸，不应留下全局禁止文字选择状态。
        let dragRect = await page.locator('#companion-pdf-panel').boundingBox();
        await page.mouse.move(dragRect.x + 70, dragRect.y + 20);
        await page.mouse.down();
        await page.mouse.move(dragRect.x + 30, dragRect.y + 40, { steps: 4 });
        await page.mouse.up();
        let movedRect = await page.locator('#companion-pdf-panel').boundingBox();
        assert.ok(Math.abs(movedRect.x - dragRect.x + 40) < 2 && Math.abs(movedRect.y - dragRect.y - 20) < 2);
        const grip = await page.locator('.cp-resize-grip').boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2 + 20, grip.y + grip.height / 2 + 20, { steps: 4 });
        await page.mouse.up();
        const resizedRect = await page.locator('#companion-pdf-panel').boundingBox();
        assert.ok(resizedRect.width > movedRect.width + 15 && resizedRect.height > movedRect.height + 15);
        assert.equal(await page.evaluate(() => document.body.style.userSelect), '');
        await page.waitForTimeout(150);
        const mainBefore = await page.evaluate(() => ({ name: state.fileName, pages: state.pdfDoc.numPages, scale: state.scale, tool: state.currentTool, unsaved: state.unsavedChanges, annotations: JSON.stringify(state.annotations), scrollTop: els.container.scrollTop }));

        // 验证主文档与副文档状态互不干扰
        const mainPages = await page.evaluate(() => state.pdfDoc.numPages);
        assert.equal(mainPages, 3, '主文档应保持3页不受影响');

        // 5. 测试小窗翻页
        await page.click('#cp-next-page');
        await page.waitForTimeout(100);
        const curPage = await page.$eval('#cp-page-input', el => el.value);
        assert.equal(curPage, '2', '点击下一页应变为第2页');

        // 测试页码输入跳转
        await page.fill('#cp-page-input', '4');
        await page.press('#cp-page-input', 'Enter');
        await page.waitForTimeout(150);
        const jumpedPage = await page.$eval('#cp-page-input', el => el.value);
        assert.equal(jumpedPage, '4', '回车应跳转至第4页');
        console.log('✔ 小窗翻页与页码快速跳转正常');

        // 6. 测试小窗折叠与展开
        const heightBeforeCollapse = await page.$eval('#companion-pdf-panel', el => el.offsetHeight);
        await page.click('#cp-collapse-btn');
        await page.waitForTimeout(100);
        const heightCollapsed = await page.$eval('#companion-pdf-panel', el => el.offsetHeight);
        assert.equal(heightCollapsed, 40, '折叠后高度应为40px标题栏');
        assert.ok(await page.evaluate(() => window.CompanionPdf.isCollapsed()), 'isCollapsed 状态应为 true');

        // 再次点击展开
        await page.click('#cp-collapse-btn');
        await page.waitForTimeout(100);
        const heightRestored = await page.$eval('#companion-pdf-panel', el => el.offsetHeight);
        assert.ok(heightRestored > 100, '展开后应恢复原窗口高度');
        console.log('✔ 折叠为极简标题栏与展开功能正常');

        // 7. 测试半屏分屏对比 (Dock) 模式
        await page.click('#cp-dock-btn');
        await page.waitForTimeout(150);
        const isDocked = await page.evaluate(() => window.CompanionPdf.isDocked());
        assert.ok(isDocked, '应进入半屏对比贴靠模式');
        const dockWidth = await page.$eval('#companion-pdf-panel', el => el.offsetWidth);
        assert.ok(dockWidth > 500, '半屏模式宽度应自适应扩展');

        // 双击标题栏还原 (双击左侧标题文本区)
        await page.dblclick('#companion-pdf-title');
        await page.waitForTimeout(150);
        const isDockedAfterDblClick = await page.evaluate(() => window.CompanionPdf.isDocked());
        assert.ok(!isDockedAfterDblClick, '双击标题栏应退出半屏贴靠模式恢复浮动');
        console.log('✔ 半屏贴靠对比与双击标题栏快速切换正常');

        // 8. 测试 F10 全局快捷键收起与展开
        await page.keyboard.press('F10');
        await page.waitForTimeout(100);
        const isOpenAfterF10 = await page.evaluate(() => window.CompanionPdf.isOpen());
        assert.ok(!isOpenAfterF10, 'F10 应收起小窗');
        const isPanelHidden = await page.$eval('#companion-pdf-panel', el => el.hidden);
        assert.ok(isPanelHidden, '小窗应已隐藏');

        await page.keyboard.press('F10');
        await page.waitForTimeout(100);
        const isPanelShown = await page.$eval('#companion-pdf-panel', el => !el.hidden);
        assert.ok(isPanelShown, 'F10 再次按下应唤出小窗');
        console.log('✔ F10 全局唤出/隐藏快捷键正常');

        assert.equal(await page.$eval('#open-companion-btn', el => el.getAttribute('aria-expanded')), 'true');
        assert.equal(await page.$eval('#companion-pdf-title', el => el.textContent), 'companion-notes.pdf');

        // 10. 测试独立键盘劫持与翻页 (聚焦在 panel 上)
        await page.click('#companion-pdf-header');
        await page.keyboard.press('Home');
        await page.waitForTimeout(100);
        assert.equal(await page.$eval('#cp-page-input', el => el.value), '1', 'Home 键应跳转至第1页');
        assert.ok(await page.$eval('#cp-prev-page', el => el.disabled), '第1页上一页按钮应被禁用');

        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(100);
        assert.equal(await page.$eval('#cp-page-input', el => el.value), '2', 'ArrowRight 键应进入第2页');

        await page.keyboard.press('End');
        await page.waitForTimeout(100);
        assert.equal(await page.$eval('#cp-page-input', el => el.value), '5', 'End 键应跳转至最后一页');
        assert.ok(await page.$eval('#cp-next-page', el => el.disabled), '末页下一页按钮应被禁用');
        console.log('✔ 独立键盘快捷键 (Home/End/Arrow) 与翻页边界按钮状态正常');

        // 11. 测试自适应整页 (Fit-Page) 缩放模式
        await page.selectOption('#cp-zoom-select', 'fit-page');
        await page.waitForTimeout(150);
        const curScaleMode = await page.evaluate(() => window.CompanionPdf && localStorage.getItem('pdf_reader_companion_pdf_state'));
        assert.ok(curScaleMode && curScaleMode.includes('fit-page'), '缩放模式应成功持久化为 fit-page');
        console.log('✔ 自适应整页 (Fit-Page) 缩放切换与状态持久化正常');

        // 输入焦点、选择修饰键与按钮的原生空格操作。
        await page.click('#cp-page-input');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'cp-page-input');
        await page.fill('#cp-page-input', '1.5');
        await page.press('#cp-page-input', 'Enter');
        assert.equal(await page.inputValue('#cp-page-input'), '5', '非法小数页码不能被截断为整数');
        await page.keyboard.press('Shift');
        assert.equal(await page.evaluate(() => CompanionPdf.isCollapsed()), false, 'Shift 不能误折叠窗口');
        await page.keyboard.press('Shift+ArrowLeft');
        assert.equal(await page.inputValue('#cp-page-input'), '5');
        await page.evaluate(() => CompanionPdf.goToPage(1, false));
        await page.focus('#cp-next-page');
        await page.keyboard.press('Space');
        assert.equal(await page.inputValue('#cp-page-input'), '2', '按钮上的空格保持按钮点击语义');
        await page.click('#companion-pdf-title');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'companion-pdf-panel', '点击阅读区域或标题将键盘焦点交给小窗');
        await page.keyboard.press('Space');
        assert.equal(await page.evaluate(() => state.handDrag.isSpaceDown), false, '小窗按键不能触发主文档抓手');

        // 缩放和重新显示窗口保留页内位置，任意倍率与实际渲染一致。
        await page.evaluate(() => { CompanionPdf.setZoom('fit-width'); CompanionPdf.goToPage(3, false); });
        await waitRendered(3);
        await page.$eval('#companion-pdf-viewport', el => { el.scrollTop += 200; });
        await page.waitForTimeout(420);
        const anchor = () => page.evaluate(() => {
            const view = document.querySelector('#companion-pdf-viewport').getBoundingClientRect();
            const card = document.querySelector('.cp-page-card[data-page-num="3"]').getBoundingClientRect();
            return (view.top + 14 - card.top) / card.height;
        });
        const beforeZoom = await anchor();
        await page.evaluate(() => { for (const scale of [1, 1.25, 0.5, 2, 1.75]) CompanionPdf.setZoom(scale); });
        await page.waitForFunction(() => document.querySelector('.cp-page-card[data-page-num="3"]').dataset.renderedScale === '1.75');
        assert.ok(Math.abs(await anchor() - beforeZoom) < 0.01, '缩放保留页内阅读位置');
        assert.equal(await page.$eval('#cp-zoom-select', el => el.selectedOptions[0].textContent), '175%');
        const canvasScale = await page.$eval('.cp-page-card[data-page-num="3"]', el => ({ pixels: el.querySelector('canvas').width, width: el.getBoundingClientRect().width, dpr: devicePixelRatio }));
        assert.ok(Math.abs(canvasScale.pixels - canvasScale.width * canvasScale.dpr) < 2);
        const beforeHide = await page.$eval('#companion-pdf-viewport', el => el.scrollTop);
        await page.evaluate(() => { CompanionPdf.hide(); CompanionPdf.show(); });
        assert.ok(Math.abs(await page.$eval('#companion-pdf-viewport', el => el.scrollTop) - beforeHide) < 2);
        const savedGeometry = await page.evaluate(() => JSON.parse(localStorage.getItem('pdf_reader_companion_pdf_state')));
        assert.ok(savedGeometry.w >= 340 && savedGeometry.h >= 240, '隐藏窗口不能将记忆尺寸写成零');

        const mainAfter = await page.evaluate(() => ({ name: state.fileName, pages: state.pdfDoc.numPages, scale: state.scale, tool: state.currentTool, unsaved: state.unsavedChanges, annotations: JSON.stringify(state.annotations), scrollTop: els.container.scrollTop }));
        assert.deepEqual(mainAfter, mainBefore, '小窗操作不能改变主文档状态或滚动位置');
        assert.equal(await page.locator('#companion-pdf-loading').isVisible(), false);
        assert.equal(await page.locator('#companion-pdf-outline-drawer').isVisible(), false);

        // 窄窗口工具不能挤出边界；高倍率文档左侧可以滚动到。
        await page.$eval('#companion-pdf-panel', el => { el.style.width = '340px'; el.style.left = '900px'; });
        await page.waitForTimeout(150);
        const clipped = await page.$eval('#companion-pdf-panel', el => {
            const bounds = el.getBoundingClientRect();
            return Array.from(el.querySelectorAll('button, input, select')).filter(button => button.getClientRects().length).filter(button => {
                const r = button.getBoundingClientRect();
                return r.left < bounds.left || r.right > bounds.right || r.top < bounds.top || r.bottom > bounds.bottom;
            }).map(el => el.id);
        });
        assert.deepEqual(clipped, [], '340px 窗口内所有控制应完整可见');
        const leftEdge = await page.$eval('#companion-pdf-viewport', el => {
            el.scrollLeft = 0;
            return el.querySelector('.cp-page-card').getBoundingClientRect().left - el.getBoundingClientRect().left;
        });
        assert.ok(leftEdge >= 0 && leftEdge <= 16, '放大页面的左边缘不能被居中裁切');
        await page.evaluate(() => CompanionPdf.goToPage(1, false));
        await waitRendered(1);
        await page.screenshot({ path: path.join(resultsDir, 'companion-narrow.png') });

        // 滚动后的远页确实释放像素资源。
        await page.evaluate(() => { CompanionPdf.setZoom('fit-width'); CompanionPdf.goToPage(5, false); });
        await waitRendered(5);
        await page.waitForFunction(() => document.querySelector('.cp-page-card[data-page-num="1"] canvas').width === 1);

        // 加载失败后保留现有文档，错误显示在窗口内。
        await loadCompanion(Buffer.from('%PDF broken fixture').toString('base64'), 'broken.pdf');
        assert.equal(await page.$eval('#companion-pdf-title', el => el.textContent), 'companion-notes.pdf');
        assert.equal(await page.locator('#cp-error').isVisible(), true);
        assert.equal(await page.locator('#companion-pdf-loading').isVisible(), false);
        await waitRendered(5);

        // 遇到本机选择器占用不应再叠加一个浏览器选择器。
        let browserPickerCalls = 0;
        page.on('filechooser', () => { browserPickerCalls++; });
        await page.unroute('**/api/pick-file');
        await page.route('**/api/pick-file', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '选择窗口正在打开' }) }));
        await page.click('#cp-open-btn');
        await page.waitForFunction(() => !document.querySelector('#cp-open-btn').disabled);
        assert.equal(browserPickerCalls, 0);
        assert.match(await page.textContent('#cp-error'), /选择窗口/);

        // 延迟的 A 文档加载不得覆盖后选的 B 文档。
        await page.evaluate(b64 => {
            window.__realPdfjsLib = pdfjsLib;
            let count = 0;
            window.pdfjsLib = { ...__realPdfjsLib, getDocument: (...args) => {
                const task = __realPdfjsLib.getDocument(...args);
                if (count++ > 0) return task;
                return { promise: task.promise.then(async doc => { await new Promise(resolve => { window.__releaseSlowLoad = resolve; }); return doc; }), destroy: () => task.destroy() };
            } };
            window.__slowLoad = CompanionPdf.loadFile(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'slow-A.pdf', { type: 'application/pdf' }));
        }, companionPdfB64);
        await page.waitForFunction(() => typeof window.__releaseSlowLoad === 'function');
        await loadCompanion(mixedPdfB64, 'mixed-B.pdf');
        await page.evaluate(async () => { __releaseSlowLoad(); await __slowLoad; window.pdfjsLib = __realPdfjsLib; });
        assert.equal(await page.textContent('#companion-pdf-title'), 'mixed-B.pdf');
        assert.equal(await page.textContent('#cp-page-total'), '3');
        assert.equal(await page.locator('#cp-error').isVisible(), false);

        // 实际 PDF 目录、混合横竖页的尺寸与整页缩放。
        await page.waitForSelector('#cp-outline-btn', { state: 'visible' });
        await page.click('#cp-outline-btn');
        await page.getByRole('button', { name: 'Landscape section' }).click();
        await page.waitForFunction(() => document.querySelector('#cp-page-input').value === '2');
        assert.equal(await page.inputValue('#cp-page-input'), '2');
        assert.equal(await page.locator('#companion-pdf-outline-drawer').isVisible(), false);
        await page.selectOption('#cp-zoom-select', 'fit-page');
        await waitRendered(2);
        const landscape = await page.$eval('.cp-page-card[data-page-num="2"]', el => ({ width: el.offsetWidth, height: el.offsetHeight, viewWidth: document.querySelector('#companion-pdf-viewport').clientWidth, viewHeight: document.querySelector('#companion-pdf-viewport').clientHeight }));
        assert.ok(Math.abs(landscape.width / landscape.height - 2.5) < 0.02);
        assert.ok(landscape.width <= landscape.viewWidth - 20 && landscape.height <= landscape.viewHeight - 20);
        await page.screenshot({ path: path.join(resultsDir, 'companion-mixed.png') });
        assert.deepEqual(renderErrors, [], '快速缩放不能产生画布并发或渲染错误');

        // 小屏贴靠 / 浮动均留在视口内，重新加载保留浮动几何尺寸。
        await page.setViewportSize({ width: 320, height: 600 });
        await page.click('#cp-dock-btn');
        let rect = await page.locator('#companion-pdf-panel').boundingBox();
        assert.ok(rect.x >= 0 && rect.x + rect.width <= 320 && rect.y + rect.height <= 600);
        await page.click('#cp-dock-btn');
        rect = await page.locator('#companion-pdf-panel').boundingBox();
        assert.ok(rect.x >= 0 && rect.x + rect.width <= 320);
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.$eval('#companion-pdf-panel', el => { el.style.width = '620px'; el.style.height = '500px'; el.style.left = '750px'; });
        await page.waitForTimeout(100);
        await page.evaluate(() => CompanionPdf.goToPage(2, false));
        await waitRendered(2);
        await page.screenshot({ path: path.join(resultsDir, 'companion-reading.png') });

        // 12. 测试关闭按钮
        await page.click('#cp-close-btn');
        await page.waitForTimeout(100);
        assert.ok(await page.$eval('#companion-pdf-panel', el => el.hidden), '点击 X 按钮应隐藏小窗');
        await page.reload();
        await page.keyboard.press('F10');
        rect = await page.locator('#companion-pdf-panel').boundingBox();
        assert.equal(Math.round(rect.width), 620);
        assert.equal(Math.round(rect.height), 500);
        await loadCompanion(mixedPdfB64, 'mixed-B.pdf');
        assert.equal(await page.inputValue('#cp-page-input'), '2', '重载相同副文档恢复进度');
        await page.click('#cp-collapse-btn');
        await page.reload();
        await page.keyboard.press('F10');
        assert.equal(await page.evaluate(() => CompanionPdf.isCollapsed()), true);
        await page.click('#cp-collapse-btn');
        await loadCompanion(mixedPdfB64, 'mixed-B.pdf');
        assert.equal(await page.inputValue('#cp-page-input'), '2', '恢复折叠窗口也不能丢失文档进度');

        assert.deepEqual(errors, [], '过程中不应有任何未捕获错误');
        console.log('🎉 所有 Companion PDF 测试用例全部通过！');

        await context.close();
    } finally {
        if (browser) await browser.close();
        child.stdin.end();
        await new Promise(resolve => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', resolve);
            setTimeout(() => { child.kill(); resolve(); }, 3000).unref();
        });
    }
})().catch(err => {
    console.error('测试失败:', err);
    process.exit(1);
});
