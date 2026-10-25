// 绘图预览坐标系回归测试：批注层残留的缩放矩阵不得让自由直线/自由高亮块的
// 拖拽预览偏离鼠标、并在松手落库后又跳回正确位置。
//
// 症状（修复前）：批注层还挂着上一次缩放的临时 transform 时，页面的批注几何
// （wrapper client rect）和批注层坐标系相差一个缩放系数。拖拽预览画进这个被缩放的
// 坐标系里，于是条带在鼠标之外一段距离开始画线；松手后落库会重建视图、顺手清掉
// 残留矩阵，图形又"跳"回正确位置。
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, loadFixture, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

const TOOLS = [
    { tool: 'line', label: '任意直线', multiPhase: false },
    { tool: 'highlight-block', label: '自由高亮块', multiPhase: true },
];
const TOLERANCE = 1.5;

(async () => {
    const variant = process.argv[2] === 'baseline' ? 'baseline' : 'current';
    const fixtures = { 'a.pdf': await fixture('text', 6) };
    const server = await startServer(fixtures);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const checks = [], errors = [];
    const pass = name => { checks.push(name); console.log('PASS ' + name); };
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto(origin + (variant === 'baseline' ? '/baseline' : '') + '/LOCALPdfReader.html');
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.waitForTimeout(500);

        const layerTransform = () => page.evaluate(() => document.getElementById('annotation-layer-1').style.transform || '');
        const pageRect = () => page.evaluate(() => {
            const w = document.getElementById('page-wrapper-1');
            w.scrollIntoView({ block: 'center' });
            return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
                const b = w.getBoundingClientRect();
                resolve({ left: b.left, top: b.top, width: b.width, height: b.height });
            })));
        });
        // 预览图形的"末端"：直线取 <line> 的 (x2,y2)，高亮块取旋转矩形的轴线末端
        // （旋转后的包围盒会同时框住两端，直接用 box 的右边会把起点也算进去）。
        const previewTip = tool => page.evaluate(tool => {
            const shape = document.querySelector('#temp-drawing-svg > *');
            if (!shape) return null;
            const wrap = document.getElementById('page-wrapper-1').getBoundingClientRect();
            const layerTransform = document.getElementById('annotation-layer-1').style.transform || '';
            if (tool === 'highlight-block') {
                const m = /translate\(([-\d.eE+]+),\s*([-\d.eE+]+)\)\s*rotate\(([-\d.eE+]+)\)/.exec(shape.getAttribute('transform') || '');
                const rad = parseFloat(m[3]) * Math.PI / 180;
                const len = parseFloat(shape.getAttribute('width'));
                return { layerTransform, x: wrap.left + parseFloat(m[1]) + Math.cos(rad) * len, y: wrap.top + parseFloat(m[2]) + Math.sin(rad) * len };
            }
            return { layerTransform, x: wrap.left + parseFloat(shape.getAttribute('x2')), y: wrap.top + parseFloat(shape.getAttribute('y2')) };
        }, tool);
        const committedTip = tool => page.evaluate(tool => {
            const anno = (state.annotations[1] || []).filter(a => a.type === tool).pop();
            if (!anno) return null;
            const wrap = document.getElementById('page-wrapper-1').getBoundingClientRect();
            return { x: wrap.left + anno.end.x * wrap.width, y: wrap.top + anno.end.y * wrap.height };
        }, tool);

        // 一次完整手势：拖出方向 → （多段式工具再调厚度并点击定型）→ 落库。
        const drawGesture = async ({ tool, label, multiPhase }) => {
            await page.evaluate(() => { state.annotations[1] = []; renderAnnotations(1, true); });
            await page.waitForTimeout(80);
            await page.evaluate(tool => { state.currentTool = tool; updateToolButtons(); }, tool);

            const rect = await pageRect();
            const start = { x: rect.left + rect.width * 0.15, y: rect.top + rect.height * 0.30 };
            const end = { x: rect.left + rect.width * 0.70, y: rect.top + rect.height * 0.45 };
            const offsets = [];
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            for (let i = 1; i <= 6; i++) {
                const mx = start.x + (end.x - start.x) * i / 6;
                const my = start.y + (end.y - start.y) * i / 6;
                await page.mouse.move(mx, my);
                await page.waitForTimeout(25);
                const tip = await previewTip(tool);
                assert.ok(tip, `${label}：拖拽期间必须存在临时预览图形`);
                assert.equal(tip.layerTransform, '', `${label}：手势期间批注层不得带缩放矩阵（否则预览落在被缩放的坐标系里）`);
                offsets.push(Math.hypot(tip.x - mx, tip.y - my));
            }
            await page.mouse.up();
            if (multiPhase) {
                await page.mouse.move(end.x, end.y + 26, { steps: 4 });
                await page.waitForTimeout(40);
                const thickTip = await previewTip(tool);
                assert.ok(thickTip && thickTip.layerTransform === '', `${label}：调厚度阶段同样不得带缩放矩阵`);
                await page.mouse.down();
                await page.mouse.up();
            }
            await page.waitForTimeout(200);

            const worst = Math.max(...offsets);
            assert.ok(worst <= TOLERANCE, `${label}：拖拽预览偏离鼠标 ${worst.toFixed(2)}px（应 ≤${TOLERANCE}px）`);
            const tip = await committedTip(tool);
            assert.ok(tip, `${label}：必须落库出矢量批注`);
            assert.ok(Math.hypot(tip.x - end.x, tip.y - end.y) <= TOLERANCE,
                `${label}：落库图形端点 (${tip.x.toFixed(1)},${tip.y.toFixed(1)}) 应与鼠标终点 (${end.x.toFixed(1)},${end.y.toFixed(1)}) 一致`);
            assert.equal(await layerTransform(), '', `${label}：落库后批注层不得残留缩放矩阵`);
            assert.equal(await page.evaluate(tool => (state.annotations[1] || []).filter(a => a.type === tool).length, tool), 1);
            return worst;
        };

        // 1) 干净的 100% 状态下先确认基线行为正常。
        const clean = await drawGesture(TOOLS[0]);
        pass(`${TOOLS[0].label}：无残留矩阵时预览贴合鼠标（最大偏离 ${clean.toFixed(2)}px）`);

        // 2) 核心用例：把批注层恢复到"上一次缩放留下的残留矩阵 + 陈旧 view"状态再画。
        //    这正是真实使用中缩放/回挂页面后立刻批注的样子；旧代码会从这里开始漂移。
        const seeded = await page.evaluate(() => {
            const wrapper = document.getElementById('page-wrapper-1');
            const layer = document.getElementById('annotation-layer-1');
            // 自然复现（页面回挂时把旧 layer transform 一起带回来）优先；如果这一轮没赶上，
            // 就手工构造同一状态，保证这条用例每次都真的在考"批注层带缩放矩阵"。
            if (layer.style.transform === '') {
                layer.style.transform = 'scale(0.666667, 0.666667)';
                wrapper._annotationView = {
                    width: parseFloat(wrapper.style.width) / 0.666667,
                    height: parseFloat(wrapper.style.height) / 0.666667,
                    scale: state.scale - 0.5,
                    entries: wrapper._annotationView ? wrapper._annotationView.entries : new Map(),
                };
            }
            return { stale: layer.style.transform !== '' };
        });
        assert.equal(seeded.stale, true, '必须构造出"批注层带缩放矩阵"的初始状态');
        for (const spec of TOOLS) {
            const worst = await drawGesture(spec);
            pass(`${spec.label}：批注层带残留缩放矩阵时预览仍贴合鼠标（最大偏离 ${worst.toFixed(2)}px），落库位置一致且矩阵被清除`);
        }

        // 3) 缩放手势期间的"批注整体变换"仍须保留，且缩放结束后自动清除——
        //    修复不得以牺牲缩放联动为代价。
        await page.evaluate(() => updateZoom(1.5));
        await page.waitForTimeout(40);
        assert.notEqual(await layerTransform(), '', '缩放手势进行中，批注层仍应保留临时整体变换');
        await page.waitForTimeout(1200);
        assert.equal(await layerTransform(), '', '缩放结束后批注层必须回到无变换状态');
        pass('缩放期间的整体变换仍生效，缩放结束后自动清除');

        if (process.env.READER_TEST_ARTIFACTS === '1') {
            fs.mkdirSync(resultsDir, { recursive: true });
            await page.screenshot({ path: path.join(resultsDir, 'draw-preview-axis.png') });
        }
        assert.deepEqual(errors, [], 'No browser errors');
        console.log(`\n${checks.length} 项检查全部通过`);
    } finally {
        await browser.close();
        server.close();
    }
})().catch(error => { console.error('FAIL ' + (error && error.message)); process.exitCode = 1; });
