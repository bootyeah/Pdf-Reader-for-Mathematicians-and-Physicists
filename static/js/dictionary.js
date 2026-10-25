// =============================================================================
// ⑨ 词典翻译工具 (Dictionary / Translator)
// -----------------------------------------------------------------------------
// 功能：在 PDF 文本层上框选词语后，于选区右上角浮现翻译气泡；
//       气泡直接展示「单词/短语」与「句子」两个选项；
//       点击选项后，在选区下方展开结果面板显示翻译内容。
//       「单词」按钮同时覆盖单词与短语，并且是词还是短语由模型判断：单个词给音标/词性/
//       中英释义，词组、固定搭配、习语给出短语解析（意思 + 用法 + 例句）。
//       框选时很容易把空白带进来，因此前端不猜词/短语，统一交给模型还原与判定。
// 依赖：foundation.js 中的全局 state / els（本文件须在其之后加载）。
// 翻译请求：POST /api/translate → 由 server.py 代理转发至 DeepSeek（V4.1 Flash）。
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
    let translationRequest = null;

    // ---------- DOM 构建 ----------
    function ensureDom() {
        if (bubble) return;

        // 悬浮气泡 (直接展示选项，取消 hover 展开，提高交互效率)
        bubble = document.createElement('div');
        bubble.id = 'dict-bubble';
        bubble.className = 'dict-bubble bg-white/95 backdrop-blur-md border border-gray-200 shadow-lg rounded-md p-[3px] flex items-center gap-[3px]';
        bubble.style.display = 'none';
        bubble.innerHTML =
            '<div class="flex items-center justify-center text-blue-500 pl-1 pr-1.5 border-r border-gray-200">' +
                '<i class="ph ph-translate text-[15px]"></i>' +
            '</div>' +
            '<button type="button" class="dict-opt flex items-center justify-center gap-1 px-2 py-1 rounded-[3px] hover:bg-blue-50 text-gray-600 hover:text-blue-600 transition-colors cursor-pointer text-xs font-medium" data-mode="word" title="单词精读（框选到词组、固定搭配时自动切换为短语解析：意思、用法与例句）">' +
                '<i class="ph ph-text-aa text-[13px]"></i><span>单词</span>' +
            '</button>' +
            '<button type="button" class="dict-opt flex items-center justify-center gap-1 px-2 py-1 rounded-[3px] hover:bg-purple-50 text-gray-600 hover:text-purple-600 transition-colors cursor-pointer text-xs font-medium" data-mode="sentence" title="句子直译">' +
                '<i class="ph ph-text-t text-[13px]"></i><span>句子</span>' +
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
            const panelW = panel.offsetWidth || 320;
            const panelH = panel.offsetHeight || 180;
            const maxLeft = Math.max(8, window.innerWidth - panelW - 8);
            const maxTop = Math.max(8, window.innerHeight - Math.min(panelH, 60) - 8);
            const nextLeft = Math.min(Math.max(8, initialLeft + moveEvent.clientX - startX), maxLeft);
            const nextTop = Math.min(Math.max(8, initialTop + moveEvent.clientY - startY), maxTop);
            panel.style.left = nextLeft + 'px';
            panel.style.top = nextTop + 'px';
        }

        function onMouseUp() {
            if (!isDragging) return;
            isDragging = false;
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove, true);
            document.removeEventListener('mouseup', onMouseUp, true);
            window.removeEventListener('blur', onMouseUp);
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
            window.addEventListener('blur', onMouseUp);
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
    // 把「选区起点」换算成"整页文本里的第几个字符"，用于页面缩放后文本层被重建时把选区还原回来
    function selectionOffsets(textLayer, range) {
        try {
            const pre = document.createRange();
            pre.selectNodeContents(textLayer);
            pre.setEnd(range.startContainer, range.startOffset);
            const start = pre.toString().length;
            return { start: start, end: start + range.toString().length };
        } catch (e) {
            return null;
        }
    }

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

        const offsets = selectionOffsets(textLayer, range);
        return {
            raw: raw,
            text: raw.trim(),
            rect: rect,
            pageNum: wrapper.dataset.pageNum || '',
            startOffset: offsets ? offsets.start : -1,
            endOffset: offsets ? offsets.end : -1
        };
    }

    // ---------- 缩放后把选区"复活" ----------
    // 页面缩放会重建页面 DOM（文本层被替换），浏览器随即把选区清空 —— 蓝色高亮和气泡一起消失。
    // 这里凭「页码 + 字符偏移」在重建后的文本层里重新构造 Range 并设为当前选区。
    let selectionRestoreTimer = null;

    function stopSelectionRestore() {
        if (selectionRestoreTimer) {
            clearInterval(selectionRestoreTimer);
            selectionRestoreTimer = null;
        }
    }

    function findPageWrapper(pageNum) {
        const list = document.querySelectorAll('.page-wrapper');
        for (let i = 0; i < list.length; i++) {
            if (String(list[i].dataset.pageNum) === String(pageNum)) return list[i];
        }
        return null;
    }

    // 把「整页文本中的第 index 个字符」定位到具体文本节点与偏移
    function locateChar(root, index) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        let seen = 0;
        let node;
        while ((node = walker.nextNode())) {
            const len = node.nodeValue ? node.nodeValue.length : 0;
            if (index <= seen + len) return { node: node, offset: index - seen };
            seen += len;
        }
        return null;
    }

    function buildRangeFromOffsets(ctx) {
        if (!ctx || ctx.startOffset < 0 || ctx.endOffset <= ctx.startOffset) return null;
        const wrapper = findPageWrapper(ctx.pageNum);
        if (!wrapper) return null;
        const textLayer = wrapper.querySelector('.textLayer');
        if (!textLayer || !textLayer.firstChild) return null;
        const total = textLayer.textContent.length;
        if (ctx.endOffset > total) return null;
        const start = locateChar(textLayer, ctx.startOffset);
        const end = locateChar(textLayer, ctx.endOffset);
        if (!start || !end) return null;
        const range = document.createRange();
        try {
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
        } catch (e) {
            return null;
        }
        return range.toString().trim() ? range : null;
    }

    // 页面缩放会连着触发一两轮页面重建，每轮 rebuild 都会 replaceChildren() 把选区清掉；
    // 所以不能"还原一次就收工"——要持续补选区，直到它连续 0.5s 存活（说明渲染真的停了）。
    function scheduleSelectionRestore() {
        if (selectionRestoreTimer || !current) return;
        const ctx = current;
        let ticks = 0;
        let stable = 0;
        selectionRestoreTimer = setInterval(function () {
            ticks++;
            if (current !== ctx) { stopSelectionRestore(); return; }   // 期间用户重新框选 / 关掉了面板
            const sel = window.getSelection();
            if (!sel) { stopSelectionRestore(); return; }

            // 选区活着：连续 5 拍（0.5s）没再被清掉，才算渲染结束，收工
            if (!sel.isCollapsed && sel.rangeCount > 0) {
                stable++;
                if (stable >= 5) {
                    stopSelectionRestore();
                    ctx.rect = sel.getRangeAt(0).getBoundingClientRect();
                    if (bubble && bubble.style.display !== 'none') showBubble(ctx.rect);
                    if (panel && panel.style.display !== 'none' && !panelDragged) showPanel();
                }
                return;
            }

            stable = 0;
            if (!findPageWrapper(ctx.pageNum)) {     // 该页已被回收，锚点失去意义
                stopSelectionRestore();
                if (current === ctx) hideAll();
                return;
            }
            const range = buildRangeFromOffsets(ctx);
            if (range) {
                sel.removeAllRanges();
                sel.addRange(range);
                ctx.rect = range.getBoundingClientRect();
                if (bubble && bubble.style.display !== 'none') showBubble(ctx.rect);
                if (panel && panel.style.display !== 'none' && !panelDragged) showPanel();
            }
            // 6s 兜底：极少数情况（页面反复重建）下停止补选区，但保持气泡不动，不凭空消失
            if (ticks >= 60) stopSelectionRestore();
        }, 100);
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
        stopSelectionRestore();      // 用户手动重新框选 → 作废上一次待还原的选区
        current = ctx;
        showBubble(ctx.rect);
    }

    function onScrollOrResize(e) {
        // 面板内部滚动不应触发关闭
        if (e && e.target && e.target.closest && e.target.closest('#dict-panel, #dict-bubble')) return;
        
        // 当用户滚动或缩放屏幕时，尝试重新获取选区位置以使浮窗“附着”在文本上
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
            stopSelectionRestore();  // 选区健在，不需要还原
            if (!current) return;
            current.rect = sel.getRangeAt(0).getBoundingClientRect();
            if (bubble && bubble.style.display !== 'none') showBubble(current.rect);
            if (panel && panel.style.display !== 'none' && !panelDragged) showPanel();
            return;
        }

        // 选区没了：若气泡/面板还开着，多半是缩放把文本层重建了 —— 等它重建好把选区还原，
        // 而不是直接 hideAll（那样气泡会在缩放时凭空消失）
        const bubbleOn = bubble && bubble.style.display !== 'none';
        const panelOn = panel && panel.style.display === 'block';
        if (current && (bubbleOn || panelOn)) {
            scheduleSelectionRestore();
            return;
        }

        // 如果选区丢失但面板已打开，则保留面板在屏幕上 (但如果没被拖拽，可能不再跟随原文本)
        if (panelOn) {
            return;
        }
        
        hideAll();
    }

    // ---------- 气泡缩放：与 PDF 文字保持固定比例 ----------
    // 页面缩放（state.scale）改变的是 PDF 文字的大小，气泡要跟着一起变，
    // 这样"气泡相对文字的大小"永远一致：缩到 50% 气泡也约一半，放大同样等比。
    let appliedBubbleScale = null;

    function pageScale() {
        const k = (typeof state !== 'undefined' && state && state.scale) ? state.scale : 1;
        return (k > 0 && isFinite(k)) ? k : 1;
    }

    // 把比例写进 CSS 变量 --dict-scale（气泡内所有字号/内边距都按它算）
    function syncBubbleScale() {
        if (!bubble) return;
        const k = pageScale();
        if (k === appliedBubbleScale) return;
        appliedBubbleScale = k;
        bubble.style.setProperty('--dict-scale', k);
    }

    // ---------- 气泡定位 ----------
    function showBubble(rect) {
        ensureDom();
        syncBubbleScale();                 // 先按当前缩放定好尺寸，再量宽高，位置才准
        bubble.style.display = 'flex';
        bubble.style.visibility = 'hidden';

        const bw = bubble.offsetWidth;
        const bh = bubble.offsetHeight;
        // 与选区之间的间距：固定 2px，不随页面缩放放大。
        // （之前写成 8px × pageScale()，页面一放大间距就跟着变宽，气泡看着像飘在半空）
        const gap = 2;

        let left = rect.right - bw;                    // 默认右对齐选区
        let top = rect.top - bh - gap;                 // 紧贴选区上沿
        if (top < 8) top = rect.bottom + gap;          // 上方放不下 → 放到下方

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
    function applyTitle(kind) {
        panelTitle.textContent = kind === 'phrase' ? '短语解析'
            : (kind === 'sentence' ? '句子翻译'
            : (kind === 'word' ? '单词翻译' : '词典查询'));
    }

    async function startTranslate(rawText, mode) {
        const cleaned = cleanSelection(rawText, mode);
        if (!cleaned) return;
        translationRequest?.abort();
        const request = translationRequest = new AbortController();
        const loadToken = state.loadToken;
        const isCurrent = () => translationRequest === request && state.loadToken === loadToken;
        const timeout = setTimeout(() => request.abort(), 135000);

        hideBubble();
        showPanel();
        // 是单词还是短语由模型判断（框选常夹带空白，代码猜不可靠）：
        // 查询期间先用中性的「词典查询」，等结果回来再按 kind 换成单词/短语标题
        applyTitle(mode === 'sentence' ? 'sentence' : null);
        renderLoading(mode === 'sentence' ? '正在翻译…' : '正在查询…');

        try {
            const resp = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: cleaned, mode: mode }), signal: request.signal
            });
            const data = await resp.json();
            if (!isCurrent()) return;
            if (!resp.ok || !data.ok) {
                throw new Error(data.error || ('请求失败 (' + resp.status + ')'));
            }
            if (mode === 'word') {
                renderEntry(data.content, data.kind);
            } else {
                renderSentenceResult(data.content);
            }
        } catch (err) {
            if (isCurrent()) renderError(err.name === 'AbortError' ? '查询超时，请重试' : err.message || String(err));
        } finally {
            clearTimeout(timeout);
            if (translationRequest === request) translationRequest = null;
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

    function renderLoading(label) {
        panelBody.innerHTML =
            '<div class="dict-loading">' +
                '<span class="dict-spinner"></span>' +
                '<span>' + escapeHtml(label || '正在翻译…') + '</span>' +
            '</div>';
    }

    function renderError(msg) {
        panelBody.innerHTML = '<div class="dict-error">' + escapeHtml(msg) + '</div>';
    }

    function renderSentenceResult(content) {
        const text = String(content || '').trim();
        panelTitle.textContent = '句子翻译';
        panelBody.innerHTML = '<div class="dict-sentence">' + escapeHtml(text) + '</div>';
    }

    // 例句列表：兼容 {"en","zh"} 对象与纯字符串两种写法
    function renderExamples(list) {
        const arr = Array.isArray(list) ? list : (list ? [list] : []);
        return arr.map(function (e) {
            const en = typeof e === 'string' ? e : ((e && e.en) || '');
            const zh = typeof e === 'string' ? '' : ((e && e.zh) || '');
            if (!en && !zh) return '';
            return '<li class="dict-example">' +
                (en ? '<div class="dict-ex-en">' + escapeHtml(en) + '</div>' : '') +
                (zh ? '<div class="dict-ex-zh mt-1">' + wrapSpoiler(zh) + '</div>' : '') +
            '</li>';
        }).join('');
    }

    // 单词条目：音标 + 词性 + 中英释义 + 例句
    function renderWordEntry(parsed) {
        panelTitle.textContent = '单词翻译';
        const exHtml = renderExamples(parsed.examples);

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

    // 短语条目：意思 + 用法 + 例句（用法可能是一段话，也可能是若干条要点）
    // 三段并列、不带中文小标题，与单词版式保持一致的克制风格；角标写 phrase 不写中文
    function renderPhraseEntry(parsed) {
        panelTitle.textContent = '短语解析';

        const usageItems = (Array.isArray(parsed.usage) ? parsed.usage : [parsed.usage])
            .filter(function (u) { return u && String(u).trim(); });
        const usageHtml = usageItems.length
            ? '<div class="dict-usage">' +
                  usageItems.map(function (u) {
                      return '<div class="dict-usage-item">' + escapeHtml(u) + '</div>';
                  }).join('') +
              '</div>'
            : '';

        const exHtml = renderExamples(parsed.examples);
        const meaningEn = parsed.meaning_en || parsed.definition_en || '';
        const meaningZh = parsed.meaning_zh || parsed.definition_zh || '';

        panelBody.innerHTML =
            '<div class="dict-word-head">' +
                '<span class="dict-word">' + escapeHtml(parsed.phrase || parsed.word || '') + '</span>' +
                '<span class="dict-tag">phrase</span>' +
            '</div>' +
            (meaningEn ? '<div class="dict-def-en">' + escapeHtml(meaningEn) + '</div>' : '') +
            (meaningZh ? '<div class="dict-def-zh mt-1">' + wrapSpoiler(meaningZh) + '</div>' : '') +
            usageHtml +
            (exHtml ? '<ul class="dict-examples">' + exHtml + '</ul>' : '');
    }

    // 该用单词版式还是短语版式：模型输出的 type 说了算，其次看短语专属字段，
    // 最后才用服务端回传的 kind（它也可能为空，那就按单词版式渲染不空转）
    function detectEntryKind(parsed, fallbackKind) {
        const type = String((parsed && parsed.type) || '').toLowerCase();
        if (type === 'phrase') return 'phrase';
        if (type === 'word') return 'word';
        if (parsed && (parsed.usage || parsed.phrase)) return 'phrase';
        return fallbackKind === 'phrase' ? 'phrase' : 'word';
    }

    function renderEntry(content, fallbackKind) {
        const parsed = parseWordJson(content);
        if (!parsed) {
            // 模型没吐出合法 JSON（例如被中转截断）：退化成整段文本展示，不让面板空着
            applyTitle(fallbackKind);
            panelBody.innerHTML = '<div class="dict-sentence">' +
                escapeHtml(String(content || '').trim()) + '</div>';
            return;
        }
        if (detectEntryKind(parsed, fallbackKind) === 'phrase') {
            renderPhraseEntry(parsed);
        } else {
            renderWordEntry(parsed);
        }
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
    function hidePanel() {
        translationRequest?.abort();
        translationRequest = null;
        if (panel) panel.style.display = 'none';
    }
    window.ReaderDictionary = { reset() {
        hidePanel(); hideBubble(); stopSelectionRestore(); current = null;
    } };
    function hideAll() {
        stopSelectionRestore();      // 收起时别再惦记着还原选区
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
        // 页面缩放时（工具栏的 % 读数会被改写）立即同步气泡尺寸：
        //   · 选区还在 → 量一次新位置把气泡贴回去
        //   · 选区被重建流程清空了 → 走还原流程，等文本层重建好后把蓝色高亮和气泡一起恢复
        if (typeof els !== 'undefined' && els.zoomLevel && window.MutationObserver) {
            new MutationObserver(function () {
                syncBubbleScale();
                if (!current) return;
                const sel = window.getSelection();
                if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
                    current.rect = sel.getRangeAt(0).getBoundingClientRect();
                    if (bubble && bubble.style.display !== 'none') showBubble(current.rect);
                    if (panel && panel.style.display !== 'none' && !panelDragged) showPanel();
                } else if ((bubble && bubble.style.display !== 'none') ||
                           (panel && panel.style.display === 'block')) {
                    scheduleSelectionRestore();
                }
            }).observe(els.zoomLevel, { childList: true, characterData: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
