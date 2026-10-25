// 原始页高索引：缩放只更新已挂载的页面，异形页尺寸按点修正。
const PDF_PAGE_GAP = 24;
const PDF_CACHE_BYTES = 128 * 1024 * 1024;
const PDF_CACHE_PAGES = 12;
const pageWrappers = new Map();
const cachedPdfPages = new Map();
let cachedPdfBytes = 0;
let pdfHeightIndex = new Float64Array(0);
let pdfWindowFrame = 0;
let pdfWindowWidth = 0;
// 起点页离开窗口后，只为仍经过阅读区域的跨页箭头保留轻量 SVG。
const crossPageArrows = new Map();
const detachedArrowLayers = new Map();

function isArrowAnnotation(anno) {
    return ['arrow', 'implies', 'equivalence'].includes(anno.type) && anno.start && anno.end;
}
function isCrossPageArrow(anno, pageNum) {
    return isArrowAnnotation(anno) && [anno.start, anno.end].some(point =>
        point.y < 0 || point.y > 1 || (point.pageAnchor && point.pageAnchor.pageNum !== pageNum));
}
function pdfPageLeft(pageNum, scale = state.scale) {
    return Math.max(0, (pdfWindowWidth - state.pageDimensions[pageNum - 1].width * scale) / 2);
}
function anchorArrowAnnotation(anno, pageNum) {
    if (!isArrowAnnotation(anno)) return;
    const dim = state.pageDimensions[pageNum - 1];
    if (!dim) return;
    const points = [anno.start, anno.end].filter(point => !point.pageAnchor &&
        Number.isFinite(point.x) && Number.isFinite(point.y) && (point.y < 0 || point.y > 1));
    if (!points.length) return;
    // 绘制时除以的是 client rect：非整数缩放下浏览器会把 CSS 尺寸取整到子像素。
    const rect = pageWrappers.get(pageNum)?.getBoundingClientRect();
    const sourceWidth = rect?.width || dim.width * state.scale;
    const sourceHeight = rect?.height || dim.height * state.scale;
    for (const point of points) {
        let offset = pdfPageTop(pageNum) + point.y * sourceHeight;
        let target = pdfPageAtOffset(offset);
        // 页顶的子像素舍入误差也归给下一页，避免横竖混排时误绑前一页。
        if (target < state.pageDimensions.length) {
            const nextTop = pdfPageTop(target + 1);
            if (offset >= nextTop - .05) { target++; offset = Math.max(offset, nextTop); }
        }
        const targetDim = state.pageDimensions[target - 1];
        const localY = offset - pdfPageTop(target), height = targetDim.height * state.scale;
        const anchor = {
            pageNum: target,
            x: (pdfPageLeft(pageNum) + point.x * sourceWidth - pdfPageLeft(target)) / (targetDim.width * state.scale),
            y: localY / height
        };
        // 间隔中的落点保存为固定间隔的比例，不把 24px 混入可缩放的页高。
        if (localY > height && target < state.pageDimensions.length) {
            anchor.y = 1;
            anchor.gapRatio = (localY - height) / PDF_PAGE_GAP;
        }
        // 保留旧的起点页比例坐标供旧版读取，新增页码与页内比例用于精确重定位。
        point.pageAnchor = anchor;
    }
}
function normalizeArrowAnchors(annotations = state.annotations, changedPages = null) {
    for (const key of changedPages || Object.keys(annotations)) {
        const pageNum = Number(key);
        if (!Number.isInteger(pageNum) || pageNum < 1 || !Array.isArray(annotations[key])) continue;
        for (const anno of annotations[key]) anchorArrowAnnotation(anno, pageNum);
    }
}
function arrowPointPosition(point, pageNum, w, h, layoutScale = state.scale) {
    const anchor = point.pageAnchor;
    const targetDim = anchor && state.pageDimensions[anchor.pageNum - 1];
    if (!targetDim || !Number.isInteger(anchor.pageNum) || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
        return { x: point.x * w, y: point.y * h };
    }
    const dim = state.pageDimensions[pageNum - 1];
    // w/h 可属于缩放中的临时批注层；先在当前页面布局中定位，再换算回层坐标。
    return {
        x: (pdfPageLeft(anchor.pageNum, layoutScale) - pdfPageLeft(pageNum, layoutScale) + anchor.x * targetDim.width * layoutScale) * w / (dim.width * layoutScale),
        y: (pdfPageTop(anchor.pageNum, layoutScale) - pdfPageTop(pageNum, layoutScale) + anchor.y * targetDim.height * layoutScale + (anchor.gapRatio || 0) * PDF_PAGE_GAP) * h / (dim.height * layoutScale)
    };
}
function arrowGeometry(anno, pageNum, w, h, layoutScale = state.scale) {
    return {
        start: arrowPointPosition(anno.start, pageNum, w, h, layoutScale),
        end: arrowPointPosition(anno.end, pageNum, w, h, layoutScale)
    };
}

