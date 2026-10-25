// 文本框右下角缩放手势回归测试：原生拖拉角已隐藏，且页面缩放不再改写文本框尺寸。
// 复用 reader-performance.cjs 的临时服务与固定样本，不启动正式服务、不读写用户教材。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, startServer, instrument, loadFixture, deps, resultsDir } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const fixtures = { 'a.pdf': await fixture('text', 6) };
    const server = await startServer(fixtures);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const checks = [], errors = [];
    const pass = name => { checks.push(name); console.log('PASS ' + name); };
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto(origin + '/LOCALPdfReader.html');
        await instrument(page);
        await loadFixture(page, 'a.pdf');
        await page.waitForTimeout(300);

        // 固定尺寸文本框 + 内容自适应文本框 + 历史数据 + 专供"临时变换"用例的文本框
        await page.evaluate(() => {
            addAnnotation(1, { id: 'fixed-box', type: 'text', color: '#000000', x: 0.1, y: 0.1, width: 0.3, height: 0.08, text: '固定尺寸文本框 fixed box' });
            addAnnotation(1, { id: 'auto-box', type: 'text', color: '#000000', x: 0.55, y: 0.1, text: '自适应文本框 auto box' });
            addAnnotation(1, { id: 'legacy-tiny', type: 'text', color: '#000000', x: 0.1, y: 0.6, width: 0.004, height: 0.002, text: '历史极小文本框 legacy tiny' });
            addAnnotation(1, { id: 'transform-box', type: 'text', color: '#000000', x: 0.06, y: 0.02, width: 0.25, height: 0.06, text: '临时变换文本框 temp transform box' });
            renderAnnotations(1, true);
        });
        await page.waitForTimeout(200);

        const snap = id => page.evaluate(id => {
            const div = document.querySelector(`.text-annotation[data-id="${id}"]`);
            const anno = state.annotations[1].find(a => a.id === id);
            const wrapper = document.getElementById('page-wrapper-1');
            const rect = div.getBoundingClientRect();
            return {
                resizeCss: getComputedStyle(div).resize,
                visualW: rect.width, visualH: rect.height,
                ratioW: rect.width / wrapper.getBoundingClientRect().width,
                ratioH: rect.height / wrapper.getBoundingClientRect().height,
                annoW: anno.width, annoH: anno.height,
                textCount: (state.annotations[1] || []).filter(a => a.type === 'text').length,
                modalHidden: document.getElementById('note-modal').classList.contains('hidden'),
            };
        }, id);
        // 交互前滚到视口中央，避免鼠标坐标落在视口外
        const boxRect = (id, dx = 0, dy = 0) => page.evaluate(([id, dx, dy]) => {
            document.querySelector(`.text-annotation[data-id="${id}"]`).scrollIntoView({ block: 'center' });
            return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
                const r = document.querySelector(`.text-annotation[data-id="${id}"]`).getBoundingClientRect();
                resolve({ x: r.right + dx, y: r.bottom + dy, right: r.right, bottom: r.bottom, left: r.left, top: r.top, w: r.width, h: r.height });
            })));
        }, [id, dx, dy]);

        const seeded = await snap('fixed-box');
        assert.equal(seeded.resizeCss, 'none');
        assert.ok(Math.abs(seeded.ratioW - seeded.annoW) < 0.002);
        pass('原生拖拉角（右下角两道杠）已从文本框上移除');

        // 右下角悬停只切换指针形态，不产生任何可见图形
        const corner = await boxRect('fixed-box', -6, -6);
        await page.mouse.move(corner.x, corner.y);
        await page.waitForTimeout(80);
        assert.equal(await page.evaluate(() => document.querySelector('.text-annotation[data-id="fixed-box"]').classList.contains('resize-hover')), true);
        pass('右下角悬停时切换为缩放指针');

        // 拖动右下角：放大并精确落库
        await page.mouse.down();
        await page.mouse.move(corner.right + 40, corner.bottom + 24, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(400);
        const grown = await snap('fixed-box');
        assert.ok(grown.visualW > corner.w + 30 && grown.visualH > corner.h + 15);
        assert.ok(Math.abs(grown.ratioW - grown.annoW) < 0.002 && Math.abs(grown.ratioH - grown.annoH) < 0.002);
        assert.equal(grown.textCount, 4);
        assert.equal(grown.modalHidden, true);
        pass('拖动右下角可缩放文本框，且存下来的比例与屏幕完全一致');

        // 反复缩放页面：屏幕比例与批注比例都必须纹丝不动
        const perScale = [];
        for (const scale of [0.5, 2, 1.5, 1, 3, 0.5, 1]) {
            await page.evaluate(scale => updateZoom(scale), scale);
            await page.waitForTimeout(600);
            perScale.push(await snap('fixed-box'));
        }
        // 允许浏览器 1/64 像素布局取整带来的极小误差（真实漂移是 0.02 量级）
        const drift = Math.max(...perScale.map(s => Math.max(Math.abs(s.ratioW - grown.ratioW), Math.abs(s.ratioH - grown.ratioH))));
        assert.ok(drift < 0.001, `ratio drift ${drift}`);
        assert.ok(perScale.every(s => Math.abs(s.ratioW - s.annoW) < 0.002 && Math.abs(s.ratioH - s.annoH) < 0.002));
        assert.ok(perScale.every(s => s.annoW === grown.annoW && s.annoH === grown.annoH));
        pass('七档缩放下来文本框尺寸与存储比例完全不漂移');

        // 内容自适应的文本框（从未手动定尺寸）也必须随页面等比缩放
        const autoRatios = [];
        for (const scale of [0.5, 2, 1, 3, 1]) {
            await page.evaluate(scale => updateZoom(scale), scale);
            await page.waitForTimeout(600);
            const auto = await snap('auto-box');
            autoRatios.push(Number(auto.ratioW.toFixed(3)) + '/' + Number(auto.ratioH.toFixed(3)));
        }
        assert.equal(new Set(autoRatios).size, 1, autoRatios.join(' '));
        pass('未手动定尺寸的文本框缩放时保持等比');

        // 历史数据里小于内边距下限的尺寸：渲染会被内边距托底，但托底比例必须与缩放无关
        const legacyRatios = [];
        for (const scale of [0.5, 2, 1, 3, 1]) {
            await page.evaluate(scale => updateZoom(scale), scale);
            await page.waitForTimeout(600);
            const legacy = await snap('legacy-tiny');
            legacyRatios.push(`${legacy.ratioW.toFixed(3)}/${legacy.ratioH.toFixed(3)}`);
        }
        assert.equal(new Set(legacyRatios).size, 1, legacyRatios.join(' '));
        pass('历史极小尺寸的文本框同样不会随缩放忽大忽小');

        // 反向拖动可缩小
        const before = await boxRect('fixed-box', -6, -6);
        await page.mouse.move(before.x, before.y);
        await page.waitForTimeout(60);
        await page.mouse.down();
        await page.mouse.move(before.right - 60, before.bottom - 40, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(400);
        const shrunk = await snap('fixed-box');
        assert.ok(shrunk.visualW < before.w - 40 && shrunk.visualH < before.h - 25);
        assert.ok(Math.abs(shrunk.ratioW - shrunk.annoW) < 0.002 && Math.abs(shrunk.ratioH - shrunk.annoH) < 0.002);
        pass('反向拖动右下角可缩小文本框');

        // 缩放动作进入撤销栈
        await page.evaluate(() => undo());
        await page.waitForTimeout(300);
        const undone = await snap('fixed-box');
        assert.ok(undone.annoW === grown.annoW && undone.annoH === grown.annoH);
        assert.ok(Math.abs(undone.ratioW - undone.annoW) < 0.002 && Math.abs(undone.ratioH - undone.annoH) < 0.002);
        pass('撤销可回退文本框缩放，回退后屏幕与数据仍一致');

        // 按住中部仍然是"移动"，不能被缩放手势抢走
        const mid = await boxRect('fixed-box');
        const beforeMove = await snap('fixed-box');
        const beforeXY = await page.evaluate(() => { const a = state.annotations[1].find(x => x.id === 'fixed-box'); return { x: a.x, y: a.y }; });
        await page.mouse.move(mid.left + 10, mid.top + 8);
        await page.mouse.down();
        await page.mouse.move(mid.left + 40, mid.top + 28, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(400);
        const afterMove = await page.evaluate(() => { const a = state.annotations[1].find(x => x.id === 'fixed-box'); return { x: a.x, y: a.y, w: a.width, textCount: (state.annotations[1] || []).filter(x => x.type === 'text').length }; });
        assert.ok(afterMove.x > beforeXY.x + 0.01 && afterMove.y > beforeXY.y + 0.005);
        assert.equal(afterMove.w, beforeMove.annoW);
        assert.equal(afterMove.textCount, 4);
        pass('按住中部拖动仍是移动位置，不会误改尺寸或新建批注');

        // 点击中部仍打开编辑弹窗
        const centerBox = await boxRect('fixed-box');
        await page.mouse.click(centerBox.left + 12, centerBox.top + 10);
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => !document.getElementById('note-modal').classList.contains('hidden')), true);
        await page.evaluate(() => document.getElementById('save-note-btn').click());
        await page.waitForTimeout(200);
        pass('点击中部仍可打开文本块编辑弹窗');
        await page.evaluate(() => document.getElementById('close-note-btn').click());
        await page.waitForTimeout(150);

        // 角落里的普通单击：尺寸不变、不新建批注、弹窗状态不变
        const quietBefore = await snap('fixed-box');
        const quietCorner = await boxRect('fixed-box', -5, -5);
        await page.mouse.click(quietCorner.x, quietCorner.y);
        await page.waitForTimeout(250);
        const quietAfter = await snap('fixed-box');
        assert.equal(quietAfter.annoW, quietBefore.annoW);
        assert.equal(quietAfter.annoH, quietBefore.annoH);
        assert.equal(quietAfter.textCount, quietBefore.textCount);
        assert.equal(quietAfter.modalHidden, quietBefore.modalHidden);
        pass('角落单击既不缩放也不误开弹窗、不误建批注');

        // 缩到下限并被拖过头：指针会留在框内（且已离开 16px 角落区），松手也不能弹出编辑弹窗。
        // 最小尺寸直接问应用，避免测试里写死一份会漂移的常量。
        await page.evaluate(() => updateZoom(2));
        await page.waitForTimeout(650);
        const start = await boxRect('fixed-box', -6, -6);
        const minimum = await page.evaluate(() => textResizeMinimum(document.querySelector('.text-annotation[data-id="fixed-box"]')));
        const stuck = 19;   // 比 16px 角落区多进去一点，确保松手点落在框内而不是角落判定区
        const overshootX = start.w - minimum.width + stuck;
        const overshootY = start.h - minimum.height + minimum.height / 2;
        const releaseAt = { x: start.right - overshootX, y: start.bottom - overshootY };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(releaseAt.x, releaseAt.y, { steps: 14 });
        await page.mouse.up();
        await page.waitForTimeout(300);
        const clamped = await snap('fixed-box');
        const releaseTarget = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className || '', [releaseAt.x, releaseAt.y]);
        assert.ok(String(releaseTarget).includes('text-annotation'), `release point should stay inside the box (got ${releaseTarget})`);
        assert.equal(clamped.modalHidden, true);
        assert.ok(Math.abs(clamped.ratioW - clamped.annoW) < 0.002 && Math.abs(clamped.ratioH - clamped.annoH) < 0.002, `clamped ratio ${clamped.ratioW}/${clamped.annoW} ${clamped.ratioH}/${clamped.annoH}`);
        pass('拖到最小尺寸并拖过头时，松手不会误开编辑弹窗，尺寸也不会被内边距撑回去');
        await page.evaluate(() => updateZoom(1));
        await page.waitForTimeout(650);

        // 给批注层人为加一个 1.5 倍临时 transform（等价于缩放后 300ms 保护窗口内的状态），
        // 验证手势按"视觉位移 / 视觉比例"换算：屏幕拖 30px 应只等于画布 20px。
        await page.evaluate(() => scrollPdfPageIntoView(1, 'start'));
        await page.waitForTimeout(400);
        const transformed = await page.evaluate(() => {
            const div = document.querySelector('.text-annotation[data-id="transform-box"]');
            const layer = div.closest('.annotation-layer');
            layer.style.transform = 'scale(1.5)';
            const rect = div.getBoundingClientRect();
            return {
                scale: textResizeScale(div), layoutW: rect.width / 1.5, layoutH: rect.height / 1.5,
                right: rect.right, bottom: rect.bottom,
                hit: document.elementFromPoint(rect.right - 6, rect.bottom - 6)?.className || 'none',
            };
        });
        assert.ok(Math.abs(transformed.scale - 1.5) < 0.001, `visual scale ${transformed.scale}`);
        assert.ok(String(transformed.hit).includes('text-annotation'), `corner unreachable (${transformed.hit})`);
        await page.mouse.move(transformed.right - 6, transformed.bottom - 6);
        await page.mouse.down();
        const gesture = await page.evaluate(() => state.resizingText ? { scale: state.resizingText.scale, w: state.resizingText.width, h: state.resizingText.height } : null);
        assert.ok(gesture && Math.abs(gesture.scale - 1.5) < 0.001, `gesture scale ${JSON.stringify(gesture)}`);
        await page.mouse.move(transformed.right - 6 + 30, transformed.bottom - 6 + 18, { steps: 8 });
        const midGesture = await page.evaluate(() => ({ w: state.resizingText.width, h: state.resizingText.height }));
        await page.mouse.up();
        await page.waitForTimeout(400);
        assert.ok(Math.abs(midGesture.w - (transformed.layoutW + 30 / 1.5)) < 1, `${midGesture.w} vs ${transformed.layoutW + 20}`);
        assert.ok(Math.abs(midGesture.h - (transformed.layoutH + 18 / 1.5)) < 1, `${midGesture.h} vs ${transformed.layoutH + 12}`);
        const committed = await page.evaluate(() => {
            const a = state.annotations[1].find(x => x.id === 'transform-box');
            const wrapper = document.getElementById('page-wrapper-1');
            return { px: [a.width * parseFloat(wrapper.style.width), a.height * parseFloat(wrapper.style.height)] };
        });
        assert.ok(Math.abs(committed.px[0] - midGesture.w) < 1 && Math.abs(committed.px[1] - midGesture.h) < 1, `${committed.px} vs ${midGesture.w}/${midGesture.h}`);
        await page.evaluate(() => { document.querySelector('.text-annotation[data-id="transform-box"]').closest('.annotation-layer').style.transform = ''; });
        pass('缩放保护窗口内（批注层带临时 transform）拖拽仍按视觉比例精确换算');

        // 出图：角落特写用于人工确认没有拖拉角
        await boxRect('fixed-box', -46, -46);
        const clip = await page.evaluate(() => {
            const r = document.querySelector('.text-annotation[data-id="fixed-box"]').getBoundingClientRect();
            return { x: Math.max(0, r.right - 46), y: Math.max(0, r.bottom - 46), width: 90, height: 90 };
        });
        await page.screenshot({ path: path.join(resultsDir, 'textbox-corner-100.png'), clip });
        await page.screenshot({ path: path.join(resultsDir, 'textbox-page-100.png'), clip: { x: 0, y: 0, width: 1100, height: 800 } });
        await page.evaluate(() => updateZoom(3));
        await page.waitForTimeout(700);
        await boxRect('fixed-box', -46, -46);
        const clipZoom = await page.evaluate(() => {
            const r = document.querySelector('.text-annotation[data-id="fixed-box"]').getBoundingClientRect();
            return { x: Math.max(0, r.right - 46), y: Math.max(0, r.bottom - 46), width: 90, height: 90 };
        });
        await page.screenshot({ path: path.join(resultsDir, 'textbox-corner-300.png'), clip: clipZoom });
        await page.screenshot({ path: path.join(resultsDir, 'textbox-page-300.png'), clip: { x: 0, y: 0, width: 1100, height: 800 } });

        assert.deepEqual(errors, []);
        pass('无未捕获的浏览器错误');
        fs.writeFileSync(path.join(resultsDir, 'textbox.json'), JSON.stringify({ checks, errors, perScale }, null, 2));
        console.log(`\n${checks.length} checks passed`);
    } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
