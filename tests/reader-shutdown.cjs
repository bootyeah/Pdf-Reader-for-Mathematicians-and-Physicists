// Shutdown regression using disposable servers/browser profiles; never targets user tabs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { deps, root } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));
const executablePath = process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function server(native) {
    const source = `
import functools, json, sys, threading
from http.server import ThreadingHTTPServer
from app.server import PDFReaderHandler
class Handler(PDFReaderHandler):
    def log_message(self, *_): pass
    def _shutdown_server(self, token=''):
        self.server.tokens.append(token)
        if ${native ? 'True' : 'False'}: super()._shutdown_server(token)
    def do_GET(self):
        if self.path == '/test/tokens':
            self._json_response(200, {'tokens': self.server.tokens}); return
        if self.path == '/keep':
            body = b'<title>Unrelated test tab</title><p>Keep this tab open.</p>'
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body); return
        if self.path.startswith('/api/cloud-anno'):
            self._json_response(200, {'ok': True, 'configured': False, 'enabled': False}); return
        if self.path.startswith('/api/ai-config'):
            self._json_response(200, {'model': 'test', 'models': [], 'revision': 'test'}); return
        super().do_GET()
with ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=${JSON.stringify(root.replaceAll('\\', '/'))})) as s:
    s.tokens = []
    thread = threading.Thread(target=s.serve_forever, daemon=True); thread.start()
    print(json.dumps({'origin': 'http://127.0.0.1:' + str(s.server_port)}), flush=True)
    try: sys.stdin.read()
    finally: s.shutdown(); thread.join()
`;
    const child = spawn(process.env.READER_TEST_PYTHON || 'python', ['-u', '-c', source], { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', b => process.stderr.write(b));
    const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
    const origin = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 15000);
        readline.createInterface({ input: child.stdout }).on('line', line => {
            try { const data = JSON.parse(line); if (data.origin) { clearTimeout(timer); resolve(data.origin); } } catch (_) {}
        });
        child.once('error', reject);
        child.once('exit', code => { clearTimeout(timer); reject(new Error('fixture exited ' + code)); });
    });
    return { origin, child, exit, async stop() {
        if (child.exitCode !== null) return;
        child.stdin.end();
        await Promise.race([exit, new Promise(resolve => setTimeout(() => { child.kill(); resolve(); }, 3000))]);
    } };
}

async function clickExit(page) {
    await page.hover('#save-dropdown-wrapper');
    await page.locator('#close-app-btn').click();
}

async function frontend() {
    const fixture = await server(false);
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const context = await browser.newContext();
        const rootPage = await context.newPage();
        const remote = await context.newPage();
        for (const page of [rootPage, remote]) {
            await page.goto(fixture.origin + '/index.html');
            await page.evaluate(() => {
                window.probe = { closes: 0, saves: 0 };
                window.close = () => { probe.closes++; };
                saveAnnotationsToStorage = async () => { await new Promise(resolve => setTimeout(resolve, 80)); probe.saves++; };
            });
        }
        await remote.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://other.invalid', data: { action: 'APP_SHUTDOWN', token: 'a'.repeat(32) } })));
        assert.equal(await remote.evaluate(() => probe.closes), 0);
        await rootPage.evaluate(() => { state.isSaving = true; });
        rootPage.once('dialog', dialog => dialog.accept());
        await clickExit(rootPage);
        assert.equal(await rootPage.evaluate(() => probe.closes), 0);
        await rootPage.evaluate(() => { state.isSaving = false; state.unsavedChanges = true; });
        rootPage.once('dialog', dialog => dialog.dismiss());
        await clickExit(rootPage);
        assert.equal(await rootPage.evaluate(() => probe.closes), 0);
        await rootPage.evaluate(() => { state.unsavedChanges = false; });
        await clickExit(rootPage);
        await rootPage.waitForFunction(() => probe.closes === 1);
        await remote.waitForFunction(() => probe.closes === 1);
        const tokens = await (await context.request.get(fixture.origin + '/test/tokens')).json();
        assert.equal(tokens.tokens.length, 1, 'Other pages must not race to terminate the engine');
        assert.match(tokens.tokens[0], /^[a-f0-9]{32}$/);
        assert.equal(await rootPage.title(), 'PDF Reader Pro - Closing ' + tokens.tokens[0]);
        assert.equal(await remote.title(), await rootPage.title());
        assert.equal(await rootPage.evaluate(() => probe.saves), 1);
        assert.equal(await remote.evaluate(() => probe.saves), 1);
        await rootPage.waitForTimeout(600);
        assert.equal(await rootPage.locator('#viewer-container').count(), 1, 'Keep the marker and UI while native tab closing is active');
        await rootPage.waitForFunction(() => document.title === 'PDF 阅读器 - 已退出');
        assert.match(await rootPage.textContent('body'), /Ctrl\+W/);
        await context.close();

        const popupContext = await browser.newContext();
        const parent = await popupContext.newPage();
        await parent.goto(fixture.origin + '/keep');
        const popupEvent = parent.waitForEvent('popup');
        await parent.evaluate(url => window.open(url), fixture.origin + '/index.html');
        const popup = await popupEvent;
        await popup.waitForLoadState();
        const closed = popup.waitForEvent('close');
        await clickExit(popup);
        await closed;
        assert.equal(parent.isClosed(), false);
        await popupContext.close();
        console.log('PASS marked titles survive native closing; one request, drafts awaited, duplicate broadcasts ignored, cancelled/saving exits preserved, script-opened tab actually closes');
    } finally { await browser.close(); await fixture.stop(); }
}

async function native() {
    if (process.platform !== 'win32') return;
    const fixture = await server(true);
    const browser = await chromium.launch({ executablePath, headless: false });
    try {
        const context = await browser.newContext();
        const keep = await context.newPage();
        await keep.goto(fixture.origin + '/keep');
        const reader = await context.newPage();
        await reader.goto(fixture.origin + '/index.html?history=1');
        await reader.goto(fixture.origin + '/index.html?history=2');
        await reader.bringToFront();
        const closed = reader.waitForEvent('close', { timeout: 8000 });
        await clickExit(reader);
        await closed;
        assert.equal(await fixture.exit, 0, 'The real reader engine should exit cleanly');
        assert.equal(keep.isClosed(), false, 'Native close must not close the browser window or an unrelated tab');
        assert.equal(await keep.title(), 'Unrelated test tab');
        await context.close();
        console.log('PASS actual Windows/Edge tab with two history entries closes, real backend exits, unrelated tab remains open');
    } finally { await browser.close(); await fixture.stop(); }
}

(async () => { await frontend(); await native(); })().catch(error => { console.error(error); process.exitCode = 1; });
