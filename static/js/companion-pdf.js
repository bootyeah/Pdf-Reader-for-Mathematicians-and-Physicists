/**
 * =============================================================================
 * ⑪ 小窗对照阅读 (Companion PDF / 画中画副文档阅读器)
 * -----------------------------------------------------------------------------
 * 功能：在不离开当前主阅读界面的前提下，在同一个页面内以悬浮画中画小窗打开另一个 PDF。
 *       - 专为文献对照、答案批阅、课件讲义参考、公式定理查表设计。
 *       - 深度打磨桌面级小窗交互体验：
 *         * 打开菜单呼出窗口，在窗口内选文件，支持 F10 全局快捷键切换；
 *         * 标题栏拖拽平移，智能贴边 clamp 防出界；
 *         * 8 向边缘调整尺寸 + 右下角精美条纹手柄自由拉伸；
 *         * 分屏贴靠对比 (Dock) 模式支持拖动中缝灵活调节分屏宽度比例；
 *         * 双击标题栏快速切换「半屏分屏对比」与「浮动小窗」，折叠时双击自动展开；
 *         * 一键折叠为便携标题栏，展开后保留阅读位置；
 *         * 窗口位置、尺寸、缩放模式及阅读进度自动记忆 (localStorage)；
 *         * 支持文件直接拖拽放入小窗，或点击窗口内的文件按钮；
 *         * 独立窗口焦点与键盘劫持保护：独立响应 PageUp/PageDown/方向键/空格/Ctrl+滚轮缩放，不干扰主文档；
 *         * 支持文档目录大纲 (Outline) 侧边抽屉快速跳转，点击视口自动收起；
 *         * 视网膜高清级 (Retina/DPR) 矢量渲染 + 自适应宽 / 自适应整页 / 常用倍率快速切换；
 *         * 高保真文本层 (Text Layer)，支持文本选择与精准复制 (Ctrl+C)；
 *         * 页面按需虚拟化懒加载，高性能低内存占用；
 *         * 自动适配护眼模式与极简纯净界面风格。
 * -----------------------------------------------------------------------------
 * 架构：自包含独立 IIFE，DOM 惰性单例创建，全局挂载 window.CompanionPdf。
 * =============================================================================
 */

