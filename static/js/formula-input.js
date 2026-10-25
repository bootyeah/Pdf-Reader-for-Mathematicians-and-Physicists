/* 识别插入属于当前笔记；手机配对独立于编辑框的显示生命周期。 */
(() => {
    const modal = els.noteModal, input = els.noteInput;
    // 识别模型由独立 API 管理工具配置；保留 deepseek 作为第二模型的内部标识。
    const ENGINE_KEY = 'pdf_reader_formula_engine';
    let engine = '';
    try { engine = localStorage.getItem(ENGINE_KEY) === 'deepseek' ? 'deepseek' : ''; } catch (_) { engine = ''; }
    const bar = document.createElement('div');
    bar.id = 'formula-input-bar';
    bar.innerHTML = `<div class="formula-mode-group" role="tablist"><button type="button" data-mode="handwriting" title="手写公式识别"><i class="ph ph-pencil-simple text-xs"></i><span>手写</span></button><button type="button" data-mode="image" title="识图/框选公式识别"><i class="ph ph-crop text-xs"></i><span>识图</span></button><button type="button" data-mode="phone" title="手机手写同步识别"><i class="ph ph-device-mobile text-xs"></i><span>手机</span></button></div><button type="button" id="formula-deepseek" aria-pressed="false" title="识别模型"><i class="ph ph-brain text-xs"></i><span>DeepSeek</span></button><button type="button" id="formula-collapse" title="收起公式输入 (Esc)" aria-label="收起公式输入" hidden><i class="ph ph-caret-up text-xs"></i><span>收起</span></button>`;
    input.before(bar);
    const panel = document.createElement('section');
    panel.id = 'formula-input-panel'; panel.hidden = true;
    panel.innerHTML = `
      <div data-formula-pane="handwriting" hidden>
        <canvas id="formula-pad" tabindex="0" aria-label="手写公式画板"></canvas>
        <div class="formula-actions"><button type="button" id="formula-undo" title="撤销一笔 (Ctrl+Z)"><i class="ph ph-arrow-counter-clockwise text-xs"></i><span>撤销一笔</span></button><button type="button" id="formula-clear" title="清空画板"><i class="ph ph-trash text-xs"></i><span>清空</span></button><button type="button" id="formula-pen" aria-pressed="false" title="切换橡皮/画笔"><i class="ph ph-eraser text-xs"></i><span>橡皮</span></button><button type="button" id="formula-hand-recognize" class="formula-primary"><i class="ph ph-sparkle text-xs"></i><span>识别手写</span></button></div>
      </div>
      <div data-formula-pane="image" hidden>
        <div id="formula-image-drop" tabindex="0" role="button" aria-label="选择公式图片"><img id="formula-image" alt="待识别的公式图片" hidden><div id="formula-image-hint"><i class="ph ph-image text-2xl text-blue-500/70 mb-0.5"></i><span>粘贴、拖入图片，或点击选择</span></div></div>
        <input type="file" id="formula-image-file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden>
        <div class="formula-actions"><button type="button" id="formula-crop" title="框选当前 PDF 页面公式"><i class="ph ph-crop text-xs"></i><span>框选 PDF 公式</span></button><button type="button" id="formula-upload"><i class="ph ph-upload-simple text-xs"></i><span>选择图片</span></button><button type="button" id="formula-image-recognize" class="formula-primary" disabled><i class="ph ph-sparkle text-xs"></i><span>识别图片</span></button></div>
      </div>
      <div data-formula-pane="phone" hidden>
        <div class="formula-phone-header"><span id="formula-phone-status" role="status">正在连接…</span><button type="button" id="formula-phone-view" aria-pressed="false" title="查看整张手机画板"><i class="ph ph-corners-out text-xs"></i><span>整张画板</span></button><button type="button" id="formula-phone-pair" aria-expanded="true" aria-controls="formula-phone-pairing"><i class="ph ph-qr-code text-xs"></i><span>二维码</span></button></div>
        <div class="formula-phone-stage">
          <canvas id="formula-phone-pad" aria-label="手机笔迹实时预览"></canvas>
          <div id="formula-phone-pairing"><img id="formula-qr" alt="手机手写配对二维码" hidden><div class="formula-pairing-info"><strong>扫码连接手机</strong><div id="formula-phone-modes" class="phone-connection-modes" role="group" aria-label="手机连接方式"><button type="button" data-connection="lan" aria-pressed="true">同一 Wi-Fi</button><button type="button" data-connection="internet" aria-pressed="false">互联网</button></div><p id="formula-phone-connection-hint" class="phone-connection-hint" role="status">手机与电脑连接同一 Wi-Fi 后扫码</p><button type="button" id="formula-phone-tunnel-retry" hidden>重试连接</button><a id="formula-phone-url" target="_blank" rel="noopener noreferrer">打开手写页</a><button type="button" id="formula-phone-reconnect"><i class="ph ph-arrows-clockwise text-xs"></i><span>重新配对</span></button></div></div>
        </div>
        <div class="formula-actions"><span id="formula-phone-view-hint">笔迹自动放大</span><button type="button" id="formula-phone-clear"><i class="ph ph-trash text-xs"></i><span>清空</span></button><button type="button" id="formula-phone-recognize" class="formula-primary"><i class="ph ph-sparkle text-xs"></i><span>识别手写</span></button></div>
      </div>
      <div id="formula-status" role="status" aria-live="polite"></div>
      <div id="formula-result" hidden><div class="formula-result-main"><div id="formula-preview" aria-live="polite"></div><button type="button" id="formula-code-toggle" aria-expanded="false" aria-controls="formula-code"><i class="ph ph-code text-xs"></i><span>改代码</span></button><button type="button" id="formula-insert" class="formula-primary"><i class="ph ph-check text-xs"></i><span>插入光标处</span></button></div><textarea id="formula-code" rows="2" aria-label="识别后的 LaTeX，可修改" spellcheck="false" hidden></textarea></div>`;
    input.before(panel);
    const $ = id => document.getElementById('formula-' + id);
    let epoch = 0, requestId = 0, controller = null, activeMode = '', expanded = false;
    let target = '', selection = [0, 0], savedSize = null, imageData = '';
    let doc = { w: 900, h: 360, strokes: [] }, stroke = null, eraser = false;
    let phoneResult = '';
    let phoneDoc = null, phoneHasConnected = false, phoneWholeBoard = false;
    let cropOverlay = null, suppressClickUntil = 0;
    const editing = () => !modal.classList.contains('hidden') && state.isEditingNote && !!state.activeAnnotationId;
    const identity = () => `${state.loadToken}:${state.fingerprint}:${state.activePageNum}:${state.activeAnnotationId}`;
    const valid = token => token === epoch && editing() && identity() === target;
    function status(message = '', error = false) { $('status').textContent = message; $('status').classList.toggle('formula-error', error); }
    function remember() { selection = [input.selectionStart, input.selectionEnd]; }
    ['select', 'keyup', 'click', 'input'].forEach(name => input.addEventListener(name, remember));
    function cancelRequest() {
        requestId++; controller?.abort(); controller = null;
        $('hand-recognize').disabled = false;
        $('image-recognize').disabled = !imageData;
    }
    async function api(path, body, signal) {
        let response;
        try {
            response = await fetch('/api/formula/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw new Error('无法连接识别服务，请通过 starter(H).bat 启动阅读器');
        }
        let data;
        try { data = await response.json(); } catch (_) { throw new Error('公式服务尚未就绪，请重启阅读器服务后重试'); }
        if (!response.ok || !data.ok) throw new Error(data.error || '识别失败，请重试');
        return data;
    }
    function updateCodeToggle(show) {
        $('code-toggle').setAttribute('aria-expanded', String(show));
        $('code-toggle').innerHTML = show ? '<i class="ph ph-caret-up text-xs"></i><span>收起代码</span>' : '<i class="ph ph-code text-xs"></i><span>改代码</span>';
    }
    function clearResult() {
        $('result').hidden = true; $('code').value = ''; $('preview').replaceChildren();
        $('code').hidden = true; updateCodeToggle(false);
    }
    function updateResultPreview() {
        const latex = $('code').value;
        $('preview').textContent = latex;
        renderLatex($('preview'));
        $('insert').disabled = !latex.trim();
    }
    function previewResult(latex) {
        $('result').hidden = false; $('code').value = latex;
        updateResultPreview();
    }
    $('code').addEventListener('input', updateResultPreview);
    $('code-toggle').onclick = () => {
        const show = $('code').hidden;
        $('code').hidden = !show;
        updateCodeToggle(show);
        if (show) { $('code').focus({ preventScroll: true }); $('code').scrollIntoView({ block: 'nearest' }); }
    };
    function keepOnScreen() {
        const r = modal.getBoundingClientRect();
        modal.style.left = Math.max(10, Math.min(r.left, innerWidth - r.width - 10)) + 'px';
        modal.style.top = Math.max(10, Math.min(r.top, innerHeight - r.height - 10)) + 'px';
    }
    function fitModal() {
        // 只记折叠前的尺寸；位置始终以用户最后拖动的位置为准。
        if (!savedSize) savedSize = { width: modal.style.width, height: modal.style.height };
        const r = modal.getBoundingClientRect();
        const w = Math.min(Math.max(r.width, 400), innerWidth - 20), h = Math.min(Math.max(r.height, 480), innerHeight - 20);
        modal.style.width = w + 'px'; modal.style.height = h + 'px';
        keepOnScreen();
    }
    function open(mode) {
        if (!editing()) return;
        if (!expanded) { target = identity(); remember(); fitModal(); }
        cancelRequest(); clearResult(); status();
        activeMode = mode; expanded = true; panel.hidden = false; modal.classList.add('formula-expanded');
        $('collapse').hidden = false;
        bar.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
        panel.querySelectorAll('[data-formula-pane]').forEach(p => p.hidden = p.dataset.formulaPane !== mode);
        if (mode === 'handwriting') requestAnimationFrame(() => draw($('pad'), doc));
        if (mode === 'phone') { phoneResult = ''; phone.start(); drawPhone(); }
        else phone.schedule();
    }
    function cancelCrop() {
        if (!cropOverlay) return;
        cropOverlay.remove(); cropOverlay = null; modal.style.visibility = '';
        suppressClickUntil = performance.now() + 400;
    }
    function collapse() {
        epoch++; cancelRequest(); cancelCrop();
        stroke = null; eraser = false; updatePen();
        expanded = false; activeMode = ''; panel.hidden = true; clearResult(); status();
        phone.schedule();
        modal.classList.remove('formula-expanded');
        $('collapse').hidden = true;
        bar.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', 'false'));
        if (savedSize) { Object.assign(modal.style, savedSize); savedSize = null; keepOnScreen(); }
    }
    function reset() {
        collapse(); target = ''; doc = { w: 900, h: 360, strokes: [] };
        imageData = ''; $('image').removeAttribute('src'); $('image').hidden = true;
        $('image-hint').hidden = false; $('image-file').value = '';
    }
    window.FormulaInput = { reset };
    new MutationObserver(() => {
        bar.hidden = !editing();
        if (!editing() && expanded) reset();
    }).observe(modal, { attributes: true, subtree: true, attributeFilter: ['class'] });
    bar.hidden = true;
    bar.addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) expanded && activeMode === b.dataset.mode ? collapse() : open(b.dataset.mode); });
    $('collapse').onclick = collapse;
    // 识别模型开关：手写 / 识图 / 手机三条识别共用，按下即改用 DeepSeek V4.1 Flash。
    function updateEngine() {
        const on = engine === 'deepseek';
        $('deepseek').setAttribute('aria-pressed', String(on));
        $('deepseek').title = on
            ? '正在使用第二模型 · 按下切回默认模型（在 API 管理工具中配置）'
            : '正在使用默认模型 · 按下改用第二模型（在 API 管理工具中配置）';
        $('deepseek').querySelector('span').textContent = '第二模型';
        try { on ? localStorage.setItem(ENGINE_KEY, 'deepseek') : localStorage.removeItem(ENGINE_KEY); } catch (_) {}
    }
    updateEngine();
    $('deepseek').onclick = () => {
        engine = engine === 'deepseek' ? '' : 'deepseek';
        updateEngine();
        status(engine === 'deepseek' ? '已切到第二模型（初始为 DeepSeek）' : '已切回默认模型（初始为 GLM）');
    };
    // 标题拖动与弹窗外点击均不会干扰画板、文件选择与 PDF 框选。
    bar.addEventListener('mousedown', e => e.preventDefault());
    function mapping(canvas, board) {
        const r = canvas.getBoundingClientRect(), s = Math.min(r.width / board.w, r.height / board.h);
        return { r, s, x: (r.width - board.w * s) / 2, y: (r.height - board.h * s) / 2 };
    }
    function draw(canvas, board, view = null) {
        const frame = view || { x: 0, y: 0, w: board.w, h: board.h };
        const { r, s, x, y } = mapping(canvas, frame); if (!r.width || !r.height) return;
        const dpr = devicePixelRatio || 1;
        canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
        const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
        ctx.fillStyle = view ? 'white' : '#f1f5f9'; ctx.fillRect(0, 0, r.width, r.height);
        ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-frame.x, -frame.y);
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, board.w, board.h);
        ctx.beginPath(); ctx.rect(0, 0, board.w, board.h); ctx.clip();
        for (const st of board.strokes || []) {
            if (!st.p?.length) continue;
            ctx.strokeStyle = ctx.fillStyle = st.k === 'eraser' ? 'white' : '#172033';
            ctx.lineWidth = st.w; ctx.lineCap = ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(...st.p[0]);
            for (let i = 1; i < st.p.length; i++) ctx.lineTo(...st.p[i]);
            ctx.stroke();
            ctx.beginPath(); ctx.arc(...st.p[0], st.w / 2, 0, Math.PI * 2); ctx.fill();
        }
    }
    function drawPhone() {
        PhoneHandwriting.draw($('phone-pad'), phoneDoc, phoneWholeBoard);
    }
    function showPairing(show) {
        $('phone-pairing').hidden = !show;
        $('phone-pair').setAttribute('aria-expanded', String(show));
    }
    $('phone-pair').onclick = () => showPairing($('phone-pairing').hidden);
    $('phone-view').onclick = () => {
        phoneWholeBoard = !phoneWholeBoard;
        $('phone-view').setAttribute('aria-pressed', String(phoneWholeBoard));
        $('phone-view').innerHTML = phoneWholeBoard ? '<i class="ph ph-magnifying-glass-plus text-xs"></i><span>放大笔迹</span>' : '<i class="ph ph-corners-out text-xs"></i><span>整张画板</span>';
        $('phone-view').title = phoneWholeBoard ? '按实际笔迹区域放大' : '查看整张手机画板';
        $('phone-view-hint').textContent = phoneWholeBoard ? '显示整张画板' : '笔迹自动放大';
        drawPhone();
    };
    const pad = $('pad');
    function point(e) { const m = mapping(pad, doc); return [Math.max(0, Math.min(doc.w, (e.clientX - m.r.left - m.x) / m.s)), Math.max(0, Math.min(doc.h, (e.clientY - m.r.top - m.y) / m.s))]; }
    pad.addEventListener('pointerdown', e => {
        if (e.button !== 0 || stroke) return; e.preventDefault(); cancelRequest(); clearResult(); status();
        pad.focus({ preventScroll: true });
        if (!doc.strokes.length) { const r = pad.getBoundingClientRect(); doc.w = r.width * 2; doc.h = r.height * 2; }
        stroke = { k: eraser ? 'eraser' : 'pen', w: eraser ? 28 : 5, p: [point(e)], pointer: e.pointerId };
        doc.strokes.push(stroke); pad.setPointerCapture(e.pointerId); draw(pad, doc);
    });
    pad.addEventListener('pointermove', e => {
        if (!stroke || stroke.pointer !== e.pointerId) return;
        const points = e.getCoalescedEvents?.();
        for (const p of (points?.length ? points : [e])) stroke.p.push(point(p));
        draw(pad, doc);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(event, e => { if (stroke?.pointer === e.pointerId) stroke = null; });
    new ResizeObserver(() => { if (activeMode === 'handwriting') draw(pad, doc); }).observe(pad);
    new ResizeObserver(() => { if (activeMode === 'phone') drawPhone(); }).observe($('phone-pad'));
    $('undo').onclick = () => { cancelRequest(); doc.strokes.pop(); clearResult(); draw(pad, doc); };
    $('clear').onclick = () => { cancelRequest(); doc.strokes = []; clearResult(); status(); draw(pad, doc); };
    function updatePen() {
        $('pen').setAttribute('aria-pressed', String(eraser));
        $('pen').innerHTML = eraser ? '<i class="ph ph-pencil-simple text-xs"></i><span>画笔</span>' : '<i class="ph ph-eraser text-xs"></i><span>橡皮</span>';
        $('pen').title = eraser ? '切换为画笔书写' : '切换为橡皮擦除';
    }
    $('pen').onclick = () => { eraser = !eraser; updatePen(); };
    async function recognize(kind) {
        if (kind === 'handwriting' && !doc.strokes.some(s => s.k === 'pen')) return status('先在画板上写下公式', true);
        if (kind === 'image' && !imageData) return status('请先选择或框选一张公式图片', true);
        cancelRequest(); clearResult(); const id = requestId, token = epoch;
        const currentController = controller = new AbortController();
        const timeout = setTimeout(() => currentController.abort(), 135000);
        $('hand-recognize').disabled = $('image-recognize').disabled = true;
        status('正在识别…');
        try {
            const result = await api('recognize', kind === 'image' ? { kind, image: imageData, engine } : { kind, doc, engine }, controller.signal);
            if (!valid(token) || id !== requestId) return;
            if (result.empty || !result.latex) return status(result.error || '未检测到公式，请重试', true);
            previewResult(result.latex); status();
        } catch (error) {
            if (valid(token) && id === requestId) status(error.name === 'AbortError' ? '识别超时，请重试' : error.message, true);
        } finally {
            clearTimeout(timeout);
            if (id === requestId) { controller = null; $('hand-recognize').disabled = false; $('image-recognize').disabled = !imageData; }
        }
    }
    $('hand-recognize').onclick = () => recognize('handwriting');
    $('image-recognize').onclick = () => recognize('image');
    async function useFile(file) {
        if (!file || !/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) return status('请选择 PNG、JPEG、WebP、GIF 或 BMP 图片', true);
        if (file.size > 8 * 1024 * 1024) return status('图片不能超过 8 MB，请裁剪后重试', true);
        open('image'); const token = epoch, id = requestId;
        try {
            const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
            if (valid(token) && id === requestId) setImage(data);
        } catch (e) { if (valid(token)) status(e.message, true); }
    }
    function setImage(data) {
        imageData = data; $('image').src = data; $('image').hidden = false; $('image-hint').hidden = true;
        $('image-recognize').disabled = false; clearResult(); status('图片已就绪，点击“识别图片”');
    }
    $('upload').onclick = () => $('image-file').click();
    $('image-drop').onclick = () => $('image-file').click();
    $('image-drop').onkeydown = e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); $('image-file').click(); } };
    $('image-file').onchange = e => { useFile(e.target.files[0]); e.target.value = ''; };
    modal.addEventListener('paste', e => {
        if (!editing() || e.target === $('code')) return;
        const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'));
        if (item) { e.preventDefault(); useFile(item.getAsFile()); }
    });
    modal.addEventListener('dragover', e => { if (editing() && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } });
    modal.addEventListener('drop', e => {
        if (!editing() || !e.dataTransfer.files.length) return;
        e.preventDefault(); e.stopPropagation(); useFile(e.dataTransfer.files[0]);
    });
    $('insert').onclick = () => {
        if (!valid(epoch)) return;
        let code = $('code').value.trim(); if (!code) return;
        const [start, end] = selection.map(n => Math.min(n, input.value.length));
        // 在已有数学环境中插入时，避免产生 $...$ 内再套 $$...$$。
        const before = input.value.slice(0, start);
        let math = '';
        const re = /\\[\s\S]|\$\$|\$/g; let match;
        while ((match = re.exec(before))) {
            const t = match[0];
            if (['$', '$$', '\\(', '\\['].includes(t)) math = math === t ? '' : (!math ? t : math);
            else if ((t === '\\)' && math === '\\(') || (t === '\\]' && math === '\\[')) math = '';
        }
        if (math && !/\$|\\[)\]]/.test(input.value.slice(start, end))) code = code.replace(/^(\$\$|\$|\\\[|\\\()/, '').replace(/(\$\$|\$|\\\]|\\\))$/, '');
        input.focus(); input.setSelectionRange(start, end); input.setRangeText(code, start, end, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true })); remember();
        collapse(); input.focus();
    };
    function startPhone() {
        phoneHasConnected = false; phoneDoc = null; showPairing(true); drawPhone();
        phoneResult = ''; clearResult();
        $('qr').hidden = true; $('phone-url').removeAttribute('href');
        $('phone-status').dataset.online = 'false';
        $('phone-status').textContent = '正在连接…'; status();
        phone.start(true);
    }
    const phone = new PhoneHandwriting.Session({
        active: () => editing() && expanded && activeMode === 'phone',
        engine: () => engine,
        error: message => { if (editing() && activeMode === 'phone') status(message, true); },
        change: (data, pairing) => {
            const changed = phoneDoc !== data.doc;
            if (data.doc) phoneDoc = data.doc;
            if (!editing() || activeMode !== 'phone') return;
            PhoneHandwriting.renderPairing(phone, pairing, { qr: $('qr'), link: $('phone-url'),
                modes: $('phone-modes'), hint: $('phone-connection-hint'), retry: $('phone-tunnel-retry') });
            $('phone-status').textContent = data.recognizing ? '正在识别…' : data.online ? '手机已连接' : phoneHasConnected ? '手机已离线' : '等待手机扫码';
            $('phone-status').dataset.online = String(!!data.online);
            if (data.online && !phoneHasConnected) { phoneHasConnected = true; showPairing(false); }
            $('phone-recognize').disabled = data.recognizing;
            if (changed) drawPhone();
            if (data.recognizing) { clearResult(); phoneResult = ''; status(); }
            if (data.error) { clearResult(); status(data.error, true); }
            else if (data.result?.latex && JSON.stringify(data.result) !== phoneResult) {
                phoneResult = JSON.stringify(data.result); previewResult(data.result.latex); status();
            }
            else if ($('status').classList.contains('formula-error')) status();
        }
    });
    $('phone-modes').querySelectorAll('[data-connection]').forEach(button => {
        button.onclick = () => phone.setConnection(button.dataset.connection);
    });
    $('phone-tunnel-retry').onclick = () => phone.setConnection('internet', true);
    $('phone-reconnect').onclick = startPhone;
    $('phone-recognize').onclick = () => { clearResult(); phoneResult = ''; phone.action('recognize'); };
    $('phone-clear').onclick = () => { clearResult(); phoneResult = ''; phone.action('clear'); };
    $('crop').onclick = () => {
        if (!state.pdfDoc) return status('请先打开 PDF', true);
        cancelRequest(); clearResult(); modal.style.visibility = 'hidden';
        const overlay = cropOverlay = document.createElement('div'); overlay.id = 'formula-crop-overlay';
        overlay.innerHTML = '<div class="formula-crop-tip">拖动框选 PDF 中的公式 · Esc 取消</div><div class="formula-crop-box" hidden></div>';
        document.body.append(overlay); let start = null, source = null, bounds = null;
        const box = overlay.querySelector('.formula-crop-box');
        overlay.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
        overlay.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            source = Array.from(document.querySelectorAll('canvas[id^="canvas-"]')).find(c => { const r = c.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && c.width > 0; });
            if (!source) { overlay.querySelector('.formula-crop-tip').textContent = '请在已显示的 PDF 页面内框选 · Esc 取消'; return; }
            bounds = source.getBoundingClientRect(); start = { x: e.clientX, y: e.clientY };
            overlay.setPointerCapture(e.pointerId); e.preventDefault();
        });
        function rect(e) {
            const x = Math.max(bounds.left, Math.min(bounds.right, e.clientX)), y = Math.max(bounds.top, Math.min(bounds.bottom, e.clientY));
            return { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) };
        }
        overlay.addEventListener('pointermove', e => {
            if (!start) return; const r = rect(e); box.hidden = false;
            Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        });
        overlay.addEventListener('pointerup', e => {
            if (!start) return; const r = rect(e); start = null;
            if (r.w < 5 || r.h < 5) { box.hidden = true; return; }
            try {
                const sx = source.width / bounds.width, sy = source.height / bounds.height;
                const canvas = document.createElement('canvas'); const scale = Math.min(1, 4096 / Math.max(r.w * sx, r.h * sy));
                canvas.width = Math.max(2, Math.round(r.w * sx * scale)); canvas.height = Math.max(2, Math.round(r.h * sy * scale));
                const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(source, (r.x - bounds.left) * sx, (r.y - bounds.top) * sy, r.w * sx, r.h * sy, 0, 0, canvas.width, canvas.height);
                setImage(canvas.toDataURL('image/png')); cancelCrop();
            } catch (_) { cancelCrop(); status('框选失败，请等待页面显示完成后重试', true); }
        });
        overlay.addEventListener('pointercancel', cancelCrop);
    };
    document.addEventListener('click', e => {
        if (cropOverlay || (performance.now() < suppressClickUntil && !modal.contains(e.target))) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    document.addEventListener('keydown', e => {
        if (e.target.closest?.('#handwriting-whiteboard')) return;
        if (cropOverlay) { e.stopImmediatePropagation(); if (e.key === 'Escape') { e.preventDefault(); cancelCrop(); } return; }
        if (!editing()) return;
        if (expanded && activeMode === 'handwriting' && panel.contains(e.target) && e.target.tagName !== 'TEXTAREA' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault(); e.stopImmediatePropagation(); $('undo').click(); return;
        }
        if (e.key === 'Escape' && expanded) { e.preventDefault(); e.stopImmediatePropagation(); collapse(); input.focus(); }
    }, true);
})();
