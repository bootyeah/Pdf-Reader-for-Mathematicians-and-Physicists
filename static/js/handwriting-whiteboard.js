/* 独立手写草稿白板：窗口隐藏/折叠不结束手机会话。 */
(() => {
    const MIN_W = 280, MIN_H = 200;
    let panel, phone, board = null, whole = false, connected = false, collapsed = false, pureMode = false;
    let engine = '', resultKey = '', expandedHeight = 620, phonePageId = '';
    const KEY = 'pdf_reader_handwriting_whiteboard';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}
    engine = saved.engine === 'deepseek' ? 'deepseek' : '';
    const $ = id => document.getElementById('whiteboard-' + id);
    function updateResponsive(width) {
        if (!panel) return;
        const w = width ?? panel.getBoundingClientRect().width;
        panel.classList.toggle('wb-compact', w <= 580);
        panel.classList.toggle('wb-narrow', w <= 420);
        panel.classList.toggle('wb-ultra-compact', w <= 320);
    }
    function updateRecognizeButton(isRecognizing = false) {
        const btn = $('recognize');
        if (!btn) return;
        btn.disabled = isRecognizing;
        btn.innerHTML = isRecognizing
            ? `<i class="ph ph-spinner ph-spin"></i><span class="wb-btn-label"><span class="wb-label-full">正在识别…</span><span class="wb-label-short">识别中…</span></span>`
            : `<i class="ph ph-sparkle"></i><span class="wb-btn-label"><span class="wb-label-full">识别 LaTeX 段落</span><span class="wb-label-short">识别段落</span></span>`;
    }
    function status(message = '', type = 'info') {
        const el = $('status');
        if (!message) { el.textContent = ''; el.className = ''; return; }
        el.className = 'wb-status-toast ' + type;
        const iconName = type === 'error' ? 'ph-warning-circle' : type === 'success' ? 'ph-check-circle' : type === 'loading' ? 'ph-spinner ph-spin' : 'ph-info';
        const icon = document.createElement('i');
        icon.className = `ph ${iconName}`;
        const span = document.createElement('span');
        span.textContent = String(message);
        el.replaceChildren(icon, span);
    }
    function save() {
        const r = panel.getBoundingClientRect();
        try { localStorage.setItem(KEY, JSON.stringify({ x: r.x, y: r.y, w: r.width,
            h: collapsed ? expandedHeight : r.height, engine })); } catch (_) {}
    }
    function clamp() {
        const r = panel.getBoundingClientRect();
        const maxH = innerHeight - 88;
        const w = Math.max(Math.min(MIN_W, innerWidth - 16), Math.min(r.width, innerWidth - 16));
        const h = collapsed ? 42 : Math.max(Math.min(MIN_H, maxH), Math.min(r.height, maxH));
        if (!collapsed && h < expandedHeight) expandedHeight = Math.max(MIN_H, h);
        Object.assign(panel.style, { width: w + 'px', height: h + 'px',
            left: Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px',
            top: Math.max(0, Math.min(r.top, innerHeight - h - 8)) + 'px' });
        updateResponsive(w);
    }
    function updateEmptyState() {
        const strokes = board?.strokes?.length || 0;
        const emptyHint = $('empty-hint');
        if (emptyHint) emptyHint.style.display = strokes > 0 ? 'none' : 'flex';
    }
    function draw() {
        if (!panel.hidden && !collapsed) {
            PhoneHandwriting.draw($('pad'), board, whole, 6);
            updateEmptyState();
        }
    }
    function pairing(show) {
        $('pairing').hidden = !show;
        $('pair').setAttribute('aria-expanded', String(show));
        $('pair').classList.toggle('active', show);
    }
    function showResult(show) {
        const available = !!$('code').value.trim();
        $('result').hidden = !show || !available;
        $('result-toggle').hidden = !available;
        $('result-toggle').setAttribute('aria-expanded', String(!$('result').hidden));
        $('result-toggle').classList.toggle('active', !$('result').hidden);
        $('result-toggle').innerHTML = `<i class="ph ${$('result').hidden ? 'ph-file-text' : 'ph-caret-up'}"></i><span>${$('result').hidden ? '查看结果' : '收起结果'}</span>`;
        if (available && show) {
            const charCount = $('char-count');
            if (charCount) charCount.textContent = $('code').value.length + ' 字符';
        }
        if ($('result').hidden && !$('status').classList.contains('error')) status();
    }
    function setCodeVisible(visible) {
        const code = $('code');
        const toggleBtn = $('code-toggle');
        const codeBar = $('code-bar');
        if (!code) return;
        code.hidden = !visible;
        if (toggleBtn) {
            toggleBtn.setAttribute('aria-expanded', String(visible));
            toggleBtn.classList.toggle('active', visible);
            toggleBtn.innerHTML = `<i class="ph ph-code"></i><span>${visible ? '收起代码' : '展开代码'}</span>`;
        }
        if (codeBar) {
            codeBar.setAttribute('aria-expanded', String(visible));
            codeBar.classList.toggle('expanded', visible);
            const label = codeBar.querySelector('.wb-code-bar-label');
            if (label) label.textContent = visible ? '收起原始 LaTeX 代码' : '展开原始 LaTeX 代码';
            const caret = codeBar.querySelector('.wb-code-bar-caret');
            if (caret) caret.className = `ph ph-caret-${visible ? 'up' : 'down'} wb-code-bar-caret`;
        }
    }
    function clearResult() {
        resultKey = ''; $('code').value = ''; $('preview').replaceChildren();
        setCodeVisible(false);
        showResult(false);
    }
    function preview() {
        $('preview').textContent = $('code').value; renderLatex($('preview'));
        const charCount = $('char-count');
        if (charCount) charCount.textContent = $('code').value.length + ' 字符';
    }
    function updateEngine() {
        const isDeepSeek = engine === 'deepseek';
        $('engine').setAttribute('aria-pressed', String(isDeepSeek));
        $('engine').classList.toggle('active', isDeepSeek);
        $('engine-label').textContent = isDeepSeek ? '第二模型' : '默认模型';
        $('engine').title = isDeepSeek ? '正在使用第二模型（DeepSeek）· 点击切回默认模型' : '正在使用默认模型（GLM）· 点击切换至第二模型';
    }
    function setPureMode(enabled) {
        pureMode = !!enabled;
        if (!panel) return;
        // 折叠时展示普通标题栏，但保留纯白板模式的选择。
        panel.classList.toggle('wb-pure-mode', pureMode && !collapsed);
        const btn = $('pure');
        if (btn) {
            btn.setAttribute('aria-pressed', String(pureMode));
            btn.title = pureMode ? '退出纯白板模式 (Esc 或再次点击)' : '纯白板模式 (隐藏标题与工具栏)';
            btn.setAttribute('aria-label', pureMode ? '退出纯白板模式' : '纯白板模式');
            btn.innerHTML = `<i class="ph ph-${pureMode ? 'app-window' : 'chalkboard'}"></i>`;
        }
        if (pureMode) {
            pairing(false);
            showResult(false);
        }
        clamp();
        draw();
    }
    function hide() {
        if (!panel) return;
        save(); panel.hidden = true;
        phone.schedule();
        setPureMode(false);
        if (state.currentTool === 'whiteboard') { state.currentTool = 'cursor'; updateToolButtons(); }
    }
    function toggleCollapsed() {
        if (!panel || panel.hidden) return;
        if (!collapsed) expandedHeight = panel.getBoundingClientRect().height;
        collapsed = !collapsed; panel.classList.toggle('collapsed', collapsed);
        panel.classList.toggle('wb-pure-mode', pureMode && !collapsed);
        panel.style.height = (collapsed ? 42 : expandedHeight) + 'px';
        $('collapse').setAttribute('aria-expanded', String(!collapsed));
        $('collapse').title = collapsed ? '展开白板 (V)' : '折叠为标题栏 (V，保持手机连接)';
        $('collapse').setAttribute('aria-label', collapsed ? '展开白板' : '折叠白板');
        $('collapse').innerHTML = `<i class="ph ph-caret-${collapsed ? 'down' : 'up'}" aria-hidden="true"></i>`;
        const scBtn = $('shortcut-btn');
        if (scBtn) {
            const act = scBtn.querySelector('.ws-action');
            if (act) act.textContent = collapsed ? '展开' : '折叠';
            scBtn.title = (collapsed ? '展开白板' : '折叠为标题栏') + ' (快捷键: V)';
            scBtn.setAttribute('aria-label', (collapsed ? '展开白板' : '折叠白板') + ' (V)');
        }
        clamp(); draw(); save();
        if (collapsed) phone.schedule(); else phone.start();
    }
    // 白板显示时按 V 折叠/展开；输入文字、组合快捷键和长按不受影响。
    document.addEventListener('keydown', e => {
        if (!panel || panel.hidden || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.code !== 'KeyV' && e.key.toLowerCase() !== 'v') return;
        const isEditing = el => el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
        if (isEditing(e.target) || isEditing(document.activeElement)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) toggleCollapsed();
    }, true);
    function ensure() {
        if (panel) return;
        panel = document.createElement('section'); panel.id = 'handwriting-whiteboard'; panel.hidden = true;
        panel.setAttribute('aria-label', '手写草稿白板');
        panel.innerHTML = `
          <div id="whiteboard-header">
            <div class="wb-header-brand">
              <div class="wb-brand-icon"><i class="ph ph-chalkboard-simple"></i></div>
              <strong>手写草稿白板</strong>
              <button type="button" id="whiteboard-shortcut-btn" class="window-shortcut-btn wb-shortcut-btn" title="折叠为标题栏 (快捷键: V)" aria-label="折叠白板 (V)">
                <span class="ws-action">折叠</span>
                <kbd class="ws-key">V</kbd>
              </button>
            </div>
            <div id="whiteboard-connection" class="wb-status-badge" data-online="false" role="status">
              <span class="wb-status-dot"></span>
              <span class="wb-status-text">等待手机扫码</span>
            </div>
            <div class="wb-header-actions">
              <button type="button" id="whiteboard-pure" class="wb-hbtn" title="纯白板模式 (隐藏标题与工具栏)" aria-label="纯白板模式" aria-pressed="false"><i class="ph ph-chalkboard"></i></button>
              <button type="button" id="whiteboard-collapse" class="wb-hbtn" title="折叠为标题栏 (V，保持手机连接)" aria-label="折叠白板" aria-expanded="true" aria-controls="whiteboard-body"><i class="ph ph-caret-up"></i></button>
              <button type="button" id="whiteboard-close" class="wb-hbtn wb-hbtn-close" title="隐藏白板 (保留连接和草稿)" aria-label="隐藏白板"><i class="ph ph-x"></i></button>
            </div>
          </div>
          <div id="whiteboard-body">
            <div id="whiteboard-actions">
              <div class="wb-action-group">
                <button type="button" id="whiteboard-pair" class="wb-tool-btn" aria-expanded="true" title="显示/收起手机配对二维码"><i class="ph ph-qr-code"></i><span>手机连接</span></button>
                <button type="button" id="whiteboard-view" class="wb-tool-btn" aria-pressed="false" title="切换画板视角 (整张画板 / 贴合笔迹)"><i class="ph ph-arrows-out-simple"></i><span>整张画板</span></button>
                <button type="button" id="whiteboard-copy-image" class="wb-tool-btn" title="以适当大小复制充满内容的画板图片到剪贴板 (Ctrl+C)"><i class="ph ph-copy"></i><span>复制图片</span></button>
                <button type="button" id="whiteboard-clear" class="wb-tool-btn wb-btn-danger" title="清空画板笔迹"><i class="ph ph-trash"></i><span>清空笔迹</span></button>
              </div>
              <div class="wb-action-divider"></div>
              <div class="wb-action-group">
                <button type="button" id="whiteboard-engine" class="wb-tool-btn wb-engine-btn" aria-pressed="false" title="切换识别模型"><i class="ph ph-cpu"></i><span id="whiteboard-engine-label">默认模型</span></button>
              </div>
              <div class="wb-action-spacer"></div>
              <div class="wb-action-group">
                <button type="button" id="whiteboard-result-toggle" class="wb-tool-btn wb-btn-result" aria-expanded="false" aria-controls="whiteboard-result" hidden title="展开/收起上次识别结果"><i class="ph ph-file-text"></i><span>查看结果</span></button>
                <button type="button" id="whiteboard-recognize" class="wb-primary-btn" title="识别手写草稿为 LaTeX 段落 (Ctrl+Enter)"><i class="ph ph-sparkle"></i><span class="wb-btn-label"><span class="wb-label-full">识别 LaTeX 段落</span><span class="wb-label-short">识别段落</span></span></button>
              </div>
            </div>
            <div id="whiteboard-stage">
              <canvas id="whiteboard-pad" aria-label="手机手写草稿实时预览"></canvas>
              <div id="whiteboard-empty-hint" class="wb-empty-hint">
                <div class="wb-empty-icon"><i class="ph ph-pencil-simple-line"></i></div>
                <div class="wb-empty-title">在手机上自由书写文字、公式或推导草稿</div>
              </div>
              <div id="whiteboard-pairing">
                <div class="wb-pairing-card">
                  <button type="button" id="whiteboard-pairing-close" class="wb-pairing-close" title="收起二维码"><i class="ph ph-x"></i></button>
                  <div class="wb-qr-wrapper">
                    <img id="whiteboard-qr" alt="白板手机配对二维码" hidden>
                    <div id="whiteboard-qr-placeholder" class="wb-qr-loading"><i class="ph ph-spinner ph-spin"></i><span>生成配对码…</span></div>
                  </div>
                  <div class="wb-pairing-info">
                    <div class="wb-pairing-title">扫码连接手机手写板</div>
                    <div id="whiteboard-phone-modes" class="phone-connection-modes" role="group" aria-label="手机连接方式"><button type="button" data-connection="lan" aria-pressed="true">同一 Wi-Fi</button><button type="button" data-connection="internet" aria-pressed="false">互联网</button></div>
                    <div class="wb-pairing-steps">
                      <div class="wb-step-item"><span class="wb-step-badge">1</span><span id="whiteboard-connection-hint" class="phone-connection-hint" role="status">手机与电脑连接同一 Wi-Fi 后扫码</span></div>
                      <div class="wb-step-item"><span class="wb-step-badge">2</span><span>手机相机或浏览器扫码直接手写</span></div>
                    </div>
                    <button type="button" id="whiteboard-tunnel-retry" class="wb-reconnect-btn" hidden>重试连接</button>
                    <div class="wb-pairing-actions">
                      <a id="whiteboard-url" target="_blank" rel="noopener noreferrer" class="wb-url-btn" title="在手机或新标签页中打开"><i class="ph ph-arrow-square-out"></i><span>直接打开网页</span></a>
                      <button type="button" id="whiteboard-reconnect" class="wb-reconnect-btn" title="重置配对会话"><i class="ph ph-arrows-clockwise"></i><span>重新配对</span></button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div id="whiteboard-status" role="status" aria-live="polite"></div>
            <div id="whiteboard-result" hidden>
              <div class="whiteboard-result-header">
                <div class="wb-result-title-wrap">
                  <span class="wb-result-badge"><i class="ph ph-sparkle"></i> LaTeX 段落</span>
                  <span id="whiteboard-char-count" class="wb-char-count"></span>
                </div>
                <div class="wb-result-actions">
                  <button type="button" id="whiteboard-code-toggle" class="wb-res-btn" aria-expanded="false" title="展开/收起原始代码"><i class="ph ph-code"></i><span>展开代码</span></button>
                  <button type="button" id="whiteboard-copy" class="wb-res-btn wb-res-btn-copy" title="复制 LaTeX 代码到剪贴板"><i class="ph ph-copy"></i><span>复制代码</span></button>
                  <button type="button" id="whiteboard-stamp" class="wb-res-btn wb-res-btn-stamp" title="拍入页面 (直接作为文本块插入当前页面)" aria-label="拍入页面"><i class="ph ph-hand-palm text-[15px]"></i></button>
                  <button type="button" id="whiteboard-result-hide" class="wb-res-btn" title="收起结果面板，返回白板"><i class="ph ph-caret-down"></i><span>收起面板</span></button>
                </div>
              </div>
              <div id="whiteboard-preview" class="wb-preview-box"></div>
              <div id="whiteboard-code-bar" class="wb-code-toggle-bar" role="button" tabindex="0" aria-expanded="false" title="点击展开/收起原始 LaTeX 代码">
                <i class="ph ph-code"></i>
                <span class="wb-code-bar-label">展开原始 LaTeX 代码</span>
                <i class="ph ph-caret-down wb-code-bar-caret"></i>
              </div>
              <textarea id="whiteboard-code" class="wb-code-area" aria-label="草稿段落 LaTeX 代码" spellcheck="false" placeholder="识别的 LaTeX 段落代码将显示在这里…" hidden></textarea>
            </div>
          </div>
          ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => `<div class="whiteboard-resize" data-edge="${edge}"></div>`).join('')}
          <div class="whiteboard-resize-grip" title="拖拽调整尺寸"><svg viewBox="0 0 16 16"><line x1="14" y1="2" x2="2" y2="14"/><line x1="14" y1="7" x2="7" y2="14"/><line x1="14" y1="12" x2="12" y2="14"/></svg></div>`;
        document.body.append(panel);
        Object.assign(panel.style, { width: (Number(saved.w) || 840) + 'px', height: (Number(saved.h) || 620) + 'px',
            left: (saved.x === 0 ? 0 : (Number(saved.x) || Math.max(16, (innerWidth - 840) / 2))) + 'px', top: (saved.y === 0 ? 0 : (Number(saved.y) || 110)) + 'px' });
        updateResponsive(panel.getBoundingClientRect().width);
        phone = new PhoneHandwriting.Session({ purpose: 'whiteboard', engine: () => engine,
            active: () => !panel.hidden && !collapsed,
            error: message => {
                const connText = $('connection')?.querySelector('.wb-status-text');
                if (connText) connText.textContent = '连接待恢复';
                status(message, 'error');
            },
            change: (data, info) => {
                if (data.pageId !== undefined && data.pageId !== phonePageId) {
                    phonePageId = data.pageId;
                    clearResult(); status();
                }
                PhoneHandwriting.renderPairing(phone, info, { qr: $('qr'), link: $('url'),
                    modes: $('phone-modes'), hint: $('connection-hint'), retry: $('tunnel-retry'),
                    placeholder: $('qr-placeholder') });
                const connText = $('connection')?.querySelector('.wb-status-text');
                if (connText) {
                    const text = data.recognizing ? '正在识别…' : data.online ? '手机已连接' : connected ? '等待手机重连' : '等待手机扫码';
                    connText.textContent = text;
                    if ($('connection')) $('connection').title = text;
                }
                $('connection').dataset.online = String(!!data.online);
                if (data.online && !connected) { connected = true; pairing(false); }
                const isRecognizing = !!data.recognizing;
                updateRecognizeButton(isRecognizing);
                if (data.doc && data.doc !== board) { board = data.doc; draw(); }
                if (data.recognizing) { clearResult(); status('正在识别文字和公式…', 'loading'); }
                else if (data.error) status(data.error, 'error');
                else {
                    if ($('status').classList.contains('error') || $('status').textContent.includes('正在识别文字和公式')) status();
                    if (data.result?.latex && JSON.stringify(data.result) !== resultKey) {
                        resultKey = JSON.stringify(data.result);
                        $('code').value = data.result.latex;
                        preview();
                        setCodeVisible(false);
                        showResult(true);
                    }
                }
            }
        });
        $('phone-modes').querySelectorAll('[data-connection]').forEach(button => {
            button.onclick = () => phone.setConnection(button.dataset.connection);
        });
        $('tunnel-retry').onclick = () => phone.setConnection('internet', true);
        $('close').onclick = hide;
        $('pure').onclick = () => setPureMode(!pureMode);
        $('collapse').onclick = toggleCollapsed;
        if ($('shortcut-btn')) $('shortcut-btn').onclick = (e) => { e.stopPropagation(); toggleCollapsed(); };
        $('pair').onclick = () => pairing($('pairing').hidden);
        $('pairing-close').onclick = () => pairing(false);
        $('pairing').onclick = e => { if (e.target === $('pairing')) pairing(false); };
        $('view').onclick = () => {
            whole = !whole; $('view').setAttribute('aria-pressed', String(whole));
            $('view').classList.toggle('active', whole);
            $('view').innerHTML = `<i class="ph ph-${whole ? 'selection' : 'arrows-out-simple'}"></i><span>${whole ? '适中笔迹' : '整张画板'}</span>`;
            draw();
        };
        $('reconnect').onclick = () => {
            connected = false; board = null; clearResult(); pairing(true); draw(); status();
            $('qr').hidden = true;
            const ph = $('qr-placeholder'); if (ph) ph.hidden = false;
            $('url').removeAttribute('href'); phone.start(true);
        };
        $('engine').onclick = () => { engine = engine ? '' : 'deepseek'; updateEngine(); save(); };
        updateEngine();
        let copyImageTimer = null;
        const copyBoardImage = async () => {
            try {
                const res = await PhoneHandwriting.copyBoardImage(board);
                if (res?.empty) {
                    status(res.error || '画板暂无手写笔迹可复制', 'info');
                    setTimeout(() => { if ($('status').textContent.includes('暂无手写笔迹')) status(); }, 2000);
                    return;
                }
                const btn = $('copy-image');
                if (btn) {
                    clearTimeout(copyImageTimer);
                    btn.innerHTML = `<i class="ph ph-check text-green-600"></i><span style="color:#16a34a">已复制!</span>`;
                    btn.classList.add('copied');
                    copyImageTimer = setTimeout(() => {
                        btn.innerHTML = `<i class="ph ph-copy"></i><span>复制图片</span>`;
                        btn.classList.remove('copied');
                    }, 1600);
                }
                status('已复制充满状态的画板图片到剪贴板', 'success');
                setTimeout(() => { if ($('status').textContent.includes('已复制充满状态')) status(); }, 2500);
            } catch (err) {
                status('复制图片失败: ' + (err?.message || '剪贴板访问受限'), 'error');
            }
        };
        $('copy-image').onclick = copyBoardImage;
        $('clear').onclick = () => { clearResult(); status(); phone.action('clear'); };
        $('recognize').onclick = () => {
            if ($('recognize').disabled) return;
            clearResult(); status(); phone.action('recognize');
        };
        $('result-hide').onclick = () => showResult(false);
        $('result-toggle').onclick = () => showResult($('result').hidden);
        $('code').oninput = preview;
        $('code-toggle').onclick = () => setCodeVisible($('code').hidden);
        const codeBar = $('code-bar');
        if (codeBar) {
            codeBar.onclick = () => setCodeVisible($('code').hidden);
            codeBar.onkeydown = e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setCodeVisible($('code').hidden);
                }
            };
        }
        $('url').onclick = e => { if (!$('url').getAttribute('href')) e.preventDefault(); };
        let copyTimer = null;
        $('copy').onclick = async () => {
            try {
                const code = $('code').value;
                if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
                else {
                    const field = document.createElement('textarea'); field.value = code; panel.append(field); field.select();
                    const copied = document.execCommand('copy'); field.remove(); if (!copied) throw new Error();
                }
                const btn = $('copy');
                clearTimeout(copyTimer);
                btn.innerHTML = `<i class="ph ph-check text-green-600"></i><span style="color:#16a34a">已复制!</span>`;
                btn.classList.add('copied');
                copyTimer = setTimeout(() => {
                    btn.innerHTML = `<i class="ph ph-copy"></i><span>复制代码</span>`;
                    btn.classList.remove('copied');
                }, 1600);
                status('已复制 LaTeX 段落', 'success');
                setTimeout(() => { if ($('status').textContent.includes('已复制')) status(); }, 2500);
            } catch (_) { status('复制失败，请展开代码后手动选中复制', 'error'); }
        };
        let stampTimer = null;
        const stampRecognizedContent = () => {
            const code = $('code')?.value?.trim();
            if (!code) {
                status('暂无可拍入页面的识别内容', 'info');
                setTimeout(() => { if ($('status').textContent.includes('暂无可拍入')) status(); }, 2000);
                return;
            }
            const currentState = typeof state !== 'undefined' ? state : window.state;
            if (!currentState?.pdfDoc) {
                status('请先在主阅读器中打开 PDF 文档', 'error');
                setTimeout(() => { if ($('status').textContent.includes('请先在主阅读器')) status(); }, 2500);
                return;
            }

            const targetPageNum = (currentState.currentPhysicalPage > 0 && currentState.currentPhysicalPage <= currentState.pdfDoc.numPages)
                ? currentState.currentPhysicalPage
                : (currentState.activePageNum || 1);

            let relX = 0.15, relY = 0.2;
            const wrapper = document.getElementById('page-wrapper-' + targetPageNum) ||
                document.querySelector(`.page-wrapper[data-page-num="${targetPageNum}"]`);
            const container = typeof els !== 'undefined' ? els.container : document.getElementById('viewer-container');
            if (wrapper && container) {
                const wrapperRect = wrapper.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                const visibleTop = Math.max(wrapperRect.top, containerRect.top);
                const visibleBottom = Math.min(wrapperRect.bottom, containerRect.bottom);
                const visibleLeft = Math.max(wrapperRect.left, containerRect.left);
                const visibleRight = Math.min(wrapperRect.right, containerRect.right);

                if (visibleRight > visibleLeft && visibleBottom > visibleTop) {
                    const centerX = (visibleLeft + visibleRight) / 2;
                    const centerY = (visibleTop + visibleBottom) / 2;
                    relX = (centerX - wrapperRect.left) / wrapperRect.width;
                    relY = (centerY - wrapperRect.top) / wrapperRect.height;
                    relX = Math.max(0.05, Math.min(0.80, relX - 0.05));
                    relY = Math.max(0.05, Math.min(0.80, relY - 0.02));
                }
            }

            const makeId = typeof nextAnnotationId === 'function' ? nextAnnotationId : () => Date.now().toString();
            if (typeof performAction === 'function') {
                performAction(() => {
                    if (!currentState.annotations[targetPageNum]) currentState.annotations[targetPageNum] = [];
                    currentState.annotations[targetPageNum].push({
                        id: makeId(),
                        type: 'text',
                        color: currentState.currentColor || '#fde047',
                        x: relX,
                        y: relY,
                        text: code,
                        timestamp: new Date().toLocaleString()
                    });
                }, [targetPageNum]);
            } else {
                if (!currentState.annotations[targetPageNum]) currentState.annotations[targetPageNum] = [];
                currentState.annotations[targetPageNum].push({
                    id: makeId(),
                    type: 'text',
                    color: currentState.currentColor || '#fde047',
                    x: relX,
                    y: relY,
                    text: code,
                    timestamp: new Date().toLocaleString()
                });
                if (typeof saveAnnotationsToStorage === 'function') saveAnnotationsToStorage();
                if (typeof refreshUI === 'function') refreshUI([targetPageNum]);
            }

            if (wrapper) {
                wrapper.style.transition = 'filter 0.3s ease';
                wrapper.style.filter = 'brightness(0.92) contrast(1.08)';
                setTimeout(() => { wrapper.style.filter = ''; }, 300);
            }

            const btn = $('stamp');
            if (btn) {
                clearTimeout(stampTimer);
                btn.innerHTML = `<i class="ph ph-check text-green-600 text-[15px]"></i>`;
                btn.classList.add('copied');
                stampTimer = setTimeout(() => {
                    btn.innerHTML = `<i class="ph ph-hand-palm text-[15px]"></i>`;
                    btn.classList.remove('copied');
                }, 1600);
            }

            status(`已将识别内容拍入第 ${targetPageNum} 页`, 'success');
            setTimeout(() => { if ($('status').textContent.includes('已将识别内容拍入')) status(); }, 2500);
        };
        $('stamp').onclick = stampRecognizedContent;
        let gesture = null;
        panel.addEventListener('pointerdown', e => {
            const edge = e.target.closest('[data-edge]')?.dataset.edge;
            const isGrip = !!e.target.closest('.whiteboard-resize-grip');
            if (e.button !== 0 || (!edge && !isGrip && (!e.target.closest('#whiteboard-header') || e.target.closest('button')))) return;
            gesture = { edge: edge || (isGrip ? 'se' : null), x: e.clientX, y: e.clientY, r: panel.getBoundingClientRect(), pointer: e.pointerId };
            panel.setPointerCapture(e.pointerId); e.preventDefault();
        });
        panel.addEventListener('pointermove', e => {
            if (!gesture || gesture.pointer !== e.pointerId) return;
            const { edge, r, x, y } = gesture, dx = e.clientX - x, dy = e.clientY - y;
            let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
            if (!edge) { left += dx; top += dy; }
            else {
                const minW = Math.min(MIN_W, innerWidth - 16), minH = Math.min(MIN_H, innerHeight - 88);
                if (edge.includes('e')) right = Math.min(innerWidth - 8, Math.max(left + minW, r.right + dx));
                if (edge.includes('s')) bottom = Math.min(innerHeight - 8, Math.max(top + minH, r.bottom + dy));
                if (edge.includes('w')) left = Math.max(8, Math.min(right - minW, r.left + dx));
                if (edge.includes('n')) top = Math.max(0, Math.min(bottom - minH, r.top + dy));
                const newW = right - left, newH = bottom - top;
                panel.style.width = newW + 'px'; panel.style.height = newH + 'px';
                updateResponsive(newW);
            }
            panel.style.left = left + 'px'; panel.style.top = top + 'px'; clamp();
        });
        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) panel.addEventListener(event, e => {
            if (gesture?.pointer !== e.pointerId) return;
            gesture = null; if (panel.hasPointerCapture(e.pointerId)) panel.releasePointerCapture(e.pointerId); save();
        });
        // 快捷键支持：Esc 关闭配对、结果或纯白板模式，Ctrl+Enter 快捷触发识别，Ctrl+C 复制画板图片
        panel.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                if (!$('pairing').hidden) { pairing(false); e.stopPropagation(); return; }
                if (!$('result').hidden) { showResult(false); e.stopPropagation(); return; }
                if (pureMode) { setPureMode(false); e.stopPropagation(); return; }
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                if (!$('recognize').disabled) { $('recognize').click(); e.preventDefault(); e.stopPropagation(); }
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
                const isEditing = el => el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
                if (!isEditing(e.target) && !isEditing(document.activeElement) && !window.getSelection()?.toString()) {
                    e.preventDefault(); e.stopPropagation();
                    copyBoardImage();
                }
            }
        });
        // 窗口内操作不穿透到 PDF 的批注、快捷键和外部点击逻辑。
        for (const event of ['click', 'mousedown', 'pointerdown', 'keydown', 'keyup', 'wheel']) panel.addEventListener(event, e => e.stopPropagation());
        new ResizeObserver(() => { if (!panel.hidden) { updateResponsive(); draw(); } }).observe(panel);
        new ResizeObserver(draw).observe($('pad'));
        window.addEventListener('resize', () => { if (!panel.hidden) { clamp(); draw(); } });
    }
    window.HandwritingWhiteboard = {
        show() { ensure(); panel.hidden = false; clamp(); draw(); phone.start(); },
        hide,
        setPureMode(enabled) { ensure(); setPureMode(enabled); },
        isPureMode() { return !!pureMode; }
    };
})();
