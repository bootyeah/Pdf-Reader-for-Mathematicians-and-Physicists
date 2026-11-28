// 真实 Python 后端 + 真实 AirtexServer/WebSocket + 桌面端与手机触控端联合端到端测试：
// 验证跨场景统一白板免重扫连接、无界草稿本真实界面映射、双指缩放平移、实时笔迹纯显示（不污染 PDF 批注）、三种跨页切换及转 LaTeX 段落。
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fixture, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

function startMockGlmServer() {
    const requests = [];
    let formulaReply = '$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$';
    let paragraphReply = '由勾股定理可得 $a^2+b^2=c^2$，进一步推导：\n\n$$c = \\sqrt{a^2+b^2}$$';
    const srv = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const prompt = body?.messages?.[0]?.content?.[0]?.text || '';
            const imageUrl = body?.messages?.[0]?.content?.[1]?.image_url?.url || '';
            const auth = req.headers.authorization || '';
            requests.push({ model: body.model, auth, prompt, imageUrl });
            const isParagraph = prompt.includes('相应段落');
            const content = isParagraph ? paragraphReply : formulaReply;
            const payload = JSON.stringify({
                model: body.model,
                choices: [{ message: { content } }]
            });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
            res.end(payload);
        });
    });
    return new Promise(resolve => {
        srv.listen(0, '127.0.0.1', () => resolve({
            server: srv,
            port: srv.address().port,
            requests,
            setReplies({ formula, paragraph }) {
                if (formula !== undefined) formulaReply = formula;
                if (paragraph !== undefined) paragraphReply = paragraph;
            }
        }));
    });
}

