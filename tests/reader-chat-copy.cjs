// Markdown 复制端到端回归：使用真实 Edge 剪贴板，SSE / TikZ 接口使用测试数据。
// 不调用 DeepSeek，不启动正式后端，不读写用户 PDF。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startServer, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));
const saveArtifacts = process.env.READER_TEST_ARTIFACTS === '1';

const tikz = String.raw`\begin{tikzpicture}
  \draw[->] (0,0) -- (2,0) node[right] {$x_1$};
\end{tikzpicture}`;
const code = 'const formula = "$x_1$"; // <tag> & "quoted"';
const answer = [
    '## 公式与图形', '',
    String.raw`行内 $x_1^2 + y_2^2 = 1$，以及 \(\alpha_i + \beta\)。`, '',
    String.raw`$$\int_0^1 x^2\,dx = \frac{1}{3}$$`, '',
    String.raw`\[\begin{pmatrix}a & b \\ c & d\end{pmatrix}\]`, '',
    '- **保留强调**、_斜体_ 和 `x_1`',
    '- [参考链接](https://example.com)', '',
    '> 引用中的公式 $E=mc^2$。', '',
    '| 项目 | 公式 |', '| --- | --- |', '| 系数 | $a_i$ |', '',
    '```js', code, '```', '', '```tikz', tikz, '```', '',
    '图形之后的文字 & <保留原文>。'
].join('\n');

const stubChat = () => {
    const originalFetch = window.fetch.bind(window);
    window.__chatCopyTest = { controller: null, requests: [] };
    window.fetch = (input, init) => {
        if (new URL(typeof input === 'string' ? input : input.url, location.href).pathname !== '/api/chat') {
            return originalFetch(input, init);
        }
        window.__chatCopyTest.requests.push(JSON.parse(init.body));
        const stream = new ReadableStream({
            start(controller) {
                window.__chatCopyTest.controller = controller;
                init.signal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')), { once: true });
            }
        });
        return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
    };
};

