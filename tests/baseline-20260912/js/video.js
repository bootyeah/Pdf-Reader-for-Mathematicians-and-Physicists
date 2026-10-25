// =============================================================================
// ⑨ 视频播放器 (Video Player) —— 悬浮播放器
// -----------------------------------------------------------------------------
// 功能：在不退出阅读器全屏的前提下，悬浮播放本地课程视频。
//       - 拖动标题栏移动窗口，右下角拖动缩放。
//       - 原生 <video controls> 提供播放/进度/音量/全屏。
//       - 头部提供：打开视频 / 加载字幕(.srt/.vtt) / 倍速(0.5x–3.0x) / 关闭。
//       - 快捷键：F9 唤出/收起播放器；Z 减速 / X 加速（±0.1x）。
// 依赖：无（自包含 IIFE，DOM 惰性创建，遵循 dictionary.js 的模块范式）。
// 说明：视频走「本地文件 → URL.createObjectURL()」Blob URL，与 PDF 加载同源，
//       天然支持进度条拖拽(Range)，无需改动 server.py，100% 离线。
// =============================================================================

(function () {
    'use strict';

    // ---------- 内部引用 ----------
    let panel = null;
    let header = null;
    let video = null;
    let filenameEl = null;
    let hintEl = null;
    let overlayEl = null;
    let speedSel = null;
    let openBtn = null;
    let subtitleBtn = null;
    let collapseBtn = null;
    let closeBtn = null;
    let hudEl = null;
    let toolbarBtn = null;
    let resizeHandle = null;

    let videoBlobUrl = null;
    let subtitleBlobUrl = null;
    let panelVisible = false;
    let isCollapsed = false;
    let hudTimer = null;
    let isMouseOverPanel = false;

    const STORAGE_KEY = 'pdf_reader_video_companion_state';

    // 顶部工具栏高度（与 LOCALPdfReader.html 里 header 的 h-[80px] 保持一致）：
    // 悬浮播放器与其它浮层的 top 下限，避免被顶栏压住
    const HEADER_HEIGHT = 80;

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
                '<i class="ph ph-video-camera text-zinc-400 text-[15px]"></i>' +
                '<span class="video-panel-filename" id="video-panel-filename" style="display:none;" title=""></span>' +
                '<div class="video-panel-spacer"></div>' +
                '<select id="video-speed" class="video-speed" title="播放速度 (Z 减速 / X 加速)">' + speedOptions + '</select>' +
                '<button type="button" class="video-panel-btn" id="video-open-btn" title="打开本地视频">' +
                    '<i class="ph ph-folder-open text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn" id="video-subtitle-btn" title="加载字幕 (.srt / .vtt)">' +
                    '<i class="ph ph-closed-captioning text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn" id="video-collapse-btn" title="折叠/展开播放器">' +
                    '<i class="ph ph-caret-up text-[15px]"></i>' +
                '</button>' +
                '<button type="button" class="video-panel-btn video-panel-btn-close" id="video-close-btn" title="关闭播放器 (F9)">' +
                    '<i class="ph ph-x text-[15px]"></i>' +
                '</button>' +
            '</div>' +
            '<div style="position:relative; flex:1; min-height:0; display:flex; flex-direction:column; background:#18181b; overflow:hidden;">' +
                '<video id="video-element" controls playsinline disablepictureinpicture="true" controlslist="nodownload nopictureinpicture" preload="metadata" style="display:none;"></video>' +
                '<div id="video-overlay" class="video-overlay" title="点击播放/暂停 · 双击全屏"></div>' +
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
        subtitleBtn = panel.querySelector('#video-subtitle-btn');
        collapseBtn = panel.querySelector('#video-collapse-btn');
        closeBtn = panel.querySelector('#video-close-btn');
        hudEl = panel.querySelector('#video-speed-hud');
        resizeHandle = panel.querySelector('.video-resize-handle');

        toolbarBtn = document.getElementById('video-btn');

        bindEvents();
        panel.style.display = 'none';

        restoreWindowState();
    }

    // ---------- 事件绑定 ----------
    function bindEvents() {
        openBtn.addEventListener('click', function (e) { e.stopPropagation(); openVideo(); });
        subtitleBtn.addEventListener('click', function (e) { e.stopPropagation(); openSubtitle(); });
        closeBtn.addEventListener('click', function (e) { e.stopPropagation(); hidePanel(); });
        collapseBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleCollapse(); });

        hintEl.addEventListener('click', function (e) {
            openVideo();
        });

        // 覆盖层：拦截 Edge 视频悬停工具，单机播放/暂停，双击全屏
        let overlayClickTimer = null;
        if (overlayEl) {
            overlayEl.addEventListener('click', function (e) {
                e.stopPropagation();
                if (overlayClickTimer) {
                    clearTimeout(overlayClickTimer);
                    overlayClickTimer = null;
                    if (video.requestFullscreen) {
                        video.requestFullscreen().catch(function () {});
                    } else if (video.webkitRequestFullscreen) {
                        video.webkitRequestFullscreen();
                    }
                    return;
                }
                overlayClickTimer = setTimeout(function () {
                    overlayClickTimer = null;
                    if (!video.src) { openVideo(); return; }
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

        video.addEventListener('loadedmetadata', function () {
            updateHint();
            if (video.videoWidth && video.videoHeight && !isCollapsed) {
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
        });

        // 点击窗口时取消聚焦，防止出现蓝色/黑色聚焦轮廓线
        panel.addEventListener('mousedown', function () {
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
                loadVideo(file);
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
                if (isCollapsed) return;
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

    // ---------- 折叠 / 展开 ----------
    function toggleCollapse() {
        isCollapsed = !isCollapsed;
        if (isCollapsed) {
            panel.classList.add('is-collapsed');
            collapseBtn.innerHTML = '<i class="ph ph-caret-down text-[15px]"></i>';
            collapseBtn.title = '展开播放器';
        } else {
            panel.classList.remove('is-collapsed');
            collapseBtn.innerHTML = '<i class="ph ph-caret-up text-[15px]"></i>';
            collapseBtn.title = '折叠播放器';
        }
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
                    collapseBtn.title = '展开播放器';
                }
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
    function openVideo() {
        if (window.showOpenFilePicker) {
            window.showOpenFilePicker({
                types: [{
                    description: 'Video',
                    accept: { 'video/*': ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.ogv'] }
                }],
                multiple: false
            }).then(async function (handles) {
                const f = await handles[0].getFile();
                loadVideo(f);
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
            input.style.display = 'none';
            input.addEventListener('change', function (e) {
                const f = e.target.files && e.target.files[0];
                if (f) loadVideo(f);
                input.value = '';
            });
            document.body.appendChild(input);
        }
        input.click();
    }

    function loadVideo(file) {
        if (!file) return;

        if (videoBlobUrl) { URL.revokeObjectURL(videoBlobUrl); videoBlobUrl = null; }
        clearSubtitle();

        videoBlobUrl = URL.createObjectURL(file);
        video.src = videoBlobUrl;

        filenameEl.textContent = file.name;
        filenameEl.title = file.name;
        filenameEl.style.display = 'inline-block';

        showPanel();
        updateHint();
        showHud('视频已载入');

        try {
            video.play().catch(function () { /* 静默，用户点原生播放键即可 */ });
        } catch (e) { /* 静默 */ }
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
        const text = await file.text();
        const isVtt = file.name.toLowerCase().endsWith('.vtt');
        const content = isVtt ? text : srtToVtt(text);

        if (subtitleBlobUrl) URL.revokeObjectURL(subtitleBlobUrl);
        subtitleBlobUrl = URL.createObjectURL(new Blob([content], { type: 'text/vtt' }));
        applySubtitleTrack(subtitleBlobUrl, file.name);

        if (subtitleBtn) {
            subtitleBtn.classList.add('active');
            subtitleBtn.title = '字幕: ' + file.name + ' (点击可更换)';
        }
        showHud('字幕已挂载');
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

        track.addEventListener('load', function () {
            try { track.track.mode = 'showing'; } catch (e) { /* 忽略 */ }
        });
    }

    function clearSubtitle() {
        video.querySelectorAll('track').forEach(function (t) { t.remove(); });
        if (subtitleBlobUrl) { URL.revokeObjectURL(subtitleBlobUrl); subtitleBlobUrl = null; }
        if (subtitleBtn) {
            subtitleBtn.classList.remove('active');
            subtitleBtn.title = '加载字幕 (.srt / .vtt)';
        }
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
    }

    function hidePanel() {
        if (panel) panel.style.display = 'none';
        panelVisible = false;
        syncToolbarButton(false);
        // 收起时若正在播放则暂停，避免「看不见却有声音」
        if (video && !video.paused) video.pause();
    }

    function togglePanel() {
        if (panelVisible) hidePanel(); else showPanel();
    }

    function updateHint() {
        if (!hintEl || !video) return;
        const hasVideo = !!(video.src || video.currentSrc);
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
