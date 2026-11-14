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
    function buildKatexAstInfo(node, texLen, tainted) {
        if (!node || typeof node !== 'object') return null;
        const selfTainted = tainted || node.type === 'htmlmathml';
        const loc = !selfTainted && node.loc && typeof node.loc.start === 'number' && typeof node.loc.end === 'number'
            && node.loc.start >= 0 && node.loc.end <= texLen && node.loc.start <= node.loc.end
            ? { start: node.loc.start, end: node.loc.end }
            : null;
        let rawMin = Infinity;
        let rawMax = -1;
        const children = [];
        for (const spec of getKatexNodeSpecs(node)) {
            const childInfo = buildKatexAstInfo(spec.node, texLen, selfTainted);
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
            start: 0,
            end: 0,
            mhchem: null
        };
    }

    function findTokenInKatexGap(tex, start, end, node) {
        let s = start;
        while (s < end && /\s/.test(tex[s])) s += 1;
        if (s >= end) return { start: Math.min(start, tex.length), end: Math.min(start, tex.length) };
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
                info.node.type === 'ordgroup' && info.node.loc && info.node.loc.end > tex.length
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

    function assignKatexNodeSpan(info, left, right, tex, mhSpans) {
        const node = info.node;
        const direct = info.direct && info.direct.start >= left && info.direct.end <= right
            ? { start: info.direct.start, end: trimKatexCommandSpace(tex, info.direct.start, info.direct.end) }
            : null;
        if (node.type === 'htmlmathml') {
            const tok = findTokenInKatexGap(tex, left, right, node);
            info.start = tok.start;
            info.end = tok.end;
            return;
        }
        if (!info.children.length) {
            const sp = direct || findTokenInKatexGap(tex, left, right, node);
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
            }
        };
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

    function alignKatexSequence(infoList, rootEls, entries, tex) {
        const stream = createKatexDomStream(rootEls);
        for (const info of infoList) alignKatexNode(info, stream, entries, tex);
    }

    function alignKatexNode(info, stream, entries, tex) {
        const node = info.node;
        if (!node || node.type === 'kern' || node.type === 'cr') return;
        if (info.mhchem) {
            const el = stream.consumeWholeElement(n => n.classList.contains('mord'));
            if (el) alignKatexMhchem(el, info.mhchem, tex, entries);
            return;
        }
        if (node.type === 'supsub') {
            const match = stream.consumeCompound('supsub');
            if (!match) return;
            const target = match.target;
            const rows = getKatexDirectVlistRows(target);
            if (target.classList.contains('op-limits')) {
                let idx = 0;
                if (info.byRole.sub && rows[idx]) alignKatexSequence([info.byRole.sub], [rows[idx++]], entries, tex);
                if (info.byRole.base && rows[idx]) alignKatexSequence([info.byRole.base], [rows[idx++]], entries, tex);
                if (info.byRole.sup && rows[idx]) alignKatexSequence([info.byRole.sup], [rows[idx++]], entries, tex);
                return;
            }
            if (target.classList.contains('mover') || target.classList.contains('munder')) {
                if (target.classList.contains('mover')) {
                    if (info.byRole.base && rows[0]) alignKatexSequence([info.byRole.base], [rows[0]], entries, tex);
                    if (info.byRole.sup && rows[1]) alignKatexSequence([info.byRole.sup], [rows[1]], entries, tex);
                } else {
                    if (info.byRole.sub && rows[0]) alignKatexSequence([info.byRole.sub], [rows[0]], entries, tex);
                    if (info.byRole.base && rows[1]) alignKatexSequence([info.byRole.base], [rows[1]], entries, tex);
                }
                return;
            }
            const targetChildren = Array.from(target.children || []);
            const msupsub = targetChildren.find(c => c.classList.contains('msupsub'));
            const baseEls = targetChildren.filter(c => c !== msupsub);
            if (info.byRole.base) alignKatexSequence([info.byRole.base], baseEls, entries, tex);
            if (msupsub) {
                const subSupRows = getKatexDirectVlistRows(msupsub);
                let idx = 0;
                if (info.byRole.sub && subSupRows[idx]) alignKatexSequence([info.byRole.sub], [subSupRows[idx++]], entries, tex);
                if (info.byRole.sup && subSupRows[idx]) alignKatexSequence([info.byRole.sup], [subSupRows[idx++]], entries, tex);
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
            if (info.byRole.denom && rows[0]) alignKatexSequence([info.byRole.denom], [rows[0]], entries, tex);
            if (info.byRole.numer && rows[1]) alignKatexSequence([info.byRole.numer], [rows[1]], entries, tex);
            if (mclose) entries.push({ kind: 'el', el: mclose, start: Math.max(info.start, info.end - 1), end: info.end });
            return;
        }
        if (node.type === 'sqrt') {
            const match = stream.consumeCompound('sqrt');
            if (!match) return;
            const rootEl = Array.from(match.target.children || []).find(c => c.classList.contains('root'));
            if (info.byRole.index && rootEl) alignKatexSequence([info.byRole.index], [rootEl], entries, tex);
            const rows = getKatexDirectVlistRows(match.target);
            const bodyRow = rows.find(r => r.classList.contains('svg-align')) || rows[0];
            if (info.byRole.body && bodyRow) alignKatexSequence([info.byRole.body], [bodyRow], entries, tex);
            const sqrtIcon = rows.find(r => !r.classList.contains('svg-align'));
            if (sqrtIcon) entries.push({ kind: 'fallbackEl', el: sqrtIcon, start: info.start, end: info.start });
            return;
        }
        if (node.type === 'xArrow') {
            const match = stream.consumeCompound('xArrow');
            if (!match) return;
            const rows = getKatexDirectVlistRows(match.target).filter(r => !r.classList.contains('svg-align'));
            if (info.byRole.body && rows[0]) alignKatexSequence([info.byRole.body], [rows[0]], entries, tex);
            if (info.byRole.below && rows[1]) alignKatexSequence([info.byRole.below], [rows[1]], entries, tex);
            return;
        }
        if (node.type === 'accent' || node.type === 'accentUnder') {
            const match = stream.consumeCompound(node.type);
            if (!match) return;
            const rows = getKatexDirectVlistRows(match.target).filter(
                r => !r.classList.contains('accent-body') && !r.classList.contains('svg-align') && !r.querySelector('.accent-body')
            );
            if (info.byRole.base && rows[0]) alignKatexSequence([info.byRole.base], [rows[0]], entries, tex);
            return;
        }
        if (node.type === 'horizBrace') {
            const match = stream.consumeCompound('horizBrace');
            if (!match) return;
            const rows = getKatexDirectVlistRows(match.target).filter(r => !r.classList.contains('svg-align'));
            if (info.byRole.base && rows[0]) alignKatexSequence([info.byRole.base], [rows[0]], entries, tex);
            return;
        }
        if (node.type === 'overline' || node.type === 'underline') {
            const match = stream.consumeCompound(node.type);
            if (!match) return;
            const rows = getKatexDirectVlistRows(match.target).filter(r => !isKatexLineRow(r));
            if (info.byRole.body && rows[0]) alignKatexSequence([info.byRole.body], [rows[0]], entries, tex);
            return;
        }
        if (node.type === 'enclose') {
            const match = stream.consumeCompound('enclose');
            if (!match) return;
            const box = match.target.querySelector('.boxpad');
            const rows = box ? [box] : getKatexDirectVlistRows(match.target).filter(
                r => !r.classList.contains('svg-align') && !Array.from(r.children || []).some(c => c.classList.contains('fbox'))
            );
            if (info.byRole.body && rows[0]) alignKatexSequence([info.byRole.body], [rows[0]], entries, tex);
            return;
        }
        if (node.type === 'raisebox') {
            const match = stream.consumeCompound('raisebox');
            if (!match) return;
            const rows = getKatexDirectVlistRows(match.target);
            if (info.byRole.body && rows[0]) alignKatexSequence([info.byRole.body], [rows[0]], entries, tex);
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
            alignKatexSequence(info.children.map(c => c.info), innerEls, entries, tex);
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
                alignKatexSequence([cellInfo], [domCell], entries, tex);
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
            for (const c of info.children) alignKatexNode(c.info, stream, hidden, tex);
            return;
        }
        if (info.children.length) {
            for (const c of info.children) alignKatexNode(c.info, stream, entries, tex);
            return;
        }
        if (node.type === 'ordgroup') return;
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

    window.considerKatexFormulaPoints = considerKatexFormulaPoints;
    window.textAnnotationOffsetAtPoint = textAnnotationOffsetAtPoint;
})();
