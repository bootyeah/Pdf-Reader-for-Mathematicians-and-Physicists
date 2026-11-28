/* 右侧无界草稿本手机映射手写：真实草稿纸界面映射至手机、实时笔迹回显（纯显示不入 PDF 批注）、跨页切换与手写转 LaTeX 段落。 */
(() => {
    const pageDocs = new Map();      // pageNum -> { w, h, infinite: true, strokes: [] }
    const pageResults = new Map();   // pageNum -> { key, latex, dismissed }
    const drawFrames = new Map();    // pageNum -> rAF id
    const inkResizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(entries => {
            for (const entry of entries) {
                const p = Number(entry.target.closest?.('.sidecar-hw-layer')?.dataset.pageNum);
                if (p > 0 && pageDocs.has(p)) scheduleDrawPageInk(p);
            }
        })
        : null;

    let phone = null;
    let sidecarActive = false;
    let pausedByFold = false;
    let activePage = 0;
    let autoFollow = true;
    let phoneOnline = false;
    let phoneWasOnline = false;
    let phoneConnectedOnce = false;
    let handledReqSeq = 0;
    let dock = null;
    let codeVisible = false;
    let bgRefreshTimer = 0;
    let scrollFollowTimer = 0;
    let syncGeneration = 0;
    let katexCssPromise = null;

    const $ = id => document.getElementById('sidecar-hw-' + id);

    function currentDocLoaded() {
        return typeof state !== 'undefined' && !!state.pdfDoc && state.pageDimensions?.length > 0;
    }

    function isSidecarShown() {
        return document.body.classList.contains('show-sidecars');
    }

    function worldSizeForPage(pageNum) {
        const dim = state.pageDimensions?.[pageNum - 1] || { width: 595, height: 842 };
        const w = 1000;
        const h = Math.max(200, Math.min(4000, Math.round(w * (dim.height / Math.max(1, dim.width)))));
        return { w, h };
    }

    function hasStrokes(pageNum) {
        const doc = pageDocs.get(pageNum);
        return !!(doc?.strokes?.some(s => s.k !== 'eraser' && s.p?.length));
    }

    // ---------- 嵌入本地 KaTeX 字体 CSS（仅首次需要截取含公式批注的草稿纸时懒加载并永久缓存） ----------
    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('read failed'));
            reader.readAsDataURL(blob);
        });
    }

    function getEmbeddedKatexCss() {
        if (katexCssPromise) return katexCssPromise;
        katexCssPromise = (async () => {
            try {
                const cssUrl = new URL('./lib/katex/katex.min.css', window.location.href).href;
                const resp = await fetch(cssUrl);
                if (!resp.ok) return '';
                let css = await resp.text();
                // 仅保留紧凑的 woff2 字体源并转成内联 data URL，使 SVG foreignObject 完全同源无污染且字形精确。
                css = css.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\(["'][^"']*["']\)/g, '');
                const matches = [...css.matchAll(/url\((['"]?)([^)'"]+\.woff2)\1\)/g)];
                const uniquePaths = [...new Set(matches.map(m => m[2]))];
                const replacements = new Map();
                await Promise.all(uniquePaths.map(async rel => {
                    try {
                        const fUrl = new URL(rel, cssUrl).href;
                        const fResp = await fetch(fUrl);
                        if (!fResp.ok) return;
                        const dataUrl = await blobToDataUrl(await fResp.blob());
                        if (dataUrl) replacements.set(rel, dataUrl);
                    } catch (_) {}
                }));
                for (const [rel, dataUrl] of replacements) {
                    css = css.split(rel).join(dataUrl);
                }
                return css;
            } catch (_) {
                return '';
            }
        })();
        return katexCssPromise;
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = err => reject(err);
            img.src = src;
        });
    }

    // ---------- 截取第 pageNum 页右侧无界草稿纸的真实界面 ----------
    async function captureSidecarSnapshot(pageNum) {
        if (!currentDocLoaded() || pageNum < 1 || pageNum > state.pdfDoc.numPages) return '';
        const wrapper = typeof ensurePdfPage === 'function'
            ? ensurePdfPage(pageNum)
            : document.getElementById(`page-wrapper-${pageNum}`);
        const dim = state.pageDimensions[pageNum - 1] || { width: 595, height: 842 };
        const scale = state.scale || 1;
        const cssW = Math.max(1, parseFloat(wrapper?.style.width) || (dim.width * scale));
        const cssH = Math.max(1, parseFloat(wrapper?.style.height) || (dim.height * scale));

        const maxSide = 1600;
        let snapW = 1100;
        let snapH = Math.max(200, Math.round(snapW * (cssH / cssW)));
        if (snapH > maxSide) {
            snapH = maxSide;
            snapW = Math.max(200, Math.round(snapH * (cssW / cssH)));
        }
        const snapScale = snapW / cssW;

        const canvas = document.createElement('canvas');
        canvas.width = snapW;
        canvas.height = snapH;
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';

        const eyeMode = document.body.classList.contains('eye-protection-mode');
        ctx.fillStyle = eyeMode ? '#FAF7F2' : '#FDFCF9';
        ctx.fillRect(0, 0, snapW, snapH);

        // 康奈尔横线网格（与 .sidecar-bg 32px 行距一致）
        const lineStep = Math.max(8, 32 * snapScale);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
        ctx.lineWidth = Math.max(1, snapScale * 0.9);
        ctx.beginPath();
        for (let y = lineStep; y < snapH; y += lineStep) {
            const py = Math.round(y) + 0.5;
            ctx.moveTo(0, py);
            ctx.lineTo(snapW, py);
        }
        ctx.stroke();

        // 左侧虚线装订边
        ctx.save();
        ctx.strokeStyle = eyeMode ? '#D1CDA8' : '#CBD5E1';
        ctx.lineWidth = Math.max(1.5, 2 * snapScale);
        ctx.setLineDash([6 * snapScale, 5 * snapScale]);
        ctx.beginPath();
        ctx.moveTo(1, 0);
        ctx.lineTo(1, snapH);
        ctx.stroke();
        ctx.restore();

        const annoLayer = wrapper?.querySelector(`#annotation-layer-${pageNum}`);
        if (annoLayer) {
            // 1. 矢量图形与跨区箭头（含从左页正文指向草稿纸的箭头）
            const vectorSvgs = [...annoLayer.querySelectorAll('svg.vector-svg')];
            for (const svgEl of vectorSvgs) {
                try {
                    const clone = svgEl.cloneNode(true);
                    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                    clone.setAttribute('width', String(snapW));
                    clone.setAttribute('height', String(snapH));
                    clone.setAttribute('viewBox', `${cssW} 0 ${cssW} ${cssH}`);
                    const xml = new XMLSerializer().serializeToString(clone);
                    const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml));
                    ctx.drawImage(img, 0, 0, snapW, snapH);
                } catch (_) {}
            }

            // 2. 草稿纸区域的文本块（含 KaTeX 公式、TikZ 图）、标记与气泡锚点
            const domNodes = [...annoLayer.children].filter(el => {
                if (el.tagName?.toLowerCase() === 'svg' || el.classList.contains('text-placeholder')) return false;
                const left = parseFloat(el.style.left);
                const width = el.offsetWidth || 24;
                return Number.isFinite(left) && (left + width > cssW * 0.98);
            });

            if (domNodes.length > 0) {
                let drawnByForeignObject = false;
                try {
                    const hasKatex = domNodes.some(el => el.querySelector?.('.katex'));
                    const katexCss = hasKatex ? await getEmbeddedKatexCss() : '';
                    const host = document.createElement('div');
                    host.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
                    host.style.cssText = `position:relative;width:${cssW}px;height:${cssH}px;overflow:hidden;font-family:ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;`;

                    const styleEl = document.createElement('style');
                    styleEl.textContent = `${katexCss}
                        .text-annotation{position:absolute;background:rgba(255,255,255,0.42);line-height:1.5;white-space:pre-wrap;word-wrap:break-word;box-sizing:border-box;border-radius:6px;}
                        .compact-prose p{margin:0.25em 0;}
                        .katex-display{margin:0.35em 0;overflow:visible;}
                    `;
                    host.appendChild(styleEl);

                    for (const el of domNodes) {
                        const clone = el.cloneNode(true);
                        const origLeft = parseFloat(el.style.left) || 0;
                        clone.style.left = (origLeft - cssW) + 'px';
                        // 移除非 data: 的外部图片链接以确保画布洁净不污染
                        clone.querySelectorAll?.('img').forEach(img => {
                            const src = img.getAttribute('src') || '';
                            if (src && !src.startsWith('data:')) img.remove();
                        });
                        host.appendChild(clone);
                    }

                    const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${snapW}" height="${snapH}" viewBox="0 0 ${cssW} ${cssH}"><foreignObject x="0" y="0" width="${cssW}" height="${cssH}">${new XMLSerializer().serializeToString(host)}</foreignObject></svg>`;
                    const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup));
                    ctx.drawImage(img, 0, 0, snapW, snapH);
                    drawnByForeignObject = true;
                } catch (_) {}

                // 兜底：若极端字符导致 foreignObject 解析失败，直接用 Canvas 2D 绘制文本块
                if (!drawnByForeignObject) {
                    ctx.save();
                    ctx.scale(snapScale, snapScale);
                    for (const el of domNodes) {
                        if (!el.classList.contains('text-annotation')) continue;
                        const x = (parseFloat(el.style.left) || cssW) - cssW;
                        const y = parseFloat(el.style.top) || 0;
                        const fs = parseFloat(el.style.fontSize) || (8 * scale);
                        ctx.fillStyle = el.style.color || '#111827';
                        ctx.font = `${fs}px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif`;
                        const lines = (el.innerText || el.textContent || '').split('\n');
                        lines.forEach((line, idx) => ctx.fillText(line, x + 6, y + fs * 1.2 + idx * fs * 1.5));
                    }
                    ctx.restore();
                }
            }
        }

        // 右下角轻量页码水印，便于手机缩放挪动时辨认当前所属页
        ctx.save();
        const fontPx = Math.max(12, Math.round(snapW * 0.015));
        ctx.font = `600 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
        ctx.fillStyle = eyeMode ? 'rgba(120, 113, 108, 0.36)' : 'rgba(148, 163, 184, 0.45)';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        const logical = (typeof state.pageOffset === 'number' && state.pageOffset > 0 && pageNum > state.pageOffset)
            ? `${pageNum - state.pageOffset} (P${pageNum})`
            : `P${pageNum}`;
        ctx.fillText(`草稿 · ${logical}`, snapW - Math.round(fontPx * 0.8), snapH - Math.round(fontPx * 0.65));
        ctx.restore();

        let out = '';
        try {
            out = canvas.toDataURL('image/webp', 0.85);
            if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/png');
        } catch (_) {
            out = canvas.toDataURL('image/png');
        }
        canvas.width = canvas.height = 0;
        return out;
    }

    // ---------- PC 端草稿纸笔迹渲染（纯显示层，绝不写入 state.annotations） ----------
    function drawPageInkNow(pageNum) {
        const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
        const canvas = wrapper?.querySelector('.sidecar-ink-canvas');
        if (!canvas) return;
        const board = pageDocs.get(pageNum);
        if (!board?.strokes?.length) {
            if (canvas.width > 0 || canvas.height > 0) {
                canvas.width = 0;
                canvas.height = 0;
            }
            return;
        }
        PhoneHandwriting.drawMapped(canvas, board);
    }

    function scheduleDrawPageInk(pageNum) {
        if (drawFrames.has(pageNum)) return;
        const id = requestAnimationFrame(() => {
            drawFrames.delete(pageNum);
            drawPageInkNow(pageNum);
        });
        drawFrames.set(pageNum, id);
    }

    // ---------- 浮动控制条与识别面板（单例挂载至当前激活页，保持 DOM 极简） ----------
    function statusToast(msg = '', kind = '') {
        const el = $('status');
        if (!el) return;
        el.textContent = msg;
        el.dataset.kind = kind;
        el.hidden = !msg;
    }

    function showPairingPopover(show) {
        const pop = $('pairing');
        const btn = $('pair');
        if (!pop || !btn) return;
        pop.hidden = !show;
        btn.setAttribute('aria-expanded', String(show));
        btn.classList.toggle('is-active', show);
    }

    function setCodeVisibleState(vis) {
        codeVisible = !!vis;
        const code = $('code');
        const btn = $('code-toggle');
        if (code) code.hidden = !codeVisible;
        if (btn) {
            btn.setAttribute('aria-expanded', String(codeVisible));
            btn.textContent = codeVisible ? '收起代码' : '改代码';
        }
    }

    function updateResultUI() {
        if (!dock) return;
        const entry = pageResults.get(activePage);
        const hasRes = !!entry?.latex?.trim();
        const toggleBtn = $('result-toggle');
        const resCard = $('result');
        const codeEl = $('code');
        const previewEl = $('preview');
        if (toggleBtn) toggleBtn.hidden = !hasRes;
        if (!hasRes) {
            if (resCard) resCard.hidden = true;
            if (codeEl) codeEl.value = '';
            if (previewEl) previewEl.replaceChildren();
            setCodeVisibleState(false);
            return;
        }
        if (codeEl && codeEl.dataset.pageKey !== `${activePage}:${entry.key}`) {
            codeEl.value = entry.latex;
            codeEl.dataset.pageKey = `${activePage}:${entry.key}`;
            if (previewEl) {
                previewEl.textContent = entry.latex;
                if (typeof renderLatex === 'function') renderLatex(previewEl);
            }
            setCodeVisibleState(false);
        }
        const visible = !entry.dismissed;
        if (resCard) resCard.hidden = !visible;
        if (toggleBtn) {
            toggleBtn.classList.toggle('is-active', visible);
            toggleBtn.title = visible ? '收起 LaTeX 识别结果' : '查看本页 LaTeX 识别结果';
        }
    }

    function updateTriggersAndDock() {
        document.querySelectorAll('.sidecar-hw-layer').forEach(layer => {
            const p = Number(layer.dataset.pageNum);
            const trigger = layer.querySelector('.sidecar-hw-trigger');
            const isCurrent = sidecarActive && p === activePage;
            layer.classList.toggle('is-active-page', isCurrent);
            if (!trigger) return;
            trigger.hidden = isCurrent;
            if (!isCurrent) {
                const label = trigger.querySelector('.sidecar-hw-trigger-label');
                const dot = trigger.querySelector('.sidecar-hw-dot');
                if (sidecarActive) {
                    if (label) label.textContent = '切到本页';
                    trigger.title = `将手机无界草稿纸切换到第 ${p} 页`;
                } else {
                    if (label) label.textContent = phoneOnline ? '手机手写' : '连接手写';
                    trigger.title = phoneOnline
                        ? `手机已连接，点击将第 ${p} 页无界草稿纸映射到手机`
                        : `扫码或连接手机，在第 ${p} 页无界草稿纸上实时手写`;
                }
                if (dot) dot.dataset.online = String(phoneOnline);
            }
        });

        if (!dock) return;
        if (!sidecarActive || !activePage) {
            dock.remove();
            return;
        }
        const activeLayer = document.querySelector(`.sidecar-hw-layer[data-page-num="${activePage}"] .sidecar-hw-anchor`);
        if (activeLayer && dock.parentElement !== activeLayer) {
            activeLayer.appendChild(dock);
        }

        const pairBtn = $('pair');
        if (pairBtn) {
            pairBtn.dataset.online = String(phoneOnline);
            const txt = pairBtn.querySelector('.sidecar-hw-pair-text');
            if (txt) txt.textContent = phoneOnline ? `已连 · P${activePage}` : `扫码 · P${activePage}`;
            pairBtn.title = phoneOnline ? '手机已连接（点击查看二维码或切换网络）' : '点击显示配对二维码';
        }

        const followBtn = $('follow');
        if (followBtn) {
            followBtn.setAttribute('aria-pressed', String(autoFollow));
            followBtn.classList.toggle('is-pinned', !autoFollow);
            followBtn.innerHTML = `<i class="ph ${autoFollow ? 'ph-arrows-down-up' : 'ph-push-pin'}"></i>`;
            followBtn.title = autoFollow
                ? '跟随翻页已开启：滚动阅读器时手机自动跟到当前页草稿纸（点击锁定本页）'
                : `已锁定第 ${activePage} 页草稿纸：滚动查阅其他页时手机保持在本页（点击恢复跟随）`;
        }

        const strokesExist = hasStrokes(activePage);
        const recognizing = !!phone?.state?.recognizing;
        const myRecognizing = recognizing && (!phone?.state?.recognizingTarget || phone.state.recognizingTarget === 'sidecar');
        const clearBtn = $('clear');
        if (clearBtn) clearBtn.disabled = !strokesExist || recognizing;
        const recogBtn = $('recognize');
        if (recogBtn) {
            recogBtn.disabled = !strokesExist || recognizing;
            const modelName = window.ReaderModelLabels?.name('whiteboard', false);
            recogBtn.title = modelName
                ? `将本页手写识别为 LaTeX 段落（模型：${modelName}）`
                : '将本页手写识别为 LaTeX 段落';
            recogBtn.innerHTML = myRecognizing
                ? `<i class="ph ph-spinner ph-spin"></i><span>识别中…</span>`
                : `<i class="ph ph-sparkle"></i><span>转 LaTeX</span>`;
        }
        updateResultUI();
    }

    function ensurePhone() {
        if (phone) return phone;
        phone = PhoneHandwriting.connect({
            id: 'sidecar',
            purpose: 'whiteboard',
            engine: () => '',
            active: () => sidecarActive && isSidecarShown(),
            error: message => {
                if (sidecarActive) statusToast(message, 'error');
            },
            change: (data, pairing) => {
                phoneOnline = !!data.online;
                if (phoneOnline) phoneConnectedOnce = true;

                // 1. 接收任意草稿页的增量笔迹（含快速翻页时的尾帧）
                if (data.sidecarDocs && typeof data.sidecarDocs === 'object') {
                    for (const [pStr, doc] of Object.entries(data.sidecarDocs)) {
                        const p = Number(pStr);
                        if (Number.isInteger(p) && p > 0 && doc) {
                            pageDocs.set(p, doc);
                            scheduleDrawPageInk(p);
                        }
                    }
                }
                // 2. 当前激活草稿页实时笔迹（兼容本地 WebSocket 直推与单页状态快照）
                if (data.scene === 'sidecar' && Number.isInteger(data.sidecarPage) && data.sidecarPage > 0 && data.doc) {
                    if (!data.pageId || data.pageId === `sidecar:${data.sidecarPage}`) {
                        pageDocs.set(data.sidecarPage, data.doc);
                        scheduleDrawPageInk(data.sidecarPage);
                    }
                }

                // 3. 响应手机端翻页按钮请求（‹ / ›）
                if (sidecarActive && Number.isInteger(data.sidecarPageReqSeq) &&
                    data.sidecarPageReqSeq !== handledReqSeq && data.sidecarPageRequest > 0) {
                    handledReqSeq = data.sidecarPageReqSeq;
                    if (currentDocLoaded() && data.sidecarPageRequest !== activePage) {
                        activatePage(data.sidecarPageRequest, { scrollIntoView: autoFollow });
                    }
                }

                ensureDock();
                PhoneHandwriting.renderPairing(phone, pairing, {
                    qr: $('qr'),
                    link: $('url'),
                    modes: $('modes'),
                    hint: $('hint'),
                    retry: $('retry'),
                    placeholder: $('qr-placeholder')
                });

                if (phoneOnline && !phoneWasOnline) {
                    phoneWasOnline = true;
                    if (sidecarActive) showPairingPopover(false);
                } else if (!phoneOnline) {
                    phoneWasOnline = false;
                }

                const myRecognizing = !!data.recognizing && (!data.recognizingTarget || data.recognizingTarget === 'sidecar');
                const myError = data.error && (!data.errorTarget || data.errorTarget === 'sidecar') ? data.error : '';
                if (myRecognizing) {
                    statusToast('正在识别手写草稿…', 'info');
                } else if (myError && sidecarActive) {
                    statusToast(myError, 'error');
                } else if ($('status')?.dataset.kind === 'info' || ($('status')?.dataset.kind === 'error' && !myError)) {
                    statusToast('');
                }

                // 4. 接收本场景（sidecar）识别完成的 LaTeX 段落
                const myResult = data.result?.latex && data.result.target === 'sidecar' ? data.result : null;
                if (myResult) {
                    let targetPage = activePage;
                    if (typeof myResult.pageId === 'string' && myResult.pageId.startsWith('sidecar:')) {
                        const parsed = Number(myResult.pageId.split(':')[1]);
                        if (Number.isInteger(parsed) && parsed > 0) targetPage = parsed;
                    }
                    if (targetPage > 0) {
                        const key = JSON.stringify(myResult);
                        const prev = pageResults.get(targetPage);
                        if (!prev || prev.key !== key) {
                            pageResults.set(targetPage, { key, latex: myResult.latex, dismissed: false });
                            statusToast('');
                        }
                    }
                }

                updateTriggersAndDock();
            }
        });
        return phone;
    }

    function ensureDock() {
        if (dock) return dock;
        dock = document.createElement('div');
        dock.id = 'sidecar-hw-dock';
        dock.className = 'sidecar-hw-dock';
        dock.innerHTML = `
            <div class="sidecar-hw-bar">
                <button type="button" id="sidecar-hw-pair" class="sidecar-hw-btn sidecar-hw-pair-btn" data-online="false" aria-expanded="false" title="手机连接状态 / 二维码">
                    <span class="sidecar-hw-dot" data-online="false"></span>
                    <span class="sidecar-hw-pair-text">扫码</span>
                    <i class="ph ph-qr-code"></i>
                </button>
                <button type="button" id="sidecar-hw-follow" class="sidecar-hw-btn sidecar-hw-icon-btn" aria-pressed="true" title="滚动时自动切换草稿纸页码">
                    <i class="ph ph-arrows-down-up"></i>
                </button>
                <button type="button" id="sidecar-hw-clear" class="sidecar-hw-btn sidecar-hw-icon-btn" title="清空本页临时手写笔迹" disabled>
                    <i class="ph ph-trash"></i>
                </button>
                <button type="button" id="sidecar-hw-result-toggle" class="sidecar-hw-btn sidecar-hw-icon-btn" hidden title="查看/收起识别结果">
                    <i class="ph ph-file-text"></i>
                </button>
                <button type="button" id="sidecar-hw-recognize" class="sidecar-hw-btn sidecar-hw-primary-btn" title="将本页手写识别为 LaTeX 段落" disabled>
                    <i class="ph ph-sparkle"></i><span>转 LaTeX</span>
                </button>
                <button type="button" id="sidecar-hw-exit" class="sidecar-hw-btn sidecar-hw-icon-btn sidecar-hw-exit-btn" title="退出草稿纸映射（保留已写笔迹与手机连接）">
                    <i class="ph ph-x"></i>
                </button>
            </div>
            <div id="sidecar-hw-status" class="sidecar-hw-status" hidden role="status"></div>
            <div id="sidecar-hw-pairing" class="sidecar-hw-popover sidecar-hw-pairing" hidden>
                <div class="sidecar-hw-qr-box">
                    <img id="sidecar-hw-qr" alt="无界草稿本手机配对二维码" hidden>
                    <div id="sidecar-hw-qr-placeholder" class="sidecar-hw-qr-loading"><i class="ph ph-spinner ph-spin"></i><span>生成配对码…</span></div>
                </div>
                <div id="sidecar-hw-modes" class="phone-connection-modes" role="group" aria-label="手机连接方式">
                    <button type="button" data-connection="lan" aria-pressed="true">同一 Wi-Fi</button>
                    <button type="button" data-connection="internet" aria-pressed="false">互联网</button>
                </div>
                <div id="sidecar-hw-hint" class="phone-connection-hint" role="status">手机与电脑连接同一 Wi-Fi 后扫码</div>
                <button type="button" id="sidecar-hw-retry" class="sidecar-hw-sub-btn" hidden>重试连接</button>
                <div class="sidecar-hw-pair-links">
                    <a id="sidecar-hw-url" target="_blank" rel="noopener noreferrer">直接打开手写页</a>
                    <button type="button" id="sidecar-hw-reconnect" class="sidecar-hw-sub-btn"><i class="ph ph-arrows-clockwise"></i><span>重新配对</span></button>
                </div>
            </div>
            <div id="sidecar-hw-result" class="sidecar-hw-popover sidecar-hw-result" hidden>
                <div id="sidecar-hw-preview" class="sidecar-hw-preview compact-prose"></div>
                <textarea id="sidecar-hw-code" class="sidecar-hw-code" rows="3" spellcheck="false" hidden aria-label="识别出的 LaTeX 段落代码"></textarea>
                <div class="sidecar-hw-result-actions">
                    <button type="button" id="sidecar-hw-code-toggle" class="sidecar-hw-sub-btn" aria-expanded="false">改代码</button>
                    <button type="button" id="sidecar-hw-copy" class="sidecar-hw-sub-btn"><i class="ph ph-copy"></i><span>复制</span></button>
                    <button type="button" id="sidecar-hw-stamp" class="sidecar-hw-btn sidecar-hw-primary-btn" title="作为文本块置入本页无界草稿纸对应位置"><i class="ph ph-check"></i><span>置入草稿</span></button>
                    <button type="button" id="sidecar-hw-result-close" class="sidecar-hw-sub-btn" title="收起面板">收起</button>
                </div>
            </div>
        `;

        // 阻止操作穿透到 PDF 页面批注/抓手/弹窗外点击关闭逻辑
        for (const evt of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'contextmenu']) {
            dock.addEventListener(evt, e => e.stopPropagation());
        }
        dock.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                if (!$('pairing').hidden) { showPairingPopover(false); e.stopPropagation(); return; }
                if (!$('result').hidden) { dismissResult(); e.stopPropagation(); }
            }
            e.stopPropagation();
        });

        const q = selector => dock.querySelector(selector);
        q('#sidecar-hw-pair').onclick = () => showPairingPopover(q('#sidecar-hw-pairing').hidden);
        q('#sidecar-hw-follow').onclick = () => {
            autoFollow = !autoFollow;
            updateTriggersAndDock();
        };
        q('#sidecar-hw-clear').onclick = () => clearPageStrokes(activePage);
        q('#sidecar-hw-recognize').onclick = () => {
            if (!activePage || !hasStrokes(activePage)) return;
            statusToast('');
            ensurePhone().action('recognize');
        };
        q('#sidecar-hw-exit').onclick = () => deactivate();
        q('#sidecar-hw-modes').querySelectorAll('[data-connection]').forEach(btn => {
            btn.onclick = () => ensurePhone().setConnection(btn.dataset.connection);
        });
        q('#sidecar-hw-retry').onclick = () => ensurePhone().setConnection('internet', true);
        q('#sidecar-hw-url').onclick = e => { if (!q('#sidecar-hw-url').getAttribute('href')) e.preventDefault(); };
        q('#sidecar-hw-reconnect').onclick = async () => {
            phoneOnline = false;
            phoneWasOnline = false;
            showPairingPopover(true);
            q('#sidecar-hw-qr').hidden = true;
            q('#sidecar-hw-qr-placeholder').hidden = false;
            q('#sidecar-hw-url').removeAttribute('href');
            await ensurePhone().start(true);
            if (sidecarActive && activePage > 0) syncActivePageToPhone(true);
        };

        q('#sidecar-hw-result-toggle').onclick = () => {
            const entry = pageResults.get(activePage);
            if (!entry) return;
            entry.dismissed = !entry.dismissed;
            updateResultUI();
        };
        const dismissResult = () => {
            const entry = pageResults.get(activePage);
            if (entry) entry.dismissed = true;
            updateResultUI();
        };
        q('#sidecar-hw-result-close').onclick = dismissResult;
        q('#sidecar-hw-code-toggle').onclick = () => setCodeVisibleState(!codeVisible);
        q('#sidecar-hw-code').addEventListener('input', () => {
            const val = q('#sidecar-hw-code').value;
            const entry = pageResults.get(activePage);
            if (entry) entry.latex = val;
            const prev = q('#sidecar-hw-preview');
            prev.textContent = val;
            if (typeof renderLatex === 'function') renderLatex(prev);
        });

        let copyTimer = 0;
        q('#sidecar-hw-copy').onclick = async () => {
            const code = q('#sidecar-hw-code').value.trim();
            if (!code) return;
            try {
                if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
                else {
                    const ta = document.createElement('textarea');
                    ta.value = code;
                    dock.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                }
                const btn = q('#sidecar-hw-copy');
                clearTimeout(copyTimer);
                btn.innerHTML = `<i class="ph ph-check"></i><span>已复制</span>`;
                copyTimer = setTimeout(() => { btn.innerHTML = `<i class="ph ph-copy"></i><span>复制</span>`; }, 1500);
            } catch (_) {
                statusToast('复制失败，请展开代码手动复制', 'error');
            }
        };

        q('#sidecar-hw-stamp').onclick = () => stampToSidecarPage(activePage);
        return dock;
    }

    function stampToSidecarPage(pageNum) {
        if (!currentDocLoaded() || !pageNum) return;
        const code = ($('code')?.value || pageResults.get(pageNum)?.latex || '').trim();
        if (!code) return;

        const doc = pageDocs.get(pageNum);
        const bounds = doc ? PhoneHandwriting.getContentBounds(doc) : null;
        let relX = 1.06, relY = 0.10;
        if (bounds && doc?.w > 0 && doc?.h > 0) {
            relX = 1 + Math.max(0.03, Math.min(0.82, bounds.left / doc.w));
            relY = Math.max(0.03, Math.min(0.88, bounds.top / doc.h));
        }

        const makeId = typeof nextAnnotationId === 'function' ? nextAnnotationId : () => Date.now().toString();
        const stampColor = (state.currentTool === 'text' && state.currentColor)
            ? state.currentColor
            : ((typeof TOOL_COLORS !== 'undefined' && TOOL_COLORS.text) || '#000000');

        const insertAnno = () => {
            if (!state.annotations[pageNum]) state.annotations[pageNum] = [];
            state.annotations[pageNum].push({
                id: makeId(),
                type: 'text',
                color: stampColor,
                x: relX,
                y: relY,
                text: code,
                timestamp: new Date().toLocaleString()
            });
        };

        if (typeof performAction === 'function') {
            performAction(insertAnno, [pageNum]);
        } else {
            insertAnno();
            if (typeof saveAnnotationsToStorage === 'function') saveAnnotationsToStorage();
            if (typeof refreshUI === 'function') refreshUI([pageNum]);
        }

        pageResults.delete(pageNum);
        clearPageStrokes(pageNum);
        updateTriggersAndDock();
        notifyAnnotationsChanged(pageNum);
    }

    function clearPageStrokes(pageNum) {
        if (!pageNum) return;
        const cur = pageDocs.get(pageNum);
        if (cur) {
            pageDocs.set(pageNum, { ...cur, strokes: [] });
        }
        drawPageInkNow(pageNum);
        if (phone?.id) {
            phone.action('sidecar_clear', { page: pageNum });
        }
        updateTriggersAndDock();
    }

    async function syncActivePageToPhone(includeInitialDoc = false) {
        if (!sidecarActive || !activePage || !currentDocLoaded()) return;
        const p = ensurePhone();
        const myGen = ++syncGeneration;
        const targetPage = activePage;
        await p.start();
        if (myGen !== syncGeneration || !sidecarActive || activePage !== targetPage || !p.id) return;

        const { w, h } = worldSizeForPage(targetPage);
        const existing = pageDocs.get(targetPage);
        if (existing) { existing.w = w; existing.h = h; }
        const bgImage = await captureSidecarSnapshot(targetPage);
        if (myGen !== syncGeneration || !sidecarActive || activePage !== targetPage || !p.id) return;

        const payload = {
            active: true,
            page: targetPage,
            totalPages: state.pdfDoc.numPages,
            width: w,
            height: h,
            bgImage
        };
        if (includeInitialDoc && existing?.strokes?.length) {
            payload.doc = existing;
        }
        await p.action('sidecar_sync', payload);
    }

    async function activatePage(pageNum, options = {}) {
        if (!currentDocLoaded()) return;
        pageNum = Math.max(1, Math.min(state.pdfDoc.numPages, Number(pageNum) || 1));
        if (!isSidecarShown() && typeof toggleSidecar === 'function') {
            toggleSidecar(true, true);
        }
        if (options.scrollIntoView && typeof scrollPdfPageIntoView === 'function') {
            scrollPdfPageIntoView(pageNum, 'start');
        } else if (typeof ensurePdfPage === 'function') {
            ensurePdfPage(pageNum);
        }

        const wasActive = sidecarActive;
        const prevPage = activePage;
        sidecarActive = true;
        pausedByFold = false;
        activePage = pageNum;

        ensurePhone();
        ensureDock();
        statusToast('');
        updateTriggersAndDock();

        if (!phoneOnline && !wasActive) {
            showPairingPopover(true);
        } else if (phoneOnline) {
            showPairingPopover(false);
        }

        await syncActivePageToPhone(!wasActive || prevPage !== pageNum);
        updateTriggersAndDock();
    }

    function deactivate(keepPausedFlag = false) {
        clearTimeout(bgRefreshTimer);
        clearTimeout(scrollFollowTimer);
        syncGeneration++;
        const wasActive = sidecarActive;
        sidecarActive = false;
        if (!keepPausedFlag) pausedByFold = false;
        activePage = 0;
        if (dock) {
            showPairingPopover(false);
            statusToast('');
            dock.remove();
        }
        updateTriggersAndDock();
        if (wasActive && phone?.id) {
            phone.action('sidecar_sync', { active: false });
            phone.schedule();
        }
    }

    // ---------- 页面挂载与生命周期钩子 ----------
    function mountPage(pageNum, wrapper) {
        if (!wrapper) return;
        let layer = wrapper.querySelector('.sidecar-hw-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'sidecar-hw-layer';
            layer.dataset.pageNum = String(pageNum);
            layer.innerHTML = `
                <canvas class="sidecar-ink-canvas" aria-hidden="true"></canvas>
                <div class="sidecar-hw-anchor">
                    <button type="button" class="sidecar-hw-trigger" title="连接手机手写">
                        <span class="sidecar-hw-dot" data-online="false"></span>
                        <i class="ph ph-device-mobile"></i>
                        <span class="sidecar-hw-trigger-label">连接手写</span>
                    </button>
                </div>
            `;
            const trigger = layer.querySelector('.sidecar-hw-trigger');
            for (const evt of ['mousedown', 'mouseup', 'pointerdown', 'dblclick', 'contextmenu']) {
                trigger.addEventListener(evt, e => e.stopPropagation());
            }
            trigger.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                activatePage(Number(layer.dataset.pageNum), { fromClick: true });
            });
            wrapper.appendChild(layer);
            const canvas = layer.querySelector('.sidecar-ink-canvas');
            if (canvas && inkResizeObserver) inkResizeObserver.observe(canvas);
        } else {
            layer.dataset.pageNum = String(pageNum);
        }
        updateTriggersAndDock();
        if (pageDocs.has(pageNum)) {
            scheduleDrawPageInk(pageNum);
        }
    }

    function onPageLayout(pageNum) {
        if (pageDocs.has(pageNum)) {
            scheduleDrawPageInk(pageNum);
        }
    }

    function unmountWrapper(wrapper) {
        const canvas = wrapper?.querySelector?.('.sidecar-ink-canvas');
        if (canvas) {
            inkResizeObserver?.unobserve(canvas);
            canvas.width = 0;
            canvas.height = 0;
        }
        if (dock && wrapper?.contains(dock)) {
            dock.remove();
        }
    }

    function notifyAnnotationsChanged(pageNum) {
        if (!sidecarActive || Number(pageNum) !== activePage) return;
        clearTimeout(bgRefreshTimer);
        bgRefreshTimer = setTimeout(() => {
            bgRefreshTimer = 0;
            if (sidecarActive && Number(pageNum) === activePage) {
                syncActivePageToPhone(false);
            }
        }, 180);
    }

    function onCurrentPageChanged(pageNum) {
        if (!sidecarActive || !autoFollow || !isSidecarShown()) return;
        if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum === activePage) return;
        clearTimeout(scrollFollowTimer);
        scrollFollowTimer = setTimeout(() => {
            scrollFollowTimer = 0;
            if (!sidecarActive || !autoFollow || !isSidecarShown()) return;
            if (phone?.state?.recognizing) return;
            const latest = state.currentPhysicalPage;
            if (Number.isInteger(latest) && latest >= 1 && latest !== activePage) {
                activatePage(latest, { fromScroll: true });
            }
        }, 220);
    }

    function onSidecarVisibilityChange(open) {
        if (!open) {
            if (sidecarActive) {
                const lastPage = activePage;
                pausedByFold = lastPage > 0;
                deactivate(true);
            }
        } else if (pausedByFold && currentDocLoaded()) {
            pausedByFold = false;
            const target = (state.currentPhysicalPage >= 1 && state.currentPhysicalPage <= state.pdfDoc.numPages)
                ? state.currentPhysicalPage
                : 1;
            activatePage(target);
        } else {
            // 展开时重绘已存在的各页笔迹（隐藏期间 getBoundingClientRect 可能未刷新）
            for (const p of pageDocs.keys()) scheduleDrawPageInk(p);
            updateTriggersAndDock();
        }
    }

    function pauseToBoard() {
        pausedByFold = false;
        if (sidecarActive) deactivate(false);
    }

    function resetForDocument() {
        pausedByFold = false;
        for (const id of drawFrames.values()) cancelAnimationFrame(id);
        drawFrames.clear();
        pageDocs.clear();
        pageResults.clear();
        clearTimeout(bgRefreshTimer);
        clearTimeout(scrollFollowTimer);
        syncGeneration++;
        const wasActive = sidecarActive;
        sidecarActive = false;
        activePage = 0;
        if (dock) dock.remove();
        if (phone?.id) {
            phone.action('sidecar_reset');
            if (wasActive) phone.schedule();
        }
    }

    // 护眼模式切换时同步更新手机上的草稿纸底色快照
    document.getElementById('eye-protection-btn')?.addEventListener('click', () => {
        if (sidecarActive && activePage > 0) notifyAnnotationsChanged(activePage);
    });
    window.addEventListener('reader-model-labels-changed', () => {
        if (dock && !dock.hidden) updateTriggersAndDock();
    });

    // 预注册到统一会话中枢，使得在白板或公式框已扫码后，草稿纸按钮能立即感知手机在线状态
    if (window.PhoneHandwriting?.connect) {
        ensurePhone();
    }

    window.SidecarHandwriting = {
        mountPage,
        onPageLayout,
        unmountWrapper,
        notifyAnnotationsChanged,
        onCurrentPageChanged,
        onSidecarVisibilityChange,
        pauseToBoard,
        resetForDocument,
        activate: activatePage,
        deactivate,
        isActive: () => sidecarActive,
        getActivePage: () => activePage,
        getPageDoc: p => pageDocs.get(Number(p)) || null,
        captureSnapshot: captureSidecarSnapshot
    };
})();