function updateCrossPageArrows(changedPages = null) {
    normalizeArrowAnchors(state.annotations, changedPages);
    if (!changedPages) crossPageArrows.clear();
    for (const key of changedPages || Object.keys(state.annotations)) {
        const pageNum = Number(key);
        if (!Number.isInteger(pageNum) || pageNum < 1) continue;
        const arrows = (state.annotations[pageNum] || []).filter(anno => isCrossPageArrow(anno, pageNum));
        if (arrows.length) crossPageArrows.set(pageNum, arrows);
        else crossPageArrows.delete(pageNum);
    }
    refreshDetachedArrows();
}
function removeDetachedArrowLayer(pageNum) {
    detachedArrowLayers.get(pageNum)?.layer.remove();
    detachedArrowLayers.delete(pageNum);
}
function refreshDetachedArrows() {
    if (!state.pdfDoc) return;
    const viewTop = els.container.scrollTop - els.pagesContainer.offsetTop - PDF_PRELOAD_MARGIN;
    const viewBottom = viewTop + els.container.clientHeight + 2 * PDF_PRELOAD_MARGIN;
    const retained = new Set();
    for (const [pageNum, arrows] of crossPageArrows) {
        if (pageWrappers.has(pageNum)) continue;
        const dim = state.pageDimensions[pageNum - 1];
        if (!dim) continue;
        const top = pdfPageTop(pageNum), w = dim.width * state.scale, h = dim.height * state.scale;
        const padding = 12 * state.scale;
        const visible = arrows.map(anno => ({ anno, ...arrowGeometry(anno, pageNum, w, h) })).filter(({ start, end }) =>
            top + Math.max(start.y, end.y) + padding >= viewTop &&
            top + Math.min(start.y, end.y) - padding <= viewBottom);
        if (!visible.length) continue;
        retained.add(pageNum);
        let entry = detachedArrowLayers.get(pageNum);
        if (!entry) {
            const layer = document.createElement('div');
            layer.className = 'annotation-layer cross-page-arrow-layer';
            layer.dataset.pageNum = pageNum;
            entry = { layer, signature: '' };
            detachedArrowLayers.set(pageNum, entry);
            els.pagesContainer.appendChild(layer);
        }
        const { layer } = entry;
        setPdfStyle(layer, 'top', top + 'px');
        setPdfStyle(layer, 'left', Math.max(0, (pdfWindowWidth - w) / 2) + 'px');
        const signature = JSON.stringify([w, h, state.scale, visible]);
        if (signature === entry.signature) continue;
        layer.style.setProperty('--annotation-page-width', w + 'px');
        layer.style.setProperty('--annotation-page-height', h + 'px');
        let minY = 0, maxY = h;
        const fragment = document.createDocumentFragment();
        for (const { anno, start, end } of visible) {
            minY = Math.min(minY, start.y, end.y);
            maxY = Math.max(maxY, start.y, end.y);
            appendAnnotationNodes(anno, pageNum, fragment, w, h, state.scale);
        }
        // 纵向覆盖整支箭头，右侧仍服从原有侧翼开关。
        layer.style.setProperty('--arrow-clip-top', minY - padding + 'px');
        layer.style.setProperty('--arrow-clip-bottom', h - maxY - padding + 'px');
        layer.replaceChildren(fragment);
        entry.signature = signature;
    }
    for (const pageNum of detachedArrowLayers.keys()) {
        if (!retained.has(pageNum)) removeDetachedArrowLayer(pageNum);
    }
}

