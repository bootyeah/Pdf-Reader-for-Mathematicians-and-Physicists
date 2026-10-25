// PDF 位图调度。保留 1200px 缓冲、150ms 邻页延迟、100ms 缩放防抖与原始像素密度。
const PDF_PRELOAD_MARGIN = 1200;
const renderTimers = new Map();
const pageRenderJobs = new Map();
const renderedPageScales = new Map();
const pageRenderFailures = new Map();
const annotationPages = new Set();
let renderGeneration = 0;
let zoomRenderTimer = null;
let zoomRenderNotBefore = 0;

// 仅重画已有位图时使用临时画布；初次绘制仍直接渐进显示。
// 临时画布最多两个且总计不超过 64 MiB；单张超大页允许独占，避免永久排队。
const repaintQueue = [];
let repaintBytes = 0;
let repaintCount = 0;
function pumpRepaints() {
    repaintQueue.sort((a, b) => Math.abs(a.job.pageNum - state.currentPhysicalPage) - Math.abs(b.job.pageNum - state.currentPhysicalPage));
    for (let i = 0; i < repaintQueue.length;) {
        const entry = repaintQueue[i];
        if (!isCurrentRender(entry.job)) {
            repaintQueue.splice(i, 1);
            entry.resolve(false);
            continue;
        }
        if (repaintCount >= 2 || (repaintCount > 0 && repaintBytes + entry.bytes > 64 * 1024 * 1024)) break;
        repaintQueue.splice(i, 1);
        repaintCount++;
        repaintBytes += entry.bytes;
        entry.job.repaintBytes = entry.bytes;
        entry.resolve(true);
    }
}
function releaseRepaint(job) {
    if (!job.repaintBytes) return;
    repaintBytes -= job.repaintBytes;
    repaintCount--;
    job.repaintBytes = 0;
    pumpRepaints();
}
function isCurrentRender(job) {
    return !job.cancelled && state.pdfDoc === job.doc && state.loadToken === job.loadToken &&
        renderGeneration === job.generation && state.scale === job.scale &&
        pageRenderJobs.get(job.pageNum) === job && job.wrapper.isConnected;
}
function clearPageTimer(pageNum) {
    const pending = renderTimers.get(pageNum);
    if (pending) clearTimeout(pending.id);
    renderTimers.delete(pageNum);
}
function cancelPageRendering(pageNum) {
    clearPageTimer(pageNum);
    const job = pageRenderJobs.get(pageNum);
    if (job) {
        job.cancelled = true;
        job.task?.cancel();
        job.textTask?.cancel();
        pageRenderJobs.delete(pageNum);
    }
    pumpRepaints();
}
function releasePage(pageNum, allowCache = true) {
    clearPageTimer(pageNum);
    detachPdfPage(pageNum, allowCache);
}
function resetPdfRendering() {
    renderGeneration++;
    clearTimeout(zoomRenderTimer);
    clearTimeout(state.zoomEndTimer);
    state.isZooming = false;
    zoomRenderNotBefore = 0;
    observer.disconnect();
    observer.takeRecords();
    for (const pageNum of [...renderTimers.keys()]) clearPageTimer(pageNum);
    for (const pageNum of [...pageRenderJobs.keys()]) cancelPageRendering(pageNum);
    for (const pageNum of [...pageWrappers.keys()]) releasePage(pageNum, false);
    for (const pageNum of [...cachedPdfPages.keys()]) evictCachedPdfPage(pageNum);
    for (const pageNum of detachedArrowLayers.keys()) removeDetachedArrowLayer(pageNum);
    crossPageArrows.clear();
    cancelAnimationFrame(pdfWindowFrame);
    pdfWindowFrame = 0;
    pdfTextCaches = new WeakMap();
    renderedPageScales.clear();
    pageRenderFailures.clear();
    annotationPages.clear();
    state.pagesRendered.clear();
    pageWrappers.clear();
    state.firstPagePaint?.resolve(false);
    state.firstPagePaint = null;
}

function generatePageSkeletons(forceRebuild = false) {
    if (forceRebuild) {
        resetPdfHeightIndex();
        els.pagesContainer.replaceChildren();
        els.pagesContainer.classList.add('pdf-virtual-pages');
    }
    layoutPdfWindow();
}

