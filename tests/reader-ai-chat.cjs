// Chat protocol regressions with local static files and scripted SSE; no model calls.
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, startServer, instrument, loadFixture, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({ 'sample.pdf': await fixture('text', 200) });
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

        // 底部输入栏：输入框高度与左右按钮严格协调，不受对话正文 A+/A- 字号缩放影响
        const readInputRowHeights = () => page.evaluate(() => ({
            pdf: document.getElementById('ds-chat-pdf-btn').getBoundingClientRect().height,
            input: document.getElementById('ds-chat-input').getBoundingClientRect().height,
            send: document.getElementById('ds-chat-send-btn').getBoundingClientRect().height
        }));
        assert.deepEqual(await readInputRowHeights(), { pdf: 34, input: 34, send: 34 });
        await page.click('#ds-chat-font-in-btn');
        await page.click('#ds-chat-font-in-btn');
        await page.click('#ds-chat-font-in-btn');
        assert.deepEqual(await readInputRowHeights(), { pdf: 34, input: 34, send: 34 });
        await page.fill('#ds-chat-input', '第一行\n第二行');
        assert.ok((await readInputRowHeights()).input > 34, 'Multiline text must auto-grow input');
        await page.fill('#ds-chat-input', '');
        assert.deepEqual(await readInputRowHeights(), { pdf: 34, input: 34, send: 34 });
        console.log('PASS input row height stays aligned at 34px across font-scale changes');

        // PDF 页面转高清图选择器回归测试
        await page.click('#ds-chat-pdf-btn');
        assert.equal(await page.locator('#ds-pdf-picker').isHidden(), true);
        assert.match(await page.locator('.ds-chat-flash').textContent(), /请先打开 PDF/);
        console.log('PASS PDF picker shows friendly hint before opening a PDF');

        await instrument(page);
        await loadFixture(page, 'sample.pdf');
        // 跳转到第 105 页并设置正文偏移 pageOffset=17（正文第 88 页），验证卡片只显示正文页数与图标按钮
        await page.evaluate(() => {
            state.pageOffset = 17;
            els.container.scrollTop = pdfPageTop(105) - 60;
            updateHUDAndOutline();
        });
        await page.waitForFunction(() => state.currentPhysicalPage === 105);

        await page.click('#ds-chat-pdf-btn');
        await page.waitForSelector('#ds-pdf-picker', { state: 'visible' });
        assert.equal(await page.locator('#ds-chat-image-btn').count(), 0);
        assert.equal(await page.locator('#ds-chat-file-input').count(), 0);
        assert.equal(await page.locator('#ds-pdf-range-input').count(), 0);
        assert.equal(await page.locator('#ds-pdf-range-btn').count(), 0);
        assert.equal(await page.locator('#ds-pdf-cur-btn').count(), 0);
        assert.equal(await page.locator('#ds-pdf-pair-btn').count(), 0);
        assert.equal(await page.locator('#ds-pdf-clear-btn').textContent(), '');
        assert.equal(await page.locator('#ds-pdf-locate-btn').textContent(), '');
        assert.equal(await page.locator('#ds-pdf-clear-btn i.ph-trash').count(), 1);
        assert.equal(await page.locator('#ds-pdf-locate-btn i.ph-crosshair').count(), 1);
        assert.equal(await page.locator('#ds-pdf-grid .ds-pdf-card').count(), 200);
        assert.equal(await page.locator('#ds-pdf-grid .ds-pdf-card[data-page="105"].is-current').count(), 1);
        assert.equal(await page.locator('#ds-pdf-grid .ds-pdf-card-logical').count(), 0);

        const cardLayout = await page.evaluate(() => {
            const card = document.querySelector('#ds-pdf-grid .ds-pdf-card[data-page="105"]');
            const thumb = card.querySelector('.ds-pdf-card-thumb');
            const foot = card.querySelector('.ds-pdf-card-foot');
            const frontNum = document.querySelector('#ds-pdf-grid .ds-pdf-card[data-page="17"] .ds-pdf-card-num').textContent;
            return {
                cardH: card.getBoundingClientRect().height,
                thumbH: thumb.getBoundingClientRect().height,
                footH: foot.getBoundingClientRect().height,
                numText: foot.querySelector('.ds-pdf-card-num').textContent,
                curBadge: foot.querySelector('.ds-pdf-card-cur')?.textContent || '',
                frontNum
            };
        });
        assert.ok(cardLayout.cardH >= 200, `Expected full card height >= 200, got ${cardLayout.cardH}`);
        assert.ok(cardLayout.thumbH >= 190, `Expected thumb height >= 190, got ${cardLayout.thumbH}`);
        assert.ok(cardLayout.footH >= 28, `Expected footer height >= 28, got ${cardLayout.footH}`);
        assert.equal(cardLayout.numText, '第 88 页');
        assert.equal(cardLayout.curBadge, '当前页');
        assert.equal(cardLayout.frontNum, '前 1 页');

        await page.waitForFunction(() => {
            const img = document.querySelector('#ds-pdf-grid .ds-pdf-card[data-page="105"] .ds-pdf-card-img');
            return !!img && !img.hidden && img.src.startsWith('data:image/jpeg');
        });

        await page.click('#ds-pdf-grid .ds-pdf-card[data-page="105"]');
        assert.deepEqual(await page.locator('#ds-pdf-grid .ds-pdf-card.is-selected').evaluateAll(els => els.map(e => e.dataset.page)), ['105']);
        if (process.env.READER_TEST_ARTIFACTS === '1') {
            await page.locator('#ds-chat-panel').screenshot({ path: path.join(__dirname, 'results', 'pdf-picker-preview.png') });
        }
        await page.click('#ds-pdf-grid .ds-pdf-card[data-page="106"]');
        assert.deepEqual(await page.locator('#ds-pdf-grid .ds-pdf-card.is-selected').evaluateAll(els => els.map(e => e.dataset.page)), ['105', '106']);
        assert.match(await page.locator('#ds-pdf-status').textContent(), /P\.88, P\.89/);
        assert.match(await page.locator('#ds-pdf-confirm-btn').textContent(), /添加高清图 \(2\)/);
        await page.click('#ds-pdf-clear-btn');
        assert.equal(await page.locator('#ds-pdf-grid .ds-pdf-card.is-selected').count(), 0);
        assert.equal(await page.locator('#ds-pdf-confirm-btn').isDisabled(), true);

        // 滚回顶部再点「定位当前页」图标按钮能回到第 105 页
        await page.evaluate(() => { document.getElementById('ds-pdf-grid').scrollTop = 0; });
        await page.click('#ds-pdf-locate-btn');
        await page.waitForFunction(() => {
            const g = document.getElementById('ds-pdf-grid');
            const c = g.querySelector('.ds-pdf-card[data-page="105"]');
            const gr = g.getBoundingClientRect();
            const cr = c.getBoundingClientRect();
            return cr.bottom > gr.top && cr.top < gr.bottom;
        });

        await page.click('#ds-pdf-grid .ds-pdf-card[data-page="104"]');
        await page.click('#ds-pdf-grid .ds-pdf-card[data-page="107"]', { modifiers: ['Shift'] });
        assert.deepEqual(await page.locator('#ds-pdf-grid .ds-pdf-card.is-selected').evaluateAll(els => els.map(e => [e.dataset.page, e.querySelector('.ds-pdf-card-order').textContent])), [['104', '1'], ['105', '2'], ['106', '3'], ['107', '4']]);

        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#ds-pdf-picker').isHidden(), true);
        assert.equal(await page.locator('#ds-chat-panel').isVisible(), true);
        console.log('PASS 200-page card layout, icon bar, logical-only page labels, Shift selection and Escape');

        await page.click('#ds-chat-pdf-btn');
        await page.waitForSelector('#ds-pdf-picker', { state: 'visible' });
        assert.equal(await page.locator('#ds-pdf-clear-btn').isDisabled(), true);
        await page.click('#ds-pdf-grid .ds-pdf-card[data-page="105"]');
        await page.click('#ds-pdf-grid .ds-pdf-card[data-page="106"]');
        await page.click('#ds-pdf-confirm-btn');
        await page.waitForSelector('#ds-pdf-picker', { state: 'hidden' });
        await page.waitForSelector('#ds-chat-thumbs.show');
        assert.deepEqual(await page.locator('#ds-chat-thumbs .ds-thumb-badge').evaluateAll(els => els.map(e => e.textContent)), ['P.88', 'P.89']);

        const thumbDims = await page.evaluate(async () => {
            const imgs = Array.from(document.querySelectorAll('#ds-chat-thumbs .ds-thumb img'));
            return Promise.all(imgs.map(el => new Promise(resolve => {
                const probe = new Image();
                probe.onload = () => resolve({ prefix: el.src.slice(0, 22), w: probe.naturalWidth, h: probe.naturalHeight });
                probe.src = el.src;
            })));
        });
        assert.equal(thumbDims.length, 2);
        for (const dim of thumbDims) {
            assert.equal(dim.prefix, 'data:image/png;base64,');
            assert.ok(dim.w >= 1400 && dim.h >= 2000, `Expected HD image, got ${dim.w}x${dim.h}`);
        }

        // 再次打开抽屉应回显已选页码，点取消保留附件
        await page.click('#ds-chat-pdf-btn');
        await page.waitForSelector('#ds-pdf-picker', { state: 'visible' });
        assert.deepEqual(await page.locator('#ds-pdf-grid .ds-pdf-card.is-selected').evaluateAll(els => els.map(e => e.dataset.page)), ['105', '106']);
        await page.click('#ds-pdf-cancel-btn');
        assert.equal(await page.locator('#ds-chat-thumbs .ds-thumb').count(), 2);

        await start('请总结这两页内容');
        const sentContent = (await lastRequest()).messages.at(-1).content;
        assert.equal(Array.isArray(sentContent), true);
        assert.deepEqual(sentContent.map(part => part.type), ['text', 'image_url', 'image_url']);
        assert.equal(sentContent[0].text, '请总结这两页内容');
        assert.ok(sentContent[1].image_url.url.startsWith('data:image/png;base64,'));
        assert.ok(sentContent[2].image_url.url.startsWith('data:image/png;base64,'));
        await emit({ model: 'GLM-5.3-Flash', delta: '已收到两页高清图' });
        await emit({ done: true });
        await close();
        assert.equal(await page.locator('#ds-chat-thumbs .ds-thumb').count(), 0);
        assert.deepEqual(errors, []);
        console.log('PASS HD PNG rendering, badge sync and multimodal chat payload');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
