(function () {
    'use strict';

    const KATEX_PREFIX_CMDS = new Set([
        'genfrac', 'sqrt', 'accent', 'accentUnder', 'xArrow',
        'overline', 'underline', 'horizBrace', 'enclose', 'raisebox'
    ]);

    function findKatexMhchemSpans(tex) {
        const spans = [];
        const re = /\\(?:ce|pu)\s*\{/g;
        let match;
        while ((match = re.exec(tex)) !== null) {
            const start = match.index;
            let depth = 1;
            let i = match.index + match[0].length;
            while (i < tex.length && depth > 0) {
                if (tex[i] === '\\') { i += 2; continue; }
                if (tex[i] === '{') depth += 1;
                else if (tex[i] === '}') depth -= 1;
                i += 1;
            }
            const bodyStart = match.index + match[0].length;
            const bodyEnd = Math.max(bodyStart, i - (depth === 0 ? 1 : 0));
            spans.push({ start, bodyStart, bodyEnd, end: i });
        }
        return spans;
    }

    function getKatexNodeSpecs(node) {
        if (!node || typeof node !== 'object') return [];
        switch (node.type) {
            case 'supsub': {
                const list = [];
                if (node.base) list.push({ role: 'base', node: node.base });
                if (node.sub) list.push({ role: 'sub', node: node.sub });
                if (node.sup) list.push({ role: 'sup', node: node.sup });
                return list;
            }
            case 'genfrac':
                return [
                    node.numer ? { role: 'numer', node: node.numer } : null,
                    node.denom ? { role: 'denom', node: node.denom } : null
                ].filter(Boolean);
            case 'sqrt':
                return [
                    node.index ? { role: 'index', node: node.index } : null,
                    node.body ? { role: 'body', node: node.body } : null
                ].filter(Boolean);
            case 'xArrow':
                return [
                    node.below ? { role: 'below', node: node.below } : null,
                    node.body ? { role: 'body', node: node.body } : null
                ].filter(Boolean);
            case 'accent':
            case 'accentUnder':
            case 'horizBrace':
                return node.base ? [{ role: 'base', node: node.base }] : [];
            case 'array': {
                const cells = [];
                if (Array.isArray(node.body)) {
                    node.body.forEach((row, r) => row.forEach((cell, c) => {
                        cells.push({ role: `cell:${r}:${c}`, node: cell });
                    }));
                }
                return cells;
            }
            case 'htmlmathml':
                return [];
            default:
                if (Array.isArray(node.body)) return node.body.map((child, idx) => ({ role: String(idx), node: child }));
                if (node.body && typeof node.body === 'object') return [{ role: 'body', node: node.body }];
                return [];
        }
    }

    // KaTeX reuses singleton AST leaves (e.g. consecutive primes in f''), so each node gets its own info wrapper.
    function buildKatexAstInfo(node, texLen, tainted, literalError) {
        if (!node || typeof node !== 'object') return null;
        const selfTainted = tainted || node.type === 'htmlmathml';
        const isErrorColorText = Boolean(
            node.type === 'color' && !node.loc && node.color === '#cc0000'
            && Array.isArray(node.body) && node.body.length === 1 && node.body[0] && node.body[0].type === 'text'
        );
        const childLiteralError = Boolean(literalError || isErrorColorText);
        const loc = !selfTainted && node.loc && typeof node.loc.start === 'number' && typeof node.loc.end === 'number'
            && node.loc.start >= 0 && node.loc.end <= texLen && node.loc.start <= node.loc.end
            ? { start: node.loc.start, end: node.loc.end }
            : null;
        let rawMin = Infinity;
        let rawMax = -1;
        const children = [];
        for (const spec of getKatexNodeSpecs(node)) {
            const childInfo = buildKatexAstInfo(spec.node, texLen, selfTainted, childLiteralError);
            if (!childInfo) continue;
            children.push({ role: spec.role, info: childInfo });
            if (childInfo.rawMax >= 0) {
                rawMin = Math.min(rawMin, childInfo.rawMin);
                rawMax = Math.max(rawMax, childInfo.rawMax);
            }
        }
        const directOk = Boolean(loc && (rawMin > rawMax || (loc.start <= rawMin && loc.end >= rawMax)));
        if (directOk) {
            rawMin = Math.min(rawMin, loc.start);
            rawMax = Math.max(rawMax, loc.end);
        }
        const byRole = Object.create(null);
        for (const c of children) byRole[c.role] = c.info;
        return {
            node,
            direct: directOk ? loc : null,
            rawMin: rawMin <= rawMax ? rawMin : -1,
            rawMax: rawMin <= rawMax ? rawMax : -1,
            children,
            byRole,
            literalError: Boolean(literalError && !loc),
            start: 0,
            end: 0,
            mhchem: null,
            innerStart: null,
            innerEnd: null,
            cellRange: null
        };
    }

    function findTokenInKatexGap(tex, start, end, node, literalError) {
        let s = start;
        while (s < end && /\s/.test(tex[s])) s += 1;
        if (s >= end) return { start: Math.min(start, tex.length), end: Math.min(start, tex.length) };
        if (literalError && node && node.text) {
            const idx = tex.indexOf(node.text, s);
            if (idx !== -1 && idx + node.text.length <= end) {
                return { start: idx, end: idx + node.text.length };
            }
        }
        if (node.type === 'textord' && node.text === '\\prime') {
            const tickIdx = tex.indexOf("'", s);
            if (tickIdx !== -1 && tickIdx < end) return { start: tickIdx, end: tickIdx + 1 };
            const cmdIdx = tex.indexOf('\\prime', s);
            if (cmdIdx !== -1 && cmdIdx < end) return { start: cmdIdx, end: cmdIdx + 6 };
        }
        if (node.type === 'op' && node.name) {
            const idx = tex.indexOf(node.name, s);
            if (idx !== -1 && idx < end) return { start: idx, end: idx + node.name.length };
        }
        if (tex[s] === '\\') {
            const match = tex.slice(s, end).match(/^\\(?:[a-zA-Z]+|.)/);
            if (match) return { start: s, end: s + match[0].length };
        }
        return { start: s, end: s + 1 };
    }

    function trimKatexCommandSpace(tex, start, end) {
        if (end > start && tex[start] === '\\' && /\s/.test(tex[end - 1])) {
            let trimmed = end;
            while (trimmed > start + 2 && /\s/.test(tex[trimmed - 1])) trimmed -= 1;
            return trimmed;
        }
        return end;
    }

    function assignKatexSeqSpans(infoList, left, right, tex, mhSpans) {
        let cursor = left;
        for (let i = 0; i < infoList.length; i += 1) {
            const info = infoList[i];
            let nextBound = right;
            for (let j = i + 1; j < infoList.length; j += 1) {
                const nextInfo = infoList[j];
                if (nextInfo.rawMax >= 0 && nextInfo.rawMin >= cursor && nextInfo.rawMax <= right) {
                    nextBound = nextInfo.rawMin;
                    break;
                }
            }
            const isExpandedMhchem = Boolean(
                info.node.type === 'ordgroup' && info.node.loc
                && (info.node.loc.end > tex.length
                    || (info.node.loc.lexer && info.node.loc.lexer.input !== tex))
            );
            const sliceOffset = tex.slice(cursor, nextBound).search(/\\(?:ce|pu)\s*\{/);
            const mh = isExpandedMhchem && sliceOffset !== -1
                ? mhSpans.find(sp => sp.start === cursor + sliceOffset && sp.end <= nextBound)
                : null;
            if (mh) {
                info.start = mh.start;
                info.end = mh.end;
                info.mhchem = { bodyStart: mh.bodyStart, bodyEnd: mh.bodyEnd };
                cursor = mh.end;
                continue;
            }
            const hasValid = info.rawMax >= 0 && info.rawMin >= cursor && info.rawMax <= right;
            if (hasValid) {
                const nodeRight = info.node.type === 'leftright' ? nextBound : info.rawMax;
                assignKatexNodeSpan(info, cursor, nodeRight, tex, mhSpans);
                cursor = Math.max(info.rawMax, info.end);
            } else {
                assignKatexNodeSpan(info, cursor, nextBound, tex, mhSpans);
                cursor = Math.max(cursor, info.end);
            }
        }
    }

    /** Compute exact source [start, end] ranges for each row/col cell in a TeX array/matrix environment. */
    function computeArrayCellRanges(tex, start, end) {
        const rows = [];
        const slice = tex.slice(start, end);
        const beginM = slice.match(/^\s*\\begin\s*\{[^}]+\}(?:\s*\[[^\]]*\])?(?:\s*\{[^}]*\})?/);
        const endM = slice.match(/\\end\s*\{[^}]+\}\s*$/);
        const bodyStart = start + (beginM ? beginM[0].length : 0);
        const bodyEnd = endM ? end - endM[0].length : end;
        let depth = 0;
        let envDepth = 0;
        let curRow = [];
        let cellStart = bodyStart;
        for (let i = bodyStart; i < bodyEnd;) {
            const ch = tex[i];
            if (ch === '\\') {
                if (envDepth === 0 && depth === 0 && tex[i + 1] === '\\') {
                    curRow.push([cellStart, i]);
                    rows.push(curRow);
                    curRow = [];
                    i += 2;
                    const opt = tex.slice(i, bodyEnd).match(/^\s*\[[^\]]*\]/);
                    if (opt) i += opt[0].length;
                    cellStart = i;
                    continue;
                }
                const cmdM = tex.slice(i, bodyEnd).match(/^\\(begin|end|cr)\b/);
                if (cmdM) {
                    if (cmdM[1] === 'begin') envDepth += 1;
                    else if (cmdM[1] === 'end' && envDepth > 0) envDepth -= 1;
                    else if (cmdM[1] === 'cr' && envDepth === 0 && depth === 0) {
                        curRow.push([cellStart, i]);
                        rows.push(curRow);
                        curRow = [];
                        i += cmdM[0].length;
                        cellStart = i;
                        continue;
                    }
                }
                const tokM = tex.slice(i, bodyEnd).match(/^\\(?:[a-zA-Z]+|.)/);
                i += tokM ? tokM[0].length : 1;
                continue;
            }
            if (ch === '{') depth += 1;
            else if (ch === '}' && depth > 0) depth -= 1;
            else if (ch === '&' && depth === 0 && envDepth === 0) {
                curRow.push([cellStart, i]);
                cellStart = i + 1;
            }
            i += 1;
        }
        curRow.push([cellStart, bodyEnd]);
        rows.push(curRow);
        return rows;
    }

    function assignKatexNodeSpan(info, left, right, tex, mhSpans) {
        const node = info.node;
        const direct = info.direct && info.direct.start >= left && info.direct.end <= right
            ? { start: info.direct.start, end: trimKatexCommandSpace(tex, info.direct.start, info.direct.end) }
            : null;
        if (node.type === 'htmlmathml') {
            const tok = findTokenInKatexGap(tex, left, right, node, info.literalError);
            info.start = tok.start;
            info.end = tok.end;
            return;
        }
        if (!info.children.length) {
            const sp = direct || findTokenInKatexGap(tex, left, right, node, info.literalError);
            if (!direct && node.type === 'text') {
                const braceM = tex.slice(sp.end, right).match(/^\s*\{\s*\}/);
                if (braceM) {
                    const openIdx = sp.end + braceM[0].indexOf('{');
                    const closeIdx = sp.end + braceM[0].lastIndexOf('}');
                    info.innerStart = openIdx + 1;
                    info.innerEnd = closeIdx;
                    sp.end += braceM[0].length;
                }
            }
            info.start = sp.start;
            info.end = sp.end;
            return;
        }
        if (node.type === 'supsub') {
            const ordered = info.children.map((item, idx) => ({ item, idx }));
            ordered.sort((a, b) => {
                const aStart = a.item.info.rawMax >= 0 && a.item.info.rawMin >= left && a.item.info.rawMax <= right
                    ? a.item.info.rawMin : null;
                const bStart = b.item.info.rawMax >= 0 && b.item.info.rawMin >= left && b.item.info.rawMax <= right
                    ? b.item.info.rawMin : null;
                if (aStart !== null && bStart !== null) return aStart - bStart;
                if (a.item.role === 'sup' && b.item.role === 'sub' && bStart !== null) return -1;
                if (b.item.role === 'sup' && a.item.role === 'sub' && aStart !== null) return 1;
                return a.idx - b.idx;
            });
            assignKatexSeqSpans(ordered.map(entry => entry.item.info), left, right, tex, mhSpans);
        } else {
            assignKatexSeqSpans(info.children.map(entry => entry.info), left, right, tex, mhSpans);
        }
        let min = direct ? direct.start : Infinity;
        let max = direct ? direct.end : -1;
        for (const { info: childInfo } of info.children) {
            min = Math.min(min, childInfo.start);
            max = Math.max(max, childInfo.end);
        }
        if (min > max) {
            info.start = direct ? direct.start : left;
            info.end = direct ? direct.end : right;
            return;
        }
        let adjStart = min;
        let adjEnd = max;
        if (KATEX_PREFIX_CMDS.has(node.type)) {
            const cmdGap = tex.slice(left, min);
            const m = cmdGap.match(/\\[a-zA-Z]+/g);
            if (m) adjStart = left + cmdGap.lastIndexOf(m[m.length - 1]);
        } else if (node.type === 'leftright') {
            const pre = tex.slice(left, min);
            const preMatches = pre.match(/\\left(?:\s*\\[a-zA-Z]+|\s*\S)|\\begin\s*\{[^}]+\}/g);
            if (preMatches) adjStart = left + pre.lastIndexOf(preMatches[preMatches.length - 1]);
            const post = tex.slice(max, right);
            const postMatch = post.match(/\\right(?:\s*\\[a-zA-Z]+|\s*\S)|\\end\s*\{[^}]+\}/);
            if (postMatch) adjEnd = max + postMatch.index + postMatch[0].length;
        }
        info.start = direct ? direct.start : adjStart;
        info.end = direct ? direct.end : adjEnd;
        if (node.type === 'array' && Array.isArray(node.body)) {
            const arrStart = Math.min(info.start, left);
            const arrEnd = Math.max(info.end, right);
            const cellRanges = computeArrayCellRanges(tex, arrStart, arrEnd);
            node.body.forEach((row, r) => row.forEach((_, c) => {
                const cellInfo = info.byRole[`cell:${r}:${c}`];
                if (cellInfo && cellRanges[r] && cellRanges[r][c]) {
                    cellInfo.cellRange = cellRanges[r][c];
                }
            }));
        }
    }

    function isKatexLineRow(rowEl) {
        return Array.from(rowEl.children || []).some(c =>
            c.classList.contains('frac-line') || c.classList.contains('overline-line') || c.classList.contains('underline-line')
        );
    }

    function isSkippedKatexDom(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        if (el.id === 'phantom-cursor' || el.id === 'latex-preview-phantom') return true;
        const cl = el.classList;
        if (cl.contains('strut') || cl.contains('pstrut') || cl.contains('vlist-s')) return true;
        if (cl.contains('mspace') && !el.textContent) return true;
        if (cl.contains('vlist-r') && !el.textContent && !el.querySelector('svg')) return true;
        return false;
    }

    function getKatexDirectVlistRows(el) {
        const directChildren = Array.from(el.children || []);
        const vt = el.classList.contains('vlist-t') ? el : directChildren.find(c => c.classList.contains('vlist-t'));
        if (!vt) return [];
        const vr = Array.from(vt.children || []).find(c => c.classList.contains('vlist-r'));
        if (!vr) return [];
        const vlist = Array.from(vr.children || []).find(c => c.classList.contains('vlist'));
        return vlist ? Array.from(vlist.children || []).filter(c => !isSkippedKatexDom(c)) : [];
    }

    function matchKatexCompoundDom(el, astType) {
        const cl = el.classList;
        const children = Array.from(el.children || []);
        if (astType === 'genfrac') {
            return cl.contains('mfrac') ? el : (children.find(c => c.classList.contains('mfrac')) || null);
        }
        if (astType === 'supsub') {
            if (cl.contains('op-limits') || cl.contains('mover') || cl.contains('munder')) return el;
            if (children.some(c => c.classList.contains('msupsub'))) return el;
            if (children.length === 1 && children[0].classList.contains('op-limits')) return children[0];
            return null;
        }
        if (astType === 'sqrt') return cl.contains('sqrt') ? el : null;
        if (astType === 'accent' || astType === 'accentUnder') return cl.contains('accent') ? el : null;
        if (astType === 'horizBrace') return (cl.contains('mover') || cl.contains('munder')) ? el : null;
        if (astType === 'xArrow') return cl.contains('x-arrow') ? el : null;
        if (astType === 'overline') return cl.contains('overline') ? el : null;
        if (astType === 'underline') return cl.contains('underline') ? el : null;
        if (astType === 'array') {
            if (cl.contains('mtable')) return el;
            for (const row of getKatexDirectVlistRows(el)) {
                const mt = Array.from(row.children || []).find(c => c.classList.contains('mtable'));
                if (mt) return mt;
            }
            return null;
        }
        if (astType === 'leftright') {
            return cl.contains('minner') && children.some(c => c.classList.contains('mopen') || c.classList.contains('mclose')) ? el : null;
        }
        if (astType === 'enclose') return children.some(c => c.classList.contains('vlist-t')) ? el : null;
        if (astType === 'raisebox') return cl.contains('vlist-t') ? el : null;
        if (astType === 'vphantom' || astType === 'hphantom' || astType === 'lap') {
            return (cl.contains('rlap') || cl.contains('llap')) ? el : null;
        }
        return null;
    }

    function createKatexDomStream(rootEls) {
        const stack = [];
        for (let i = rootEls.length - 1; i >= 0; i -= 1) stack.push({ node: rootEls[i], pos: 0 });
        const expand = el => {
            for (let i = el.childNodes.length - 1; i >= 0; i -= 1) {
                stack.push({ node: el.childNodes[i], pos: 0 });
            }
        };
        return {
            consumeGlyph() {
                while (stack.length) {
                    const top = stack[stack.length - 1];
                    const n = top.node;
                    if (n.nodeType === Node.TEXT_NODE) {
                        if (top.pos >= n.data.length) { stack.pop(); continue; }
                        const cp = n.data.codePointAt(top.pos);
                        if (cp === 0x200b) { top.pos += 1; continue; }
                        const step = cp > 0xffff ? 2 : 1;
                        const start = top.pos;
                        top.pos += step;
                        return { kind: 'char', textNode: n, charStart: start, charEnd: start + step, ch: n.data.slice(start, start + step) };
                    }
                    if (n.nodeType !== Node.ELEMENT_NODE || isSkippedKatexDom(n) || n.classList.contains('nulldelimiter')) {
                        stack.pop();
                        continue;
                    }
                    if (n.classList.contains('delimsizing') && !n.textContent && n.querySelector('svg')) {
                        stack.pop();
                        return { kind: 'el', el: n };
                    }
                    stack.pop();
                    expand(n);
                }
                return null;
            },
            consumeCompound(astType) {
                while (stack.length) {
                    const top = stack[stack.length - 1];
                    const n = top.node;
                    if (n.nodeType !== Node.ELEMENT_NODE || isSkippedKatexDom(n) || n.classList.contains('nulldelimiter')) {
                        stack.pop();
                        continue;
                    }
                    const target = matchKatexCompoundDom(n, astType);
                    if (target) { stack.pop(); return { el: n, target }; }
                    stack.pop();
                    expand(n);
                }
                return null;
            },
            consumeWholeElement(predicate) {
                while (stack.length) {
                    const top = stack[stack.length - 1];
                    const n = top.node;
                    if (n.nodeType !== Node.ELEMENT_NODE || isSkippedKatexDom(n) || n.classList.contains('nulldelimiter')) {
                        stack.pop();
                        continue;
                    }
                    if (predicate(n)) { stack.pop(); return n; }
                    stack.pop();
                    expand(n);
                }
                return null;
            },
            /** Peek/consume an inline empty leaf placeholder (e.g. `<span class="mord text"></span>`) without touching sibling glyphs. */
            consumeEmptyInline() {
                const saved = stack.map(item => ({ node: item.node, pos: item.pos }));
                while (stack.length) {
                    const top = stack[stack.length - 1];
                    const n = top.node;
                    if (n.nodeType === Node.TEXT_NODE) {
                        if (top.pos >= n.data.length) { stack.pop(); continue; }
                        if (n.data.codePointAt(top.pos) === 0x200b) { top.pos += 1; continue; }
                        break;
                    }
                    if (n.nodeType !== Node.ELEMENT_NODE || isSkippedKatexDom(n) || n.classList.contains('nulldelimiter')) {
                        stack.pop();
                        continue;
                    }
                    const cl = n.classList;
                    if (!n.childElementCount && !n.textContent
                        && !cl.contains('frac-line') && !cl.contains('overline-line')
                        && !cl.contains('underline-line') && !cl.contains('fbox')) {
                        stack.pop();
                        return n;
                    }
                    if ((!n.textContent && !n.querySelector('svg')) || cl.contains('base')) {
                        stack.pop();
                        expand(n);
                        continue;
                    }
                    break;
                }
                stack.length = 0;
                for (const item of saved) stack.push(item);
                return null;
            }
        };
    }

    function isDecorOnlyKatexEl(el) {
        const cl = el.classList;
        return cl.contains('pstrut') || cl.contains('strut') || cl.contains('vlist-s')
            || cl.contains('frac-line') || cl.contains('overline-line') || cl.contains('underline-line')
            || cl.contains('fbox') || cl.contains('nulldelimiter') || cl.contains('hide-tail')
            || cl.contains('accent-body');
    }

    /** Pick the innermost empty DOM slot placeholder inside a compound slot element list. */
    function findEmptySlotElement(rootEls) {
        let best = null;
        function walk(el) {
            if (!el || el.nodeType !== Node.ELEMENT_NODE || isDecorOnlyKatexEl(el)) return false;
            if (el.tagName === 'svg' || el.tagName === 'SVG') return false;
            if (!el.childElementCount && !el.textContent) {
                best = el;
                return true;
            }
            for (const ch of el.children) {
                if (walk(ch)) return true;
            }
            if (!best && !el.textContent && !el.querySelector('svg')) best = el;
            return false;
        }
        for (const root of rootEls) {
            if (walk(root)) return best;
        }
        return best;
    }

    function hasRecordedSlot(info) {
        if (!info) return false;
        if (info._slotEl) return true;
        return info.children.some(c => hasRecordedSlot(c.info));
    }

    function alignKatexMhchem(el, mhchem, tex, entries) {
        const items = [];
        (function walkVis(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                for (let i = 0; i < node.data.length;) {
                    const cp = node.data.codePointAt(i);
                    const step = cp > 0xffff ? 2 : 1;
                    if (cp !== 0x200b) {
                        items.push({ kind: 'char', textNode: node, charStart: i, charEnd: i + step, ch: node.data.slice(i, i + step) });
                    }
                    i += step;
                }
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE || isSkippedKatexDom(node) || node.classList.contains('rlap')) return;
            if (node.classList.contains('x-arrow')) {
                items.push({ kind: 'el', el: node, ch: '->' });
                return;
            }
            node.childNodes.forEach(walkVis);
        })(el);
        let pos = mhchem.bodyStart;
        for (const item of items) {
            const needle = item.ch === '−' ? '-' : item.ch;
            let idx = tex.indexOf(needle, pos);
            let len = needle.length;
            if (idx === -1 && (item.ch === '→' || item.ch === '−' || item.ch === '>' || item.ch === '->')) {
                const arrowIdx = tex.indexOf('->', pos);
                if (arrowIdx !== -1 && arrowIdx < mhchem.bodyEnd) {
                    idx = arrowIdx;
                    len = 2;
                }
            }
            if (idx !== -1 && idx < mhchem.bodyEnd) {
                entries.push(item.kind === 'char'
                    ? { kind: 'char', textNode: item.textNode, charStart: item.charStart, charEnd: item.charEnd, start: idx, end: idx + len }
                    : { kind: 'el', el: item.el, start: idx, end: idx + len });
                pos = idx + len;
            }
        }
    }

    function alignKatexSequence(infoList, rootEls, entries, tex, trackSlots) {
        const stream = createKatexDomStream(rootEls);
        for (const info of infoList) alignKatexNode(info, stream, entries, tex, trackSlots);
    }

    function alignKatexNode(info, stream, entries, tex, trackSlots) {
        const before = entries.length;
        alignKatexNodeInner(info, stream, entries, tex, trackSlots);
        if (trackSlots) {
            info._entryStart = before;
            info._entryEnd = entries.length;
        }
    }

    function alignKatexNodeInner(info, stream, entries, tex, trackSlots) {
        const node = info.node;
        if (!node || node.type === 'kern' || node.type === 'cr') return;
        const alignSlot = (childInfo, roleEls) => {
            if (!childInfo || !roleEls || !roleEls.length) return;
            const before = entries.length;
            alignKatexSequence([childInfo], roleEls, entries, tex, trackSlots);
            if (trackSlots && entries.length === before && !hasRecordedSlot(childInfo)) {
                childInfo._slotEl = findEmptySlotElement(roleEls);
            }
        };
        if (info.mhchem) {
            const el = stream.consumeWholeElement(n => n.classList.contains('mord'));
            if (el) {
                const before = entries.length;
                alignKatexMhchem(el, info.mhchem, tex, entries);
                if (trackSlots && entries.length === before) info._slotEl = el;
            }
            return;
        }
        if (node.type === 'supsub') {
            const match = stream.consumeCompound('supsub');
            if (!match) return;
            const target = match.target;
            const rows = getKatexDirectVlistRows(target);
            if (target.classList.contains('op-limits')) {
                let idx = 0;
                if (info.byRole.sub && rows[idx]) alignSlot(info.byRole.sub, [rows[idx++]]);
                if (info.byRole.base && rows[idx]) alignSlot(info.byRole.base, [rows[idx++]]);
                if (info.byRole.sup && rows[idx]) alignSlot(info.byRole.sup, [rows[idx++]]);
                return;
            }
            if (target.classList.contains('mover') || target.classList.contains('munder')) {
                if (target.classList.contains('mover')) {
                    if (info.byRole.base && rows[0]) alignSlot(info.byRole.base, [rows[0]]);
                    if (info.byRole.sup && rows[1]) alignSlot(info.byRole.sup, [rows[1]]);
                } else {
                    if (info.byRole.sub && rows[0]) alignSlot(info.byRole.sub, [rows[0]]);
                    if (info.byRole.base && rows[1]) alignSlot(info.byRole.base, [rows[1]]);
                }
                return;
            }
            const targetChildren = Array.from(target.children || []);
            const msupsub = targetChildren.find(c => c.classList.contains('msupsub'));
            const baseEls = targetChildren.filter(c => c !== msupsub);
            if (info.byRole.base) alignSlot(info.byRole.base, baseEls);
            if (msupsub) {
                const subSupRows = getKatexDirectVlistRows(msupsub);
                let idx = 0;
                if (info.byRole.sub && subSupRows[idx]) alignSlot(info.byRole.sub, [subSupRows[idx++]]);
                if (info.byRole.sup && subSupRows[idx]) alignSlot(info.byRole.sup, [subSupRows[idx++]]);
            }
            return;
        }
        if (node.type === 'genfrac') {
            const match = stream.consumeCompound('genfrac');
            if (!match) return;
            const parentChildren = match.el !== match.target ? Array.from(match.el.children || []) : [];
            const mopen = parentChildren.find(c => c.classList.contains('mopen') && !c.classList.contains('nulldelimiter'));
            const mclose = parentChildren.find(c => c.classList.contains('mclose') && !c.classList.contains('nulldelimiter'));
            if (mopen) entries.push({ kind: 'el', el: mopen, start: info.start, end: info.start + 1 });
            const rows = getKatexDirectVlistRows(match.target).filter(r => !isKatexLineRow(r));
            if (info.byRole.denom && rows[0]) alignSlot(info.byRole.denom, [rows[0]]);
            if (info.byRole.numer && rows[1]) alignSlot(info.byRole.numer, [rows[1]]);
            if (mclose) entries.push({ kind: 'el', el: mclose, start: Math.max(info.start, info.end - 1), end: info.end });
            return;
        }
        if (node.type === 'sqrt') {
            const match = stream.consumeCompound('sqrt');
            if (!match) return;
            const rootEl = Array.from(match.target.children || []).find(c => c.classList.contains('root'));
            if (info.byRole.index && rootEl) alignSlot(info.byRole.index, [rootEl]);
            const rows = getKatexDirectVlistRows(match.target);
            const bodyRow = rows.find(r => r.classList.contains('svg-align')) || rows[0];
            if (info.byRole.body && bodyRow) alignSlot(info.byRole.body, [bodyRow]);
            const sqrtIcon = rows.find(r => !r.classList.contains('svg-align'));
            if (sqrtIcon) entries.push({ kind: 'fallbackEl', el: sqrtIcon, start: info.start, end: info.start });
            return;
        }
        if (node.type === 'xArrow') {
            const match = stream.consumeCompound('xArrow');
            if (!match) return;
            const rows = getKatexDirectVlistRows(match.target).filter(r => !r.classList.contains('svg-align'));
            if (info.byRole.body && rows[0]) alignSlot(info.byRole.body, [rows[0]]);
            if (info.byRole.below && rows[1]) alignSlot(info.byRole.below, [rows[1]]);
            return;
        }
        if (node.type === 'accent' || node.type === 'accentUnder') {
            const match = stream.consumeCompound(node.type);
            if (!match) return;
            const rows = getKatexDirectVlistRows(match.target).filter(
                r => !r.classList.contains('accent-body') && !r.classList.contains('svg-align') && !r.querySelector('.accent-body')
            );
            if (info.byRole.base && rows[0]) alignSlot(info.byRole.base, [rows[0]]);
            return;
        }
        if (node.type === 'horizBrace') {
            const match = stream.consumeCompound('horizBrace');
            if (!match) return;
            const rows = getKatexDirectVlistRows(match.target).filter(r => !r.classList.contains('svg-align'));
            if (info.byRole.base && rows[0]) alignSlot(info.byRole.base, [rows[0]]);
            return;
        }
        if (node.type === 'overline' || node.type === 'underline') {
            const match = stream.consumeCompound(node.type);
            if (!match) return;
            const rows = getKatexDirectVlistRows(match.target).filter(r => !isKatexLineRow(r));
            if (info.byRole.body && rows[0]) alignSlot(info.byRole.body, [rows[0]]);
            return;
        }
        if (node.type === 'enclose') {
            const match = stream.consumeCompound('enclose');
            if (!match) return;
            const box = match.target.querySelector('.boxpad');
            const rows = box ? [box] : getKatexDirectVlistRows(match.target).filter(
                r => !r.classList.contains('svg-align') && !Array.from(r.children || []).some(c => c.classList.contains('fbox'))
            );
            if (info.byRole.body && rows[0]) alignSlot(info.byRole.body, [rows[0]]);
            return;
        }
        if (node.type === 'raisebox') {
            const match = stream.consumeCompound('raisebox');
            if (!match) return;
            const rows = getKatexDirectVlistRows(match.target);
            if (info.byRole.body && rows[0]) alignSlot(info.byRole.body, [rows[0]]);
            return;
        }
        if (node.type === 'leftright') {
            const match = stream.consumeCompound('leftright');
            if (!match) return;
            const ch = Array.from(match.target.children || []);
            const innerEls = ch.slice(1, ch.length - 1);
            const openTok = tex.slice(info.start, info.end).match(/^(?:\\left(?:\s*\\[a-zA-Z]+|\s*\S)|\\begin\s*\{[^}]+\})/);
            const closeTok = tex.slice(info.start, info.end).match(/(?:\\right(?:\s*\\[a-zA-Z]+|\s*\S)|\\end\s*\{[^}]+\})$/);
            if (ch[0] && !ch[0].classList.contains('nulldelimiter')) {
                entries.push({ kind: 'el', el: ch[0], start: info.start, end: info.start + (openTok ? openTok[0].length : 0) });
            }
            alignKatexSequence(info.children.map(c => c.info), innerEls, entries, tex, trackSlots);
            if (ch[ch.length - 1] && !ch[ch.length - 1].classList.contains('nulldelimiter')) {
                entries.push({ kind: 'el', el: ch[ch.length - 1], start: info.end - (closeTok ? closeTok[0].length : 0), end: info.end });
            }
            return;
        }
        if (node.type === 'array') {
            const match = stream.consumeCompound('array');
            if (!match) return;
            const cols = Array.from(match.target.children || []).filter(c => /\bcol-align-/.test(c.className || ''));
            const colRows = cols.map(c => getKatexDirectVlistRows(c));
            node.body.forEach((row, r) => row.forEach((_, c) => {
                const cellInfo = info.byRole[`cell:${r}:${c}`];
                const domCell = colRows[c]?.[r];
                if (!cellInfo || !domCell) return;
                const prevCount = entries.length;
                alignSlot(cellInfo, [domCell]);
                if (entries.length === prevCount) {
                    entries.push({ kind: 'fallbackEl', el: domCell, start: cellInfo.start, end: cellInfo.end });
                }
            }));
            return;
        }
        if (node.type === 'op' && !info.children.length) {
            const el = stream.consumeWholeElement(n => n.classList.contains('mop'));
            if (el) entries.push({ kind: 'el', el, start: info.start, end: info.end });
            return;
        }
        if (node.type === 'htmlmathml') {
            const el = stream.consumeWholeElement(n =>
                n.classList.contains('mrel') || n.classList.contains('mbin') || n.classList.contains('mord')
            );
            if (el) entries.push({ kind: 'el', el, start: info.start, end: info.end });
            return;
        }
        if (node.type === 'vphantom' || node.type === 'hphantom' || node.type === 'lap') {
            stream.consumeWholeElement(n => n.classList.contains('rlap') || n.classList.contains('llap'));
            return;
        }
        if (node.type === 'phantom') {
            const hidden = [];
            for (const c of info.children) alignKatexNode(c.info, stream, hidden, tex, false);
            return;
        }
        if (info.children.length) {
            const before = entries.length;
            for (const c of info.children) alignKatexNode(c.info, stream, entries, tex, trackSlots);
            if (trackSlots && entries.length === before && !hasRecordedSlot(info)) {
                const emptyEl = stream.consumeEmptyInline();
                if (emptyEl) info._slotEl = emptyEl;
            }
            return;
        }
        if (node.type === 'ordgroup' || (trackSlots && (
            node.type === 'text' || node.type === 'styling' || node.type === 'font'
            || node.type === 'color' || node.type === 'sizing' || node.type === 'mclass'
        ))) {
            if (trackSlots) {
                const emptyEl = stream.consumeEmptyInline();
                if (emptyEl) info._slotEl = emptyEl;
            }
            return;
        }
        const g = stream.consumeGlyph();
        if (g) entries.push({ ...g, start: info.start, end: info.end });
    }

    function considerKatexFormulaPoints(katexNode, innerStart, innerEnd, source, displayMode, range, consider) {
        const formulaStart = innerStart - (displayMode && source[innerStart - 2] === '$' ? 2 : (source[innerStart - 1] === '\\' || source[innerStart - 2] === '\\' ? 2 : 1));
        const outerStart = source.startsWith('$$', formulaStart) || source.startsWith('\\[', formulaStart)
            || source.startsWith('\\(', formulaStart)
            ? formulaStart
            : innerStart - 1;
        const spanEnd = Math.min(source.length, innerEnd + (source.startsWith('$$', innerEnd) || source.startsWith('\\]', innerEnd) || source.startsWith('\\)', innerEnd) ? 2 : 1));
        const inner = source.slice(innerStart, innerEnd);
        if (!inner) {
            consider(outerStart, katexNode.getBoundingClientRect(), true);
            return;
        }

        if (katexNode.classList.contains('katex-error')) {
            let charPos = 0;
            const matched = katexNode.textContent === inner;
            const walker = document.createTreeWalker(katexNode, NodeFilter.SHOW_TEXT);
            let tn;
            while ((tn = walker.nextNode())) {
                for (let i = 0; i <= tn.length;) {
                    range.setStart(tn, i);
                    range.collapse(true);
                    for (const rect of range.getClientRects()) {
                        const mapped = matched ? innerStart + charPos + i : innerStart;
                        consider(mapped, rect);
                    }
                    if (i === tn.length) break;
                    i += tn.data.codePointAt(i) > 0xffff ? 2 : 1;
                }
                charPos += tn.length;
            }
            if (charPos === 0) consider(innerStart, katexNode.getBoundingClientRect(), true);
            return;
        }

        const katexHtml = katexNode.querySelector('.katex-html');
        if (!katexHtml || typeof katex === 'undefined' || typeof katex.__parse !== 'function') {
            consider(outerStart, katexNode.getBoundingClientRect(), true);
            return;
        }

        const entries = [];
        try {
            const ast = katex.__parse(inner, { displayMode, throwOnError: false });
            const mhSpans = findKatexMhchemSpans(inner);
            const infos = ast.map(n => buildKatexAstInfo(n, inner.length, false)).filter(Boolean);
            assignKatexSeqSpans(infos, 0, inner.length, inner, mhSpans);
            const bases = Array.from(katexHtml.children || []).filter(c => c.classList.contains('base'));
            alignKatexSequence(infos, bases, entries, inner);
        } catch {
            consider(outerStart, katexNode.getBoundingClientRect(), true);
            return;
        }

        let emitted = 0;
        let contentLeft = Infinity;
        let contentRight = -Infinity;
        let firstTop = 0;
        let firstBottom = 0;
        let lastTop = 0;
        let lastBottom = 0;

        const emitRectPair = (rect, startOff, endOff) => {
            if (!rect || !rect.height) return;
            emitted += 1;
            if (rect.left < contentLeft) {
                contentLeft = rect.left;
                firstTop = rect.top;
                firstBottom = rect.bottom;
            }
            if (rect.right > contentRight) {
                contentRight = rect.right;
                lastTop = rect.top;
                lastBottom = rect.bottom;
            }
            const inset = Math.min(0.8, rect.width * 0.15);
            consider(innerStart + startOff, {
                left: rect.left + inset,
                right: rect.left + inset,
                top: rect.top,
                bottom: rect.bottom,
                height: rect.height
            });
            consider(innerStart + endOff, {
                left: rect.right - inset,
                right: rect.right - inset,
                top: rect.top,
                bottom: rect.bottom,
                height: rect.height
            });
        };

        for (const entry of entries) {
            if (entry.kind === 'char') {
                range.setStart(entry.textNode, entry.charStart);
                range.setEnd(entry.textNode, entry.charEnd);
                emitRectPair(range.getBoundingClientRect(), entry.start, entry.end);
            } else if (entry.kind === 'el' && entry.el) {
                emitRectPair(entry.el.getBoundingClientRect(), entry.start, entry.end);
            }
        }
        if (emitted === 0) {
            for (const entry of entries) {
                if (entry.kind === 'fallbackEl' && entry.el) {
                    emitRectPair(entry.el.getBoundingClientRect(), entry.start, entry.end);
                }
            }
        }
        if (emitted === 0) {
            consider(outerStart, katexNode.getBoundingClientRect(), true);
            return;
        }
        // Allow clicking far outside either edge of an isolated formula to land outside delimiters.
        consider(outerStart, {
            left: contentLeft - 4,
            right: contentLeft - 4,
            top: firstTop,
            bottom: firstBottom,
            height: firstBottom - firstTop
        });
        consider(spanEnd, {
            left: contentRight + 4,
            right: contentRight + 4,
            top: lastTop,
            bottom: lastBottom,
            height: lastBottom - lastTop
        });
    }

    // 按渲染后的 DOM 顺序还原源码偏移，跳过幻影光标和 KaTeX 的重复 MathML。
    // 普通文字与 KaTeX 公式内部均精确到源码字符/记号边界；TikZ 图形仍作为一个整体。
    function textAnnotationOffsetAtPoint(div, source, clientX, clientY) {
        if (!source) return 0;
        const tikzBlocks = scanTikzBlocks(source, false);
        const range = document.createRange();
        let offset = 0;
        let best = { offset: 0, dy: Infinity, dx: Infinity };
        const consider = (index, rect, isBlock = false) => {
            if (!rect.height) return;
            const dy = Math.max(rect.top - clientY, clientY - rect.bottom, 0);
            const dx = isBlock
                ? Math.max(rect.left - clientX, clientX - rect.right, 0)
                : Math.abs(clientX - rect.left);
            if (dy < best.dy || (dy === best.dy && dx < best.dx)) best = { offset: index, dy, dx };
        };
        const visit = node => {
            if (node.nodeType === Node.TEXT_NODE) {
                // 使用 UTF-16 偏移，且不把光标放在一个 emoji 的代理对中间。
                for (let i = 0; i <= node.length;) {
                    range.setStart(node, i);
                    range.collapse(true);
                    const rects = range.getClientRects();
                    for (const rect of rects) consider(offset + i, rect);
                    if (i === node.length) break;
                    const step = node.data.codePointAt(i) > 0xffff ? 2 : 1;
                    // 连续换行中的空行没有折叠 Range，选中换行符才能取得其行框。
                    if (!rects.length) {
                        range.setEnd(node, i + step);
                        for (const rect of range.getClientRects()) consider(offset + i, rect);
                    }
                    i += step;
                }
                offset += node.length;
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE || node.id === 'phantom-cursor' || node.id === 'latex-preview-phantom') return;
            if (node.classList.contains('ignored-by-katex')) {
                const block = tikzBlocks.find(item => item.start === offset);
                if (block) {
                    consider(block.start, node.getBoundingClientRect(), true);
                    offset = block.end;
                    return;
                }
            }
            if (node.classList.contains('katex') || node.classList.contains('katex-error')) {
                const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent
                    ?? node.textContent;
                const delimiters = [['$$', '$$'], ['$', '$'], ['\\(', '\\)'], ['\\[', '\\]']];
                let delimiter = delimiters.find(([left, right]) => source.startsWith(left + tex + right, offset));
                let spanLength = delimiter ? delimiter[0].length + tex.length + delimiter[1].length : 0;
                if (!delimiter && tex) {
                    delimiter = delimiters.find(([left, right]) => {
                        if (!source.startsWith(left, offset)) return false;
                        const endIdx = source.indexOf(right, offset + left.length);
                        if (endIdx === -1) return false;
                        const inner = source.slice(offset + left.length, endIdx);
                        if (inner.trim() === tex.trim()) {
                            spanLength = (endIdx + right.length) - offset;
                            return true;
                        }
                        return false;
                    });
                }
                if (delimiter) {
                    const innerStart = offset + delimiter[0].length;
                    const innerEnd = offset + spanLength - delimiter[1].length;
                    const displayMode = delimiter[0] === '$$' || delimiter[0] === '\\[';
                    considerKatexFormulaPoints(node, innerStart, innerEnd, source, displayMode, range, consider);
                    offset += spanLength;
                    return;
                }
            }
            node.childNodes.forEach(visit);
        };
        visit(div);
        return Math.min(best.offset, source.length);
    }

    const MATH_BLOCK_REGEX = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\(.*?\\\)|\$[^$\n]*?\$)/g;

    /** Find the math delimiter block matching `injectPhantomCursor` around `cursorOffset`. */
    function findMathBlockAtCursor(source, cursorOffset) {
        if (!source) return null;
        MATH_BLOCK_REGEX.lastIndex = 0;
        let match;
        while ((match = MATH_BLOCK_REGEX.exec(source)) !== null) {
            const start = match.index;
            const raw = match[0];
            const end = start + raw.length;
            if (cursorOffset >= start && cursorOffset <= end) {
                let openLen = 1;
                let closeLen = 1;
                let displayMode = false;
                if (raw.startsWith('$$')) {
                    openLen = 2;
                    closeLen = raw.length >= 4 && raw.endsWith('$$') ? 2 : 0;
                    displayMode = true;
                } else if (raw.startsWith('\\[')) {
                    openLen = 2;
                    closeLen = raw.endsWith('\\]') ? 2 : 0;
                    displayMode = true;
                } else if (raw.startsWith('\\(')) {
                    openLen = 2;
                    closeLen = raw.endsWith('\\)') ? 2 : 0;
                }
                return { start, end, raw, openLen, closeLen, displayMode };
            }
        }
        return null;
    }

    function getElementZoomScale(el) {
        const host = el && el.closest ? (el.closest('.text-annotation') || el.closest('.katex') || el) : el;
        if (host && host.offsetHeight > 0) {
            const ratio = host.getBoundingClientRect().height / host.offsetHeight;
            if (ratio > 0.05 && Number.isFinite(ratio)) return ratio;
        }
        return 1;
    }

    function baselineRectForContainer(el, displayMode, fallbackEl) {
        const target = el || fallbackEl;
        if (!target) return null;
        const rect = target.getBoundingClientRect();
        const cs = getComputedStyle(target);
        const scale = getElementZoomScale(target);
        const fs = (parseFloat(cs.fontSize) || 18) * scale;
        if (rect.height > 1 && (rect.height <= fs * 1.85 || (!displayMode && rect.height <= fs * 2.2))) {
            return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
        }
        if (rect.height > 1) {
            const h = Math.max(fs * 1.3, 12 * scale);
            const mid = (rect.top + rect.bottom) / 2;
            return { left: rect.left, right: rect.right, top: mid - h / 2, width: rect.width, height: h };
        }
        const hostRect = (fallbackEl || target).getBoundingClientRect();
        const left = displayMode && hostRect.width > 0 ? hostRect.left + hostRect.width / 2 : rect.left;
        const h = Math.max(fs * 1.15, 10 * scale);
        return { left, right: left, top: rect.top - fs * 0.9, width: 0, height: h };
    }

    /** Compute caret rect for an empty KaTeX container slot (handles vlist 0-height, sqrt paddingLeft, and zoom). */
    function emptySlotCaretRect(slotEl) {
        if (!slotEl) return null;
        const rect = slotEl.getBoundingClientRect();
        const cs = getComputedStyle(slotEl);
        const scale = getElementZoomScale(slotEl);
        const padLeft = (parseFloat(cs.paddingLeft) || 0) * scale;
        const left = rect.left + padLeft;
        if (rect.height > 1) {
            return { left, right: left, top: rect.top, width: 0, height: rect.height };
        }
        const fs = (parseFloat(cs.fontSize) || 18) * scale;
        const height = Math.max(fs * 1.15, 7 * scale);
        const top = rect.top - fs * 0.9;
        return { left, right: left, top, width: 0, height };
    }

    function findFirstSlotInSubtree(info) {
        if (!info) return null;
        if (info._slotEl) return info._slotEl;
        for (const c of info.children) {
            const s = findFirstSlotInSubtree(c.info);
            if (s) return s;
        }
        return null;
    }

    function entryClientRect(entry) {
        if (!entry) return null;
        if (entry.kind === 'char' && entry.textNode) {
            const len = entry.textNode.data.length;
            const s = Math.max(0, Math.min(len, entry.charStart));
            const e = Math.max(s, Math.min(len, entry.charEnd));
            const range = document.createRange();
            range.setStart(entry.textNode, s);
            range.setEnd(entry.textNode, e);
            const r = range.getBoundingClientRect();
            if (r.width > 0 || r.height > 0) return r;
            if (entry.textNode.parentElement) return entry.textNode.parentElement.getBoundingClientRect();
        }
        if (entry.el) return entry.el.getBoundingClientRect();
        return null;
    }

    /** Compute a text-offset caret rect via Range inside raw unrendered math or `.katex-error`. */
    function caretAtRangeOffset(containerEl, offset, expectedLen, fallbackRect) {
        if (!containerEl) return null;
        const nodes = [];
        let total = 0;
        const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
        let tn;
        while ((tn = walker.nextNode())) {
            nodes.push({ node: tn, start: total, end: total + tn.data.length });
            total += tn.data.length;
        }
        if (!nodes.length) {
            return {
                left: fallbackRect.left,
                top: fallbackRect.top,
                height: Math.max(fallbackRect.height, 14)
            };
        }
        const scaled = expectedLen > 0 && total !== expectedLen
            ? Math.round((Math.max(0, Math.min(expectedLen, offset)) / expectedLen) * total)
            : offset;
        const clamped = Math.max(0, Math.min(total, scaled));
        let chosen = nodes[nodes.length - 1];
        for (const item of nodes) {
            if (clamped <= item.end) {
                chosen = item;
                break;
            }
        }
        const local = Math.max(0, Math.min(chosen.node.data.length, clamped - chosen.start));
        const range = document.createRange();
        range.setStart(chosen.node, local);
        range.collapse(true);
        const r = range.getBoundingClientRect();
        if (r.height > 0) return { left: r.left, top: r.top, height: r.height };
        return {
            left: r.left || fallbackRect.left,
            top: fallbackRect.top,
            height: Math.max(fallbackRect.height, 14)
        };
    }

    function unionRectBoxes(boxes) {
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (const r of boxes) {
            if (!r) continue;
            if (r.left < left) left = r.left;
            if (r.top < top) top = r.top;
            if ((r.right != null ? r.right : r.left + r.width) > right) {
                right = r.right != null ? r.right : r.left + r.width;
            }
            if ((r.bottom != null ? r.bottom : r.top + r.height) > bottom) {
                bottom = r.bottom != null ? r.bottom : r.top + r.height;
            }
        }
        if (left === Infinity) return null;
        return { left, right, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    }

    function infoVisualBox(info, entries) {
        if (!info) return null;
        if (info._entryEnd > info._entryStart) {
            const rects = [];
            for (let i = info._entryStart; i < info._entryEnd; i += 1) {
                const r = entryClientRect(entries[i]);
                if (r && (r.width > 0 || r.height > 0)) rects.push(r);
            }
            const u = unionRectBoxes(rects);
            if (u) return u;
        }
        const slotEl = findFirstSlotInSubtree(info);
        if (slotEl) return emptySlotCaretRect(slotEl);
        return null;
    }

    function isCompoundKatexType(type) {
        return type === 'supsub' || type === 'genfrac' || type === 'sqrt' || type === 'xArrow'
            || type === 'accent' || type === 'accentUnder' || type === 'horizBrace'
            || type === 'overline' || type === 'underline' || type === 'enclose'
            || type === 'raisebox' || type === 'array' || type === 'leftright';
    }

    function baselineForSequence(seqInfos, entries, fallbackBox) {
        for (const info of seqInfos) {
            if (!info || info.node.type === 'kern' || info.node.type === 'cr') continue;
            if (!isCompoundKatexType(info.node.type) && info._entryEnd > info._entryStart) {
                for (let i = info._entryStart; i < info._entryEnd; i += 1) {
                    const r = entryClientRect(entries[i]);
                    if (r && r.height > 1) return { left: fallbackBox.left, top: r.top, height: r.height };
                }
            }
        }
        for (const info of seqInfos) {
            if (info && info.node.type === 'supsub' && info.byRole.base) {
                const baseBox = infoVisualBox(info.byRole.base, entries);
                if (baseBox && baseBox.height > 1) return { left: fallbackBox.left, top: baseBox.top, height: baseBox.height };
            }
        }
        return { left: fallbackBox.left, top: fallbackBox.top, height: fallbackBox.height };
    }

    /** Find the source [innerStart, innerEnd] of a braced/delimited AST container if enterable. */
    function containerInnerRange(info, tex) {
        if (!info) return null;
        if (info.mhchem) return [info.mhchem.bodyStart, info.mhchem.bodyEnd];
        if (info.cellRange) return info.cellRange;
        if (info.node.type === 'text' && info.innerStart != null) return [info.innerStart, info.innerEnd];
        const loc = info.node.loc;
        const fromTex = !loc || !loc.lexer || loc.lexer.input === tex;
        if (fromTex && (info.node.type === 'ordgroup' || info.node.type === 'styling'
            || info.node.type === 'font' || info.node.type === 'color'
            || info.node.type === 'sizing' || info.node.type === 'mclass')) {
            if (info.end - info.start >= 2) {
                const a = tex[info.start];
                const b = tex[info.end - 1];
                if ((a === '{' && b === '}') || (a === '[' && b === ']')) {
                    return [info.start + 1, info.end - 1];
                }
            }
        }
        if (info.node.type === 'leftright') {
            const slice = tex.slice(info.start, info.end);
            const openTok = slice.match(/^(?:\\left(?:\s*\\[a-zA-Z]+|\s*\S)|\\begin\s*\{[^}]+\})/);
            const closeTok = slice.match(/(?:\\right(?:\s*\\[a-zA-Z]+|\s*\S)|\\end\s*\{[^}]+\})$/);
            const s = info.start + (openTok ? openTok[0].length : 0);
            const e = info.end - (closeTok ? closeTok[0].length : 0);
            if (s <= e) return [s, e];
        }
        if (info.node.type === 'enclose' && info.children.length) {
            const childLoc = info.children[0].info.node.loc;
            if (childLoc && childLoc.lexer && childLoc.lexer.input !== tex) {
                const openIdx = tex.indexOf('{', info.start);
                if (openIdx !== -1 && openIdx < info.end && tex[info.end - 1] === '}') {
                    return [openIdx + 1, info.end - 1];
                }
            }
        }
        return null;
    }

    function didEnterScope(info, offset, tex, strictUnbraced) {
        if (!info) return false;
        const inner = containerInnerRange(info, tex);
        if (inner) return offset >= inner[0] && offset <= inner[1];
        if (!strictUnbraced) return false;
        if (info.node.type === 'ordgroup' || info.node.type === 'styling'
            || info.node.type === 'font' || info.node.type === 'color'
            || info.node.type === 'sizing' || info.node.type === 'mclass') {
            if (info.children.some(c => didEnterScope(c.info, offset, tex, true))) return true;
        }
        return offset >= info.start && offset < info.end;
    }

    function resolveFlatEntriesCaret(entriesList, offset, baselineBox) {
        const items = [];
        for (const e of entriesList) {
            const r = entryClientRect(e);
            if (r) items.push({ start: e.start, end: e.end, box: r });
        }
        if (!items.length) return { left: baselineBox.left, top: baselineBox.top, height: baselineBox.height };
        items.sort((a, b) => a.start - b.start || a.end - b.end);
        for (const item of items) {
            if (item.start < offset && offset < item.end) {
                const ratio = (offset - item.start) / Math.max(1, item.end - item.start);
                return { left: item.box.left + ratio * item.box.width, top: item.box.top, height: item.box.height };
            }
        }
        let prev = null;
        let next = null;
        for (const item of items) {
            if (item.end <= offset) prev = item;
            else if (!next && item.start >= offset) next = item;
        }
        if (!prev && next) return { left: next.box.left, top: next.box.top, height: next.box.height };
        if (prev && !next) return { left: prev.box.right, top: prev.box.top, height: prev.box.height };
        if (prev && next) {
            const span = Math.max(1, next.start - prev.end);
            const t = Math.max(0, Math.min(1, (offset - prev.end) / span));
            const left = prev.box.right + t * Math.max(0, next.box.left - prev.box.right);
            const ref = t <= 0.5 ? prev : next;
            return { left, top: ref.box.top, height: ref.box.height };
        }
        return { left: baselineBox.left, top: baselineBox.top, height: baselineBox.height };
    }

    function resolveCompoundCaret(info, offset, tex, entries, seqBaseline) {
        const node = info.node;
        const box = infoVisualBox(info, entries) || seqBaseline;

        if (info.mhchem) {
            const sub = entries.slice(info._entryStart, info._entryEnd);
            if (!sub.length) {
                return info._slotEl ? emptySlotCaretRect(info._slotEl) : box;
            }
            return resolveFlatEntriesCaret(sub, offset, box);
        }

        if (node.type === 'array') {
            for (const c of info.children) {
                const r = c.info.cellRange;
                if (r && offset >= r[0] && offset <= r[1]) {
                    const slotEl = findFirstSlotInSubtree(c.info);
                    const cellFallback = slotEl ? emptySlotCaretRect(slotEl) : { ...box, ...seqBaseline };
                    if (c.info._entryEnd <= c.info._entryStart) return cellFallback;
                    return resolveCaretInSequence([c.info], offset, tex, entries, cellFallback);
                }
            }
            const firstCellEnd = info.children[0]?.info?.cellRange?.[0] ?? info.start;
            return {
                left: offset <= firstCellEnd ? box.left : box.right,
                top: seqBaseline.top,
                height: seqBaseline.height
            };
        }

        if (node.type === 'supsub') {
            for (const role of ['sub', 'sup']) {
                const child = info.byRole[role];
                if (child && didEnterScope(child, offset, tex, true)) {
                    const childFb = findFirstSlotInSubtree(child)
                        ? emptySlotCaretRect(findFirstSlotInSubtree(child)) : seqBaseline;
                    return resolveCaretInSequence([child], offset, tex, entries, childFb);
                }
            }
            const base = info.byRole.base;
            if (base) {
                const firstScriptStart = Math.min(
                    info.byRole.sub ? info.byRole.sub.start : Infinity,
                    info.byRole.sup ? info.byRole.sup.start : Infinity
                );
                if (didEnterScope(base, offset, tex, true)) {
                    const baseFb = infoVisualBox(base, entries) || seqBaseline;
                    return resolveCaretInSequence([base], offset, tex, entries, baseFb);
                }
                const baseBox = infoVisualBox(base, entries);
                if (baseBox && offset >= base.end && offset <= firstScriptStart) {
                    return { left: baseBox.right, top: baseBox.top, height: baseBox.height };
                }
                if (baseBox && offset <= base.start) {
                    return { left: baseBox.left, top: baseBox.top, height: baseBox.height };
                }
            }
            return { left: offset >= info.end ? box.right : box.left, top: seqBaseline.top, height: seqBaseline.height };
        }

        if (node.type === 'enclose' && info.children.length) {
            const inner = containerInnerRange(info, tex);
            if (inner && offset >= inner[0] && offset <= inner[1]) {
                const slotEl = findFirstSlotInSubtree(info);
                const fb = slotEl ? emptySlotCaretRect(slotEl) : box;
                if (info._entryEnd <= info._entryStart) return fb;
                return resolveFlatEntriesCaret(entries.slice(info._entryStart, info._entryEnd), offset, fb);
            }
            return { left: offset <= (inner ? inner[0] : info.start) ? box.left : box.right, top: seqBaseline.top, height: seqBaseline.height };
        }

        if (node.type === 'leftright') {
            const inner = containerInnerRange(info, tex);
            if (inner && offset >= inner[0] && offset <= inner[1]) {
                return resolveCaretInSequence(info.children.map(c => c.info), offset, tex, entries, seqBaseline);
            }
            return { left: offset < (inner ? inner[0] : info.end) ? box.left : box.right, top: seqBaseline.top, height: seqBaseline.height };
        }

        for (const c of info.children) {
            if (didEnterScope(c.info, offset, tex, true)) {
                const slotEl = findFirstSlotInSubtree(c.info);
                const childFb = slotEl ? emptySlotCaretRect(slotEl) : seqBaseline;
                return resolveCaretInSequence([c.info], offset, tex, entries, childFb);
            }
        }

        if (isCompoundKatexType(node.type)) {
            return { left: offset >= info.end ? box.right : box.left, top: seqBaseline.top, height: seqBaseline.height };
        }

        if (info.children.length) {
            const slotEl = findFirstSlotInSubtree(info);
            const fb = slotEl ? emptySlotCaretRect(slotEl) : box;
            return resolveCaretInSequence(info.children.map(c => c.info), offset, tex, entries, fb);
        }
        return info._slotEl ? emptySlotCaretRect(info._slotEl) : box;
    }

    function resolveCaretInSequence(seqInfos, offset, tex, entries, fallbackBox) {
        const visibleInfos = seqInfos.filter(info => info && info.node.type !== 'kern' && info.node.type !== 'cr');
        if (!visibleInfos.length) {
            return { left: fallbackBox.left, top: fallbackBox.top, height: fallbackBox.height };
        }
        const seqBaseline = baselineForSequence(visibleInfos, entries, fallbackBox);

        for (const info of visibleInfos) {
            const isLeaf = !info.children.length && !info.mhchem && info.node.type !== 'array' && info.node.type !== 'enclose';
            if (!isLeaf && (didEnterScope(info, offset, tex, false)
                || (isCompoundKatexType(info.node.type) && offset > info.start && offset < info.end))) {
                return resolveCompoundCaret(info, offset, tex, entries, seqBaseline);
            }
        }

        const items = [];
        for (const info of visibleInfos) {
            const box = infoVisualBox(info, entries);
            if (!box) continue;
            items.push({ info, start: info.start, end: info.end, box });
        }
        if (!items.length) {
            return { left: seqBaseline.left ?? fallbackBox.left, top: seqBaseline.top, height: seqBaseline.height };
        }

        for (const item of items) {
            if (item.start < offset && offset < item.end) {
                if (item.info.children.length || item.info.mhchem) {
                    return resolveCompoundCaret(item.info, offset, tex, entries, seqBaseline);
                }
                if (item.info._slotEl && item.info._entryEnd <= item.info._entryStart) {
                    return { left: item.box.left, top: item.box.top, height: item.box.height };
                }
                const ratio = (offset - item.start) / Math.max(1, item.end - item.start);
                return {
                    left: item.box.left + ratio * (item.box.width || 0),
                    top: item.box.top,
                    height: item.box.height
                };
            }
        }

        let prev = null;
        let next = null;
        for (const item of items) {
            if (item.end <= offset) prev = item;
            else if (!next && item.start >= offset) next = item;
        }
        const pickVertical = (item) => {
            if (!item || isCompoundKatexType(item.info.node.type)) return seqBaseline;
            return { top: item.box.top, height: item.box.height };
        };
        if (!prev && next) {
            const v = pickVertical(next);
            return { left: next.box.left, top: v.top, height: v.height };
        }
        if (prev && !next) {
            const v = pickVertical(prev);
            return { left: prev.box.right, top: v.top, height: v.height };
        }
        if (prev && next) {
            const span = Math.max(1, next.start - prev.end);
            const t = Math.max(0, Math.min(1, (offset - prev.end) / span));
            const left = prev.box.right + t * Math.max(0, next.box.left - prev.box.right);
            const v = pickVertical(t <= 0.5 ? prev : next);
            return { left, top: v.top, height: v.height };
        }
        return { left: fallbackBox.left, top: seqBaseline.top, height: seqBaseline.height };
    }

    /** Compute viewport-space `{ left, top, height }` for the cursor inside a rendered `#...-block` formula. */
    function formulaCursorRect(blockEl, source, cursorOffset) {
        if (!blockEl || typeof source !== 'string') return null;
        const block = findMathBlockAtCursor(source, cursorOffset);
        if (!block) return null;
        const localOffset = Math.max(0, Math.min(block.raw.length, cursorOffset - block.start));
        const inner = block.raw.slice(block.openLen, block.raw.length - block.closeLen);
        const innerOffset = Math.max(0, Math.min(inner.length, localOffset - block.openLen));

        const katexErrorEl = blockEl.classList?.contains('katex-error') ? blockEl : blockEl.querySelector('.katex-error');
        const katexNode = blockEl.classList?.contains('katex') ? blockEl : blockEl.querySelector('.katex');

        if (!katexNode && !katexErrorEl) {
            return caretAtRangeOffset(blockEl, localOffset, block.raw.length, blockEl.getBoundingClientRect());
        }
        if (katexErrorEl) {
            return caretAtRangeOffset(katexErrorEl, innerOffset, inner.length, katexErrorEl.getBoundingClientRect());
        }

        const katexHtml = katexNode.querySelector('.katex-html');
        const fallbackBox = baselineRectForContainer(katexHtml || katexNode, block.displayMode, blockEl);
        if (!katexHtml || !inner.trim() || typeof katex === 'undefined' || typeof katex.__parse !== 'function') {
            return fallbackBox;
        }

        try {
            const entries = [];
            const ast = katex.__parse(inner, { displayMode: block.displayMode, throwOnError: false });
            const mhSpans = findKatexMhchemSpans(inner);
            const infos = ast.map(n => buildKatexAstInfo(n, inner.length, false, false)).filter(Boolean);
            assignKatexSeqSpans(infos, 0, inner.length, inner, mhSpans);
            const bases = Array.from(katexHtml.children || []).filter(c => c.classList.contains('base'));
            alignKatexSequence(infos, bases, entries, inner, true);
            if (!entries.length && infos.length === 0) {
                const emptySlot = findEmptySlotElement([katexHtml]);
                if (emptySlot) return emptySlotCaretRect(emptySlot);
            }
            const rect = resolveCaretInSequence(infos, innerOffset, inner, entries, fallbackBox);
            return rect || fallbackBox;
        } catch {
            return fallbackBox;
        }
    }

    window.considerKatexFormulaPoints = considerKatexFormulaPoints;
    window.textAnnotationOffsetAtPoint = textAnnotationOffsetAtPoint;
    window.formulaCursorRect = formulaCursorRect;
})();
