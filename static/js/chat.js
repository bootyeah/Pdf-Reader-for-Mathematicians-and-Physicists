// =============================================================================
// ⑩ DeepSeek 对话 (DeepSeek Chat) —— 工具栏鲸鱼按钮 + 可拖动悬浮对话框
// -----------------------------------------------------------------------------
// 功能：点击顶栏「DeepSeek 鲸鱼」按钮，在其下方展开一个可拖动的对话面板，
//       通过本地 server.py 代理调用 DeepSeek V4.1 Flash（deepseek-flash）多轮对话。
//       · 支持粘贴 / 拖拽 / 选择图片（PNG / JPEG / WebP / GIF，与上游要求一致）
//       · 流式输出（SSE 边生成边显示），带「停止」按钮
//       · 回答按 Markdown 渲染，公式交给 KaTeX —— 与文本框批注同一套 LaTeX 引擎
//       · 框选后复制 Markdown / LaTeX；回答底部按钮也可复制完整原文
//       · 回答里的 TikZ 图形（裸写或 ```tikz 围栏）自动交给本地 LaTeX 引擎画成矢量图，
//         与批注文本框共用 render.js 的 TikzRender 公共层（按内容缓存，同一段代码只编译一次）
//       · 面板尺寸、位置、模型与思考开关全部记忆在 localStorage
// 依赖：本地 KaTeX auto-render 与 render.js 的 window.TikzRender 公共层。
// 后端：POST /api/chat（见 server.py），密钥只存在于服务端，前端拿不到。
// =============================================================================

