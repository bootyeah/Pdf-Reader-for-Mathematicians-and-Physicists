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
    const MAX_IMAGES = 4;              // 单条消息最多几张图
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    const HEADER_HEIGHT = 72;          // 顶栏高度（与 LOCALPdfReader.html 的 h-[72px] 一致）

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
    let inputEl = null;
    let sendBtn = null;
    let stopBtn = null;
    let thumbsEl = null;
    let modelBtn = null;
    let modelMenu = null;
    let modelLabel = null;
    let thinkingBtn = null;
    let clearBtn = null;
    let closeBtn = null;
    let resizeHandle = null;
    let toolbarBtn = null;

    // ---------- 会话状态 ----------
    let history = [];              // [{role:'user'|'assistant', content:string|Array}]
    let attachments = [];          // 待发送图片 [{id, dataUrl, name}]
    let streaming = false;         // 正在生成
    let abortController = null;
    let panelVisible = false;
    let isComposing = false;       // 中文输入法组词中（此时回车不算发送）
    let pendingScroll = false;
    let renderScheduled = false;
    let model = MODELS[0].id;
    let thinking = false;
    let apiRevision = '';
    let apiRefresh = null;
    let modelThinking = {};        // 模型 → 'enabled' | 'disabled' | 'omit'（来自 /api/ai-config）

    // 当前模型不接受思考参数（如 Gemini）时：按钮置灰、不发送，但保留用户对其他模型的开关偏好
    function thinkingAllowed() {
        return modelThinking[model] !== 'omit';
    }

    function syncThinkingAvailability() {
        if (!thinkingBtn) return;
        const allowed = thinkingAllowed();
        thinkingBtn.disabled = !allowed;
        if (allowed) {
            setThinking(thinking);
        } else {
            thinkingBtn.classList.remove('active');
            thinkingBtn.title = '当前模型不使用思考开关（管理工具已设置为不发送思考参数）';
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
            const providers = cfg.model_provider || {};
            MODELS = [cfg.model].concat(cfg.models).filter(function (id, i, all) {
                return typeof id === 'string' && id && all.indexOf(id) === i;
            }).map(function (id, i) {
                const gemini = providers[id] === 'chat_gemini';
                return {id: id, label: id, hint: gemini ? 'Gemini · 独立接口' : (i ? '可选模型' : '管理工具 · 默认模型')};
            });
            buildModelMenu();
            apiRevision = cfg.revision;
            setModel(changed ? cfg.model : model);
            if (changed) setThinking(cfg.thinking === 'enabled');
            syncThinkingAvailability();
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
            if (!wrap.querySelector('.ds-message-copy')) {
                const copy = document.createElement('button');
                copy.type = 'button';
                copy.className = 'ds-message-copy';
                copy.title = '复制选中的 Markdown / LaTeX；未框选时复制完整回答（含 TikZ 源码）';
                copy.setAttribute('aria-live', 'polite');
                copy.innerHTML = '<i class="ph ph-copy" aria-hidden="true"></i><span>复制 Markdown</span>';
                // 放在气泡外：流式输出、TikZ 编译完成和历史恢复都不改动复制按钮。
                wrap.appendChild(copy);
            }
        }
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
                '<div class="ds-chat-spacer"></div>' +
                '<button type="button" class="ds-chat-hbtn" id="ds-chat-thinking-btn" title="思考模式（更周密，但更慢）">' +
                    '<i class="ph ph-brain"></i>' +
                '</button>' +
                '<button type="button" class="ds-chat-hbtn" id="ds-chat-clear-btn" title="清空对话">' +
                    '<i class="ph ph-broom"></i>' +
                '</button>' +
                '<button type="button" class="ds-chat-hbtn ds-chat-hbtn-close" id="ds-chat-close-btn" title="收起对话 (Esc)">' +
                    '<i class="ph ph-x"></i>' +
                '</button>' +
            '</div>' +
            '<div class="ds-chat-body custom-scrollbar" id="ds-chat-body">' + WELCOME + '</div>' +
            '<div class="ds-chat-thumbs" id="ds-chat-thumbs"></div>' +
            '<div class="ds-chat-input-row">' +
                '<button type="button" class="ds-chat-tool" id="ds-chat-image-btn" title="选择图片（也可直接 Ctrl+V 粘贴）">' +
                    '<i class="ph ph-image"></i>' +
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
        inputEl = panel.querySelector('#ds-chat-input');
        sendBtn = panel.querySelector('#ds-chat-send-btn');
        thumbsEl = panel.querySelector('#ds-chat-thumbs');
        modelBtn = panel.querySelector('#ds-chat-model-btn');
        modelMenu = panel.querySelector('#ds-chat-model-menu');
        modelLabel = panel.querySelector('#ds-chat-model-label');
        thinkingBtn = panel.querySelector('#ds-chat-thinking-btn');
        clearBtn = panel.querySelector('#ds-chat-clear-btn');
        closeBtn = panel.querySelector('#ds-chat-close-btn');
        resizeHandle = panel.querySelector('#ds-chat-resize');
        toolbarBtn = document.getElementById('deepseek-chat-btn');

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
        model = MODELS.some(function (m) { return m.id === id; }) ? id : MODELS[0].id;
        const m = MODELS.filter(function (x) { return x.id === model; })[0];
        if (modelLabel) modelLabel.textContent = m.label;
        if (modelBtn) modelBtn.title = '当前模型：' + m.label + '（' + m.hint + '）· 点击切换';
        modelMenu.querySelectorAll('.ds-chat-model-opt').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.model === model);
        });
        saveState();
        syncThinkingAvailability();
    }

    function setThinking(on) {
        thinking = !!on;
        thinkingBtn.classList.toggle('active', thinking);
        thinkingBtn.title = thinking ? '思考模式：开（回答更周密，首字更慢）' : '思考模式：关（默认，响应更快）';
        saveState();
    }

    // =========================================================================
    // 三、渲染会话
    // =========================================================================
    function clearBody() {
        bodyEl.innerHTML = '';
        paintedMessages.clear();
        openTikzSources.clear();
        selectingBody = null;
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

    function userMessageEl(text, images) {
        const el = messageEl('user');
        let html = '';
        (images || []).forEach(function (src) {
            html += '<img class="ds-chat-img" src="' + src + '" alt="图片">';
        });
        if (text) {
            // 用户原文按纯文本显示（保留换行），不做 Markdown 解析
            html += '<div class="ds-user-text">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
        }
        el.bubble.innerHTML = html;
        return el;
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

    // 流式渲染：一帧最多重排一次（每个 token 都重排会让长回答明显卡顿）
    function streamTick(state) {
        if (state.renderQueued) return;
        state.renderQueued = true;
        requestAnimationFrame(function () {
            state.renderQueued = false;
            if (!state.alive) return;
            paintStream(state);
            scheduleScroll(false);
        });
    }

    // 把当前累积的文本铺进气泡：思考块（若有）在上，正文在下
    function paintStream(state) {
        if (state.headEl && state.reasoning) {
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
        if (!panel) return;          // 面板还没建好（初始化早期的 blur 事件）直接跳过
        try {
            const data = {
                left: panel ? panel.style.left : '',
                top: panel ? panel.style.top : '',
                width: panel ? panel.style.width : '',
                height: panel ? panel.style.height : '',
                model: model,
                apiRevision: apiRevision,
                thinking: thinking,
                // 只存纯文本历史（图片 data URL 体积太大，绝不写进 localStorage）
                history: history.slice(-MAX_HISTORY).map(function (m) {
                    return { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
                }).filter(function (m) { return m.content; })
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) { /* 存储不可用时静默 */ }
    }

    function restoreState() {
        let data = null;
        try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { data = null; }
        if (!data) return;

        if (data.width) panel.style.width = data.width;
        if (data.height) panel.style.height = data.height;
        if (data.left && data.top) {
            const w = parseInt(data.width, 10) || 430;
            const maxLeft = Math.max(0, window.innerWidth - w - 4);
            const maxTop = Math.max(0, window.innerHeight - 60);
            panel.style.left = Math.min(Math.max(4, parseInt(data.left, 10) || 0), maxLeft) + 'px';
            panel.style.top = Math.min(Math.max(HEADER_HEIGHT, parseInt(data.top, 10) || HEADER_HEIGHT), maxTop) + 'px';
        }
        apiRevision = data.apiRevision || '';
        if (data.model && !MODELS.some(function (m) { return m.id === data.model; })) {
            MODELS.push({id: data.model, label: data.model, hint: '已保存的选择'});
            buildModelMenu();
        }
        setModel(data.model || MODELS[0].id);
        setThinking(!!data.thinking);

        if (Array.isArray(data.history) && data.history.length) {
            clearBody();
            data.history.forEach(function (m) {
                history.push({ role: m.role, content: m.content });
                if (m.role === 'user') userMessageEl(m.content, []);
                else {
                    const el = messageEl('assistant');
                    const content = document.createElement('div');
                    content.className = 'ds-content';
                    el.bubble.appendChild(content);
                    paintMessageBody(content, m.content, {});
                }
            });
            scrollToBottom(true);
        }
    }

    // =========================================================================
    // 五、事件绑定
    // =========================================================================
    function bindEvents() {
        closeBtn.addEventListener('click', function (e) { e.stopPropagation(); hidePanel(); });
        clearBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!history.length) return;
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

        // 工具栏「选择图片」按钮
        panel.querySelector('#ds-chat-image-btn').addEventListener('click', function (e) {
            e.stopPropagation();
            pickImageFile();
        });

        // 回答 / 代码块复制、TikZ 源码开关、思考过程折叠（事件委托，消息是流式重建的）
        bodyEl.addEventListener('click', function (e) {
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

        // 只在对话区放行原生右键菜单；PDF 区域继续使用阅读器原来的行为。
        panel.addEventListener('contextmenu', function (e) { e.stopPropagation(); });
        bodyEl.addEventListener('mousedown', function (e) {
            if (e.target.closest('.ds-message-copy')) { e.preventDefault(); return; }
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
        let resizing = false, rw = 0, rh = 0, rmx = 0, rmy = 0;
        function onResizeMove(e) {
            if (!resizing) return;
            const maxW = Math.max(300, window.innerWidth - panel.offsetLeft - 8);
            const maxH = Math.max(220, window.innerHeight - panel.offsetTop - 8);
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
            saveState();
        }
        resizeHandle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            resizing = true;
            rw = panel.offsetWidth; rh = panel.offsetHeight;
            rmx = e.clientX; rmy = e.clientY;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'nwse-resize';
            document.addEventListener('mousemove', onResizeMove, true);
            document.addEventListener('mouseup', onResizeEnd, true);
        });

        window.addEventListener('blur', function () { onDragEnd(); onResizeEnd(); });

        // 窗口尺寸变化时把面板拉回可视区
        window.addEventListener('resize', function () {
            if (!panelVisible) return;
            const maxLeft = Math.max(0, window.innerWidth - 120);
            const maxTop = Math.max(HEADER_HEIGHT, window.innerHeight - 80);
            if (panel.offsetLeft > maxLeft) panel.style.left = maxLeft + 'px';
            if (panel.offsetTop > maxTop) panel.style.top = maxTop + 'px';
        });

        // 工具栏按钮
        if (toolbarBtn) {
            toolbarBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                togglePanel();
            });
        }

        // Esc 收起面板（输入框里按下时由上面的 keydown 处理）
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape' || !panelVisible) return;
            if (e.target && e.target.closest && e.target.closest('#ds-chat-panel')) return;
            hidePanel();
        });
    }

    function autoGrow() {
        if (!inputEl) return;
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
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
            if (node.matches('button, [hidden], .ds-code-head, .ds-chat-note, .ds-tikz-bar')) return '';
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
    // 六、图片：粘贴 / 拖拽 / 选择
    // =========================================================================
    function pickImageFile() {
        let input = document.getElementById('ds-chat-file-input');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.id = 'ds-chat-file-input';
            input.accept = 'image/png,image/jpeg,image/webp,image/gif';
            input.multiple = true;
            input.style.display = 'none';
            input.addEventListener('change', function () {
                addImageFiles(input.files);
                input.value = '';
            });
            document.body.appendChild(input);
        }
        input.click();
    }

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
            if (attachments.length >= MAX_IMAGES) {
                flashHint('单条消息最多 ' + MAX_IMAGES + ' 张图片');
                return;
            }
            const reader = new FileReader();
            reader.onload = function () {
                attachments.push({
                    id: 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
                    dataUrl: reader.result,
                    name: file.name || 'pasted-image'
                });
                renderThumbs();
                inputEl.focus();
            };
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
        thumbsEl.innerHTML = attachments.map(function (a) {
            return '<div class="ds-thumb" data-id="' + a.id + '" title="' + escapeHtml(a.name) + '">' +
                '<img src="' + a.dataUrl + '" alt="">' +
                '<button type="button" class="ds-thumb-del" data-del="' + a.id + '" title="移除">' +
                    '<i class="ph ph-x"></i>' +
                '</button>' +
            '</div>';
        }).join('');
        thumbsEl.querySelectorAll('.ds-thumb-del').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                attachments = attachments.filter(function (a) { return a.id !== btn.dataset.del; });
                renderThumbs();
            });
        });
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

    function setStreaming(on) {
        streaming = on;
        sendBtn.style.display = on ? 'none' : '';
        stopBtn.style.display = on ? '' : 'none';
        clearBtn.disabled = on;
        inputEl.disabled = false;      // 允许边生成边打下一句
        panel.classList.toggle('is-streaming', on);
    }

    async function send(text, images) {
        ensureDom();
        if (!panelVisible) showPanel();

        // 首次发言时把开场白清掉
        if (!history.length) clearBody();

        // 1. 本地回显用户消息 + 写入历史
        const imageUrls = (images || []).map(function (a) { return a.dataUrl; });
        const userEl = userMessageEl(text, imageUrls);
        const userContent = buildUserContent(text, imageUrls);
        const userEntry = { role: 'user', content: userContent };
        history.push(userEntry);
        while (history.length > MAX_HISTORY + 1) history.shift();

        // 2. 建立助手气泡并进入流式状态
        const el = startAssistantMessage(thinking ? '正在深度思考…' : '正在思考…');
        const state = Object.assign({
            alive: true,
            text: '',
            reasoning: '',
            renderQueued: false
        }, el);
        setStreaming(true);
        abortController = new AbortController();

        let failed = false;
        let settled = false;      // catch 分支已经按最终态画过（别再画一遍把提示语冲掉）
        try {
            await refreshApiSettings();
            if (abortController.signal.aborted) throw new DOMException('Stopped', 'AbortError');
            const resp = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: abortController.signal,
                body: JSON.stringify({
                    messages: history,
                    model: model,
                    stream: true,
                    thinking: thinking && thinkingAllowed()
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
                const retryTurn = (text || (images && images.length)) ? function () {
                    if (el.wrap.isConnected) el.wrap.remove();
                    if (userEl.wrap.isConnected) userEl.wrap.remove();
                    const idx = history.lastIndexOf(userEntry);
                    if (idx !== -1) history.splice(idx, 1);
                    send(text, images);
                } : null;
                if (state.text) {
                    settled = true;
                    paintMessageBody(state.bodyEl, state.text, {});
                    renderError(msg, retryTurn);
                } else {
                    el.wrap.remove();
                    renderError(msg, retryTurn);
                }
            }
        } finally {
            state.alive = false;
            setStreaming(false);
            abortController = null;
            // 流式结束按「最终态」再画一次：半途截断的 TikZ 会从占位符换成可折叠的源码块
            if (state.text && !settled) paintMessageBody(state.bodyEl, state.text, {});
            if (!failed && state.text) {
                history.push({ role: 'assistant', content: state.text });
                saveState();
            } else if (!failed && !state.text && el.wrap.isConnected) {
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
        if (!payload || payload === '[DONE]') return;

        let obj;
        try { obj = JSON.parse(payload); } catch (e) { return; }

        if (obj.error) throw new Error(obj.error);
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
    function showPanel() {
        ensureDom();
        refreshApiSettings().catch(function () {});
        if (panelVisible) return;
        panel.style.display = 'flex';
        panelVisible = true;

        // 首次打开：贴在鲸鱼按钮正下方（左对齐按钮，越界时回收进屏幕）
        if (!panel.style.left || !panel.style.top) {
            const rect = toolbarBtn ? toolbarBtn.getBoundingClientRect() : null;
            const w = panel.offsetWidth || 430;
            const h = panel.offsetHeight || 540;
            let left = rect ? rect.left - 8 : 80;
            let top = (rect ? rect.bottom : HEADER_HEIGHT) + 8;
            left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
            top = Math.max(HEADER_HEIGHT, Math.min(top, Math.max(HEADER_HEIGHT, window.innerHeight - h - 8)));
            panel.style.left = Math.round(left) + 'px';
            panel.style.top = Math.round(top) + 'px';
        }
        syncToolbarButton(true);
        setTimeout(function () { if (inputEl) inputEl.focus(); }, 30);
    }

    function hidePanel() {
        if (panel) panel.style.display = 'none';
        panelVisible = false;
        syncToolbarButton(false);
    }

    function togglePanel() {
        if (panelVisible) hidePanel(); else showPanel();
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
