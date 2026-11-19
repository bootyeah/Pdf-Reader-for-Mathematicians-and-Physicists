// PDF 高精度文本层引擎：利用 PDF 内嵌字体字宽表 (fontExtraProperties) 与比例拉丁字体族，
// 修正英文教材、数学公式、单字符符号/变量及空格的横纵几何偏差，并稳定空白区拖选。
(function () {
    'use strict';

    const GLYPH_NAME_TO_CHAR = {
        space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$',
        percent: '%', ampersand: '&', quotesingle: "'", quoteright: '\u2019',
        quoteleft: '\u2018', parenleft: '(', parenright: ')', asterisk: '*',
        plus: '+', comma: ',', hyphen: '-', minus: '\u2212', period: '.',
        slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4',
        five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':',
        semicolon: ';', less: '<', equal: '=', greater: '>', question: '?',
        at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
        asciicircum: '^', underscore: '_', grave: '`', braceleft: '{',
        bar: '|', braceright: '}', asciitilde: '~', endash: '\u2013',
        emdash: '\u2014', quotedblleft: '\u201c', quotedblright: '\u201d',
        fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl',
    };

    const TOKEN_RE = /\s+|[A-Za-z0-9\u00C0-\u024F]+|[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+|[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\sA-Za-z0-9\u00C0-\u024F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g;

    let measureCtx = null;
    let fallbackCtx = null;
    const ascentCache = new Map();
    const fallbackWidthCache = new Map();
    const fontMetaCache = new WeakMap();

    function getMeasureCtx() {
        if (!measureCtx) {
            const c = document.createElement('canvas');
            c.width = 0;
            c.height = 0;
            measureCtx = c.getContext('2d', { alpha: false });
        }
        return measureCtx;
    }

    function getFallbackCtx() {
        if (!fallbackCtx) {
            const c = document.createElement('canvas');
            c.width = 0;
            c.height = 0;
            fallbackCtx = c.getContext('2d', { alpha: false });
        }
        return fallbackCtx;
    }

    function getCssAscentRatio(fontSpec) {
        const cached = ascentCache.get(fontSpec);
        if (cached !== undefined) return cached;
        const ctx = getFallbackCtx();
        ctx.font = `30px ${fontSpec}`;
        const m = ctx.measureText('Hg');
        const asc = m.fontBoundingBoxAscent;
        const desc = Math.abs(m.fontBoundingBoxDescent);
        const ratio = (asc > 0 && (asc + desc) > 0) ? asc / (asc + desc) : 0.8;
        ascentCache.set(fontSpec, ratio);
        return ratio;
    }

    function measureFallbackEm(ch, fallbackCtxFont) {
        const key = fallbackCtxFont + '\0' + ch;
        let em = fallbackWidthCache.get(key);
        if (em !== undefined) return em;
        const ctx = getFallbackCtx();
        ctx.font = fallbackCtxFont;
        em = ctx.measureText(ch).width / 100;
        if (fallbackWidthCache.size > 4096) fallbackWidthCache.clear();
        fallbackWidthCache.set(key, em);
        return em;
    }

    // 显式指定拉丁比例字体族，避免 <html lang="zh-CN"> 下 serif 回退为等宽宋体 (SimSun)
    // 或 sans-serif 回退为高行框微软雅黑；汉字等非拉丁字符仍自动回退系统字体。
    function resolveCssFont(fontObj, style) {
        const rawName = String(fontObj?.name || '').replace(/^[A-Z]{6}\+/, '');
        const fallback = style?.fontFamily || fontObj?.fallbackName || 'sans-serif';

        const isMono = Boolean(fontObj?.isMonospace) || fallback === 'monospace' ||
            /(?:mono|courier|consolas|cmtt|lmtt|txtt|inconsolata|menlo|fixed)/i.test(rawName);
        const isSans = !isMono &&
            /(?:sans|arial|helv|calibri|segoe|verdana|tahoma|cmss|lmss|sfss|phv|roboto|noto\s*sans|inter|lato|myriad|frutiger|futura|optima|gothic)/i.test(rawName);
        const isSerif = !isMono && !isSans && (
            Boolean(fontObj?.isSerifFont) || fallback === 'serif' ||
            /(?:serif|times|roman|georgia|garamond|palatino|cambria|minion|stix|charter|bookman|century|baskerville|utopia|cmr|cmbx|cmti|cmmi|cmsl|cmcsc|cmsy|cmex|lmr|lmbx|lmmi|txr|pxr|ptm|ppl|put|nimbusrom|libertine|math)/i.test(rawName)
        );

        const family = isMono
            ? '"Courier New", Consolas, monospace'
            : (isSerif ? '"Times New Roman", Georgia, serif' : 'Arial, Helvetica, sans-serif');

        const isBold = Boolean(fontObj?.bold) ||
            /(?:bold|black|heavy|demi|semibold|cmbx|lmbx|ptmb|phvb|bx\d+)/i.test(rawName);
        const isItalic = Boolean(fontObj?.italic) ||
            /(?:italic|oblique|slant|cmti|cmmi|cmsl|lmti|lmmi|ptmri|phvo)/i.test(rawName);

        const weight = isBold ? '700' : '400';
        const fontStyle = isItalic ? 'italic' : 'normal';
        const cssPrefix = `${fontStyle === 'italic' ? 'italic ' : ''}${weight === '700' ? '700 ' : ''}`;
        return { family, weight, fontStyle, cssPrefix };
    }

    function buildFontMeta(fontObj, style) {
        if (fontObj && fontMetaCache.has(fontObj)) return fontMetaCache.get(fontObj);
        const css = resolveCssFont(fontObj, style);
        const charWidths = new Map();
        let maxKeyLen = 1;
        const matrixScale = (Array.isArray(fontObj?.fontMatrix) && fontObj.fontMatrix[0])
            ? Math.abs(fontObj.fontMatrix[0]) : 0.001;
        const widths = fontObj?.widths;
        const defaultW = (typeof fontObj?.defaultWidth === 'number' && fontObj.defaultWidth > 0)
            ? fontObj.defaultWidth : 0;

        if (widths && typeof widths === 'object') {
            const toUniMap = fontObj?.toUnicode?._map;
            if (toUniMap && typeof toUniMap === 'object') {
                const keys = Object.keys(toUniMap);
                // 第一遍：优先记录 PDF 字体表中显式给出的字形宽度（含连字 ff/fi/fl/ffi 与代理对数学斜体）
                for (let i = 0; i < keys.length; i++) {
                    const code = keys[i];
                    const uni = toUniMap[code];
                    if (typeof uni !== 'string' || !uni) continue;
                    const w = widths[code];
                    if (typeof w === 'number' && w > 0 && !charWidths.has(uni)) {
                        charWidths.set(uni, w * matrixScale);
                        if (uni.length > maxKeyLen && uni.length <= 4) maxKeyLen = uni.length;
                    }
                }
                // 第二遍：CID/稀疏宽表字体补齐默认宽度
                if (defaultW > 0) {
                    for (let i = 0; i < keys.length; i++) {
                        const code = keys[i];
                        const uni = toUniMap[code];
                        if (typeof uni !== 'string' || !uni || charWidths.has(uni)) continue;
                        charWidths.set(uni, defaultW * matrixScale);
                        if (uni.length > maxKeyLen && uni.length <= 4) maxKeyLen = uni.length;
                    }
                }
            }
            // 第三遍：无完整 ToUnicode 时的标准编码 / differences 回退
            const enc = fontObj?.defaultEncoding;
            const diffs = fontObj?.differences;
            if (Array.isArray(enc) || (diffs && typeof diffs === 'object')) {
                for (let code = 0; code < 256; code++) {
                    const w = widths[code];
                    if (typeof w !== 'number' || w <= 0) continue;
                    const gname = (diffs && diffs[code]) || (Array.isArray(enc) ? enc[code] : null);
                    if (typeof gname !== 'string' || !gname) continue;
                    const ch = gname.length === 1 ? gname : GLYPH_NAME_TO_CHAR[gname];
                    if (ch && !charWidths.has(ch)) {
                        charWidths.set(ch, w * matrixScale);
                        if (ch.length > maxKeyLen && ch.length <= 4) maxKeyLen = ch.length;
                    }
                }
            }
        }

        const meta = {
            css,
            charWidths,
            maxKeyLen,
            defaultEm: defaultW > 0 ? defaultW * matrixScale : 0,
            ascent: typeof fontObj?.ascent === 'number' ? fontObj.ascent : (style?.ascent ?? 0.8),
            descent: typeof fontObj?.descent === 'number' ? fontObj.descent : (style?.descent ?? -0.2),
            vertical: Boolean(style?.vertical || fontObj?.vertical),
        };
        if (fontObj) fontMetaCache.set(fontObj, meta);
        return meta;
    }

    function segmentText(str) {
        if (str.length <= 1) return [str];
        const tokens = str.match(TOKEN_RE);
        if (!tokens || tokens.length <= 1) return [str];
        return tokens;
    }

    function estimateTokenEmWidth(token, meta, fallbackCtxFont) {
        const { charWidths, maxKeyLen, defaultEm } = meta;
        let sum = 0;
        let matchedChars = 0;
        let i = 0;
        while (i < token.length) {
            let found = false;
            const maxL = Math.min(maxKeyLen, token.length - i);
            for (let len = maxL; len >= 1; len--) {
                const sub = token.slice(i, i + len);
                const w = charWidths.get(sub);
                if (w !== undefined) {
                    sum += w;
                    matchedChars += len;
                    i += len;
                    found = true;
                    break;
                }
            }
            if (!found) {
                const cp = token.codePointAt(i);
                const step = cp > 0xFFFF ? 2 : 1;
                const ch = token.slice(i, i + step);
                if (defaultEm > 0 && cp >= 0x2E80) {
                    sum += defaultEm;
                    matchedChars += step;
                } else {
                    sum += measureFallbackEm(ch, fallbackCtxFont);
                }
                i += step;
            }
        }
        return { em: sum, matchedChars };
    }

    function renderPrecisionTextLayer(page, textContent, container, viewport) {
        let cancelled = false;
        const task = {
            cancel() { cancelled = true; },
            promise: Promise.resolve().then(() => {
                if (cancelled || !container || !textContent || !viewport) return;
                try {
                    renderSync(page, textContent, container, viewport);
                } catch (err) {
                    if (cancelled) return;
                    console.warn('高精度文本层渲染回退至默认实现:', err);
                    container.replaceChildren();
                    if (typeof pdfjsLib !== 'undefined' && pdfjsLib.renderTextLayer) {
                        return pdfjsLib.renderTextLayer({
                            textContentSource: textContent,
                            container,
                            viewport,
                            textDivs: []
                        }).promise;
                    }
                }
            })
        };
        return task;
    }

    function renderSync(page, textContent, container, viewport) {
        if (typeof pdfjsLib !== 'undefined' && typeof pdfjsLib.setLayerDimensions === 'function') {
            pdfjsLib.setLayerDimensions(container, viewport);
        }
        const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
        const baseTransform = [1, 0, 0, -1, -pageX, pageY + pageHeight];
        const scale = viewport.scale;
        const measureScale = scale * (window.devicePixelRatio || 1);
        const styles = textContent.styles || {};
        const items = textContent.items || [];
        const frag = document.createDocumentFragment();
        const ctx = getMeasureCtx();
        const commonObjs = page?.commonObjs;
        const pageFontCache = new Map();

        let prevCtxFont = '';
        function measureWidth(ctxFont, text) {
            if (prevCtxFont !== ctxFont) {
                ctx.font = ctxFont;
                prevCtxFont = ctxFont;
            }
            return ctx.measureText(text).width;
        }

        function getMeta(fontName, style) {
            let meta = pageFontCache.get(fontName);
            if (meta) return meta;
            let fontObj = null;
            if (commonObjs && fontName) {
                try {
                    if (commonObjs.has(fontName)) fontObj = commonObjs.get(fontName);
                } catch (_) {
                    fontObj = null;
                }
            }
            meta = buildFontMeta(fontObj, style);
            pageFontCache.set(fontName, meta);
            return meta;
        }

        for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx];
            if (item.str === undefined) continue;
            const style = styles[item.fontName] || { fontFamily: 'sans-serif', vertical: false };
            const meta = getMeta(item.fontName, style);

            if (!item.str) {
                if (item.hasEOL) {
                    const br = document.createElement('br');
                    br.setAttribute('role', 'presentation');
                    frag.appendChild(br);
                }
                continue;
            }

            const tx = pdfjsLib.Util.transform(baseTransform, item.transform);
            let angle = Math.atan2(tx[1], tx[0]);
            if (meta.vertical) angle += Math.PI / 2;
            const fontHeight = Math.hypot(tx[2], tx[3]);
            const horizScale = Math.hypot(tx[0], tx[1]) || fontHeight;
            if (!(fontHeight > 0)) continue;

            const cssFontSpec = `${meta.css.cssPrefix}${meta.css.family}`;
            const cssAscentRatio = getCssAscentRatio(cssFontSpec);

            // 修正悬挂型数学大符号字体（如 CMEX10 的 ∑/∫，ascent≈0.04、descent≈-0.60），
            // 避免选框悬浮在符号上方
            let effectiveFontHeight = fontHeight;
            let ascentOffset = fontHeight * cssAscentRatio;
            if (!meta.vertical && meta.ascent < 0.35 && meta.descent < -0.35) {
                const glyphSpan = Math.max(1.0, (meta.ascent - meta.descent) * 1.15);
                effectiveFontHeight = fontHeight * glyphSpan;
                ascentOffset = fontHeight * Math.max(meta.ascent, 0.06);
            }

            const sinA = angle ? Math.sin(angle) : 0;
            const cosA = angle ? Math.cos(angle) : 1;
            const baseLeft = angle === 0 ? tx[4] : tx[4] + ascentOffset * sinA;
            const baseTop = angle === 0 ? tx[5] - ascentOffset : tx[5] - ascentOffset * cosA;
            const itemAdvance = meta.vertical ? item.height : item.width;
            const angleDeg = angle ? angle * (180 / Math.PI) : 0;

            const canSplit = !meta.vertical && Math.abs(angle) < 1e-4 && itemAdvance > 0 && item.str.length > 1;
            const tokens = canSplit ? segmentText(item.str) : [item.str];

            let segments;
            if (tokens.length > 1 && itemAdvance > 0) {
                const fallback100 = `${meta.css.cssPrefix}100px ${meta.css.family}`;
                const rawWidths = new Array(tokens.length);
                const isSpaceToken = new Array(tokens.length);
                let totalNatural = 0;
                let totalSpaceNatural = 0;
                let spaceCount = 0;
                let nonSpaceChars = 0;
                let matchedNonSpaceChars = 0;

                for (let k = 0; k < tokens.length; k++) {
                    const tok = tokens[k];
                    const sp = /^\s+$/.test(tok);
                    isSpaceToken[k] = sp;
                    const est = estimateTokenEmWidth(tok, meta, fallback100);
                    const w = est.em * horizScale;
                    rawWidths[k] = w;
                    totalNatural += w;
                    if (sp) {
                        totalSpaceNatural += w;
                        spaceCount++;
                    } else {
                        nonSpaceChars += tok.length;
                        matchedNonSpaceChars += est.matchedChars;
                    }
                }

                if (totalNatural > 0) {
                    const diff = itemAdvance - totalNatural;
                    const matchedRatio = nonSpaceChars > 0 ? matchedNonSpaceChars / nonSpaceChars : 0;
                    // 英文两端对齐行（LaTeX/出版社 PDF）的伸缩余量主要分布在词间空格中，而非拉伸字母本身
                    const useSpaceAbsorption =
                        spaceCount > 0 &&
                        matchedRatio >= 0.7 &&
                        diff > -totalSpaceNatural * 0.45 &&
                        diff < spaceCount * fontHeight * 1.15 &&
                        Math.abs(diff) <= Math.max(spaceCount * fontHeight * 0.85, itemAdvance * 0.22);

                    const spaceDelta = useSpaceAbsorption ? (diff / spaceCount) : 0;
                    const uniformRatio = useSpaceAbsorption ? 1 : (itemAdvance / totalNatural);

                    segments = new Array(tokens.length);
                    let cursorX = baseLeft;
                    for (let k = 0; k < tokens.length; k++) {
                        let segW = useSpaceAbsorption
                            ? rawWidths[k] + (isSpaceToken[k] ? spaceDelta : 0)
                            : rawWidths[k] * uniformRatio;
                        if (!(segW > 0.05)) segW = rawWidths[k] * (itemAdvance / totalNatural);
                        segments[k] = { str: tokens[k], left: cursorX, width: segW };
                        cursorX += segW;
                    }
                } else {
                    segments = [{ str: item.str, left: baseLeft, width: itemAdvance }];
                }
            } else {
                segments = [{ str: item.str, left: baseLeft, width: itemAdvance }];
            }

            const ctxFont = `${meta.css.cssPrefix}${effectiveFontHeight * measureScale}px ${meta.css.family}`;
            for (let s = 0; s < segments.length; s++) {
                const seg = segments[s];
                const span = document.createElement('span');
                span.setAttribute('role', 'presentation');
                span.textContent = seg.str;
                if (item.dir) span.dir = item.dir;
                const st = span.style;
                st.left = `${(100 * seg.left / pageWidth).toFixed(4)}%`;
                st.top = `${(100 * baseTop / pageHeight).toFixed(4)}%`;
                st.fontSize = `calc(var(--scale-factor) * ${effectiveFontHeight.toFixed(3)}px)`;
                st.fontFamily = meta.css.family;
                if (meta.css.weight !== '400') st.fontWeight = meta.css.weight;
                if (meta.css.fontStyle !== 'normal') st.fontStyle = meta.css.fontStyle;

                let transformStr = '';
                if (seg.width > 0) {
                    const measured = measureWidth(ctxFont, seg.str);
                    if (measured > 0) {
                        const sx = (seg.width * measureScale) / measured;
                        if (Number.isFinite(sx) && sx > 0.05 && sx < 20) {
                            transformStr = `scaleX(${sx.toFixed(4)})`;
                        }
                    }
                }
                if (angleDeg !== 0) {
                    transformStr = `rotate(${angleDeg.toFixed(3)}deg) ${transformStr}`.trim();
                }
                if (transformStr) st.transform = transformStr;
                frag.appendChild(span);
            }

            if (item.hasEOL) {
                const br = document.createElement('br');
                br.setAttribute('role', 'presentation');
                frag.appendChild(br);
            }
        }

        const endOfContent = document.createElement('div');
        endOfContent.className = 'endOfContent';
        frag.appendChild(endOfContent);
        container.replaceChildren(frag);
    }

    // ---------- 拖选稳定器：修正空白区跳选与空格/边界起拖丢锚点 ----------
    let dragState = null;

    function isTextSelectionAllowed(textLayer) {
        if (textLayer.classList.contains('cp-text-layer')) {
            return !textLayer.closest('.cp-hand-mode');
        }
        if (typeof state !== 'undefined' && state && state.currentTool) {
            return state.currentTool === 'cursor' ||
                state.currentTool === 'highlight' ||
                state.currentTool === 'underline' ||
                state.currentTool === 'parenthesis';
        }
        return true;
    }

    function findNearestEndPlacement(textLayer, clientX, clientY) {
        const spans = textLayer.children;
        let sameLineBefore = null;
        let sameLineBeforeRight = -Infinity;
        let sameLineAfter = null;
        let sameLineAfterLeft = Infinity;
        let sameLineFirst = null;
        let sameLineFirstLeft = Infinity;
        let aboveLast = null;
        let firstSpan = null;

        for (let i = 0; i < spans.length; i++) {
            const el = spans[i];
            if (el.tagName !== 'SPAN') continue;
            if (!firstSpan) firstSpan = el;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;

            if (clientY >= r.top - 4 && clientY <= r.bottom + 4) {
                if (r.left < sameLineFirstLeft) {
                    sameLineFirstLeft = r.left;
                    sameLineFirst = el;
                }
                if (r.left <= clientX && r.right >= sameLineBeforeRight) {
                    sameLineBefore = el;
                    sameLineBeforeRight = r.right;
                } else if (r.left > clientX && r.left < sameLineAfterLeft) {
                    sameLineAfterLeft = r.left;
                    sameLineAfter = el;
                }
            } else if (r.bottom < clientY) {
                aboveLast = el;
            }
        }

        if (sameLineBefore) return { ref: sameLineBefore.nextSibling, span: sameLineBefore, nextSpan: sameLineAfter, toEnd: true };
        if (sameLineFirst) return { ref: sameLineFirst, span: sameLineFirst, nextSpan: sameLineFirst, toEnd: false };
        if (aboveLast) return { ref: aboveLast.nextSibling, span: aboveLast, nextSpan: null, toEnd: true };
        if (firstSpan) return { ref: firstSpan, span: firstSpan, nextSpan: firstSpan, toEnd: false };
        return null;
    }

    function resolveCaretPoint(textLayer, clientX, clientY, preferNextOnSpace) {
        if (typeof document.caretRangeFromPoint === 'function') {
            const r = document.caretRangeFromPoint(clientX, clientY);
            if (r && r.startContainer && r.startContainer.nodeType === 3 && textLayer.contains(r.startContainer)) {
                const parentSpan = r.startContainer.parentElement;
                // 若落点在独立空格 span 的右半边/末端，锚点对准紧邻下一个词首，避免 Blink 丢失选区锚点
                if (preferNextOnSpace && parentSpan && parentSpan.tagName === 'SPAN' && /^\s+$/.test(parentSpan.textContent || '')) {
                    const sr = parentSpan.getBoundingClientRect();
                    if (clientX >= (sr.left + sr.right) / 2 || r.startOffset >= r.startContainer.nodeValue.length) {
                        let next = parentSpan.nextElementSibling;
                        while (next && (next.tagName !== 'SPAN' || !next.firstChild || next.firstChild.nodeType !== 3)) {
                            next = next.nextElementSibling;
                        }
                        if (next && next.firstChild) {
                            const nr = next.getBoundingClientRect();
                            if (Math.abs((nr.top + nr.bottom) / 2 - (sr.top + sr.bottom) / 2) <= Math.max(nr.height, sr.height)) {
                                return { node: next.firstChild, offset: 0 };
                            }
                        }
                    }
                }
                return { node: r.startContainer, offset: r.startOffset };
            }
        }
        const placement = findNearestEndPlacement(textLayer, clientX, clientY);
        if (placement) {
            const targetSpan = (preferNextOnSpace && placement.toEnd && placement.nextSpan) ? placement.nextSpan : placement.span;
            const tn = targetSpan?.firstChild;
            if (tn && tn.nodeType === 3) {
                const useStart = (targetSpan === placement.nextSpan && preferNextOnSpace) || !placement.toEnd;
                return { node: tn, offset: useStart ? 0 : tn.nodeValue.length };
            }
        }
        return null;
    }

    function resetEndOfContent(entry) {
        if (!entry) return;
        const { textLayer, endOfContent } = entry;
        endOfContent.classList.remove('active');
        if (!textLayer.isConnected || !endOfContent.isConnected) return;
        const sel = window.getSelection();
        const touchesContainer = sel && !sel.isCollapsed &&
            (sel.anchorNode === textLayer || sel.focusNode === textLayer);
        if (!touchesContainer && endOfContent.nextSibling !== null) {
            textLayer.appendChild(endOfContent);
        }
    }

    let bound = false;
    function bindPrecisionTextLayerSelection() {
        if (bound) return;
        bound = true;

        document.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.defaultPrevented || e.detail > 1) return;
            const textLayer = e.target?.closest?.('.textLayer');
            if (!textLayer || !isTextSelectionAllowed(textLayer)) return;
            const endOfContent = textLayer.querySelector(':scope > .endOfContent');
            if (!endOfContent) return;
            const anchor = resolveCaretPoint(textLayer, e.clientX, e.clientY, true);
            if (endOfContent.nextSibling !== null) textLayer.appendChild(endOfContent);
            endOfContent.classList.add('active');
            dragState = {
                textLayer,
                endOfContent,
                startX: e.clientX,
                startY: e.clientY,
                anchor,
                moveCount: 0,
                recovering: false,
            };
        }, true);

        document.addEventListener('mousemove', (e) => {
            if (!dragState) return;
            if ((e.buttons & 1) === 0) {
                resetEndOfContent(dragState);
                dragState = null;
                return;
            }
            const { textLayer, endOfContent, anchor } = dragState;
            if (!textLayer.isConnected || !endOfContent.isConnected) {
                dragState = null;
                return;
            }
            dragState.moveCount++;
            const movedDist = Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY);
            const sel = window.getSelection();

            // 1. 仅当经过至少一次原生 mousemove 默认处理后，拖动 > 4px 选区仍然折叠
            //    （独立空格 span / 词首亚像素边缘 / 留白起拖触发 Blink 丢锚点），才由起点锚点接管。
            if (anchor && anchor.node.isConnected && sel &&
                (dragState.recovering || (dragState.moveCount >= 2 && movedDist > 4 && sel.isCollapsed))) {
                dragState.recovering = true;
                e.preventDefault();
                const focus = (e.target === endOfContent || e.target === textLayer)
                    ? (() => {
                        const pl = findNearestEndPlacement(textLayer, e.clientX, e.clientY);
                        const tn = pl?.span?.firstChild;
                        return (tn && tn.nodeType === 3) ? { node: tn, offset: pl.toEnd ? tn.nodeValue.length : 0 } : null;
                    })()
                    : resolveCaretPoint(textLayer, e.clientX, e.clientY, false);
                if (focus && focus.node.isConnected && typeof sel.setBaseAndExtent === 'function') {
                    try {
                        sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
                    } catch (_) {}
                }
                return;
            }

            // 2. 指针落入空白背景（而非具体 span）时，稳定选区终点到光标同行/就近文字边界
            if (e.target === endOfContent || e.target === textLayer) {
                const placement = findNearestEndPlacement(textLayer, e.clientX, e.clientY);
                if (placement) {
                    if (placement.ref !== endOfContent && placement.ref !== endOfContent.nextSibling) {
                        textLayer.insertBefore(endOfContent, placement.ref || null);
                    }
                    const textNode = placement.span?.firstChild;
                    if (sel && sel.anchorNode && textLayer.contains(sel.anchorNode) &&
                        textNode && textNode.nodeType === 3 && typeof sel.extend === 'function') {
                        const offset = placement.toEnd ? textNode.nodeValue.length : 0;
                        if (sel.focusNode !== textNode || sel.focusOffset !== offset) {
                            try { sel.extend(textNode, offset); } catch (_) {}
                        }
                    }
                }
            }
        }, false);

        const finishDrag = () => {
            if (!dragState) return;
            resetEndOfContent(dragState);
            dragState = null;
        };
        document.addEventListener('mouseup', finishDrag, true);
        window.addEventListener('blur', finishDrag);
    }

    bindPrecisionTextLayerSelection();

    window.renderPrecisionTextLayer = renderPrecisionTextLayer;
    window.bindPrecisionTextLayerSelection = bindPrecisionTextLayerSelection;
})();