function pageIntersectsRoot(wrapper, margin = 0) {
    const rect = wrapper.getBoundingClientRect();
    const root = els.container.getBoundingClientRect();
    return rect.bottom > root.top + els.container.clientTop - margin &&
        rect.top < root.top + els.container.clientTop + els.container.clientHeight + margin &&
        rect.right > root.left - margin && rect.left < root.right + margin;
}
function schedulePageRender(pageNum, delay = 150) {
    if (!state.pdfDoc) return;
    if (state.pagesRendered.has(pageNum) && renderedPageScales.get(pageNum) === state.scale) return;
    const active = pageRenderJobs.get(pageNum);
    if (active && isCurrentRender(active)) return;
    const due = Math.max(performance.now() + delay, state.isZooming ? zoomRenderNotBefore : 0);
    const pending = renderTimers.get(pageNum);
    if (pending && pending.generation === renderGeneration && pending.due <= due) return;
    clearPageTimer(pageNum);
    const loadToken = state.loadToken;
    const generation = renderGeneration;
    const id = setTimeout(() => {
        renderTimers.delete(pageNum);
        if (state.loadToken !== loadToken || renderGeneration !== generation) return;
        const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
        if (wrapper && pageIntersectsRoot(wrapper, PDF_PRELOAD_MARGIN)) renderPageHighQuality(pageNum);
    }, Math.max(0, due - performance.now()));
    renderTimers.set(pageNum, { id, due, generation });
}
const observer = new IntersectionObserver(() => {
    // 几何判断/挂载/回收统一在一个 rAF 中处理，忽略迟到的观察条目。
    queuePdfWindowRefresh();
}, { root: els.container, rootMargin: '1200px', threshold: 0.01 });

function refreshPdfRenderWindow(reclaim = false) {
    if (!state.pdfDoc || !state.pageDimensions.length) return;
    const viewTop = els.container.scrollTop - els.pagesContainer.offsetTop;
    const viewBottom = viewTop + els.container.clientHeight;
    const first = pdfPageAtOffset(Math.max(0, viewTop - PDF_PRELOAD_MARGIN));
    const last = pdfPageAtOffset(viewBottom + PDF_PRELOAD_MARGIN);
    const near = pinnedPdfPages();
    for (let pageNum = first; pageNum <= last; pageNum++) near.add(pageNum);
    for (const pageNum of near) {
        if (!ensurePdfPage(pageNum)) continue;
        const top = pdfPageTop(pageNum);
        const height = state.pageDimensions[pageNum - 1].height * state.scale;
        schedulePageRender(pageNum, top + height > viewTop && top < viewBottom || state.isZooming ? 0 : 150);
    }
    if (reclaim) for (const pageNum of [...pageWrappers.keys()]) {
        if (!near.has(pageNum)) releasePage(pageNum);
    }
    refreshDetachedArrows();
}
function beginPdfZoom() {
    renderGeneration++;
    zoomRenderNotBefore = performance.now() + 100;
    for (const pageNum of [...renderTimers.keys()]) clearPageTimer(pageNum);
    for (const pageNum of [...pageRenderJobs.keys()]) cancelPageRendering(pageNum);
    state.pagesRendered.clear();
}
function scheduleZoomRefresh() {
    clearTimeout(zoomRenderTimer);
    // 与原版一样，从同步尺寸/定位更新结束后计时；长文档布局不能吃掉防抖窗口。
    zoomRenderNotBefore = performance.now() + 100;
    const loadToken = state.loadToken;
    zoomRenderTimer = setTimeout(() => {
        if (state.loadToken === loadToken) refreshPdfRenderWindow();
    }, Math.max(0, zoomRenderNotBefore - performance.now()));
}

function renderPageHighQuality(pageNum, forceRender = false) {
    const doc = state.pdfDoc;
    const wrapper = ensurePdfPage(pageNum);
    if (!doc || !wrapper) return Promise.resolve(false);
    const active = pageRenderJobs.get(pageNum);
    if (!forceRender && active && isCurrentRender(active)) return active.promise;
    if (!forceRender && state.pagesRendered.has(pageNum) && renderedPageScales.get(pageNum) === state.scale) return Promise.resolve(true);
    cancelPageRendering(pageNum);
    const job = { doc, wrapper, pageNum, scale: state.scale, loadToken: state.loadToken, generation: renderGeneration, cancelled: false };
    pageRenderJobs.set(pageNum, job);
    job.promise = drawPdfPage(job);
    return job.promise;
}

