// 真实 Edge 的编辑/框选/持久化回归；OCR 和手机状态使用可控响应，不消耗接口额度。
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, startServer, instrument, loadFixture, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));
const sharp = require(path.join(deps, 'sharp'));
const saveArtifacts = process.env.READER_TEST_ARTIFACTS === '1';
(async () => {
    const server = await startServer({ 'a.pdf': await fixture('text', 2) });
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], calls = []; let result = '$x^2$', delay = 0, fail = false, phoneLatex = '', whiteboardLatex = '', closes = 0, phoneOnline = false;
    page.on('pageerror', e => errors.push(String(e)));
    const png = await sharp(Buffer.from('<svg width="200" height="80"><rect width="200" height="80" fill="white"/><text x="20" y="50" font-size="32">x + y = 2</text></svg>')).png().toBuffer();
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    const connections = new Map(); let tunnelStatus = 'connecting';
    function pairingFor(sid) {
        const entry = connections.get(sid);
        const remote = entry.connection === 'internet';
        const status = remote ? tunnelStatus : 'ready';
        const signature = entry.connection + ':' + status;
        if (entry.signature !== signature) { entry.signature = signature; entry.rev++; }
        const ready = status === 'ready';
        return { connection: entry.connection, status, pairingRev: entry.rev,
            urls: ready ? [remote ? 'https://synthetic-board.trycloudflare.com/?t=test' : 'http://127.0.0.1:8765/?t=test'] : [],
            qr: ready ? dataUrl : '', message: status === 'error' ? '模拟互联网连接失败' : remote
                ? ready ? '手机可使用移动数据或任意 Wi-Fi 扫码' : '正在生成远程二维码…' : '手机与电脑连接同一 Wi-Fi 后扫码' };
    }
    await page.route('**/api/formula/**', async route => {
        const body = route.request().postDataJSON(); calls.push(body);
        let answer;
        if (route.request().url().endsWith('/recognize')) {
            const latex = result; const failed = fail;
            if (delay) await new Promise(r => setTimeout(r, delay));
            answer = failed ? { ok: false, error: '测试：识别服务暂时不可用' } : { ok: true, latex };
        } else if (body.action === 'start') {
            const sid = body.purpose === 'whiteboard' ? 'whiteboard-session' : 'test-session';
            connections.set(sid, { connection: body.connection || 'lan', rev: 0 });
            answer = { ok: true, session: sid, ...pairingFor(sid) };
        } else if (body.action === 'connection') {
            connections.get(body.session).connection = body.connection;
            if (body.retry) tunnelStatus = 'connecting';
            answer = { ok: true, pairing: pairingFor(body.session) };
        }
        else if (body.action === 'close') { closes++; answer = { ok: true }; }
        else {
            const latex = body.session === 'whiteboard-session' ? whiteboardLatex : phoneLatex;
            answer = { ok: true, pairing: pairingFor(body.session), online: phoneOnline, doc: { w: 1000, h: 2000, strokes: [{ k: 'pen', w: 4, p: [[700, 1700], [900, 1760]] }] }, result: latex ? { latex, cost: 1 } : null };
        }
        await route.fulfill({ json: answer }).catch(() => {});
    });
    const pass = name => console.log('PASS ' + name);
    const open = async (id = 'box') => {
        await page.evaluate(id => {
            const anno = state.annotations[1].find(a => a.id === id);
            openNoteModal({ ...anno, note: anno.text }, 1, 700, 160, true);
        }, id);
        await page.waitForTimeout(100);
    };
    const click = id => page.locator('#formula-' + id).click();
    const mode = name => page.locator(`#formula-input-bar [data-mode="${name}"]`).click();
    const image = async () => { await mode('image'); await page.locator('#formula-image-file').setInputFiles({ name: 'formula.png', mimeType: 'image/png', buffer: png }); };
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await instrument(page); await loadFixture(page, 'a.pdf');
        await page.evaluate(() => {
            addAnnotation(1, { id: 'box', type: 'text', color: '#000000', x: .12, y: .1, text: 'Before AFTER' });
            addAnnotation(1, { id: 'other', type: 'text', color: '#000000', x: .12, y: .3, text: 'Other note' });
            renderAnnotations(1, true); initHistory();
        });
        await open();
        assert.equal(await page.locator('header #formula-input-bar').count(), 0);
        await page.locator('#note-input').evaluate(el => { el.setSelectionRange(7, 12); el.dispatchEvent(new Event('select')); });
        await image(); await click('image-recognize'); await page.locator('#formula-result').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#formula-preview .katex').count(), 1);
        const compact = await page.locator('#note-modal').boundingBox();
        assert.ok(compact.width * compact.height < 460 * 720 * .65, '默认占用面积应明显小于旧面板');
        assert.equal(await page.locator('#formula-code').isVisible(), false);
        await click('code-toggle'); await page.locator('#formula-code').fill('$y+1$');
        assert.match(await page.locator('#formula-preview').textContent(), /y/);
        await page.locator('#formula-code').fill('$x^2$'); await click('code-toggle');
        assert.deepEqual(await page.locator('#note-modal').boundingBox(), compact);
        pass('公式面板默认紧凑尺寸，按需修改代码且不改变窗口位置尺寸');
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'formula-image.png') });
        await click('insert');
        assert.equal(await page.locator('#note-input').inputValue(), 'Before $x^2$');
        await page.waitForTimeout(150); await page.locator('#save-note-btn').click();
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(async () => (await localforage.getItem(`pdf_annos_${state.fingerprint}`))[1].find(a => a.id === 'box').text), 'Before $x^2$');
        await page.evaluate(() => undo());
        assert.equal(await page.evaluate(() => state.annotations[1].find(a => a.id === 'box').text), 'Before AFTER');
        await page.evaluate(() => redo());
        assert.equal(await page.evaluate(() => state.annotations[1].find(a => a.id === 'box').text), 'Before $x^2$');
        pass('图片识别预览、替换选区、保存到本地与撤销/重做');

        await open(); const collapsed = await page.locator('#note-modal').boundingBox();
        await mode('handwriting');
        const header = await page.locator('#note-header').boundingBox();
        await page.mouse.move(header.x + 50, header.y + 14); await page.mouse.down();
        await page.mouse.move(header.x - 100, header.y + 94, { steps: 10 }); await page.mouse.up();
        const moved = await page.locator('#note-modal').boundingBox();
        assert.ok(Math.abs(moved.x - collapsed.x) > 100);
        await click('collapse'); const folded = await page.locator('#note-modal').boundingBox();
        assert.equal(folded.x, moved.x); assert.equal(folded.y, moved.y);
        assert.equal(folded.width, collapsed.width); assert.equal(folded.height, collapsed.height);
        await mode('handwriting'); await mode('handwriting');
        assert.deepEqual(await page.locator('#note-modal').boundingBox(), folded);
        pass('拖动后收起只恢复尺寸，位置不回跳；重复展开收起不漂移');

        await open(); await page.locator('#note-input').fill('math $a+ $ end');
        await page.locator('#note-input').evaluate(el => { el.setSelectionRange(8, 8); el.dispatchEvent(new Event('select')); });
        await image(); await click('image-recognize'); await page.locator('#formula-result').waitFor({ state: 'visible' }); await click('insert');
        assert.equal(await page.locator('#note-input').inputValue(), 'math $a+x^2 $ end');
        await page.locator('#toggle-edit-btn').click();
        assert.equal(await page.evaluate(() => state.annotations[1].find(a => a.id === 'box').text), 'Before $x^2$');
        pass('已有数学环境中插入不嵌套定界符，取消回滚内容');

        await open(); await mode('handwriting');
        const r = await page.locator('#formula-pad').boundingBox();
        await page.mouse.move(r.x + 40, r.y + 40); await page.mouse.down(); await page.mouse.move(r.x + 160, r.y + 110, { steps: 15 }); await page.mouse.up();
        await click('hand-recognize'); await page.locator('#formula-result').waitFor({ state: 'visible' });
        assert.equal(calls.filter(c => c.kind === 'handwriting').at(-1).doc.strokes.length, 1);
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'formula-handwriting.png') });
        await click('undo'); await click('hand-recognize');
        assert.match(await page.locator('#formula-status').textContent(), /先在画板/);
        pass('真实鼠标手写、传递笔迹、撤销一笔与空画板提示');

        await mode('image'); await click('crop');
        let canvas = await page.locator('#canvas-1').boundingBox();
        const x = Math.max(300, canvas.x + 30), y = Math.max(150, canvas.y + 120);
        await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 170, y + 65, { steps: 10 }); await page.mouse.up();
        await page.waitForTimeout(450);
        assert.equal(await page.locator('#formula-crop-overlay').count(), 0);
        assert.equal(await page.locator('#note-modal').isVisible(), true);
        assert.ok((await page.locator('#formula-image').getAttribute('src')).startsWith('data:image/png'));
        await click('image-recognize'); await page.locator('#formula-result').waitFor({ state: 'visible' });
        pass('从 PDF 位图框选公式，编辑框与草稿保持打开');
        await click('crop'); await page.keyboard.press('Escape'); await page.waitForTimeout(450);
        assert.equal(await page.locator('#note-modal').isVisible(), true);
        pass('Esc 取消 PDF 框选并恢复编辑');

        fail = true; await click('image-recognize'); await page.waitForFunction(() => document.getElementById('formula-status').textContent.includes('暂时不可用'));
        assert.equal(await page.locator('#formula-result').isVisible(), false);
        assert.equal(await page.locator('#formula-image-recognize').isEnabled(), true); fail = false;
        pass('识别失败保留图片并允许重试');

        // 「手写 / 识图 / 手机」右边新增的识别模型按钮：按下走 DeepSeek V4.1 Flash，再按切回 GLM。
        assert.deepEqual(await page.locator('#formula-input-bar button').evaluateAll(list => list.map(b => b.dataset.mode || b.id)),
            ['handwriting', 'image', 'phone', 'formula-deepseek', 'formula-collapse']);
        const barBoxes = await page.evaluate(() => {
            const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right }; };
            const bar = document.getElementById('formula-input-bar');
            return { group: box(bar.querySelector('.formula-mode-group')), engine: box(document.getElementById('formula-deepseek')), collapse: box(document.getElementById('formula-collapse')) };
        });
        assert.ok(barBoxes.engine.l >= barBoxes.group.r, '模型按钮应在三个模式按钮右边');
        assert.ok(barBoxes.collapse.l > barBoxes.engine.r, '「收起」仍在最右边');
        const enginePressed = () => page.locator('#formula-deepseek').getAttribute('aria-pressed');
        assert.equal(await enginePressed(), 'false');
        await click('deepseek'); assert.equal(await enginePressed(), 'true');
        await click('image-recognize'); await page.locator('#formula-result').waitFor({ state: 'visible' });
        assert.equal(calls.at(-1).engine, 'deepseek');
        await click('deepseek'); assert.equal(await enginePressed(), 'false');
        await click('image-recognize'); await page.locator('#formula-result').waitFor({ state: 'visible' });
        assert.equal(calls.at(-1).engine, '');
        pass('公式栏「DeepSeek」按钮切换识别模型，默认仍是 GLM');

        delay = 500; result = '$late$'; await click('image-recognize'); await open('other'); await page.waitForTimeout(700);
        assert.equal(await page.locator('#note-input').inputValue(), 'Other note');
        assert.equal(await page.locator('#formula-result').isVisible(), false); delay = 0;
        pass('切换文本块后丢弃迟到的识别结果');

        await page.locator('#note-input').evaluate((el, url) => {
            const raw = atob(url.split(',')[1]); const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
            const dt = new DataTransfer(); dt.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
            el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }, dataUrl);
        await page.locator('#formula-image-recognize').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#formula-image').isVisible(), true);
        pass('编辑正文时粘贴图片自动进入识图');

        await click('collapse');
        const drop = await page.locator('#note-input').evaluate((el, url) => {
            const bytes = Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0));
            const dt = new DataTransfer(); dt.items.add(new File([bytes], 'drop.png', { type: 'image/png' }));
            dt.dropEffect = 'none';
            const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
            el.dispatchEvent(over);
            el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
            return over.defaultPrevented;
        }, dataUrl);
        assert.equal(drop, true);
        await page.locator('#formula-image').waitFor({ state: 'visible' });
        pass('拖入图片可穿过阅读器的全局防拖拽保护');

        await mode('phone'); await page.locator('#formula-qr').waitFor({ state: 'visible' });
        const waiting = await page.locator('#note-modal').boundingBox();
        const phoneMode = name => page.locator(`#formula-phone-modes [data-connection="${name}"]`);
        await phoneMode('internet').click();
        await page.waitForFunction(() => document.getElementById('formula-phone-connection-hint').textContent.includes('正在生成远程'));
        assert.equal(await page.locator('#formula-qr').isVisible(), false);
        assert.equal(await page.locator('#formula-phone-url').getAttribute('href'), null);
        tunnelStatus = 'error';
        await page.locator('#formula-phone-tunnel-retry').waitFor({ state: 'visible' });
        await page.locator('#formula-phone-tunnel-retry').click();
        await page.waitForFunction(() => document.getElementById('formula-phone-connection-hint').textContent.includes('正在生成远程'));
        tunnelStatus = 'ready';
        await page.locator('#formula-qr').waitFor({ state: 'visible' });
        assert.match(await page.locator('#formula-phone-url').getAttribute('href'), /^https:\/\//);
        assert.equal(await phoneMode('internet').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.evaluate(() => localStorage.getItem('pdf_reader_phone_connection_formula')), 'internet');
        assert.deepEqual(await page.locator('#note-modal').boundingBox(), waiting);
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'formula-phone-internet.png') });
        await phoneMode('lan').click();
        await page.waitForFunction(() => document.getElementById('formula-phone-url').href.startsWith('http://127.0.0.1:8765'));
        assert.equal(calls.filter(c => c.action === 'start').length, 1);
        pass('手机公式互联网连接：等待时隐藏旧二维码，错误可重试，HTTPS 就绪后扫码，切换 Wi-Fi 保留原会话');
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'formula-phone-pairing.png') });
        phoneOnline = true;
        await page.locator('#formula-phone-pairing').waitFor({ state: 'hidden' });
        assert.deepEqual(await page.locator('#note-modal').boundingBox(), waiting);
        assert.ok((await page.locator('#formula-phone-pad').boundingBox()).height >= 180);
        assert.equal(await page.locator('#formula-qr').isVisible(), false);
        const inkWidth = () => page.locator('#formula-phone-pad').evaluate(canvas => {
            const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
            let left = canvas.width, right = 0;
            for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
                const i = (y * canvas.width + x) * 4;
                if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) { left = Math.min(left, x); right = Math.max(right, x); }
            }
            return { ink: right - left, canvas: canvas.width };
        });
        const zoomedInk = await inkWidth(); assert.ok(zoomedInk.ink > zoomedInk.canvas * .5);
        await click('phone-view'); const wholeInk = await inkWidth();
        assert.ok(zoomedInk.ink > wholeInk.ink * 5);
        await click('phone-view');
        assert.equal((await inkWidth()).ink, zoomedInk.ink);
        await click('phone-pair'); await page.waitForTimeout(950);
        assert.equal(await page.locator('#formula-qr').isVisible(), true);
        await click('phone-pair');
        assert.deepEqual(await page.locator('#note-modal').boundingBox(), waiting);
        assert.equal(calls.filter(c => c.action === 'start').length, 1);
        pass('二维码连接后自动收起，可再次查看且不重建连接；笔迹自动取景放大，整板切换不改笔迹');
        // 连接之后再按模型按钮：之后每一轮手机轮询都会带上新的选择。
        await click('deepseek'); await page.waitForTimeout(900);
        assert.equal(calls.filter(c => c.action === 'state').at(-1).engine, 'deepseek');
        await click('deepseek'); await page.waitForTimeout(900);
        assert.equal(calls.filter(c => c.action === 'state').at(-1).engine, '');
        pass('手机配对期间切换模型按钮同样生效');
        phoneLatex = '$E=mc^2$'; await page.waitForFunction(() => document.getElementById('formula-code').value === '$E=mc^2$');
        const resultFullyVisible = () => page.evaluate(() => {
            const panel = document.getElementById('formula-input-panel').getBoundingClientRect();
            const button = document.getElementById('formula-insert').getBoundingClientRect();
            const preview = document.getElementById('formula-preview').getBoundingClientRect();
            return Math.max(button.bottom, preview.bottom) <= panel.bottom && Math.min(button.top, preview.top) >= panel.top;
        });
        assert.equal(await resultFullyVisible(), true, '识别结果与插入按钮应完整显示，不需要先滚动画板');
        await click('code-toggle');
        assert.equal(await resultFullyVisible(), true, '展开代码后插入按钮仍应完整显示');
        await click('code-toggle');
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'formula-phone.png') });
        await click('insert'); await page.waitForTimeout(150);
        assert.match(await page.locator('#note-input').inputValue(), /E=mc/); assert.equal(closes, 0);
        await page.mouse.click(1350, 900); await page.waitForTimeout(200);
        assert.match(await page.evaluate(() => state.annotations[1].find(a => a.id === 'other').text), /E=mc/);
        await open(); await mode('phone');
        await page.waitForFunction(() => document.getElementById('formula-code').value === '$E=mc^2$');
        await click('collapse'); phoneLatex = '$z=3$'; await page.waitForTimeout(800);
        await mode('phone'); await page.waitForFunction(() => document.getElementById('formula-code').value === '$z=3$');
        await mode('image'); await mode('phone');
        assert.equal(calls.filter(c => c.action === 'start').length, 1);
        assert.equal(closes, 0);
        await click('collapse');
        pass('手机结果插入及外部保存；重开编辑框、收起面板、切换模式复用连接并取回隐藏期间的结果');

        // 小视口也能滚动到插入按钮，编辑框不会被面板撑出屏幕。
        await page.setViewportSize({ width: 800, height: 600 });
        await open(); await image(); result = '$a+b$';
        await click('image-recognize'); await page.locator('#formula-result').waitFor({ state: 'visible' });
        const small = await page.locator('#note-modal').boundingBox();
        assert.ok(small.y >= 0 && small.y + small.height <= 600 && small.x + small.width <= 800);
        await click('insert');
        pass('小视口下编辑框完整可见且仍可插入公式');

        phoneOnline = false;
        await mode('phone');
        const previousCloses = closes;
        await loadFixture(page, 'a.pdf'); await page.waitForTimeout(200);
        assert.equal(await page.locator('#note-modal').isVisible(), false);
        assert.equal(closes, previousCloses);
        pass('切换 PDF 结束编辑但保留手机连接');

        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => { state.currentTool = 'cursor'; updateToolButtons(); });
        const textTool = page.locator('button[data-tool="text"]');
        await textTool.click(); assert.equal(await page.evaluate(() => state.currentTool), 'text');
        await textTool.click();
        const whiteboard = page.locator('#handwriting-whiteboard');
        await whiteboard.waitFor({ state: 'visible' });
        await page.locator('#whiteboard-qr').waitFor({ state: 'visible' });
        await page.locator('#whiteboard-phone-modes [data-connection="internet"]').click();
        await page.waitForFunction(() => document.getElementById('whiteboard-url').href.startsWith('https://synthetic-board'));
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'whiteboard-phone-internet.png') });
        assert.equal(await page.evaluate(() => localStorage.getItem('pdf_reader_phone_connection_whiteboard')), 'internet');
        pass('草稿白板共享互联网入口，远程二维码和偏好独立于手机公式输入');
        assert.equal(calls.filter(c => c.action === 'start' && c.purpose === 'whiteboard').length, 1);
        await page.mouse.click(1350, 900); assert.equal(await whiteboard.isVisible(), true);
        phoneOnline = true; await page.locator('#whiteboard-pairing').waitFor({ state: 'hidden' });
        const beforeDrag = await whiteboard.boundingBox();
        const wbHeader = await page.locator('#whiteboard-header').boundingBox();
        await page.mouse.move(wbHeader.x + 90, wbHeader.y + 20); await page.mouse.down();
        await page.mouse.move(wbHeader.x + 150, wbHeader.y + 65, { steps: 8 }); await page.mouse.up();
        const afterDrag = await whiteboard.boundingBox();
        assert.ok(afterDrag.x > beforeDrag.x + 50 && afterDrag.y > beforeDrag.y + 40);
        const corner = await page.locator('.whiteboard-resize[data-edge="se"]').boundingBox();
        await page.mouse.move(corner.x + 8, corner.y + 8); await page.mouse.down();
        await page.mouse.move(corner.x + 98, corner.y - 72, { steps: 8 }); await page.mouse.up();
        const resized = await whiteboard.boundingBox();
        assert.ok(resized.width > afterDrag.width + 70 && resized.height < afterDrag.height - 60);
        await page.locator('#whiteboard-collapse').click();
        assert.ok((await whiteboard.boundingBox()).height < 50);
        whiteboardLatex = '这是草稿。设 $x=1$。\n\n$$y=x+2$$';
        await page.waitForTimeout(900);
        await page.locator('#whiteboard-collapse').click();
        assert.ok(Math.abs((await whiteboard.boundingBox()).height - resized.height) < 2);
        await page.waitForFunction((expected) => document.getElementById('whiteboard-code').value === expected, whiteboardLatex);
        assert.equal(await page.locator('#whiteboard-code').inputValue(), whiteboardLatex);
        assert.equal(await page.locator('#whiteboard-preview .katex').count(), 2);
        const editedDraft = whiteboardLatex + '\n已校对。';
        if (await page.locator('#whiteboard-code').isHidden()) {
            await page.locator('#whiteboard-code-toggle').click();
        }
        await page.locator('#whiteboard-code').fill(editedDraft);
        const stageWithResult = await page.locator('#whiteboard-stage').boundingBox();
        await page.locator('#whiteboard-result-hide').click();
        await page.waitForTimeout(1600); // Multiple phone polls must not reopen a dismissed result.
        assert.equal(await page.locator('#whiteboard-result').isVisible(), false);
        assert.ok((await page.locator('#whiteboard-stage').boundingBox()).height > stageWithResult.height + 100);
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'handwriting-whiteboard-plain.png') });
        await page.locator('#whiteboard-collapse').click();
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'handwriting-whiteboard-collapsed.png') });
        await page.locator('#whiteboard-collapse').click();
        assert.equal(await page.locator('#whiteboard-result').isVisible(), false);
        await page.locator('#whiteboard-result-toggle').click();
        assert.equal(await page.locator('#whiteboard-code').inputValue(), editedDraft);
        await page.locator('#whiteboard-result-toggle').click();
        whiteboardLatex = '新的草稿：$a+b=c$';
        await page.waitForFunction(() => document.getElementById('whiteboard-code').value === '新的草稿：$a+b=c$');
        assert.equal(await page.locator('#whiteboard-result').isVisible(), true);
        pass('回到纯白板释放全部结果区空间，轮询/折叠不重开结果；可取回修改过的代码，新识别结果正常显示');
        const pureHeight = (await whiteboard.boundingBox()).height;
        const startsBeforePure = calls.filter(c => c.action === 'start' && c.purpose === 'whiteboard').length;
        await page.locator('#whiteboard-pure').click();
        assert.equal(await page.evaluate(() => HandwritingWhiteboard.isPureMode()), true);
        assert.equal(await page.locator('#whiteboard-actions').isVisible(), false);
        await page.keyboard.press('v');
        assert.ok((await whiteboard.boundingBox()).height < 50);
        assert.equal(await page.evaluate(() => HandwritingWhiteboard.isPureMode()), true);
        assert.equal(await page.locator('#whiteboard-collapse').isVisible(), true);
        assert.equal(await page.locator('#whiteboard-collapse').getAttribute('aria-expanded'), 'false');
        await page.locator('#whiteboard-collapse').click();
        assert.ok(Math.abs((await whiteboard.boundingBox()).height - pureHeight) < 2);
        assert.equal(await page.locator('#whiteboard-actions').isVisible(), false);
        assert.equal(await page.locator('#whiteboard-pure').getAttribute('aria-pressed'), 'true');
        await page.keyboard.press('v'); await page.keyboard.press('v');
        assert.equal(await page.evaluate(() => HandwritingWhiteboard.isPureMode()), true);
        assert.equal(await page.locator('#whiteboard-code').inputValue(), whiteboardLatex);
        assert.equal(calls.filter(c => c.action === 'start' && c.purpose === 'whiteboard').length, startsBeforePure);
        await page.keyboard.press('v');
        await page.locator('#whiteboard-pure').click(); // Changing mode must not expand the collapsed board.
        assert.ok((await whiteboard.boundingBox()).height < 50);
        assert.equal(await page.evaluate(() => HandwritingWhiteboard.isPureMode()), false);
        await page.locator('#whiteboard-collapse').click();
        assert.equal(await page.locator('#whiteboard-actions').isVisible(), true);
        pass('纯白板模式与 V/按钮折叠独立；展开恢复原模式、尺寸、草稿和手机连接');
        await page.locator('#whiteboard-engine').click(); await page.waitForTimeout(800);
        assert.equal(calls.filter(c => c.action === 'state' && c.session === 'whiteboard-session').at(-1).engine, 'deepseek');
        assert.equal(calls.filter(c => c.action === 'state' && c.session === 'test-session').at(-1).engine, '');
        await page.locator('#whiteboard-close').click();
        await textTool.click(); await textTool.click();
        assert.equal(await whiteboard.isVisible(), true);
        assert.equal(calls.filter(c => c.action === 'start' && c.purpose === 'whiteboard').length, 1);
        assert.equal(closes, previousCloses);
        if (saveArtifacts) await page.screenshot({ path: path.join(resultsDir, 'handwriting-whiteboard.png') });
        await page.setViewportSize({ width: 600, height: 500 }); await page.waitForTimeout(200);
        const smallBoard = await whiteboard.boundingBox();
        assert.ok(smallBoard.x >= 0 && smallBoard.y >= 0 && smallBoard.x + smallBoard.width <= 600 && smallBoard.y + smallBoard.height <= 500);
        await textTool.click(); assert.equal(await whiteboard.isVisible(), false);
        await page.evaluate(() => addAnnotation(1, { id: 'box', type: 'text', color: '#000000', x: .12, y: .1, text: 'New note' }));
        await open(); await mode('phone');
        assert.equal(await page.locator('#formula-code').inputValue(), '$z=3$');
        pass('白板二次入口、外部点击常驻、自由拖动缩放、折叠隐藏保持同步、双模型和识别结果隔离、小窗口适配');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
