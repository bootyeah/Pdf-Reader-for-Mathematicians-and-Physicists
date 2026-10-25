// DeepSeek 对话面板里的 TikZ 自动渲染回归测试
// -----------------------------------------------------------------------------
// 验证：模型回答里的 TikZ 代码（裸写或 ```tikz 围栏）会被本地 LaTeX 引擎渲染成矢量图，
//       流式生成期间不编译未闭合的代码块、同一段代码只编译一次；
//       渲染失败时不吞掉回答、给出可查看的源码；刷新后历史消息里的图仍然能画出来。
//
// 运行：node tests/reader-chat-tikz.cjs
// 依赖：python server.py（本脚本自己拉起，结束自动关掉）、Playwright + Edge、本机 TeX Live。
// 说明：/api/chat 被页面内的 fetch 桩替换成按脚本分片的 SSE，不消耗真实 API 额度。
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

const checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };

// 页面内的 fetch 桩：/api/chat 返回按脚本分片的 SSE；/api/render-tikz 原样放行并记账
const CHAT_STUB = () => {
    window.__tikz = { renderBodies: [], chatCalls: 0, script: [], gap: 30 };
    const realFetch = window.fetch.bind(window);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.fetch = function (input, init) {
        let url = typeof input === 'string' ? input : (input && input.url) || '';
        try { url = new URL(url, location.href).pathname; } catch (e) { /* 原样 */ }
        if (url === '/api/render-tikz') {
            window.__tikz.renderBodies.push(String((init && init.body) || ''));
        }
        if (url === '/api/chat') {
            window.__tikz.chatCalls++;
            const steps = window.__tikz.script.slice();
            const enc = new TextEncoder();
            const signal = init && init.signal;
            const stream = new ReadableStream({
                async start(controller) {
                    for (const step of steps) {
                        controller.enqueue(enc.encode('data: ' + JSON.stringify({ delta: step.d }) + '\n\n'));
                        await sleep(step.w == null ? window.__tikz.gap : step.w);
                    }
                    if (window.__tikz.holdOpen) {
                        // 模拟「还在生成」：真 fetch 在 abort 时会让读取以 AbortError 失败，这里照做
                        await new Promise(resolve => {
                            if (signal && signal.aborted) return resolve();
                            if (signal) signal.addEventListener('abort', resolve, { once: true });
                        });
                        throw new DOMException('The user aborted a request.', 'AbortError');
                    }
                    controller.enqueue(enc.encode('data: ' + JSON.stringify({ done: true }) + '\n\n'));
                    controller.close();
                }
            });
            return Promise.resolve(new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
            }));
        }
        return realFetch(input, init);
    };
};

