// =============================================================================
// ⑨ 词典翻译工具 (Dictionary / Translator)
// -----------------------------------------------------------------------------
// 功能：在 PDF 文本层上框选词语后，于选区右上角浮现翻译气泡；
//       鼠标悬停气泡时右侧展开「单词翻译 / 句子翻译」两个选项；
//       点击选项后，在选区下方展开结果面板显示翻译内容。
// 依赖：foundation.js 中的全局 state / els（本文件须在其之后加载）。
// 翻译请求：POST /api/translate → 由 server.py 代理转发至 DeepSeek（v4-flash 联网模型）。
// =============================================================================

(function () {
    'use strict';

    // ---------- 配置 ----------
    const API_URL = '/api/translate';

    // ---------- 惰性创建的 DOM ----------
    let bubble = null;
    let panel = null;
    let panelBody = null;
    let panelTitle = null;

    // 当前选中的上下文（鼠标松开时捕获，防止点击气泡导致浏览器清空选区）
    let current = null; // { raw, text, rect }

    let panelDragged = false; // 记录面板是否被用户拖动过

    // ---------- DOM 构建 ----------
    function ensureDom() {
        if (bubble) return;

        // 悬浮气泡 (直接展示选项，取消 hover 展开，提高交互效率)
        bubble = document.createElement('div');
        bubble.id = 'dict-bubble';
        bubble.className = 'dict-bubble bg-white/95 backdrop-blur-md border border-gray-200 shadow-lg rounded-lg p-1 flex items-center gap-1';
        bubble.style.display = 'none';
        bubble.innerHTML =
            '<div class="flex items-center justify-center text-blue-500 pl-1.5 pr-2 border-r border-gray-200">' +
                '<i class="ph ph-translate text-[18px]"></i>' +
            '</div>' +
            '<button type="button" class="dict-opt flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded hover:bg-blue-50 text-gray-600 hover:text-blue-600 transition-colors cursor-pointer text-sm font-medium" data-mode="word" title="单词精读">' +
                '<i class="ph ph-text-aa text-[16px]"></i><span>单词</span>' +
            '</button>' +
            '<button type="button" class="dict-opt flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded hover:bg-purple-50 text-gray-600 hover:text-purple-600 transition-colors cursor-pointer text-sm font-medium" data-mode="sentence" title="句子直译">' +
                '<i class="ph ph-text-t text-[16px]"></i><span>句子</span>' +
            '</button>';
        document.body.appendChild(bubble);

        // 结果面板 (UI 风格对齐侧边栏和笔记弹窗)
        panel = document.createElement('div');
        panel.id = 'dict-panel';
        panel.className = 'dict-panel bg-white/95 backdrop-blur-md border border-gray-200 shadow-xl rounded-xl flex flex-col ring-1 ring-black/5 overflow-hidden';
        panel.style.display = 'none';
        panel.innerHTML =
            '<div class="dict-panel-header px-3 py-2 border-b border-gray-100 bg-gray-50/80 flex justify-between items-center shrink-0" style="cursor: move;">' +
                '<span class="dict-panel-title text-xs font-bold text-gray-500 uppercase flex items-center gap-1.5" id="dict-panel-title"><i class="ph ph-translate text-blue-500 text-sm"></i> 翻译</span>' +
                '<button type="button" class="text-gray-400 hover:text-red-500 hover:bg-red-50 rounded p-1 transition-colors cursor-pointer flex items-center justify-center" id="dict-panel-close" title="关闭">' +
                    '<i class="ph ph-x"></i>' +
                '</button>' +
            '</div>' +
            '<div class="dict-panel-body p-3 overflow-y-auto text-sm text-gray-700 custom-scrollbar" id="dict-panel-body"></div>';
        document.body.appendChild(panel);

        panelBody = panel.querySelector('.dict-panel-body');
        panelTitle = panel.querySelector('.dict-panel-title');

        // 阻止气泡/面板上的 mousedown 清空选区 & 冒泡干扰主流程
        [bubble, panel].forEach(function (el) {
            el.addEventListener('mousedown', function (e) {
                // 允许面板 header 触发拖拽，但不清除选区
                if (!e.target.closest('.dict-panel-header')) {
                    e.preventDefault();
                }
                e.stopPropagation();
            });
            el.addEventListener('mouseup', function (e) {
                e.stopPropagation();
            });
        });

        // 选项点击
        bubble.querySelectorAll('.dict-opt').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (!current) return;
                startTranslate(current.raw, btn.dataset.mode);
            });
        });

        // 关闭按钮
        panel.querySelector('#dict-panel-close').addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            hideAll();
        });

        // 面板拖拽逻辑
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;
        const header = panel.querySelector('.dict-panel-header');
        
        function onMouseMove(moveEvent) {
            if (!isDragging) return;
            panel.style.left = (initialLeft + moveEvent.clientX - startX) + 'px';
            panel.style.top = (initialTop + moveEvent.clientY - startY) + 'px';
        }

        function onMouseUp(upEvent) {
            if (!isDragging) return;
            isDragging = false;
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove, true);
            document.removeEventListener('mouseup', onMouseUp, true);
        }

        header.addEventListener('mousedown', function (e) {
            if (e.target.closest('#dict-panel-close')) return;
            isDragging = true;
            panelDragged = true;
            startX = e.clientX;
            startY = e.clientY;
            initialLeft = panel.offsetLeft;
            initialTop = panel.offsetTop;
            document.body.style.userSelect = 'none';

            document.addEventListener('mousemove', onMouseMove, true);
            document.addEventListener('mouseup', onMouseUp, true);
        });
    }

    // ---------- 文本智能清洗 ----------
    // 处理 PDF 框选可能引入的：换行、多余空格、软连字符、零宽字符等
    function cleanSelection(raw, mode) {
        let t = String(raw || '')
            .replace(/[\u00ad\u200b\u200c\u200d\ufeff]/g, '') // 软连字符 / 零宽字符
            .replace(/\s+/g, ' ')                              // 所有空白(含换行)折叠为单个空格
            .trim();

        if (mode === 'word') {
            const parts = t.split(' ').filter(Boolean);
            // 典型「PDF 逐字符加空格」场景：每个碎片都是单字符 → 拼回原词
            if (parts.length > 1 && parts.every(function (p) { return p.length === 1; })) {
                t = parts.join('');
            }
        }
        return t;
    }

    // ---------- 选区检测（在 PDF 文本层内） ----------
    function getSelectionContext() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

        const raw = sel.toString();
        if (!raw || !raw.trim()) return null;

        const anchor = sel.anchorNode;
        const focus = sel.focusNode;
        const wrapper = anchor && anchor.nodeType === 1
            ? anchor.closest('.page-wrapper')
            : (anchor && anchor.parentElement && anchor.parentElement.closest('.page-wrapper'));

        if (!wrapper) return null;

        const textLayer = wrapper.querySelector('.textLayer');
        if (!textLayer) return null;
        if (!textLayer.contains(anchor)) return null;
        if (focus && !textLayer.contains(focus)) return null;

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width < 2 && rect.height < 2)) return null;

        return { raw: raw, text: raw.trim(), rect: rect };
    }

    // ---------- 事件处理 ----------
    function onDocumentMouseUp(e) {
        // 点击气泡/面板时不做选区处理
        if (e.target && e.target.closest && e.target.closest('#dict-bubble, #dict-panel')) return;

        // 仅在默认「光标」模式下启用词典；标注工具(高亮/下划线/括号)选中文本另有用处
        if (state.currentTool !== 'cursor') {
            hideAll();
            return;
        }

        const ctx = getSelectionContext();
        if (!ctx) {
            hideAll();
            return;
        }
        current = ctx;
        showBubble(ctx.rect);
    }

    function onScrollOrResize(e) {
        // 面板内部滚动不应触发关闭
        if (e && e.target && e.target.closest && e.target.closest('#dict-panel, #dict-bubble')) return;
        
        // 当用户滚动或缩放屏幕时，尝试重新获取选区位置以使浮窗“附着”在文本上
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
            current.rect = sel.getRangeAt(0).getBoundingClientRect();
            if (bubble && bubble.style.display !== 'none') showBubble(current.rect);
            if (panel && panel.style.display !== 'none' && !panelDragged) showPanel();
            return;
        }
        
        // 如果选区丢失但面板已打开，则保留面板在屏幕上 (但如果没被拖拽，可能不再跟随原文本)
        if (panel && panel.style.display === 'block') {
            return;
        }
        
        hideAll();
    }

    // ---------- 气泡定位 ----------
    function showBubble(rect) {
        ensureDom();
        bubble.style.display = 'flex';
        bubble.style.visibility = 'hidden';

        const bw = bubble.offsetWidth;
        const bh = bubble.offsetHeight;

        let left = rect.right - bw;                    // 默认右对齐选区
        let top = rect.top - bh - 8;                   // 悬浮在选区上方
        if (top < 8) top = rect.bottom + 8;            // 上方放不下 → 放到下方

        // 若超出右边界，向左平移
        const maxLeft = window.innerWidth - bw - 8;
        if (left > maxLeft) left = maxLeft;
        left = Math.max(8, left);
        top = Math.max(8, Math.min(top, window.innerHeight - bh - 8));

        bubble.style.left = left + 'px';
        bubble.style.top = top + 'px';
        bubble.style.visibility = 'visible';
    }

    // ---------- 结果面板定位 ----------
    function showPanel() {
        panel.style.display = 'block';
        panel.style.visibility = 'hidden';

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pw = Math.min(360, vw - 16);
        panel.style.width = pw + 'px';

        const headerEl = panel.querySelector('.dict-panel-header');
        const headerH = (headerEl && headerEl.offsetHeight) || 42;
        const gap = 8;

        // 水平方向：左对齐选区，并保证不越界
        const left = Math.max(8, Math.min(current.rect.left, vw - pw - 8));

        // 垂直方向：默认放在选区正下方；根据下方剩余空间动态限制面板高度，避免越界
        let top = current.rect.bottom + gap;
        const maxBodyBelow = Math.max(64, vh - top - headerH - 16);
        let bodyMax = Math.min(maxBodyBelow, Math.round(vh * 0.5));

        // 若下方连最小高度都放不下，翻到选区上方
        if (maxBodyBelow < 90) {
            top = current.rect.top - headerH - 90 - gap;
            const maxBodyAbove = Math.max(64, top - 16);
            bodyMax = Math.min(maxBodyAbove, Math.round(vh * 0.5));
            top = Math.max(8, top);
        }

        panelBody.style.maxHeight = bodyMax + 'px';
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.visibility = 'visible';
    }

    // ---------- 发起翻译 ----------
    async function startTranslate(rawText, mode) {
        const cleaned = cleanSelection(rawText, mode);
        if (!cleaned) return;

        hideBubble();
        showPanel();
        panelTitle.textContent = mode === 'word' ? '单词翻译' : '句子翻译';
        renderLoading();

        try {
            const resp = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: cleaned, mode: mode })
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) {
                throw new Error(data.error || ('请求失败 (' + resp.status + ')'));
            }
            if (mode === 'word') {
                renderWordResult(data.content);
            } else {
                renderSentenceResult(data.content);
            }
        } catch (err) {
            renderError(err.message || String(err));
        }
    }

    // ---------- 渲染 ----------
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function wrapSpoiler(text) {
        if (!text) return '';
        const escaped = escapeHtml(text);
        // 使用 Tailwind 工具类实现实心方块遮挡，点击后移除隐藏类
        return '<span class="bg-gray-300 text-transparent cursor-pointer rounded select-none hover:bg-gray-400 transition-colors" onclick="this.classList.remove(\'bg-gray-300\', \'text-transparent\', \'hover:bg-gray-400\');">' + escaped + '</span>';
    }

    function renderLoading() {
        panelBody.innerHTML =
            '<div class="dict-loading">' +
                '<span class="dict-spinner"></span>' +
                '<span>正在翻译…</span>' +
            '</div>';
    }

    function renderError(msg) {
        panelBody.innerHTML = '<div class="dict-error">' + escapeHtml(msg) + '</div>';
    }

    function renderSentenceResult(content) {
        const text = String(content || '').trim();
        panelBody.innerHTML = '<div class="dict-sentence">' + escapeHtml(text) + '</div>';
    }

    function renderWordResult(content) {
        const parsed = parseWordJson(content);
        if (!parsed) {
            renderSentenceResult(content);
            return;
        }

        const ex = Array.isArray(parsed.examples) ? parsed.examples : [];
        const exHtml = ex.map(function (e) {
            return '<li class="dict-example">' +
                '<div class="dict-ex-en">' + escapeHtml(e && e.en) + '</div>' +
                '<div class="dict-ex-zh mt-1">' + wrapSpoiler(e && e.zh) + '</div>' +
            '</li>';
        }).join('');

        panelBody.innerHTML =
            '<div class="dict-word-head">' +
                '<span class="dict-word">' + escapeHtml(parsed.word) + '</span>' +
                (parsed.phonetic ? '<span class="dict-phonetic">' + escapeHtml(parsed.phonetic) + '</span>' : '') +
                (parsed.pos ? '<span class="dict-pos">' + escapeHtml(parsed.pos) + '</span>' : '') +
            '</div>' +
            (parsed.definition_en ? '<div class="dict-def-en">' + escapeHtml(parsed.definition_en) + '</div>' : '') +
            (parsed.definition_zh ? '<div class="dict-def-zh mt-1">' + wrapSpoiler(parsed.definition_zh) + '</div>' : '') +
            (exHtml ? '<ul class="dict-examples">' + exHtml + '</ul>' : '');
    }

    function parseWordJson(text) {
        if (!text) return null;
        try { return JSON.parse(text); } catch (e) { /* 继续 */ }
        // 容忍模型在 JSON 前后夹带说明文字 / 代码块围栏
        const m = String(text).match(/\{[\s\S]*\}/);
        if (m) {
            try { return JSON.parse(m[0]); } catch (e) { /* 继续 */ }
        }
        return null;
    }

    // ---------- 隐藏 ----------
    function hideBubble() { if (bubble) bubble.style.display = 'none'; }
    function hidePanel() { if (panel) panel.style.display = 'none'; }
    function hideAll() {
        hideBubble();
        hidePanel();
        current = null;
        panelDragged = false;
    }

    // ---------- 初始化 ----------
    function init() {
        ensureDom();
        document.addEventListener('mouseup', onDocumentMouseUp);
        window.addEventListener('scroll', onScrollOrResize, true);
        window.addEventListener('resize', onScrollOrResize);
        if (typeof els !== 'undefined' && els.container) {
            els.container.addEventListener('scroll', onScrollOrResize);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