function startRealPythonReader(glmPort) {
    const pyCode = `
import functools, http.server, json, os, sys, tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(${JSON.stringify(path.resolve(__dirname, '..'))})
sys.path.insert(0, str(ROOT))
os.environ['PDF_READER_NO_BROWSER'] = '1'
tmp = tempfile.TemporaryDirectory(prefix='unified-hw-e2e-')
os.environ['PDF_READER_API_CONFIG'] = str(Path(tmp.name) / 'absent.json')

import server
import formula_bridge as bridge
from airtex import core, web
from tex import latex_ocr

def test_cfg(kind):
    cfg = dict(latex_ocr.DEFAULT_CONFIG if kind == 'image' else core.DEFAULT_CONFIG)
    cfg.update(
        api_key='glm-test-formula-key',
        base_url='http://127.0.0.1:${glmPort}',
        model='glm-4.6v-flash',
        fallback_model='glm-4v-flash',
        debug_keep_png=False,
    )
    return cfg

bridge._config = test_cfg
core.get_lan_ips = lambda: ['127.0.0.1']

class QuietHandler(server.PDFReaderHandler):
    def log_message(self, *_):
        pass

httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
print(json.dumps({'origin': f'http://127.0.0.1:{httpd.server_port}'}), flush=True)
try:
    httpd.serve_forever()
finally:
    bridge.close_all()
    tmp.cleanup()
`;
    const child = spawn('python', ['-c', pyCode], { stdio: ['pipe', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
        let out = '', err = '';
        child.stdout.on('data', chunk => {
            out += chunk.toString('utf8');
            const line = out.split(/\r?\n/).find(l => l.trim().startsWith('{'));
            if (line) {
                resolve({
                    origin: JSON.parse(line).origin,
                    stop: () => new Promise(r => {
                        child.once('exit', () => r());
                        child.kill();
                    })
                });
            }
        });
        child.stderr.on('data', chunk => { err += chunk.toString('utf8'); });
        child.once('exit', code => reject(new Error(`Python server exited early (${code}): ${err}`)));
    });
}

(async () => {
    const glm = await startMockGlmServer();
    const py = await startRealPythonReader(glm.port);
    const pdfBuffer = await fixture('text', 3);
    const browser = await chromium.launch({
        executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: true
    });

    const desktop = await browser.newPage({ viewport: { width: 1520, height: 960 } });
    const mobileCtx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true
    });
    const phone = await mobileCtx.newPage();
    const cdp = await mobileCtx.newCDPSession(phone);
    await phone.addInitScript(() => {
        Element.prototype.requestFullscreen = () => Promise.reject(new Error('headless'));
    });

    const errors = [];
    const startCalls = [];
    for (const p of [desktop, phone]) p.on('pageerror', e => errors.push(String(e)));
    desktop.on('response', async res => {
        if (res.url().includes('/api/') && res.status() >= 400) {
            console.error('API ERROR:', res.status(), res.url(), await res.text().catch(() => ''));
        }
    });
    desktop.on('request', req => {
        if (req.url().endsWith('/api/formula/phone') && req.method() === 'POST') {
            try {
                const body = req.postDataJSON();
                if (body?.action === 'start') startCalls.push(body);
            } catch (_) {}
        }
    });

    async function touchStroke(normPoints, colorHex = null) {
        if (colorHex) {
            const colorBtn = phone.locator(`[data-color="${colorHex}"]`);
            if (await colorBtn.isVisible()) await colorBtn.tap();
        }
        const box = await phone.locator('#board').boundingBox();
        for (let i = 0; i < normPoints.length; i++) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: i === 0 ? 'touchStart' : 'touchMove',
                touchPoints: [{
                    id: 1,
                    x: box.x + normPoints[i][0] * box.width,
                    y: box.y + normPoints[i][1] * box.height,
                    radiusX: 6,
                    radiusY: 6
                }]
            });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await phone.waitForTimeout(160);
        await phone.waitForFunction(() => !window.__airtex.dirty);
    }

    async function pinchAndPan(before, after) {
        const box = await phone.locator('#board').boundingBox();
        const toPts = pts => pts.map(([id, rx, ry]) => ({
            id, x: box.x + rx * box.width, y: box.y + ry * box.height, radiusX: 8, radiusY: 8
        }));
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: toPts(before) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: toPts(after) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await phone.waitForTimeout(120);
    }

    try {
        await desktop.goto(`${py.origin}/index.html`);
        await desktop.locator('#file-input').setInputFiles({
            name: 'book.pdf',
            mimeType: 'application/pdf',
            buffer: pdfBuffer
        });
        await desktop.waitForFunction(() => typeof state !== 'undefined' && state.pdfDoc?.numPages === 3 && state.pagesRendered.has(1));
        await desktop.waitForFunction(() => state.annotationsLoading === false);

        // =====================================================================
        // 1. 统一白板测试：手写白板扫码一次 -> 写草稿 -> 打开批注公式编辑框无需重扫即可见同一画板并识别公式
        // =====================================================================
        await desktop.evaluate(() => HandwritingWhiteboard.show());
        await desktop.locator('#handwriting-whiteboard').waitFor({ state: 'visible' });
        await desktop.waitForFunction(() => {
            const href = document.getElementById('whiteboard-url')?.getAttribute('href');
            return !!href && href.startsWith('http://');
        });
        const pairUrl = await desktop.locator('#whiteboard-url').getAttribute('href');
        assert.equal(startCalls.length, 1, '首次打开手写白板仅创建 1 个统一会话');

        await phone.goto(pairUrl);
        await phone.waitForFunction(() => window.__airtex?.connected === true);
        await desktop.locator('#whiteboard-pairing').waitFor({ state: 'hidden' });

        // 在手机白板上写一段草稿
        await touchStroke([[0.25, 0.40], [0.55, 0.42], [0.70, 0.48]], '#dc2626');
        await desktop.waitForFunction(() => {
            const c = document.getElementById('whiteboard-pad');
            if (!c || !c.width) return false;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] > d[i + 1] + 40 && d[i] > d[i + 2] + 40) return true;
            }
            return false;
        });
        console.log('PASS 1a: 手机扫码连接手写白板后实时同步彩色草稿');

        // 添加一条批注并打开编辑框 -> 切到「手机」模式：免重新扫码，直接共享同一白板内容并识别公式
        await desktop.evaluate(() => {
            addAnnotation(1, { id: 'note-1', type: 'text', color: '#000000', x: 0.15, y: 0.2, text: '推导：' });
            renderAnnotations(1, true);
            initHistory();
            updateSaveStatus(false);
            const anno = state.annotations[1].find(a => a.id === 'note-1');
            openNoteModal({ ...anno, note: anno.text }, 1, 520, 200, true);
        });
        await desktop.locator('#formula-input-bar [data-mode="phone"]').click();
        assert.equal(startCalls.length, 1, '切换到批注公式编辑框绝不新建会话、无需重新扫码');
        assert.equal(await desktop.locator('#formula-phone-pairing').isVisible(), false, '二维码面板保持收起');
        assert.equal(await desktop.locator('#formula-phone-status').getAttribute('data-online'), 'true');
        await desktop.waitForFunction(() => {
            const c = document.getElementById('formula-phone-pad');
            if (!c || !c.width) return false;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] > d[i + 1] + 40 && d[i] > d[i + 2] + 40) return true;
            }
            return false;
        });

        await desktop.locator('#formula-phone-recognize').click();
        await desktop.locator('#formula-result').waitFor({ state: 'visible' });
        assert.match(await desktop.locator('#formula-code').inputValue(), /\\int_0\^1 x\^2/);
        assert.equal(glm.requests.at(-1).auth, 'Bearer glm-test-formula-key');
        assert.ok(!glm.requests.at(-1).prompt.includes('相应段落'), '批注公式编辑框使用公式识别提示词');
        assert.equal(await desktop.locator('#whiteboard-result').isVisible(), false, '公式识别结果不会污染独立白板结果面板');

        await desktop.locator('#formula-insert').click();
        await desktop.locator('#save-note-btn').click();
        assert.match(await desktop.evaluate(() => state.annotations[1].find(a => a.id === 'note-1').text), /\\int_0\^1/);
        await desktop.evaluate(() => HandwritingWhiteboard.hide());
        console.log('PASS 1b: 批注编辑框直接共享白板笔迹并完成公式识别插入，无需重扫且结果隔离');

        // =====================================================================
        // 2. 右侧无界草稿本连接手写：真实界面映射、缩放挪动、实时笔迹回传（不入批注文件）、跨页切换与转 LaTeX
        // =====================================================================
        // 先在第 1 页右侧无界草稿纸上放一个真实的已有文本块批注，再保存基线状态
        const annoCountBefore = await desktop.evaluate(() => {
            toggleSidecar(true, true);
            addAnnotation(1, { id: 'sc-existing', type: 'text', color: '#1d4ed8', x: 1.15, y: 0.12, text: '已知条件：$a^2+b^2=c^2$' });
            renderAnnotations(1, true);
            initHistory();
            updateSaveStatus(false);
            return state.annotations[1].length;
        });

        const triggerP1 = desktop.locator('#page-wrapper-1 .sidecar-hw-trigger');
        await triggerP1.waitFor({ state: 'visible' });
        assert.equal(await triggerP1.locator('.sidecar-hw-trigger-label').textContent(), '手机手写', '已连接状态下草稿纸按钮直接显示手机手写');
        await triggerP1.click();

        assert.equal(startCalls.length, 1, '开启无界草稿本手写仍复用同一手机连接');
        await phone.waitForFunction(() => window.__airtex.scene === 'sidecar' && window.__airtex.sidecarPage === 1 && window.__airtex.sidecarBgLoaded === true);
        assert.equal(await phone.locator('#pageNumber').textContent(), 'P1 / 3');
        assert.equal(await desktop.locator('#sidecar-hw-pairing').isVisible(), false, '已连手机在草稿本中无需弹出二维码');

        // 验证手机端真实绘制了映射过来的草稿纸界面（包含蓝色已有批注像素）
        const phoneHasMappedBlueAnno = await phone.locator('#board').evaluate(canvas => {
            const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 2] > d[i] + 45 && d[i + 2] > d[i + 1] + 25) return true;
            }
            return false;
        });
        assert.equal(phoneHasMappedBlueAnno, true, '第 1 页草稿纸上的已有公式批注真实界面已映射到手机画布');

        // 手机端双指捏合放大并平移后，在草稿纸下半区书写绿色笔迹
        const viewBefore = await phone.evaluate(() => window.__airtex.view);
        await pinchAndPan([[1, 0.35, 0.5], [2, 0.65, 0.5]], [[1, 0.20, 0.42], [2, 0.80, 0.42]]);
        const viewAfter = await phone.evaluate(() => window.__airtex.view);
        assert.ok(viewAfter.scale > viewBefore.scale * 1.25, '手机端映射界面支持双指缩放挪动');

        await touchStroke([[0.30, 0.60], [0.70, 0.62]], '#16a34a');

        // 验证笔迹实时回显到第 1 页无界草稿本画布上，且绝不污染 PDF 批注与未保存状态
        await desktop.waitForFunction(() => {
            const c = document.querySelector('#page-wrapper-1 .sidecar-ink-canvas');
            if (!c || !c.width) return false;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] > 100 && d[i + 1] > d[i] + 35 && d[i + 1] > d[i + 2] + 35) return true;
            }
            return false;
        });
        assert.equal(await desktop.evaluate(() => state.unsavedChanges), false, '草稿本实时手写仅作显示，不触发未保存状态');
        assert.equal(await desktop.evaluate(() => state.annotations[1].length), annoCountBefore, '草稿本实时手写绝不写入 state.annotations');
        console.log('PASS 2a: 无界草稿纸真实界面映射至手机、缩放挪动书写实时回显且不写入 PDF 批注');

        // =====================================================================
        // 3. 跨页切换测试：桌面点击切页 / 滚动自动跟随与锁定 / 手机端翻页按钮
        // =====================================================================
        await desktop.evaluate(() => ensurePdfPage(2));
        const triggerP2 = desktop.locator('#page-wrapper-2 .sidecar-hw-trigger');
        assert.equal(await triggerP2.locator('.sidecar-hw-trigger-label').textContent(), '切到本页');
        await triggerP2.click();

        await phone.waitForFunction(() => window.__airtex.sidecarPage === 2);
        assert.equal(await phone.locator('#pageNumber').textContent(), 'P2 / 3');
        assert.equal(await phone.evaluate(() => window.__airtex.strokes), 0, '切换到第 2 页后手机显示第 2 页空白草稿纸');

        // 在第 2 页用紫色画笔书写推导
        await touchStroke([[0.25, 0.35], [0.65, 0.35], [0.45, 0.50]], '#9333ea');
        await desktop.waitForFunction(() => SidecarHandwriting.getPageDoc(2)?.strokes?.length === 1);
        assert.equal(await desktop.evaluate(() => SidecarHandwriting.getPageDoc(1)?.strokes?.length), 1, '第 1 页草稿笔迹完好保留');

        // 滚动桌面端到第 3 页：默认自动跟随切到 P3
        await desktop.evaluate(() => scrollPdfPageIntoView(3, 'start'));
        await phone.waitForFunction(() => window.__airtex.sidecarPage === 3);
        assert.equal(await phone.locator('#pageNumber').textContent(), 'P3 / 3');

        // 点击锁定按钮（固定在 P3），再滚回第 1 页时手机保持在 P3 不跳页
        await desktop.locator('#sidecar-hw-follow').click();
        assert.equal(await desktop.locator('#sidecar-hw-follow').getAttribute('aria-pressed'), 'false');
        await desktop.evaluate(() => scrollPdfPageIntoView(1, 'start'));
        await desktop.waitForTimeout(380);
        assert.equal(await phone.evaluate(() => window.__airtex.sidecarPage), 3, '锁定本页后滚动查阅前文不会打断当前草稿页');
        await desktop.locator('#sidecar-hw-follow').click(); // 恢复跟随

        // 从手机端点击「上一页 ‹」切回第 2 页：桌面与手机同步切回 P2 且恢复第 2 页笔迹
        await phone.locator('#prevPageBtn').tap();
        await phone.waitForFunction(() => window.__airtex.sidecarPage === 2 && window.__airtex.strokes === 1);
        await desktop.waitForFunction(() => SidecarHandwriting.getActivePage() === 2);
        console.log('PASS 2b: 无界草稿本支持按钮切换、滚动自动跟随、页码锁定及手机端翻页，各页笔迹独立保留');

        // =====================================================================
        // 4. 手写转 LaTeX 段落（复用 GLM 公式密钥）与置入本页草稿纸
        // =====================================================================
        const glmCountBefore = glm.requests.length;
        await desktop.locator('#sidecar-hw-recognize').click();
        await desktop.locator('#sidecar-hw-result').waitFor({ state: 'visible' });
        assert.equal(glm.requests.length, glmCountBefore + 1);
        assert.equal(glm.requests.at(-1).auth, 'Bearer glm-test-formula-key', '沿用 GLM 公式识别 API Key');
        assert.equal(glm.requests.at(-1).model, 'glm-4.6v-flash');
        assert.ok(glm.requests.at(-1).prompt.includes('相应段落'), '使用 LaTeX 段落识别提示词');
        assert.ok(await desktop.locator('#sidecar-hw-preview .katex').count() >= 2, '预览区正确渲染行内与行间 LaTeX 公式');

        // 点击「置入草稿」：在第 2 页草稿纸对应位置生成文本批注，清空临时手写，并支持 Ctrl+Z 撤销
        await desktop.locator('#sidecar-hw-stamp').click();
        await desktop.waitForFunction(() => (state.annotations[2] || []).length === 1);
        const stampedAnno = await desktop.evaluate(() => state.annotations[2][0]);
        assert.equal(stampedAnno.type, 'text');
        assert.ok(stampedAnno.x > 1.0 && stampedAnno.x < 1.9, `置入坐标落在右侧草稿纸区域: x=${stampedAnno.x}`);
        assert.match(stampedAnno.text, /勾股定理/);
        await phone.waitForFunction(() => window.__airtex.strokes === 0, null, { timeout: 5000 });
        console.log('PASS 2c: 无界草稿本手写转 LaTeX 段落（复用 GLM 密钥）并精准置入对应页草稿纸');

        // =====================================================================
        // 5. 切回独立手写白板：恢复原先的自由白板草稿，第 1 页草稿纸上的显示笔迹依然保留
        // =====================================================================
        await desktop.evaluate(() => HandwritingWhiteboard.show());
        await phone.waitForFunction(() => window.__airtex.scene === 'board' && window.__airtex.strokes === 1);
        assert.equal(await desktop.evaluate(() => SidecarHandwriting.getPageDoc(1)?.strokes?.length), 1, '切回自由白板后无界草稿本已写笔迹仍保留显示');
        assert.equal(startCalls.length, 1, '全流程仅 1 次配对会话');
        assert.deepEqual(errors, []);
        console.log('PASS 3: 全场景切换无缝衔接，零重扫、零前端报错');
    } finally {
        await browser.close();
        await py.stop();
        await new Promise(r => glm.server.close(r));
    }
})().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
