// 内嵌批注提取独立于 PDF.js 的绘制 worker；读取完成即释放原始字节。
function isAnnotationTable(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
        Object.entries(value).every(([key, list]) =>
            !(/^\d+$/.test(key) || key === 'snippets') ||
            (Array.isArray(list) && list.every(anno => anno && typeof anno === 'object' && anno.id != null)));
}
async function readEmbeddedAnnotations(file, loadToken, includeIdentity = false) {
    if (typeof Worker === 'function') {
        try {
            return await new Promise((resolve, reject) => {
                const worker = new Worker(readerAssetUrl('./js/annotation-worker.js'));
                let settled = false;
                const finish = (value, error) => {
                    if (settled) return;
                    settled = true;
                    worker.terminate();
                    if (state.cancelAnnotationRead === cancel) state.cancelAnnotationRead = null;
                    if (error) reject(error); else resolve(value);
                };
                const cancel = () => finish({});
                state.cancelAnnotationRead = cancel;
                worker.onmessage = event => {
                    if (event.data.error) { finish(null, new Error(event.data.error)); return; }
                    if (event.data.annotationError) console.warn('未读取到内嵌批注:', event.data.annotationError);
                    finish(includeIdentity ? event.data : event.data.annotations || {});
                };
                worker.onerror = event => { event.preventDefault(); finish(null, new Error(event.message)); };
                worker.onmessageerror = () => finish(null, new Error('批注 worker 消息解码失败'));
                try { worker.postMessage({ file }); } catch (error) { finish(null, error); }
            });
        } catch (error) {
            if (state.loadToken !== loadToken) return {};
            console.warn('批注 worker 不可用，使用兼容读取:', error);
        }
    }
    if (state.loadToken !== loadToken) return {};
    // Worker 不可用时保留旧解析器；不额外 slice 整份文件，也不长期保留第二份数据。
    const buffer = await file.arrayBuffer();
    if (state.loadToken !== loadToken) return {};
    const doc = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true });
    if (state.loadToken !== loadToken) return {};
    const fingerprint = includeIdentity ? await readerDocumentFingerprint(doc) : '';
    const obj = doc.getInfoDict().get(PDFLib.PDFName.of('ReaderProAnnos'));
    let annotations = {};
    try {
        if (obj?.value) {
            const bytes = new Uint8Array(obj.value.length / 2);
            for (let i = 0; i < obj.value.length; i += 2) bytes[i / 2] = parseInt(obj.value.substring(i, i + 2), 16);
            annotations = JSON.parse(new TextDecoder().decode(bytes));
        }
    } catch (error) { console.warn('未读取到内嵌批注:', error); }
    return includeIdentity ? { annotations, fingerprint } : annotations;
}

function afterPdfPaint(firstPaint) {
    return firstPaint.then(ok => {
        if (!ok) return false;
        return new Promise(resolve => {
            let firstFrame, secondFrame;
            const done = () => { clearTimeout(timeout); cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); resolve(true); };
            // 后台标签页也能完成恢复；前台为首个完成的画布留出一次实际绘制机会。
            const timeout = setTimeout(done, 100);
            firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(done); });
        });
    });
}

// 提取期间仍允许创建批注。把这期间的更改合入恢复的数据，并重建对应撤销增量，
// 防止迟到的恢复任务覆盖新批注，或一次撤销把原有批注一起删掉。
function applyAnnotationChanges(target, before, after) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
        if (/^\d+$/.test(key) && (Array.isArray(before[key]) || Array.isArray(after[key]))) {
            const prev = before[key] || [], next = after[key] || [];
            const previousById = new Map(prev.map(a => [a.id, a]));
            const ids = new Set(next.map(a => a.id));
            const deleted = new Set(prev.filter(a => !ids.has(a.id)).map(a => a.id));
            const list = (target[key] || []).filter(a => !deleted.has(a.id));
            const positions = new Map(list.map((a, i) => [a.id, i]));
            for (const anno of next) {
                const old = previousById.get(anno.id);
                if (JSON.stringify(old) === JSON.stringify(anno)) continue;
                const index = positions.get(anno.id);
                if (index === undefined) { positions.set(anno.id, list.length); list.push(anno); }
                else list[index] = anno;
            }
            target[key] = list;
        } else if (key === 'settings') {
            const settings = { ...target.settings };
            for (const name of new Set([...Object.keys(before.settings || {}), ...Object.keys(after.settings || {})])) {
                if (JSON.stringify(before.settings?.[name]) === JSON.stringify(after.settings?.[name])) continue;
                if (Object.prototype.hasOwnProperty.call(after.settings || {}, name)) settings[name] = after.settings[name];
                else delete settings[name];
            }
            target.settings = settings;
        } else if (Object.prototype.hasOwnProperty.call(after, key)) target[key] = after[key];
        else delete target[key];
    }
}
function restoreAnnotationsPreservingEdits(restored) {
    normalizeArrowAnchors(restored);
    // 常见路径没有恢复期间的编辑，直接接管数据，避免为大批注表做多次深拷贝。
    if (state.history.length === 1 && state.historyIndex === 0 && Object.keys(state.annotations).length === 0) {
        state.annotations = restored;
        initHistory();
        return;
    }
    const clone = value => JSON.parse(JSON.stringify(value));
    const originalHistory = state.history;
    const originalIndex = state.historyIndex;
    let early = originalHistory[0]?.type === 'FULL' ? JSON.parse(originalHistory[0].data) : {};
    let merged = clone(restored);
    applyAnnotationChanges(merged, {}, early);
    const history = [{ type: 'FULL', data: JSON.stringify(merged) }];
    let active = clone(merged), activeEarly = clone(early);
    for (let i = 1; i < originalHistory.length; i++) {
        const step = originalHistory[i];
        const next = step.type === 'FULL' ? JSON.parse(step.data) : clone(early);
        if (step.forward) for (const key of Object.keys(step.forward)) next[key] = JSON.parse(step.forward[key]);
        const before = clone(merged);
        applyAnnotationChanges(merged, early, next);
        const backward = {}, forward = {};
        for (const key of new Set([...Object.keys(before), ...Object.keys(merged)])) {
            if (JSON.stringify(before[key]) === JSON.stringify(merged[key])) continue;
            backward[key] = JSON.stringify(before[key] ?? []);
            forward[key] = JSON.stringify(merged[key] ?? []);
        }
        history.push({ type: 'DELTA', backward, forward });
        early = next;
        if (i === originalIndex) { active = clone(merged); activeEarly = clone(early); }
    }
    applyAnnotationChanges(active, activeEarly, state.annotations);
    state.annotations = active;
    state.history = history;
    state.historyIndex = Math.max(0, originalIndex);
    const discarded = Math.max(0, Math.min(state.historyIndex, state.history.length - 50));
    if (discarded) {
        state.history.splice(0, discarded);
        state.historyIndex -= discarded;
    }
}