(async () => {
    const server = await startServer({});
    let browser;
    const checks = [], errors = [];
    const pass = name => { checks.push(name); console.log('PASS ' + name); };
    try {
        browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
        page.on('pageerror', e => errors.push(String(e)));
        await page.addInitScript(stubChat);
        let renderCount = 0;
        await page.route('**/api/render-tikz', async route => {
            renderCount++;
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="50"><path d="M10 25h210l-8 -5m8 5l-8 5" stroke="#334155" fill="none"/></svg>';
            await route.fulfill({ status: 200, body: Buffer.from(svg).toString('base64') });
        });
        const url = `http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`;
        await page.goto(url);
        await page.click('#deepseek-chat-btn');
        await page.evaluate(() => Object.assign(document.getElementById('ds-chat-panel').style, { left: '40px', top: '80px', width: '560px', height: '850px' }));
        const buttons = page.locator('.ds-message-copy');
        const start = async text => {
            await page.evaluate(() => { window.__chatCopyTest.controller = null; });
            await page.fill('#ds-chat-input', text);
            await page.click('#ds-chat-send-btn');
            await page.waitForFunction(() => !!window.__chatCopyTest.controller);
        };
        const emit = payload => page.evaluate(payload => {
            window.__chatCopyTest.controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(payload) + '\n\n'));
        }, payload);
        const finish = async () => {
            await page.evaluate(() => window.__chatCopyTest.controller.close());
            await page.waitForFunction(() => !document.querySelector('#ds-chat-panel.is-streaming'));
        };
        const copiedText = () => page.evaluate(() => navigator.clipboard.readText());
        const checkCopy = async (button, expected) => {
            await button.click();
            await page.waitForFunction(() => !!document.querySelector('.ds-message-copy .ph-check, .ds-code-copy .ph-check, .ds-tikz-copy .ph-check'));
            assert.equal((await copiedText()).replace(/\r\n/g, '\n'), expected);
            await button.evaluate(el => new Promise(resolve => {
                const poll = () => el.disabled ? setTimeout(poll, 30) : resolve();
                poll();
            }));
        };

        assert.equal(await buttons.count(), 0);
        await start('请解释公式并画图');
        await emit({ reasoning: '这段思考过程不属于复制内容。' });
        await page.waitForFunction(() => document.querySelector('.ds-reasoning-body').textContent.length > 0);
        assert.equal(await buttons.count(), 0);
        await emit({ delta: answer });
        await page.waitForFunction(() => !!document.querySelector('.ds-message-copy') && !!document.querySelector('.ds-tikz-img'));
        assert.ok(await page.locator('.katex').count() >= 5, '公式仍由 KaTeX 渲染');
        await checkCopy(buttons.first(), answer);
        assert.equal(renderCount, 1, '复制不触发额外 TikZ 编译');
        pass('生成中可复制完整 Markdown / LaTeX / TikZ 原文，且不夹带思考过程和渲染界面');

        const tail = '\n\n最后补充 $z_3$。';
        await emit({ delta: tail });
        await finish();
        await checkCopy(buttons.first(), answer + tail);
        await checkCopy(page.locator('.ds-code-copy').first(), code);
        await checkCopy(page.locator('.ds-tikz-copy').first(), tikz);
        assert.equal(await buttons.count(), 1);
        assert.equal(await page.locator('.ds-msg-user .ds-message-copy').count(), 0);
        pass('完成后复制最新全文，代码块和 TikZ 的原有复制入口保持可用');
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'chat-copy-markdown.png') });

        const select = async selector => page.locator(selector).first().evaluate(el => {
            document.activeElement.blur();
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        const clearSelection = () => page.evaluate(() => window.getSelection().removeAllRanges());
        const nativeCopy = async () => {
            await page.keyboard.press('Control+c');
            return (await copiedText()).replace(/\r\n/g, '\n');
        };

        await page.locator('.ds-content p').first().scrollIntoViewIfNeeded();
        const points = await page.locator('.ds-content p').first().evaluate(el => {
            const point = (node, offset) => {
                const range = document.createRange();
                range.setStart(node, offset); range.collapse(true);
                const rect = range.getBoundingClientRect();
                return { x: rect.x, y: rect.y + rect.height / 2 };
            };
            return [point(el.childNodes[0], 0), point(el.childNodes[2], 3)];
        });
        await page.mouse.move(points[1].x, points[1].y);
        await page.mouse.down();
        await page.mouse.move(points[0].x, points[0].y, { steps: 12 });
        await page.mouse.up();
        assert.equal(await nativeCopy(), '行内 $x_1^2 + y_2^2 = 1$，以及');
        await checkCopy(buttons.first(), '行内 $x_1^2 + y_2^2 = 1$，以及');
        pass('真实鼠标反向框选后 Ctrl+C 与复制按钮都只复制选中的文字和 LaTeX');

        await select('.ds-content [data-ds-math] .katex-html .mord');
        assert.equal(await nativeCopy(), '$x_1^2 + y_2^2 = 1$');
        for (const raw of [String.raw`\(\alpha_i + \beta\)`, String.raw`$$\int_0^1 x^2\,dx = \frac{1}{3}$$`, String.raw`\[\begin{pmatrix}a & b \\ c & d\end{pmatrix}\]`]) {
            await page.locator('[data-ds-math]').evaluateAll((nodes, raw) => {
                const node = nodes.find(node => node.dataset.dsMath === raw);
                const range = document.createRange(); range.selectNodeContents(node);
                const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
            }, raw);
            assert.equal(await nativeCopy(), raw);
        }
        pass('选到公式内部时复制完整公式，四种 LaTeX 定界符均保留且不重复');

        await select('.ds-content .ds-h');
        assert.equal(await nativeCopy(), '## 公式与图形');
        await select('.ds-content ul');
        assert.equal(await nativeCopy(), '- **保留强调**、*斜体* 和 `x_1`\n- [参考链接](https://example.com)');
        await select('.ds-content blockquote');
        assert.equal(await nativeCopy(), '> 引用中的公式 $E=mc^2$。');
        await select('.ds-content table');
        assert.equal(await nativeCopy(), '| 项目 | 公式 |\n| --- | --- |\n| 系数 | $a_i$ |');
        await select('.ds-code-block pre code');
        assert.equal(await nativeCopy(), '```js\n' + code + '\n```');
        await select('.ds-tikz-view');
        assert.equal(await nativeCopy(), '```tikz\n' + tikz + '\n```');
        assert.equal(await page.locator('.ds-tikz-source').evaluate(el => el.hidden), true);
        assert.equal(await page.locator('.ds-content').first().evaluate(el => el.textContent.includes('DSMATH')), false);
        pass('局部复制保留标题、列表、引用、表格和代码，选中图形可获得折叠的 TikZ 源码');

        assert.equal(await page.locator('.ds-content').first().evaluate(el => {
            const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
            el.dispatchEvent(event);
            return event.defaultPrevented;
        }), false);
        await clearSelection();
        await page.fill('#ds-chat-input', '草稿 $a_1$');
        await page.locator('#ds-chat-input').selectText();
        assert.equal(await nativeCopy(), '草稿 $a_1$');
        await select('.ds-user-text');
        assert.equal(await nativeCopy(), '请解释公式并画图');
        await clearSelection();
        pass('对话支持原生右键复制，输入框与用户消息继续使用普通复制');

        await page.reload();
        await page.click('#deepseek-chat-btn');
        await checkCopy(buttons.first(), answer + tail);
        await select('.ds-content [data-ds-math]');
        assert.equal(await nativeCopy(), '$x_1^2 + y_2^2 = 1$');
        await clearSelection();
        pass('刷新恢复的历史回答仍可原样复制');

        await start('中途停止');
        const partial = String.raw`已生成 $a_1$。

\begin{tikzpicture}
  \draw (0,0) -- (1,1);`;
        await emit({ delta: partial });
        await page.waitForFunction(() => document.querySelectorAll('.ds-message-copy').length === 2);
        await page.click('#ds-chat-stop-btn');
        await page.waitForFunction(() => !document.querySelector('#ds-chat-panel.is-streaming'));
        await checkCopy(buttons.nth(1), partial);
        await checkCopy(buttons.first(), answer + tail);
        pass('停止后保留未闭合 TikZ 原文，排除停止提示，多条回答各自复制正确内容');

        await start('框选期间继续生成');
        await emit({ delta: '保留选区 $x_1$。' });
        await page.waitForFunction(() => document.querySelectorAll('.ds-message-copy').length === 3);
        await select('.ds-msg-assistant:last-child .ds-content p');
        const before = await page.evaluate(() => window.getSelection().toString());
        await emit({ delta: '\n\n后续输出 $y_2$。' });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await finish();
        assert.equal(await page.evaluate(() => window.getSelection().toString()), before);
        assert.equal(await nativeCopy(), '保留选区 $x_1$。');
        await clearSelection();
        await page.waitForFunction(() => document.querySelector('.ds-msg-assistant:last-child .ds-content').textContent.includes('后续输出'));
        await checkCopy(buttons.last(), '保留选区 $x_1$。\n\n后续输出 $y_2$。');
        pass('选区在流式追加和生成结束时保持稳定，取消框选后显示最新内容');

        await page.evaluate(() => {
            window.__clipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
            navigator.clipboard.writeText = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
            const input = document.getElementById('ds-chat-input');
            input.value = '还未发送的草稿';
            input.focus();
            input.setSelectionRange(1, 4);
            // DOM click 保留输入焦点，用于验证兼容复制不会丢失草稿选择位置。
            document.querySelector('.ds-message-copy').click();
        });
        await page.waitForFunction(() => !!document.querySelector('.ds-message-copy .ph-check'));
        assert.equal((await copiedText()).replace(/\r\n/g, '\n'), answer + tail);
        assert.deepEqual(await page.evaluate(() => {
            const input = document.getElementById('ds-chat-input');
            return [document.activeElement === input, input.value, input.selectionStart, input.selectionEnd];
        }), [true, '还未发送的草稿', 1, 4]);
        pass('Clipboard API 异步拒绝时兼容复制成功，保留草稿和输入选择位置');

        await page.waitForFunction(() => !document.querySelector('.ds-message-copy').disabled);
        await page.evaluate(() => {
            document.execCommand = () => false;
            document.querySelector('.ds-message-copy').click();
        });
        await page.waitForFunction(() => document.querySelector('.ds-chat-flash.show')?.textContent.includes('复制失败'));
        assert.equal(await buttons.first().textContent(), '复制 Markdown');
        assert.equal(await buttons.first().isEnabled(), true);
        await page.evaluate(() => { navigator.clipboard.writeText = window.__clipboardWrite; });
        await checkCopy(buttons.first(), answer + tail);
        pass('两种复制方式均失败时提示失败，可重试且不显示虚假成功');

        assert.deepEqual(errors, []);
        pass('无浏览器脚本异常');
        if (saveArtifacts) fs.writeFileSync(path.join(resultsDir, 'chat-copy.json'), JSON.stringify({ checks, errors }, null, 2));
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(err => { console.error(err); process.exitCode = 1; });