async function drawPdfPage(job) {
    let targetCanvas;
    let detached = false;
    try {
        const page = await job.doc.getPage(job.pageNum);
        if (!isCurrentRender(job)) return false;
        const viewport = page.getViewport({ scale: job.scale });
        const { wrapper, pageNum } = job;
        const outputScale = Math.max(window.devicePixelRatio || 1, 2);
        const width = Math.floor(viewport.width * outputScale);
        const height = Math.floor(viewport.height * outputScale);
        const oldCanvas = document.getElementById(`canvas-${pageNum}`);
        detached = oldCanvas.width > 0 && oldCanvas.height > 0;
        if (detached) {
            const acquired = await new Promise(resolve => {
                repaintQueue.push({ job, bytes: width * height * 4, resolve });
                pumpRepaints();
            });
            if (!acquired || !isCurrentRender(job)) return false;
        }
        // 修正异形页的逻辑保持不变，且只由当前文档/当前缩放写入。
        updatePdfPageDimensions(pageNum, viewport.width / job.scale, viewport.height / job.scale);
        wrapper.style.width = viewport.width + 'px';
        wrapper.style.height = viewport.height + 'px';
        oldCanvas.style.width = viewport.width + 'px';
        oldCanvas.style.height = viewport.height + 'px';
        targetCanvas = detached ? document.createElement('canvas') : oldCanvas;
        targetCanvas.width = width;
        targetCanvas.height = height;
        targetCanvas.style.width = viewport.width + 'px';
        targetCanvas.style.height = viewport.height + 'px';
        const task = page.render({ canvasContext: targetCanvas.getContext('2d'), viewport,
            transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null });
        job.task = task;
        await task.promise;
        if (!isCurrentRender(job)) return false;
        if (detached) {
            // 同一次 JS 执行内交换完整位图。旧画布直到这一刻都保持可见。
            targetCanvas.id = oldCanvas.id;
            targetCanvas.className = oldCanvas.className;
            oldCanvas.replaceWith(targetCanvas);
            oldCanvas.width = 0;
            oldCanvas.height = 0;
        }
        renderedPageScales.set(pageNum, job.scale);
        state.pagesRendered.add(pageNum);
        releaseRepaint(job);
        if (pageIntersectsRoot(wrapper)) state.firstPagePaint?.resolve(true);
        renderAnnotations(pageNum);
        const textLayer = document.getElementById(`text-layer-${pageNum}`);
        const textContent = await getPdfTextContent(job.doc, pageNum, page);
        if (!isCurrentRender(job)) return false;
        textLayer._pdfScale = job.scale;
        textLayer.style.transform = '';
        textLayer.style.width = viewport.width + 'px';
        textLayer.style.height = viewport.height + 'px';
        textLayer.style.setProperty('--scale-factor', job.scale);
        wrapper.style.setProperty('--scale-factor', job.scale);
        textLayer.replaceChildren();
        job.textTask = pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayer, viewport, textDivs: [] });
        await Promise.all([job.textTask.promise, renderNativeLinks(page, pageNum, viewport, () => isCurrentRender(job))]);
        if (isCurrentRender(job)) {
            pageRenderFailures.delete(pageNum);
            wrapper._pdfCompleteScale = job.scale;
            wrapper._pdfLayersScale = job.scale;
        }
        return isCurrentRender(job);
    } catch (error) {
        if (isCurrentRender(job) && error.name !== 'RenderingCancelledException' && error.name !== 'AbortException') {
            console.error('PDF 页面渲染失败:', job.pageNum, error);
            state.pagesRendered.delete(job.pageNum);
            renderedPageScales.delete(job.pageNum);
            const failure = pageRenderFailures.get(job.pageNum);
            const attempts = failure?.generation === job.generation ? failure.attempts : 0;
            pageRenderFailures.set(job.pageNum, { generation: job.generation, attempts: attempts + 1 });
            job.retry = attempts === 0;
            state.firstPagePaint?.resolve(false);
        }
        return false;
    } finally {
        // 已交换到 DOM 的画布绝不能释放；取消/失败时仅回收未展示的临时画布。
        if (detached && targetCanvas && !targetCanvas.isConnected) { targetCanvas.width = 0; targetCanvas.height = 0; }
        releaseRepaint(job);
        if (pageRenderJobs.get(job.pageNum) === job) pageRenderJobs.delete(job.pageNum);
        if (job.retry && !job.cancelled && state.loadToken === job.loadToken && renderGeneration === job.generation &&
            job.wrapper.isConnected && pageIntersectsRoot(job.wrapper, PDF_PRELOAD_MARGIN)) {
            schedulePageRender(job.pageNum, 150);
        }
    }
}

async function renderNativeLinks(page, pageNum, viewport, isCurrent) {
    const annotations = await page.getAnnotations();
    if (!isCurrent()) return;
    const div = document.getElementById(`link-layer-${pageNum}`);
    const fragment = document.createDocumentFragment();
    for (const anno of annotations) {
        if (anno.subtype !== 'Link') continue;
        const { url, dest, rect } = anno;
        const element = document.createElement('a');
        const viewRect = viewport.convertToViewportRectangle(rect);
        element.style.left = Math.min(viewRect[0], viewRect[2]) + 'px';
        element.style.top = Math.min(viewRect[1], viewRect[3]) + 'px';
        element.style.width = Math.abs(viewRect[0] - viewRect[2]) + 'px';
        element.style.height = Math.abs(viewRect[1] - viewRect[3]) + 'px';
        if (url) { element.href = url; element.target = '_blank'; element.title = `打开链接: ${url}`; }
        else if (dest) {
            element.href = '#'; element.title = '跳转到内部页面';
            element.onclick = e => { e.preventDefault(); navigateToDestination(dest); };
        }
        fragment.appendChild(element);
    }
    div._pdfScale = viewport.scale;
    div.style.transform = '';
    div.style.width = viewport.width + 'px';
    div.style.height = viewport.height + 'px';
    div.replaceChildren(fragment);
}