(function () {
    'use strict';

    const STORAGE_KEY = 'pdf_reader_companion_pdf_state';
    const MIN_W = 340;
    const MIN_H = 240;
    const HEADER_HEIGHT = 72; // 与主界面顶栏保持安全间距

    // 内部 DOM 引用
    let panel = null;
    let header = null;
    let controls = null;
    let titleEl = null;
    let shortcutBtn = null;
    let navGroup = null;
    let prevBtn = null;
    let nextBtn = null;
    let pageInput = null;
    let pageTotal = null;
    let zoomGroup = null;
    let handBtn = null;
    let isHandToolActive = false;
    let isSpaceDown = false;
    let handDrag = { isDragging: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 };
    let zoomSelect = null;
    let zoomOutBtn = null;
    let zoomInBtn = null;
    let outlineBtn = null;
    let openBtn = null;
    let dockBtn = null;
    let collapseBtn = null;
    let closeBtn = null;
    let bodyEl = null;
    let viewportEl = null;
    let pagesContainer = null;
    let emptyState = null;
    let emptyOpenBtn = null;
    let dropzone = null;
    let loadingMask = null;
    let outlineDrawer = null;
    let outlineList = null;
    let outlineCloseBtn = null;
    let resizeGrip = null;
    let errorEl = null;
    let returnFocus = null;
    let restoredLayout = false;

    // 状态管理
    let isOpen = false;
    let isCollapsed = false;
    let isDocked = false;
    let savedFloatingRect = null; // 贴靠前保存的浮动位置尺寸
    let expandedHeight = 480;

    let currentFile = null;
    let currentBlobUrl = null;
    let companionDoc = null;
    let loadingTask = null;
    let loadGeneration = 0;
    let pickingFile = false;
    let pageDimensions = []; // { width, height } at scale=1
    let numPages = 0;
    let currentPage = 1;
    let currentScaleMode = 'fit-width'; // 'fit-width' | 'fit-page' | 0.5 | 0.75 | 1.0 | 1.25 | 1.5 | 2.0
    let effectiveScale = 1.0;
    let outlineItems = [];

    // 渲染管理
    let pageWrappers = new Map(); // pageNum -> { wrapper, canvas, textLayer, rendered, rendering, renderTask }
    let intersectionObserver = null;
    let resizeObserver = null;
    let scrollDebounceTimer = null;
    let fileInputEl = null;
    let isNavigating = false;
    let navigatingTimer = null;
    let renderFrame = null;
    let zoomFrame = null;
    let lastReadingPosition = null;
    let refreshQuickFolderChips = null;

    function getQuickFolders() {
        try {
            return typeof loadQuickFoldersConfig === 'function'
                ? loadQuickFoldersConfig()
                : JSON.parse(localStorage.getItem('pdf_reader_quick_folders') || '{}');
        } catch (_) { return {}; }
    }

    // ---------- 读取与存储窗口记忆 ----------
    function loadSavedState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const saved = raw ? JSON.parse(raw) : {};
            return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
        } catch (_) {
            return {};
        }
    }

    function saveState() {
        if (!panel || panel.hidden) return;
        const previous = loadSavedState();
        const rect = panel.getBoundingClientRect();
        const data = {
            x: isDocked && savedFloatingRect ? savedFloatingRect.x : rect.x,
            y: isDocked && savedFloatingRect ? savedFloatingRect.y : rect.y,
            w: isDocked && savedFloatingRect ? savedFloatingRect.w : rect.width,
            h: isDocked && savedFloatingRect ? savedFloatingRect.h : (isCollapsed ? expandedHeight : rect.height),
            collapsed: isCollapsed,
            docked: isDocked,
            dockWidth: isDocked ? rect.width : previous.dockWidth,
            scaleMode: currentScaleMode,
            lastPage: currentFile ? currentPage : (previous.lastPage || 1),
            lastFileName: currentFile ? currentFile.name : (previous.lastFileName || ''),
            lastFileSize: currentFile ? currentFile.size : (previous.lastFileSize || 0),
            position: currentFile ? (isCollapsed ? lastReadingPosition : capturePosition()) : (previous.position || null)
        };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (_) {}
    }

    function syncOpenButton() {
        document.getElementById('open-companion-btn')?.setAttribute('aria-expanded', String(isOpen));
    }

    // ---------- 窗口置顶与焦点提升 ----------
    function bringToFront() {
        if (!panel) return;
        panel.style.zIndex = '2060';
        panel.classList.add('cp-focused');
    }

    // ---------- 边界约束保护 (Clamp) ----------
    function clampPosition() {
        if (!panel || isDocked) return;
        const r = panel.getBoundingClientRect();
        const maxW = Math.max(1, window.innerWidth - 16);
        const maxH = Math.max(40, window.innerHeight - 16);
        const w = Math.max(Math.min(MIN_W, maxW), Math.min(r.width, maxW));
        const h = isCollapsed ? 40 : Math.max(Math.min(MIN_H, maxH), Math.min(r.height, maxH));

        if (!isCollapsed && h < expandedHeight) expandedHeight = Math.max(MIN_H, h);

        const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
        const top = Math.max(0, Math.min(r.top, window.innerHeight - h - 8));

        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    }

    // ---------- DOM 结构构建 ----------
    function ensureDom() {
        if (panel) return;

        panel = document.createElement('section');
        panel.id = 'companion-pdf-panel';
        panel.className = 'companion-pdf-panel';
        panel.hidden = true;
        panel.setAttribute('tabindex', '-1');
        panel.setAttribute('aria-label', '小窗 PDF 对照阅读器');

        panel.innerHTML = `
            <div id="companion-pdf-header" class="companion-pdf-header">
                <div class="cp-header-brand">
                    <div class="cp-brand-icon"><i class="ph ph-file-pdf"></i></div>
                    <strong id="companion-pdf-title" class="cp-title" title="小窗对照阅读">小窗对照阅读</strong>
                    <button type="button" id="cp-shortcut-btn" class="window-shortcut-btn cp-shortcut-btn" title="折叠为标题栏 (快捷键: P)" aria-label="折叠小窗 (P)">
                        <span class="ws-action">折叠</span>
                        <kbd class="ws-key">P</kbd>
                    </button>
                </div>

                <!-- 顶栏快捷翻页与页码输入 -->
                <div id="companion-pdf-nav" class="cp-nav-group" style="display:none;">
                    <button type="button" id="cp-prev-page" class="cp-hbtn" title="上一页 (PageUp / ←)" aria-label="上一页">
                        <i class="ph ph-caret-left"></i>
                    </button>
                    <div class="cp-page-counter">
                        <input type="text" inputmode="numeric" id="cp-page-input" class="cp-page-input" value="1" title="输入页码按回车跳转" aria-label="当前页码">
                        <span class="cp-page-slash">/</span>
                        <span id="cp-page-total" class="cp-page-total">1</span>
                    </div>
                    <button type="button" id="cp-next-page" class="cp-hbtn" title="下一页 (PageDown / →)" aria-label="下一页">
                        <i class="ph ph-caret-right"></i>
                    </button>
                </div>

                <!-- 缩放与抓手控制 -->
                <div id="companion-pdf-zoom-group" class="cp-zoom-group" style="display:none;">
                    <button type="button" id="cp-hand-btn" class="cp-hbtn" title="抓手模式 (空格键拖动 / 点击保持)" aria-label="抓手模式"><i class="ph ph-hand-palm"></i></button>
                    <button type="button" id="cp-zoom-out" class="cp-hbtn" title="缩小 (Ctrl + -)" aria-label="缩小"><i class="ph ph-minus"></i></button>
                    <select id="cp-zoom-select" class="cp-zoom-select" title="缩放比例" aria-label="缩放比例">
                        <option value="fit-width" selected>自适应宽</option>
                        <option value="fit-page">自适应整页</option>
                        <option value="0.5">50%</option>
                        <option value="0.75">75%</option>
                        <option value="1.0">100%</option>
                        <option value="1.25">125%</option>
                        <option value="1.5">150%</option>
                        <option value="2.0">200%</option>
                    </select>
                    <button type="button" id="cp-zoom-in" class="cp-hbtn" title="放大 (Ctrl + +)" aria-label="放大"><i class="ph ph-plus"></i></button>
                </div>

                <div class="cp-header-spacer"></div>

                <!-- 窗口操作按钮 -->
                <div class="cp-header-actions">
                    <button type="button" id="cp-outline-btn" class="cp-hbtn" title="展开/收起文档目录" aria-label="目录" style="display:none;">
                        <i class="ph ph-list-dashes"></i>
                    </button>
                    <button type="button" id="cp-open-btn" class="cp-hbtn" title="打开或更换副文档 PDF" aria-label="打开 PDF">
                        <i class="ph ph-folder-open"></i>
                    </button>
                    <button type="button" id="cp-dock-btn" class="cp-hbtn" title="半屏贴靠对比 (再次点击恢复浮动)" aria-label="半屏对比">
                        <i class="ph ph-sidebar-simple"></i>
                    </button>
                    <button type="button" id="cp-collapse-btn" class="cp-hbtn" title="折叠为标题栏 (P)" aria-label="折叠" aria-expanded="true">
                        <i class="ph ph-caret-up"></i>
                    </button>
                    <button type="button" id="cp-close-btn" class="cp-hbtn cp-hbtn-close" title="关闭小窗" aria-label="关闭">
                        <i class="ph ph-x"></i>
                    </button>
                </div>
            </div>

            <div id="companion-pdf-body" class="companion-pdf-body">
                <!-- 侧边目录抽屉 -->
                <div id="companion-pdf-outline-drawer" class="cp-outline-drawer" hidden>
                    <div class="cp-outline-head">
                        <span class="cp-outline-head-title"><i class="ph ph-list-dashes"></i> 文档目录</span>
                        <button type="button" id="cp-outline-close" class="cp-hbtn" title="收起目录 (Esc)" aria-label="收起目录"><i class="ph ph-x"></i></button>
                    </div>
                    <div id="companion-pdf-outline-list" class="cp-outline-list custom-scrollbar"></div>
                </div>

                <!-- 极简高质感空状态 -->
                <div id="companion-pdf-empty" class="cp-empty-state">
                    <div class="cp-empty-card" id="companion-pdf-dropzone">
                        <div class="cp-empty-icon-wrap">
                            <i class="ph ph-browsers"></i>
                        </div>
                        <div class="cp-empty-title">打开另一份 PDF</div>
                        <div class="cp-empty-sub">拖入 PDF，或点击下方选择文件</div>
                        <div class="cp-empty-actions">
                            <button type="button" id="cp-empty-open-btn" class="cp-empty-main-btn" title="选择并打开副文档">
                                <i class="ph ph-folder-open"></i>
                                <span>选择文件</span>
                            </button>
                            <div class="cp-empty-quick-wrap" id="cp-empty-quick-wrap">
                                <button type="button" class="cp-empty-quick-btn" id="cp-quick-btn-1" title="从快捷文件夹选择">数</button>
                                <button type="button" class="cp-empty-quick-btn" id="cp-quick-btn-2" title="从快捷文件夹选择">物</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 加载中指示器 -->
                <div id="companion-pdf-loading" class="cp-loading-mask" role="status" hidden>
                    <div class="cp-loading-spinner"><i class="ph ph-spinner ph-spin"></i></div>
                    <span class="cp-loading-text">正在解析文档…</span>
                </div>

                <!-- PDF 滚动主视口 -->
                <div id="companion-pdf-viewport" class="cp-viewport custom-scrollbar" style="display:none;">
                    <div id="companion-pdf-pages" class="cp-pages-container"></div>
                </div>
            </div>

            <!-- 8 向调整手柄与右下角拖拽角标 -->
            ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => `<div class="cp-resize-edge" data-edge="${edge}"></div>`).join('')}
            <div class="cp-resize-grip" title="拖拽调整尺寸">
                <svg viewBox="0 0 16 16"><line x1="14" y1="2" x2="2" y2="14"/><line x1="14" y1="7" x2="7" y2="14"/><line x1="14" y1="12" x2="12" y2="14"/></svg>
            </div>
        `;

        document.body.appendChild(panel);

        // 获取元素引用
        header = panel.querySelector('#companion-pdf-header');
        titleEl = panel.querySelector('#companion-pdf-title');
        shortcutBtn = panel.querySelector('#cp-shortcut-btn');
        navGroup = panel.querySelector('#companion-pdf-nav');
        prevBtn = panel.querySelector('#cp-prev-page');
        nextBtn = panel.querySelector('#cp-next-page');
        pageInput = panel.querySelector('#cp-page-input');
        pageTotal = panel.querySelector('#cp-page-total');
        zoomGroup = panel.querySelector('#companion-pdf-zoom-group');
        handBtn = panel.querySelector('#cp-hand-btn');
        zoomSelect = panel.querySelector('#cp-zoom-select');
        zoomOutBtn = panel.querySelector('#cp-zoom-out');
        zoomInBtn = panel.querySelector('#cp-zoom-in');
        outlineBtn = panel.querySelector('#cp-outline-btn');
        openBtn = panel.querySelector('#cp-open-btn');
        dockBtn = panel.querySelector('#cp-dock-btn');
        collapseBtn = panel.querySelector('#cp-collapse-btn');
        closeBtn = panel.querySelector('#cp-close-btn');
        bodyEl = panel.querySelector('#companion-pdf-body');
        viewportEl = panel.querySelector('#companion-pdf-viewport');
        pagesContainer = panel.querySelector('#companion-pdf-pages');
        emptyState = panel.querySelector('#companion-pdf-empty');
        emptyOpenBtn = panel.querySelector('#cp-empty-open-btn');
        dropzone = panel.querySelector('#companion-pdf-dropzone');
        loadingMask = panel.querySelector('#companion-pdf-loading');
        outlineDrawer = panel.querySelector('#companion-pdf-outline-drawer');
        outlineList = panel.querySelector('#companion-pdf-outline-list');
        outlineCloseBtn = panel.querySelector('#cp-outline-close');
        resizeGrip = panel.querySelector('.cp-resize-grip');

        // 阅读控制独立成行，窄窗口也能完整显示文件名和窗口按钮。
        controls = document.createElement('div');
        controls.className = 'cp-controls';
        controls.hidden = true;
        controls.append(navGroup, zoomGroup);
        header.after(controls);
        errorEl = document.createElement('div');
        errorEl.id = 'cp-error';
        errorEl.className = 'cp-error';
        errorEl.setAttribute('role', 'alert');
        errorEl.hidden = true;
        controls.after(errorEl);

        // 创建隐式文件选择器
        fileInputEl = document.createElement('input');
        fileInputEl.type = 'file';
        fileInputEl.accept = 'application/pdf';
        fileInputEl.style.display = 'none';
        document.body.appendChild(fileInputEl);

        fileInputEl.addEventListener('change', e => {
            const file = e.target.files?.[0];
            if (file) loadFile(file);
            fileInputEl.value = '';
        });

        // 恢复历史位置与状态
        const saved = loadSavedState();
        const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
        const initW = Math.max(1, finite(saved.w, Math.min(620, window.innerWidth - 32)));
        const initH = Math.max(40, finite(saved.h, Math.min(500, window.innerHeight - 32)));
        const initX = finite(saved.x, Math.max(16, window.innerWidth - initW - 24));
        const initY = finite(saved.y, HEADER_HEIGHT + 16);

        expandedHeight = Math.max(MIN_H, initH);
        panel.style.width = initW + 'px';
        panel.style.height = initH + 'px';
        panel.style.left = initX + 'px';
        panel.style.top = initY + 'px';

        currentScaleMode = normalizeScale(saved.scaleMode);
        syncZoomSelectUI(currentScaleMode);

        bindEvents();
    }

    // ---------- 抓手模式辅助函数 ----------
    function updateHandCursor() {
        if (!viewportEl) return;
        const canGrab = isHandToolActive || isSpaceDown;
        viewportEl.classList.toggle('cp-hand-active', canGrab);
        if (!canGrab && !handDrag.isDragging) {
            viewportEl.classList.remove('cp-hand-grabbing');
        }
    }

    function endHandDrag() {
        if (handDrag.isDragging) {
            handDrag.isDragging = false;
        }
        if (viewportEl) {
            viewportEl.classList.remove('cp-hand-grabbing');
        }
        updateHandCursor();
    }

    // ---------- 事件绑定 ----------
    function bindEvents() {
        // 打开文件按钮
        const triggerOpen = () => openFilePicker();
        openBtn.addEventListener('click', e => { e.stopPropagation(); triggerOpen(); });
        emptyOpenBtn.addEventListener('click', e => { e.stopPropagation(); triggerOpen(); });

        // 空状态快捷文件夹药丸按钮
        refreshQuickFolderChips = () => {
            try {
                const conf = getQuickFolders();
                const b1 = panel.querySelector('#cp-quick-btn-1');
                const b2 = panel.querySelector('#cp-quick-btn-2');
                if (b1) {
                    const l1 = (conf.btn1?.label || '数').substring(0, 1);
                    b1.textContent = l1;
                    b1.title = `从「${conf.btn1?.name || conf.btn1?.path || '数学专业课'}」选择打开副文档`;
                    b1.onclick = e => { e.stopPropagation(); openFilePicker(getQuickFolders().btn1?.path); };
                }
                if (b2) {
                    const l2 = (conf.btn2?.label || '物').substring(0, 1);
                    b2.textContent = l2;
                    b2.title = `从「${conf.btn2?.name || conf.btn2?.path || '物理专业课'}」选择打开副文档`;
                    b2.onclick = e => { e.stopPropagation(); openFilePicker(getQuickFolders().btn2?.path); };
                }
            } catch (_) {}
        };
        refreshQuickFolderChips();
        panel.querySelector('.cp-empty-actions').addEventListener('pointerenter', refreshQuickFolderChips);

        // 窗口焦点提升与置顶
        panel.addEventListener('pointerdown', e => {
            bringToFront();
            const focusTarget = e.target.closest('button, input, select, textarea, a, [tabindex], [contenteditable]');
            if (!focusTarget || focusTarget === panel) {
                panel.focus({ preventScroll: true });
            }
        });
        panel.addEventListener('focusin', () => {
            bringToFront();
        });
        panel.addEventListener('focusout', (e) => {
            if (!panel.contains(e.relatedTarget)) {
                panel.classList.remove('cp-focused');
                if (isSpaceDown) {
                    isSpaceDown = false;
                    if (!isHandToolActive && handDrag.isDragging) {
                        endHandDrag();
                    }
                    updateHandCursor();
                }
            }
        });
        panel.addEventListener('pointerleave', () => {
            if (!handDrag.isDragging && isSpaceDown) {
                isSpaceDown = false;
                updateHandCursor();
            }
        });

        // 折叠 / 展开
        collapseBtn.addEventListener('click', e => { e.stopPropagation(); toggleCollapsed(); });
        if (shortcutBtn) {
            shortcutBtn.addEventListener('click', e => {
                e.stopPropagation();
                toggleCollapsed();
            });
        }

        // 关闭
        closeBtn.addEventListener('click', e => { e.stopPropagation(); hide(); });

        // 半屏贴靠 / 浮动切换
        dockBtn.addEventListener('click', e => { e.stopPropagation(); toggleDock(); });

        // 目录开关
        outlineBtn.addEventListener('click', e => {
            e.stopPropagation();
            toggleOutline();
        });
        outlineCloseBtn.addEventListener('click', e => {
            e.stopPropagation();
            toggleOutline(false);
        });

        // 翻页操作
        prevBtn.addEventListener('click', e => { e.stopPropagation(); goToPage(currentPage - 1); });
        nextBtn.addEventListener('click', e => { e.stopPropagation(); goToPage(currentPage + 1); });

        // 页码输入跳转
        pageInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                const p = Number(pageInput.value.trim());
                if (Number.isInteger(p) && p >= 1 && p <= numPages) {
                    goToPage(p);
                } else {
                    pageInput.value = currentPage;
                }
                panel.focus({ preventScroll: true });
            }
        });
        pageInput.addEventListener('blur', () => { pageInput.value = currentPage; });

        // 缩放控制
        zoomSelect.addEventListener('change', e => {
            const val = e.target.value;
            currentScaleMode = normalizeScale(val);
            applyZoom();
            saveState();
        });

        zoomInBtn.addEventListener('click', e => {
            e.stopPropagation();
            zoomStep(0.25);
            panel.focus({ preventScroll: true });
        });
        zoomOutBtn.addEventListener('click', e => {
            e.stopPropagation();
            zoomStep(-0.25);
            panel.focus({ preventScroll: true });
        });

        // 抓手模式按钮：点击切换保持抓取状态
        handBtn.addEventListener('click', e => {
            e.stopPropagation();
            isHandToolActive = !isHandToolActive;
            handBtn.classList.toggle('active', isHandToolActive);
            if (!isHandToolActive && handDrag.isDragging) {
                endHandDrag();
            }
            updateHandCursor();
            panel.focus({ preventScroll: true });
        });

        // 视口拖拽平移事件 (左键/中键响应抓手模式或按住空格)
        viewportEl.addEventListener('mousedown', e => {
            if (document.activeElement !== panel && !panel.contains(document.activeElement)) {
                panel.focus({ preventScroll: true });
            }
            const canGrab = isHandToolActive || isSpaceDown;
            if (canGrab && (e.button === 0 || e.button === 1)) {
                e.preventDefault();
                e.stopPropagation();
                handDrag.isDragging = true;
                handDrag.startX = e.clientX;
                handDrag.startY = e.clientY;
                handDrag.scrollLeft = viewportEl.scrollLeft;
                handDrag.scrollTop = viewportEl.scrollTop;
                viewportEl.classList.add('cp-hand-grabbing');
            }
        });

        window.addEventListener('mousemove', e => {
            if (handDrag.isDragging) {
                if (!(e.buttons & 1) && !(e.buttons & 4)) {
                    endHandDrag();
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                const dx = e.clientX - handDrag.startX;
                const dy = e.clientY - handDrag.startY;
                viewportEl.scrollLeft = handDrag.scrollLeft - dx;
                viewportEl.scrollTop = handDrag.scrollTop - dy;
            }
        }, { capture: true, passive: false });

        window.addEventListener('mouseup', e => {
            if (handDrag.isDragging && (e.button === 0 || e.button === 1)) {
                endHandDrag();
            }
        }, { capture: true });

        viewportEl.addEventListener('click', e => {
            const canGrab = isHandToolActive || isSpaceDown;
            if (canGrab) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, { capture: true });

        // 双击标题栏：若折叠中则展开；若已展开则快速在“半屏对比”与“浮动小窗”之间切换
        header.addEventListener('dblclick', e => {
            if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return;
            if (isCollapsed) {
                setCollapsed(false);
            } else {
                toggleDock();
            }
        });

        // 拖拽移动与边缘缩放
        setupPointerDragAndResize();

        // 视口滚动监听（计算当前可视页码）
        viewportEl.addEventListener('scroll', onViewportScroll, { passive: true });

        // 点击视口空白处收起目录抽屉
        viewportEl.addEventListener('click', () => {
            if (outlineDrawer && !outlineDrawer.hidden) {
                toggleOutline(false);
            }
        });

        // 拖拽放入文件打开
        setupDragAndDrop();

        // Ctrl + 滚轮对副文档进行缩放；普通滚轮正常纵向滚动
        panel.addEventListener('wheel', e => {
            if (e.ctrlKey) {
                e.preventDefault();
                e.stopPropagation();
                const delta = e.deltaY < 0 ? 0.25 : -0.25;
                zoomStep(delta, { x: e.clientX, y: e.clientY });
                return;
            }
            e.stopPropagation();
        }, { passive: false });

        // 专属快捷键支持（当小窗处于激活或有焦点时生效）
        panel.addEventListener('keydown', e => {
            // 所有小窗按键都在此结束冒泡；复制、选择和输入仍由浏览器处理。
            e.stopPropagation();
            const isInput = e.target && (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable);
            if (e.isComposing) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                if (isInput) {
                    pageInput.value = currentPage;
                    panel.focus({ preventScroll: true });
                    return;
                }
                if (!outlineDrawer.hidden) {
                    toggleOutline(false);
                    return;
                }
                if (isDocked) {
                    toggleDock();
                    return;
                }
                hide();
                return;
            }
            if (isInput) return;
            const isSpaceKey = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
            if (e.target.closest('button') && (isSpaceKey || e.key === 'Enter')) {
                if (isSpaceKey && viewportEl?.matches?.(':hover')) {
                    e.target.blur();
                    panel.focus({ preventScroll: true });
                } else {
                    return;
                }
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
                e.preventDefault();
                openFilePicker();
                return;
            }
            if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'KeyP' || e.key.toLowerCase() === 'p')) {
                e.preventDefault();
                e.stopPropagation();
                if (!e.repeat) toggleCollapsed();
                return;
            }
            if (isSpaceKey) {
                e.preventDefault();
                e.stopPropagation();
                if (!isCollapsed && companionDoc && !isSpaceDown) {
                    isSpaceDown = true;
                    updateHandCursor();
                }
                return;
            }
            // 保留文字选择的 Shift+方向键与浏览器的复制等组合键。
            if (e.shiftKey && e.key.startsWith('Arrow')) return;
            if ((e.ctrlKey || e.metaKey) && !['=', '+', '-', '_', '0'].includes(e.key)) return;
            if (e.altKey && !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
            if (isCollapsed || !companionDoc) return;

            if (e.key === 'PageUp' || (e.altKey && e.key === 'ArrowUp') || e.key === 'ArrowLeft') {
                e.preventDefault();
                e.stopPropagation();
                goToPage(currentPage - 1);
            } else if (e.key === 'PageDown' || (e.altKey && e.key === 'ArrowDown') || e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                goToPage(currentPage + 1);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                viewportEl.scrollBy({ top: 120, behavior: 'smooth' });
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                viewportEl.scrollBy({ top: -120, behavior: 'smooth' });
            } else if (e.key === 'Home') {
                e.preventDefault();
                e.stopPropagation();
                goToPage(1);
            } else if (e.key === 'End') {
                e.preventDefault();
                e.stopPropagation();
                goToPage(numPages);
            } else if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
                e.preventDefault();
                e.stopPropagation();
                zoomStep(0.25);
            } else if (e.ctrlKey && (e.key === '-' || e.key === '_')) {
                e.preventDefault();
                e.stopPropagation();
                zoomStep(-0.25);
            } else if (e.ctrlKey && e.key === '0') {
                e.preventDefault();
                e.stopPropagation();
                currentScaleMode = 'fit-width';
                syncZoomSelectUI('fit-width');
                applyZoom();
                saveState();
            }
        });
        panel.addEventListener('keyup', e => {
            if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
                if (isSpaceDown) {
                    isSpaceDown = false;
                    if (!isHandToolActive && handDrag.isDragging) {
                        endHandDrag();
                    }
                    updateHandCursor();
                }
            }
        });

        // 全局空格与失焦监听：与主阅读器体验保持一致，按下空格随时在副窗口抓手拖拽
        window.addEventListener('keydown', e => {
            if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
                if (!isOpen || !panel || panel.hidden) return;
                const isInput = e.target && (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable);
                if (isInput) return;
                const isOverPanel = panel.contains(document.activeElement) ||
                                    panel.contains(e.target) ||
                                    panel.matches(':hover');
                if (!isOverPanel) return;
                if (e.target.closest?.('button') && !viewportEl?.matches?.(':hover')) return;
                e.preventDefault();
                if (!isCollapsed && companionDoc && !isSpaceDown) {
                    isSpaceDown = true;
                    updateHandCursor();
                }
            }
        });

        window.addEventListener('keyup', e => {
            if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
                if (isSpaceDown) {
                    isSpaceDown = false;
                    if (!isHandToolActive && handDrag.isDragging) {
                        endHandDrag();
                    }
                    updateHandCursor();
                }
            }
        });

        window.addEventListener('blur', () => {
            if (isSpaceDown) {
                isSpaceDown = false;
                if (!isHandToolActive && handDrag.isDragging) {
                    endHandDrag();
                }
                updateHandCursor();
            }
        });

        // 避免小窗内部操作穿透到主 PDF
        for (const evt of ['click', 'mousedown', 'pointerdown', 'contextmenu']) {
            panel.addEventListener(evt, e => e.stopPropagation());
        }

        // 视口尺寸变化监视：自适应宽重新计算
        resizeObserver = new ResizeObserver(() => {
            if (!isOpen || isCollapsed) return;
            if (currentScaleMode === 'fit-width' || currentScaleMode === 'fit-page') {
                queueZoom();
            }
        });
        resizeObserver.observe(viewportEl);

        window.addEventListener('resize', () => {
            if (!isOpen) return;
            if (isDocked) {
                layoutDocked(panel.offsetWidth);
            } else {
                clampPosition();
            }
            queueZoom();
        });
    }

    // ---------- 拖拽移动与 8 向缩放 ----------
    function setupPointerDragAndResize() {
        let gesture = null;

        panel.addEventListener('pointerdown', e => {
            const edge = e.target.closest('[data-edge]')?.dataset.edge;
            const isGrip = !!e.target.closest('.cp-resize-grip');
            const isHeader = !!e.target.closest('#companion-pdf-header') && !e.target.closest('button') && !e.target.closest('select') && !e.target.closest('input');

            if (e.button !== 0 || (!edge && !isGrip && !isHeader)) return;
            if (isDocked && isHeader) return; // 贴靠模式禁止拖动平移

            gesture = {
                edge: edge || (isGrip ? 'se' : null),
                x: e.clientX,
                y: e.clientY,
                r: panel.getBoundingClientRect(),
                pointer: e.pointerId,
                userSelect: document.body.style.userSelect
            };
            panel.setPointerCapture(e.pointerId);
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        panel.addEventListener('pointermove', e => {
            if (!gesture || gesture.pointer !== e.pointerId) return;
            const { edge, r, x, y } = gesture;
            const dx = e.clientX - x;
            const dy = e.clientY - y;

            if (!edge) {
                // 平移移动
                const newLeft = r.left + dx;
                const newTop = r.top + dy;
                panel.style.left = newLeft + 'px';
                panel.style.top = newTop + 'px';
                clampPosition();
            } else {
                // 调整大小
                if (isDocked) {
                    // 分屏贴靠模式下，拖动左边缘平滑调整分屏对比宽度与比例
                    if (edge === 'w' || edge === 'nw' || edge === 'sw') {
                        const maxW = Math.max(1, window.innerWidth - 16);
                        const minW = Math.min(MIN_W, maxW);
                        const newW = Math.max(minW, Math.min(maxW, r.right - (r.left + dx)));
                        layoutDocked(newW);
                        return;
                    }
                    // 其它边缘拖动自动退回自由浮动状态
                    isDocked = false;
                    panel.classList.remove('cp-docked');
                    dockBtn.classList.remove('active');
                }
                let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
                const minW = Math.min(MIN_W, window.innerWidth - 16);
                const minH = Math.min(MIN_H, window.innerHeight - 16);

                if (edge.includes('e')) right = Math.min(window.innerWidth - 8, Math.max(left + minW, r.right + dx));
                if (edge.includes('s')) bottom = Math.min(window.innerHeight - 8, Math.max(top + minH, r.bottom + dy));
                if (edge.includes('w')) left = Math.max(8, Math.min(right - minW, r.left + dx));
                if (edge.includes('n')) top = Math.max(0, Math.min(bottom - minH, r.top + dy));

                panel.style.width = (right - left) + 'px';
                if (!isCollapsed) {
                    panel.style.height = (bottom - top) + 'px';
                    expandedHeight = bottom - top;
                }
                panel.style.left = left + 'px';
                panel.style.top = top + 'px';
                clampPosition();
            }
        });

        const endGesture = e => {
            if (!gesture || gesture.pointer !== e.pointerId) return;
            document.body.style.userSelect = gesture.userSelect;
            gesture = null;
            if (panel.hasPointerCapture(e.pointerId)) panel.releasePointerCapture(e.pointerId);
            saveState();
        };

        for (const evt of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            panel.addEventListener(evt, endGesture);
        }
    }

    // ---------- 文件拖拽放入支持 ----------
    function setupDragAndDrop() {
        const handleDragOver = e => {
            if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
            e.preventDefault();
            e.stopPropagation();
            panel.classList.add('cp-drag-over');
        };
        const handleDragLeave = e => {
            e.preventDefault();
            e.stopPropagation();
            if (!panel.contains(e.relatedTarget)) {
                panel.classList.remove('cp-drag-over');
            }
        };
        const handleDrop = e => {
            e.preventDefault();
            e.stopPropagation();
            panel.classList.remove('cp-drag-over');
            const file = e.dataTransfer?.files?.[0];
            if (file) {
                if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
                    loadFile(file);
                } else {
                    showError('请拖入有效的 PDF 文档。');
                }
            }
        };

        panel.addEventListener('dragover', handleDragOver);
        panel.addEventListener('dragleave', handleDragLeave);
        panel.addEventListener('drop', handleDrop);
    }

    // ---------- 唤起文件选择 (优先使用快捷文件夹同款 Python 原生选择器) ----------
    async function openFilePicker(preferredFolder = null) {
        ensureDom();
        if (pickingFile) return;
        pickingFile = true;
        let fileWasSelected = false;
        errorEl.hidden = true;
        const pickerButtons = panel.querySelectorAll('#cp-open-btn, #cp-empty-open-btn, .cp-empty-quick-btn');
        pickerButtons.forEach(button => { button.disabled = true; });
        try {
        // 🚀 优先使用 Python 后台提供的原生系统文件选择（与数、物快捷文件夹相同的高级方式）
        try {
            let folderPath = preferredFolder || '';
            if (!folderPath) {
                if (typeof state !== 'undefined' && state?.localFilePath) {
                    const segs = state.localFilePath.replace(/[\\\/]+$/, '').split(/[\\\/]/);
                    segs.pop();
                    folderPath = segs.join('\\');
                } else {
                    try {
                        const savedQuick = JSON.parse(localStorage.getItem('pdf_reader_quick_folders') || '{}');
                        folderPath = savedQuick.btn1?.path || savedQuick.btn2?.path || '';
                    } catch (_) {}
                }
            }

            const resp = await fetch('/api/pick-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder: folderPath })
            });

            if (resp.status !== 404 && resp.status !== 501) {
                const data = await resp.json().catch(() => ({}));
                if (data.cancelled) return; // 用户取消选择
                if (data.ok && data.path) {
                    fileWasSelected = true;
                    if (!/\.pdf$/i.test(data.name || data.path)) {
                        showError('所选文件不是 PDF：' + (data.name || data.path));
                        return;
                    }
                    const fileResp = await fetch('/api/read-file?path=' + encodeURIComponent(data.path));
                    if (fileResp.ok) {
                        const blob = await fileResp.blob();
                        const file = new File([blob], data.name || data.path.split(/[\\/]/).pop(), { type: 'application/pdf' });
                        await loadFile(file);
                        return;
                    }
                    showError('无法读取所选 PDF，请确认文件仍然存在且可访问。');
                    return;
                }
                showError(data.error || '文件选择失败，请重试。');
                return;
            }
        } catch (err) {
            if (fileWasSelected) {
                showError('无法读取所选 PDF，请确认文件仍然存在且可访问。');
                return;
            }
            console.warn('呼叫原生文件选择器受阻，降级至系统选择器:', err);
        }

        // 降级策略：本地离线或无后台时使用浏览器选择器
        if (window.showOpenFilePicker) {
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [{ description: 'PDF Files', accept: { 'application/pdf': ['.pdf'] } }],
                    multiple: false
                });
                const file = await handle.getFile();
                await loadFile(file);
                return;
            } catch (err) {
                if (err.name === 'AbortError') return;
            }
        }
        fileInputEl.click();
        } finally {
            pickingFile = false;
            pickerButtons.forEach(button => { button.disabled = false; });
        }
    }

    function showError(message) {
        if (!errorEl) return;
        errorEl.textContent = message;
        errorEl.hidden = false;
    }

    function cancelPageWork() {
        for (const info of pageWrappers.values()) {
            info.version++;
            try { info.renderTask?.cancel(); } catch (_) {}
            try { info.textTask?.cancel(); } catch (_) {}
        }
        clearTimeout(scrollDebounceTimer);
        clearTimeout(navigatingTimer);
        isNavigating = false;
        intersectionObserver?.disconnect();
    }

    function destroyDocument(doc) {
        if (doc) Promise.resolve(doc.destroy()).catch(() => {});
        isHandToolActive = false;
        isSpaceDown = false;
        endHandDrag();
        if (handBtn) handBtn.classList.remove('active');
        if (viewportEl) viewportEl.classList.remove('cp-hand-active', 'cp-hand-grabbing');
    }

    // ---------- 更新翻页按钮禁用状态 ----------
    function updateNavButtons() {
        if (!prevBtn || !nextBtn) return;
        prevBtn.disabled = currentPage <= 1;
        prevBtn.classList.toggle('cp-btn-disabled', currentPage <= 1);
        nextBtn.disabled = currentPage >= numPages;
        nextBtn.classList.toggle('cp-btn-disabled', currentPage >= numPages);
    }

    // ---------- 加载 PDF 文档 ----------
    async function loadFile(file) {
        if (!file || (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name))) {
            ensureDom();
            show();
            showError('请选择有效的 PDF 文件。');
            return;
        }

        ensureDom();
        saveState();
        const saved = loadSavedState();
        show();
        if (isCollapsed) setCollapsed(false);
        const generation = ++loadGeneration;
        const obsoleteTask = loadingTask;
        if (obsoleteTask) Promise.resolve(obsoleteTask.destroy()).catch(() => {});
        errorEl.hidden = true;
        loadingMask.hidden = false;
        panel.setAttribute('aria-busy', 'true');
        toggleOutline(false);
        let candidateDoc = null;
        let candidateUrl = null;
        let task = null;
        let committed = false;
        try {
            candidateUrl = URL.createObjectURL(file);
            const cmapsAbsoluteUrl = new URL('./lib/cmaps/', window.location.href).href;
            const standardFontsAbsoluteUrl = new URL('./lib/standard_fonts/', window.location.href).href;

            task = loadingTask = pdfjsLib.getDocument({
                url: candidateUrl,
                cMapUrl: cmapsAbsoluteUrl,
                cMapPacked: true,
                standardFontDataUrl: standardFontsAbsoluteUrl,
                fontExtraProperties: false
            });

            candidateDoc = await task.promise;
            if (generation !== loadGeneration) return;
            // 获取真实几何尺寸；混合横竖页的跳转和整页缩放不能用单页采样猜测。
            const dimensions = [];
            for (let start = 1; start <= candidateDoc.numPages; start += 8) {
                const batch = await Promise.all(Array.from({ length: Math.min(8, candidateDoc.numPages - start + 1) }, async (_, i) => {
                    const page = await candidateDoc.getPage(start + i);
                    const vp = page.getViewport({ scale: 1 });
                    return { width: vp.width, height: vp.height };
                }));
                if (generation !== loadGeneration) return;
                dimensions.push(...batch);
            }

            // 新文档准备好后才替换旧文档，失败或迟到的加载不会清空当前阅读内容。
            cancelPageWork();
            const previousDoc = companionDoc;
            const previousUrl = currentBlobUrl;
            companionDoc = candidateDoc;
            currentBlobUrl = candidateUrl;
            currentFile = file;
            committed = true;
            loadingTask = null;
            destroyDocument(previousDoc);
            if (previousUrl) URL.revokeObjectURL(previousUrl);
            pageDimensions = dimensions;
            numPages = companionDoc.numPages;
            pageTotal.textContent = numPages;
            titleEl.textContent = file.name;
            titleEl.title = file.name;
            outlineBtn.style.display = 'none';
            emptyState.style.display = 'none';
            viewportEl.style.display = 'block';
            controls.hidden = false;
            navGroup.style.display = 'flex';
            zoomGroup.style.display = 'flex';

            const sameFile = saved.lastFileName === file.name && saved.lastFileSize === file.size;
            const targetPage = (sameFile && Number.isInteger(saved.lastPage) && saved.lastPage >= 1 && saved.lastPage <= numPages)
                ? saved.lastPage
                : 1;
            currentPage = targetPage;
            pageInput.value = currentPage;
            updateNavButtons();
            buildPageSkeletons();
            applyZoom(null, true);
            goToPage(targetPage, false);
            if (sameFile && saved.position) restorePosition(saved.position);
            loadOutline(companionDoc);
            scheduleVisiblePages();
            saveState();
        } catch (err) {
            if (generation !== loadGeneration) return;
            console.error('加载副文档 PDF 失败:', err);
            showError(err?.name === 'PasswordException' ? '该 PDF 需要密码，请先解锁后打开。' : '无法读取该 PDF，请确认文件完整后重新选择。');
        } finally {
            if (!committed) {
                if (task) Promise.resolve(task.destroy()).catch(() => {});
                if (candidateUrl) URL.revokeObjectURL(candidateUrl);
            }
            if (generation === loadGeneration) {
                loadingTask = null;
                loadingMask.hidden = true;
                panel.setAttribute('aria-busy', 'false');
            }
        }
    }

    // ---------- 构建页面骨架与 IntersectionObserver 调度 ----------
    function buildPageSkeletons() {
        pagesContainer.replaceChildren();
        pageWrappers.clear();

        if (intersectionObserver) {
            intersectionObserver.disconnect();
        }

        intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const pageNum = Number(entry.target.dataset.pageNum);
                const info = pageWrappers.get(pageNum);
                if (!info || info.wrapper !== entry.target || !isOpen || isCollapsed) return;

                if (entry.isIntersecting) {
                    renderPage(pageNum);
                } else {
                    // 远离视口时回收 canvas 资源以节省显存
                    const bounds = entry.boundingClientRect;
                    const rootBounds = entry.rootBounds;
                    if (rootBounds) {
                        const distance = Math.min(
                            Math.abs(bounds.top - rootBounds.bottom),
                            Math.abs(bounds.bottom - rootBounds.top)
                        );
                        // 离开视口超过 1200px 时清空 Canvas 像素
                        if (distance > 1200 && info.rendered) {
                            recyclePage(pageNum);
                        }
                    }
                }
            });
        }, {
            root: viewportEl,
            rootMargin: '400px 0px 400px 0px'
        });

        for (let i = 1; i <= numPages; i++) {
            const dim = pageDimensions[i - 1];
            const wrapper = document.createElement('div');
            wrapper.className = 'cp-page-card';
            wrapper.dataset.pageNum = String(i);
            wrapper.style.width = Math.round(dim.width * effectiveScale) + 'px';
            wrapper.style.height = Math.round(dim.height * effectiveScale) + 'px';

            const canvas = document.createElement('canvas');
            canvas.className = 'cp-page-canvas';
            wrapper.appendChild(canvas);

            const textLayer = document.createElement('div');
            textLayer.className = 'cp-text-layer textLayer';
            wrapper.appendChild(textLayer);

            const pageNumTag = document.createElement('div');
            pageNumTag.className = 'cp-page-badge';
            pageNumTag.textContent = String(i);
            wrapper.appendChild(pageNumTag);

            pagesContainer.appendChild(wrapper);

            pageWrappers.set(i, {
                wrapper,
                canvas,
                textLayer,
                rendered: false,
                rendering: false,
                renderTask: null,
                textTask: null,
                version: 0
            });

            intersectionObserver.observe(wrapper);
        }
    }

    // ---------- 渲染指定页面的 Canvas 和文本层 (支持 Retina 高清 + 异形页自适应) ----------
    async function renderPage(pageNum) {
        const info = pageWrappers.get(pageNum);
        if (!info || info.rendered || info.rendering || !companionDoc || !isOpen || isCollapsed) return;
        const doc = companionDoc;
        const scale = effectiveScale;
        const version = info.version;
        const isCurrent = () => companionDoc === doc && pageWrappers.get(pageNum) === info && info.version === version;
        info.rendering = true;
        try {
            const page = await doc.getPage(pageNum);
            if (!isCurrent()) return;
            const viewport = page.getViewport({ scale });
            // 后台画完再交换；旧画布留在屏幕上，缩放时不会被清成白页。
            const canvas = document.createElement('canvas');
            canvas.className = 'cp-page-canvas';
            const ctx = canvas.getContext('2d', { alpha: false });
            const dpr = window.devicePixelRatio || 1;

            canvas.width = Math.floor(viewport.width * dpr);
            canvas.height = Math.floor(viewport.height * dpr);

            // 🚀 使用标准 transform 参数实现 Retina/高分屏视网膜高清渲染
            const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
            const renderTask = page.render({
                canvasContext: ctx,
                viewport: viewport,
                transform: transform
            });
            info.renderTask = renderTask;
            await renderTask.promise;
            if (!isCurrent()) return;
            info.renderTask = null;
            const textLayer = document.createElement('div');
            textLayer.className = 'cp-text-layer textLayer';
            await renderTextLayer(page, viewport, textLayer, info, isCurrent);
            if (!isCurrent()) return;
            info.canvas.replaceWith(canvas);
            info.textLayer.replaceWith(textLayer);
            info.canvas.width = info.canvas.height = 1;
            info.canvas = canvas;
            info.textLayer = textLayer;
            info.rendered = true;
            info.wrapper.dataset.renderedScale = String(scale);
        } catch (err) {
            if (isCurrent() && err?.name !== 'RenderingCancelledException') {
                console.warn(`页面 ${pageNum} 渲染受挫:`, err);
            }
        } finally {
            info.renderTask = null;
            info.textTask = null;
            info.rendering = false;
            if (companionDoc === doc && pageWrappers.get(pageNum) === info && info.version !== version) scheduleVisiblePages();
        }
    }

    // ---------- 渲染文本图层 ----------
    async function renderTextLayer(page, viewport, textLayerDiv, info, isCurrent) {
        try {
            textLayerDiv.replaceChildren();
            textLayerDiv.style.width = Math.floor(viewport.width) + 'px';
            textLayerDiv.style.height = Math.floor(viewport.height) + 'px';
            textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale));

            const textContent = await page.getTextContent();
            if (!isCurrent()) return;
            if (pdfjsLib.renderTextLayer) {
                const textTask = pdfjsLib.renderTextLayer({
                    textContentSource: textContent,
                    textContent: textContent,
                    container: textLayerDiv,
                    viewport: viewport,
                    textDivs: []
                });
                info.textTask = textTask;
                if (textTask && textTask.promise) {
                    await textTask.promise;
                }
            }
        } catch (_) {
            // 文本图层失败不阻碍页面图形浏览
        }
    }

    // ---------- 离开视口回收页面 Canvas ----------
    function recyclePage(pageNum) {
        const info = pageWrappers.get(pageNum);
        if (!info || (!info.rendered && !info.rendering && info.canvas.width <= 1)) return;
        info.version++;
        if (info.renderTask) {
            try { info.renderTask.cancel(); } catch (_) {}
            info.renderTask = null;
        }
        try { info.textTask?.cancel(); } catch (_) {}
        const canvas = info.canvas;
        canvas.width = 1;
        canvas.height = 1;
        info.textLayer.replaceChildren();
        info.rendered = false;
        delete info.wrapper.dataset.renderedScale;
    }

    // ---------- 缩放计算与应用 ----------
    function normalizeScale(mode) {
        if (mode === 'fit-width' || mode === 'fit-page') return mode;
        const value = Number(mode);
        return Number.isFinite(value) && value > 0 ? Math.max(0.25, Math.min(4, value)) : 'fit-width';
    }

    function capturePosition(point) {
        if (!viewportEl || !pageWrappers.size) return null;
        const view = viewportEl.getBoundingClientRect();
        const x = point?.x ?? view.left + view.width / 2;
        const y = point?.y ?? view.top + 14;
        let page = currentPage;
        for (const [pageNum, info] of pageWrappers) {
            if (info.wrapper.getBoundingClientRect().bottom > y) { page = pageNum; break; }
        }
        const rect = pageWrappers.get(page)?.wrapper.getBoundingClientRect();
        if (!rect?.width || !rect.height) return null;
        return { page, x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height, offsetX: x - view.left, offsetY: y - view.top };
    }

    function restorePosition(position) {
        if (!position || !['page', 'x', 'y', 'offsetX', 'offsetY'].every(key => Number.isFinite(position[key]))) return;
        const info = pageWrappers.get(position.page);
        if (!info) return;
        const view = viewportEl.getBoundingClientRect();
        const rect = info.wrapper.getBoundingClientRect();
        viewportEl.scrollLeft += rect.left + position.x * rect.width - view.left - Math.min(view.width, Math.max(0, position.offsetX));
        viewportEl.scrollTop += rect.top + position.y * rect.height - view.top - Math.min(view.height, Math.max(0, position.offsetY));
    }

    function queueZoom() {
        if (zoomFrame !== null) return;
        zoomFrame = requestAnimationFrame(() => { zoomFrame = null; applyZoom(); });
    }

    function applyZoom(position = null, force = false) {
        if (!companionDoc || !numPages || !isOpen || isCollapsed || !viewportEl.clientWidth) return;

        const viewportWidth = Math.max(100, viewportEl.clientWidth - 28);
        const viewportHeight = Math.max(100, viewportEl.clientHeight - 28);
        const targetPage = currentPage;
        const previousScale = effectiveScale;
        position = position || capturePosition();

        if (currentScaleMode === 'fit-width') {
            const baseDim = pageDimensions[targetPage - 1] || pageDimensions[0] || { width: 595, height: 842 };
            effectiveScale = Math.min(4, viewportWidth / baseDim.width);
        } else if (currentScaleMode === 'fit-page') {
            const baseDim = pageDimensions[targetPage - 1] || pageDimensions[0] || { width: 595, height: 842 };
            const scaleW = viewportWidth / baseDim.width;
            const scaleH = viewportHeight / baseDim.height;
            effectiveScale = Math.min(4, scaleW, scaleH);
        } else {
            effectiveScale = Number(currentScaleMode) || 1.0;
        }

        const changed = force || Math.abs(previousScale - effectiveScale) > 0.0001;
        // 整个页面容器至少有最宽页的宽度，放大后左边内容也可滚动到。
        const maxWidth = Math.max(...pageDimensions.map(dim => Math.round(dim.width * effectiveScale)));
        pagesContainer.style.width = Math.max(viewportEl.clientWidth - 24, maxWidth) + 'px';
        for (let i = 1; i <= numPages; i++) {
            const dim = pageDimensions[i - 1];
            const info = pageWrappers.get(i);
            if (!info) continue;

            const w = Math.round(dim.width * effectiveScale);
            const h = Math.round(dim.height * effectiveScale);
            info.wrapper.style.width = w + 'px';
            info.wrapper.style.height = h + 'px';

            if (changed) {
                info.version++;
                info.rendered = false;
                try { info.renderTask?.cancel(); } catch (_) {}
                try { info.textTask?.cancel(); } catch (_) {}
                const layerScale = Number(info.wrapper.dataset.renderedScale);
                if (layerScale) info.textLayer.style.transform = `scale(${effectiveScale / layerScale})`;
            }
        }
        restorePosition(position);
        scheduleVisiblePages();
    }

    function zoomStep(delta, point = null) {
        const position = capturePosition(point);
        let current = effectiveScale;
        let next = Math.max(0.25, Math.min(4, Math.round((current + delta) * 4) / 4));
        currentScaleMode = next;
        syncZoomSelectUI(next);
        applyZoom(position);
        saveState();
    }

    function syncZoomSelectUI(scale) {
        if (!zoomSelect) return;
        if (currentScaleMode === 'fit-width' || currentScaleMode === 'fit-page') {
            zoomSelect.value = currentScaleMode;
            return;
        }
        zoomSelect.querySelector('[data-custom-scale]')?.remove();
        let match = Array.from(zoomSelect.options).find(opt => Number(opt.value) === Number(scale));
        if (!match) {
            match = document.createElement('option');
            match.value = String(scale);
            match.textContent = Math.round(Number(scale) * 100) + '%';
            match.dataset.customScale = 'true';
            zoomSelect.appendChild(match);
        }
        zoomSelect.value = match.value;
    }

    function scheduleVisiblePages() {
        if (renderFrame !== null) return;
        renderFrame = requestAnimationFrame(() => {
            renderFrame = null;
            if (!isOpen || isCollapsed || !companionDoc) return;
            const view = viewportEl.getBoundingClientRect();
            const visible = new Set(getVisiblePages());
            for (const [pageNum, info] of pageWrappers) {
                if (visible.has(pageNum)) renderPage(pageNum);
                else {
                    const rect = info.wrapper.getBoundingClientRect();
                    if (rect.bottom < view.top - 1200 || rect.top > view.bottom + 1200) recyclePage(pageNum);
                }
            }
        });
    }

    // ---------- 获取当前进入视口的页码 ----------
    function getVisiblePages() {
        const visible = [];
        const viewRect = viewportEl.getBoundingClientRect();
        for (const [pageNum, info] of pageWrappers.entries()) {
            const r = info.wrapper.getBoundingClientRect();
            if (r.bottom >= viewRect.top - 100 && r.top <= viewRect.bottom + 100) {
                visible.push(pageNum);
            }
        }
        return visible.length ? visible : [currentPage];
    }

    // ---------- 滚动检测更新当前页码 ----------
    function onViewportScroll() {
        scheduleVisiblePages();
        if (isNavigating) return;
        if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
        scrollDebounceTimer = setTimeout(() => {
            if (isNavigating) return;
            const viewRect = viewportEl.getBoundingClientRect();
            const centerY = viewRect.top + Math.min(140, viewRect.height * 0.4);
            let closestPage = currentPage;
            for (const [pageNum, info] of pageWrappers.entries()) {
                const r = info.wrapper.getBoundingClientRect();
                if (r.bottom > centerY) {
                    closestPage = pageNum;
                    break;
                }
            }

            if (closestPage !== currentPage) {
                currentPage = closestPage;
                if (document.activeElement !== pageInput) pageInput.value = currentPage;
                updateNavButtons();
            }
            saveState();
        }, 50);
    }

    // ---------- 跳转至指定页 ----------
    function goToPage(targetPage, smooth = true) {
        if (!numPages || !Number.isInteger(targetPage) || targetPage < 1 || targetPage > numPages) return;
        currentPage = targetPage;
        applyZoom();
        pageInput.value = currentPage;
        updateNavButtons();

        isNavigating = true;
        clearTimeout(navigatingTimer);
        navigatingTimer = setTimeout(() => { isNavigating = false; }, 350);

        const info = pageWrappers.get(targetPage);
        if (info) {
            const nearby = Math.abs(info.wrapper.offsetTop - viewportEl.scrollTop) < viewportEl.clientHeight * 1.5;
            viewportEl.scrollTo({ top: info.wrapper.offsetTop, left: 0, behavior: smooth && nearby && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
            renderPage(targetPage);
        }
        saveState();
    }

    // ---------- 目录大纲解析与呈现 ----------
    async function loadOutline(doc = companionDoc) {
        outlineItems = [];
        outlineList.replaceChildren();
        if (!doc) return;

        try {
            const rawOutline = await doc.getOutline();
            if (doc !== companionDoc) return;
            if (rawOutline && rawOutline.length) {
                outlineItems = rawOutline;
                outlineBtn.style.display = 'inline-flex';
                renderOutlineTree(outlineItems, outlineList, doc);
            } else {
                outlineBtn.style.display = 'none';
            }
        } catch (_) {
            if (doc === companionDoc) outlineBtn.style.display = 'none';
        }
    }

    function renderOutlineTree(items, container, doc) {
        items.forEach(item => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'cp-outline-item';
            row.textContent = item.title;
            row.title = item.title;

            row.addEventListener('click', async (e) => {
                e.stopPropagation();
                panel.querySelectorAll('.cp-outline-item.active').forEach(el => el.classList.remove('active'));
                row.classList.add('active');
                if (item.dest) {
                    try {
                        let dest = item.dest;
                        if (typeof dest === 'string') dest = await doc.getDestination(dest);
                        if (Array.isArray(dest)) {
                            const pageIndex = Number.isInteger(dest[0]) ? dest[0] : await doc.getPageIndex(dest[0]);
                            if (doc !== companionDoc) return;
                            goToPage(pageIndex + 1, false);
                            toggleOutline(false);
                            panel.focus({ preventScroll: true });
                        }
                    } catch (_) {}
                }
            });

            container.appendChild(row);

            if (item.items && item.items.length) {
                const sub = document.createElement('div');
                sub.className = 'cp-outline-sub';
                renderOutlineTree(item.items, sub, doc);
                container.appendChild(sub);
            }
        });
    }

    function toggleOutline(force) {
        const show = force !== undefined ? force : outlineDrawer.hidden;
        outlineDrawer.hidden = !show;
        outlineBtn.classList.toggle('active', show);
        outlineBtn.setAttribute('aria-expanded', String(show));
    }

    // ---------- 折叠 / 展开 ----------
    function toggleCollapsed() {
        if (!panel || panel.hidden) return;
        setCollapsed(!isCollapsed);
    }

    function setCollapsed(collapse) {
        if (!panel) return;
        if (collapse === isCollapsed) return;
        if (collapse) lastReadingPosition = capturePosition() || loadSavedState().position || null;
        isCollapsed = !!collapse;
        panel.classList.toggle('cp-collapsed', isCollapsed);

        if (isCollapsed) {
            if (handDrag.isDragging) endHandDrag();
            isSpaceDown = false;
            updateHandCursor();
            const currentH = panel.getBoundingClientRect().height;
            if (currentH > 40) expandedHeight = currentH;
            panel.style.height = '40px';
            collapseBtn.title = '展开小窗阅读 (P)';
            collapseBtn.setAttribute('aria-label', '展开');
            collapseBtn.innerHTML = '<i class="ph ph-caret-down"></i>';
            if (shortcutBtn) {
                const act = shortcutBtn.querySelector('.ws-action');
                if (act) act.textContent = '展开';
                shortcutBtn.title = '展开小窗阅读 (快捷键: P)';
                shortcutBtn.setAttribute('aria-label', '展开小窗 (P)');
            }
        } else {
            panel.style.height = expandedHeight + 'px';
            collapseBtn.title = '折叠为标题栏 (P)';
            collapseBtn.setAttribute('aria-label', '折叠');
            collapseBtn.innerHTML = '<i class="ph ph-caret-up"></i>';
            if (shortcutBtn) {
                const act = shortcutBtn.querySelector('.ws-action');
                if (act) act.textContent = '折叠';
                shortcutBtn.title = '折叠为标题栏 (快捷键: P)';
                shortcutBtn.setAttribute('aria-label', '折叠小窗 (P)');
            }
            clampPosition();
            applyZoom();
            restorePosition(lastReadingPosition);
            scheduleVisiblePages();
        }
        collapseBtn.setAttribute('aria-expanded', String(!isCollapsed));
        saveState();
    }

    // ---------- 半屏贴靠对比 (Dock) ----------
    function toggleDock() {
        if (!panel || panel.hidden) return;
        setDocked(!isDocked);
    }

    function setDocked(dock) {
        if (!panel) return;
        if (dock === isDocked) return;
        const position = capturePosition();
        if (dock && isCollapsed) setCollapsed(false);
        isDocked = !!dock;
        panel.classList.toggle('cp-docked', isDocked);
        dockBtn.classList.toggle('active', isDocked);
        dockBtn.setAttribute('aria-pressed', String(isDocked));

        if (isDocked) {
            const r = panel.getBoundingClientRect();
            savedFloatingRect = { x: r.left, y: r.top, w: r.width, h: r.height };

            // 贴靠在屏幕右半侧（宽约 48%~50%，高自适应顶栏到底部）
            layoutDocked(Math.floor(window.innerWidth * 0.48));
            dockBtn.title = '还原为浮动小窗';
        } else {
            dockBtn.title = '半屏贴靠对比 (再次点击恢复浮动)';
            if (savedFloatingRect) {
                panel.style.left = savedFloatingRect.x + 'px';
                panel.style.top = savedFloatingRect.y + 'px';
                panel.style.width = savedFloatingRect.w + 'px';
                panel.style.height = savedFloatingRect.h + 'px';
                expandedHeight = savedFloatingRect.h;
            }
            clampPosition();
        }
        applyZoom(position);
        saveState();
    }

    function layoutDocked(width) {
        const maxWidth = Math.max(1, window.innerWidth - 16);
        const dockWidth = Math.min(maxWidth, Math.max(Math.min(MIN_W, maxWidth), width));
        const height = Math.max(40, window.innerHeight - HEADER_HEIGHT - 14);
        panel.style.left = (window.innerWidth - dockWidth - 8) + 'px';
        panel.style.top = (HEADER_HEIGHT + 6) + 'px';
        panel.style.width = dockWidth + 'px';
        panel.style.height = (isCollapsed ? 40 : height) + 'px';
        expandedHeight = height;
    }

    // ---------- 显示 / 隐藏 / 切换 ----------
    function show() {
        ensureDom();
        refreshQuickFolderChips?.();
        if (!isOpen) returnFocus = document.activeElement;
        panel.hidden = false;
        isOpen = true;
        if (!restoredLayout) {
            restoredLayout = true;
            const saved = loadSavedState();
            clampPosition();
            if (saved.docked) {
                setDocked(true);
                if (Number.isFinite(saved.dockWidth)) layoutDocked(saved.dockWidth);
            }
            if (saved.collapsed) setCollapsed(true);
        }
        bringToFront();
        panel.focus({ preventScroll: true });
        syncOpenButton();
        clampPosition();
        if (currentScaleMode === 'fit-width' || currentScaleMode === 'fit-page') applyZoom();
        scheduleVisiblePages();
    }

    function hide() {
        if (!panel) return;
        saveState();
        if (isHandToolActive) {
            isHandToolActive = false;
            handBtn?.classList.remove('active');
        }
        isSpaceDown = false;
        endHandDrag();
        if (typeof state !== 'undefined' && state?.handDrag) {
            state.handDrag.isSpaceDown = false;
            state.handDrag.isDragging = false;
            const container = document.getElementById('viewer-container');
            if (container && !state.isHandToolActive) {
                container.style.cursor = '';
            }
        }
        const hadFocus = panel.contains(document.activeElement);
        panel.hidden = true;
        isOpen = false;
        panel.classList.remove('cp-focused');
        syncOpenButton();
        if (hadFocus) returnFocus?.focus?.({ preventScroll: true });
    }

    function toggle() {
        if (isOpen && !panel.hidden) {
            hide();
        } else {
            show();
        }
    }

    // ---------- 对外公开接口 ----------
    window.CompanionPdf = {
        show,
        hide,
        toggle,
        loadFile,
        openFilePicker,
        goToPage,
        setZoom: (mode) => {
            currentScaleMode = normalizeScale(mode);
            syncZoomSelectUI(currentScaleMode);
            applyZoom();
            saveState();
        },
        isOpen: () => isOpen,
        isCollapsed: () => isCollapsed,
        isDocked: () => isDocked,
        isHandToolActive: () => isHandToolActive,
        setHandTool: (active) => {
            isHandToolActive = !!active;
            handBtn?.classList.toggle('active', isHandToolActive);
            if (!isHandToolActive && handDrag.isDragging) endHandDrag();
            updateHandCursor();
        }
    };

    // 菜单只显示窗口；选文件由窗口内的按钮发起。
    function initToolbarButtons() {
        const openCompBtn = document.getElementById('open-companion-btn');
        if (openCompBtn && !openCompBtn._cpBound) {
            openCompBtn._cpBound = true;
            openCompBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                show();
            });
        }
    }

    // 在惰性创建 DOM 之前绑定，首次按 F10 也能打开窗口。
    window.addEventListener('keydown', e => {
        if (e.key !== 'F10' || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        toggle();
    }, true);

    // 小窗显示时按 P 快捷键折叠/展开；输入文字、组合快捷键（如 Ctrl+P 打印）、思维导图焦点和长按不受影响。
    document.addEventListener('keydown', e => {
        if (!isOpen || !panel || panel.hidden || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.code !== 'KeyP' && e.key.toLowerCase() !== 'p') return;
        const isEditing = el => el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
        if (isEditing(e.target) || isEditing(document.activeElement)) return;
        const inMindmap = el => el?.closest?.('#mindmap-panel, #mm-popover-dialog, #mm-context-menu');
        if (inMindmap(e.target) || inMindmap(document.activeElement)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) toggleCollapsed();
    }, true);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initToolbarButtons);
    } else {
        initToolbarButtons();
    }
})();
