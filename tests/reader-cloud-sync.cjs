// 云端批注库端到端自检：真实 server.py + 真实浏览器 + 一个「假 GitHub」。
//
//     node tests/reader-cloud-sync.cjs
//
// 与 test_cloud_backend.py 的分工：那个只管后端驱动（请求形状、命名、错误提示），
// 这个管整条链路——浏览器按保存 → /api/cloud-anno → 驱动 → 仓库，
// 以及「云端挂了本地照常保存」「离线排队补传」「打开只提示不自动改」这些用户能感觉到的行为。
// 全程不联网、不需要真账号。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { fixture, deps } = require('./reader-performance.cjs');
const { startBackend } = require('./chat-backend.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

const TOKEN = 'good-token';
const TMP = path.join(__dirname, '.tmp-cloud-test');

// ---------------------------------------------------------------- 假 GitHub
function createFakeGithub() {
    const files = new Map();      // path -> { content: Buffer, sha }
    const requests = [];
    let sequence = 0;
    const sha = prefix => `${prefix}-${String(++sequence).padStart(4, '0')}`;
    const json = (res, code, body) => {
        const data = Buffer.from(JSON.stringify(body), 'utf-8');
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
        res.end(data);
    };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const parts = url.pathname.split('/').filter(Boolean);
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {};
            requests.push({ method: req.method, path: url.pathname, body });
            if (req.headers.authorization !== 'Bearer ' + TOKEN) { json(res, 401, { message: 'Bad credentials' }); return; }
            if (url.pathname === '/repos/owner/repo') { json(res, 200, { full_name: 'owner/repo', private: true, default_branch: 'main' }); return; }
            if (parts[3] === 'contents') {
                const key = parts.slice(4).map(decodeURIComponent).join('/');
                if (req.method === 'GET') {
                    const entry = files.get(key);
                    if (entry) {
                        json(res, 200, { type: 'file', name: key.split('/').pop(), path: key, sha: entry.sha, size: entry.content.length, encoding: 'base64', content: entry.content.toString('base64') });
                        return;
                    }
                    // 目录清单：GitHub 用数组返回该目录下的文件，但**只给 name/path/sha/size，
                    // 不给 content**（内容只有单独取文件时才有）；目录不存在才 404
                    const prefix = key ? key + '/' : '';
                    const children = [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
                    if (children.length) {
                        json(res, 200, children.map(p => ({ type: 'file', name: p.split('/').pop(), path: p, sha: files.get(p).sha, size: files.get(p).content.length })));
                        return;
                    }
                    json(res, 404, { message: 'Not Found' });
                    return;
                }
                if (req.method === 'PUT' || req.method === 'POST') {
                    const existing = files.get(key);
                    if (existing && !body.sha) { json(res, 422, { message: "'sha' wasn't supplied." }); return; }
                    if (body.sha && existing && body.sha !== existing.sha) { json(res, 409, { message: 'sha does not match' }); return; }
                    files.set(key, { content: Buffer.from(body.content || '', 'base64'), sha: sha('file') });
                    json(res, existing ? 200 : 201, { content: { path: key, sha: files.get(key).sha }, commit: { sha: sha('commit') } });
                    return;
                }
            }
            json(res, 404, { message: 'Not Found' });
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
        files, requests, port: server.address().port,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(r => server.close(r)),
    })));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(describe, predicate, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(80);
    }
    throw new Error('等待超时：' + describe);
}

const checks = [];
function pass(label) { checks.push(label); console.log('  [PASS] ' + label); }