(async () => {
    if (saveArtifacts) fs.mkdirSync(resultsDir, { recursive: true });
    let backend = null;
    let browser = null;
    try {
        backend = await startBackend();
        const ORIGIN = backend.origin;
        pass('Local backend (server.py) is up on ' + ORIGIN);

        browser = await chromium.launch({ executablePath: BROWSER, headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await page.addInitScript(CHAT_STUB);
        await page.goto(ORIGIN + '/LOCALPdfReader.html');
        await page.waitForFunction(() => !!window.__tikz, { timeout: 10000 });

        // 面板摆到固定位置，方便截图对比
        await page.click('#deepseek-chat-btn');
        await page.waitForSelector('#ds-chat-panel', { state: 'visible' });
        await page.evaluate(() => {
            const p = document.getElementById('ds-chat-panel');
            p.style.left = '40px';
            p.style.top = '80px';
            p.style.width = '560px';
            p.style.height = '840px';
        });

        // ---------- 1. 裸写的 TikZ：流式期间不编译，闭合后恰好编译一次 ----------
        await page.evaluate(() => {
            window.__tikz.script = [
                { d: '下面用 TikZ 画一个抛物线与切线示意图：\n\n', w: 30 },
                { d: '\\begin{tikzpicture}[scale=0.9]\n  \\draw[->] (0,0) -- (3,0) node[right]{$x$};\n', w: 30 },
                { d: '  \\draw[->] (0,0) -- (0,2.2) node[above]{$y$};\n  \\draw[blue,thick,domain=0:2.2,samples=60] plot (\\x,{0.45*\\x*\\x});\n', w: 2200 },
                { d: '  \\fill[red] (1.6,1.15) circle (1.6pt);\n  \\node[red,right] at (1.6,1.15) {切点};\n\\end{tikzpicture}\n\n', w: 30 },
                { d: '图中蓝线为 $y=0.45x^2$，红点是切点。', w: 10 }
            ];
        });
        await page.fill('#ds-chat-input', '画一个抛物线示意图');
        await page.click('#ds-chat-send-btn');

        // 流式进行到一半（tikz 还没闭合）：只允许出现占位符，绝不能发起编译
        await page.waitForFunction(
            () => document.querySelector('#ds-chat-body .ds-tikz-pending'),
            null,
            { timeout: 15000 }
        );
        const mid = await page.evaluate(() => ({
            calls: window.__tikz.renderBodies.length,
            placeholder: !!document.querySelector('#ds-chat-body .ds-tikz-pending'),
            streaming: !!document.querySelector('#ds-chat-panel.is-streaming')
        }));
        assert.deepEqual(mid, { calls: 0, placeholder: true, streaming: true });
        pass('Incomplete TikZ during streaming shows a placeholder and triggers no compile');

        await page.waitForFunction(() => {
            const img = document.querySelector('#ds-chat-body .ds-tikz img');
            return !!img && img.naturalWidth > 0;
        }, null, { timeout: 60000 });
        await page.waitForTimeout(900);

        const first = await page.evaluate(() => {
            const fig = document.querySelector('#ds-chat-body .ds-tikz');
            const img = fig.querySelector('img');
            return {
                calls: window.__tikz.renderBodies.length,
                src: img.getAttribute('src').slice(0, 26),
                w: img.naturalWidth,
                h: img.naturalHeight,
                pending: !!fig.querySelector('.ds-tikz-pending'),
                textHasSource: document.querySelector('#ds-chat-body .ds-content').innerText.indexOf('begin{tikzpicture}') !== -1,
                body: window.__tikz.renderBodies[0] || ''
            };
        });
        assert.equal(first.calls, 1, '同一段 TikZ 在整段流式输出里只编译一次');
        assert.equal(first.src, 'data:image/svg+xml;base64,');
        assert.ok(first.w > 40 && first.h > 40, 'SVG 尺寸异常: ' + first.w + 'x' + first.h);
        assert.equal(first.pending, false);
        assert.equal(first.textHasSource, false, '源码不应直接铺在正文里');
        assert.ok(first.body.indexOf('\\documentclass') === 0, '发给引擎的应是完整可编译文档');
        assert.ok(first.body.indexOf('\\begin{tikzpicture}') !== -1);
        assert.ok(first.body.indexOf('{ctex}') !== -1, '正文含中文（切点）应自动挂载 ctex');
        pass('Bare TikZ in the answer renders to an SVG figure with a single compile');

        // 源码折叠区：默认收起，可展开
        const sourceToggle = await page.evaluate(() => {
            const btn = document.querySelector('#ds-chat-body .ds-tikz-toggle');
            if (!btn) return null;
            const pre = document.querySelector('#ds-chat-body .ds-tikz-source');
            const before = pre.hasAttribute('hidden');
            btn.click();
            const after = pre.hasAttribute('hidden');
            return { before, after, hasCode: pre.textContent.indexOf('\\draw') !== -1 };
        });
        assert.deepEqual(sourceToggle, { before: true, after: false, hasCode: true });
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'chat-tikz-source.png') });
        const sourceCollapsed = await page.evaluate(() => {
            const btn = document.querySelector('#ds-chat-body .ds-tikz-toggle');
            btn.click();
            return document.querySelector('#ds-chat-body .ds-tikz-source').hasAttribute('hidden');
        });
        assert.equal(sourceCollapsed, true);
        pass('Each figure keeps a collapsible, copyable TikZ source');

        // ---------- 2. ```tikz 围栏 + 中文标签：应渲染成图，而不是代码块 ----------
        await page.evaluate(() => {
            window.__tikz.script = [
                { d: '用围栏给出电路示意：\n\n```tikz\n\\begin{tikzpicture}\n  \\draw (0,0) to[R, l=$R_1$] (2,0) to[C, l=$C$] (4,0);\n  \\draw (4,0) -- (4,-1.2) -- (0,-1.2) -- (0,0);\n  \\node at (2,-1.7) {中文标注：低通滤波};\n\\end{tikzpicture}\n```\n\n其中 $R_1$ 与 $C$ 构成一阶低通。', w: 20 }
            ];
        });
        const beforeSecond = await page.evaluate(() => window.__tikz.renderBodies.length);
        await page.fill('#ds-chat-input', '画一个 RC 低通滤波电路');
        await page.click('#ds-chat-send-btn');
        await page.waitForFunction(n => {
            const imgs = document.querySelectorAll('#ds-chat-body .ds-tikz img');
            return imgs.length > n && imgs[imgs.length - 1].naturalWidth > 0;
        }, beforeSecond, { timeout: 60000 });

        const second = await page.evaluate(() => {
            const fig = document.querySelectorAll('#ds-chat-body .ds-tikz');
            const last = fig[fig.length - 1];
            return {
                figures: fig.length,
                fences: last.querySelectorAll('.ds-code-block').length,
                body: window.__tikz.renderBodies[window.__tikz.renderBodies.length - 1]
            };
        });
        assert.equal(second.figures, 2);
        assert.equal(second.fences, 0, '围栏里的 TikZ 不应再以代码块形式重复出现');
        assert.ok(second.body.indexOf('{ctex}') !== -1, '中文 TikZ 应自动挂载 ctex');
        assert.ok(second.body.indexOf('circuitikz') !== -1);
        pass('Fenced ```tikz block renders as a figure (Chinese labels auto-enable ctex)');

        // ---------- 3. 语法错误：不吞回答，给出可查看的源码 ----------
        await page.evaluate(() => {
            window.__tikz.script = [
                { d: '这段是故意写错的：\n\n\\begin{tikzpicture}\n  \\draw[thick] (0,0) -- (2,2;\n\\end{tikzpicture}\n\n其余文字照常显示。', w: 20 }
            ];
        });
        await page.fill('#ds-chat-input', '给我一个坏例子');
        await page.click('#ds-chat-send-btn');
        await page.waitForFunction(() => !!document.querySelector('#ds-chat-body .ds-tikz-error'), null, { timeout: 60000 });
        const broken = await page.evaluate(() => {
            const err = document.querySelector('#ds-chat-body .ds-tikz-error');
            const wrap = err.closest('.ds-msg');
            return { hasSource: !!err.closest('.ds-tikz').querySelector('.ds-tikz-source'), text: wrap.innerText };
        });
        assert.equal(broken.hasSource, true);
        assert.ok(broken.text.indexOf('其余文字照常显示') !== -1, '图形失败不能影响其余正文');
        pass('Broken TikZ shows an inline error with the source, rest of the answer survives');

        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'chat-tikz.png') });

        // ---------- 4. 刷新后历史消息里的图仍然要画出来 ----------
        const renderCallsBeforeReload = await page.evaluate(() => window.__tikz.renderBodies.length);
        await page.reload();
        await page.waitForFunction(() => !!window.__tikz, null, { timeout: 10000 });
        await page.click('#deepseek-chat-btn');
        await page.waitForFunction(() => {
            const img = document.querySelector('#ds-chat-body .ds-tikz img');
            return !!img && img.naturalWidth > 0;
        }, null, { timeout: 60000 });
        const afterReload = await page.evaluate(() => ({
            figures: document.querySelectorAll('#ds-chat-body .ds-tikz').length,
            images: document.querySelectorAll('#ds-chat-body .ds-tikz img').length
        }));
        assert.equal(afterReload.figures, 3);
        assert.equal(afterReload.images, 2, '两条正确的图应重新渲染，错误那条仍显示错误');
        assert.ok(renderCallsBeforeReload >= 3);
        pass('Figures in restored history render again after a page reload');

        // ---------- 6. 生成到一半按「停止」：不许留下永远转圈的占位符 ----------
        await page.evaluate(() => {
            window.__tikz.holdOpen = true;
            window.__tikz.script = [
                { d: '先给一半：\n\n\\begin{tikzpicture}\n  \\draw[thick] (0,0) -- (2,0);\n', w: 20 },
                { d: '  \\draw[thick] (2,0) -- (2,2);\n', w: 200 }
            ];
        });
        await page.fill('#ds-chat-input', '画个折线（我会中途停掉）');
        await page.click('#ds-chat-send-btn');
        try {
            await page.waitForFunction(() => !!document.querySelector('#ds-chat-body .ds-tikz-pending'), null, { timeout: 20000 });
        } catch (e) {
            const dump = await page.evaluate(() => ({
                input: document.getElementById('ds-chat-input').value,
                html: document.getElementById('ds-chat-body').innerHTML.slice(-1200),
                streaming: !!document.querySelector('#ds-chat-panel.is-streaming'),
                calls: window.__tikz.chatCalls
            }));
            throw new Error('没等到流式占位符：' + JSON.stringify(dump));
        }
        await page.click('#ds-chat-stop-btn');
        await page.waitForFunction(() => {
            const notes = Array.from(document.querySelectorAll('#ds-chat-body .ds-chat-note'));
            return notes.some(n => n.textContent.indexOf('已停止生成') !== -1);
        }, null, { timeout: 20000 });
        const aborted = await page.evaluate(() => {
            const notes = Array.from(document.querySelectorAll('#ds-chat-body .ds-chat-note'));
            const wrap = notes.filter(n => n.textContent.indexOf('已停止生成') !== -1)[0].closest('.ds-msg');
            return {
                pending: wrap.querySelectorAll('.ds-tikz-pending').length,
                source: wrap.querySelectorAll('.ds-code-block code').length,
                keepsText: wrap.innerText.indexOf('先给一半') !== -1,
                compiling: window.__tikz.renderBodies.some(b => b.indexOf('-- (2,2)') !== -1)
            };
        });
        assert.deepEqual(aborted, { pending: 0, source: 1, keepsText: true, compiling: false });
        pass('Stopping mid-figure leaves readable source (no endless spinner, no stray compile)');
        await page.evaluate(() => { window.__tikz.holdOpen = false; });

        // ---------- 7. 批注文本框（render.js 老路径）不受重构影响 ----------
        const annoPath = await page.evaluate(async () => {
            const box = document.createElement('div');
            box.id = 'anno-tikz-probe';
            box.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(box);
            const code = '\\begin{tikzpicture}\\draw[thick] (0,0) -- (1,1);\\end{tikzpicture}';
            // renderTikzToImg 是在 img.onload 里落图的，函数返回时图还没挂上去
            await renderTikzToImg(code, box, null, 1);
            for (let i = 0; i < 200 && !box.querySelector('img'); i++) {
                await new Promise(r => setTimeout(r, 50));
            }
            const img = box.querySelector('img');
            const body = window.__tikz.renderBodies[window.__tikz.renderBodies.length - 1] || '';
            return {
                hasImg: !!img,
                src: img ? img.getAttribute('src').slice(0, 26) : '',
                noCtex: body.indexOf('{ctex}') === -1,
                autoSized: img ? img.style.height.indexOf('em') !== -1 : false
            };
        });
        assert.deepEqual(annoPath, { hasImg: true, src: 'data:image/svg+xml;base64,', noCtex: true, autoSized: true });
        pass('Legacy annotation path renderTikzToImg() still renders (unchanged header sniffing)');

        assert.deepEqual(errors, [], '页面出现 JS 异常: ' + errors.join(' | '));
        pass('No uncaught page errors');

        if (saveArtifacts) console.log('\n截图: tests/results/chat-tikz.png');
        console.log('通过 ' + checks.length + ' 项检查');
    } catch (err) {
        console.error('\nFAIL ' + (err && err.stack || err));
        if (backend && backend.log.length) {
            console.error('--- server.py 输出 ---\n' + backend.log.join('').slice(-3000));
        }
        process.exitCode = 1;
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (backend) await backend.stop();
    }
})();
