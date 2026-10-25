const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const deps = 'node_modules';
const { chromium } = require(path.join(deps, 'playwright'));
const { PDFDocument, StandardFonts } = require(path.join(root, 'static/lib/pdf-lib.min.js'));

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
    const child = spawn('python', ['-u', '-c', serverSource], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let browser;
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
        });

        const doc1 = await PDFDocument.create();
        const font = await doc1.embedFont(StandardFonts.Helvetica);
        for (let i = 1; i <= 3; i++) {
            doc1.addPage([800, 1200]).drawText('Main Page ' + i, { x: 50, y: 1000, font, size: 24 });
        }
        const mainPdfB64 = Buffer.from(await doc1.save()).toString('base64');

        const doc2 = await PDFDocument.create();
        for (let i = 1; i <= 3; i++) {
            doc2.addPage([1000, 1600]).drawText('Companion Page ' + i, { x: 50, y: 1400, font, size: 24 });
        }
        const companionPdfB64 = Buffer.from(await doc2.save()).toString('base64');

        browser = await chromium.launch({
            executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            headless: true
        });

        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        await page.goto(origin + '/index.html');
        await page.waitForLoadState('networkidle');

        // 加载主文档
        await page.evaluate(async b64 => {
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const file = new File([bytes], 'main-document.pdf', { type: 'application/pdf' });
            await processSelectedFile(file, null);
        }, mainPdfB64);

        await page.waitForFunction(() => state.pdfDoc?.numPages === 3);
        console.log('✔ 主文档加载成功');

        // ==========================================
        // 测试 1: 小窗抓手功能与保持抓取按钮
        // ==========================================
        await page.evaluate(() => window.CompanionPdf.show());
        await page.waitForSelector('#companion-pdf-panel:not([hidden])');

        // 加载副文档
        await page.evaluate(b64 => {
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const file = new File([bytes], 'companion-test.pdf', { type: 'application/pdf' });
            return window.CompanionPdf.loadFile(file);
        }, companionPdfB64);

        await page.waitForFunction(() => document.querySelector('#cp-hand-btn') !== null);
        console.log('✔ 对照小窗副文档加载成功，抓手按钮存在');

        // 验证抓手按钮存在且初始未激活
        const handBtn = await page.$('#cp-hand-btn');
        assert.ok(handBtn, 'cp-hand-btn 必须存在于小窗缩放组中');
        assert.ok(await page.$eval('#cp-hand-btn .ph-hand-palm', el => !!el), '抓手按钮必须包含 ph-hand-palm 图标');

        const isInitiallyActive = await page.$eval('#cp-hand-btn', el => el.classList.contains('active'));
        assert.equal(isInitiallyActive, false, '抓手按钮初始应未激活');

        // 点击抓手按钮 -> 保持抓取状态
        await page.click('#cp-hand-btn');
        const isActiveAfterClick = await page.$eval('#cp-hand-btn', el => el.classList.contains('active'));
        assert.equal(isActiveAfterClick, true, '点击后抓手按钮应保持激活状态');
        const isViewportGrab = await page.$eval('#companion-pdf-viewport', el => el.classList.contains('cp-hand-active'));
        assert.equal(isViewportGrab, true, '激活后小窗视口应具有 cp-hand-active 类 (cursor: grab)');

        // 在保持抓取状态下，使用鼠标拖拽平移视口
        await page.evaluate(() => {
            const vp = document.getElementById('companion-pdf-viewport');
            vp.scrollTop = 100;
        });
        const initialScrollTop = await page.$eval('#companion-pdf-viewport', el => el.scrollTop);

        // 模拟鼠标左键拖拽平移
        const vpBox = await page.locator('#companion-pdf-viewport').boundingBox();
        await page.mouse.move(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2);
        await page.mouse.down();
        const isGrabbing = await page.$eval('#companion-pdf-viewport', el => el.classList.contains('cp-hand-grabbing'));
        assert.equal(isGrabbing, true, '按下左键拖拽时应具有 cp-hand-grabbing 类 (cursor: grabbing)');
        await page.mouse.move(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2 - 80);
        await page.mouse.up();

        const draggedScrollTop = await page.$eval('#companion-pdf-viewport', el => el.scrollTop);
        assert.ok(draggedScrollTop > initialScrollTop, '抓手拖拽后 scrollTop 应增大');
        console.log('✔ 抓手按钮保持激活状态与拖拽平移正常');

        // 再次点击抓手按钮 -> 退出保持抓取状态
        await page.click('#cp-hand-btn');
        assert.equal(await page.$eval('#cp-hand-btn', el => el.classList.contains('active')), false, '再次点击退出抓手模式');
        assert.equal(await page.$eval('#companion-pdf-viewport', el => el.classList.contains('cp-hand-active')), false, '视口恢复默认指针');

        // 移动到视口并点击，使焦点位于视口内（非按钮上）
        await page.mouse.move(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2);
        await page.mouse.click(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2);

        // 测试空格键触发抓手模式
        await page.keyboard.down('Space');
        const isSpaceGrab = await page.$eval('#companion-pdf-viewport', el => el.classList.contains('cp-hand-active'));
        assert.equal(isSpaceGrab, true, '按下空格键时小窗视口应进入 cp-hand-active 抓手状态');

        // 按住空格拖拽
        const beforeSpaceDrag = await page.$eval('#companion-pdf-viewport', el => el.scrollTop);
        await page.mouse.move(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2 - 60);
        await page.mouse.up();
        const afterSpaceDrag = await page.$eval('#companion-pdf-viewport', el => el.scrollTop);
        assert.ok(afterSpaceDrag > beforeSpaceDrag, '空格拖拽后 scrollTop 应增大');

        await page.keyboard.up('Space');
        const isSpaceReleased = await page.$eval('#companion-pdf-viewport', el => el.classList.contains('cp-hand-active'));
        assert.equal(isSpaceReleased, false, '松开空格键后退出抓手状态');
        console.log('✔ 空格键激活抓手与拖动功能正常');

        // 测试小窗拖动到工具栏上方 (top < 72px)
        const headerBox = await page.locator('#companion-pdf-header').boundingBox();
        await page.mouse.move(headerBox.x + 80, headerBox.y + headerBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(headerBox.x + 80, 8);
        await page.mouse.up();
        const panelTop = await page.$eval('#companion-pdf-panel', el => el.getBoundingClientRect().top);
        assert.ok(panelTop < 72, `小窗应能够被拖动到工具栏上方（当前 top: ${panelTop}px < 72px）`);
        assert.ok(panelTop >= 0, `小窗 top 不应小于 0（当前 top: ${panelTop}px）`);
        console.log('✔ 对照小窗成功拖动到工具栏上方 (top: ' + panelTop + 'px)');

        // 测试按键 P 快捷折叠与展开
        assert.equal(await page.evaluate(() => window.CompanionPdf.isCollapsed()), false, '折叠前处于展开状态');
        await page.keyboard.press('p');
        await page.waitForFunction(() => window.CompanionPdf.isCollapsed() === true);
        const collapsedH = await page.$eval('#companion-pdf-panel', el => el.offsetHeight);
        assert.equal(collapsedH, 40, '按 P 键后小窗应折叠为 40px 高度');

        // 再次按按键 P 展开小窗
        await page.keyboard.press('p');
        await page.waitForFunction(() => window.CompanionPdf.isCollapsed() === false);
        const expandedH = await page.$eval('#companion-pdf-panel', el => el.offsetHeight);
        assert.ok(expandedH > 100, '再次按 P 键后小窗应恢复展开高度');

        // 测试大写 P 也能折叠
        await page.keyboard.press('KeyP');
        await page.waitForFunction(() => window.CompanionPdf.isCollapsed() === true);
        assert.equal(await page.evaluate(() => window.CompanionPdf.isCollapsed()), true, '按 KeyP 键折叠');
        await page.keyboard.press('KeyP');
        await page.waitForFunction(() => window.CompanionPdf.isCollapsed() === false);
        assert.equal(await page.evaluate(() => window.CompanionPdf.isCollapsed()), false, '按 KeyP 键展开');

        // 验证在输入框中输入 p 不会误触发折叠
        await page.click('#cp-page-input');
        await page.keyboard.press('p');
        assert.equal(await page.evaluate(() => window.CompanionPdf.isCollapsed()), false, '在页码输入框中按 p 不应触发折叠');
        // 点击主阅读器空白处失焦
        await page.mouse.click(10, 500);

        console.log('✔ 按键 P 快捷折叠/展开对照小窗功能正常');

        // 关闭对照小窗，恢复主视口焦点
        await page.evaluate(() => window.CompanionPdf.hide());

        // ==========================================
        // 测试 2: 手写白板“拍”入页面功能
        // ==========================================
        await page.evaluate(() => window.HandwritingWhiteboard.show());
        await page.waitForSelector('#handwriting-whiteboard:not([hidden])');

        // 模拟白板识别结果生成并展示
        await page.evaluate(() => {
            const codeEl = document.getElementById('whiteboard-code');
            codeEl.value = 'E = mc^2 \\quad \\text{质能方程}';
            // 触发内部结果展示
            const resEl = document.getElementById('whiteboard-result');
            resEl.hidden = false;
            const toggle = document.getElementById('whiteboard-result-toggle');
            if (toggle) toggle.hidden = false;
        });

        // 验证拍入按钮存在
        const stampBtn = await page.$('#whiteboard-stamp');
        assert.ok(stampBtn, 'whiteboard-stamp 按钮必须存在于白板识别结果顶栏中');

        // 验证没有文字
        const btnText = await page.$eval('#whiteboard-stamp', el => {
            // 获取所有直接文本或 span 文本
            return (el.innerText || el.textContent || '').trim();
        });
        assert.equal(btnText, '', '拍入按钮必须没有文字');

        // 验证具有拍下手掌图案 (ph-hand-palm)
        const hasHandIcon = await page.$eval('#whiteboard-stamp', el => !!el.querySelector('.ph-hand-palm'));
        assert.ok(hasHandIcon, '拍入按钮应包含简洁的手掌图案 (.ph-hand-palm)');

        // 记录拍入前的第 1 页批注数量
        const beforeAnnoCount = await page.evaluate(() => (state.annotations[1] || []).length);

        // 点击拍入按钮
        await page.click('#whiteboard-stamp');

        // 验证第 1 页新增了一个 text 类型的批注，且文本内容为识别的内容
        const afterAnnos = await page.evaluate(() => state.annotations[1] || []);
        assert.equal(afterAnnos.length, beforeAnnoCount + 1, '第 1 页应新增 1 条批注');
        const lastAnno = afterAnnos[afterAnnos.length - 1];
        assert.equal(lastAnno.type, 'text', '批注类型必须为 text 文本块');
        assert.equal(lastAnno.text, 'E = mc^2 \\quad \\text{质能方程}', '文本块内容应与识别结果一致');
        assert.ok(lastAnno.x > 0 && lastAnno.x < 1, '坐标 x 应在合法相对比例范围内');
        assert.ok(lastAnno.y > 0 && lastAnno.y < 1, '坐标 y 应在合法相对比例范围内');

        // 验证页面 DOM 中渲染了该文本块
        await page.waitForSelector(`.text-annotation[data-id="${lastAnno.id}"]`);
        console.log('✔ 手写白板拍入按钮成功将识别内容变成文本块插入页面中');

        // 验证按钮反馈与提示消息
        const toastText = await page.$eval('#whiteboard-status', el => el.textContent);
        assert.match(toastText, /已将识别内容拍入第 1 页/, '白板状态栏应提示拍入成功消息');

        // ==========================================
        // 测试 3: 公式渲染区域优化与代码隐藏在渲染后点击才显示
        // ==========================================
        // 模拟新的复杂数学公式识别结果
        await page.evaluate(() => {
            const codeEl = document.getElementById('whiteboard-code');
            codeEl.value = '质能方程推导：$$\\int_{a}^{b} f(x) dx = F(b) - F(a)$$ 其中 $x \\in \\mathbb{R}$';
            codeEl.dispatchEvent(new Event('input', { bubbles: true }));
        });

        // 验证代码输入框默认隐藏（藏在渲染后面）
        const isCodeHidden = await page.$eval('#whiteboard-code', el => el.hidden || getComputedStyle(el).display === 'none');
        assert.equal(isCodeHidden, true, '识别后 LaTeX 代码区域应默认隐藏在渲染后面');

        // 验证公式预览区域显示且尺寸充足（不再被挤压）
        const previewBox = await page.$eval('#whiteboard-preview', el => {
            const rect = el.getBoundingClientRect();
            return { width: rect.width, height: rect.height, text: el.textContent };
        });
        assert.ok(previewBox.height >= 80, `公式渲染区域高度应充足（当前高度: ${previewBox.height}px >= 80px）`);
        assert.ok(previewBox.width > 200, '公式渲染区域宽度应充足');

        // 验证 KaTeX 公式成功渲染
        const katexElements = await page.$eval('#whiteboard-preview', el => el.querySelectorAll('.katex').length);
        assert.ok(katexElements >= 2, '公式渲染区域应正确渲染 KaTeX 公式');

        // 验证代码展开切换条存在且处于收起状态
        const codeBarVisible = await page.$eval('#whiteboard-code-bar', el => !el.hidden && getComputedStyle(el).display !== 'none');
        assert.equal(codeBarVisible, true, '切换条 #whiteboard-code-bar 应处于可见状态');
        const codeBarExpanded = await page.$eval('#whiteboard-code-bar', el => el.getAttribute('aria-expanded'));
        assert.equal(codeBarExpanded, 'false', '切换条默认 aria-expanded 应为 false');

        // 点击切换条展开代码
        await page.click('#whiteboard-code-bar');
        const isCodeVisibleAfterClick = await page.$eval('#whiteboard-code', el => !el.hidden && getComputedStyle(el).display !== 'none');
        assert.equal(isCodeVisibleAfterClick, true, '点击展开条后 LaTeX 代码区域应显示');

        // 再次点击切换条收起代码
        await page.click('#whiteboard-code-bar');
        const isCodeHiddenAfterSecondClick = await page.$eval('#whiteboard-code', el => el.hidden || getComputedStyle(el).display === 'none');
        assert.equal(isCodeHiddenAfterSecondClick, true, '再次点击展开条后 LaTeX 代码区域应收起隐藏');

        // 点击顶栏的展开代码按钮
        await page.click('#whiteboard-code-toggle');
        const isCodeVisibleAfterToggleBtn = await page.$eval('#whiteboard-code', el => !el.hidden && getComputedStyle(el).display !== 'none');
        assert.equal(isCodeVisibleAfterToggleBtn, true, '点击顶栏展开代码按钮后代码区域应显示');

        // 再次点击顶栏按钮收起
        await page.click('#whiteboard-code-toggle');
        const isCodeHiddenAfterToggleBtn2 = await page.$eval('#whiteboard-code', el => el.hidden || getComputedStyle(el).display === 'none');
        assert.equal(isCodeHiddenAfterToggleBtn2, true, '再次点击顶栏按钮后代码区域应收起隐藏');

        console.log('✔ 公式渲染区域优化与代码隐藏交互测试全部通过');

        console.log('🎉 所有新增功能端到端测试全部通过！');

    } finally {
        if (browser) await browser.close();
        child.kill();
    }
})();