(function () {
    'use strict';

    // ---------- 配置 ----------
    const API_URL = '/api/chat';
    const STORAGE_KEY = 'pdf_reader_deepseek_chat_state';
    const MAX_HISTORY = 24;            // 送给模型的历史消息条数上限（不含本轮）
    const MAX_IMAGES = 8;              // 单条消息最多几张图（与后端 CHAT_MAX_IMAGES 对齐）
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    const PDF_THUMB_WIDTH = 360;
    const PDF_HIGHRES_SCALE = 2.5;
    const PDF_HIGHRES_MAX_PX = 2400;
    const PDF_THUMB_CACHE_MAX = 150;
    const HEADER_HEIGHT = 72;          // 顶栏高度（与 LOCALPdfReader.html 的 h-[72px] 一致）
    function getHeaderHeight() {
        if (document.body.classList.contains('toolbar-collapsed')) return 12;
        const h = document.getElementById('main-toolbar') || document.querySelector('header');
        return (h && h.offsetHeight) ? h.offsetHeight : HEADER_HEIGHT;
    }

    // TikZ：公共渲染层由 render.js 暴露（动态获取，确保脚本加载时序稳健）
    function getTikz() { return window.TikzRender || null; }
    const TIKZ_MARK = '\u0000DSTIKZ';              // 与公式占位符同一套思路：先摘出去，避免被转义/强调符碰坏
    const TIKZ_MARK_RE = /^\s*\u0000DSTIKZ(\d+)\u0000\s*$/;
    // 允许从代码围栏里认领 TikZ 的语言标记（模型常用 ```tikz / ```latex）
    const TIKZ_FENCE_LANG = /^(|tex|latex|tikz|pgf|pgfplots|context|plaintext|text|code)$/i;
    const openTikzSources = new Set();             // 用户手动展开过源码的图（重绘后保持展开）

    let MODELS = [
        { id: 'deepseek-flash', label: 'V4.1 Flash', hint: '快 · 日常问答' },
        { id: 'deepseek-v4-pro', label: 'V4 Pro', hint: '强 · 复杂推理' }
    ];

    // 空会话时的开场：只留一个图标与名字，不放副标题，也不放示例胶囊
    const WELCOME =
        '<div class="ds-chat-welcome">' +
            '<div class="ds-chat-welcome-icon">' + whaleIconSvg(30) + '</div>' +
            '<div class="ds-chat-welcome-title">DeepSeek 对话</div>' +
        '</div>';

    // ---------- DOM 引用 ----------
    let panel = null;
    let headerEl = null;
    let bodyEl = null;
    let pdfBtn = null;
    let pdfPickerEl = null;
    let pdfGridEl = null;
    let pdfLocateBtn = null;
    let pdfClearBtn = null;
    let pdfStatusEl = null;
    let pdfCancelBtn = null;
    let pdfConfirmBtn = null;
    let inputEl = null;
    let sendBtn = null;
    let stopBtn = null;
    let thumbsEl = null;
    let modelBtn = null;
    let modelMenu = null;
    let modelLabel = null;
    let fontOutBtn = null;
    let fontInBtn = null;
    let thinkingBtn = null;
    let clearBtn = null;
    let shortcutBtn = null;
    let closeBtn = null;
    let resizeHandle = null;
    let toolbarBtn = null;

    // ---------- 会话状态 ----------
    const FONT_SCALE_MIN = 0.8;
    const FONT_SCALE_MAX = 1.6;
    const FONT_SCALE_STEP = 0.1;
    let fontScale = 1;
    const msgEntryMap = new WeakMap(); // wrap (.ds-msg) -> history entry {role, content}
    let history = [];              // [{role:'user'|'assistant', content:string|Array}]
    let attachments = [];          // 待发送图片 [{id, dataUrl, name, pdfPage?, pdfDoc?, pdfToken?}]
    let pendingImages = 0;         // 正在异步读取中的图片数，防止并发超额
    let streaming = false;         // 正在生成
    let chatStatus = 'idle';       // 'idle' | 'streaming' | 'error'
    let abortController = null;
    let panelVisible = false;
    let isComposing = false;       // 中文输入法组词中（此时回车不算发送）
    let pendingScroll = false;
    let renderScheduled = false;
    let model = MODELS[0].id;
    let thinking = false;
    let apiRevision = '';
    let apiRefresh = null;
    let restoringState = false;
    let modelThinking = {};        // 模型 → 'enabled' | 'disabled' | 'low' | 'medium' | 'high' | 'omit'（来自 /api/ai-config）
    let modelCapabilities = {};

    // ---------- PDF 选页抽屉状态 ----------
    let pdfPickerOpen = false;
    let pdfSelectedPages = [];
    let pdfLastClickedPage = null;
    let pdfThumbObserver = null;
    let pdfThumbCache = new Map();
    let pdfThumbDoc = null;
    let pdfThumbToken = null;
    let pdfPickerGen = 0;
    let pdfThumbQueue = [];
    let pdfThumbActive = 0;
    let pdfConfirming = false;
    let pdfShownCurrentPage = 0;
    let pdfViewerScrollBound = null;

    function isThinkingModeEnabled(mode) {
        return ['enabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(mode);
    }

    // 当前模型设置为 omit 时：按钮置灰、不发送，但保留用户对其他模型的开关偏好
    function thinkingAllowed() {
        return modelThinking[model] !== 'omit' && modelCapabilities[model]?.can_disable !== false;
    }

    function syncThinkingAvailability() {
        if (!thinkingBtn) return;
        const allowed = thinkingAllowed();
        thinkingBtn.disabled = !allowed;
        if (allowed) {
            setThinking(thinking);
        } else {
            const mandatory = modelCapabilities[model]?.can_disable === false && modelCapabilities[model]?.default_thinking !== false;
            thinkingBtn.classList.toggle('active', mandatory);
            thinkingBtn.title = mandatory ? '当前模型始终开启思考，不能关闭；档位在 API Manager 中设置。'
                : '当前使用模型默认思考设置（omit）。';
        }
    }

    function refreshApiSettings() {
        if (apiRefresh) return apiRefresh;
        apiRefresh = (async function () {
            const response = await fetch('/api/ai-config', { cache: 'no-store' });
            if (response.status === 404) return; // Older reader / static test fixture.
            if (!response.ok) throw new Error('API 配置无法读取，请打开独立管理工具检查。');
            const cfg = await response.json();
            if (!cfg.model || !Array.isArray(cfg.models)) return;
            const changed = apiRevision !== cfg.revision;
            modelThinking = cfg.model_thinking || {};
            modelCapabilities = cfg.model_capabilities || {};
            const providers = cfg.model_provider || {};
            MODELS = [cfg.model].concat(cfg.models).filter(function (id, i, all) {
                return typeof id === 'string' && id && all.indexOf(id) === i;
            }).map(function (id, i) {
                const gemini = providers[id] === 'chat_gemini';
                return {id: id, label: id, hint: gemini ? 'Gemini · 独立接口' : (i ? '可选模型' : '管理工具 · 默认模型')};
            });
            buildModelMenu();
            apiRevision = cfg.revision;
            if (changed) {
                setModel(cfg.model);
                setThinking(isThinkingModeEnabled(modelThinking[model] || cfg.thinking));
            } else if (!MODELS.some(function (m) { return m.id === model; })) {
                setModel(cfg.model);
            } else {
                syncThinkingAvailability();
            }
        })().finally(function () { apiRefresh = null; });
        return apiRefresh;
    }

    // ---------- 小工具 ----------
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 工具栏按钮用的鲸鱼图标；面板里也复用同一份路径（换尺寸即可）
    function whaleIconSvg(size) {
        const s = size || 20;
        return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" ' +
            'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M2.8 9.2C4.6 8.2 6.6 12 8.7 13.1c2 1.05 5.2 1.5 8.6.7 3.4-.8 4.3-4.1 4.3-6.9-1.1 1-2 1.3-2.9 1.2 1-1.4 1.3-3.3 1.2-5.3-1.3 1.8-3.4 2.6-5.2 2.6C11.4 3.9 8.1 4.6 5.8 6.4 3.7 7.9 2.8 9.2 2.8 9.2z" />' +
            '<path d="M6.9 13.5c-.5 1.4-1.4 2.5-2.7 3.3" />' +
            '<circle cx="15.8" cy="8.1" r="0.95" fill="currentColor" stroke="none" />' +
            '</svg>';
    }

    // =========================================================================
    // 一、轻量 Markdown 渲染器
    //   只覆盖模型实际会用到的语法（标题 / 列表 / 表格 / 引用 / 代码 / 强调），
    //   不引入任何第三方库（整个阅读器是 100% 离线的）。
    //   数学公式不在这里解析：输出里的 $...$ 原样保留，随后交给 KaTeX 的
    //   auto-render 统一渲染（与文本框批注共用一套引擎，行为完全一致）。
    // =========================================================================
    const MATH_TOKEN_PREFIX = '\u0000DSMATH';

    function tokenizeMath(text) {
        const tokens = [];
        const out = String(text == null ? '' : text).replace(
            /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?!\s)(?:\\.|[^$\\\n])+?(?<!\\)\$/g,
            function (m) {
                tokens.push(m);
                return MATH_TOKEN_PREFIX + (tokens.length - 1) + '\u0000';
            }
        );
        return { text: out, tokens: tokens };
    }

    function mathSourceHtml(raw) {
        return '<span data-ds-math="' + escapeHtml(raw) + '">' + escapeHtml(raw) + '</span>';
    }

    function restoreMath(html, tokens, codeOnly) {
        if (!tokens.length) return html;
        return html.replace(/\u0000DSMATH(\d+)\u0000/g, function (m, i) {
            const raw = tokens[Number(i)];
            return raw == null ? '' : (codeOnly ? escapeHtml(raw) : mathSourceHtml(raw));
        });
    }

    // 代码围栏里的正文同样被数学占位符动过手脚，这里按「原文」还原（不能转义，否则源码就不是源码了）
    function restoreMathRaw(text, tokens) {
        if (!tokens.length) return text;
        return String(text == null ? '' : text).replace(/\u0000DSMATH(\d+)\u0000/g, function (m, i) {
            const raw = tokens[Number(i)];
            return raw == null ? '' : raw;
        });
    }

    // =========================================================================
    // 一·五、TikZ：把回答里的 TikZ 段落换成占位标记，随后交给本地 LaTeX 引擎出图
    //   为什么先换成标记：Markdown 渲染会做 HTML 转义、`*`/`_` 强调、`$` 公式抽取，
    //   这些都会改坏 TikZ 源码（`x_1`、`$x$`、`--`、下划线等）。先把整块摘出去，
    //   它就不会被行内处理碰到；渲染到那一步时再原样还给引擎。
    // =========================================================================

    // 找出文本里所有 TikZ 环境，把每一块换成独占一行的标记；返回 {text, blocks}
    // 围栏代码块里的内容一律不碰（交给 markdownToHtml 的围栏分支去认领），
    // 否则「```latex 包着 tikzpicture」会被这里先摘走，围栏里就只剩一个标记了。
    // 未闭合的半截块同样要摘出来：流式中它是占位符，生成结束后要变成可读的源码块
    // —— 留成正文的话，`\draw` 之类的会被当成普通文字铺在回答里。
    function splitTikzBlocks(src) {
        const TIKZ = getTikz();
        const blocks = [];
        const text = String(src == null ? '' : src);
        if (!TIKZ) return { text: text, blocks: blocks };

        const found = TIKZ.scanTikzBlocks(maskFencedRegions(text), true);
        if (!found.length) return { text: text, blocks: blocks };

        let out = '';
        let cursor = 0;
        found.forEach(function (block) {
            out += text.slice(cursor, block.start) + '\n\n' + TIKZ_MARK + blocks.length + '\u0000\n\n';
            blocks.push(block);
            cursor = block.end;
        });
        return { text: out + text.slice(cursor), blocks: blocks };
    }

    // 把围栏代码块（含围栏行本身）整段替换成等长空格：长度不变，所以扫描出来的偏移量仍然对得上原文
    function maskFencedRegions(text) {
        const chars = text.split('');
        let fence = null;
        let pos = 0;
        text.split('\n').forEach(function (line) {
            const m = /^\s*(```|~~~)/.exec(line);
            let masked = !!fence;
            if (m) {
                if (!fence) { fence = m[1]; masked = true; }
                else if (fence === m[1]) { fence = null; masked = true; }
            }
            if (masked) {
                for (let k = pos; k < pos + line.length; k++) chars[k] = ' ';
            }
            pos += line.length + 1;
        });
        return chars.join('');
    }

    function tikzPendingHtml(hint) {
        return '<div class="ds-tikz-pending"><span class="dict-spinner"></span><span>' +
            escapeHtml(hint || '正在绘制图形…') + '</span></div>';
    }

    function tikzErrorHtml(message) {
        return '<div class="ds-tikz-error"><i class="ph ph-warning-circle"></i>' +
            '<span>图形编译失败：' + escapeHtml(message || '请检查 TikZ 语法') +
            '（可展开下方源码修改后重试）</span></div>';
    }

    // 一张 TikZ 图的完整外壳：图 / 占位 / 报错 + 「源码 · 复制」工具条
    // complete=false 表示 \begin 已经来了、\end 还在路上（流式输出里很常见）
    function tikzFigureHtml(block, ctx) {
        const TIKZ = getTikz();
        const code = block.code;
        const env = block.env || 'tikzpicture';

        if (!TIKZ) return renderCodeBlock(code, env, !block.complete);
        if (!block.complete && !ctx.streaming) {
            return renderCodeBlock(code, env, true) +
                '<div class="ds-chat-note">（这段 TikZ 没有闭合，未送去编译；可展开源码检查）</div>';
        }

        let view = '';
        let state = '';
        if (!block.complete) {
            view = tikzPendingHtml('正在绘制图形…');
            state = '绘制中';
        } else {
            const entry = TIKZ.requestTikzSvg(code, { extractBody: true }, ctx.onTikzReady);
            if (entry.status === 'done') {
                view = '<img class="ds-tikz-img" src="' + entry.dataUrl + '" alt="TikZ 图形">';
                state = '已渲染';
            } else if (entry.status === 'error') {
                view = tikzErrorHtml(entry.error);
                state = '编译失败';
            } else {
                view = tikzPendingHtml('正在绘制图形…');
                state = '绘制中';
            }
        }

        const open = openTikzSources.has(code);
        return '<figure class="ds-tikz">' +
                '<div class="ds-tikz-view">' + view + '</div>' +
                '<figcaption class="ds-tikz-bar">' +
                    '<span class="ds-tikz-badge">TikZ</span>' +
                    '<span class="ds-tikz-state">' + escapeHtml(state) + '</span>' +
                    '<span class="ds-tikz-grow"></span>' +
                    '<button type="button" class="ds-tikz-btn ds-tikz-toggle' + (open ? ' active' : '') +
                        '" title="查看 / 收起 TikZ 源码"><i class="ph ph-code"></i></button>' +
                    '<button type="button" class="ds-tikz-btn ds-tikz-copy" title="复制 TikZ 源码">' +
                        '<i class="ph ph-copy"></i></button>' +
                '</figcaption>' +
                '<pre class="ds-tikz-source ignored-by-katex"' + (open ? '' : ' hidden') +
                    '><code>' + escapeHtml(code) + '</code></pre>' +
            '</figure>';
    }

    function inlineMarkdown(text, tokens) {
        const codes = [];
        const html = escapeHtml(text)
            // 行内代码：先占位，免得里面的 * _ 被当成强调符
            .replace(/`([^`]+)`/g, function (m, code) {
                codes.push('<code class="ds-code-inline">' + restoreMath(code, tokens, true) + '</code>');
                return '\u0000DSCODE' + (codes.length - 1) + '\u0000';
            })
            .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, alt, src) {
                const safeSrc = restoreMath(src, tokens, true);
                const safeAlt = restoreMath(alt, tokens, true);
                return /^(https?:|data:image\/)/i.test(safeSrc)
                    ? '<img class="ds-chat-img" src="' + safeSrc + '" alt="' + safeAlt + '">'
                    : m;
            })
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, href) {
                const safeHref = restoreMath(href, tokens, true);
                return /^(https?:|mailto:)/i.test(safeHref)
                    ? '<a href="' + safeHref + '" target="_blank" rel="noreferrer">' + label + '</a>'
                    : label;
            })
            .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
            .replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>')
            .replace(/~~([^~]+)~~/g, '<del>$1</del>');
        return restoreMath(html, tokens).replace(/\u0000DSCODE(\d+)\u0000/g, function (m, i) {
            return codes[Number(i)];
        });
    }

    function isTableSeparator(line) {
        return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line || '');
    }

    function splitTableRow(line) {
        return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) {
            return c.trim();
        });
    }

    // 表格单元格里的「裸 LaTeX」兜底：模型经常把公式写进表格却忘了加 $，
    // 于是单元格会原样显示成 e^{i\pi}+1=0。只在单元格这种独立单元里做判定，
    // 且必须同时满足「没有中文/自然语言」+「带 LaTeX 特征」，避免误伤普通文本。
    function looksLikeBareLatex(text) {
        const s = String(text || '').trim();
        if (!s || s.length > 120) return false;
        if (s.indexOf('$') !== -1 || s.indexOf('`') !== -1 || s.indexOf(MATH_TOKEN_PREFIX) !== -1) return false;
        if (/[\u4e00-\u9fa5，。；：、“”（）]/.test(s)) return false;         // 有中文 → 是说明文字
        if (/(^|\s)[A-Za-z]{3,}(\s|$)/.test(s)) return false;                 // 有普通英文单词 → 是说明文字
        if (!/\\[A-Za-z]+|[{}^_]/.test(s)) return false;                      // 没有任何 LaTeX 特征
        if (/[。！？]/.test(s)) return false;
        return true;
    }

    function cellMarkdown(cell, tokens) {
        const raw = cell == null ? '' : cell;
        return looksLikeBareLatex(raw) ? mathSourceHtml('$' + raw + '$') : inlineMarkdown(raw, tokens);
    }

    function renderTable(rows, tokens) {
        const head = splitTableRow(rows[0]);
        const body = rows.slice(2).map(splitTableRow);
        let html = '<div class="ds-table-wrap"><table class="ds-table"><thead><tr>';
        head.forEach(function (c) {
            html += '<th>' + cellMarkdown(c, tokens) + '</th>';
        });
        html += '</tr></thead><tbody>';
        body.forEach(function (cells) {
            html += '<tr>';
            for (let i = 0; i < head.length; i++) {
                html += '<td>' + cellMarkdown(cells[i], tokens) + '</td>';
            }
            html += '</tr>';
        });
        return html + '</tbody></table></div>';
    }

    function renderCodeBlock(code, lang, open) {
        return '<div class="ds-code-block' + (open ? ' is-open' : '') + '">' +
            '<div class="ds-code-head"><span class="ds-code-lang">' + escapeHtml(lang || 'code') + '</span>' +
            '<button type="button" class="ds-code-copy" title="复制代码"><i class="ph ph-copy"></i></button></div>' +
            '<pre><code>' + escapeHtml(code) + '</code></pre>' +
            '</div>';
    }

    function markdownToHtml(src, ctx) {
        const TIKZ = getTikz();
        const context = ctx || {};
        // TikZ 先摘出去（换成独占一行的标记），剩下的文本才交给公式与 Markdown 处理
        const tikzOn = context.tikz !== false && !!TIKZ;
        // 引用块是递归渲染的：外层已经摘过一遍，这里直接接用它的块表，绝不能再扫一次
        const split = context.tzSplit
            ? { text: src, blocks: context.tzBlocks || [] }
            : (tikzOn ? splitTikzBlocks(src) : { text: src, blocks: [] });
        const tk = tokenizeMath(split.text);
        const lines = tk.text.replace(/\r\n?/g, '\n').split('\n');
        let html = '';
        let i = 0;

        // 列表用「栈」维护嵌套：'ul' / 'ol' 交替时按缩进层级开关标签
        const stack = [];

        function closeLists(toDepth) {
            while (stack.length > (toDepth == null ? 0 : toDepth)) {
                html += stack.pop() === 'ol' ? '</ol>' : '</ul>';
            }
        }

        while (i < lines.length) {
            const line = lines[i];

            // --- TikZ 图形（前面摘出来的块，这里长回一张图） ---
            const tikzMark = TIKZ_MARK_RE.exec(line);
            if (tikzMark) {
                const block = split.blocks[Number(tikzMark[1])];
                closeLists();
                html += block ? tikzFigureHtml(block, context) : escapeHtml(line);
                i++;
                continue;
            }

            // --- 围栏代码块 ---
            const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
            if (fence) {
                const marker = fence[1];
                const lang = fence[2];
                const buf = [];
                i++;
                let closed = false;
                while (i < lines.length) {
                    if (new RegExp('^\\s*' + marker + '\\s*$').test(lines[i])) { closed = true; i++; break; }
                    buf.push(lines[i]);
                    i++;
                }
                closeLists();
                const fenceBody = buf.join('\n');
                // ```tikz / ```latex 里包着的就是 TikZ 源码 —— 画出来，而不是当代码贴一遍
                const fencedTikz = (tikzOn && closed && TIKZ_FENCE_LANG.test(lang))
                    ? TIKZ.scanTikzBlocks(restoreMathRaw(fenceBody, tk.tokens), false)
                    : [];
                if (fencedTikz.length) {
                    fencedTikz.forEach(function (block) {
                        html += tikzFigureHtml({ code: block.code, env: block.env, complete: true }, context);
                    });
                    continue;
                }
                html += renderCodeBlock(restoreMathRaw(fenceBody, tk.tokens), lang, !closed);
                continue;
            }

            // --- 空行 ---
            if (!line.trim()) { closeLists(); i++; continue; }

            // --- 标题 ---
            const heading = /^(#{1,6})\s+(.*)$/.exec(line);
            if (heading) {
                closeLists();
                const level = Math.min(6, heading[1].length + 2);   // # → h3（面板里不需要 h1/h2 那么大）
                html += '<h' + level + ' class="ds-h" data-ds-heading="' + heading[1].length + '">' + inlineMarkdown(heading[2], tk.tokens) + '</h' + level + '>';
                i++;
                continue;
            }

            // --- 分隔线 ---
            if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
                closeLists();
                html += '<hr class="ds-hr">';
                i++;
                continue;
            }

            // --- 表格 ---
            if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
                const rows = [line, lines[i + 1]];
                i += 2;
                while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) {
                    rows.push(lines[i]);
                    i++;
                }
                closeLists();
                html += renderTable(rows, tk.tokens);
                continue;
            }

            // --- 引用 ---
            if (/^\s*>/.test(line)) {
                const buf = [];
                while (i < lines.length && /^\s*>/.test(lines[i])) {
                    buf.push(lines[i].replace(/^\s*>\s?/, ''));
                    i++;
                }
                closeLists();
                html += '<blockquote class="ds-quote">' +
                    markdownToHtml(restoreMathRaw(buf.join('\n'), tk.tokens), {
                        streaming: context.streaming,
                        tikz: context.tikz,
                        tzSplit: true,
                        tzBlocks: split.blocks,
                        onTikzReady: context.onTikzReady
                    }) + '</blockquote>';
                continue;
            }

            // --- 列表 ---
            const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
            if (li) {
                const indent = li[1].replace(/\t/g, '    ').length;
                const depth = Math.min(3, Math.floor(indent / 2)) + 1;
                const kind = /\d/.test(li[2]) ? 'ol' : 'ul';
                while (stack.length > depth) html += stack.pop() === 'ol' ? '</ol>' : '</ul>';
                if (stack.length < depth) {
                    while (stack.length < depth) { stack.push(kind); html += kind === 'ol' ? '<ol>' : '<ul>'; }
                } else if (stack[stack.length - 1] !== kind) {
                    html += stack.pop() === 'ol' ? '</ol>' : '</ul>';
                    stack.push(kind);
                    html += kind === 'ol' ? '<ol>' : '<ul>';
                }
                const text = li[3];
                // 任务列表（- [x] 已办）
                const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
                if (task) {
                    html += '<li class="ds-li-task" data-ds-marker="' + li[2] + '"><input type="checkbox" disabled' +
                        (task[1].toLowerCase() === 'x' ? ' checked' : '') + '> ' +
                        inlineMarkdown(task[2], tk.tokens) + '</li>';
                } else {
                    html += '<li data-ds-marker="' + li[2] + '">' + inlineMarkdown(text, tk.tokens) + '</li>';
                }
                i++;
                continue;
            }

            // --- 普通段落（连续非空行合并，行内换行保留为 <br>） ---
            const buf = [line];
            i++;
            while (i < lines.length && lines[i].trim() &&
                   !/^\s*(```|~~~|>|#{1,6}\s|([-*+]|\d+[.)])\s)/.test(lines[i]) &&
                   !(lines[i].indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) &&
                   !/^\s*([-*_])\s*\1\s*\1/.test(lines[i])) {
                buf.push(lines[i]);
                i++;
            }
            closeLists();
            html += '<p>' + buf.map(function (l) {
                return inlineMarkdown(l, tk.tokens);
            }).join('<br>') + '</p>';
        }

        closeLists();
        return html;
    }

    // 公式与批注使用同一套本地 KaTeX 引擎；对话额外跳过代码块。
    const MATH_OPTIONS = {
        delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true }
        ],
        throwOnError: false,
        strict: false,
        ignoredClasses: ['ds-code-block', 'ds-code-inline', 'ignored-by-katex']
    };

    function renderMathIn(el) {
        if (!el) return;
        try {
            if (window.renderMathInElement) {
                renderMathInElement(el, MATH_OPTIONS);
            }
        } catch (e) { /* KaTeX 渲染异常时保留原 HTML 内容 */ }
    }

    // 同一份登记同时用于全文复制、流式更新与 TikZ 完成后的重绘。
    const paintedMessages = new Map(); // body -> {markdown, opts, pending}
    let repaintQueued = false;
    let selectingBody = null;

    function selectionTouches(el) {
        const selection = window.getSelection();
        return !!selection && !selection.isCollapsed && selection.rangeCount > 0 &&
            selection.getRangeAt(0).intersectsNode(el);
    }

    function paintMessageBody(el, markdown, opts) {
        const options = opts || {};
        const pending = selectingBody === el || selectionTouches(el);
        paintedMessages.set(el, { markdown: markdown, opts: options, pending: pending });
        // 框选期间只更新数据，避免流式输出或 TikZ 重绘销毁鼠标选区。
        if (pending) return;

        el.innerHTML = markdownToHtml(markdown, {
            streaming: !!options.streaming,
            tikz: options.tikz,
            onTikzReady: scheduleTikzRepaint
        });
        renderMathIn(el);
        if (options.note) {
            el.insertAdjacentHTML('beforeend', '<div class="ds-chat-note">' + escapeHtml(options.note) + '</div>');
        }

        const wrap = el.closest('.ds-msg-assistant');
        if (wrap && markdown) {
            ensureAssistantActions(wrap);
        }
    }

    function ensureAssistantActions(wrap) {
        if (!wrap || wrap.querySelector('.ds-message-copy')) return;
        let actions = wrap.querySelector('.ds-msg-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'ds-msg-actions';
            wrap.appendChild(actions);
        }
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'ds-message-copy';
        copy.title = '复制选中的 Markdown / LaTeX；未框选时复制完整回答（含 TikZ 源码）';
        copy.setAttribute('aria-live', 'polite');
        copy.innerHTML = '<i class="ph ph-copy" aria-hidden="true"></i><span>复制 Markdown</span>';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'ds-msg-action ds-msg-edit';
        edit.title = '修改此条 AI 回答内容';
        edit.innerHTML = '<i class="ph ph-pencil-simple" aria-hidden="true"></i><span>修改</span>';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ds-msg-action ds-msg-delete';
        del.title = '从当前对话上下文中删除此条回答';
        del.innerHTML = '<i class="ph ph-trash" aria-hidden="true"></i><span>删除</span>';
        // 放在气泡外：流式输出、TikZ 编译完成和历史恢复都不改动操作按钮。
        actions.appendChild(copy);
        actions.appendChild(edit);
        actions.appendChild(del);
    }

    // 某张图编译完（成功或失败）后回调：只重画「还挂着占位符」的那几条消息，
    // 一帧最多一次 —— 否则流式输出里每帧都会登记一次回调，图出来时会连着重画几十遍。
    function scheduleTikzRepaint() {
        if (repaintQueued) return;
        repaintQueued = true;
        requestAnimationFrame(function () {
            repaintQueued = false;
            paintedMessages.forEach(function (record, el) {
                if (!el.isConnected) { paintedMessages.delete(el); return; }
                if (el.querySelector('.ds-tikz-pending')) paintMessageBody(el, record.markdown, record.opts);
            });
        });
    }

    function resumeSelectedMessages() {
        if (!panelVisible && !selectingBody) return;
        if (!paintedMessages.size) return;
        paintedMessages.forEach(function (record, el) {
            if (!el.isConnected) { paintedMessages.delete(el); return; }
            if (record.pending && selectingBody !== el && !selectionTouches(el)) {
                paintMessageBody(el, record.markdown, record.opts);
            }
        });
    }

    // =========================================================================
    // 二、面板 DOM 构建
    // =========================================================================
    function ensureDom() {
        if (panel) return;

        panel = document.createElement('div');
        panel.id = 'ds-chat-panel';
        panel.className = 'ds-chat-panel';
        panel.innerHTML =
            '<div class="ds-chat-header" id="ds-chat-header">' +
                '<span class="ds-chat-brand" title="DeepSeek 对话">' + whaleIconSvg(17) + '</span>' +
                '<div class="ds-chat-model-wrap">' +
                    '<button type="button" class="ds-chat-model" id="ds-chat-model-btn" title="切换模型">' +
                        '<span id="ds-chat-model-label">V4.1 Flash</span>' +
                        '<i class="ph ph-caret-down ds-chat-model-caret"></i>' +
                    '</button>' +
                    '<div class="ds-chat-model-menu" id="ds-chat-model-menu"></div>' +
                '</div>' +
                '<button type="button" class="window-shortcut-btn ds-shortcut-btn" id="ds-chat-shortcut-btn" title="关闭对话 (快捷键: D)" aria-label="关闭对话 (D)">' +
                    '<span class="ws-action">关闭</span>' +
                    '<kbd class="ws-key">D</kbd>' +
                '</button>' +
                '<div class="ds-chat-spacer"></div>' +
                '<div class="ds-chat-font-group" title="调节对话排版字号">' +
                    '<button type="button" class="ds-chat-hbtn ds-chat-font-btn" id="ds-chat-font-out-btn" title="缩小字体" aria-label="缩小字体">A-</button>' +
                    '<button type="button" class="ds-chat-hbtn ds-chat-font-btn" id="ds-chat-font-in-btn" title="放大字体" aria-label="放大字体">A+</button>' +
                '</div>' +
                '<button type="button" class="ds-chat-hbtn" id="ds-chat-thinking-btn" title="思考模式（更周密，但更慢）">' +
                    '<i class="ph ph-brain"></i>' +
                '</button>' +
                '<button type="button" class="ds-chat-hbtn" id="ds-chat-clear-btn" title="清空对话">' +
                    '<i class="ph ph-broom"></i>' +
                '</button>' +
                '<button type="button" class="ds-chat-hbtn ds-chat-hbtn-close" id="ds-chat-close-btn" title="关闭对话 (D / Esc)">' +
                    '<i class="ph ph-x"></i>' +
                '</button>' +
            '</div>' +
            '<div class="ds-chat-stage">' +
                '<div class="ds-chat-body custom-scrollbar" id="ds-chat-body">' + WELCOME + '</div>' +
                '<div class="ds-pdf-picker" id="ds-pdf-picker" hidden>' +
                    '<div class="ds-pdf-picker-bar">' +
                        '<button type="button" class="ds-pdf-pill" id="ds-pdf-clear-btn" title="清空已选页面" aria-label="清空已选页面">' +
                            '<i class="ph ph-trash"></i>' +
                        '</button>' +
                        '<button type="button" class="ds-pdf-pill ds-pdf-locate-btn" id="ds-pdf-locate-btn" title="定位到当前阅读页" aria-label="定位到当前阅读页">' +
                            '<i class="ph ph-crosshair"></i>' +
                        '</button>' +
                    '</div>' +
                    '<div class="ds-pdf-grid custom-scrollbar" id="ds-pdf-grid"></div>' +
                    '<div class="ds-pdf-picker-foot">' +
                        '<span class="ds-pdf-status" id="ds-pdf-status"></span>' +
                        '<div class="ds-pdf-foot-btns">' +
                            '<button type="button" class="ds-edit-btn" id="ds-pdf-cancel-btn">取消</button>' +
                            '<button type="button" class="ds-edit-btn ds-edit-primary" id="ds-pdf-confirm-btn">添加高清图</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="ds-chat-thumbs" id="ds-chat-thumbs"></div>' +
            '<div class="ds-chat-input-row">' +
                '<button type="button" class="ds-chat-tool" id="ds-chat-pdf-btn" title="选择 PDF 页面转高清图片发送">' +
                    '<i class="ph ph-file-pdf"></i>' +
                '</button>' +
                '<textarea id="ds-chat-input" class="ds-chat-input" rows="1" placeholder=""></textarea>' +
                '<button type="button" class="ds-chat-send" id="ds-chat-send-btn" title="发送 (Enter)">' +
                    '<i class="ph ph-paper-plane-right"></i>' +
                '</button>' +
            '</div>' +
            '<div class="ds-chat-resize-handle" id="ds-chat-resize" title="拖动调整大小">' +
                '<svg viewBox="0 0 6 6" style="fill:#cbd5e1;"><circle cx="5" cy="5" r="0.8"/><circle cx="5" cy="2" r="0.8"/><circle cx="2" cy="5" r="0.8"/></svg>' +
            '</div>';
        document.body.appendChild(panel);

        headerEl = panel.querySelector('#ds-chat-header');
        bodyEl = panel.querySelector('#ds-chat-body');
        pdfBtn = panel.querySelector('#ds-chat-pdf-btn');
        pdfPickerEl = panel.querySelector('#ds-pdf-picker');
        pdfGridEl = panel.querySelector('#ds-pdf-grid');
        pdfLocateBtn = panel.querySelector('#ds-pdf-locate-btn');
        pdfClearBtn = panel.querySelector('#ds-pdf-clear-btn');
        pdfStatusEl = panel.querySelector('#ds-pdf-status');
        pdfCancelBtn = panel.querySelector('#ds-pdf-cancel-btn');
        pdfConfirmBtn = panel.querySelector('#ds-pdf-confirm-btn');
        inputEl = panel.querySelector('#ds-chat-input');
        sendBtn = panel.querySelector('#ds-chat-send-btn');
        thumbsEl = panel.querySelector('#ds-chat-thumbs');
        modelBtn = panel.querySelector('#ds-chat-model-btn');
        modelMenu = panel.querySelector('#ds-chat-model-menu');
        modelLabel = panel.querySelector('#ds-chat-model-label');
        fontOutBtn = panel.querySelector('#ds-chat-font-out-btn');
        fontInBtn = panel.querySelector('#ds-chat-font-in-btn');
        thinkingBtn = panel.querySelector('#ds-chat-thinking-btn');
        clearBtn = panel.querySelector('#ds-chat-clear-btn');
        shortcutBtn = panel.querySelector('#ds-chat-shortcut-btn');
        closeBtn = panel.querySelector('#ds-chat-close-btn');
        resizeHandle = panel.querySelector('#ds-chat-resize');
        toolbarBtn = document.getElementById('deepseek-chat-btn');
        setChatStatus(chatStatus);

        applyFontScale(fontScale);
        buildModelMenu();
        bindEvents();
        panel.style.display = 'none';
        // 自建「停止」按钮：生成中替换发送键，避免界面上多出一个常驻按钮
        stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'ds-chat-send ds-chat-stop';
        stopBtn.id = 'ds-chat-stop-btn';
        stopBtn.title = '停止生成';
        stopBtn.innerHTML = '<i class="ph ph-stop"></i>';
        stopBtn.style.display = 'none';
        stopBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            abortStream();
        });
        sendBtn.parentNode.insertBefore(stopBtn, sendBtn.nextSibling);
    }

    function buildModelMenu() {
        modelMenu.innerHTML = MODELS.map(function (m) {
            return '<button type="button" class="ds-chat-model-opt" data-model="' + escapeHtml(m.id) + '">' +
                '<span class="ds-chat-model-name">' + escapeHtml(m.label) + '</span>' +
                '<span class="ds-chat-model-hint">' + escapeHtml(m.hint) + '</span>' +
            '</button>';
        }).join('');
        modelMenu.querySelectorAll('.ds-chat-model-opt').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                setModel(btn.dataset.model);
                modelMenu.classList.remove('show');
            });
        });
    }

    function setModel(id) {
        const prevModel = model;
        model = MODELS.some(function (m) { return m.id === id; }) ? id : MODELS[0].id;
        const m = MODELS.filter(function (x) { return x.id === model; })[0];
        if (modelLabel) modelLabel.textContent = m.label;
        if (modelBtn) modelBtn.title = '当前模型：' + m.label + '（' + m.hint + '）· 点击切换';
        modelMenu.querySelectorAll('.ds-chat-model-opt').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.model === model);
        });
        if (model !== prevModel && modelThinking[model] !== undefined) {
            thinking = isThinkingModeEnabled(modelThinking[model]);
        }
        saveState();
        syncThinkingAvailability();
    }

    function setThinking(on) {
        thinking = !!on;
        const mode = modelThinking[model];
        const levelHint = isThinkingModeEnabled(mode) && mode !== 'enabled' ? ' · ' + mode : '';
        thinkingBtn.classList.toggle('active', thinking);
        thinkingBtn.title = thinking
            ? '思考模式：开' + levelHint + '（回答更周密，首字更慢）'
            : '思考模式：关（默认，响应更快）';
        saveState();
    }

    function applyFontScale(scale) {
        const num = Number(scale);
        fontScale = Number.isFinite(num)
            ? Math.round(Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, num)) * 100) / 100
            : 1;
        if (panel) panel.style.setProperty('--ds-font-scale', String(fontScale));
        const pct = Math.round(fontScale * 100) + '%';
        if (fontOutBtn) {
            fontOutBtn.disabled = fontScale <= FONT_SCALE_MIN + 0.001;
            fontOutBtn.title = '缩小字体（当前 ' + pct + '）';
        }
        if (fontInBtn) {
            fontInBtn.disabled = fontScale >= FONT_SCALE_MAX - 0.001;
            fontInBtn.title = '放大字体（当前 ' + pct + '）';
        }
    }

    function setFontScale(scale) {
        applyFontScale(scale);
        saveState();
    }

    // =========================================================================
    // 三、渲染会话
    // =========================================================================
    let historyDomPending = false;

    function clearBody() {
        historyDomPending = false;
        bodyEl.innerHTML = '';
        paintedMessages.clear();
        openTikzSources.clear();
        selectingBody = null;
        if (!streaming && chatStatus === 'error') {
            setChatStatus('idle');
        }
    }

    function showWelcome() {
        bodyEl.innerHTML = WELCOME;
    }

    function messageEl(role) {
        const wrap = document.createElement('div');
        wrap.className = 'ds-msg ds-msg-' + role;
        const bubble = document.createElement('div');
        bubble.className = 'ds-bubble';
        wrap.appendChild(bubble);
        bodyEl.appendChild(wrap);
        return { wrap: wrap, bubble: bubble };
    }

    function renderUserBubble(bubble, text, images) {
        let html = '';
        (images || []).forEach(function (src) {
            html += '<img class="ds-chat-img" src="' + src + '" alt="图片">';
        });
        if (text) {
            // 用户原文按纯文本显示（保留换行），不做 Markdown 解析
            html += '<div class="ds-user-text">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
        }
        bubble.innerHTML = html;
    }

    function userMessageEl(text, images) {
        const el = messageEl('user');
        renderUserBubble(el.bubble, text, images);
        const actions = document.createElement('div');
        actions.className = 'ds-msg-actions';
        actions.innerHTML =
            '<button type="button" class="ds-msg-action ds-msg-edit" title="修改此条提问">' +
                '<i class="ph ph-pencil-simple" aria-hidden="true"></i><span>修改</span>' +
            '</button>' +
            '<button type="button" class="ds-msg-action ds-msg-resend" title="以此处修改后的上下文重新向 AI 发送">' +
                '<i class="ph ph-arrows-clockwise" aria-hidden="true"></i><span>重发</span>' +
            '</button>' +
            '<button type="button" class="ds-msg-action ds-msg-delete" title="从当前对话上下文中删除此条提问">' +
                '<i class="ph ph-trash" aria-hidden="true"></i><span>删除</span>' +
            '</button>';
        el.wrap.appendChild(actions);
        return el;
    }

    function getEntryText(entry) {
        if (!entry) return '';
        if (typeof entry.content === 'string') return entry.content;
        if (Array.isArray(entry.content)) {
            const part = entry.content.find(function (p) { return p && p.type === 'text'; });
            return part ? (part.text || '') : '';
        }
        return '';
    }

    function getEntryImages(entry) {
        if (!entry || !Array.isArray(entry.content)) return [];
        return entry.content
            .filter(function (p) { return p && p.type === 'image_url' && p.image_url && p.image_url.url; })
            .map(function (p) { return p.image_url.url; });
    }

    function setEntryText(entry, newText) {
        if (!entry) return;
        if (entry.role === 'user') {
            entry.content = buildUserContent(newText, getEntryImages(entry));
        } else {
            entry.content = newText;
        }
    }

    function closeMsgEditor(wrap) {
        if (!wrap) return;
        const box = wrap.querySelector('.ds-edit-box');
        if (box) box.remove();
        wrap.classList.remove('is-editing');
    }

    function openMsgEditor(wrap) {
        if (!wrap) return;
        if (streaming) {
            flashHint('正在生成回答，请先停止后再修改对话历史');
            return;
        }
        const entry = msgEntryMap.get(wrap);
        if (!entry) return;
        if (wrap.classList.contains('is-editing')) {
            const existing = wrap.querySelector('.ds-edit-input');
            if (existing) existing.focus();
            return;
        }
        wrap.classList.add('is-editing');
        const isUser = entry.role === 'user';
        const box = document.createElement('div');
        box.className = 'ds-edit-box';
        box.innerHTML =
            '<textarea class="ds-edit-input" rows="2"></textarea>' +
            '<div class="ds-edit-toolbar">' +
                '<button type="button" class="ds-edit-btn ds-edit-cancel">取消</button>' +
                '<button type="button" class="ds-edit-btn ' + (isUser ? '' : 'ds-edit-primary ') + 'ds-edit-save" title="仅保存修改到上下文，不清空后续记录">保存修改</button>' +
                (isUser ? '<button type="button" class="ds-edit-btn ds-edit-primary ds-edit-resend" title="保存修改并截断后续消息，立即重新发送给 AI">保存并重发</button>' : '') +
            '</div>';
        const bubble = wrap.querySelector('.ds-bubble');
        wrap.insertBefore(box, bubble ? bubble.nextSibling : null);

        const ta = box.querySelector('.ds-edit-input');
        ta.value = getEntryText(entry);
        function syncEditHeight() {
            ta.style.height = 'auto';
            ta.style.height = Math.min(220, Math.max(52, ta.scrollHeight)) + 'px';
        }
        ta.addEventListener('input', syncEditHeight);
        ta.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                closeMsgEditor(wrap);
                return;
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveMsgEdit(wrap, false);
            }
        });
        syncEditHeight();
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
    }

    function truncateAfterWrap(wrap) {
        const entry = msgEntryMap.get(wrap);
        if (entry) {
            const idx = history.indexOf(entry);
            if (idx !== -1) history.splice(idx + 1);
        }
        let next = wrap.nextElementSibling;
        while (next) {
            const toRemove = next;
            next = next.nextElementSibling;
            const c = toRemove.querySelector && toRemove.querySelector('.ds-content');
            if (c) paintedMessages.delete(c);
            toRemove.remove();
        }
    }

    function saveMsgEdit(wrap, andResend) {
        if (!wrap) return;
        if (streaming) {
            flashHint('正在生成回答，请先停止');
            return;
        }
        const entry = msgEntryMap.get(wrap);
        const ta = wrap.querySelector('.ds-edit-input');
        if (!entry || !ta) return;
        const newText = ta.value.trim();
        const imgs = getEntryImages(entry);
        if (!newText && !imgs.length) {
            flashHint('内容不能为空，如需移除请点删除');
            return;
        }
        setEntryText(entry, newText);
        if (entry.role === 'user') {
            const bubble = wrap.querySelector('.ds-bubble');
            if (bubble) renderUserBubble(bubble, newText, imgs);
        } else {
            const contentEl = wrap.querySelector('.ds-content');
            if (contentEl) paintMessageBody(contentEl, newText, {});
        }
        closeMsgEditor(wrap);
        if (andResend && entry.role === 'user') {
            truncateAfterWrap(wrap);
            saveState();
            requestAssistantReply(function () { resendFromUserMsg(wrap); });
        } else {
            if (!bodyEl.querySelector('.dict-error') && chatStatus === 'error') {
                setChatStatus('idle');
            }
            saveState();
        }
    }

    function resendFromUserMsg(wrap) {
        if (!wrap) return;
        if (streaming) {
            flashHint('正在生成回答，请先停止');
            return;
        }
        closeMsgEditor(wrap);
        truncateAfterWrap(wrap);
        saveState();
        requestAssistantReply(function () { resendFromUserMsg(wrap); });
    }

    function deleteMsg(wrap) {
        if (!wrap) return;
        if (streaming) {
            flashHint('正在生成回答，请先停止后再删除消息');
            return;
        }
        const entry = msgEntryMap.get(wrap);
        if (entry) {
            const idx = history.indexOf(entry);
            if (idx !== -1) history.splice(idx, 1);
        }
        const nextEl = wrap.nextElementSibling;
        if (nextEl && !msgEntryMap.has(nextEl) && nextEl.querySelector && nextEl.querySelector('.dict-error')) {
            nextEl.remove();
        }
        const contentEl = wrap.querySelector('.ds-content');
        if (contentEl) paintedMessages.delete(contentEl);
        wrap.remove();
        if (!history.length || !bodyEl.querySelector('.ds-msg')) {
            history = [];
            clearBody();
            showWelcome();
        } else if (!bodyEl.querySelector('.dict-error') && chatStatus === 'error') {
            setChatStatus('idle');
        }
        saveState();
    }

    function scrollToBottom(force) {
        if (!bodyEl) return;
        if (selectingBody || selectionTouches(bodyEl)) return;
        // 用户往上翻看历史时不要把他拽回底部（除非是刚发出新消息）
        const nearBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 120;
        if (force || nearBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    function scheduleScroll(force) {
        if (force) pendingScroll = true;
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(function () {
            renderScheduled = false;
            scrollToBottom(pendingScroll);
            pendingScroll = false;
        });
    }

    // 流式渲染：短回答每帧最多重排一次；超长回答（>2000 字符）按 ~48ms 节流，降低全量 Markdown+KaTeX 重排开销
    function streamTick(state) {
        if (state.renderQueued) return;
        state.renderQueued = true;
        const flush = function () {
            state.renderTimer = null;
            requestAnimationFrame(function () {
                state.renderQueued = false;
                if (!state.alive) return;
                state.lastPaintAt = performance.now();
                paintStream(state);
                scheduleScroll(false);
            });
        };
        const minGap = state.text.length > 2000 ? 48 : 0;
        const wait = minGap > 0 && state.lastPaintAt ? Math.max(0, minGap - (performance.now() - state.lastPaintAt)) : 0;
        if (wait > 0) {
            state.renderTimer = setTimeout(flush, wait);
        } else {
            flush();
        }
    }

    // 把当前累积的文本铺进气泡：思考块（若有）在上，正文在下
    function paintStream(state) {
        if (state.headEl && state.reasoning && state.renderedReasoningLen !== state.reasoning.length) {
            state.renderedReasoningLen = state.reasoning.length;
            state.headEl.style.display = '';
            // 思考过程只当速记本看：里面的 TikZ 不送去编译（真正要画的是正文里那份）
            state.headEl.querySelector('.ds-reasoning-body').innerHTML =
                markdownToHtml(state.reasoning, { tikz: false });
        }
        if (!state.text) return;
        const loading = state.bodyEl.querySelector('.ds-chat-loading');
        if (loading) loading.remove();
        paintMessageBody(state.bodyEl, state.text, { streaming: true });
    }

    function startAssistantMessage(placeholder) {
        const el = messageEl('assistant');
        el.bubble.innerHTML =
            '<div class="ds-reasoning" style="display:none;">' +
                '<div class="ds-reasoning-head"><i class="ph ph-brain"></i><span>思考过程</span>' +
                '<i class="ph ph-caret-down ds-reasoning-caret"></i></div>' +
                '<div class="ds-reasoning-body"></div>' +
            '</div>' +
            '<div class="ds-content"><div class="ds-chat-loading"><span class="dict-spinner"></span><span>' +
                escapeHtml(placeholder || '正在思考…') + '</span></div></div>';
        scrollToBottom(true);
        return {
            wrap: el.wrap,
            bubble: el.bubble,
            headEl: el.bubble.querySelector('.ds-reasoning'),
            bodyEl: el.bubble.querySelector('.ds-content')
        };
    }

    function renderError(message, retryAction) {
        const el = messageEl('assistant');
        el.bubble.innerHTML = '<div class="dict-error">' + escapeHtml(message) + '</div>' +
            (retryAction ? '<button type="button" class="ds-chat-retry"><i class="ph ph-arrow-clockwise"></i> 重试</button>' : '');
        const retry = el.bubble.querySelector('.ds-chat-retry');
        if (retry) {
            retry.addEventListener('click', function () {
                el.wrap.remove();
                if (typeof retryAction === 'function') retryAction();
                else if (retryAction) send(retryAction, []);
            });
        }
        scrollToBottom(true);
    }

    // =========================================================================
    // 四、会话持久化（刷新页面后接着聊）
    // =========================================================================
    function saveState() {
        if (!panel || restoringState) return;
        try {
            const data = {
                left: panel ? panel.style.left : '',
                top: panel ? panel.style.top : '',
                width: panel ? panel.style.width : '',
                height: panel ? panel.style.height : '',
                model: model,
                apiRevision: apiRevision,
                thinking: thinking,
                fontScale: fontScale,
                // 只存纯文本历史（图片 data URL 体积太大，绝不写进 localStorage）
                history: history.slice(-MAX_HISTORY).map(function (m) {
                    return storedEntry(m);
                }).filter(function (m) { return m.content; })
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) { /* 存储不可用时静默 */ }
    }

    function renderRestoredHistoryIfNeeded() {
        if (!historyDomPending) return;
        historyDomPending = false;
        if (!history.length) return;
        clearBody();
        history.forEach(function (entry) {
            if (entry.role === 'user') {
                const userEl = userMessageEl(entry.content, []);
                msgEntryMap.set(userEl.wrap, entry);
            } else {
                const el = messageEl('assistant');
                msgEntryMap.set(el.wrap, entry);
                if (entry.reasoning_content && String(entry.reasoning_content).trim()) {
                    const reasoningEl = document.createElement('div');
                    reasoningEl.className = 'ds-reasoning collapsed';
                    reasoningEl.innerHTML =
                        '<div class="ds-reasoning-head"><i class="ph ph-brain"></i><span>思考过程</span>' +
                        '<i class="ph ph-caret-down ds-reasoning-caret"></i></div>' +
                        '<div class="ds-reasoning-body"></div>';
                    reasoningEl.querySelector('.ds-reasoning-body').innerHTML =
                        markdownToHtml(entry.reasoning_content, { tikz: false });
                    el.bubble.appendChild(reasoningEl);
                }
                const content = document.createElement('div');
                content.className = 'ds-content';
                el.bubble.appendChild(content);
                paintMessageBody(content, entry.content, {});
            }
        });
        scrollToBottom(true);
    }

    function restoreState() {
        let data = null;
        try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { data = null; }
        if (!data) return;
        restoringState = true;

        if (data.width) panel.style.width = data.width;
        if (data.height) panel.style.height = data.height;
        if (data.left && data.top) {
            const headerH = getHeaderHeight();
            const w = parseInt(data.width, 10) || 430;
            const maxLeft = Math.max(0, window.innerWidth - w - 4);
            const maxTop = Math.max(0, window.innerHeight - 60);
            panel.style.left = Math.min(Math.max(4, parseInt(data.left, 10) || 0), maxLeft) + 'px';
            panel.style.top = Math.min(Math.max(headerH, parseInt(data.top, 10) || headerH), maxTop) + 'px';
        }
        if (data.fontScale) applyFontScale(data.fontScale);
        apiRevision = data.apiRevision || '';
        if (data.model && !MODELS.some(function (m) { return m.id === data.model; })) {
            MODELS.push({id: data.model, label: data.model, hint: '已保存的选择'});
            buildModelMenu();
        }
        setModel(data.model || MODELS[0].id);
        setThinking(!!data.thinking);
        syncThinkingAvailability();

        if (Array.isArray(data.history) && data.history.length) {
            data.history.forEach(function (m) {
                if (!['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') return;
                history.push(storedEntry(m));
            });
            if (history.length) {
                // 延迟到首次打开对话面板时再渲染历史 DOM 与 KaTeX 公式，加快冷启动速度
                historyDomPending = true;
                if (panelVisible) renderRestoredHistoryIfNeeded();
            }
        }
        restoringState = false;
    }

    function storedEntry(m) {
        let text = typeof m.content === 'string' ? m.content : getEntryText(m);
        if (!text && Array.isArray(m.content) && m.content.some(function (p) { return p && p.type === 'image_url'; })) {
            text = '[图片]';
        }
        const entry = { role: m.role, content: text };
        if (m.role === 'assistant') {
            for (const key of ['reasoning_content', '_reader_model']) {
                if (typeof m[key] === 'string') entry[key] = m[key];
            }
        }
        return entry;
    }

    // =========================================================================
    // 五、事件绑定
    // =========================================================================
    function bindEvents() {
        closeBtn.addEventListener('click', function (e) { e.stopPropagation(); hidePanel(); });
        if (shortcutBtn) shortcutBtn.addEventListener('click', function (e) { e.stopPropagation(); hidePanel(); });
        clearBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!history.length && !bodyEl.querySelector('.ds-msg')) return;
            // 直接清空，不弹确认框（清空只是本地动作，不会动 PDF 与批注）
            history = [];
            clearBody();
            showWelcome();
            saveState();
        });
        thinkingBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            setThinking(!thinking);
        });
        fontOutBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            setFontScale(fontScale - FONT_SCALE_STEP);
        });
        fontInBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            setFontScale(fontScale + FONT_SCALE_STEP);
        });
        modelBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            refreshApiSettings().catch(function () {});
            modelMenu.classList.toggle('show');
        });

        sendBtn.addEventListener('click', function (e) { e.stopPropagation(); submit(); });

        inputEl.addEventListener('input', autoGrow);
        inputEl.addEventListener('compositionstart', function () { isComposing = true; });
        inputEl.addEventListener('compositionend', function () { isComposing = false; });
        inputEl.addEventListener('keydown', function (e) {
            e.stopPropagation();   // 别让阅读器的全局快捷键（空格抓手 / Z X 倍速）被触发
            if (e.key === 'Enter' && !e.shiftKey && !isComposing && !e.isComposing) {
                e.preventDefault();
                submit();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                if (pdfPickerOpen) { closePdfPicker(); return; }
                if (streaming) abortStream(); else hidePanel();
            }
        });
        inputEl.addEventListener('paste', function (e) { handlePaste(e); });

        // 拖拽图片进面板：必须在面板上 stopPropagation —— boot.js 在 window 上
        // 装了全局 drop 拦截（防止误拖 PDF），不拦住的话图片根本进不来。
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
        panel.addEventListener('drop', function (e) {
            const files = e.dataTransfer && e.dataTransfer.files;
            if (files && files.length) addImageFiles(files);
        });

        // 工具栏「选择 PDF 页面」按钮
        pdfBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            togglePdfPicker();
        });

        // PDF 选页抽屉事件
        pdfClearBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            pdfSelectedPages = [];
            pdfLastClickedPage = null;
            updatePdfPickerUI();
        });
        pdfLocateBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            const rs = getReaderState();
            const doc = rs && rs.pdfDoc;
            if (!doc) return;
            syncCurrentPdfPageInPicker();
            scrollPickerToPage(getCurrentPdfPage(rs, doc.numPages), false);
        });
        pdfCancelBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            closePdfPicker();
        });
        pdfConfirmBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            confirmPdfPages();
        });
        pdfGridEl.addEventListener('mousedown', function (e) {
            if (e.shiftKey && e.target.closest && e.target.closest('.ds-pdf-card')) {
                e.preventDefault();
            }
        });
        pdfGridEl.addEventListener('click', function (e) {
            const card = e.target.closest && e.target.closest('.ds-pdf-card');
            if (!card || pdfConfirming) return;
            togglePdfCardSelection(Number(card.dataset.page), !!e.shiftKey);
        });
        pdfGridEl.addEventListener('dblclick', function (e) {
            const card = e.target.closest && e.target.closest('.ds-pdf-card');
            if (!card || pdfConfirming) return;
            const pageNum = Number(card.dataset.page);
            if (!Number.isInteger(pageNum) || pageNum < 1) return;
            const rs = getReaderState();
            const doc = rs && rs.pdfDoc;
            const token = rs ? rs.loadToken : null;
            const maxAllowed = getMaxPdfSelectable(doc, token);
            if (pdfSelectedPages.indexOf(pageNum) === -1) {
                if (pdfSelectedPages.length >= maxAllowed) {
                    flashHint('单条消息最多 ' + MAX_IMAGES + ' 张图片');
                    return;
                }
                pdfSelectedPages.push(pageNum);
                updatePdfPickerUI();
            }
            confirmPdfPages();
        });

        // 回答 / 代码块复制、历史消息删改、TikZ 源码开关、思考过程折叠（事件委托，消息是流式重建的）
        bodyEl.addEventListener('click', function (e) {
            const editBtn = e.target.closest && e.target.closest('.ds-msg-edit');
            if (editBtn) {
                openMsgEditor(editBtn.closest('.ds-msg'));
                return;
            }
            const delBtn = e.target.closest && e.target.closest('.ds-msg-delete');
            if (delBtn) {
                deleteMsg(delBtn.closest('.ds-msg'));
                return;
            }
            const resendBtn = e.target.closest && e.target.closest('.ds-msg-resend');
            if (resendBtn) {
                resendFromUserMsg(resendBtn.closest('.ds-msg'));
                return;
            }
            const editSave = e.target.closest && e.target.closest('.ds-edit-save');
            if (editSave) {
                saveMsgEdit(editSave.closest('.ds-msg'), false);
                return;
            }
            const editResend = e.target.closest && e.target.closest('.ds-edit-resend');
            if (editResend) {
                saveMsgEdit(editResend.closest('.ds-msg'), true);
                return;
            }
            const editCancel = e.target.closest && e.target.closest('.ds-edit-cancel');
            if (editCancel) {
                closeMsgEditor(editCancel.closest('.ds-msg'));
                return;
            }
            const messageCopy = e.target.closest && e.target.closest('.ds-message-copy');
            if (messageCopy) {
                const wrap = messageCopy.closest('.ds-msg-assistant');
                const selected = selectedMarkdown(wrap);
                const record = paintedMessages.get(wrap.querySelector('.ds-content'));
                if (record) copyWithFeedback(messageCopy, selected == null ? record.markdown : selected, true);
                return;
            }
            const copy = e.target.closest && e.target.closest('.ds-code-copy');
            if (copy) {
                const code = copy.closest('.ds-code-block').querySelector('code');
                copyWithFeedback(copy, code ? code.textContent : '');
                return;
            }
            // TikZ 图：展开 / 收起源码（展开状态记在 key 上，流式重绘不会把它弹回去）
            const tikzToggle = e.target.closest && e.target.closest('.ds-tikz-toggle');
            if (tikzToggle) {
                const source = tikzToggle.closest('.ds-tikz').querySelector('.ds-tikz-source');
                const code = source ? source.textContent : '';
                const open = !openTikzSources.has(code);
                if (open) openTikzSources.add(code); else openTikzSources.delete(code);
                if (source) source.toggleAttribute('hidden', !open);
                tikzToggle.classList.toggle('active', open);
                return;
            }
            const tikzCopy = e.target.closest && e.target.closest('.ds-tikz-copy');
            if (tikzCopy) {
                const source = tikzCopy.closest('.ds-tikz').querySelector('.ds-tikz-source code');
                copyWithFeedback(tikzCopy, source ? source.textContent : '');
                return;
            }
            const rHead = e.target.closest && e.target.closest('.ds-reasoning-head');
            if (rHead) rHead.parentNode.classList.toggle('collapsed');
        });

        // 只在对话区放行原生右键菜单；隔离滚轮；PDF 区域继续使用阅读器原来的行为。
        panel.addEventListener('contextmenu', function (e) { e.stopPropagation(); });
        panel.addEventListener('wheel', function (e) { e.stopPropagation(); }, { passive: true });
        bodyEl.addEventListener('mousedown', function (e) {
            if (e.target.closest('.ds-message-copy, .ds-msg-action, .ds-edit-btn')) { e.preventDefault(); return; }
            if (e.button === 0) selectingBody = e.target.closest('.ds-content');
        });
        document.addEventListener('mouseup', function () {
            selectingBody = null;
            resumeSelectedMessages();
        });
        document.addEventListener('selectionchange', resumeSelectedMessages);
        window.addEventListener('blur', function () { selectingBody = null; resumeSelectedMessages(); });
        document.addEventListener('copy', function (e) {
            if (copyingText || !e.clipboardData || e.defaultPrevented) return;
            const active = document.activeElement;
            if (active && active.matches('input, textarea, [contenteditable="true"]')) return;
            const markdown = selectedMarkdown();
            if (markdown == null) return;
            e.clipboardData.setData('text/plain', markdown);
            e.preventDefault();
        });

        // 点击面板空白处收起模型菜单
        panel.addEventListener('mousedown', function (e) {
            if (!e.target.closest || !e.target.closest('.ds-chat-model-wrap')) {
                modelMenu.classList.remove('show');
            }
            // 保持输入焦点：只有点标题栏/面板空白处才吞掉默认行为。
            // 消息区与输入区必须放行 —— 否则消息正文没法用鼠标划选复制。
            if (e.target.closest && e.target.closest('.ds-chat-header')) e.preventDefault();
        });

        // ---------- 拖动标题栏移动面板 ----------
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
            window.FloatingWindowLayers?.resetViewportBase(panel);
            saveState();
        }
        headerEl.addEventListener('mousedown', function (e) {
            if (e.target.closest('button, select, a, input')) return;
            e.preventDefault();
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            sl = panel.offsetLeft; st = panel.offsetTop;
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onDragMove, true);
            document.addEventListener('mouseup', onDragEnd, true);
        });

        // ---------- 右下角缩放 ----------
        let resizing = false, rw = 0, rh = 0, rmx = 0, rmy = 0, rLeft = 0, rTop = 0;
        function onResizeMove(e) {
            if (!resizing) return;
            const maxW = Math.max(300, window.innerWidth - rLeft - 8);
            const maxH = Math.max(220, window.innerHeight - rTop - 8);
            panel.style.width = Math.max(300, Math.min(maxW, rw + e.clientX - rmx)) + 'px';
            panel.style.height = Math.max(220, Math.min(maxH, rh + e.clientY - rmy)) + 'px';
        }
        function onResizeEnd() {
            if (!resizing) return;
            resizing = false;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            document.removeEventListener('mousemove', onResizeMove, true);
            document.removeEventListener('mouseup', onResizeEnd, true);
            window.FloatingWindowLayers?.resetViewportBase(panel);
            saveState();
        }
        resizeHandle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            resizing = true;
            rw = panel.offsetWidth; rh = panel.offsetHeight;
            rLeft = panel.offsetLeft; rTop = panel.offsetTop;
            rmx = e.clientX; rmy = e.clientY;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'nwse-resize';
            document.addEventListener('mousemove', onResizeMove, true);
            document.addEventListener('mouseup', onResizeEnd, true);
        });

        window.addEventListener('blur', function () { onDragEnd(); onResizeEnd(); });

        // 窗口尺寸变化时保持底边贴靠并把面板拉回可视区
        function syncLayoutOnViewportChange() {
            if (!panelVisible) return;
            window.FloatingWindowLayers?.syncViewportBottom(panel);
            clampViewportBounds();
            window.FloatingWindowLayers?.noteViewportClamped(panel);
        }
        window.addEventListener('resize', syncLayoutOnViewportChange);
        window.FloatingWindowLayers?.bindViewportFullscreenSync(panel, syncLayoutOnViewportChange);

        // 工具栏按钮
        if (toolbarBtn) {
            toolbarBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                togglePanel();
            });
        }

        // Esc 收起面板；D 打开 / 关闭对话面板（输入文字或组合键时不触发）
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && panelVisible) {
                if (pdfPickerOpen) { e.preventDefault(); closePdfPicker(); return; }
                if (e.target && e.target.closest && e.target.closest('#ds-chat-panel')) return;
                hidePanel();
                return;
            }
            if (e.defaultPrevented || e.repeat || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.code !== 'KeyD' && String(e.key || '').toLowerCase() !== 'd') return;
            const isEditable = function (el) {
                return Boolean(el && (
                    el.tagName === 'INPUT' ||
                    el.tagName === 'TEXTAREA' ||
                    el.tagName === 'SELECT' ||
                    el.isContentEditable ||
                    (el.closest && el.closest('[contenteditable="true"]'))
                ));
            };
            if (isEditable(e.target) || isEditable(document.activeElement)) return;
            e.preventDefault();
            e.stopPropagation();
            togglePanel({ focusInput: false });
        });
    }

    function autoGrow() {
        if (!inputEl) return;
        inputEl.style.height = '34px';
        const borderH = inputEl.offsetHeight - inputEl.clientHeight;
        inputEl.style.height = Math.min(120, Math.max(34, inputEl.scrollHeight + borderH)) + 'px';
    }

    // 只序列化选中的回答节点。公式与图形作为完整单元复制，避免半个公式或重复 MathML。
    function selectedMarkdown(wrap) {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
        const range = selection.getRangeAt(0);
        function contentAt(node) {
            const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            return el && el.closest('.ds-msg-assistant .ds-content');
        }
        const start = contentAt(range.startContainer), end = contentAt(range.endContainer);
        if (!start || !end || !bodyEl.contains(start) || !bodyEl.contains(end)) return null;
        if (wrap && (!wrap.contains(start) || !wrap.contains(end))) return null;

        function fence(text, lang) {
            const runs = text.match(/`+/g) || [];
            const marker = '`'.repeat(Math.max(3, ...runs.map(function (run) { return run.length + 1; })));
            return '\n\n' + marker + (lang || '') + '\n' + text + '\n' + marker + '\n\n';
        }
        function children(node, code) {
            return Array.from(node.childNodes).map(function (child) { return read(child, code); }).join('');
        }
        function read(node, code) {
            if (!range.intersectsNode(node)) return '';
            if (node.nodeType === Node.TEXT_NODE) {
                const from = node === range.startContainer ? range.startOffset : 0;
                const to = node === range.endContainer ? range.endOffset : node.length;
                const text = node.data.slice(from, to);
                return code ? text : text.replace(/[\\`*_[\]<>]/g, '\\$&');
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            if (node.hasAttribute('data-ds-math')) return node.getAttribute('data-ds-math');
            if (node.matches('.ds-tikz')) {
                const source = node.querySelector('.ds-tikz-source');
                if (source && source.contains(range.startContainer) && source.contains(range.endContainer)) {
                    return fence(children(source, true), 'tikz');
                }
                return source ? fence(source.textContent, 'tikz') : '';
            }
            if (node.matches('button, [hidden], .ds-code-head, .ds-chat-note, .ds-tikz-bar, .ds-msg-actions, .ds-edit-box')) return '';
            if (node.matches('.ds-code-block')) {
                const pre = node.querySelector('pre');
                const lang = node.querySelector('.ds-code-lang');
                return pre ? fence(children(pre, true), lang ? lang.textContent : '') : '';
            }
            if (node.tagName === 'CODE') {
                const text = children(node, true);
                if (code || !text) return text;
                const runs = text.match(/`+/g) || [];
                const marker = '`'.repeat(Math.max(1, ...runs.map(function (run) { return run.length + 1; })));
                const pad = /^[` ]|[` ]$/.test(text) ? ' ' : '';
                return marker + pad + text + pad + marker;
            }
            if (node.tagName === 'TABLE') {
                const cell = contentAt(range.startContainer) === contentAt(range.endContainer)
                    ? (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement).closest('td, th') : null;
                if (cell && cell.contains(range.endContainer)) return children(cell);
                const rows = Array.from(node.rows).map(function (row) {
                    return Array.from(row.cells).map(function (td) { return children(td).trim().replace(/\n/g, '<br>'); });
                }).filter(function (row) { return row.some(Boolean); });
                if (!rows.length) return '';
                const lines = rows.map(function (row) { return '| ' + row.join(' | ') + ' |'; });
                lines.splice(1, 0, '| ' + rows[0].map(function () { return '---'; }).join(' | ') + ' |');
                return '\n\n' + lines.join('\n') + '\n\n';
            }
            const text = children(node, code);
            if (node.tagName === 'BR') return '\n';
            if (node.tagName === 'HR') return '\n\n---\n\n';
            if (node.tagName === 'IMG') return '![' + (node.alt || '') + '](' + node.getAttribute('src') + ')';
            if (!text) return '';
            if (node.hasAttribute('data-ds-heading')) return '\n\n' + '#'.repeat(Number(node.dataset.dsHeading)) + ' ' + text.trim() + '\n\n';
            if (node.tagName === 'STRONG') return '**' + text + '**';
            if (node.tagName === 'EM') return '*' + text + '*';
            if (node.tagName === 'DEL') return '~~' + text + '~~';
            if (node.tagName === 'A') return '[' + text + '](' + node.getAttribute('href') + ')';
            if (node.tagName === 'BLOCKQUOTE') return '\n\n' + text.trim().split('\n').map(function (line) { return '> ' + line; }).join('\n') + '\n\n';
            if (node.tagName === 'LI') {
                const task = node.querySelector('input[type="checkbox"]');
                const prefix = (node.dataset.dsMarker || '-') + ' ' + (task ? (task.checked ? '[x] ' : '[ ] ') : '');
                return prefix + text.trim().replace(/\n/g, '\n  ') + '\n';
            }
            if (node.matches('UL, OL')) return '\n' + text.trimEnd() + '\n';
            if (node.tagName === 'P') return '\n\n' + text + '\n\n';
            return text;
        }
        return Array.from(bodyEl.querySelectorAll('.ds-msg-assistant .ds-content'))
            .filter(function (el) { return range.intersectsNode(el); })
            .map(function (el) { return read(el).trim(); }).filter(Boolean).join('\n\n');
    }

    let copyingText = false; // execCommand 的内部复制不经过选区 Markdown 转换

    async function copyWithFeedback(button, text, showLabel) {
        if (button.disabled) return;
        const original = button.innerHTML;
        button.disabled = true;
        const copied = await copyText(text);
        if (!copied) {
            button.disabled = false;
            flashHint('复制失败，请允许浏览器访问剪贴板后重试');
            return;
        }
        button.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i>' + (showLabel ? '<span>已复制</span>' : '');
        setTimeout(function () {
            button.innerHTML = original;
            button.disabled = false;
        }, 1200);
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) { /* 落回 execCommand */ }
        const active = document.activeElement;
        const selection = window.getSelection();
        const ranges = [];
        if (selection) {
            for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
        }
        const inputSelection = active && typeof active.selectionStart === 'number'
            ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
        const ta = document.createElement('textarea');
        try {
            ta.value = text;
            ta.readOnly = true;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            copyingText = true;
            return document.execCommand('copy');
        } catch (e) {
            return false;
        } finally {
            copyingText = false;
            ta.remove();
            if (active && active.isConnected) active.focus({ preventScroll: true });
            if (selection) {
                selection.removeAllRanges();
                ranges.forEach(function (range) { selection.addRange(range); });
            }
            if (inputSelection && active.isConnected) active.setSelectionRange.apply(active, inputSelection);
        }
    }

    // =========================================================================
    // 六、图片：粘贴 / 拖拽
    // =========================================================================
    function handlePaste(e) {
        const dt = e.clipboardData;
        if (!dt) return;
        const files = [];
        const items = dt.items || [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                const f = items[i].getAsFile();
                if (f) files.push(f);
            }
        }
        if (!files.length && dt.files && dt.files.length) {
            for (let i = 0; i < dt.files.length; i++) files.push(dt.files[i]);
        }
        if (!files.length) return;      // 纯文本粘贴：交给浏览器默认行为
        e.preventDefault();
        addImageFiles(files);
    }

    function addImageFiles(files) {
        Array.prototype.slice.call(files).forEach(function (file) {
            if (!file) return;
            if (ALLOWED_IMAGE_TYPES.indexOf(file.type) === -1) {
                flashHint('仅支持 PNG / JPEG / WebP / GIF 图片');
                return;
            }
            if (file.size > MAX_IMAGE_BYTES) {
                flashHint('图片过大（上限 8 MB）');
                return;
            }
            if (attachments.length + pendingImages >= MAX_IMAGES) {
                flashHint('单条消息最多 ' + MAX_IMAGES + ' 张图片');
                return;
            }
            pendingImages++;
            const reader = new FileReader();
            const finishRead = function () {
                pendingImages = Math.max(0, pendingImages - 1);
            };
            reader.onload = function () {
                finishRead();
                if (attachments.length >= MAX_IMAGES) {
                    flashHint('单条消息最多 ' + MAX_IMAGES + ' 张图片');
                    return;
                }
                attachments.push({
                    id: 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
                    dataUrl: reader.result,
                    name: file.name || 'pasted-image'
                });
                renderThumbs();
                if (pdfPickerOpen) updatePdfPickerUI();
                inputEl.focus();
            };
            reader.onerror = reader.onabort = finishRead;
            reader.readAsDataURL(file);
        });
    }

    function renderThumbs() {
        if (!attachments.length) {
            thumbsEl.classList.remove('show');
            thumbsEl.innerHTML = '';
            return;
        }
        thumbsEl.classList.add('show');
        const rs = getReaderState();
        thumbsEl.innerHTML = attachments.map(function (a) {
            const badge = a.pdfPage ? (a.pdfLabel || formatPdfPageLabel(a.pdfPage, rs, true)) : '';
            return '<div class="ds-thumb" data-id="' + a.id + '" title="' + escapeHtml(a.name) + '">' +
                '<img src="' + a.dataUrl + '" alt="">' +
                (badge ? '<span class="ds-thumb-badge">' + escapeHtml(badge) + '</span>' : '') +
                '<button type="button" class="ds-thumb-del" data-del="' + a.id + '" title="移除">' +
                    '<i class="ph ph-x"></i>' +
                '</button>' +
            '</div>';
        }).join('');
        thumbsEl.querySelectorAll('.ds-thumb-del').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                const removed = attachments.find(function (a) { return a.id === btn.dataset.del; });
                attachments = attachments.filter(function (a) { return a.id !== btn.dataset.del; });
                renderThumbs();
                if (pdfPickerOpen && removed && removed.pdfPage) {
                    pdfSelectedPages = pdfSelectedPages.filter(function (p) { return p !== removed.pdfPage; });
                    updatePdfPickerUI();
                } else if (pdfPickerOpen) {
                    updatePdfPickerUI();
                }
            });
        });
    }

    // =========================================================================
    // 六·五、PDF 页面转高清图片选择器
    // =========================================================================
    function getReaderState() {
        return typeof state !== 'undefined' ? state : window.state;
    }

    function isCurrentDocPdfAttachment(a, doc, token) {
        return !!(a && a.pdfPage && a.pdfDoc === doc && a.pdfToken === token);
    }

    function getCurrentPdfPage(rs, totalPages) {
        const cur = rs && Number(rs.currentPhysicalPage);
        if (Number.isInteger(cur) && cur >= 1 && cur <= totalPages) return cur;
        return 1;
    }

    function formatPdfPageLabel(physicalPage, rs, shortMode) {
        const offset = Number(rs && rs.pageOffset) || 0;
        const logical = physicalPage - offset;
        if (offset > 0 && logical <= 0) {
            const front = Math.abs(logical - 1);
            return shortMode ? ('前' + front) : ('前 ' + front + ' 页');
        }
        const num = offset > 0 ? logical : physicalPage;
        return shortMode ? ('P.' + num) : ('第 ' + num + ' 页');
    }

    function getMaxPdfSelectable(doc, token) {
        const otherCount = attachments.filter(function (a) {
            return !isCurrentDocPdfAttachment(a, doc, token);
        }).length;
        return Math.max(0, MAX_IMAGES - otherCount - pendingImages);
    }

    function setThumbCacheEntry(pageNum, entry) {
        if (pdfThumbCache.has(pageNum)) pdfThumbCache.delete(pageNum);
        pdfThumbCache.set(pageNum, entry);
        while (pdfThumbCache.size > PDF_THUMB_CACHE_MAX) {
            pdfThumbCache.delete(pdfThumbCache.keys().next().value);
        }
    }

    function applyCardThumb(card, entry) {
        if (!card || !entry) return;
        const thumbBox = card.querySelector('.ds-pdf-card-thumb');
        const img = card.querySelector('.ds-pdf-card-img');
        const ph = card.querySelector('.ds-pdf-card-ph');
        if (thumbBox && entry.ratio) thumbBox.style.aspectRatio = entry.ratio;
        if (img) {
            img.src = entry.dataUrl;
            img.hidden = false;
        }
        if (ph) ph.hidden = true;
        card.dataset.thumbState = 'done';
    }

    function isCardNearGrid(card) {
        if (!pdfGridEl || !card.isConnected) return false;
        const gr = pdfGridEl.getBoundingClientRect();
        const cr = card.getBoundingClientRect();
        if (!gr.height || !cr.height) return true;
        return cr.bottom >= gr.top - 300 && cr.top <= gr.bottom + 300;
    }

    async function renderPdfThumbEntry(doc, token, pageNum) {
        const rs = getReaderState();
        const viewerCanvas = document.getElementById('canvas-' + pageNum);
        if (viewerCanvas && viewerCanvas.width >= 200 && viewerCanvas.height >= 200 &&
            rs && rs.pdfDoc === doc && rs.loadToken === token &&
            (!rs.pagesRendered || rs.pagesRendered.has(pageNum))) {
            const targetW = PDF_THUMB_WIDTH;
            const targetH = Math.max(1, Math.round(viewerCanvas.height * (targetW / viewerCanvas.width)));
            const tmp = document.createElement('canvas');
            tmp.width = targetW;
            tmp.height = targetH;
            const ctx = tmp.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, targetW, targetH);
            ctx.drawImage(viewerCanvas, 0, 0, targetW, targetH);
            const dataUrl = tmp.toDataURL('image/jpeg', 0.84);
            const ratio = viewerCanvas.width + ' / ' + viewerCanvas.height;
            tmp.width = 0;
            tmp.height = 0;
            return { dataUrl: dataUrl, ratio: ratio };
        }
        const page = await doc.getPage(pageNum);
        const baseVp = page.getViewport({ scale: 1 });
        const scale = Math.max(0.2, PDF_THUMB_WIDTH / Math.max(baseVp.width, 1));
        const vp = page.getViewport({ scale: scale });
        const tmp = document.createElement('canvas');
        tmp.width = Math.max(1, Math.round(vp.width));
        tmp.height = Math.max(1, Math.round(vp.height));
        const ctx = tmp.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, tmp.width, tmp.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const dataUrl = tmp.toDataURL('image/jpeg', 0.84);
        const ratio = Math.max(1, Math.round(baseVp.width)) + ' / ' + Math.max(1, Math.round(baseVp.height));
        tmp.width = 0;
        tmp.height = 0;
        return { dataUrl: dataUrl, ratio: ratio };
    }

    function enqueueThumbRender(pageNum, card, doc, token, gen) {
        const cached = pdfThumbCache.get(pageNum);
        if (cached) {
            setThumbCacheEntry(pageNum, cached);
            applyCardThumb(card, cached);
            return;
        }
        if (card.dataset.thumbState === 'done' || card.dataset.thumbState === 'queued' || card.dataset.thumbState === 'loading') {
            return;
        }
        card.dataset.thumbState = 'queued';
        pdfThumbQueue.push({ pageNum: pageNum, card: card, doc: doc, token: token, gen: gen });
        pumpThumbQueue();
    }

    function pumpThumbQueue() {
        while (pdfThumbActive < 2 && pdfThumbQueue.length) {
            if (pdfGridEl && pdfThumbQueue.length > 1) {
                const viewCenter = pdfGridEl.scrollTop + pdfGridEl.clientHeight / 2;
                pdfThumbQueue.sort(function (a, b) {
                    const da = Math.abs((a.card.offsetTop + a.card.offsetHeight / 2) - viewCenter);
                    const db = Math.abs((b.card.offsetTop + b.card.offsetHeight / 2) - viewCenter);
                    return da - db;
                });
            }
            const task = pdfThumbQueue.shift();
            if (!pdfPickerOpen || task.gen !== pdfPickerGen || !task.card.isConnected) continue;
            if (!isCardNearGrid(task.card)) {
                task.card.dataset.thumbState = '';
                continue;
            }
            const cached = pdfThumbCache.get(task.pageNum);
            if (cached) {
                applyCardThumb(task.card, cached);
                continue;
            }
            task.card.dataset.thumbState = 'loading';
            pdfThumbActive++;
            renderPdfThumbEntry(task.doc, task.token, task.pageNum).then(function (entry) {
                if (task.doc === pdfThumbDoc && task.token === pdfThumbToken) {
                    setThumbCacheEntry(task.pageNum, entry);
                }
                if (pdfPickerOpen && task.gen === pdfPickerGen && task.card.isConnected) {
                    applyCardThumb(task.card, entry);
                }
            }).catch(function () {
                if (task.card.isConnected && task.card.dataset.thumbState === 'loading') {
                    task.card.dataset.thumbState = '';
                }
            }).finally(function () {
                pdfThumbActive = Math.max(0, pdfThumbActive - 1);
                pumpThumbQueue();
            });
        }
    }

    function scrollPickerToPage(pageNum, instant) {
        if (!pdfGridEl) return;
        const card = pdfGridEl.querySelector('.ds-pdf-card[data-page="' + pageNum + '"]');
        if (!card) return;
        const targetTop = Math.max(0, card.offsetTop - Math.max(0, (pdfGridEl.clientHeight - card.offsetHeight) / 2));
        if (instant || typeof pdfGridEl.scrollTo !== 'function') {
            pdfGridEl.scrollTop = targetTop;
        } else {
            pdfGridEl.scrollTo({ top: targetTop, behavior: 'smooth' });
        }
    }

    function syncCurrentPdfPageInPicker() {
        if (!pdfPickerOpen || !pdfGridEl) return;
        const rs = getReaderState();
        const doc = rs && rs.pdfDoc;
        if (!doc) return;
        const curPage = getCurrentPdfPage(rs, doc.numPages);
        if (curPage === pdfShownCurrentPage) return;

        const prevCard = pdfShownCurrentPage
            ? pdfGridEl.querySelector('.ds-pdf-card[data-page="' + pdfShownCurrentPage + '"]')
            : null;
        if (prevCard) {
            prevCard.classList.remove('is-current');
            const oldTag = prevCard.querySelector('.ds-pdf-card-cur');
            if (oldTag) oldTag.remove();
        }
        const nextCard = pdfGridEl.querySelector('.ds-pdf-card[data-page="' + curPage + '"]');
        if (nextCard) {
            nextCard.classList.add('is-current');
            const foot = nextCard.querySelector('.ds-pdf-card-foot');
            if (foot && !foot.querySelector('.ds-pdf-card-cur')) {
                const tag = document.createElement('span');
                tag.className = 'ds-pdf-card-cur';
                tag.textContent = '当前页';
                foot.appendChild(tag);
            }
        }
        pdfShownCurrentPage = curPage;
        updatePdfPickerUI();
    }

    function updatePdfPickerUI() {
        if (!pdfPickerEl) return;
        const rs = getReaderState();
        const doc = rs && rs.pdfDoc;
        const token = rs ? rs.loadToken : null;
        const maxAllowed = getMaxPdfSelectable(doc, token);
        const hasExisting = attachments.some(function (a) { return isCurrentDocPdfAttachment(a, doc, token); });

        const orderMap = new Map();
        pdfSelectedPages.forEach(function (p, idx) { orderMap.set(p, idx + 1); });

        pdfGridEl.querySelectorAll('.ds-pdf-card').forEach(function (card) {
            const p = Number(card.dataset.page);
            const ord = orderMap.get(p);
            card.classList.toggle('is-selected', !!ord);
            const ordEl = card.querySelector('.ds-pdf-card-order');
            if (ordEl) ordEl.textContent = ord ? String(ord) : '';
        });

        pdfClearBtn.disabled = pdfSelectedPages.length === 0;

        if (!pdfSelectedPages.length) {
            pdfStatusEl.textContent = maxAllowed > 0
                ? '点击页面选择（支持 Shift 连选，最多 ' + maxAllowed + ' 页）'
                : '附件数量已达上限（' + MAX_IMAGES + ' 张）';
        } else {
            const summary = pdfSelectedPages.map(function (p) { return formatPdfPageLabel(p, rs, true); }).join(', ');
            pdfStatusEl.textContent = '已选 ' + pdfSelectedPages.length + '/' + maxAllowed + ' 页：' + summary;
        }

        if (pdfConfirming) return;
        if (pdfSelectedPages.length > 0) {
            pdfConfirmBtn.disabled = false;
            pdfConfirmBtn.textContent = '添加高清图 (' + pdfSelectedPages.length + ')';
        } else if (hasExisting) {
            pdfConfirmBtn.disabled = false;
            pdfConfirmBtn.textContent = '确认移除';
        } else {
            pdfConfirmBtn.disabled = true;
            pdfConfirmBtn.textContent = '添加高清图';
        }
    }

    function togglePdfCardSelection(pageNum, isShift) {
        const rs = getReaderState();
        const doc = rs && rs.pdfDoc;
        if (!doc || !Number.isInteger(pageNum) || pageNum < 1 || pageNum > doc.numPages) return;
        const maxAllowed = getMaxPdfSelectable(doc, rs.loadToken);

        if (isShift && pdfLastClickedPage && pdfLastClickedPage >= 1 && pdfLastClickedPage <= doc.numPages) {
            const step = pdfLastClickedPage <= pageNum ? 1 : -1;
            let hitLimit = false;
            for (let p = pdfLastClickedPage; ; p += step) {
                if (pdfSelectedPages.indexOf(p) === -1) {
                    if (pdfSelectedPages.length >= maxAllowed) {
                        hitLimit = true;
                        break;
                    }
                    pdfSelectedPages.push(p);
                }
                if (p === pageNum) break;
            }
            if (hitLimit) flashHint('单条消息最多 ' + MAX_IMAGES + ' 张图片');
            pdfLastClickedPage = pageNum;
            updatePdfPickerUI();
            return;
        }

        const existingIdx = pdfSelectedPages.indexOf(pageNum);
        if (existingIdx !== -1) {
            pdfSelectedPages.splice(existingIdx, 1);
        } else {
            if (pdfSelectedPages.length >= maxAllowed) {
                flashHint('单条消息最多 ' + MAX_IMAGES + ' 张图片');
                return;
            }
            pdfSelectedPages.push(pageNum);
        }
        pdfLastClickedPage = pageNum;
        updatePdfPickerUI();
    }

    async function renderPdfPageHighRes(doc, pageNum) {
        const page = await doc.getPage(pageNum);
        const baseVp = page.getViewport({ scale: 1 });
        const maxDim = Math.max(baseVp.width, baseVp.height, 1);
        const scale = Math.max(0.5, Math.min(PDF_HIGHRES_SCALE, PDF_HIGHRES_MAX_PX / maxDim));
        const viewport = page.getViewport({ scale: scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        const approxBytes = function (url) {
            const comma = url.indexOf(',');
            return comma === -1 ? 0 : Math.floor((url.length - comma - 1) * 3 / 4);
        };
        let dataUrl = canvas.toDataURL('image/png');
        if (approxBytes(dataUrl) > MAX_IMAGE_BYTES) {
            dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        }
        if (approxBytes(dataUrl) > MAX_IMAGE_BYTES) {
            dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        }
        canvas.width = 0;
        canvas.height = 0;
        return dataUrl;
    }

    async function confirmPdfPages() {
        if (pdfConfirming) return;
        const rs = getReaderState();
        const doc = rs && rs.pdfDoc;
        if (!doc) {
            closePdfPicker();
            return;
        }
        const token = rs.loadToken;
        const gen = pdfPickerGen;
        const otherAttachments = attachments.filter(function (a) {
            return !isCurrentDocPdfAttachment(a, doc, token);
        });
        const existingMap = new Map();
        attachments.forEach(function (a) {
            if (isCurrentDocPdfAttachment(a, doc, token)) existingMap.set(a.pdfPage, a);
        });

        if (!pdfSelectedPages.length) {
            attachments = otherAttachments;
            renderThumbs();
            closePdfPicker();
            inputEl.focus();
            return;
        }

        const maxAllowed = Math.max(0, MAX_IMAGES - otherAttachments.length);
        const targetPages = pdfSelectedPages.slice(0, maxAllowed);
        const toRenderCount = targetPages.filter(function (p) { return !existingMap.has(p); }).length;

        pdfConfirming = true;
        pdfConfirmBtn.disabled = true;
        pdfCancelBtn.disabled = false;
        let renderedDone = 0;
        const pdfAttachments = [];
        try {
            for (let i = 0; i < targetPages.length; i++) {
                const p = targetPages[i];
                const reused = existingMap.get(p);
                if (reused) {
                    pdfAttachments.push(reused);
                    continue;
                }
                renderedDone++;
                pdfConfirmBtn.textContent = toRenderCount > 1
                    ? '生成中 ' + renderedDone + '/' + toRenderCount + '…'
                    : '生成中…';
                const dataUrl = await renderPdfPageHighRes(doc, p);
                if (!pdfPickerOpen || gen !== pdfPickerGen) return;
                const liveRs = getReaderState();
                if (!liveRs || liveRs.pdfDoc !== doc || liveRs.loadToken !== token) return;
                pdfAttachments.push({
                    id: 'pdf-' + Date.now() + '-' + p + '-' + Math.random().toString(36).slice(2, 6),
                    dataUrl: dataUrl,
                    name: 'PDF ' + formatPdfPageLabel(p, liveRs, false),
                    pdfLabel: formatPdfPageLabel(p, liveRs, true),
                    pdfPage: p,
                    pdfDoc: doc,
                    pdfToken: token
                });
            }
            attachments = otherAttachments.concat(pdfAttachments);
            renderThumbs();
            closePdfPicker();
            inputEl.focus();
        } catch (err) {
            flashHint('生成页面图片失败，请重试');
        } finally {
            pdfConfirming = false;
            if (pdfPickerOpen && gen === pdfPickerGen) updatePdfPickerUI();
        }
    }

    function openPdfPicker() {
        const rs = getReaderState();
        const doc = rs && rs.pdfDoc;
        if (!doc) {
            flashHint('请先打开 PDF 文档后再选择页面');
            return;
        }
        const token = rs.loadToken;
        if (doc !== pdfThumbDoc || token !== pdfThumbToken) {
            pdfThumbCache.clear();
            pdfThumbDoc = doc;
            pdfThumbToken = token;
        }
        pdfPickerGen++;
        const gen = pdfPickerGen;
        pdfThumbQueue = [];
        pdfConfirming = false;
        if (pdfThumbObserver) {
            pdfThumbObserver.disconnect();
            pdfThumbObserver = null;
        }

        const totalPages = doc.numPages;
        const curPage = getCurrentPdfPage(rs, totalPages);
        const seen = new Set();
        pdfSelectedPages = [];
        attachments.forEach(function (a) {
            if (isCurrentDocPdfAttachment(a, doc, token) && a.pdfPage >= 1 && a.pdfPage <= totalPages && !seen.has(a.pdfPage)) {
                seen.add(a.pdfPage);
                pdfSelectedPages.push(a.pdfPage);
            }
        });
        pdfLastClickedPage = pdfSelectedPages.length ? pdfSelectedPages[pdfSelectedPages.length - 1] : null;

        const dims = Array.isArray(rs.pageDimensions) ? rs.pageDimensions : [];
        const frag = document.createDocumentFragment();
        for (let p = 1; p <= totalPages; p++) {
            const dim = dims[p - 1];
            const ratio = dim && dim.width && dim.height
                ? (Math.max(1, Math.round(dim.width)) + ' / ' + Math.max(1, Math.round(dim.height)))
                : '595 / 842';
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'ds-pdf-card' + (p === curPage ? ' is-current' : '');
            card.dataset.page = String(p);
            const label = formatPdfPageLabel(p, rs, false);
            card.title = label + ' · 单击选择，Shift+单击连选，双击快速添加';
            card.innerHTML =
                '<div class="ds-pdf-card-thumb" style="aspect-ratio:' + ratio + ';">' +
                    '<img class="ds-pdf-card-img" alt="' + label + '" hidden>' +
                    '<span class="ds-pdf-card-ph">' + label + '</span>' +
                    '<span class="ds-pdf-card-order"></span>' +
                '</div>' +
                '<div class="ds-pdf-card-foot">' +
                    '<span class="ds-pdf-card-label">' +
                        '<span class="ds-pdf-card-num">' + label + '</span>' +
                    '</span>' +
                    (p === curPage ? '<span class="ds-pdf-card-cur">当前页</span>' : '') +
                '</div>';
            frag.appendChild(card);
        }
        pdfGridEl.replaceChildren(frag);

        pdfShownCurrentPage = curPage;
        pdfPickerEl.hidden = false;
        pdfPickerOpen = true;
        pdfBtn.classList.add('active');
        modelMenu.classList.remove('show');
        const flashEl = panel.querySelector('.ds-chat-flash');
        if (flashEl) flashEl.classList.remove('show');
        updatePdfPickerUI();

        const viewerEl = document.getElementById('viewer-container');
        if (viewerEl && !pdfViewerScrollBound) {
            let scrollSyncQueued = false;
            pdfViewerScrollBound = function () {
                if (!pdfPickerOpen || scrollSyncQueued) return;
                scrollSyncQueued = true;
                requestAnimationFrame(function () {
                    scrollSyncQueued = false;
                    syncCurrentPdfPageInPicker();
                });
            };
            viewerEl.addEventListener('scroll', pdfViewerScrollBound, { passive: true });
        }

        const targetScrollPage = pdfSelectedPages[0] || curPage;
        requestAnimationFrame(function () {
            if (!pdfPickerOpen || gen !== pdfPickerGen) return;
            scrollPickerToPage(targetScrollPage, true);
            if (typeof IntersectionObserver !== 'undefined') {
                pdfThumbObserver = new IntersectionObserver(function (entries) {
                    if (!pdfPickerOpen || gen !== pdfPickerGen) return;
                    entries.forEach(function (entry) {
                        if (!entry.isIntersecting) return;
                        const card = entry.target;
                        enqueueThumbRender(Number(card.dataset.page), card, doc, token, gen);
                    });
                }, { root: pdfGridEl, rootMargin: '280px 0px', threshold: 0.01 });
                pdfGridEl.querySelectorAll('.ds-pdf-card').forEach(function (card) {
                    pdfThumbObserver.observe(card);
                });
            } else {
                pdfGridEl.querySelectorAll('.ds-pdf-card').forEach(function (card) {
                    enqueueThumbRender(Number(card.dataset.page), card, doc, token, gen);
                });
            }
        });
    }

    function closePdfPicker() {
        pdfPickerOpen = false;
        pdfPickerGen++;
        pdfThumbQueue = [];
        pdfConfirming = false;
        pdfShownCurrentPage = 0;
        if (pdfThumbObserver) {
            pdfThumbObserver.disconnect();
            pdfThumbObserver = null;
        }
        const viewerEl = document.getElementById('viewer-container');
        if (viewerEl && pdfViewerScrollBound) {
            viewerEl.removeEventListener('scroll', pdfViewerScrollBound);
            pdfViewerScrollBound = null;
        }
        if (pdfPickerEl) pdfPickerEl.hidden = true;
        if (pdfBtn) pdfBtn.classList.remove('active');
        if (pdfConfirmBtn) pdfConfirmBtn.disabled = false;
    }

    function togglePdfPicker() {
        if (pdfPickerOpen) closePdfPicker(); else openPdfPicker();
    }

    // 缩略图上方的一次性提示（大小/格式不合规时）
    let hintTimer = null;
    function flashHint(msg) {
        let el = panel.querySelector('.ds-chat-flash');
        if (!el) {
            el = document.createElement('div');
            el.className = 'ds-chat-flash';
            panel.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('show');
        if (hintTimer) clearTimeout(hintTimer);
        hintTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
    }

    // =========================================================================
    // 七、发送与流式接收
    // =========================================================================
    function submit() {
        const text = inputEl.value.trim();
        if (!text && !attachments.length) return;
        // 正在生成时不要把用户敲的字吞掉：提示他先停一下，输入原样留在框里
        if (streaming) {
            flashHint('正在生成回答，先点停止或等它说完');
            return;
        }
        if (pdfPickerOpen) closePdfPicker();
        const images = attachments.slice();
        inputEl.value = '';
        autoGrow();
        attachments = [];
        renderThumbs();
        send(text, images);
    }

    function abortStream() {
        if (abortController) {
            try { abortController.abort(); } catch (e) { /* 忽略 */ }
        }
    }

    function setStreaming(on, hasError) {
        streaming = on;
        sendBtn.style.display = on ? 'none' : '';
        stopBtn.style.display = on ? '' : 'none';
        clearBtn.disabled = on;
        inputEl.disabled = false;      // 允许边生成边打下一句
        panel.classList.toggle('is-streaming', on);
        setChatStatus(on ? 'streaming' : (hasError ? 'error' : 'idle'));
    }

    async function send(text, images) {
        ensureDom();
        if (!panelVisible) showPanel();
        if (pdfPickerOpen) closePdfPicker();

        // 首次发言时把开场白清掉
        if (!history.length) clearBody();

        // 1. 本地回显用户消息 + 写入历史
        const imageUrls = (images || []).map(function (a) { return a.dataUrl; });
        const userEl = userMessageEl(text, imageUrls);
        const userContent = buildUserContent(text, imageUrls);
        const userEntry = { role: 'user', content: userContent };
        msgEntryMap.set(userEl.wrap, userEntry);
        history.push(userEntry);
        while (history.length > MAX_HISTORY + 1) history.shift();

        const retryTurn = (text || (images && images.length)) ? function () {
            if (userEl.wrap.isConnected) userEl.wrap.remove();
            const idx = history.lastIndexOf(userEntry);
            if (idx !== -1) history.splice(idx, 1);
            send(text, images);
        } : null;

        return requestAssistantReply(retryTurn);
    }

    async function requestAssistantReply(retryTurn) {
        ensureDom();
        if (!panelVisible) showPanel();

        // 2. 建立助手气泡并进入流式状态
        const el = startAssistantMessage(thinking ? '正在深度思考…' : '正在思考…');
        const state = Object.assign({
            alive: true,
            text: '',
            reasoning: '',
            completed: false,
            model: model,
            renderQueued: false
        }, el);
        setStreaming(true);
        abortController = new AbortController();

        let failed = false;
        let settled = false;      // catch 分支已经按最终态画过（别再画一遍把提示语冲掉）
        try {
            await refreshApiSettings();
            if (abortController.signal.aborted) throw new DOMException('Stopped', 'AbortError');
            const reqModel = model;
            const reqThinking = thinkingAllowed() ? thinking : undefined;
            state.model = reqModel;
            const loadingTextEl = state.bodyEl.querySelector('.ds-chat-loading span:last-child');
            if (loadingTextEl) loadingTextEl.textContent = reqThinking ? '正在深度思考…' : '正在思考…';
            const resp = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: abortController.signal,
                body: JSON.stringify({
                    messages: history,
                    model: reqModel,
                    stream: true,
                    thinking: reqThinking
                })
            });

            if (!resp.ok) {
                let detail = '';
                try {
                    const data = await resp.json();
                    detail = data.error || '';
                } catch (e) { /* 非 JSON 响应 */ }
                throw new Error(detail || ('请求失败（HTTP ' + resp.status + '）'));
            }

            await consumeStream(resp, state);
            if (!state.completed) throw new Error('连接提前结束，回答未完成，请重试。');
            if (!state.text.trim()) throw new Error('模型未返回正文，请检查输出上限后重试。');
        } catch (err) {
            if (err && err.name === 'AbortError') {
                // 用户主动停止：保留已生成的内容，补一句「已停止」
                settled = true;
                if (state.text) {
                    paintMessageBody(state.bodyEl, state.text, { note: '已停止生成' });
                } else {
                    state.bodyEl.innerHTML = '<div class="ds-chat-note">已停止生成</div>';
                }
            } else {
                failed = true;
                const msg = (err && err.message) || String(err);
                const retryFn = retryTurn ? function () {
                    if (el.wrap.isConnected) el.wrap.remove();
                    retryTurn();
                } : null;
                if (state.text) {
                    settled = true;
                    paintMessageBody(state.bodyEl, state.text, {});
                    renderError(msg, retryFn);
                } else {
                    el.wrap.remove();
                    renderError(msg, retryFn);
                }
            }
        } finally {
            state.alive = false;
            if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; }
            setStreaming(false, failed);
            abortController = null;
            // 流式结束按「最终态」再画一次：半途截断的 TikZ 会从占位符换成可折叠的源码块
            if (state.text && !settled) paintMessageBody(state.bodyEl, state.text, {});
            if (!failed && state.completed && state.text) {
                const assistantEntry = { role: 'assistant', content: state.text,
                    reasoning_content: state.reasoning, _reader_model: state.model };
                msgEntryMap.set(el.wrap, assistantEntry);
                history.push(assistantEntry);
                saveState();
            } else if (!failed && !settled && !state.text && el.wrap.isConnected) {
                el.wrap.remove();      // 空回答不留空气泡
            }
            scrollToBottom(true);
        }
    }

    // 把文本 + 图片组装成 OpenAI/DeepSeek 的 content 结构
    function buildUserContent(text, imageUrls) {
        if (!imageUrls || !imageUrls.length) return text;
        const parts = [];
        if (text) parts.push({ type: 'text', text: text });
        imageUrls.forEach(function (url) {
            parts.push({ type: 'image_url', image_url: { url: url } });
        });
        return parts;
    }

    // 逐行读取 SSE：data: {"delta"} / {"reasoning"} / {"usage"} / {"done"} / {"error"}
    async function consumeStream(resp, state) {
        let reader = null;
        if (!resp.body || !resp.body.getReader) {
            // 极老的浏览器没有流式读取：退化成一次性读取
            parseSseText(await resp.text(), state);
            return;
        }
        reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                buffer += decoder.decode(chunk.value, { stream: true });

                let idx;
                while ((idx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, idx).replace(/\r$/, '');
                    buffer = buffer.slice(idx + 1);
                    handleSseLine(line, state);
                }
            }
            buffer += decoder.decode();
            if (buffer) handleSseLine(buffer.replace(/\r$/, ''), state);
        } catch (err) {
            // 出错（含用户点「停止」）时主动断开连接，别让上游继续生成
            try { await reader.cancel(); } catch (e) { /* 忽略 */ }
            throw err;
        }
    }

    function parseSseText(raw, state) {
        String(raw || '').split('\n').forEach(function (line) {
            handleSseLine(line.replace(/\r$/, ''), state);
        });
    }

    function handleSseLine(line, state) {
        if (!line || line.charAt(0) === ':') return;
        if (line.indexOf('data:') !== 0) return;
        const payload = line.slice(5).trim();
        if (!payload) return;
        if (payload === '[DONE]') { state.completed = true; return; }

        let obj;
        try { obj = JSON.parse(payload); } catch (e) { throw new Error('收到无法解析的回答数据，请重试。'); }

        if (obj.error) throw new Error(obj.error);
        if (obj.done) state.completed = true;
        if (typeof obj.model === 'string') state.model = obj.model;
        if (obj.reasoning) {
            state.reasoning += obj.reasoning;
            streamTick(state);
        }
        if (obj.delta) {
            state.text += obj.delta;
            streamTick(state);
        }
    }

    // =========================================================================
    // 八、显示 / 隐藏
    // =========================================================================
    function clampViewportBounds() {
        if (!panel) return;
        const maxLeft = Math.max(0, window.innerWidth - 120);
        const maxTop = Math.max(getHeaderHeight(), window.innerHeight - 80);
        if (panel.offsetLeft > maxLeft) panel.style.left = maxLeft + 'px';
        if (panel.offsetTop > maxTop) panel.style.top = maxTop + 'px';
    }

    function showPanel(opts) {
        const focusInput = !opts || opts.focusInput !== false;
        ensureDom();
        refreshApiSettings().catch(function () {});
        if (panelVisible) return;
        panel.style.display = 'flex';
        panelVisible = true;
        renderRestoredHistoryIfNeeded();
        window.FloatingWindowLayers?.bringToFront(panel);

        // 首次打开：贴在鲸鱼按钮正下方（左对齐按钮，越界时回收进屏幕）
        if (!panel.style.left || !panel.style.top) {
            const headerH = getHeaderHeight();
            const rect = toolbarBtn ? toolbarBtn.getBoundingClientRect() : null;
            const w = panel.offsetWidth || 430;
            const h = panel.offsetHeight || 540;
            let left = rect ? rect.left - 8 : 80;
            let top = (rect ? rect.bottom : headerH) + 8;
            left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
            top = Math.max(headerH, Math.min(top, Math.max(headerH, window.innerHeight - h - 8)));
            panel.style.left = Math.round(left) + 'px';
            panel.style.top = Math.round(top) + 'px';
            window.FloatingWindowLayers?.resetViewportBase(panel);
        } else if (window.FloatingWindowLayers?.hasViewportBase(panel)) {
            window.FloatingWindowLayers.syncViewportBottom(panel);
            clampViewportBounds();
            window.FloatingWindowLayers.noteViewportClamped(panel);
        } else {
            clampViewportBounds();
            window.FloatingWindowLayers?.resetViewportBase(panel);
        }
        syncToolbarButton(true);
        if (focusInput) {
            setTimeout(function () { if (inputEl) inputEl.focus(); }, 30);
        }
    }

    function hidePanel() {
        if (pdfPickerOpen) closePdfPicker();
        if (panel) panel.style.display = 'none';
        panelVisible = false;
        syncToolbarButton(false);
    }

    function togglePanel(opts) {
        if (panelVisible) hidePanel(); else showPanel(opts);
    }

    function syncToolbarButton(active) {
        if (!toolbarBtn) toolbarBtn = document.getElementById('deepseek-chat-btn');
        if (!toolbarBtn) return;
        if (active) {
            toolbarBtn.classList.add('bg-white', 'shadow-sm', 'text-blue-600');
            toolbarBtn.classList.remove('text-gray-600');
        } else {
            toolbarBtn.classList.remove('bg-white', 'shadow-sm', 'text-blue-600');
            toolbarBtn.classList.add('text-gray-600');
        }
    }

    function setChatStatus(nextStatus) {
        chatStatus = nextStatus === 'streaming' || nextStatus === 'error' ? nextStatus : 'idle';
        if (!toolbarBtn) toolbarBtn = document.getElementById('deepseek-chat-btn');
        if (!toolbarBtn) return;
        toolbarBtn.classList.toggle('is-streaming', chatStatus === 'streaming');
        toolbarBtn.classList.toggle('is-error', chatStatus === 'error');
        toolbarBtn.dataset.chatStatus = chatStatus;
        if (chatStatus === 'streaming') {
            toolbarBtn.title = 'DeepSeek 对话 · 正在回答… (可粘贴图片 · D)';
        } else if (chatStatus === 'error') {
            toolbarBtn.title = 'DeepSeek 对话 · 回答出错 (可粘贴图片 · D)';
        } else {
            toolbarBtn.title = 'DeepSeek 对话 (可粘贴图片 · D)';
        }
    }

    // =========================================================================
    // 九、初始化
    // =========================================================================
    function init() {
        ensureDom();
        restoreState();
        refreshApiSettings().catch(function () {});
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