function resetPdfHeightIndex() {
    const dims = state.pageDimensions;
    pdfHeightIndex = new Float64Array(dims.length + 1);
    for (let i = 1; i <= dims.length; i++) {
        pdfHeightIndex[i] += dims[i - 1].height;
        const parent = i + (i & -i);
        if (parent <= dims.length) pdfHeightIndex[parent] += pdfHeightIndex[i];
    }
}
function pdfPageTop(pageNum, scale = state.scale) {
    const count = Math.max(0, Math.min(pageNum - 1, state.pageDimensions.length));
    let height = 0;
    for (let i = count; i > 0; i -= i & -i) height += pdfHeightIndex[i];
    return height * scale + count * PDF_PAGE_GAP;
}
function pdfPageAtOffset(offset) {
    const count = state.pageDimensions.length;
    let index = 0, sum = 0;
    for (let bit = 2 ** Math.floor(Math.log2(count || 1)); bit; bit = Math.floor(bit / 2)) {
        const next = index + bit;
        if (next <= count && (sum + pdfHeightIndex[next]) * state.scale + next * PDF_PAGE_GAP < offset) {
            index = next;
            sum += pdfHeightIndex[next];
        }
    }
    return Math.min(count, index + 1);
}
function updatePdfPageDimensions(pageNum, width, height) {
    const previous = state.pageDimensions[pageNum - 1];
    if (previous.width === width && previous.height === height) return;
    state.pageDimensions[pageNum - 1] = { width, height };
    for (let i = pageNum; i < pdfHeightIndex.length; i += i & -i) pdfHeightIndex[i] += height - previous.height;
    layoutPdfWindow();
    queuePdfWindowRefresh();
}
function setPdfStyle(element, name, value) {
    if (element && element.style && element.style[name] !== value) element.style[name] = value;
}
function layoutPdfPage(pageNum, wrapper) {
    const dim = state.pageDimensions[pageNum - 1];
    const width = dim.width * state.scale, height = dim.height * state.scale;
    setPdfStyle(wrapper, 'top', pdfPageTop(pageNum) + 'px');
    setPdfStyle(wrapper, 'left', Math.max(0, (pdfWindowWidth - width) / 2) + 'px');
    setPdfStyle(wrapper, 'width', width + 'px');
    setPdfStyle(wrapper, 'height', height + 'px');
    const canvas = wrapper.querySelector('canvas');
    setPdfStyle(canvas, 'width', width + 'px');
    setPdfStyle(canvas, 'height', height + 'px');
    for (const name of ['text', 'link']) {
        const layer = wrapper.querySelector(`#${name}-layer-${pageNum}`);
        if (layer._pdfScale) setPdfStyle(layer, 'transform', `scale(${state.scale / layer._pdfScale})`);
    }
    scaleAnnotationLayer(pageNum);
}
function layoutPdfWindow() {
    if (!state.pdfDoc) return;
    pdfWindowWidth = els.pagesContainer.clientWidth;
    setPdfStyle(els.pagesContainer, 'height', pdfPageTop(state.pageDimensions.length + 1) + 80 + 'px');
    for (const [pageNum, wrapper] of pageWrappers) layoutPdfPage(pageNum, wrapper);
    refreshDetachedArrows();
}
function ensurePdfPage(pageNum) {
    pageNum = Number(pageNum);
    if (!state.pdfDoc || !Number.isInteger(pageNum) || pageNum < 1 || pageNum > state.pdfDoc.numPages) return null;
    if (pageWrappers.has(pageNum)) return pageWrappers.get(pageNum);
    removeDetachedArrowLayer(pageNum);
    const cached = cachedPdfPages.get(pageNum);
    let wrapper;
    if (cached && cached.scale === state.scale) {
        cachedPdfPages.delete(pageNum);
        cachedPdfBytes -= cached.bytes;
        wrapper = cached.wrapper;
        state.pagesRendered.add(pageNum);
        renderedPageScales.set(pageNum, cached.scale);
    } else {
        if (cached) evictCachedPdfPage(pageNum);
        wrapper = document.createElement('div');
        wrapper.className = 'page-wrapper';
        wrapper.dataset.pageNum = pageNum;
        wrapper.id = `page-wrapper-${pageNum}`;
        wrapper.innerHTML = `
            <div id="sidecar-bg-${pageNum}" class="sidecar-bg">
                <div class="absolute inset-0 pointer-events-none" style="background-image:linear-gradient(rgba(0,0,0,0.06) 1px,transparent 1px);background-size:100% 32px"></div>
            </div>
            <canvas id="canvas-${pageNum}" class="block" width="0" height="0"></canvas>
            <div id="text-layer-${pageNum}" class="textLayer"></div>
            <div id="link-layer-${pageNum}" class="link-layer"></div>
            <div id="annotation-layer-${pageNum}" class="annotation-layer"></div>`;
    }
    pageWrappers.set(pageNum, wrapper);
    layoutPdfPage(pageNum, wrapper);
    // DOM 页序必须保留，否则跨页原生选择会跳过中间文字。
    let nextPageNum = Infinity;
    let nextEl = null;
    for (const [n, el] of pageWrappers) {
        if (n > pageNum && n < nextPageNum && el.isConnected) {
            nextPageNum = n;
            nextEl = el;
        }
    }
    els.pagesContainer.insertBefore(wrapper, nextEl);
    if (wrapper._annotationView?.entries.size) annotationPages.add(pageNum);
    renderAnnotations(pageNum);
    for (const node of wrapper.querySelectorAll('.text-annotation')) {
        // 只重新挂上观察，不再重置 isFirstResize：
        // 这里是"缓存页重新入窗"，重置会吞掉紧接着的一次真实尺寸变化，
        // 让批注里存的比例落后于屏幕，等下次缩放重排时文本框就会突然跳变。
        globalTextResizeObserver.observe(node);
    }
    observer.observe(wrapper);
    return wrapper;
}
function scrollPdfPageIntoView(pageNum, block = 'start') {
    const wrapper = ensurePdfPage(pageNum);
    if (!wrapper) return null;
    wrapper.scrollIntoView({ behavior: 'auto', block });
    refreshPdfRenderWindow(true);
    return wrapper;
}
function evictCachedPdfPage(pageNum) {
    const entry = cachedPdfPages.get(pageNum);
    if (!entry) return;
    cachedPdfPages.delete(pageNum);
    cachedPdfBytes -= entry.bytes;
    disposePdfWrapper(entry.wrapper);
}
function disposePdfWrapper(wrapper) {
    for (const node of wrapper.querySelectorAll('.text-annotation')) globalTextResizeObserver.unobserve(node);
    const canvas = wrapper.querySelector('canvas');
    if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
    }
    wrapper.replaceChildren();
    wrapper._annotationView = null;
}
function detachPdfPage(pageNum, allowCache = true) {
    const wrapper = pageWrappers.get(pageNum);
    if (!wrapper) return;
    cancelPageRendering(pageNum);
    observer.unobserve(wrapper);
    for (const node of wrapper.querySelectorAll('.text-annotation')) globalTextResizeObserver.unobserve(node);
    wrapper.querySelector('#search-highlight-layer')?.remove();
    for (const node of wrapper.querySelectorAll('.fallback-highlight')) {
        node.style.backgroundColor = '';
        node.classList.remove('fallback-highlight');
    }
    wrapper.remove();
    pageWrappers.delete(pageNum);
    const canvas = wrapper.querySelector('canvas');
    const bytes = canvas ? canvas.width * canvas.height * 4 : 0;
    if (allowCache && wrapper._pdfCompleteScale === state.scale && bytes > 0 && bytes <= PDF_CACHE_BYTES) {
        evictCachedPdfPage(pageNum);
        cachedPdfPages.set(pageNum, { wrapper, bytes, scale: state.scale });
        cachedPdfBytes += bytes;
        while (cachedPdfBytes > PDF_CACHE_BYTES || cachedPdfPages.size > PDF_CACHE_PAGES) evictCachedPdfPage(cachedPdfPages.keys().next().value);
    } else disposePdfWrapper(wrapper);
    annotationPages.delete(pageNum);
    renderedPageScales.delete(pageNum);
    state.pagesRendered.delete(pageNum);
}
function pinnedPdfPages() {
    const pinned = new Set();
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
        const pageOf = node => Number((node?.nodeType === 1 ? node : node?.parentElement)?.closest('.page-wrapper')?.dataset.pageNum);
        const a = pageOf(selection.anchorNode), b = pageOf(selection.focusNode);
        for (const pageNum of pageWrappers.keys()) if (pageNum >= Math.min(a, b) && pageNum <= Math.max(a, b)) pinned.add(pageNum);
    }
    if (state.drawingArrow?.isDrawing) pinned.add(Number(state.drawingArrow.pageNum));
    if (state.draggingText?.isPressed) pinned.add(Number(state.draggingText.pageNum));
    if (state.resizingText?.div) pinned.add(Number(state.resizingText.pageNum));
    if (state.draggingBubble?.isPressed) pinned.add(Number(state.draggingBubble.pageNum));
    if (state.isEditingNote) pinned.add(Number(state.activePageNum));
    return pinned;
}
function queuePdfWindowRefresh() {
    if (!pdfWindowFrame) pdfWindowFrame = requestAnimationFrame(() => {
        pdfWindowFrame = 0;
        refreshPdfRenderWindow(true);
    });
}
els.container.addEventListener('scroll', queuePdfWindowRefresh, { passive: true });
new ResizeObserver(() => {
    if (!state.pdfDoc) return;
    layoutPdfWindow();
    queuePdfWindowRefresh();
}).observe(els.container);

