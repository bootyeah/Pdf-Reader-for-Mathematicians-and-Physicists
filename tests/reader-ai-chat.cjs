// Chat protocol regressions with local static files and scripted SSE; no model calls.
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({});
    let browser;
    const errors = [];
    try {
        browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/ai-config', route => route.fulfill({ json: {
            model: 'Kimi-K3.1-Pro', models: ['GLM-5.3-Flash'], thinking: 'high', revision: 'ai-regression',
            model_thinking: { 'Kimi-K3.1-Pro': 'high', 'GLM-5.3-Flash': 'high' },
            model_capabilities: { 'Kimi-K3.1-Pro': { can_disable: false }, 'GLM-5.3-Flash': { can_disable: false } }
        } }));
        await page.addInitScript(() => {
            const originalFetch = window.fetch.bind(window);
            window.aiTest = { controller: null, requests: [] };
            window.fetch = (input, init) => {
                if (new URL(typeof input === 'string' ? input : input.url, location.href).pathname !== '/api/chat') return originalFetch(input, init);
                window.aiTest.requests.push(JSON.parse(init.body));
                return Promise.resolve(new Response(new ReadableStream({ start(controller) {
                    window.aiTest.controller = controller;
                    init.signal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')), { once: true });
                } }), { headers: { 'Content-Type': 'text/event-stream' } }));
            };
        });
        const url = `http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`;
        const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('pdf_reader_deepseek_chat_state')).history);
        const assistantHistory = async () => (await stored()).filter(m => m.role === 'assistant');
        const lastRequest = () => page.evaluate(() => window.aiTest.requests.at(-1));
        const open = async () => {
            await page.goto(url);
            await page.click('#deepseek-chat-btn');
            await page.waitForFunction(() => document.getElementById('ds-chat-model-label').textContent === 'Kimi-K3.1-Pro');
        };
        const start = async text => {
            await page.evaluate(() => { window.aiTest.controller = null; });
            await page.fill('#ds-chat-input', text);
            await page.click('#ds-chat-send-btn');
            await page.waitForFunction(() => !!window.aiTest.controller);
        };
        const emit = obj => page.evaluate(obj => window.aiTest.controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(obj) + '\n\n')), obj);
        const close = async () => {
            await page.evaluate(() => window.aiTest.controller.close());
            await page.waitForFunction(() => !document.querySelector('#ds-chat-panel.is-streaming'));
        };
        await open();
        assert.equal(await page.locator('#ds-chat-thinking-btn').isDisabled(), true);
        assert.match(await page.locator('#ds-chat-thinking-btn').getAttribute('title'), /不能关闭/);
        await start('first');
        assert.equal(Object.hasOwn(await lastRequest(), 'thinking'), false);
        await emit({ model: 'Kimi-K3.1-Pro', reasoning: ' reasoning\n', delta: ' answer\n' });
        await emit({ done: true });
        await close();
        const expected = { role: 'assistant', content: ' answer\n', reasoning_content: ' reasoning\n', _reader_model: 'Kimi-K3.1-Pro' };
        assert.deepEqual(await assistantHistory(), [expected]);
        await open();
        await open();
        assert.deepEqual(await assistantHistory(), [expected]);
        await start('follow up');
        assert.deepEqual((await lastRequest()).messages.find(m => m.role === 'assistant'), expected);
        await emit({ delta: 'incomplete answer' });
        await close();
        assert.deepEqual(await assistantHistory(), [expected]);
        assert.match(await page.locator('#ds-chat-body').textContent(), /提前结束/);
        console.log('PASS mandatory reasoning, complete Kimi history and repeated reloads');

        await start('truncated');
        await emit({ delta: 'truncated answer' });
        await emit({ error: '输出达到 token 上限，回答未完成' });
        await page.waitForFunction(() => !document.querySelector('#ds-chat-panel.is-streaming'));
        assert.deepEqual(await assistantHistory(), [expected]);
        await start('reasoning only');
        await emit({ reasoning: 'no final content' });
        await emit({ done: true });
        await close();
        assert.deepEqual(await assistantHistory(), [expected]);
        assert.match(await page.locator('#ds-chat-body').textContent(), /未返回正文/);
        await start('stop');
        await emit({ delta: 'stopped answer' });
        await page.click('#ds-chat-stop-btn');
        await page.waitForFunction(() => !document.querySelector('#ds-chat-panel.is-streaming'));
        assert.deepEqual(await assistantHistory(), [expected]);
        assert.match(await page.locator('#ds-chat-body').textContent(), /已停止生成/);
        console.log('PASS EOF, truncation, reasoning-only and stopped outputs are excluded from completed history');

        await page.click('#ds-chat-model-btn');
        await page.click('.ds-chat-model-opt[data-model="GLM-5.3-Flash"]');
        await start('different model');
        assert.equal((await lastRequest()).model, 'GLM-5.3-Flash');
        await emit({ model: 'GLM-5.3-Flash', delta: 'GLM answer' });
        await emit({ done: true });
        await close();
        assert.equal((await assistantHistory()).at(-1)._reader_model, 'GLM-5.3-Flash');
        assert.deepEqual(errors, []);
        console.log('PASS actual response model tags and no JavaScript errors');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