(async () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    const github = await createFakeGithub();
    const configPath = path.join(TMP, 'cloud_config.json');
    fs.writeFileSync(configPath, JSON.stringify({
        enabled: true, provider: 'github', owner: 'owner', repo: 'repo', token: TOKEN,
        branch: 'main', dir: 'annotations', device: 'TEST-PC', proxy: '', api_base: github.origin,
    }, null, 2));
    process.env.PDF_READER_CLOUD_CONFIG = configPath;

    const backend = await startBackend();
    const origin = backend.origin;
    const pdfA = await fixture('text', 3);
    const browser = await chromium.launch({
        executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    const bar = () => page.evaluate(() => {
        // 三合一之后：状态看那枚小胶囊（颜色/图标/悬浮提示），文字在 title 里
        const chip = document.getElementById('cloud-restore-btn');
        return {
            visible: !chip.classList.contains('hidden'),
            text: chip.title,
            tone: document.getElementById('cloud-chip-icon').className,
            dot: !document.getElementById('cloud-chip-dot').classList.contains('hidden'),
            count: document.getElementById('cloud-restore-count').textContent,
            phase: state.cloudSync?.phase || 'none',
        };
    });
    const openDoc = (name, useSaved = false) => page.evaluate(async ({ b64, fileName, useSaved }) => {
        // useSaved = 用「上一次真正写盘的那份 PDF」重新打开，模拟关掉再开这本书
        const bytes = (useSaved && window.__lastSaved)
            ? new Uint8Array(window.__lastSaved)
            : Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const file = new File([bytes], fileName, { type: 'application/pdf' });
        // 句柄桩：不弹另存为对话框，同时把真正写出去的字节留下来做断言
        state.fileHandle = {
            queryPermission: async () => 'granted',
            createWritable: async () => ({
                truncate: async () => {},
                write: async data => {
                    window.__savedBytes = data instanceof Blob ? await data.arrayBuffer() : data;
                    window.__lastSaved = window.__savedBytes;
                },
                close: async () => {},
            }),
        };
        await loadPDFFromFile(file);
        await state.annotationsReady;
    }, { b64: pdfA.toString('base64'), fileName: name, useSaved });

    try {
        await page.goto(origin + '/LOCALPdfReader.html');
        await page.waitForFunction(() => typeof CloudSync !== 'undefined');
        // ---------- 0. 还没打开任何文档：入口就该在，云库能翻但取回置灰 ----------
        await page.waitForFunction(() => !document.getElementById('cloud-restore-btn').classList.contains('hidden'),
            null, { timeout: 15000 });
        assert.equal(await page.evaluate(() => document.getElementById('cloud-sync-btn').classList.contains('hidden')), true,
            '「立即同步」管的是当前文档的批注，没开文档时不该出现');
        await page.click('#cloud-restore-btn');
        await page.waitForSelector('#cloud-panel:not(.hidden)');
        assert.equal(await page.evaluate(() => !document.getElementById('cloud-panel-note').classList.contains('hidden')), true,
            '没打开文档时该说明「打开一本书之后才能取回批注」');
        pass('云端已配置时入口一进页面就在（不必先打开一本书），云库能翻、取回置灰并说明原因');
        await page.click('#cloud-panel-close');

        await openDoc('物理 必修一.pdf');
        assert.equal(await page.evaluate(() => document.getElementById('cloud-sync-btn').classList.contains('hidden')), false,
            '打开文档之后「立即同步」才该出现');
        pass('云端功能随页面加载，打开文档不报错');

        // ---------- 1. 保存即上传 ----------
        await page.evaluate(() => {
            state.annotations[1] = [{ id: 'a1', type: 'highlight', color: '#fde047', text: '第一条', rects: [{ x: .1, y: .2, w: .3, h: .02 }] }];
            performAction(() => {});
        });
        await page.evaluate(() => performSave());
        await waitFor('云端收到第一份批注', () => github.files.has('annotations/物理 必修一_annotations.json'));
        const first = JSON.parse(github.files.get('annotations/物理 必修一_annotations.json').content.toString('utf-8'));
        assert.equal(first.app, 'PDFReaderPro');
        assert.equal(first.fileName, '物理 必修一.pdf');
        assert.equal(first.device, 'TEST-PC');
        assert.equal(first.fingerprint, await page.evaluate(() => state.fingerprint));
        assert.equal(first.annotations['1'].length, 1);
        pass('保存一次 → 云端按 PDF 名字建立 <PDF名>_annotations.json');

        await waitFor('状态条显示已同步', async () => (await bar()).phase === 'ok');
        const synced = await bar();
        assert.ok(synced.visible && synced.text.includes('云端已同步'), JSON.stringify(synced));
        assert.ok(synced.tone.includes('ph-cloud-check') && synced.count === '1', JSON.stringify(synced));
        pass('保存后检索行右端的云朵胶囊变绿打勾，份数变 1');

        // ---------- 2. 再保存 = 覆盖更新同一份文件 ----------
        const before = github.requests.length;
        await page.evaluate(() => {
            state.annotations[1].push({ id: 'a2', type: 'highlight', color: '#bbf7d0', text: '第二条', rects: [{ x: .1, y: .3, w: .3, h: .02 }] });
            updateSaveStatus(true);
        });
        await page.evaluate(() => performSave());
        await waitFor('云端条数变成 2', () => {
            const entry = github.files.get('annotations/物理 必修一_annotations.json');
            return entry && JSON.parse(entry.content.toString('utf-8')).annotations['1'].length === 2;
        });
        assert.equal(github.files.size, 1, '不应该多出一个新文件');
        const writes = github.requests.slice(before).filter(r => r.method === 'PUT' || r.method === 'POST');
        assert.ok(writes.some(r => r.body.sha), '覆盖更新必须带 sha');
        pass('再次保存 → 覆盖更新同一份云端文件（不是新建、不是追加）');

        // ---------- 3. 云端不可用：本地保存照常 ----------
        await page.route('**/api/cloud-anno', route => {
            if (route.request().method() === 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, configured: true, error: '模拟云端断网' }) });
            return route.continue();
        });
        await page.evaluate(() => {
            state.annotations[1].push({ id: 'a3', type: 'highlight', color: '#fca5a5', text: '第三条', rects: [{ x: .1, y: .4, w: .3, h: .02 }] });
            updateSaveStatus(true);
        });
        await page.evaluate(() => performSave());
        await waitFor('胶囊进入待同步', async () => (await bar()).phase === 'pending');
        const offline = await bar();
        assert.ok(offline.text.includes('云端待同步') && offline.dot, JSON.stringify(offline));
        assert.equal(await page.evaluate(() => state.unsavedChanges), false, '云端失败不能影响本地保存状态');
        const pdfBytes = Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(window.__savedBytes))));
        assert.ok(pdfBytes.length > 1000, 'PDF 仍然真的写盘了');
        assert.equal(await page.evaluate(() => CloudSync.pendingCount()), 1);
        pass('云端断网：本地 PDF 照常写盘、胶囊变琥珀色带小圆点、批注进入离线队列');

        // ---------- 4. 云端恢复：自动补传 ----------
        await page.unroute('**/api/cloud-anno');
        const flushed = await page.evaluate(() => CloudSync.flushQueue());
        assert.equal(flushed, true);
        await waitFor('补传后云端是 3 条', () => {
            const entry = github.files.get('annotations/物理 必修一_annotations.json');
            return entry && JSON.parse(entry.content.toString('utf-8')).annotations['1'].length === 3;
        });
        assert.equal(await page.evaluate(() => CloudSync.pendingCount()), 0);
        pass('云端恢复后补传成功，队列清空');
        // ---------- 5. 打开文档只提示、不自动改 ----------
        const newer = JSON.parse(github.files.get('annotations/物理 必修一_annotations.json').content.toString('utf-8'));
        newer.device = 'OTHER-PC';
        newer.timestamp = new Date(Date.now() + 3600_000).toISOString();
        newer.annotations['1'].push({ id: 'remote-1', type: 'highlight', color: '#93c5fd', text: '另一台电脑加的', rects: [{ x: .2, y: .5, w: .2, h: .02 }] });
        github.files.set('annotations/物理 必修一_annotations.json', { content: Buffer.from(JSON.stringify(newer), 'utf-8'), sha: 'remote-sha' });
        // 服务端的目录清单有 20 秒缓存（连开几份文档时不必反复打接口），这里显式刷新一次
        await page.evaluate(() => fetch('/api/cloud-anno/list?refresh=1').then(r => r.json()));
        await openDoc('物理 必修一.pdf', true);
        await waitFor('胶囊出现云端更新提示', async () => (await bar()).phase === 'remote');
        const hint = await bar();
        assert.ok(hint.text.includes('云端有更新的批注') && hint.text.includes('OTHER-PC'), JSON.stringify(hint));
        assert.ok(hint.dot && hint.tone.includes('ph-cloud-arrow-down'), JSON.stringify(hint));
        const ids = await page.evaluate(() => state.annotations['1'].map(a => a.id));
        assert.ok(!ids.includes('remote-1'), '打开文档时绝不能自动合并云端批注：' + JSON.stringify(ids));
        assert.ok(ids.includes('a1') && ids.includes('a3'), '本地批注必须原封不动：' + JSON.stringify(ids));
        pass('打开文档只把胶囊点亮（蓝 + 小圆点）并写进悬浮提示，本地批注一动不动');

        // ---------- 6. 在面板顶部动作条点「合并」才真正取回 ----------
        await page.click('#cloud-restore-btn');
        await page.waitForSelector('#cloud-panel:not(.hidden) #cloud-panel-action:not(.hidden)');
        // 动作条只放短句（侧栏窄），完整信息在悬浮提示里
        const actionText = await page.textContent('#cloud-panel-action-text');
        const actionTitle = await page.getAttribute('#cloud-panel-action-text', 'title');
        assert.ok(actionText.includes('云端有更新') && actionText.includes('OTHER-PC'), actionText);
        assert.ok(actionTitle.includes('云端有更新的批注') && actionTitle.includes('OTHER-PC'), actionTitle);
        await page.click('#cloud-panel-action-primary');
        await waitFor('云端那条被合并进来', async () => (await page.evaluate(() => state.annotations['1'].map(a => a.id))).includes('remote-1'));
        const merged = await page.evaluate(() => state.annotations['1'].map(a => a.id).sort());
        assert.deepEqual(merged, ['a1', 'a2', 'a3', 'remote-1']);
        pass('动作条写明「谁在什么时候更新了几条」，点「合并」才把云端批注并进来（原有批注一条不丢）');

        // ---------- 7. 合并可撤销 + 云库面板「覆盖」 ----------
        await page.evaluate(() => undo());
        assert.deepEqual(await page.evaluate(() => state.annotations['1'].map(a => a.id).sort()), ['a1', 'a2', 'a3']);
        await page.evaluate(() => redo());
        pass('云端合并同样进撤销栈（Ctrl+Z 可回退）');

        await page.click('#cloud-restore-btn');
        // 面板会先摆一行「正在读取云端批注库…」，要等真实清单回来（含文件名）再断言
        await page.waitForFunction(() => document.getElementById('cloud-panel').classList.contains('hidden') === false
            && document.getElementById('cloud-panel-list').textContent.includes('物理 必修一.pdf'));
        // 时间/设备/条数是懒加载的：先出文件名，随后按需补详情
        await page.waitForFunction(() => document.getElementById('cloud-panel-list').textContent.includes('OTHER-PC'), null, { timeout: 20000 });
        const panelText = await page.textContent('#cloud-panel-list');
        assert.ok(panelText.includes('物理 必修一.pdf') && panelText.includes('OTHER-PC'), panelText);
        pass('云库清单：打开先出文件名，时间/设备/条数随后自动补齐');

        // 搜索：书多了以后靠它找（无匹配给提示、匹配数与总数可见）
        await page.fill('#cloud-panel-search', '不存在的一本书');
        await page.waitForFunction(() => document.getElementById('cloud-panel-list').textContent.includes('没有匹配'));
        const missCount = await page.textContent('#cloud-panel-count');
        assert.ok(missCount.includes('匹配 0') && missCount.includes('共 1 份'), missCount);
        await page.fill('#cloud-panel-search', '必修一');
        await page.waitForFunction(() => document.getElementById('cloud-panel-list').textContent.includes('物理 必修一.pdf'));
        pass('云库清单支持搜索：无匹配时给提示，匹配数/总数一目了然');
        await page.click('#cloud-panel-search-clear');
        await page.waitForFunction(() => document.querySelectorAll('#cloud-panel-list > div').length === 1);

        await page.click('#cloud-panel-list button:has-text("覆盖")');
        await waitFor('覆盖生效', async () => JSON.stringify(await page.evaluate(() => state.annotations['1'].map(a => a.id).sort())) === JSON.stringify(['a1', 'a2', 'a3', 'remote-1']));
        pass('云库面板可一键合并/覆盖到当前文档');

        // ---------- 8. 与「导入批注」共用同一套回灌逻辑 ----------
        const settingsKept = await page.evaluate(async () => {
            state.annotations['settings'] = { lastPage: 2, pageOffset: 1 };
            const bundle = { app: 'PDFReaderPro', fingerprint: state.fingerprint, fileName: '物理 必修一.pdf', annotations: { 2: [{ id: 'x9', type: 'highlight', rects: [] }], settings: { lastPage: 9 } } };
            importAnnotationBundle(bundle, { mode: 'overwrite', source: '自检' });
            return { ids: state.annotations['2'].map(a => a.id), settings: state.annotations['settings'] };
        });
        assert.deepEqual(settingsKept.ids, ['x9']);
        // settings 属于本机阅读状态，必须留着；lastPage 会随当前浏览页刷新，故只断言页码偏移这类设置没被云端覆盖
        assert.equal(settingsKept.settings.pageOffset, 1, JSON.stringify(settingsKept.settings));
        pass('云端取回与本地导入共用一套逻辑，且覆盖时不丢本机阅读设置');

        // ---------- 9. 代理没开：入口照样在，点一下就能恢复（不刷新页面）----------
        // 这正是这条改动的由来：以前连不上云端时「配置探测」会把 configured 判成 false，
        // 那枚胶囊直接消失；等用户想起来开代理，只能刷新页面重开 PDF。
        await page.route('**/api/cloud-anno/status*', route => {
            if (route.request().url().includes('local=1')) return route.continue();   // 纯本地那一问必须照常
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ ok: false, configured: true, reachable: false, error: '连不上云端（模拟代理没开）' }),
            });
        });
        await page.goto(origin + '/LOCALPdfReader.html');
        await page.waitForFunction(() => typeof CloudSync !== 'undefined');
        await page.waitForFunction(() => document.getElementById('cloud-restore-btn').classList.contains('hidden') === false,
            null, { timeout: 15000 });
        await page.waitForFunction(() => state.cloudSync?.phase === 'offline', null, { timeout: 15000 });
        const unplugged = await bar();
        assert.ok(unplugged.visible, '连不上云端时入口也必须留着：' + JSON.stringify(unplugged));
        assert.ok(unplugged.tone.includes('ph-cloud-slash'), '胶囊该显示成「连不上」：' + JSON.stringify(unplugged));
        assert.ok(unplugged.dot, '连不上是要用户注意的事，该有小圆点：' + JSON.stringify(unplugged));
        assert.ok(unplugged.text.includes('代理'), '悬浮提示要说清多半是代理没开：' + JSON.stringify(unplugged));
        pass('代理没开时入口不消失：胶囊变红提示「连不上云端 / 点一下重试」');

        // 文档照样能打开、批注照样存本地；这次上传不硬等云端超时，直接进离线队列
        await openDoc('物理 必修一.pdf');
        await page.evaluate(() => {
            state.annotations[1] = [{ id: 'off-1', type: 'highlight', color: '#fde047', text: '离线时写的', rects: [{ x: .1, y: .2, w: .3, h: .02 }] }];
            performAction(() => {});
        });
        await page.evaluate(() => performSave());
        await waitFor('离线时保存进队列', async () => (await bar()).phase === 'pending');
        assert.equal(await page.evaluate(() => state.unsavedChanges), false, '连不上云端不能影响本地保存状态');
        assert.equal(github.files.size, 1, '连不上时不该有新的云端写入');
        pass('连不上云端：保存照常完成，批注进离线队列，不硬等云端超时');

        // 代理开好了：不用刷新页面，点一下胶囊就该恢复，并把排队的补传掉
        await page.unroute('**/api/cloud-anno/status*');
        await page.click('#cloud-restore-btn');
        await waitFor('恢复后自动补传', async () => (await page.evaluate(() => CloudSync.pendingCount())) === 0, 20000);
        await waitFor('胶囊收起「连不上 / 待同步」', async () => ['ok', 'idle'].includes((await bar()).phase), 20000);
        const recovered = await bar();
        assert.ok(recovered.tone.includes('ph-cloud') && !recovered.tone.includes('ph-cloud-slash'),
            '恢复后不该还是一副「连不上」的样子：' + JSON.stringify(recovered));
        // 清单接口只给云端文件名（书名/设备/条数要等懒补详情），这里断言已经拿到真实清单、
        // 而不是那行「云端读取失败」
        await waitFor('恢复后面板拿到真实清单', async () =>
            (await page.locator('#cloud-panel-list [data-cloud-key="annotations/物理 必修一_annotations.json"]').count()) === 1, 20000);
        assert.ok(!(await page.textContent('#cloud-panel-list')).includes('读取失败'),
            '恢复后清单不该还是失败提示：' + await page.textContent('#cloud-panel-list'));
        pass('代理开好后点一下胶囊即恢复（自动补传排队的批注），不必刷新页面重开 PDF');
        await page.click('#cloud-panel-close');

        // ---------- 10. 关掉云端 = 完全隐形（零回归保证）----------
        const writesBefore = github.requests.filter(r => r.method === 'PUT' || r.method === 'POST').length;
        fs.writeFileSync(configPath, JSON.stringify({
            enabled: false, provider: 'github', owner: 'owner', repo: 'repo', token: TOKEN,
            branch: 'main', dir: 'annotations', device: 'TEST-PC', proxy: '', api_base: github.origin,
        }, null, 2));
        await page.goto(origin + '/LOCALPdfReader.html');
        await page.waitForFunction(() => typeof CloudSync !== 'undefined');
        await openDoc('物理 必修一.pdf');
        await page.evaluate(() => performSave());
        await sleep(1200);
        const dormant = await bar();
        assert.equal(dormant.visible, false, '未启用时连那枚云朵胶囊都不该出现：' + JSON.stringify(dormant));
        assert.equal(await page.evaluate(() => document.getElementById('anno-search-input') !== null), true,
            '检索批注内容那一行必须照旧可用');
        assert.equal(await page.evaluate(() => state.unsavedChanges), false);
        assert.equal(github.requests.filter(r => r.method === 'PUT' || r.method === 'POST').length, writesBefore,
            '未启用时不该向仓库写任何东西');
        pass('enabled=false 时功能完全隐形：入口、提示、上传全部消失，保存行为与旧版一致');

        assert.deepEqual(pageErrors, []);
        fs.writeFileSync(path.join(__dirname, 'results', 'cloud-sync.json'), JSON.stringify({ checks, cloudPath: 'annotations/物理 必修一_annotations.json' }, null, 2));
        console.log('\n云端批注库端到端自检：' + checks.length + ' 项全部通过 ✅');
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        await backend.stop().catch(() => {});
        await github.close().catch(() => {});
        fs.rmSync(TMP, { recursive: true, force: true });
        delete process.env.PDF_READER_CLOUD_CONFIG;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
