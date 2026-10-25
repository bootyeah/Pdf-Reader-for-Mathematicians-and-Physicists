// =============================================================================
// ⑨ 视频播放器 (Video Player) —— 悬浮播放器
// -----------------------------------------------------------------------------
// 功能：在不退出阅读器全屏的前提下，悬浮播放本地或在线课程视频。
//       - 拖动标题栏移动窗口，右下角拖动缩放。
//       - 原生 <video controls> 提供播放/进度/音量/全屏。
//       - 头部提供：打开视频 / 上一个与下一个 / 字幕 / 倍速(0.5x–3.0x) / 关闭。
//       - 框选放大：锁定播放器比例，悬停原画预览可拖动选区，顶部按钮取消。
//       - 快捷键：F9 唤出/收起；单按 Shift 折叠/展开；Z 减速 / X 加速（±0.1x）。
// 依赖：无（自包含 IIFE，DOM 惰性创建，遵循 dictionary.js 的模块范式）。
// 说明：本地服务选择视频后登记同目录播放列表，支持 HTTP Range 流式读取；
//       B 站扫码登录与清晰度通过本机服务处理，视频复用原生播放器与框选放大。
// =============================================================================

(function () {
    'use strict';

    // ---------- 内部引用 ----------
    let panel = null;
    let header = null;
    let video = null;
    let filenameEl = null;
    let headerShortcutBtn = null;
    let hintEl = null;
    let overlayEl = null;
    let speedSel = null;
    let openBtn = null;
    let urlBtn = null;
    let urlForm = null;
    let urlInput = null;
    let urlError = null;
    let urlSubmit = null;
    let onlineRequest = null;
    let biliRequest = null;
    let biliQuality = null;
    let biliActual = null;
    let biliLoginBtn = null;
    let biliLogoutBtn = null;
    let biliLoginCard = null;
    let biliLoginTimer = null;
    let biliLoginRequest = null;
    let biliLoginGeneration = 0;
    let restorePlaybackListener = null;
    let dashPlayer = null;
    let dashLibraryPromise = null;
    let previousBtn = null;
    let nextBtn = null;
    let fullscreenBtn = null;
    let subtitleBtn = null;
    let subtitleReplaceBtn = null;
    let collapseBtn = null;
    let closeBtn = null;
    let hudEl = null;
    let toolbarBtn = null;
    let resizeHandle = null;
    let cropBtn = null;
    let cropSurface = null;
    let cropBox = null;
    let cropPreview = null;
    let cropSelecting = false;
    let cropRegion = null; // 原视频坐标，x/y/w/h 均为 0–1 的比例。
    let cropGesture = null;
    let cropFrame = null;

    let videoBlobUrl = null;
    let playlist = [];
    let playlistIndex = -1;
    let videoFolder = '';
    let pickingVideo = false;
    let subtitleBlobUrl = null;
    let subtitleEnabled = false;
    let subtitleFilename = '';
    let subtitleLoadId = 0;
    let panelVisible = false;
    let isCollapsed = false;
    let hudTimer = null;
    let isMouseOverPanel = false;

    const STORAGE_KEY = 'pdf_reader_video_companion_state';

    // 顶部工具栏高度（与 LOCALPdfReader.html 里 header 的 h-[72px] 保持一致）：
    // 悬浮播放器与其它浮层的 top 下限，避免被顶栏压住
    const HEADER_HEIGHT = 72;

    // 倍速边界（以 0.1 为步进的十分位整数表示，避免浮点误差累积）
    const RATE_MIN_TENTHS = 5;    // 0.5x
    const RATE_MAX_TENTHS = 30;   // 3.0x

    function rateToTenths(r) { return Math.round(Number(r) * 10); }
    function currentTenths() { return rateToTenths(video ? video.playbackRate : 1); }

    // ---------- HUD 瞬态浮层反馈 ----------
    function showHud(text) {
        if (!hudEl) return;
        hudEl.textContent = text;
        hudEl.classList.add('show');
        if (hudTimer) clearTimeout(hudTimer);
        hudTimer = setTimeout(function () {
            if (hudEl) hudEl.classList.remove('show');
        }, 750);
    }

    // ---------- 顶部工具栏状态联动（中性雅致） ----------
    function syncToolbarButton(visible) {
        if (!toolbarBtn) toolbarBtn = document.getElementById('video-btn');
        if (!toolbarBtn) return;
        if (visible) {
            toolbarBtn.classList.add('bg-gray-100', 'text-gray-800');
            toolbarBtn.classList.remove('text-gray-600');
        } else {
            toolbarBtn.classList.remove('bg-gray-100', 'text-gray-800');
            toolbarBtn.classList.add('text-gray-600');
        }
    }

    // ---------- DOM 构建 ----------
    function ensureDom() {
        if (panel) return;

        const speedOptions =
            '<option value="0.5">0.5x</option>' +
            '<option value="1.0" selected>1.0x</option>' +
            '<option value="2.0">2.0x</option>' +
            '<option value="3.0">3.0x</option>';

        panel = document.createElement('div');
        panel.id = 'video-panel';
        panel.className = 'video-panel';
        panel.innerHTML =
            '<div class="video-panel-header" id="video-panel-header">' +
                '<div class="video-panel-brand">' +
                    '<i class="ph ph-video-camera text-zinc-400 text-[15px]"></i>' +
                    '<strong class="video-panel-title" id="video-panel-title" title="视频伴读">视频伴读</strong>' +
                    '<button type="button" class="window-shortcut-btn video-shortcut-btn" id="video-header-shortcut-btn" title="折叠播放器 (快捷键: Shift)" aria-label="折叠视频窗口 (Shift)">' +
                        '<span class="ws-action">折叠</span>' +
                        '<kbd class="ws-key">Shift</kbd>' +
                    '</button>' +
                '</div>' +
                '<span class="video-panel-filename" id="video-panel-filename" style="display:none;" title=""></span>' +
                '<div class="video-panel-spacer"></div>' +
                '<select id="video-speed" class="video-speed" title="播放速度 (Z 减速 / X 加速)">' + speedOptions + '</select>' +
                '<button type="button" class="video-panel-btn" id="video-previous-btn" title="上一个视频" aria-label="上一个视频" disabled>' +
                    '<i class="ph ph-skip-back text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn" id="video-next-btn" title="下一个视频" aria-label="下一个视频" disabled>' +
                    '<i class="ph ph-skip-forward text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn" id="video-fullscreen-btn" title="视频全屏（双击画面）" aria-label="视频全屏" style="display:none;">' +
                    '<i class="ph ph-arrows-out text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn" id="video-open-btn" title="打开本地视频">' +
                    '<i class="ph ph-folder-open text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn" id="video-url-btn" title="打开在线视频" aria-label="打开在线视频" aria-expanded="false">' +
                    '<i class="ph ph-link text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn" id="video-subtitle-btn" title="加载字幕 (.srt / .vtt)">' +
                    '<i class="ph ph-closed-captioning text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn" id="video-subtitle-replace-btn" title="更换字幕 (.srt / .vtt)" aria-label="更换字幕" style="display:none;">' +
                    '<i class="ph ph-arrows-clockwise text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn" id="video-crop-btn" title="框选放大" aria-label="框选放大" aria-pressed="false" disabled>' +
                    '<i class="ph ph-crop text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn" id="video-collapse-btn" title="折叠播放器 (Shift)" aria-expanded="true">' +
                    '<i class="ph ph-caret-up text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn video-panel-btn-close" id="video-close-btn" title="关闭播放器 (F9)">' +
                    '<i class="ph ph-x text-[15px]"></i>' +
                '</button>' +
            '</div>' +
            '<div style="position:relative; flex:1; min-height:0; display:flex; flex-direction:column; background:#18181b; overflow:hidden;">' +
                '<form id="video-url-form" class="video-url-form" hidden>' +
                    '<div class="video-url-row">' +
                        '<input id="video-url-input" type="url" required maxlength="4096" autocomplete="off" placeholder="B 站网址或视频直链" aria-label="在线视频网址" aria-describedby="video-url-error">' +
                        '<button type="submit" id="video-url-submit">播放</button>' +
                        '<button type="button" id="video-url-cancel" aria-label="取消输入网址" title="取消"><i class="ph ph-x"></i></button>' +
                    '</div>' +
                    '<div class="video-bili-row">' +
                        '<button type="button" id="video-bili-login" title="使用 B 站 App 扫码登录">B 站登录</button>' +
                        '<button type="button" id="video-bili-logout" title="退出本机 B 站登录" hidden>退出</button>' +
                        '<span id="video-bili-actual"></span>' +
                        '<select id="video-bili-quality" aria-label="B 站清晰度" title="按账号可用权限播放，登录后可用高清">' +
                            '<option value="80">1080P</option><option value="64">720P</option>' +
                            '<option value="32">480P</option><option value="16">360P</option>' +
                        '</select>' +
                    '</div>' +
                    '<div id="video-bili-login-card" class="video-bili-login-card" hidden>' +
                        '<img id="video-bili-qr" alt="B 站登录二维码">' +
                        '<div id="video-bili-login-status" role="status">使用 B 站 App 扫码并确认登录</div>' +
                        '<button type="button" id="video-bili-login-retry" hidden>刷新二维码</button>' +
                    '</div>' +
                    '<div id="video-url-error" class="video-url-error" role="status" aria-live="polite"></div>' +
                '</form>' +
                '<video id="video-element" controls playsinline disablepictureinpicture="true" controlslist="nodownload nopictureinpicture" preload="metadata" style="display:none;"></video>' +
                '<div id="video-overlay" class="video-overlay" title="点击播放/暂停 · 双击全屏"></div>' +
                '<div id="video-crop-surface" class="video-crop-surface" hidden>' +
                    '<canvas id="video-crop-preview" hidden></canvas>' +
                    '<div id="video-crop-box" class="video-crop-box" hidden></div>' +
                '</div>' +
                '<div id="video-speed-hud" class="video-hud-badge">1.0x</div>' +
                '<div class="video-panel-hint" id="video-panel-hint" title="点击选择本地视频，或直接拖拽文件至此处">' +
                    '<i class="ph ph-video-camera"></i>' +
                '</div>' +
            '</div>' +
            '<div class="video-resize-handle" title="按住等比例缩放窗口">' +
                '<svg viewBox="0 0 6 6" class="w-2.5 h-2.5" style="fill:#71717a;"><circle cx="5" cy="5" r="0.8"/><circle cx="5" cy="2" r="0.8"/><circle cx="2" cy="5" r="0.8"/></svg>' +
            '</div>';
        document.body.appendChild(panel);

        header = panel.querySelector('#video-panel-header');
        video = panel.querySelector('#video-element');
        filenameEl = panel.querySelector('#video-panel-filename');
        hintEl = panel.querySelector('#video-panel-hint');
        overlayEl = panel.querySelector('#video-overlay');
        speedSel = panel.querySelector('#video-speed');
        openBtn = panel.querySelector('#video-open-btn');
        urlBtn = panel.querySelector('#video-url-btn');
        urlForm = panel.querySelector('#video-url-form');
        urlInput = panel.querySelector('#video-url-input');
        urlError = panel.querySelector('#video-url-error');
        urlSubmit = panel.querySelector('#video-url-submit');
        biliQuality = panel.querySelector('#video-bili-quality');
        biliActual = panel.querySelector('#video-bili-actual');
        biliLoginBtn = panel.querySelector('#video-bili-login');
        biliLogoutBtn = panel.querySelector('#video-bili-logout');
        biliLoginCard = panel.querySelector('#video-bili-login-card');
        previousBtn = panel.querySelector('#video-previous-btn');
        nextBtn = panel.querySelector('#video-next-btn');
        fullscreenBtn = panel.querySelector('#video-fullscreen-btn');
        subtitleBtn = panel.querySelector('#video-subtitle-btn');
        subtitleReplaceBtn = panel.querySelector('#video-subtitle-replace-btn');
        collapseBtn = panel.querySelector('#video-collapse-btn');
        headerShortcutBtn = panel.querySelector('#video-header-shortcut-btn');
        closeBtn = panel.querySelector('#video-close-btn');
        hudEl = panel.querySelector('#video-speed-hud');
        resizeHandle = panel.querySelector('.video-resize-handle');
        cropBtn = panel.querySelector('#video-crop-btn');
        cropSurface = panel.querySelector('#video-crop-surface');
        cropBox = panel.querySelector('#video-crop-box');
        cropPreview = panel.querySelector('#video-crop-preview');

        toolbarBtn = document.getElementById('video-btn');

        bindEvents();
        panel.style.display = 'none';

        restoreWindowState();
    }

    // ---------- 事件绑定 ----------
    function bindEvents() {
        openBtn.addEventListener('click', function (e) { e.stopPropagation(); openVideo(); });
        urlBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleUrlInput(urlForm.hidden); });
        urlForm.addEventListener('submit', openOnlineVideo);
        urlInput.addEventListener('input', function () { cancelOnlineRequest(); cancelBiliPlayback(); urlError.textContent = ''; });
        biliLoginBtn.addEventListener('click', startBiliLogin);
        panel.querySelector('#video-bili-login-retry').addEventListener('click', startBiliLogin);
        biliLogoutBtn.addEventListener('click', async function () {
            stopBiliLogin();
            try { await biliApi({ action: 'logout' }); syncBiliAccount({ loggedIn: false }); }
            catch (error) { urlError.textContent = error.message; }
        });
        biliQuality.addEventListener('change', function () {
            if (playlist[playlistIndex] && playlist[playlistIndex].kind === 'bilibili') {
                playPlaylistItem(playlistIndex, playlist, true);
            }
        });
        panel.querySelector('#video-url-cancel').addEventListener('click', function () { toggleUrlInput(false); });
        urlForm.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); toggleUrlInput(false); urlBtn.focus(); }
        });
        previousBtn.addEventListener('click', function (e) { e.stopPropagation(); playPlaylistItem(playlistIndex - 1); });
        nextBtn.addEventListener('click', function (e) { e.stopPropagation(); playPlaylistItem(playlistIndex + 1); });
        fullscreenBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleVideoFullscreen(); });
        subtitleBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!subtitleBlobUrl) { openSubtitle(); return; }
            setSubtitleEnabled(!subtitleEnabled);
            showHud(subtitleEnabled ? '字幕已开启' : '字幕已关闭');
        });
        subtitleReplaceBtn.addEventListener('click', function (e) { e.stopPropagation(); openSubtitle(); });
        closeBtn.addEventListener('click', function (e) { e.stopPropagation(); hidePanel(); });
        collapseBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleCollapse(); });
        if (headerShortcutBtn) {
            headerShortcutBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleCollapse();
            });
        }

        hintEl.addEventListener('click', function (e) {
            openVideo();
        });

        // 覆盖层：拦截 Edge 视频悬停工具，单机播放/暂停，双击全屏
        let overlayClickTimer = null;
        cropBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            clearTimeout(overlayClickTimer);
            overlayClickTimer = null;
            if (cropSelecting || cropRegion) { clearCrop(); return; }
            if (isCollapsed) toggleCollapse();
            cropSelecting = true;
            updateCropLayout();
            showHud('拖动框选 · 顶部图标取消');
        });
        cropSurface.addEventListener('pointerdown', startCropGesture);
        cropSurface.addEventListener('pointermove', moveCropGesture);
        cropSurface.addEventListener('pointerup', finishCropGesture);
        cropSurface.addEventListener('pointercancel', cancelCropGesture);
        cropSurface.addEventListener('lostpointercapture', cancelCropGesture);
        cropSurface.addEventListener('click', function (e) { e.stopPropagation(); });
        new ResizeObserver(updateCropLayout).observe(video);
        ['loadeddata', 'seeked', 'play', 'pause', 'ended'].forEach(function (eventName) {
            video.addEventListener(eventName, refreshCropPreview);
        });
        document.addEventListener('visibilitychange', refreshCropPreview);
        if (overlayEl) {
            overlayEl.addEventListener('click', function (e) {
                e.stopPropagation();
                if (overlayClickTimer) {
                    clearTimeout(overlayClickTimer);
                    overlayClickTimer = null;
                    toggleVideoFullscreen();
                    return;
                }
                overlayClickTimer = setTimeout(function () {
                    overlayClickTimer = null;
                    if (!video.src && !dashPlayer) { openVideo(); return; }
                    if (video.paused) {
                        video.play();
                        showHud('播放');
                    } else {
                        video.pause();
                        showHud('暂停');
                    }
                }, 220);
            });
        }

        speedSel.addEventListener('mousedown', function () {
            // 点开下拉列表时，移除自定义非标倍速项，只展示 0.5、1、2、3 四个标准选项
            const customOpt = speedSel.querySelector('option[data-custom]');
            if (customOpt) customOpt.remove();
        });
        speedSel.addEventListener('change', function () {
            setRateTenths(rateToTenths(parseFloat(speedSel.value) || 1));
            speedSel.blur();
        });

        // 视频播放状态联动
        video.addEventListener('play', function () {
            if (toolbarBtn) toolbarBtn.title = '视频播放器 (正在播放 · F9)';
        });
        video.addEventListener('pause', function () {
            if (toolbarBtn) toolbarBtn.title = '视频播放器 (F9)';
        });
        video.addEventListener('ended', function () {
            if (toolbarBtn) toolbarBtn.title = '视频播放器 (F9)';
        });
        video.addEventListener('error', function () {
            if (!video.getAttribute('src')) return;
            if (playlist[playlistIndex] && ['direct', 'bilibili'].includes(playlist[playlistIndex].kind)) {
                toggleUrlInput(true);
                urlError.textContent = '视频无法播放，请检查链接、网站访问权限或视频格式。';
            } else showHud('视频无法播放，请检查文件或切换视频');
        });
        video.textTracks.addEventListener('change', function () {
            const track = video.querySelector('track');
            if (!track) return;
            subtitleEnabled = track.track.mode === 'showing';
            syncSubtitleControls();
        });

        video.addEventListener('loadedmetadata', function () {
            updateHint();
            cropBtn.disabled = !video.videoWidth || !CSS.supports('object-view-box', 'inset(0%)');
            cropBtn.title = cropBtn.disabled ? '框选放大需要新版 Edge / Chrome' : '框选放大';
            if (video.videoWidth && video.videoHeight && !isCollapsed && document.fullscreenElement !== panel) {
                const ratio = video.videoWidth / video.videoHeight;
                const curW = panel.offsetWidth || 560;
                const contentH = Math.round(curW / ratio);
                const targetH = 38 + contentH;
                const maxH = window.innerHeight - panel.offsetTop - 16;
                if (targetH <= maxH) {
                    panel.style.height = targetH + 'px';
                } else {
                    const fitH = maxH;
                    const fitW = Math.max(280, Math.round((fitH - 38) * ratio));
                    panel.style.width = fitW + 'px';
                    panel.style.height = fitH + 'px';
                }
                saveWindowState();
            }
            updateCropLayout();
        });

        // 点击窗口时取消聚焦，防止出现蓝色/黑色聚焦轮廓线
        panel.addEventListener('mousedown', function (e) {
            if (e.target.closest('.video-url-form')) return;
            if (document.activeElement && document.activeElement !== speedSel && typeof document.activeElement.blur === 'function') {
                document.activeElement.blur();
            }
        });

        // 鼠标悬停状态追踪（辅助空格快捷键判定）
        panel.addEventListener('mouseenter', function () { isMouseOverPanel = true; });
        panel.addEventListener('mouseleave', function () { isMouseOverPanel = false; });

        // 拖拽文件到播放器直接加载 (Drag & Drop)
        ['dragenter', 'dragover'].forEach(function (evt) {
            panel.addEventListener(evt, function (e) {
                e.preventDefault();
                e.stopPropagation();
                panel.classList.add('drag-over');
            });
        });
        ['dragleave', 'drop'].forEach(function (evt) {
            panel.addEventListener(evt, function (e) {
                e.preventDefault();
                e.stopPropagation();
                panel.classList.remove('drag-over');
            });
        });
        panel.addEventListener('drop', async function (e) {
            const files = e.dataTransfer && e.dataTransfer.files;
            if (!files || files.length === 0) return;
            const file = files[0];
            const lower = file.name.toLowerCase();
            if (lower.endsWith('.srt') || lower.endsWith('.vtt')) {
                await loadSubtitle(file);
            } else {
                setPlaylist(Array.from(files).filter(isVideoFile), file);
            }
        });

        // 拖动标题栏移动窗口
        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
        function onDragMove(e) {
            if (!dragging) return;
            const left = Math.max(0, Math.min(sl + e.clientX - sx, window.innerWidth - 80));
            const top = Math.max(0, Math.min(st + e.clientY - sy, window.innerHeight - 48));
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
        }
        function onDragEnd() {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onDragMove, true);
            document.removeEventListener('mouseup', onDragEnd, true);
            saveWindowState();
        }
        header.addEventListener('mousedown', function (e) {
            if (document.fullscreenElement === panel) return;
            if (e.target.closest('.video-panel-btn') || e.target.closest('#video-speed')) return;
            e.preventDefault();
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            sl = panel.offsetLeft; st = panel.offsetTop;
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onDragMove, true);
            document.addEventListener('mouseup', onDragEnd, true);
        });

        // ---------- 右下角等比例缩放（锁定视频宽高比，杜绝黑边与黑底） ----------
        let resizing = false;
        let startW = 0, startH = 0, startMouseX = 0, startMouseY = 0;

        function getVideoAspectRatio() {
            if (video && video.videoWidth && video.videoHeight) {
                return video.videoWidth / video.videoHeight;
            }
            return 16 / 9;
        }

        function onResizeMove(e) {
            if (!resizing) return;
            const dx = e.clientX - startMouseX;
            const ratio = getVideoAspectRatio();
            const minW = 280;
            const maxW = Math.max(320, window.innerWidth - panel.offsetLeft - 16);
            const maxH = Math.max(180, window.innerHeight - panel.offsetTop - 16);

            let newW = Math.max(minW, Math.min(maxW, startW + dx));
            let contentH = Math.round(newW / ratio);
            let newH = 38 + contentH;

            if (newH > maxH) {
                newH = maxH;
                contentH = Math.max(80, newH - 38);
                newW = Math.round(contentH * ratio);
            }

            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
        }

        function onResizeEnd() {
            if (!resizing) return;
            resizing = false;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            document.removeEventListener('mousemove', onResizeMove, true);
            document.removeEventListener('mouseup', onResizeEnd, true);
            saveWindowState();
        }

        if (resizeHandle) {
            resizeHandle.addEventListener('mousedown', function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (isCollapsed || document.fullscreenElement === panel) return;
                resizing = true;
                startW = panel.offsetWidth;
                startH = panel.offsetHeight;
                startMouseX = e.clientX;
                startMouseY = e.clientY;
                document.body.style.userSelect = 'none';
                document.body.style.cursor = 'nwse-resize';
                document.addEventListener('mousemove', onResizeMove, true);
                document.addEventListener('mouseup', onResizeEnd, true);
            });
        }

        window.addEventListener('blur', function () {
            onDragEnd();
            onResizeEnd();
            cancelCropGesture();
        });

        // 窗口尺寸变化时防止浮窗越界
        window.addEventListener('resize', function () {
            if (!panel || !panelVisible) return;
            const curLeft = panel.offsetLeft;
            const curTop = panel.offsetTop;
            const maxLeft = Math.max(0, window.innerWidth - (panel.offsetWidth || 320));
            const maxTop = Math.max(0, window.innerHeight - 48);
            if (curLeft > maxLeft) panel.style.left = Math.max(8, maxLeft) + 'px';
            if (curTop > maxTop) panel.style.top = Math.max(HEADER_HEIGHT, maxTop) + 'px';
        });

        if (toolbarBtn) toolbarBtn.addEventListener('click', function () { togglePanel(); });

        // 单按 Shift 在松开时切换，组合键、输入和鼠标操作不触发；长按只切换一次。
        let shiftCollapsePending = false;
        let pointerDown = false;
        window.addEventListener('keydown', function (e) {
            if (e.key !== 'Shift') {
                shiftCollapsePending = false;
            } else if (!e.repeat) {
                shiftCollapsePending = panelVisible && !pointerDown && !isTypingTarget(e.target) &&
                    !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey;
            }
        }, true);
        window.addEventListener('keyup', function (e) {
            if (e.key !== 'Shift') { shiftCollapsePending = false; return; }
            const shouldToggle = shiftCollapsePending;
            shiftCollapsePending = false;
            if (shouldToggle && panelVisible && !isTypingTarget(e.target) &&
                !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) {
                toggleCollapse();
            }
        }, true);
        window.addEventListener('pointerdown', function () {
            pointerDown = true;
            shiftCollapsePending = false;
        }, true);
        ['pointerup', 'pointercancel'].forEach(function (eventName) {
            window.addEventListener(eventName, function () {
                pointerDown = false;
                shiftCollapsePending = false;
            }, true);
        });
        window.addEventListener('focusin', function (e) {
            if (isTypingTarget(e.target)) shiftCollapsePending = false;
        }, true);
        window.addEventListener('blur', function () {
            pointerDown = false;
            shiftCollapsePending = false;
        });

        // 快捷键支持
        document.addEventListener('keydown', function (e) {
            const isTyping = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);

            if (e.key === 'F9') {
                e.preventDefault();
                togglePanel();
                return;
            }

            if (isTyping || e.ctrlKey || e.metaKey || e.altKey) return;
            if (!video || !video.src) return;

            // Z / X 倍速微调（全局有效）
            if (e.key === 'z' || e.key === 'Z') {
                e.preventDefault();
                if (document.activeElement && typeof document.activeElement.blur === 'function') {
                    document.activeElement.blur();
                }
                setRateTenths(currentTenths() - 1);
            } else if (e.key === 'x' || e.key === 'X') {
                e.preventDefault();
                if (document.activeElement && typeof document.activeElement.blur === 'function') {
                    document.activeElement.blur();
                }
                setRateTenths(currentTenths() + 1);
            }

            // 悬停在播放器上时的快捷控制（避免与阅读器滚动冲突）
            if (isMouseOverPanel && panelVisible && !isCollapsed) {
                if (e.code === 'Space') {
                    e.preventDefault();
                    if (video.paused) {
                        video.play();
                        showHud('播放');
                    } else {
                        video.pause();
                        showHud('暂停');
                    }
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    video.currentTime = Math.max(0, video.currentTime - 5);
                    showHud('快退 5 秒');
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    video.currentTime = Math.min(video.duration || 99999, video.currentTime + 5);
                    showHud('快进 5 秒');
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    video.volume = Math.min(1, Math.round((video.volume + 0.1) * 10) / 10);
                    showHud('音量 ' + Math.round(video.volume * 100) + '%');
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    video.volume = Math.max(0, Math.round((video.volume - 0.1) * 10) / 10);
                    showHud('音量 ' + Math.round(video.volume * 100) + '%');
                }
            }
        });
    }

    function isTypingTarget(target) {
        return target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
    }

    // ---------- 固定比例框选放大 ----------
    function updateCropLayout() {
        const active = cropSelecting || !!cropRegion;
        panel.classList.toggle('is-crop-selecting', cropSelecting);
        panel.classList.toggle('is-crop-zoomed', !!cropRegion && !cropSelecting);
        cropBtn.classList.toggle('active', active);
        cropBtn.setAttribute('aria-pressed', String(active));
        if (!cropBtn.disabled) cropBtn.title = active ? '取消框选放大' : '框选放大';
        cropBtn.setAttribute('aria-label', cropBtn.title);
        cropSurface.hidden = !active;
        cropBox.hidden = !cropRegion;
        cropPreview.hidden = cropSelecting;
        const width = video.clientWidth, height = video.clientHeight;
        if (!active || !width || !height || !video.videoWidth || isCollapsed) {
            refreshCropPreview();
            return;
        }
        const ratio = video.videoWidth / video.videoHeight;
        if (cropSelecting) {
            // 排除 object-fit: contain 的黑边，框选坐标始终对应原画。
            const w = Math.min(width, height * ratio), h = w / ratio;
            Object.assign(cropSurface.style, {
                left: (width - w) / 2 + 'px', top: (height - h) / 2 + 'px',
                width: w + 'px', height: h + 'px'
            });
            cropSurface.title = '拖动框选放大 · 点击顶部裁剪图标取消';
        } else {
            // 视口改变时保持选区中心，继续锁定实际播放器画面的比例。
            const k = width / height / ratio;
            const cx = cropRegion.x + cropRegion.w / 2, cy = cropRegion.y + cropRegion.h / 2;
            cropRegion.h = Math.min(cropRegion.h, 1, 1 / k);
            cropRegion.w = cropRegion.h * k;
            cropRegion.x = Math.max(0, Math.min(1 - cropRegion.w, cx - cropRegion.w / 2));
            cropRegion.y = Math.max(0, Math.min(1 - cropRegion.h, cy - cropRegion.h / 2));
            const w = Math.min(144, width * 0.28, Math.max(24, height - 66) * ratio);
            Object.assign(cropSurface.style, {
                left: width - w - 10 + 'px', top: '10px', width: w + 'px', height: w / ratio + 'px'
            });
            cropPreview.width = Math.round(w * (window.devicePixelRatio || 1));
            cropPreview.height = Math.round(cropPreview.width / ratio);
            cropSurface.title = '拖动选区调整位置 · 点击其他位置移动选区';
        }
        applyCrop();
        refreshCropPreview();
    }

    function applyCrop() {
        cropBox.hidden = !cropRegion;
        if (cropRegion) {
            const r = cropRegion;
            Object.assign(cropBox.style, { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' });
            if (!cropSelecting) {
                // 只裁剪视频图像；原生控制条和外挂字幕保持原尺寸。
                video.style.setProperty('object-view-box', 'inset(' + [r.y, 1 - r.x - r.w, 1 - r.y - r.h, r.x].map(function (v) { return Math.max(0, v) * 100 + '%'; }).join(' ') + ')');
            }
        }
    }

    function cropPoint(e) {
        const rect = cropSurface.getBoundingClientRect();
        return { x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) };
    }

    function startCropGesture(e) {
        if (e.button !== 0 || cropGesture) return;
        e.preventDefault();
        e.stopPropagation();
        const point = cropPoint(e);
        if (!cropSelecting) {
            const r = cropRegion;
            if (point.x < r.x || point.x > r.x + r.w || point.y < r.y || point.y > r.y + r.h) {
                r.x = Math.max(0, Math.min(1 - r.w, point.x - r.w / 2));
                r.y = Math.max(0, Math.min(1 - r.h, point.y - r.h / 2));
                applyCrop();
            }
        }
        cropGesture = { id: e.pointerId, point: point, region: cropRegion && Object.assign({}, cropRegion) };
        cropSurface.setPointerCapture(e.pointerId);
    }

    function moveCropGesture(e) {
        if (!cropGesture || e.pointerId !== cropGesture.id) return;
        e.preventDefault();
        const p = cropPoint(e), start = cropGesture.point;
        if (cropSelecting) {
            const dx = p.x - start.x, dy = p.y - start.y;
            const k = video.clientWidth / video.clientHeight / (video.videoWidth / video.videoHeight);
            const w = Math.min(Math.max(Math.abs(dx), Math.abs(dy) * k), dx < 0 ? start.x : 1 - start.x, (dy < 0 ? start.y : 1 - start.y) * k);
            const h = w / k;
            cropRegion = { x: start.x - (dx < 0 ? w : 0), y: start.y - (dy < 0 ? h : 0), w: w, h: h };
        } else {
            const r = cropGesture.region;
            cropRegion.x = Math.max(0, Math.min(1 - r.w, r.x + p.x - start.x));
            cropRegion.y = Math.max(0, Math.min(1 - r.h, r.y + p.y - start.y));
        }
        applyCrop();
    }

    function finishCropGesture(e) {
        if (!cropGesture || e.pointerId !== cropGesture.id) return;
        moveCropGesture(e);
        const rect = cropSurface.getBoundingClientRect();
        const valid = cropRegion && cropRegion.w * rect.width >= 18 && cropRegion.h * rect.height >= 12;
        cropGesture = null;
        if (cropSurface.hasPointerCapture(e.pointerId)) cropSurface.releasePointerCapture(e.pointerId);
        if (cropSelecting) {
            if (valid) {
                cropSelecting = false;
                updateCropLayout();
                showHud('已放大 · 小窗拖动调整');
            } else {
                cropRegion = null;
                applyCrop();
            }
        }
    }

    function cancelCropGesture() {
        if (!cropGesture) return;
        const gesture = cropGesture;
        cropGesture = null;
        cropRegion = gesture.region;
        if (cropSurface.hasPointerCapture(gesture.id)) cropSurface.releasePointerCapture(gesture.id);
        applyCrop();
    }

    function refreshCropPreview() {
        if (cropFrame !== null) cancelAnimationFrame(cropFrame);
        cropFrame = null;
        if (!cropRegion || cropSelecting || !panelVisible || isCollapsed || document.hidden || video.readyState < 2) return;
        cropPreview.getContext('2d').drawImage(video, 0, 0, cropPreview.width, cropPreview.height);
        // 小预览最多每秒重绘 10 次，不增加视频解码器，暂停/隐藏时停止。
        if (!video.paused && !video.ended) {
            let last = performance.now();
            function frame(now) {
                if (now - last >= 100) { refreshCropPreview(); return; }
                cropFrame = requestAnimationFrame(frame);
            }
            cropFrame = requestAnimationFrame(frame);
        }
    }

    function clearCrop() {
        cancelCropGesture();
        cropSelecting = false;
        cropRegion = null;
        video.style.removeProperty('object-view-box');
        updateCropLayout();
    }

    // ---------- 折叠 / 展开 ----------
    function updateHeaderShortcutBtn() {
        if (!headerShortcutBtn) return;
        const act = headerShortcutBtn.querySelector('.ws-action');
        if (act) act.textContent = isCollapsed ? '展开' : '折叠';
        headerShortcutBtn.title = (isCollapsed ? '展开播放器' : '折叠播放器') + ' (快捷键: Shift)';
        headerShortcutBtn.setAttribute('aria-label', (isCollapsed ? '展开播放器' : '折叠播放器') + ' (Shift)');
    }

    function toggleCollapse() {
        if (document.fullscreenElement === panel) return;
        isCollapsed = !isCollapsed;
        if (isCollapsed) {
            panel.classList.add('is-collapsed');
            collapseBtn.innerHTML = '<i class="ph ph-caret-down text-[15px]"></i>';
            collapseBtn.title = '展开播放器 (Shift)';
        } else {
            panel.classList.remove('is-collapsed');
            collapseBtn.innerHTML = '<i class="ph ph-caret-up text-[15px]"></i>';
            collapseBtn.title = '折叠播放器 (Shift)';
        }
        collapseBtn.setAttribute('aria-expanded', String(!isCollapsed));
        updateHeaderShortcutBtn();
        cancelCropGesture();
        updateCropLayout();
        saveWindowState();
    }

    // ---------- 状态持久化 ----------
    function saveWindowState() {
        if (!panel) return;
        try {
            const data = {
                left: panel.style.left,
                top: panel.style.top,
                width: panel.style.width,
                height: panel.style.height,
                isCollapsed: isCollapsed,
                videoFolder: videoFolder,
                rate: video ? video.playbackRate : 1
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (_) {}
    }

    function restoreWindowState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (typeof s.videoFolder === 'string') videoFolder = s.videoFolder;
            if (s.width) panel.style.width = s.width;
            if (s.height) panel.style.height = s.height;
            if (s.left && s.top) {
                const maxLeft = Math.max(0, window.innerWidth - (parseInt(s.width, 10) || 320));
                const maxTop = Math.max(0, window.innerHeight - 48);
                panel.style.left = Math.min(Math.max(8, parseInt(s.left, 10) || 0), maxLeft) + 'px';
                panel.style.top = Math.min(Math.max(HEADER_HEIGHT, parseInt(s.top, 10) || HEADER_HEIGHT), maxTop) + 'px';
            }
            if (s.isCollapsed) {
                isCollapsed = true;
                panel.classList.add('is-collapsed');
                if (collapseBtn) {
                    collapseBtn.innerHTML = '<i class="ph ph-caret-down text-[15px]"></i>';
                    collapseBtn.title = '展开播放器 (Shift)';
                    collapseBtn.setAttribute('aria-expanded', 'false');
                }
                updateHeaderShortcutBtn();
            }
            if (s.rate && video) {
                setRateTenths(rateToTenths(s.rate), false);
            }
        } catch (_) {}
    }

    function syncSpeedDropdown(val) {
        if (!speedSel) return;
        const standardValues = ['0.5', '1.0', '2.0', '3.0'];
        const strVal = val.toFixed(1);
        let customOpt = speedSel.querySelector('option[data-custom]');
        if (standardValues.includes(strVal)) {
            if (customOpt) customOpt.remove();
            speedSel.value = strVal;
        } else {
            if (!customOpt) {
                customOpt = document.createElement('option');
                customOpt.setAttribute('data-custom', 'true');
                speedSel.appendChild(customOpt);
            }
            customOpt.value = strVal;
            customOpt.textContent = strVal + 'x';
            speedSel.value = strVal;
        }
    }

    // 设置倍速（十分位整数），并同步下拉框显示与 HUD 反馈
    function setRateTenths(tenths, triggerNotice = true) {
        tenths = Math.max(RATE_MIN_TENTHS, Math.min(RATE_MAX_TENTHS, tenths));
        const val = tenths / 10;
        if (video) video.playbackRate = val;
        syncSpeedDropdown(val);
        if (triggerNotice) showHud(val.toFixed(1) + 'x');
        saveWindowState();
    }

    // ---------- 打开视频 ----------
    function toggleVideoFullscreen() {
        // 多视频全屏包含标题栏，切换文件时保留同一个全屏容器。
        const target = cropRegion || playlist.length > 1 ? panel : video;
        if (document.fullscreenElement === video || document.fullscreenElement === panel) {
            document.exitFullscreen().catch(function () {});
        } else {
            if (isCollapsed) toggleCollapse();
            if (target.requestFullscreen) target.requestFullscreen().catch(function () {});
            else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
        }
    }

    function isVideoFile(file) {
        return /\.(mp4|webm|mkv|mov|m4v|avi|ogv)$/i.test(file.name) || (file.type || '').startsWith('video/');
    }

    function setPlaylist(items, selected, keepOrder) {
        cancelOnlineRequest();
        const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
        const ordered = keepOrder ? items.slice() : items.slice().sort(function (a, b) { return collator.compare(a.name, b.name); });
        const index = ordered.findIndex(function (item) { return item === selected || item.url === selected; });
        return playPlaylistItem(index >= 0 ? index : 0, ordered);
    }

    function syncPlaylistControls() {
        previousBtn.disabled = playlistIndex <= 0;
        nextBtn.disabled = playlistIndex < 0 || playlistIndex >= playlist.length - 1;
        previousBtn.title = previousBtn.disabled ? '已是第一个视频' : '上一个：' + playlist[playlistIndex - 1].name;
        nextBtn.title = nextBtn.disabled ? '已是最后一个视频' : '下一个：' + playlist[playlistIndex + 1].name;
        panel.classList.toggle('has-video-playlist', playlist.length > 1);
        fullscreenBtn.style.display = playlist.length > 1 ? 'inline-flex' : 'none';
    }

    async function playPlaylistItem(index, items = playlist, resumeCurrent = false) {
        if (index < 0 || index >= items.length) return false;
        cancelOnlineRequest();
        cancelBiliPlayback();
        const item = items[index];
        let source = item;
        let request = null;
        let timeout = null;
        try {
            if (item.kind === 'bilibili') {
                request = new AbortController();
                biliRequest = request;
                timeout = setTimeout(function () { request.abort(); }, 30000);
                previousBtn.disabled = nextBtn.disabled = true;
                showHud('正在读取视频');
                const data = await biliApi({ action: 'play', bvid: item.bvid, aid: item.aid,
                    cid: item.cid, page: item.page, quality: Number(biliQuality.value) }, request.signal);
                if (biliRequest !== request || request.signal.aborted) return false;
                if (data.transport === 'dash') await ensureDashLibrary();
                if (biliRequest !== request || request.signal.aborted) return false;
                source = Object.assign({}, item, { url: data.url, transport: data.transport || 'mp4' });
                biliActual.textContent = '当前 ' + data.qualityLabel;
                biliActual.title = data.quality < Number(biliQuality.value) ?
                    (data.loggedIn ? '按账号与视频实际可用的清晰度播放' : '扫码登录后重试高清') : '';
            }
            const resume = resumeCurrent ? { time: video.currentTime, paused: video.paused,
                crop: cropRegion && Object.assign({}, cropRegion) } : null;
            biliRequest = null;
            playlist = items;
            playlistIndex = index;
            toggleUrlInput(false);
            loadVideo(source, resume);
            syncPlaylistControls();
            filenameEl.title = item.name + ' (' + (index + 1) + '/' + items.length + ')';
            return true;
        } catch (error) {
            if (request && biliRequest !== request) return false;
            toggleUrlInput(true);
            urlError.textContent = request && request.signal.aborted ? '视频读取超时，请检查网络后重试' : (error.message || '读取视频失败，请重试');
            return false;
        } finally {
            clearTimeout(timeout);
            if (biliRequest === request) biliRequest = null;
            if (!biliRequest) syncPlaylistControls();
        }
    }

    async function openVideo() {
        if (pickingVideo) return;
        cancelBiliPlayback();
        toggleUrlInput(false);
        pickingVideo = true;
        openBtn.disabled = true;
        try {
            const response = await fetch('/api/pick-video', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initial_dir: videoFolder })
            });
            if (response.status === 404 || response.status === 501) { browserVideoPicker(); return; }
            const data = await response.json();
            if (data.cancelled) return;
            if (!data.ok || !Array.isArray(data.videos) || !data.videos.length) {
                if (data.error) showHud(data.error);
                else browserVideoPicker();
                return;
            }
            videoFolder = data.folder || '';
            setPlaylist(data.videos, data.selected);
            saveWindowState();
        } catch (_) {
            browserVideoPicker();
        } finally {
            pickingVideo = false;
            openBtn.disabled = false;
        }
    }

    // 无本地服务时保留浏览器入口，可多选视频作为播放列表。
    function browserVideoPicker() {
        if (window.showOpenFilePicker) {
            window.showOpenFilePicker({
                types: [{
                    description: 'Video',
                    accept: { 'video/*': ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.ogv'] }
                }],
                multiple: true
            }).then(async function (handles) {
                const files = await Promise.all(handles.map(function (handle) { return handle.getFile(); }));
                setPlaylist(files, files[0]);
            }).catch(function (err) {
                if (err && err.name !== 'AbortError') fallbackVideoInput();
            });
        } else {
            fallbackVideoInput();
        }
    }

    function fallbackVideoInput() {
        let input = document.getElementById('video-file-input');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.id = 'video-file-input';
            input.accept = 'video/*,.mkv,.mp4,.webm,.mov,.m4v,.avi,.ogv';
            input.multiple = true;
            input.style.display = 'none';
            input.addEventListener('change', function (e) {
                const files = Array.from(e.target.files || []).filter(isVideoFile);
                if (files.length) setPlaylist(files, files[0]);
                input.value = '';
            });
            document.body.appendChild(input);
        }
        input.click();
    }

    function loadVideo(file, resume) {
        if (!file) return;
        if (file.kind !== 'bilibili') { biliActual.textContent = ''; biliActual.title = ''; }

        clearCrop();
        cropBtn.disabled = true;

        if (videoBlobUrl) { URL.revokeObjectURL(videoBlobUrl); videoBlobUrl = null; }
        if (!resume) clearSubtitle();

        const rate = video.playbackRate;
        if (restorePlaybackListener) video.removeEventListener('loadedmetadata', restorePlaybackListener);
        restorePlaybackListener = null;
        if (dashPlayer) {
            const previous = dashPlayer;
            dashPlayer = null;
            previous.reset();
        }
        if (resume) {
            restorePlaybackListener = function () {
                restorePlaybackListener = null;
                video.currentTime = Math.min(resume.time, Math.max(0, video.duration - 0.1));
                if (resume.crop) { cropRegion = resume.crop; updateCropLayout(); }
                if (resume.paused) video.pause();
            };
            video.addEventListener('loadedmetadata', restorePlaybackListener, { once: true });
        }
        if (file.transport === 'dash') {
            const player = window.dashjs.MediaPlayer().create();
            dashPlayer = player;
            player.updateSettings({ debug: { logLevel: 0 } });
            player.on(window.dashjs.MediaPlayer.events.ERROR, function () {
                if (dashPlayer === player) showHud('高清流加载失败，请重新打开或切换清晰度');
            });
            player.initialize(video, file.url, !(resume && resume.paused));
        } else {
            videoBlobUrl = file.url ? null : URL.createObjectURL(file);
            video.src = file.url || videoBlobUrl;
        }
        video.defaultPlaybackRate = rate;
        video.playbackRate = rate;

        filenameEl.textContent = file.name;
        filenameEl.title = file.name;
        filenameEl.style.display = 'inline-block';

        showPanel();
        updateHint();
        showHud('视频已载入');

        if (file.transport === 'dash' || (resume && resume.paused)) return;
        try {
            video.play().catch(function () { /* 静默，用户点原生播放键即可 */ });
        } catch (e) { /* 静默 */ }
    }

    function ensureDashLibrary() {
        if (!window.MediaSource) return Promise.reject(new Error('高清播放需要新版 Edge / Chrome 浏览器'));
        if (window.dashjs) return Promise.resolve();
        if (!dashLibraryPromise) {
            dashLibraryPromise = new Promise(function (resolve, reject) {
                const script = document.createElement('script');
                script.src = '/static/lib/dashjs/dash.all.min.js?v=5.2.1';
                script.onload = function () {
                    if (window.dashjs) resolve();
                    else { script.remove(); dashLibraryPromise = null; reject(new Error('高清播放器加载失败，请刷新页面重试')); }
                };
                script.onerror = function () {
                    script.remove(); dashLibraryPromise = null;
                    reject(new Error('高清播放器加载失败，请重启阅读器并刷新页面'));
                };
                document.head.appendChild(script);
            });
        }
        return dashLibraryPromise;
    }

    // ---------- 在线视频（只在主动提交网址时联网） ----------
    function cancelOnlineRequest() {
        if (onlineRequest) onlineRequest.abort();
        onlineRequest = null;
        if (urlSubmit) { urlSubmit.disabled = false; urlSubmit.textContent = '播放'; }
    }

    function toggleUrlInput(visible) {
        if (!visible) { cancelOnlineRequest(); cancelBiliPlayback(); stopBiliLogin(); }
        urlForm.hidden = !visible;
        urlBtn.classList.toggle('active', visible);
        urlBtn.setAttribute('aria-expanded', String(visible));
        if (visible) {
            if (isCollapsed) toggleCollapse();
            urlError.textContent = '';
            urlInput.focus();
            refreshBiliAccount();
        }
    }

    async function openOnlineVideo(e) {
        e.preventDefault();
        cancelOnlineRequest();
        let url;
        try {
            url = new URL(urlInput.value.trim());
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
        } catch (_) { urlError.textContent = '请输入完整的 http:// 或 https:// 视频网址'; return; }
        const request = new AbortController();
        onlineRequest = request;
        urlSubmit.disabled = true;
        urlSubmit.textContent = '读取中';
        urlError.textContent = '';
        const timeout = setTimeout(function () { request.abort(); }, 30000);
        try {
            let data;
            // Direct media needs no backend and retains all native video controls.
            if (/\.(mp4|webm|m4v|mov|ogv)$/i.test(url.pathname) && !/(^|\.)bilibili\.com$/i.test(url.hostname)) {
                let name = url.pathname.split('/').pop();
                try { name = decodeURIComponent(name); } catch (_) { /* Keep malformed escapes as text. */ }
                data = { ok: true, videos: [{ kind: 'direct', name: name, url: url.href }], selected: url.href };
            } else {
                const response = await fetch('/api/online-video', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: url.href }), signal: request.signal
                });
                if (response.status === 404 || response.status === 501) throw new Error('请重启阅读器服务并刷新页面后重试');
                data = await response.json();
                if (!response.ok || !data.ok) throw new Error(data.error || '无法读取视频，请稍后重试');
            }
            if (onlineRequest !== request || request.signal.aborted) return;
            if (!Array.isArray(data.videos) || !data.videos.length) throw new Error('未找到可播放的视频，请检查网址');
            // Never sort a site's series by title: its published sequence is authoritative.
            await setPlaylist(data.videos, data.selected, true);
        } catch (error) {
            if (onlineRequest !== request) return;
            urlError.textContent = request.signal.aborted ? '读取超时，请检查网络后重试' : (error.message || '读取失败，请稍后重试');
        } finally {
            clearTimeout(timeout);
            if (onlineRequest === request) cancelOnlineRequest();
        }
    }

    function cancelBiliPlayback() {
        if (biliRequest) biliRequest.abort();
        biliRequest = null;
        if (previousBtn) syncPlaylistControls();
    }

    async function biliApi(data, signal) {
        const response = await fetch('/api/bilibili', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: signal });
        if ([404, 501].includes(response.status)) throw new Error('请重启阅读器服务并刷新页面后重试');
        const answer = await response.json();
        if (!response.ok || !answer.ok) throw new Error(answer.error || 'B 站请求失败，请稍后重试');
        return answer;
    }

    function syncBiliAccount(data) {
        biliLoginBtn.textContent = data.loggedIn ? (data.name || 'B 站已登录') : 'B 站登录';
        biliLoginBtn.dataset.loggedIn = String(!!data.loggedIn);
        biliLoginBtn.title = data.loggedIn ? '本机已登录 B 站' : '使用 B 站 App 扫码登录';
        biliLogoutBtn.hidden = !data.loggedIn;
    }

    async function refreshBiliAccount() {
        try { syncBiliAccount(await biliApi({ action: 'status' })); }
        catch (_) { /* Account status must not interrupt local video or URL editing. */ }
    }

    function stopBiliLogin() {
        biliLoginGeneration++;
        clearTimeout(biliLoginTimer);
        biliLoginTimer = null;
        if (biliLoginRequest) biliLoginRequest.abort();
        biliLoginRequest = null;
        if (biliLoginCard) {
            biliLoginCard.hidden = true;
            panel.querySelector('#video-bili-qr').removeAttribute('src');
        }
    }

    async function startBiliLogin() {
        if (biliLoginBtn.dataset.loggedIn === 'true') return;
        stopBiliLogin();
        const generation = biliLoginGeneration;
        const controller = new AbortController();
        biliLoginRequest = controller;
        const status = panel.querySelector('#video-bili-login-status');
        const retry = panel.querySelector('#video-bili-login-retry');
        biliLoginCard.hidden = false;
        retry.hidden = true;
        status.textContent = '正在生成二维码';
        try {
            const data = await biliApi({ action: 'login' }, controller.signal);
            if (generation !== biliLoginGeneration) return;
            panel.querySelector('#video-bili-qr').src = data.image;
            status.textContent = '使用 B 站 App 扫码并确认登录';
            async function poll() {
                try {
                    const result = await biliApi({ action: 'poll', token: data.token }, controller.signal);
                    if (generation !== biliLoginGeneration) return;
                    if (result.state === 'success') {
                        stopBiliLogin();
                        syncBiliAccount({ loggedIn: true });
                        refreshBiliAccount();
                        if (playlist[playlistIndex] && playlist[playlistIndex].kind === 'bilibili') {
                            playPlaylistItem(playlistIndex, playlist, true);
                        } else showHud('B 站登录成功');
                        return;
                    }
                    if (result.state === 'expired') {
                        status.textContent = '二维码已过期'; retry.hidden = false; return;
                    }
                    status.textContent = result.state === 'confirm' ? '请在 B 站 App 确认登录' : '使用 B 站 App 扫码并确认登录';
                    biliLoginTimer = setTimeout(poll, 2000);
                } catch (error) {
                    if (generation !== biliLoginGeneration) return;
                    status.textContent = error.message; retry.hidden = false;
                }
            }
            biliLoginTimer = setTimeout(poll, 2000);
        } catch (error) {
            if (generation !== biliLoginGeneration) return;
            status.textContent = error.message; retry.hidden = false;
        }
    }

    // ---------- 字幕 ----------
    function openSubtitle() {
        if (!video.src) { alert('请先打开视频，再加载字幕。'); return; }

        let input = document.getElementById('video-subtitle-input');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.id = 'video-subtitle-input';
            input.accept = '.srt,.vtt,text/vtt,application/x-subrip';
            input.style.display = 'none';
            input.addEventListener('change', async function (e) {
                const f = e.target.files && e.target.files[0];
                if (f) await loadSubtitle(f);
                input.value = '';
            });
            document.body.appendChild(input);
        }
        input.click();
    }

    async function loadSubtitle(file) {
        if (!video.src) { alert('请先打开视频，再加载字幕。'); return; }
        const loadId = ++subtitleLoadId;
        let text;
        try {
            text = await file.text();
        } catch (_) {
            if (loadId === subtitleLoadId) showHud('字幕读取失败，请重试');
            return;
        }
        // 更换视频或再次选择字幕后，忽略上一次仍在读取的文件。
        if (loadId !== subtitleLoadId) return;
        const isVtt = file.name.toLowerCase().endsWith('.vtt');
        const content = isVtt ? text : srtToVtt(text);

        if (subtitleBlobUrl) URL.revokeObjectURL(subtitleBlobUrl);
        subtitleBlobUrl = URL.createObjectURL(new Blob([content], { type: 'text/vtt' }));
        subtitleFilename = file.name;
        subtitleEnabled = true;
        applySubtitleTrack(subtitleBlobUrl, file.name);

        syncSubtitleControls();
        showHud('字幕已挂载');
    }

    function syncSubtitleControls() {
        if (!subtitleBtn) return;
        const hasSubtitle = !!subtitleBlobUrl;
        subtitleBtn.classList.toggle('active', hasSubtitle && subtitleEnabled);
        subtitleBtn.title = hasSubtitle
            ? (subtitleEnabled ? '关闭字幕：' : '开启字幕：') + subtitleFilename
            : '加载字幕 (.srt / .vtt)';
        subtitleBtn.setAttribute('aria-label', subtitleBtn.title);
        if (hasSubtitle) subtitleBtn.setAttribute('aria-pressed', String(subtitleEnabled));
        else subtitleBtn.removeAttribute('aria-pressed');
        if (subtitleReplaceBtn) subtitleReplaceBtn.style.display = hasSubtitle ? 'inline-flex' : 'none';
    }

    function setSubtitleEnabled(enabled) {
        subtitleEnabled = enabled;
        const track = video.querySelector('track');
        if (track) track.track.mode = enabled ? 'showing' : 'disabled';
        syncSubtitleControls();
    }

    function applySubtitleTrack(url, label) {
        video.querySelectorAll('track').forEach(function (t) { t.remove(); });

        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = label || '字幕';
        track.srclang = 'zh';
        track.src = url;
        track.default = true;
        video.appendChild(track);
        track.track.mode = subtitleEnabled ? 'showing' : 'disabled';

        track.addEventListener('load', function () {
            if (track.parentNode !== video) return;
            track.track.mode = subtitleEnabled ? 'showing' : 'disabled';
        });
    }

    function clearSubtitle() {
        subtitleLoadId++;
        video.querySelectorAll('track').forEach(function (t) { t.remove(); });
        if (subtitleBlobUrl) { URL.revokeObjectURL(subtitleBlobUrl); subtitleBlobUrl = null; }
        subtitleEnabled = false;
        subtitleFilename = '';
        syncSubtitleControls();
    }

    // SRT → VTT：去掉序号行，时间戳逗号改句点，加 WEBVTT 头
    function srtToVtt(srt) {
        const text = String(srt || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        const lines = text.split('\n');
        let vtt = 'WEBVTT\n\n';
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            if (/^\s*\d+\s*$/.test(line)) { i++; continue; } // 跳过序号
            if (line.indexOf('-->') !== -1) {
                vtt += line.replace(/,/g, '.') + '\n';
                i++;
                while (i < lines.length && lines[i].trim() !== '') {
                    vtt += lines[i] + '\n';
                    i++;
                }
                vtt += '\n';
            } else {
                i++;
            }
        }
        return vtt;
    }

    // ---------- 显示 / 隐藏 ----------
    function showPanel() {
        ensureDom();
        if (!panelVisible) {
            panel.style.display = 'flex';
            panelVisible = true;
            syncToolbarButton(true);

            // 首次显示时定位到屏幕中央（若无历史记录）
            if (!panel.style.left || !panel.style.top) {
                const w = panel.offsetWidth || 560;
                const h = panel.offsetHeight || 380;
                panel.style.left = Math.max(8, Math.round((window.innerWidth - w) / 2)) + 'px';
                panel.style.top = Math.max(HEADER_HEIGHT, Math.round((window.innerHeight - h) / 2)) + 'px';
            }
        }
        updateHint();
        updateCropLayout();
    }

    function hidePanel() {
        toggleUrlInput(false);
        cancelCropGesture();
        if (panel) panel.style.display = 'none';
        panelVisible = false;
        syncToolbarButton(false);
        // 收起时若正在播放则暂停，避免「看不见却有声音」
        if (video && !video.paused) video.pause();
        refreshCropPreview();
    }

    function togglePanel() {
        if (panelVisible) hidePanel(); else showPanel();
    }

    function updateHint() {
        if (!hintEl || !video) return;
        const hasVideo = !!dashPlayer || !!(video.src || video.currentSrc);
        hintEl.style.display = hasVideo ? 'none' : 'flex';
        video.style.display = hasVideo ? 'block' : 'none';
        if (overlayEl) overlayEl.style.display = hasVideo ? 'block' : 'none';
        if (!hasVideo && filenameEl) {
            filenameEl.style.display = 'none';
        }
    }

    // ---------- 初始化 ----------
    function init() {
        ensureDom();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
