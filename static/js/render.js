// PDF 位图调度在 pdf-renderer.js；这里保留链接跳转、批注与公式渲染。
        async function navigateToDestination(dest) {
            const pdfDoc = state.pdfDoc;
            const loadToken = state.loadToken;
            if (!pdfDoc) return;
            const isStale = () => state.pdfDoc !== pdfDoc || state.loadToken !== loadToken;
            try {
                const pageIndex = await resolvePdfDestinationPage(pdfDoc, dest);
                if (pageIndex === null) return;
                if (isStale()) return;
                const pageNum = pageIndex + 1;

                recordJumpPosition();
                scrollPdfPageIntoView(pageNum);
            } catch (error) {
                if (!isStale()) console.warn('PDF 内部跳转失败:', error);
            }
        }

        // 全局拖拽元素引用
        let draggingElement = null;

        // ==============================================================================
        // ⚠️ 外部配置声明 (External Configuration Declaration)
        // ==============================================================================
        // 下列三大全局配置常量已抽离至同级目录的 `config.js` 文件中，以精简核心代码体积：
        // 
        // 1. LATEX_CONFIG   : 全局 LaTeX / TikZ 扩展宏包与环境配置中心
        // 2. LATEX_SNIPPETS : 量子速录引擎 (Snippet Engine) 的 LaTeX 快捷键字典
        // 3. MARKER_CONFIG  : 全局图章/标记 (Markers) 的矢量 SVG 核心库与尺寸配置
        // 
        // 注：这些变量会在 HTML 头部通过 config.js 脚本标签优先注入为全局变量。
        // ==============================================================================

        function getMarkerSvg(type, customClass) {
            const m = MARKER_CONFIG[type];
            if (!m) return '';
            return `<svg viewBox="${m.viewBox}" class="${customClass}" fill="${m.fill}" stroke="${m.stroke}" stroke-width="${m.strokeWidth}">${m.inner}</svg>`;
        }
        // ==============================================================================
        // 🧩 TikZ 公共渲染层
        // ------------------------------------------------------------------------------
        // 批注文本框（renderTikzToImg）与 DeepSeek 对话面板（chat.js）共用这一层：
        //   · buildStandaloneTex() : 把一段 TikZ 片段补成可独立编译的完整文档
        //   · scanTikzBlocks()     : 在任意文本里找出 TikZ 环境（含流式输出里未闭合的尾巴）
        //   · requestTikzSvg()     : 编译 + 按内容缓存，同一段代码全应用只编译一次
        // scanTikzBlocks / requestTikzSvg 都不依赖 DOM，chat.js 拿它们直接做 Markdown 级渲染。
        // ==============================================================================
        const TIKZ_CACHE_LIMIT = 60;          // 最多缓存多少张矢量图（每张几十 KB 量级）
        const TIKZ_CACHE = new Map();         // key -> {status, dataUrl, error, settleHandlers}

        function tikzEnvPattern() {
            const envs = (typeof LATEX_CONFIG !== 'undefined' && LATEX_CONFIG.environments && LATEX_CONFIG.environments.length)
                ? LATEX_CONFIG.environments
                : ['tikzpicture'];
            return envs.join('|');
        }

        // 直接使用源码作为键，避免短哈希碰撞把另一张图当作当前图。
        function tikzCacheKey(tex) { return tex; }

        // 把 TikZ 片段补成完整文档。
        // opts.extractBody !== false 时（对话面板用）：只取 document 正文，导言区一律换成下面这套
        // 「预装齐全」的宏包与库 —— 模型经常少写 \usepackage / \usetikzlibrary，直接编译必然失败。
        // 批注文本框走 extractBody:false，完全保留用户自己写的文档结构（老行为不变）。
        function buildStandaloneTex(tikzCode, opts) {
            const options = opts || {};
            let body = String(tikzCode == null ? '' : tikzCode).trim();
            if (!body) return '';

            if (options.extractBody) {
                const doc = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(body);
                if (doc) {
                    body = doc[1].trim();
                } else if (!/\\begin\{/.test(body)) {
                    // 只有零散前言、根本没有环境体：把前言也去掉，剩下什么送什么
                    body = body.replace(/\\documentclass(\[[^\]]*\])?\{[^}]*\}/g, '')
                               .replace(/\\usepackage(\[[^\]]*\])?\{[^}]*\}/g, '')
                               .trim();
                }
            }
            if (!body) return '';
            // 清理 TikZ 节点括号内的首尾误输入空格，例如 (c6 ) 或 (c6 .north) -> (c6) / (c6.north)，
            // 避免 PGF 把末尾空格当成节点名一部分而报 No shape named `c6 ' is known.
            body = body.replace(/\(\s*([A-Za-z][A-Za-z0-9_@-]*)\s*(?:\.\s*([A-Za-z0-9_@ -]+?)\s*)?\)/g, function (m, name, anchor) {
                return anchor ? '(' + name + '.' + anchor.trim() + ')' : '(' + name + ')';
            });
            // 已经是完整文档（批注里用户自己写的），原样交给引擎
            if (body.includes('\\documentclass')) return body;

            const packagesStr = (typeof LATEX_CONFIG !== 'undefined') ? LATEX_CONFIG.packages.join('\n') : '\\usepackage{tikz}';
            const tikzLibraries = (typeof LATEX_CONFIG !== 'undefined' && LATEX_CONFIG.tikzLibraries) || [];
            const pgfplotsLibraries = (typeof LATEX_CONFIG !== 'undefined' && LATEX_CONFIG.pgfplotsLibraries) || [];
            const tikzLibsStr = tikzLibraries.length > 0 ? `\\usetikzlibrary{${tikzLibraries.join(',')}}` : '';
            const pgfLibsStr = pgfplotsLibraries.length > 0 ? `\\usepgfplotslibrary{${pgfplotsLibraries.join(',')}}` : '';

            // 🌟 智能中文嗅探：注释里的中文不算数，正文有中文才挂 ctex
            const codeWithoutComments = body.replace(/(^|[^\\])%.*/g, '$1');
            const hasChinese = /[\u4e00-\u9fa5]/.test(codeWithoutComments);
            const ctexPackage = hasChinese ? '\\usepackage[UTF8]{ctex}\n' : '';

            return `\\documentclass[border=4pt, tikz]{standalone}\n${ctexPackage}${packagesStr}\n${tikzLibsStr}\n${pgfLibsStr}\n\\begin{document}\n${body}\n\\end{document}`;
        }

        // 在一段文本里找出所有 TikZ 环境：返回 [{start, end, env, code, complete}]（按出现顺序）。
        // allowIncomplete=true（流式输出）时，末尾那个「开了头还没收尾」的块也会返回，
        // 调用方据此先摆占位符，等它闭合再交给引擎；false 时未闭合的块直接不算数。
        function scanTikzBlocks(text, allowIncomplete) {
            const src = String(text == null ? '' : text);
            const blocks = [];
            const openRe = new RegExp('\\\\begin\\{(' + tikzEnvPattern() + ')\\}', 'g');
            let m;
            while ((m = openRe.exec(src)) !== null) {
                const env = m[1];
                const close = new RegExp('\\\\end\\{' + env + '\\}').exec(src.slice(m.index));
                if (close) {
                    const end = m.index + close.index + close[0].length;
                    blocks.push({ start: m.index, end: end, env: env, code: src.slice(m.index, end), complete: true });
                    openRe.lastIndex = end;
                } else {
                    // 没闭合：只有「看起来真的在写图」才算半截图形。
                    // 光是正文里提一句「用 \begin{tikzpicture} 开头」不该被当成图形吞掉。
                    if (allowIncomplete && tikzLooksLikeBody(src.slice(m.index))) {
                        blocks.push({ start: m.index, end: src.length, env: env, code: src.slice(m.index), complete: false });
                    }
                    break;
                }
            }
            return blocks;
        }

        // 半截代码是否像图形正文：\begin 之后还有别的命令，或者已经换过行
        function tikzLooksLikeBody(code) {
            const inner = String(code).replace(/^\s*\\begin\{[^}]*\}(\s*\[[^\]]*\])?/, '');
            return /\\[A-Za-z]+/.test(inner) || inner.indexOf('\n') !== -1;
        }

        function trimTikzCache() {
            if (TIKZ_CACHE.size <= TIKZ_CACHE_LIMIT) return;
            for (const [key, entry] of TIKZ_CACHE) {
                if (TIKZ_CACHE.size <= TIKZ_CACHE_LIMIT) break;
                if (entry.status === 'pending') continue;      // 正在编译的不能丢
                TIKZ_CACHE.delete(key);
            }
        }

        // 编译一段 TikZ（带按内容缓存 + 进行中请求合并）。
        // 返回 entry：{status:'pending'|'done'|'error', dataUrl, error, key}；
        // onSettle 只在这次编译真正出结果时回调一次（重复传入同一个函数会被忽略）。
        function requestTikzSvg(tikzCode, opts, onSettle) {
            const tex = buildStandaloneTex(tikzCode, opts);
            if (!tex) return { status: 'error', error: '空的 TikZ 代码', key: '' };

            const key = tikzCacheKey(tex);
            let entry = TIKZ_CACHE.get(key);
            if (!entry) {
                entry = { key: key, status: 'pending', dataUrl: '', error: '', settleHandlers: [] };
                TIKZ_CACHE.set(key, entry);
                trimTikzCache();

                fetch('/api/render-tikz', { method: 'POST', body: tex })
                    .then(function (response) {
                        if (response.ok) return response.text();
                        return response.text().then(function (detail) {
                            throw new Error((detail || '').trim() || ('编译失败（HTTP ' + response.status + '）'));
                        });
                    })
                    .then(function (base64) {
                        entry.status = 'done';
                        entry.dataUrl = 'data:image/svg+xml;base64,' + String(base64).trim();
                    })
                    .catch(function (e) {
                        entry.status = 'error';
                        entry.error = (e && e.message) || String(e);
                        console.error('Local TikZ Render Error:', e);
                    })
                    .then(function () {
                        const handlers = entry.settleHandlers.slice();
                        entry.settleHandlers.length = 0;
                        handlers.forEach(function (fn) {
                            try { fn(entry); } catch (err) { console.warn(err); }
                        });
                    });
            }
            if (onSettle && entry.status === 'pending' && entry.settleHandlers.indexOf(onSettle) === -1) {
                entry.settleHandlers.push(onSettle);
            }
            return entry;
        }

        // 供 chat.js 使用（对话面板是独立模块，统一从这个出口取能力）
        window.TikzRender = {
            buildStandaloneTex: buildStandaloneTex,
            scanTikzBlocks: scanTikzBlocks,
            requestTikzSvg: requestTikzSvg,
            envPattern: tikzEnvPattern
        };

        async function renderTikzToImg(tikzCode, containerNode, anno, pageNum) {
            if (!containerNode) return;
            const loadToken = state.loadToken;
            const request = {};
            tikzNodeRequests.set(containerNode, request);
            const source = anno?.text ?? anno?.note;
            const isCurrent = () => state.loadToken === loadToken &&
                tikzNodeRequests.get(containerNode) === request &&
                (!anno || (state.annotations[pageNum]?.includes(anno) && (anno.text ?? anno.note) === source));
            try {
                const entry = requestTikzSvg(tikzCode, { extractBody: false });
                if (entry.status === 'error') throw new Error(entry.error || '编译失败');
                const imgSrc = entry.status === 'done' ? entry.dataUrl : await new Promise(function (resolve, reject) {
                    entry.settleHandlers.push(function (settled) {
                        if (settled.status === 'done') resolve(settled.dataUrl);
                        else reject(new Error(settled.error || '编译失败'));
                    });
                });
                if (!isCurrent()) return;

                if (anno) { anno.tikzBase64 = imgSrc; anno.tikzSource = tikzCode; }

                const img = document.createElement('img');
                img.src = imgSrc;
                img.style.pointerEvents = 'none'; 
                
                img.onload = () => {
                    if (!isCurrent()) return;
                    entry.imgH = img.naturalHeight;
                    containerNode.innerHTML = '';
                    img.style.height = (img.naturalHeight / 8) + 'em';
                    img.style.width = 'auto';
                    img.style.maxWidth = 'none';
                    img.style.display = 'block';
                    img.style.margin = '0 auto';
                    
                    containerNode.style.display = 'block';
                    containerNode.style.minHeight = '0';
                    containerNode.style.border = 'none';
                    containerNode.style.background = 'transparent';
                    containerNode.appendChild(img);

                    if (anno) {
                        anno.imgH = img.naturalHeight;
                        saveAnnotationsToStorage();
                    }
                };
            } catch (e) {
                if (!isCurrent()) return;
                console.error('Local TikZ Render Error:', e);
                containerNode.innerHTML = '<span class="text-red-500 text-xs font-bold">[ 图形渲染失败，请检查 LaTeX 语法或本地引擎日志 ]</span>';
            }
        }
        async function resolvePdfDestinationPage(pdfDoc, dest) {
            const explicitDest = typeof dest === 'string' ? await pdfDoc.getDestination(dest) : dest;
            if (!Array.isArray(explicitDest) || !explicitDest.length) return null;
            const ref = explicitDest[0];
            const index = Number.isInteger(ref) ? ref : await pdfDoc.getPageIndex(ref);
            return Number.isInteger(index) && index >= 0 && index < pdfDoc.numPages ? index : null;
        }
        const tikzNodeRequests = new WeakMap();

        // 保留当前画面对应的源码；输入防抖尚未完成时，它可能与输入框内容不同。
        const textAnnotationSources = new WeakMap();
        // 每次重绘文本块自增：编辑框光标据此判断画面上的幻影节点是否已被重绘抹掉。
        let textAnnotationRenderVersion = 0;

        // 没有手动宽高时，由浏览器按实际排版持续贴合内容（也覆盖公式和异步图片）。
        function applyTextAnnotationSize(div, anno, w, h) {
            const autoSize = !anno.width && !anno.height;
            div.style.width = autoSize ? 'max-content' : (anno.width ? (anno.width * w) + 'px' : '');
            div.style.height = anno.height ? (anno.height * h) + 'px' : '';
            div.style.minWidth = autoSize ? 'min-content' : '';
            // 普通长文本在本页/草稿页的剩余宽度内换行；不可折行的公式、图形保留完整宽度。
            const rightEdge = Math.max(1, Math.floor(anno.x) + 1);
            div.style.maxWidth = autoSize ? Math.max(0, (rightEdge - anno.x) * w) + 'px' : '';
            div.style.overflowWrap = autoSize ? 'anywhere' : '';
        }

        function resetTextAnnotationSize(anno, div = null) {
            delete anno.width;
            delete anno.height;
            const data = div && textResizeDataMap.get(div);
            if (data) applyTextAnnotationSize(div, anno, data.w, data.h);
        }

        function renderLatex(element, anno = null, pageNum = null) {
            if (element.classList.contains('text-annotation')) {
                textAnnotationSources.set(element, (anno?.text || '').replace(/\r\n?/g, '\n'));
                textAnnotationRenderVersion++;
            }
            const graphicScale = textResizeDataMap.get(element)?.scale || 1;
            const envs = LATEX_CONFIG.environments.join('|');
            const tikzRegex = new RegExp("\\\\begin\\{(" + envs + ")\\}[\\s\\S]*?\\\\end\\{\\1\\}", 'g');
            
            const tikzMatches = element.innerHTML.match(tikzRegex);
            if (tikzMatches) {
                element.innerHTML = element.innerHTML.replace(tikzRegex, (match) => {
                    const cleanTikz = match.replace(/<br\s*\/?>/gi, '\n')
                                           .replace(/&lt;/g, '<')
                                           .replace(/&gt;/g, '>')
                                           .replace(/&amp;/g, '&')
                                           .replace(/&nbsp;/g, ' ');
                    const cachedAnno = tikzMatches.length === 1 ? anno : null;
                    const cachedEntry = TIKZ_CACHE.get(tikzCacheKey(buildStandaloneTex(cleanTikz, { extractBody: false })));
                    let cachedSrc = cachedEntry?.status === 'done' ? cachedEntry.dataUrl : '';
                    let cachedHeight = cachedEntry?.imgH;
                    if (cachedAnno && (!anno.tikzSource || anno.tikzSource === cleanTikz) &&
                        /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=\s]+$/.test(anno.tikzBase64 || '')) {
                        cachedSrc = anno.tikzBase64;
                        cachedHeight = anno.imgH || cachedHeight;
                    }
                    if (cachedSrc) {
                        const h = cachedHeight ? (cachedHeight / 8) + 'em' : 'auto';
                        // 🌟 压平为一行，彻底消灭渲染图片时的换行空白！
                        return `<div class="ignored-by-katex" style="margin: ${8 * graphicScale}px 0;"><img src="${cachedSrc}" ${cachedHeight ? '' : 'data-tikz-auto-height'} style="height: ${h}; width: auto; max-width: none; display: block; margin: 0 auto; pointer-events: none;"></div>`;
                    }

                    const id = 'tikz-' + Math.random().toString(36).substr(2, 9);
                    
                    setTimeout(() => {
                        const targetBox = element.querySelector('#' + id);
                        renderTikzToImg(cleanTikz, targetBox, cachedAnno, pageNum);
                    }, 20);

                    // 🌟 占位提示符同样压平为一行
                    return `<div id="${id}" class="ignored-by-katex" style="margin: ${8 * graphicScale}px 0; text-align: center; min-height: ${40 * graphicScale}px; display: flex; justify-content: center; align-items: center; background: rgba(0,0,0,0.02); border-radius: ${4 * graphicScale}px; border: ${graphicScale}px dashed #cbd5e1;"><span class="animate-pulse text-blue-500 font-bold" style="font-size: ${12 * graphicScale}px;">[ 渲染图形中... ]</span></div>`;
                });
                // 缓存可能先由对话或导图生成，尚无文本块的自然高度记录。
                for (const img of element.querySelectorAll('img[data-tikz-auto-height]')) {
                    const setHeight = () => { img.style.height = (img.naturalHeight / 8) + 'em'; };
                    img.removeAttribute('data-tikz-auto-height');
                    if (img.complete && img.naturalHeight) setHeight();
                    else img.addEventListener('load', setHeight, { once: true });
                }
            }

            if (window.renderMathInElement) {
                try {
                    renderMathInElement(element, { 
                        delimiters: [ {left: '$$', right: '$$', display: true}, {left: '$', right: '$', display: false}, {left: '\\(', right: '\\)', display: false}, {left: '\\[', right: '\\]', display: true} ],
                        throwOnError: false, strict: false, ignoredClasses: ["ignored-by-katex"]
                    });
                } catch(e) { console.warn("KaTeX render error", e); }
            }
        }

        // ==============================================================================
        // 📐 文本框右下角缩放手势（取代浏览器原生拖拉角，因此界面上不再有"两道杠"）
        // 唯一真源：anno.width / anno.height 存的是"页面相对比例"。
        // 手势期间的临时像素只用于跟手，松手时立刻换算成比例写回批注数据；
        // 渲染时又只用比例 × 页面尺寸还原。因此页面缩放（重排或临时 transform）
        // 只会改变文本框在屏幕上的显示比例，绝不会改写它本身的宽高。
        // ==============================================================================
        const TEXT_RESIZE_ZONE = 16;   // 右下角感应区，单位是屏幕像素，与缩放无关
        const TEXT_RESIZE_MIN_W = 24;  // 最小宽度（画布像素，正常缩放下等同屏幕像素）
        const TEXT_RESIZE_MIN_H = 18;  // 最小高度
        const TEXT_RESIZE_MIN_CONTENT = 8;   // 最小值之上再留给正文的余量
        let textResizeGesture = null;
        let suppressTextClickUntil = 0;   // 刚缩放完的那一次 click 不该被当成"点击编辑"

        function isTextResizeCorner(div, e) {
            const rect = div.getBoundingClientRect();
            return e.clientX > rect.right - TEXT_RESIZE_ZONE && e.clientY > rect.bottom - TEXT_RESIZE_ZONE;
        }

        // 能拖到的最小尺寸：绝不能小于自身内边距之和。
        // 否则 width/height 会被浏览器按 padding 撑回去，"屏幕上的尺寸"与"存下来的比例"
        // 就对不上了（缩放重排后文本框会突然变个大小）。内边距随页面缩放，所以用计算值现算。
        function textResizeMinimum(div) {
            const cs = getComputedStyle(div);
            const padW = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
            const padH = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
            const data = textResizeDataMap.get(div);
            const zoom = data ? state.scale / data.scale : 1;
            return {
                width: Math.max(TEXT_RESIZE_MIN_W / zoom, padW + TEXT_RESIZE_MIN_CONTENT / zoom),
                height: Math.max(TEXT_RESIZE_MIN_H / zoom, padH + TEXT_RESIZE_MIN_CONTENT / zoom / 2)
            };
        }

        // 文本保留初次排版，并与批注层的临时缩放叠加；手势按总视觉比例换算。
        function textResizeScale(div) {
            const layer = div.closest('.annotation-layer');
            const transformScale = node => {
                const matched = node && /matrix\(([^)]+)\)/.exec(getComputedStyle(node).transform);
                return matched ? Number(matched[1].split(',')[0]) || 1 : 1;
            };
            const scale = transformScale(div) * transformScale(layer);
            const wrapper = div.closest('.page-wrapper');
            if (!wrapper) return scale;
            const layoutW = parseFloat(wrapper.style.width);
            const visualW = wrapper.getBoundingClientRect().width;
            if (!(layoutW > 0) || !(visualW > 0)) return scale;
            return scale * visualW / layoutW;
        }

        function beginTextResize(e, div, anno, pageNum, w, h) {
            const scale = textResizeScale(div);
            const rect = div.getBoundingClientRect();
            const startW = rect.width / scale;
            const startH = rect.height / scale;
            textResizeGesture = {
                anno: anno, div: div, pageNum: pageNum, w: w, h: h, scale: scale,
                startX: e.clientX, startY: e.clientY,
                startW: startW, startH: startH, width: startW, height: startH,
                minimum: textResizeMinimum(div),
                moved: false
            };
            state.resizingText = textResizeGesture;
            div.classList.remove('resize-hover');
            document.body.style.cursor = 'nwse-resize';
            document.addEventListener('mousemove', onTextResizeMove);
            document.addEventListener('mouseup', onTextResizeEnd);
        }

        function onTextResizeMove(e) {
            const g = textResizeGesture;
            if (!g) return;
            if (e.buttons !== 1) { finishTextResize(); return; }   // 松开事件丢失时兜底收尾
            const dx = (e.clientX - g.startX) / g.scale;
            const dy = (e.clientY - g.startY) / g.scale;
            if (!g.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;   // 抖动容差
            g.moved = true;
            e.preventDefault();
            // 下限既保证"看得见"（24/18 屏幕像素），也不会小于内边距，避免尺寸被浏览器撑回去
            g.width = Math.max(g.minimum.width, g.startW + dx);
            g.height = Math.max(g.minimum.height, g.startH + dy);
            g.div.style.minWidth = '';
            g.div.style.maxWidth = '';
            g.div.style.overflowWrap = '';
            g.div.style.width = g.width + 'px';
            g.div.style.height = g.height + 'px';
        }

        function onTextResizeEnd() { finishTextResize(); }

        function finishTextResize() {
            const g = textResizeGesture;
            if (!g) return;
            textResizeGesture = null;
            state.resizingText = null;
            document.removeEventListener('mousemove', onTextResizeMove);
            document.removeEventListener('mouseup', onTextResizeEnd);
            document.body.style.cursor = '';
            if (!g.moved) return;   // 角落里的普通点击：尺寸没变，不写数据
            // 缩到下限时指针会留在框内，松手产生的那次 click 不能再去开编辑弹窗。
            suppressTextClickUntil = performance.now() + 200;
            // 手势期间批注可能已被撤销/重做替换成新对象，此时放弃写入，别污染新状态。
            if (!state.annotations[g.pageNum]?.includes(g.anno)) return;
            const { anno, pageNum, w, h, width, height } = g;
            performAction(() => {
                anno.width = width / w;
                anno.height = height / h;
            }, [pageNum]);
        }

        function scaleAnnotationLayer(pageNum) {
            const wrapper = pageWrappers.get(Number(pageNum));
            const view = wrapper?._annotationView;
            if (!view) return;
            // 只在缩放手势进行中做"整体临时变换"。手势结束后 wrapper 尺寸还会被
            // drawPdfPage / layoutPdfWindow 改写，此时再挂上缩放矩阵就会留下一个
            // 和陈旧 view 配套的残留 transform：批注会按旧比例显示、点击热区错位，
            // 新画的图形也会因为落在被缩放的坐标系里而偏离鼠标。这种情况一律交给
            // renderAnnotations 按当前尺寸重建。
            if (!state.isZooming) {
                // 目标页尺寸/居中位置改变时，起点页上的箭头也需要重新定位。
                if (crossPageArrows.has(Number(pageNum))) renderAnnotations(pageNum);
                return;
            }
            view._pdZooming = true;
            const layer = wrapper.querySelector(`#annotation-layer-${pageNum}`);
            const sx = parseFloat(wrapper.style.width) / view.width;
            const sy = parseFloat(wrapper.style.height) / view.height;
            setPdfStyle(layer, 'transform', sx === 1 && sy === 1 ? '' : `scale(${sx}, ${sy})`);
            // 普通批注继续整体缩放；跨页箭头按当前页面布局换算回临时层坐标，
            // 使固定页间距在手势期间也保持 24px，而非等手势结束才跳回原位。
            for (const entry of view.entries.values()) {
                const anno = entry.anno;
                if (!isCrossPageArrow(anno, Number(pageNum))) continue;
                const signature = annotationRenderSignature(anno, Number(pageNum), view.width, view.height, state.scale);
                if (entry.signature === signature) continue;
                const fragment = document.createDocumentFragment();
                appendAnnotationNodes(anno, Number(pageNum), fragment, view.width, view.height, view.scale, state.scale);
                const nodes = [...fragment.childNodes];
                layer.insertBefore(fragment, entry.nodes.find(node => node.parentNode === layer) || null);
                for (const node of entry.nodes) node.remove();
                entry.nodes = nodes;
                entry.signature = annotationRenderSignature(anno, Number(pageNum), view.width, view.height, state.scale);
            }
        }

        function annotationRenderSignature(anno, pageNum, w, h, layoutScale) {
            // 异步图形的缓存元数据不改变文本内容，不能因此销毁已完成的 DOM。
            if (anno.type === 'text') {
                const { tikzBase64, tikzSource, imgH, ...content } = anno;
                return JSON.stringify(content);
            }
            return isArrowAnnotation(anno) ? JSON.stringify([anno, arrowGeometry(anno, pageNum, w, h, layoutScale)]) : JSON.stringify(anno);
        }

        // 页面的批注几何以「页面 wrapper 的 client rect」为唯一坐标轴：批注节点按当前
        // wrapper 尺寸绘制。批注层一旦还挂着上一次缩放的临时 transform，两者就不再是
        // 同一个坐标系——批注按旧比例显示、点击热区错位，落进来的新图形（拖拽预览、
        // 选择、图章）也会偏离鼠标。任何手势开始前都先用这里对齐一次。
        function ensureAnnotationLayer(pageNum) {
            const wrapper = pageWrappers.get(Number(pageNum));
            if (!wrapper) return null;
            const layer = wrapper.querySelector(`#annotation-layer-${pageNum}`);
            if (!layer) return null;
            const view = wrapper._annotationView;
            const w = parseFloat(wrapper.style.width), h = parseFloat(wrapper.style.height);
            if (view && view.entries.size && (view._pdZooming || view.width !== w || view.height !== h || view.scale !== state.scale)) {
                // 将批注层对齐当前尺寸，文本继续复用原排版；绘图坐标轴与 wrapper 一致。
                renderAnnotations(Number(pageNum), true);
            } else if (layer.style.transform) {
                // 空批注层（还没有任何节点）直接清掉残留矩阵即可，无需重建。
                setPdfStyle(layer, 'transform', '');
                if (view) view._pdZooming = false;
            }
            return layer;
        }

        function renderAnnotations(pageNum, force = false) {
            pageNum = Number(pageNum);
            const wrapper = pageWrappers.get(pageNum);
            if (!wrapper) return;
            const container = wrapper.querySelector(`#annotation-layer-${pageNum}`);
            const list = state.annotations[pageNum] || [];
            let view = wrapper._annotationView;
            if (state.isZooming && view && !force) { scaleAnnotationLayer(pageNum); return; }
            const w = parseFloat(wrapper.style.width), h = parseFloat(wrapper.style.height);
            if (!view) view = wrapper._annotationView = { entries: new Map() };
            if (view.width !== w || view.height !== h || view.scale !== state.scale || view._pdZooming) {
                // 缩放仅变换文本的现有排版；公式、已加载图片和进行中的图形都保留原节点。
                // 其它批注继续按当前页面尺寸绘制，保持绘图手势的坐标系不变。
                const retainedNodes = new Set();
                for (const [id, entry] of view.entries) {
                    const data = entry.anno.type === 'text' && textResizeDataMap.get(entry.nodes[0]);
                    if (data && Math.abs(data.w / data.scale - w / state.scale) < 0.01 &&
                        Math.abs(data.h / data.scale - h / state.scale) < 0.01) {
                        for (const node of entry.nodes) retainedNodes.add(node);
                    } else {
                        view.entries.delete(id);
                    }
                }
                for (const node of [...container.childNodes]) {
                    if (!retainedNodes.has(node)) {
                        if (node.matches?.('.text-annotation')) globalTextResizeObserver.unobserve(node);
                        node.remove();
                    }
                }
                Object.assign(view, { width: w, height: h, scale: state.scale, _pdZooming: false });
                container.style.setProperty('--annotation-page-width', w + 'px');
                container.style.setProperty('--annotation-page-height', h + 'px');
                container.style.transform = '';
            }
            const ids = new Set(list.map(anno => anno.id));
            const remove = entry => {
                for (const node of entry.nodes) {
                    if (node.matches?.('.text-annotation')) globalTextResizeObserver.unobserve(node);
                    node.remove();
                }
            };
            for (const [id, entry] of view.entries) if (!ids.has(id)) { remove(entry); view.entries.delete(id); }
            let cursor = container.firstChild;
            for (const anno of list) {
                let entry = view.entries.get(anno.id);
                const signature = annotationRenderSignature(anno, pageNum, w, h, state.scale);
                if (!entry || entry.anno !== anno || entry.signature !== signature || entry.nodes.some(node => node.parentNode !== container)) {
                    if (entry) { while (cursor && entry.nodes.includes(cursor)) cursor = cursor.nextSibling; remove(entry); }
                    const fragment = document.createDocumentFragment();
                    appendAnnotationNodes(anno, pageNum, fragment, w, h, state.scale);
                    const finalSignature = isArrowAnnotation(anno)
                        ? annotationRenderSignature(anno, pageNum, w, h, state.scale)
                        : signature;
                    entry = { anno, signature: finalSignature, nodes: [...fragment.childNodes] };
                    view.entries.set(anno.id, entry);
                }
                if (anno.type === 'text') {
                    const div = entry.nodes[0];
                    const data = textResizeDataMap.get(div);
                    const zoom = state.scale / data.scale;
                    setPdfStyle(div, 'left', (anno.x * w) + 'px');
                    setPdfStyle(div, 'top', (anno.y * h) + 'px');
                    setPdfStyle(div, 'transformOrigin', '0 0');
                    setPdfStyle(div, 'transform', zoom === 1 ? '' : `scale(${zoom})`);
                }
                for (const node of entry.nodes) {
                    if (node !== cursor) container.insertBefore(node, cursor);
                    cursor = node.nextSibling;
                }
            }
            if (list.length) annotationPages.add(pageNum); else annotationPages.delete(pageNum);
        }

        function appendAnnotationNodes(anno, pageNum, container, w, h, currentScale, layoutScale = currentScale) {
                const color = anno.color || '#fde047';
                const arrow = isArrowAnnotation(anno) ? arrowGeometry(anno, pageNum, w, h, layoutScale) : null;

                let isSidecarOnly = false;
                // 1. 文本块与标记
                if (anno.type === 'text' || MARKER_CONFIG[anno.type]) {
                    if (anno.x >= 0.98) isSidecarOnly = true;
                } 
                // 2. 矢量线条 (箭头、直线、括号、推出符号)
                else if (anno.start && anno.end) {
                    if (Math.min(anno.start.x, anno.end.x) >= 0.98) isSidecarOnly = true;
                } 
                // 3. 数组型批注 (高亮、下划线、括号)
                else if (anno.rects && anno.rects.length > 0) {
                    let minX = Infinity;
                    anno.rects.forEach(r => { if (r.x < minX) minX = r.x; });
                    if (minX >= 0.98) isSidecarOnly = true;
                }
                
                if (anno.type === 'text') {
                    const div = document.createElement('div');
                    div.className = `text-annotation compact-prose ${isSidecarOnly ? 'sidecar-only-anno' : ''}`;
                    div.dataset.id = anno.id; 
                    div.style.left = (anno.x * w) + 'px';
                    div.style.top = (anno.y * h) + 'px';
                    div.style.color = color;
                    
                    const tScale = anno.fontSizeScale || 1;
                    div.style.fontSize = `${8 * currentScale * tScale}px`;
                    div.style.padding = `${4 * currentScale}px ${8 * currentScale}px`;
                    div.style.borderRadius = `${6 * currentScale}px`;

                    applyTextAnnotationSize(div, anno, w, h);

                    textResizeDataMap.set(div, { anno, w, h, scale: currentScale, isFirstResize: true });
                    globalTextResizeObserver.observe(div);

                    const isPlaceholder = !anno.text || anno.text === '点击编辑文本';
                    if (isPlaceholder) {
                        div.textContent = '点击编辑文本';
                        div.style.color = '#9ca3af';
                        div.classList.add('text-placeholder');
                    } else {
                        div.textContent = anno.text;
                        div.style.color = color;
                        div.classList.remove('text-placeholder');
                    }

                    div.addEventListener('mousedown', (e) => {
                        if (e.button === 2) {
                            e.preventDefault();
                            e.stopPropagation();
                            return;
                        }
                        if (e.button !== 0) return; 
                        // 右下角：进入缩放手势（浏览器原生拖拉角已隐藏，这里完全自管）
                        if (isTextResizeCorner(div, e)) {
                            e.stopPropagation();
                            e.preventDefault();
                            beginTextResize(e, div, anno, pageNum, w, h);
                            return; 
                        }
                        const rect = div.getBoundingClientRect();
                        e.stopPropagation();
                        state.draggingText = {
                            isDragging: false,      
                            isPressed: true,        
                            id: anno.id,
                            pageNum: pageNum,
                            startX: e.clientX,      
                            startY: e.clientY,
                            offsetX: e.clientX - rect.left,
                            offsetY: e.clientY - rect.top,
                        };
                        draggingElement = div; 
                    });

                    // 只在右下角给出缩放指针提示，不显示任何图形
                    div.addEventListener('mousemove', (e) => {
                        div.classList.toggle('resize-hover', isTextResizeCorner(div, e));
                    });
                    div.addEventListener('mouseleave', () => div.classList.remove('resize-hover'));

                    div.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        moveNoteCursorFromPreview(div, anno.id, pageNum, e.clientX, e.clientY);
                    });

                    div.addEventListener('click', (e) => {
                        // 缩放收尾或右下角区域：都不算"点击编辑"
                        if (performance.now() < suppressTextClickUntil || isTextResizeCorner(div, e)) {
                            e.stopPropagation();
                            return; 
                        }
                        e.stopPropagation();
                        els.modalTitle.textContent = "编辑文本块";
                        const rawText = (anno.text === '点击编辑文本') ? '' : (anno.text || '');
                        openNoteModal({ ...anno, note: rawText }, pageNum, e.clientX, e.clientY, true);
                    });

                    container.appendChild(div);
                    renderLatex(div, anno, pageNum);
                    return; 
                }

                const hasNote = anno.note && anno.note.trim().length > 0;
                if (hasNote && anno.type !== 'text') { 
                    let ax, ay;
                    
                    if (MARKER_CONFIG[anno.type]) {
                        const markerSize = anno.size || MARKER_CONFIG[anno.type].defaultSize || 8;
                        const actualPixelSize = markerSize * currentScale;
                        ax = anno.x + (actualPixelSize / w); 
                        ay = anno.y + ((actualPixelSize / 2) / h);
                    }
                    else if (anno.type === 'free-parenthesis') {
                        // 锚点 = 右括号的中心：局部坐标 (localX, lineOffset*th + th/2) 经旋转平移换算回页面坐标
                        const th = anno.thickness * h;
                        const lx = anno.localX * w;
                        if (!(th > 0) || !(lx > 0)) {
                            ax = anno.end.x; ay = anno.end.y; // 兜底：旧数据缺字段时退回终点
                        } else {
                            const yOff = (anno.lineOffset || 0) * th;
                            const ang = Math.atan2(anno.end.y * h - anno.start.y * h, anno.end.x * w - anno.start.x * w);
                            const cosA = Math.cos(ang), sinA = Math.sin(ang);
                            const absX = anno.start.x * w + lx * cosA - (yOff + th / 2) * sinA;
                            const absY = anno.start.y * h + lx * sinA + (yOff + th / 2) * cosA;
                            ax = absX / w;
                            ay = absY / h;
                        }
                    }
                    else if (['arrow', 'brace', 'line', 'rect', 'implies', 'equivalence', 'highlight-block'].includes(anno.type)) { 
                        ax = arrow ? arrow.end.x / w : anno.end.x;
                        ay = arrow ? arrow.end.y / h : anno.end.y;
                    }
                    else if (anno.type === 'parenthesis') { 
                        const lastRect = anno.rects[anno.rects.length - 1]; 
                        ax = lastRect.x + lastRect.w; 
                        ay = lastRect.y + (lastRect.h / 2); 
                    }
                    else { 
                        if (anno.rects && anno.rects.length > 0) { 
                            const r = anno.rects[anno.rects.length - 1]; 
                            ax = r.x + r.w; 
                            ay = r.y + (r.h / 2); 
                        } 
                    }

                    if (ax !== undefined) {
                        if (!anno.bubbleOffset) anno.bubbleOffset = { x: 0, y: 0 };
                        
                        const cx = (ax + anno.bubbleOffset.x) * w;
                        const cy = (ay + anno.bubbleOffset.y) * h;
                        const absAx = ax * w;
                        const absAy = ay * h;

                        const indicator = document.createElement('div');
                        indicator.className = `absolute z-30 cursor-pointer pointer-events-auto group ${isSidecarOnly ? 'sidecar-only-anno' : ''}`;
                        indicator.style.width = "16px";
                        indicator.style.height = "16px";
                        indicator.style.left = `${cx}px`; 
                        indicator.style.top = `${cy}px`;
                        indicator.style.transform = `translate(-50%, -50%) scale(${currentScale * 0.7})`;
                        indicator.style.transformOrigin = "center center";

                        indicator.innerHTML = `
                            <svg class="absolute pointer-events-none transition-transform duration-100 group-hover:scale-110" style="top: -42px; left: -42px; width: 100px; height: 100px; overflow: visible; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.15)); transform-origin: 50px 50px;" viewBox="-50 -50 100 100">
                                <path class="bubble-tail" fill="white" stroke="#e5e7eb" stroke-width="1" d=""></path>
                                <circle cx="0" cy="0" r="6" fill="white" stroke="#e5e7eb" stroke-width="1"></circle>
                                <circle cx="0" cy="0" r="5" fill="#3b82f6"></circle>
                                <line x1="-2" y1="-1.5" x2="2" y2="-1.5" stroke="white" stroke-width="1" stroke-linecap="round"></line>
                                <line x1="-2" y1="1.5" x2="0" y2="1.5" stroke="white" stroke-width="1" stroke-linecap="round"></line>
                            </svg>
                        `;
                        
                        const tailPath = indicator.querySelector('.bubble-tail');
                        updateBubbleTail(tailPath, cx, cy, absAx, absAy, currentScale);

                        indicator.addEventListener('mousedown', (e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation(); e.preventDefault();
                            state.draggingBubble = {
                                isPressed: true, isDragging: false,
                                anno: anno, pageNum: pageNum,
                                startX: e.clientX, startY: e.clientY,
                                baseRx: anno.bubbleOffset.x,
                                baseRy: anno.bubbleOffset.y,
                                ax: ax, ay: ay,
                                el: indicator, tail: tailPath,
                                wrapperW: w, wrapperH: h
                            };
                        });

                        indicator.addEventListener('click', (e) => { 
                            if (state.draggingBubble && state.draggingBubble.isDragging) return;
                            e.stopPropagation(); 
                            els.modalTitle.textContent = "笔记"; 
                            openNoteModal(anno, parseInt(pageNum), e.clientX, e.clientY); 
                        });
                        
                        container.appendChild(indicator);
                    }
                }

                if (MARKER_CONFIG[anno.type]) {
                    const div = document.createElement('div');
                    div.className = `absolute cursor-pointer group pointer-events-auto select-none ${isSidecarOnly ? 'sidecar-only-anno' : ''}`;
                    const markerSize = anno.size || MARKER_CONFIG[anno.type].defaultSize || 8; 

                    div.style.left = (anno.x * w) + 'px';
                    div.style.top = (anno.y * h) + 'px';
                    div.style.width = `${markerSize * currentScale}px`;
                    div.style.height = `${markerSize * currentScale}px`;
                    div.style.color = anno.color || MARKER_CONFIG[anno.type].color; 
                    div.style.zIndex = '35';

                    div.innerHTML = getMarkerSvg(anno.type, "drop-shadow-sm group-hover:scale-110 transition-transform w-full h-full transform-origin-center");

                    div.addEventListener('mousedown', (e) => {
                        if (e.button !== 0) return; 
                        e.stopPropagation(); e.preventDefault(); 
                        const rect = div.getBoundingClientRect();
                        state.draggingText = {
                            isDragging: false, isPressed: true, id: anno.id, pageNum: pageNum,
                            startX: e.clientX, startY: e.clientY, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
                        };
                        draggingElement = div; 
                    });

                    div.addEventListener('click', (e) => {
                        e.stopPropagation(); els.modalTitle.textContent = "标记"; openNoteModal(anno, pageNum, e.clientX, e.clientY); 
                    });

                    container.appendChild(div);
                    return; 
                }

                if (['arrow', 'parenthesis', 'brace', 'line', 'rect', 'implies', 'equivalence', 'highlight-block', 'free-parenthesis'].includes(anno.type)) {
                    const svgNS = "http://www.w3.org/2000/svg";
                    const svg = document.createElementNS(svgNS, "svg");
                    svg.setAttribute("class", `vector-svg ${isSidecarOnly ? 'sidecar-only-anno' : ''}`);
                    svg.style.zIndex = 20;

                    const strokeWidth = 1.2 * currentScale;

                    if (anno.type === 'arrow') {
                        const { x: x1, y: y1 } = arrow.start;
                        const { x: x2, y: y2 } = arrow.end;
                        const angle = Math.atan2(y2 - y1, x2 - x1); 
                        const headLen = 6 * currentScale; 
                        const arrowBaseOffset = headLen * Math.cos(Math.PI / 6);
                        const dist = Math.hypot(x2 - x1, y2 - y1);
                        let lineEndX = x2, lineEndY = y2;
                        
                        if (dist > arrowBaseOffset) {
                            lineEndX = x2 - arrowBaseOffset * Math.cos(angle);
                            lineEndY = y2 - arrowBaseOffset * Math.sin(angle);
                        }

                        const line = document.createElementNS(svgNS, "line");
                        line.setAttribute("x1", x1); line.setAttribute("y1", y1); 
                        line.setAttribute("x2", lineEndX); line.setAttribute("y2", lineEndY); 
                        line.setAttribute("stroke", color); 
                        line.setAttribute("stroke-width", strokeWidth);
                        line.setAttribute("class", "vector-path");
                        line.setAttribute("opacity", "0.7"); 
                        
                        const hx1 = x2 - headLen * Math.cos(angle - Math.PI / 6); 
                        const hy1 = y2 - headLen * Math.sin(angle - Math.PI / 6);
                        const hx2 = x2 - headLen * Math.cos(angle + Math.PI / 6); 
                        const hy2 = y2 - headLen * Math.sin(angle + Math.PI / 6);
                        
                        const head = document.createElementNS(svgNS, "polygon");
                        head.setAttribute("points", `${x2},${y2} ${hx1},${hy1} ${hx2},${hy2}`);
                        head.setAttribute("class", "arrow-head"); 
                        head.setAttribute("fill", color); 
                        head.setAttribute("opacity", "0.7"); 
                        
                        line.addEventListener('click', (e) => { e.stopPropagation(); els.modalTitle.textContent = "箭头"; openNoteModal(anno, pageNum, e.clientX, e.clientY); });
                        svg.appendChild(line); svg.appendChild(head);

                    }
                    else if (anno.type === 'highlight-block') {
                        const rect = document.createElementNS(svgNS, "rect");
                        const x1 = anno.start.x * w;
                        const y1 = anno.start.y * h;
                        const x2 = anno.end.x * w;
                        const y2 = anno.end.y * h;
                        
                        const dx = x2 - x1;
                        const dy = y2 - y1;
                        const length = Math.hypot(dx, dy);
                        // 弧度转角度
                        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
                        const thickness = anno.thickness * w;

                        rect.setAttribute("x", "0"); 
                        rect.setAttribute("y", -thickness / 2); 
                        rect.setAttribute("width", length); 
                        rect.setAttribute("height", thickness); 
                        rect.setAttribute("rx", 4 * currentScale); 
                        
                        // 运用几何平移与旋转矩阵
                        rect.setAttribute("transform", `translate(${x1}, ${y1}) rotate(${angle})`);
                        
                        rect.setAttribute("fill", color); 
                        rect.setAttribute("stroke", "none"); 
                        rect.setAttribute("opacity", "0.45");
                        rect.style.mixBlendMode = "multiply"; 
                        
                        rect.setAttribute("class", `cursor-pointer group ${isSidecarOnly ? 'sidecar-only-anno' : ''}`);
                        rect.style.pointerEvents = "all"; 
                        
                        // 绑定点击弹窗事件
                        rect.addEventListener('click', (e) => { 
                            e.stopPropagation(); 
                            els.modalTitle.textContent = "自由高亮块"; 
                            openNoteModal(anno, pageNum, e.clientX, e.clientY); 
                        });
                        svg.appendChild(rect);
                    } else if (anno.type === 'free-parenthesis') {
                        const g = document.createElementNS(svgNS, "g");
                        const startX = anno.start.x * w;
                        const startY = anno.start.y * h;
                        const endX = anno.end.x * w;
                        const endY = anno.end.y * h;
                        
                        const angle = Math.atan2(endY - startY, endX - startX) * (180 / Math.PI);
                        const thickness = anno.thickness * h;
                        const localX = anno.localX * w;
                        const yOffset = anno.lineOffset * thickness;

                        g.setAttribute("transform", `translate(${startX}, ${startY}) rotate(${angle})`);
                        g.setAttribute("class", `cursor-pointer group ${isSidecarOnly ? 'sidecar-only-anno' : ''}`);
                        
                        const leftPath = document.createElementNS(svgNS, "path");
                        leftPath.setAttribute("d", `M 6 0 Q -4 ${thickness/2} 6 ${thickness}`);
                        leftPath.setAttribute("fill", "none");
                        leftPath.setAttribute("stroke", color);
                        leftPath.setAttribute("stroke-width", strokeWidth);

                        const rightPath = document.createElementNS(svgNS, "path");
                        rightPath.setAttribute("d", `M ${localX - 6} ${yOffset} Q ${localX + 4} ${yOffset + thickness/2} ${localX - 6} ${yOffset + thickness}`);
                        rightPath.setAttribute("fill", "none");
                        rightPath.setAttribute("stroke", color);
                        rightPath.setAttribute("stroke-width", strokeWidth);
                        
                        // 增加一个透明底板，方便用户点击中间的空白区域唤出弹窗
                        const hitBox = document.createElementNS(svgNS, "rect");
                        const minX = Math.min(0, localX);
                        const maxX = Math.max(0, localX);
                        const minY = Math.min(0, yOffset);
                        const maxY = Math.max(thickness, yOffset + thickness);
                        hitBox.setAttribute("x", minX);
                        hitBox.setAttribute("y", minY);
                        hitBox.setAttribute("width", Math.max(12, maxX - minX));
                        hitBox.setAttribute("height", Math.max(thickness, maxY - minY));
                        hitBox.setAttribute("fill", "transparent");
                        hitBox.style.pointerEvents = "all";

                        g.appendChild(hitBox);
                        g.appendChild(leftPath);
                        g.appendChild(rightPath);

                        g.addEventListener('click', (e) => { 
                            e.stopPropagation(); 
                            els.modalTitle.textContent = "自由括号"; 
                            openNoteModal(anno, pageNum, e.clientX, e.clientY); 
                        });
                        svg.appendChild(g);
                    }
                    else if (anno.type === 'parenthesis') {
                        if (anno.rects.length === 0) return;
                        const firstRect = anno.rects[0]; const lastRect = anno.rects[anno.rects.length - 1];
                        const curve = 2 * currentScale; const padding = 4 * currentScale;
                        const lX = firstRect.x * w - padding; const lY = firstRect.y * h; const lH = firstRect.h * h;
                        const leftPath = document.createElementNS(svgNS, "path");
                        const dLeft = `M ${lX + curve} ${lY} Q ${lX - curve} ${lY + lH/2} ${lX + curve} ${lY + lH}`;
                        leftPath.setAttribute("d", dLeft); leftPath.setAttribute("stroke", color); leftPath.setAttribute("fill", "none"); 
                        leftPath.setAttribute("stroke-width", strokeWidth);
                        leftPath.setAttribute("class", "vector-path");
                        
                        const rX = (lastRect.x + lastRect.w) * w + padding; const rY = lastRect.y * h; const rH = lastRect.h * h;
                        const rightPath = document.createElementNS(svgNS, "path");
                        const dRight = `M ${rX - curve} ${rY} Q ${rX + curve} ${rY + rH/2} ${rX - curve} ${rY + rH}`;
                        rightPath.setAttribute("d", dRight); rightPath.setAttribute("stroke", color); rightPath.setAttribute("fill", "none"); 
                        rightPath.setAttribute("stroke-width", strokeWidth);
                        rightPath.setAttribute("class", "vector-path");

                        leftPath.addEventListener('click', (e) => { e.stopPropagation(); els.modalTitle.textContent = "括号"; openNoteModal(anno, pageNum, e.clientX, e.clientY); });
                        rightPath.addEventListener('click', (e) => { e.stopPropagation(); els.modalTitle.textContent = "括号"; openNoteModal(anno, pageNum, e.clientX, e.clientY); });
                        svg.appendChild(leftPath); svg.appendChild(rightPath);
                    } else if (anno.type === 'brace') {
                        const x1 = anno.start.x * w, y1 = anno.start.y * h;
                        const x2 = anno.end.x * w, y2 = anno.end.y * h;
                        const path = document.createElementNS(svgNS, "path");
                        path.setAttribute("d", getBracePath(x1, y1, x2, y2));
                        path.setAttribute("stroke", color); 
                        path.setAttribute("fill", "none"); 
                        path.setAttribute("stroke-width", strokeWidth);
                        path.setAttribute("class", "vector-path");
                        
                        path.addEventListener('click', (e) => { e.stopPropagation(); els.modalTitle.textContent = "大括号"; openNoteModal(anno, pageNum, e.clientX, e.clientY); });
                        svg.appendChild(path);
                    } else if (anno.type === 'line') {
                        const line = document.createElementNS(svgNS, "line");
                        line.setAttribute("x1", anno.start.x * w); line.setAttribute("y1", anno.start.y * h); 
                        line.setAttribute("x2", anno.end.x * w); line.setAttribute("y2", anno.end.y * h); 
                        line.setAttribute("stroke", color); 
                        line.setAttribute("stroke-width", strokeWidth);
                        line.setAttribute("class", "vector-path");
                        
                        line.addEventListener('click', (e) => { e.stopPropagation(); els.modalTitle.textContent = "直线"; openNoteModal(anno, pageNum, e.clientX, e.clientY); });
                        svg.appendChild(line);
                    } else if (anno.type === 'rect') {
                        const x1 = anno.start.x * w, y1 = anno.start.y * h;
                        const x2 = anno.end.x * w, y2 = anno.end.y * h;
                        const minX = Math.min(x1, x2), minY = Math.min(y1, y2);
                        const rw = Math.abs(x1 - x2), rh = Math.abs(y1 - y2);

                        const rect = document.createElementNS(svgNS, "rect");
                        rect.setAttribute("x", minX); rect.setAttribute("y", minY);
                        rect.setAttribute("width", rw); rect.setAttribute("height", rh);
                        rect.setAttribute("stroke", color);
                        rect.setAttribute("fill", "none");
                        rect.setAttribute("stroke-width", strokeWidth);
                        rect.setAttribute("class", "vector-path");
                        rect.setAttribute("rx", 4 * currentScale);

                        rect.addEventListener('click', (e) => { e.stopPropagation(); els.modalTitle.textContent = "矩形框"; openNoteModal(anno, pageNum, e.clientX, e.clientY); });
                        svg.appendChild(rect);
                    } else if (['implies', 'equivalence'].includes(anno.type)) {
                        const { x: x1, y: y1 } = arrow.start;
                        const { x: x2, y: y2 } = arrow.end;
                        
                        const path = document.createElementNS(svgNS, "path");
                        path.setAttribute("d", getImpliesPath(x1, y1, x2, y2, currentScale, anno.type === 'equivalence'));
                        path.setAttribute("stroke", color); 
                        path.setAttribute("fill", "none"); 
                        path.setAttribute("stroke-width", strokeWidth);
                        path.setAttribute("class", "vector-path");
                        
                        path.addEventListener('click', (e) => { e.stopPropagation(); els.modalTitle.textContent = anno.type === "equivalence" ? "等价箭头" : "推出箭头"; openNoteModal(anno, pageNum, e.clientX, e.clientY); });
                        svg.appendChild(path);
                    }
                    container.appendChild(svg);

                } else {
                    anno.rects.forEach(r => {
                        const el = document.createElement('div');
                        el.className = (anno.type === 'highlight' ? 'highlight-rect' : 'underline-rect') + (isSidecarOnly ? ' sidecar-only-anno' : '');
                        el.style.left = (r.x * w) + 'px'; el.style.top = (r.y * h) + 'px';
                        el.style.width = (r.w * w) + 'px'; el.style.height = (r.h * h) + 'px';
                        if (anno.type === 'highlight') el.style.backgroundColor = color;
                        else if (anno.type === 'underline') {
                            el.style.borderBottomColor = color;
                            el.style.borderBottomWidth = `${2 * currentScale}px`; 
                        }
                        el.addEventListener('click', (e) => { e.stopPropagation(); el.scrollIntoView({behavior: "smooth", block: "center"}); els.modalTitle.textContent = "批注"; openNoteModal(anno, pageNum, e.clientX, e.clientY); });
                        container.appendChild(el);
                    });
                }
        }

        els.fullscreenBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(err => console.error(err));
            else if (document.exitFullscreen) document.exitFullscreen();
        });
        // Esc 下方的反引号/波浪号物理键进入全屏，Esc 仍交给浏览器退出。
        window.addEventListener('keydown', e => {
            if (e.code !== 'Backquote' || e.repeat || e.defaultPrevented || e.isComposing ||
                e.ctrlKey || e.metaKey || e.altKey || document.fullscreenElement) return;
            if (e.target && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName))) return;
            e.preventDefault();
            document.documentElement.requestFullscreen().catch(err => console.error(err));
        });

