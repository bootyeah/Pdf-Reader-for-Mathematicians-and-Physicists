// Standalone manager UI: temporary config copy and browser profile; no user settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { deps, resultsDir, fixture, startServer, instrument, loadFixture } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));
const root = path.resolve(__dirname, '..');

(async () => {
    const child = spawn(process.env.READER_TEST_PYTHON || 'python', ['tests/test_latex_manager.py', '--serve-fixture'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stopped = new Promise(resolve => child.once('exit', resolve));
    let browser, stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    try {
        const session = await new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(new Error('Fixture startup timed out: ' + stderr)), 15000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.stdout.on('data', data => {
                output += data;
                if (!output.includes('\n')) return;
                clearTimeout(timer);
                resolve(JSON.parse(output.split('\n')[0]));
            });
        });
        browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
        const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(session.url);
        await page.waitForFunction(() => document.querySelector('#save-status').textContent === '所有更改已保存');
        const api = async (url = '/api/config', body) => page.evaluate(async ({ origin, token, url, body }) => {
            const response = await fetch(origin + url, { method: body ? 'POST' : 'GET', headers: { 'X-Manager-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            return response.json();
        }, { ...session, url, body });
        const original = await api();
        const originalText = fs.readFileSync(original.config_path, 'utf8');
        const nav = label => page.locator('#navigation button').filter({ hasText: label });
        assert.equal(await page.locator('#navigation button').count(), 4);
        assert.equal(await nav('公式宏').count(), 0);
        assert.equal(await page.locator('textarea, #preview-section, script[src*="katex"]').count(), 0);
        await nav('TikZ 宏包').click();
        const packageCount = original.config.packages.length;
        assert.equal(await page.locator('.config-row').count(), packageCount);
        for (const [label, value] of [['TikZ 宏包', '\\usepackage{siunitx}'], ['TikZ 库', 'perspective'], ['PGFPlots 库', 'statistics'], ['绘图环境', 'axis']]) {
            await nav(label).click();
            await page.locator('#add').click();
            await page.locator('.config-row').last().locator('input').fill(value);
        }
        await nav('TikZ 宏包').click();
        assert.equal(await page.locator('.config-row').count(), packageCount + 1, 'navigation retains all drafts');
        await page.keyboard.press('Control+s');
        await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('已保存'));
        const saved = await api();
        assert.equal(Object.hasOwn(saved.config, 'macros'), false);
        assert.equal(saved.config.packages.at(-1), '\\usepackage{siunitx}');
        assert.equal(saved.config.tikzLibraries.at(-1), 'perspective');
        assert.equal(saved.config.pgfplotsLibraries.at(-1), 'statistics');
        assert.equal(saved.config.environments.at(-1), 'axis');
        assert.equal(saved.has_backup, true);
        const suffix = text => text.slice(text.indexOf('const LATEX_SNIPPETS'));
        assert.equal(suffix(fs.readFileSync(saved.config_path, 'utf8')), suffix(originalText), 'snippets and markers stay intact');
        console.log('PASS package-only editor, navigation drafts, all setting groups and Ctrl+S');

        // Serve the saved settings to a reader to test every affected rendering path.
        const readerServer = await startServer({ 'a.pdf': await fixture('text', 1) });
        const reader = await browser.newPage();
        try {
            await reader.route('**/config.js', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(saved.config_path) }));
            await reader.route('**/api/chat', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ delta: '$\\mathbb{R}$ 和 $\\mathbf{x}$' }) + '\n\n' }));
            await reader.goto(`http://127.0.0.1:${readerServer.address().port}/LOCALPdfReader.html`);
            await instrument(reader);
            await loadFixture(reader, 'a.pdf');
            const result = await reader.evaluate(() => {
                const source = '$\\mathbb{R}$ 和 $\\mathbf{x}$';
                state.annotations[1].push({ id: 'manager-test', type: 'text', text: source, x: .1, y: .2, color: '#000' });
                renderAnnotations(1, true);
                renderNotePreview(source);
                window.MindMap.toggle(true);
                state.annotations.mindmap.nodes[0].text = source;
                window.MindMap.render();
                return { text: document.querySelectorAll('.text-annotation .katex').length, note: els.notePreview.querySelectorAll('.katex').length,
                    map: document.querySelectorAll('.mm-card .katex').length,
                    tex: window.TikzRender.buildStandaloneTex('\\begin{tikzpicture}\\draw(0,0)--(1,1);\\end{tikzpicture}') };
            });
            assert.equal(result.text, 2);
            assert.equal(result.note, 2);
            assert.equal(result.map, 2);
            assert(result.tex.includes('\\usepackage{siunitx}'));
            assert(result.tex.includes('perspective'));
            assert(result.tex.includes('statistics'));
            await reader.click('#deepseek-chat-btn');
            await reader.locator('#ds-chat-input').fill('test');
            await reader.click('#ds-chat-send-btn');
            await reader.waitForFunction(() => document.querySelectorAll('.ds-content .katex').length === 2);
            assert.equal(await reader.locator('.ds-content .katex-error').count(), 0);
        } finally {
            await reader.close();
            await new Promise(resolve => readerServer.close(resolve));
        }
        console.log('PASS saved settings reach text annotations, note view, mind maps, chat and TikZ preambles');

        await page.reload();
        await page.waitForFunction(count => document.querySelectorAll('.config-row').length === count, packageCount + 1);
        await page.locator('#add').click();
        await page.locator('.config-row').last().locator('input').fill(original.config.packages[0]);
        await page.locator('#save').click();
        await page.waitForFunction(() => document.querySelector('#notice.error')?.textContent.includes('重复'));
        assert.equal((await api()).revision, saved.revision, 'duplicate package preserves saved configuration');
        await page.locator('.config-row').last().locator('.remove').click();
        await nav('TikZ 宏包').click();
        await page.locator('.config-row').last().locator('.remove').click();
        await page.locator('#save').click();
        await page.waitForFunction(() => document.querySelector('#save-status').textContent === '所有更改已保存');
        assert.equal((await api()).config.packages.length, packageCount);
        const current = await api();
        current.config.tikzLibraries.push('external');
        await api('/api/save', { config: current.config, revision: current.revision });
        await page.locator('.config-row').first().locator('input').fill('\\usepackage{tikz} % draft');
        await page.locator('#save').click();
        await page.waitForFunction(() => document.querySelector('#notice.error')?.textContent.includes('其他操作修改'));
        await page.locator('#reload').click();
        await page.waitForFunction(() => document.querySelector('#notice').textContent === '已重新加载配置。');
        await page.locator('#restore').click();
        await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('已恢复上一版'));
        assert.deepEqual((await api()).config.tikzLibraries, saved.config.tikzLibraries);
        console.log('PASS refresh persistence, add/delete, duplicate validation, stale write rejection and restore');

        for (const width of [1400, 700, 390, 320]) {
            await page.setViewportSize({ width, height: 950 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `manager layout at ${width}px`);
            if (process.env.READER_TEST_ARTIFACTS) await page.screenshot({ path: path.join(resultsDir, `latex-manager-${width}.png`), fullPage: true });
        }
        await page.route('**/api/quit', route => route.abort());
        await page.locator('#quit').click();
        await page.waitForFunction(() => document.querySelector('#notice').classList.contains('error'));
        assert.equal(await page.locator('#quit').isDisabled(), false, 'quit can be retried after connection failure');
        await page.unroute('**/api/quit');
        await page.locator('#quit').click();
        await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已退出');
        assert.equal(await page.locator('button:enabled').count(), 0);
        assert.deepEqual(errors, []);
        console.log('PASS 1400/700/390/320px layouts and quit failure/retry; no browser errors');
    } finally {
        await browser?.close();
        child.stdin.end();
        await stopped;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
