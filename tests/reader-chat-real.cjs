// 真实 DeepSeek 链路的对话 → TikZ → 本地引擎 端到端验证（可选，默认不跑）
// -----------------------------------------------------------------------------
// 会真的调用 DeepSeek（消耗额度），因此默认只在显式开启时运行：
//     $env:READER_TEST_REAL_CHAT = '1'; node tests/reader-chat-real.cjs
// 验证的是「模型按 server.py 的 CHAT_SYSTEM_PROMPT 输出 TikZ，面板把它画出来」这条链，
// 失败时会把模型的原文打印出来，便于判断是提示词问题还是渲染问题。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startBackend } = require('./chat-backend.cjs');
const deps = process.env.READER_TEST_NODE_MODULES || 'node_modules';
const { chromium } = require(path.join(deps, 'playwright'));

const root = path.resolve(__dirname, '..');
const resultsDir = path.join(root, 'tests', 'results');
const saveArtifacts = process.env.READER_TEST_ARTIFACTS === '1';
const BROWSER = process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const QUESTION = process.env.READER_TEST_QUESTION ||
    '请画一张图说明单位圆上角 θ 的正弦线：标出单位圆、角 θ、终边、以及长度为 sinθ 的竖直线段。';

(async () => {
    if (process.env.READER_TEST_REAL_CHAT !== '1') {
        console.log('已跳过（真实 API 测试：设置 READER_TEST_REAL_CHAT=1 后运行）');
        return;
    }
    if (saveArtifacts) fs.mkdirSync(resultsDir, { recursive: true });
    let backend = null;
    let browser = null;
    try {
        backend = await startBackend();

        browser = await chromium.launch({ executablePath: BROWSER, headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto(backend.origin + '/LOCALPdfReader.html');
        await page.click('#deepseek-chat-btn');
        await page.evaluate(() => {
            const p = document.getElementById('ds-chat-panel');
            p.style.left = '40px'; p.style.top = '80px';
            p.style.width = '560px'; p.style.height = '900px';
        });

        await page.fill('#ds-chat-input', QUESTION);
        await page.click('#ds-chat-send-btn');
        console.log('已发送：' + QUESTION);

        let outcome = 'none';
        try {
            await page.waitForFunction(() => {
                const img = document.querySelector('#ds-chat-body .ds-tikz img');
                return !!img && img.naturalWidth > 0;
            }, null, { timeout: 180000 });
            outcome = 'rendered';
        } catch (e) {
            outcome = await page.evaluate(() => {
                if (document.querySelector('#ds-chat-body .ds-tikz-error')) return 'error';
                if (document.querySelector('#ds-chat-body .ds-tikz')) return 'stuck';
                return 'no-tikz';
            });
        }
        await page.waitForTimeout(500);

        const detail = await page.evaluate(() => {
            const img = document.querySelector('#ds-chat-body .ds-tikz img');
            const err = document.querySelector('#ds-chat-body .ds-tikz-error');
            const bubbles = document.querySelectorAll('#ds-chat-body .ds-msg-assistant .ds-content');
            const last = bubbles[bubbles.length - 1];
            return {
                answer: last ? last.innerText : '',
                size: img ? img.naturalWidth + 'x' + img.naturalHeight : '',
                error: err ? err.innerText : ''
            };
        });
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'chat-tikz-real.png') });

        console.log('--- 模型回答 ---\n' + detail.answer.slice(0, 2500));
        if (detail.error) console.log('--- 渲染报错 ---\n' + detail.error);
        console.log('--- 结论 ---\n' + outcome + (detail.size ? '（图 ' + detail.size + '）' : ''));
        if (saveArtifacts) console.log('截图: tests/results/chat-tikz-real.png');
        assert.deepEqual(errors, []);
        assert.equal(outcome, 'rendered', '真实模型回答未能渲染出 TikZ 图形（见上面的原文）');
        console.log('PASS 真实 DeepSeek 回答里的 TikZ 已被本地引擎渲染');
    } catch (err) {
        console.error('FAIL ' + (err && err.stack || err));
        if (backend && backend.log.length) console.error('--- server.py ---\n' + backend.log.join('').slice(-2000));
        process.exitCode = 1;
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (backend) await backend.stop();
    }
})();
