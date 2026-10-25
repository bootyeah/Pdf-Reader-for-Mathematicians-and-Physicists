// Real browser + real manager/reader + a local fake upstream. No real credentials or model quota.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const deps = process.env.READER_TEST_NODE_MODULES || 'node_modules';
const {chromium} = require(path.join(deps, 'playwright'));
const python = process.env.READER_TEST_PYTHON || 'python';
const root = path.resolve(__dirname, '..');

(async () => {
    const child = spawn(python, ['-u', 'tests/test_api_manager.py', '--serve-fixture'], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: {...process.env, PYTHONIOENCODING: 'utf-8'}
    });
    const lines = createInterface({input: child.stdout});
    const ended = new Promise(resolve => child.once('close', resolve));
    let browser, timer;
    const log = [];
    child.stderr.on('data', x => log.push(String(x)));
    try {
        const info = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Fixture timeout: ' + log.join(''))), 15000);
            lines.on('line', line => { if (line.startsWith('{')) resolve(JSON.parse(line)); });
            child.once('error', reject);
            child.once('exit', code => reject(new Error('Fixture exited: ' + code + log.join(''))));
        });
        clearTimeout(timer);
        browser = await chromium.launch({executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true});
        const context = await browser.newContext({viewport: {width: 1440, height: 1050}});
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(info.manager);
        await page.waitForFunction(() => document.getElementById('model').value === 'model-chat');
        assert.equal(await page.locator('nav button').count(), 6);
        assert.equal(await page.inputValue('#api_key'), 'test-key-chat');
        assert.equal(await page.locator('#api_key').getAttribute('type'), 'text');
        assert.equal(await page.locator('#key-status').textContent(), 'Key 已配置');
        console.log('PASS six features and existing keys displayed in plaintext');
        // Chained sharing must follow draft edits, even when intermediate features own other keys.
        await page.click('nav button[data-feature="translation"]');
        await page.selectOption('#key_source', 'chat');
        await page.click('nav button[data-feature="formula_alt"]');
        await page.click('#clear-key');
        await page.selectOption('#key_source', 'translation');
        assert.equal(await page.inputValue('#api_key'), 'test-key-chat');
        await page.click('nav button[data-feature="chat"]');
        await page.fill('#api_key', 'draft-shared-key');
        await page.click('nav button[data-feature="formula_alt"]');
        assert.equal(await page.inputValue('#api_key'), 'draft-shared-key');
        assert.equal(await page.locator('#api_key').evaluate(el => el.readOnly), true);
        await page.evaluate(() => {
            window.copied = [];
            Object.defineProperty(navigator.clipboard, 'writeText', {configurable: true,
                value: async value => window.copied.push(value)});
        });
        await page.click('#copy-key');
        assert.equal(await page.evaluate(() => window.copied.at(-1)), 'draft-shared-key');
        await page.click('#show-key');
        assert.equal(await page.locator('#api_key').getAttribute('type'), 'password');
        assert.equal((await page.locator('#shared-key-hint').textContent()).includes('draft-shared-key'), false);
        await page.click('#switch-to-own-btn');
        assert.equal(await page.inputValue('#api_key'), 'draft-shared-key');
        assert.equal(await page.inputValue('#key_source'), '');
        assert.equal(await page.locator('#api_key').getAttribute('type'), 'password');
        await page.click('#show-key');
        await page.selectOption('#key_source', 'translation');
        await page.click('nav button[data-feature="chat"]');
        await page.click('#clear-key');
        for (const fid of ['chat', 'translation', 'formula_alt']) {
            assert.equal(await page.locator(`nav button[data-feature="${fid}"] .nav-item-badge`).getAttribute('class'), 'nav-item-badge missing');
        }
        await page.click('nav button[data-feature="formula_alt"]');
        assert.equal(await page.inputValue('#api_key'), '');
        assert.equal(await page.locator('#key-status').textContent(), 'Key 未配置');
        page.once('dialog', dialog => dialog.accept());
        await page.click('#reload');
        await page.waitForFunction(() => document.getElementById('api_key').value === 'test-key-formula_alt');
        await page.click('#copy-path-btn');
        assert.equal(await page.evaluate(() => window.copied.length), 2);
        await page.click('nav button[data-feature="chat"]');
        console.log('PASS chained draft keys, copy, clear, independent key and navigation status');
        await page.click('#test');
        await page.waitForSelector('#test-result.success');
        await page.click('#fetch-models');
        await page.waitForFunction(() => document.querySelectorAll('#remote-models option').length === 2);
        console.log('PASS actual test request and model discovery');
        await page.fill('#model', 'custom-ui-model');
        await page.fill('#api_key', 'browser-test-key');
        await page.selectOption('#thinking', 'enabled');
        await page.click('nav button[data-feature="translation"]');
        await page.fill('#temperature', '0.55');
        await page.click('nav button[data-feature="chat"]');
        assert.equal(await page.inputValue('#model'), 'custom-ui-model');
        assert.equal(await page.inputValue('#api_key'), 'browser-test-key');
        await page.click('#save');
        await page.waitForFunction(() => document.getElementById('save').disabled && document.getElementById('notice').textContent.includes('设置已保存'));
        assert.equal(await page.inputValue('#api_key'), 'browser-test-key');
        assert.equal(await page.locator('#test-result').isHidden(), true);
        await page.reload();
        await page.waitForFunction(() => document.getElementById('model').value === 'custom-ui-model');
        console.log('PASS multi-feature drafts, save, plaintext key rotation and reload');

        const reader = await context.newPage();
        reader.on('pageerror', error => errors.push(error.message));
        await reader.goto(info.reader + '/LOCALPdfReader.html');
        await reader.click('#deepseek-chat-btn');
        await reader.waitForFunction(() => document.getElementById('ds-chat-model-label').textContent === 'custom-ui-model');
        assert.equal(await reader.locator('#ds-chat-thinking-btn').getAttribute('class').then(x => x.includes('active')), true);
        await page.fill('#model', 'hot-reloaded-model');
        await page.selectOption('#thinking', 'omit');
        await page.click('#save');
        await page.waitForFunction(() => document.getElementById('save').disabled && document.getElementById('notice').textContent.includes('设置已保存'));
        await reader.fill('#ds-chat-input', 'check hot reload');
        const sent = reader.waitForRequest(req => req.url().endsWith('/api/chat'));
        await reader.click('#ds-chat-send-btn');
        assert.equal((await sent).postDataJSON().model, 'hot-reloaded-model');
        await reader.waitForFunction(() => !document.getElementById('ds-chat-panel').classList.contains('is-streaming'));
        assert.equal(await reader.locator('#ds-chat-thinking-btn').isDisabled(), true);
        console.log('PASS open reader uses changed model and thinking settings on its next request');

        page.once('dialog', dialog => dialog.accept());
        await page.click('#restore');
        await page.waitForFunction(() => document.getElementById('model').value === 'custom-ui-model');
        await page.click('nav button[data-feature="translation"]');
        assert.equal(await page.inputValue('#temperature'), '0.55');
        await page.click('nav button[data-feature="chat"]');
        console.log('PASS restore preserves all feature settings');
        await page.click('#test');
        await page.waitForSelector('#test-result.success');
        fs.mkdirSync(path.join(__dirname, 'results'), {recursive: true});
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({path: path.join(__dirname, 'results', 'api-manager-desktop.png'), animations: 'disabled'});
        await page.setViewportSize({width: 390, height: 844});
        for (const fid of ['dictionary', 'translation', 'formula_image', 'formula_handwriting', 'formula_alt', 'chat']) {
            await page.click('nav button[data-feature="' + fid + '"]');
            assert.equal(await page.locator('nav button[data-feature="' + fid + '"]').getAttribute('aria-current'), 'page');
        }
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('nav button')].every(button => {
            const rect = button.getBoundingClientRect(), nav = button.closest('nav').getBoundingClientRect();
            return rect.height >= 32 && rect.top >= nav.top && rect.bottom <= nav.bottom;
        })), true);
        await page.screenshot({path: path.join(__dirname, 'results', 'api-manager-mobile.png'), fullPage: true, animations: 'disabled'});
        const layout = await page.evaluate(() => ({
            width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            overflow: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1)
                .slice(0, 12).map(el => ({ tag: el.tagName, id: el.id, className: el.className, right: el.getBoundingClientRect().right }))
        }));
        assert(layout.scrollWidth <= layout.width, JSON.stringify(layout));
        for (const width of [320, 600, 900, 1100, 1440]) {
            await page.setViewportSize({width, height: 1050});
            await page.fill('#base_url', 'https://example.test/' + 'endpoint'.repeat(40));
            await page.selectOption('#key_source', 'formula_alt');
            const clipped = await page.evaluate(() => [...document.querySelectorAll('#editor input, #editor button, #editor select, #endpoint, #shared-key-text')]
                .filter(el => el.getClientRects().length).filter(el => {
                    const r = el.getBoundingClientRect(), card = el.closest('.card').getBoundingClientRect();
                    return r.right > card.right || r.left < card.left;
                }).map(el => el.id));
            assert.deepEqual(clipped, [], `clipped controls at ${width}px`);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        // Recovery notices remain visible after reload; Ctrl+S cannot save a recovery draft.
        await page.route('**/api/config', async route => {
            const response = await route.fetch();
            const data = await response.json();
            data.document.revision = 'invalid:test';
            data.recovery = '当前配置文件损坏，请恢复备份。';
            await route.fulfill({response, json: data});
        });
        page.once('dialog', dialog => dialog.accept());
        await page.click('#reload');
        await page.waitForFunction(() => document.getElementById('notice').textContent.includes('当前配置文件损坏'));
        await page.fill('#model', 'recovery-draft');
        let saveRequests = 0;
        page.on('request', req => {if (req.url().endsWith('/api/save')) saveRequests++;});
        await page.keyboard.press('Control+s');
        assert.equal(await page.locator('#save').isDisabled(), true);
        await page.unroute('**/api/config');
        page.once('dialog', dialog => dialog.accept());
        await page.click('#reload');
        await page.waitForFunction(() => document.getElementById('model').value === 'custom-ui-model');
        assert.equal(saveRequests, 0);

        // Failed quit preserves the draft and permits retry. Successful quit stops unload prompts.
        await page.fill('#model', 'unsaved-on-exit');
        await page.evaluate(() => {window.close = () => {};});
        await page.route('**/api/quit', route => route.fulfill({status: 500, json: {error: 'simulated failure'}}));
        page.once('dialog', dialog => dialog.accept());
        await page.click('#quit');
        await page.waitForFunction(() => document.getElementById('notice').textContent.includes('退出失败'));
        assert.equal(await page.locator('#quit').isDisabled(), false);
        assert.equal(await page.locator('#save').isDisabled(), false);
        assert.equal(await page.evaluate(() => {
            const event = new Event('beforeunload', {cancelable: true});
            window.dispatchEvent(event);
            return event.defaultPrevented;
        }), true);
        await page.unroute('**/api/quit');
        page.once('dialog', dialog => dialog.accept());
        await page.click('#quit');
        await page.waitForFunction(() => document.getElementById('save-status').textContent === '服务已关闭');
        assert.equal(await page.evaluate(() => {
            const event = new Event('beforeunload', {cancelable: true});
            window.dispatchEvent(event);
            return event.defaultPrevented;
        }), false);
        await page.keyboard.press('Control+s');
        assert.equal(saveRequests, 0);
        assert.deepEqual(errors, []);
        console.log('PASS responsive layout, recovery, quit failure/retry, unload handling and no JavaScript errors');
    } finally {
        clearTimeout(timer);
        if (browser) await browser.close();
        child.stdin.end();
        const killer = setTimeout(() => child.kill(), 6000);
        await ended; clearTimeout(killer); lines.close();
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