// 渲染与搜索共用提取 Promise。文字层预算 16 MiB，搜索文本预算 32 MiB。
let pdfTextCaches = new WeakMap();
function pdfTextCache(doc) {
    let cache = pdfTextCaches.get(doc);
    if (!cache) {
        cache = { content: new Map(), bytes: 0, search: new Map(), searchBytes: 0 };
        pdfTextCaches.set(doc, cache);
    }
    return cache;
}
function getPdfTextContent(doc, pageNum, page = null) {
    const cache = pdfTextCache(doc);
    let entry = cache.content.get(pageNum);
    if (entry) {
        cache.content.delete(pageNum);
        cache.content.set(pageNum, entry);
        return entry.promise;
    }
    entry = { bytes: 0 };
    entry.promise = Promise.resolve(page || doc.getPage(pageNum)).then(p => p.getTextContent()).then(content => {
        entry.bytes = content.items.reduce((sum, item) => sum + item.str.length * 2 + 200, 0);
        cache.bytes += entry.bytes;
        for (const [key, old] of cache.content) {
            if (cache.bytes <= 16 * 1024 * 1024 && cache.content.size <= 256) break;
            if (!old.bytes) continue;
            cache.content.delete(key);
            cache.bytes -= old.bytes;
        }
        return content;
    }, error => { cache.content.delete(pageNum); throw error; });
    cache.content.set(pageNum, entry);
    return entry.promise;
}
async function getPdfSearchText(doc, pageNum) {
    const cache = pdfTextCache(doc);
    if (cache.search.has(pageNum)) {
        const text = cache.search.get(pageNum);
        cache.search.delete(pageNum);
        cache.search.set(pageNum, text);
        return text;
    }
    const content = await getPdfTextContent(doc, pageNum);
    const text = content.items.map(item => item.str + (item.hasEOL ? ' ' : '')).join('');
    if (!cache.search.has(pageNum)) cache.searchBytes += text.length * 2;
    cache.search.set(pageNum, text);
    while (cache.searchBytes > 32 * 1024 * 1024 && cache.search.size > 1) {
        const key = cache.search.keys().next().value;
        cache.searchBytes -= cache.search.get(key).length * 2;
        cache.search.delete(key);
    }
    return text;
}
