        // forceRebuild = true 用于「换文档」：必须整棵 DOM 重建。
        // 复用分支只适用于同一份文档内部（缩放路径）：它只改尺寸、清文本/链接层，
        // 既不清 canvas 位图也不重新 observe —— 页数恰好相同时，原本就在视口内的页面
        // 不会跨越 IntersectionObserver 阈值、拿不到新回调，于是新文档永远不渲染，
        // 屏幕上是上一本书拉伸后的图像，文本层却是空的。
        function generatePageSkeletons(forceRebuild = false) {
            const existingWrappers = els.pagesContainer.children;
            
            if (!forceRebuild && existingWrappers.length === state.pdfDoc.numPages) {
                for (let i = 1; i <= state.pdfDoc.numPages; i++) {
                    const wrapper = document.getElementById(`page-wrapper-${i}`);
                    if (!wrapper) continue;
                    
                    const dim = state.pageDimensions[i - 1]; // 数组从 0 开始，页码从 1 开始
                    const width = dim.width * state.scale;
                    const height = dim.height * state.scale;
                    
                    wrapper.style.width = width + "px";
                    wrapper.style.height = height + "px";
                    
                    const canvas = document.getElementById(`canvas-${i}`);
                    if (canvas) { canvas.style.width = width + "px"; canvas.style.height = height + "px"; }
                    
                    const textLayer = document.getElementById(`text-layer-${i}`);
                    if (textLayer) { textLayer.style.width = width + "px"; textLayer.style.height = height + "px"; textLayer.style.setProperty('--scale-factor', state.scale); textLayer.innerHTML = ''; }
                    
                    const linkLayer = document.getElementById(`link-layer-${i}`);
                    if (linkLayer) { linkLayer.style.width = width + "px"; linkLayer.style.height = height + "px"; linkLayer.innerHTML = ''; }
                }
                return;
            }

            els.pagesContainer.innerHTML = '';
            for (let i = 1; i <= state.pdfDoc.numPages; i++) {
                
                const dim = state.pageDimensions[i - 1];
                const width = dim.width * state.scale;
                const height = dim.height * state.scale;

                const wrapper = document.createElement('div');
                wrapper.className = 'page-wrapper';
                wrapper.dataset.pageNum = i;
                wrapper.id = `page-wrapper-${i}`;
                
                wrapper.style.width = width + "px";
                wrapper.style.height = height + "px";

                wrapper.innerHTML = `
                    <div id="sidecar-bg-${i}" class="sidecar-bg">
                        <div class="absolute inset-0 pointer-events-none" style="background-image: linear-gradient(rgba(0,0,0,0.06) 1px, transparent 1px); background-size: 100% 32px;"></div>
                    </div>
                    <canvas id="canvas-${i}" class="block" width="${width}" height="${height}" style="width:${width}px;height:${height}px"></canvas>
                    <div id="text-layer-${i}" class="textLayer" style="width:${width}px;height:${height}px;--scale-factor:${state.scale}"></div>
                    <div id="link-layer-${i}" class="link-layer" style="width:${width}px;height:${height}px"></div>
                    <div id="annotation-layer-${i}" class="annotation-layer"></div>
                `;
                els.pagesContainer.appendChild(wrapper);
                observer.observe(wrapper);
            }
        }

        const renderTimers = {};
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const pageNum = parseInt(entry.target.dataset.pageNum);
                if (entry.isIntersecting) {
                    const delay = state.isZooming ? 0 : 150;
                    renderTimers[pageNum] = setTimeout(() => {
                        renderPageHighQuality(pageNum);
                    }, delay);
                } else {
                    // 页面滑出视口时，取消渲染任务
                    clearTimeout(renderTimers[pageNum]);
                    
                    // 🛡️ 方案一【缩放护盾】：如果当前正处于全局缩放的 300ms 保护期，绝对禁止砸碎旧画布！
                    // 让旧画布配合 CSS 继续拉伸顶住场面，彻底消灭闪烁！
                    if (state.isZooming) return;
                    
                    if (state.pagesRendered.has(pageNum)) {
                        const canvas = document.getElementById(`canvas-${pageNum}`);
                        if (canvas) {
                            canvas.width = 0;  // 这一步能彻底释放 GPU 图像内存
                            canvas.height = 0;
                        }
                        const textLayer = document.getElementById(`text-layer-${pageNum}`);
                        if (textLayer) textLayer.innerHTML = ''; 
                        const annoLayer = document.getElementById(`annotation-layer-${pageNum}`);
                        if (annoLayer) annoLayer.innerHTML = '';
                        state.pagesRendered.delete(pageNum); 
                    }
                }
            });
        }, { root: els.container, rootMargin: '1200px', threshold: 0.01 });
        // 这样既能提前渲染保证滑动不白屏，又能及时回收远处的页面。

        let zoomRenderTimer = null;

        async function renderPageHighQuality(pageNum, forceRender = false) {
            if (!forceRender && state.pagesRendered.has(pageNum)) return;
            state.pagesRendered.add(pageNum);

            const page = await state.pdfDoc.getPage(pageNum);
            const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
            const canvas = document.getElementById(`canvas-${pageNum}`);
            const ctx = canvas.getContext('2d');
            
            const viewport = page.getViewport({scale: state.scale});
            
            // 当真正渲染到某页时，如果发现其真实尺寸与当初的“同构假设”尺寸不符，瞬间为其重塑骨架！
            const assumedDim = state.pageDimensions[pageNum - 1];
            const actualBaseWidth = viewport.width / state.scale;
            const actualBaseHeight = viewport.height / state.scale;

            if (Math.abs(assumedDim.width - actualBaseWidth) > 1 || Math.abs(assumedDim.height - actualBaseHeight) > 1) {
                // 记录真实的异形尺寸
                state.pageDimensions[pageNum - 1] = { width: actualBaseWidth, height: actualBaseHeight };
                // 物理修正父容器
                wrapper.style.width = viewport.width + "px";
                wrapper.style.height = viewport.height + "px";
                // 修正兄弟容器：侧翼草稿纸、文本层和链接层
                const txtL = document.getElementById(`text-layer-${pageNum}`);
                const lnkL = document.getElementById(`link-layer-${pageNum}`);
                if(txtL) { txtL.style.width = viewport.width + "px"; txtL.style.height = viewport.height + "px"; }
                if(lnkL) { lnkL.style.width = viewport.width + "px"; lnkL.style.height = viewport.height + "px"; }
            }

            const outputScale = Math.max(window.devicePixelRatio || 1, 2);

            canvas.width = Math.floor(viewport.width * outputScale);
            canvas.height = Math.floor(viewport.height * outputScale);
            
            canvas.style.width = viewport.width + "px";
            canvas.style.height = viewport.height + "px";
            wrapper.style.width = viewport.width + "px";
            wrapper.style.height = viewport.height + "px";

            if (state.renderTasks[pageNum]) {
                state.renderTasks[pageNum].cancel();
            }

            const renderContext = {
                canvasContext: ctx,
                transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
                viewport
            };
            
            const renderTask = page.render(renderContext);
            state.renderTasks[pageNum] = renderTask;

            try {
                await renderTask.promise;
                delete state.renderTasks[pageNum]; 
            } catch (error) {
                if (error.name === 'RenderingCancelledException') return;
                console.error(error);
            }

            // 🛡️ 缩放护盾 2.0：渲染期间 state.scale 若已变化（用户触发了缩放），
            // 本帧渲染已过期，直接放弃，交给新一轮渲染接管，避免文本层与画布错位
            if (state.scale !== viewport.scale) return;

            const textLayerDiv = document.getElementById(`text-layer-${pageNum}`);
            textLayerDiv.style.width = canvas.style.width;
            textLayerDiv.style.height = canvas.style.height;
            // ⚠️ 关键修复：--scale-factor 必须与传给 renderTextLayer 的 viewport.scale 完全一致。
            // 之前写成 state.scale，一旦 await 期间发生缩放，两者就会错位，
            // pdf.js 会持续报 "The `--scale-factor` CSS-variable must be set..." 错误。
            // 这里同时在文本层自身和页面容器上设置，双保险。
            textLayerDiv.style.setProperty('--scale-factor', viewport.scale);
            wrapper.style.setProperty('--scale-factor', viewport.scale);

            page.getTextContent().then(textContent => {
                // 双保险：getTextContent 也是异步的，期间若发生了缩放，
                // 文本层已交给新一帧渲染，这里直接放弃，防止新旧 scale 混用
                if (state.scale !== viewport.scale) return;
                textLayerDiv.replaceChildren();
                pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayerDiv, viewport, textDivs: [] });
            });

            renderNativeLinks(page, pageNum);

            renderAnnotations(pageNum);
        }

        async function renderNativeLinks(page, pageNum) {
            const div = document.getElementById(`link-layer-${pageNum}`);
            if (!div) return;
            div.innerHTML = '';
            
            const annotations = await page.getAnnotations();
            const viewport = page.getViewport({ scale: state.scale });

            annotations.forEach(anno => {
                if (anno.subtype === 'Link') {
                    const { url, dest, rect } = anno;
                    const element = document.createElement('a');
                    
                    // rect 是 PDF 坐标 [x1, y1, x2, y2]，需转换为 Viewport 坐标
                    const viewRect = viewport.convertToViewportRectangle(rect);
                    // 标准化坐标 (left, top, width, height)
                    const minX = Math.min(viewRect[0], viewRect[2]);
                    const minY = Math.min(viewRect[1], viewRect[3]);
                    const width = Math.abs(viewRect[0] - viewRect[2]);
                    const height = Math.abs(viewRect[1] - viewRect[3]);

                    element.style.left = `${minX}px`;
                    element.style.top = `${minY}px`;
                    element.style.width = `${width}px`;
                    element.style.height = `${height}px`;
                    
                    if (url) {
                        element.href = url;
                        element.target = '_blank';
                        element.title = `打开链接: ${url}`;
                    } else if (dest) {
                        element.href = '#';
                        element.title = `跳转到内部页面`;
                        element.onclick = (e) => {
                            e.preventDefault();
                            navigateToDestination(dest);
                        };
                    }
                    div.appendChild(element);
                }
            });
        }

        async function navigateToDestination(dest) {
            let explicitDest = dest;
            if (typeof dest === 'string') {
                // 如果是命名目标（如 "chapter.1"），需要解析
                explicitDest = await state.pdfDoc.getDestination(dest);
            }
            if (!explicitDest) return;
            
            const pageRef = explicitDest[0];
            const pageIndex = await state.pdfDoc.getPageIndex(pageRef); // 获取 0-based 页码
            const pageNum = pageIndex + 1;
            
            const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
            recordJumpPosition();
            if (wrapper) {
                // 如果页面已存在 DOM 中，直接滚动
                wrapper.scrollIntoView({ behavior: 'auto', block: 'start' });
            } else {
                // 如果页面很远未加载（虽不常见，因为我们生成了 Skeleton），确保渲染
                // 这里的逻辑通常是滚动到 Skeleton 位置，Observer 会自动触发渲染
                const skeleton = document.getElementById(`page-wrapper-${pageNum}`);
                if (skeleton) skeleton.scrollIntoView({ behavior: 'auto', block: 'start' });
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

        if (typeof MARKER_CONFIG !== 'undefined') {
            MARKER_CONFIG['triangle'] = {
                label: '红三角', color: '#ef4444', defaultSize: 6,
                viewBox: '0 0 24 24', fill: 'currentColor', stroke: 'none', strokeWidth: 0,
                inner: '<polygon points="12,2 22,20 2,20" />'
            };
            MARKER_CONFIG['exText'] = {
                label: 'ex文本', color: '#ef4444', defaultSize: 12,
                viewBox: '0 0 24 24', fill: 'currentColor', stroke: 'none', strokeWidth: 0,
                inner: '<text x="12" y="17" font-size="15" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="900" text-anchor="middle">ex</text>'
            };
        }

        function getMarkerSvg(type, customClass) {
            const m = MARKER_CONFIG[type];
            if (!m) return '';
            return `<svg viewBox="${m.viewBox}" class="${customClass}" fill="${m.fill}" stroke="${m.stroke}" stroke-width="${m.strokeWidth}">${m.inner}</svg>`;
        }
        async function renderTikzToImg(tikzCode, containerNode, anno, pageNum) {
            if (!containerNode) return;
            try {
                let finalCode = tikzCode.trim();
                
                // 🛑 拆除防火墙，改为“智能中文嗅探”
                const codeWithoutComments = finalCode.replace(/(^|[^\\])%.*/g, '$1');
                const hasChinese = /[\u4e00-\u9fa5]/.test(codeWithoutComments);

                // 🌟 动态拼装终极 LaTeX 文件头
                if (!finalCode.includes('\\documentclass')) {
                    const packagesStr = LATEX_CONFIG.packages.join('\n');
                    const tikzLibsStr = LATEX_CONFIG.tikzLibraries.length > 0 
                        ? `\\usetikzlibrary{${LATEX_CONFIG.tikzLibraries.join(',')}}` 
                        : '';
                    const pgfLibsStr = LATEX_CONFIG.pgfplotsLibraries.length > 0 
                        ? `\\usepgfplotslibrary{${LATEX_CONFIG.pgfplotsLibraries.join(',')}}` 
                        : '';
                    
                    // 🌟 核心：如果嗅探到中文，自动挂载 ctex 宏包！
                    const ctexPackage = hasChinese ? '\\usepackage[UTF8]{ctex}\n' : '';

                    finalCode = `\\documentclass[border=4pt, tikz]{standalone}\n${ctexPackage}${packagesStr}\n${tikzLibsStr}\n${pgfLibsStr}\n\\begin{document}\n${finalCode}\n\\end{document}`;
                }

                // 发送给本地 Python 代理引擎
                const response = await fetch('/api/render-tikz', {
                    method: 'POST',
                    body: finalCode
                });

                if (!response.ok) throw new Error("编译失败");

                const base64 = await response.text();
                const imgSrc = `data:image/svg+xml;base64,${base64}`;

                if (anno) anno.tikzBase64 = imgSrc; 

                const img = document.createElement('img');
                img.src = imgSrc;
                img.style.pointerEvents = 'none'; 
                
                img.onload = () => {
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
                console.error('Local TikZ Render Error:', e);
                containerNode.innerHTML = '<span class="text-red-500 text-xs font-bold">[ 图形渲染失败，请检查 LaTeX 语法或本地引擎日志 ]</span>';
            }
        }

        function renderLatex(element, anno = null, pageNum = null) {
            const envs = LATEX_CONFIG.environments.join('|');
            const tikzRegex = new RegExp("\\\\begin\\{(" + envs + ")\\}[\\s\\S]*?\\\\end\\{\\1\\}", 'g');
            
            if (tikzRegex.test(element.innerHTML)) {
                element.innerHTML = element.innerHTML.replace(tikzRegex, (match) => {
                    if (anno && anno.tikzBase64) {
                        const h = anno.imgH ? (anno.imgH / 8) + 'em' : 'auto';
                        // 🌟 压平为一行，彻底消灭渲染图片时的换行空白！
                        return `<div class="ignored-by-katex" style="margin: 8px 0;"><img src="${anno.tikzBase64}" style="height: ${h}; width: auto; max-width: none; display: block; margin: 0 auto; pointer-events: none;"></div>`;
                    }

                    const cleanTikz = match.replace(/<br\s*\/?>/gi, '\n')
                                           .replace(/&lt;/g, '<')
                                           .replace(/&gt;/g, '>')
                                           .replace(/&amp;/g, '&')
                                           .replace(/&nbsp;/g, ' ');
                    
                    const id = 'tikz-' + Math.random().toString(36).substr(2, 9);
                    
                    setTimeout(() => {
                        const targetBox = element.querySelector('#' + id);
                        renderTikzToImg(cleanTikz, targetBox, anno, pageNum);
                    }, 20);

                    // 🌟 占位提示符同样压平为一行
                    return `<div id="${id}" class="ignored-by-katex" style="margin: 8px 0; text-align: center; min-height: 40px; display: flex; justify-content: center; align-items: center; background: rgba(0,0,0,0.02); border-radius: 4px; border: 1px dashed #cbd5e1;"><span class="animate-pulse text-blue-500 text-xs font-bold">[ 渲染图形中... ]</span></div>`;
                });
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

       function renderAnnotations(pageNum) {
            const list = state.annotations[pageNum] || [];
            const container = document.getElementById(`annotation-layer-${pageNum}`);
            if (!container) return;
            
            // 提早拦截：如果该页没有批注，直接清空并跳过，最大化性能
            if (list.length === 0) {
                container.innerHTML = '';
                return;
            }
            
            container.innerHTML = ''; 
            const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
            if (!wrapper) return;
            
            const w = parseFloat(wrapper.style.width);
            const h = parseFloat(wrapper.style.height);
            const currentScale = state.scale;

            list.forEach(anno => {
                const color = anno.color || '#fde047';

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

                    if (anno.width) div.style.width = (anno.width * w) + 'px';
                    if (anno.height) div.style.height = (anno.height * h) + 'px';

                    textResizeDataMap.set(div, { anno, w, h, isFirstResize: true });
                    globalTextResizeObserver.observe(div);

                    div.textContent = anno.text || '点击编辑';

                    div.addEventListener('mousedown', (e) => {
                        if (e.button !== 0) return; 
                        const rect = div.getBoundingClientRect();
                        if (e.clientX > rect.right - 16 && e.clientY > rect.bottom - 16) {
                            e.stopPropagation();
                            return; 
                        }
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

                    div.addEventListener('click', (e) => {
                        const rect = div.getBoundingClientRect();
                        if (e.clientX > rect.right - 16 && e.clientY > rect.bottom - 16) {
                            e.stopPropagation();
                            return; 
                        }
                        e.stopPropagation();
                        els.modalTitle.textContent = "编辑文本块";
                        openNoteModal({ ...anno, note: anno.text }, pageNum, e.clientX, e.clientY, true);
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
                        ax = anno.end.x; 
                        ay = anno.end.y; 
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
                        const x1 = anno.start.x * w, y1 = anno.start.y * h;
                        const x2 = anno.end.x * w, y2 = anno.end.y * h;
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
                        hitBox.setAttribute("x", "0"); hitBox.setAttribute("y", "0");
                        hitBox.setAttribute("width", localX); hitBox.setAttribute("height", Math.max(thickness, yOffset + thickness));
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
                        const x1 = anno.start.x * w, y1 = anno.start.y * h;
                        const x2 = anno.end.x * w, y2 = anno.end.y * h;
                        
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
            });
        }

        els.fullscreenBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(err => console.error(err));
            else if (document.exitFullscreen) document.exitFullscreen();
        });

