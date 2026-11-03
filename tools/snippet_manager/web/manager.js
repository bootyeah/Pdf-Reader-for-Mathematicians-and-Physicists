'use strict';

// =============================================================================
// LaTeX 快捷键管理中心 · 前端交互与量子速录引擎
// =============================================================================

const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || sessionStorage.getItem('snippet-manager-token') || '';

if (fragment.has('token')) {
    sessionStorage.setItem('snippet-manager-token', token);
    history.replaceState(null, '', location.pathname);
}

let doc = null;
let savedSnapshot = '';
let activeCategory = 'all';
let activeFilter = 'all';
let searchQuery = '';
let sortMode = 'default';
let categoriesMap = {};
let hasBackup = false;
let busy = false;
let sandboxEngine = null;

// =============================================================================
// 1. API 通讯与状态管理
// =============================================================================

function isDirty() {
    if (!doc) return false;
    return JSON.stringify(doc.snippets) !== savedSnapshot;
}

function updateStatus() {
    const dirty = isDirty();
    $('dirty-dot').classList.toggle('dirty', dirty);
    if (dirty) {
        let diffCount = 0;
        try {
            const savedArr = JSON.parse(savedSnapshot || '[]');
            const savedMap = new Map(savedArr.map(s => [s.id, JSON.stringify(s)]));
            doc.snippets.forEach(s => {
                if (savedMap.get(s.id) !== JSON.stringify(s)) diffCount++;
            });
            diffCount += Math.abs(doc.snippets.length - savedArr.length);
        } catch (_) {
            diffCount = 1;
        }
        $('save-status').textContent = `有 ${Math.max(1, diffCount)} 处未保存更改`;
    } else {
        $('save-status').textContent = '所有更改已保存并同步至阅读器';
    }
    $('restore').disabled = !hasBackup;
}

function notice(message, error = false) {
    const el = $('notice');
    el.textContent = message;
    el.className = 'notice-bar' + (error ? ' error' : '');
    el.hidden = !message;
    if (message && !error) {
        setTimeout(() => {
            if (el.textContent === message) el.hidden = true;
        }, 3500);
    }
}

async function api(path, body) {
    const response = await fetch('/api/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
            'X-Manager-Token': token,
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

function lock(on) {
    busy = on;
    document.body.classList.toggle('busy', on);
    document.querySelectorAll('.app-header button').forEach(el => {
        el.disabled = on;
    });
    if (!on) updateStatus();
}

async function action(fn) {
    if (busy) return;
    notice('');
    lock(true);
    try {
        await fn();
    } catch (error) {
        notice(error.message, true);
    } finally {
        lock(false);
    }
}

function acceptData(data) {
    doc = data.document;
    savedSnapshot = JSON.stringify(doc.snippets);
    categoriesMap = data.categories || {};
    hasBackup = !!data.has_backup;

    $('config-path').textContent = data.config_path;
    $('config-path').title = `配置路径: ${data.config_path}\nJS同步路径: ${data.config_js_path || ''}`;

    renderCategoriesNav();
    renderSnippetsList();
    initSandboxEngine();
    updateStatus();
}

// =============================================================================
// 2. 嵌入式量子速录引擎 (QuantumSnippetEngine 沙盒实现)
// =============================================================================

class SandboxQuantumEngine {
    constructor(textarea, getSnippetsFn, options = {}) {
        this.textarea = textarea;
        this.getSnippetsFn = getSnippetsFn;
        this.activeTabStops = [];
        this.totalStopsForCurrent = 0;
        this.lastValLength = textarea.value.length;
        this.isExpanding = false;
        this.onTabStopsChange = options.onTabStopsChange || null;

        this.GREEK = "alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|vartheta|Theta|iota|kappa|lambda|Lambda|mu|nu|xi|Xi|pi|Pi|rho|varrho|sigma|Sigma|tau|upsilon|Upsilon|phi|varphi|Phi|chi|psi|Psi|omega|Omega";
        this.SYMBOL = "infty|sum|prod|lim|nabla|times|cdot|propto|equiv|neq|geq|leq|gg|ll|sim|simeq|leftrightarrow|longleftrightarrow|to|mapsto|implies|impliedby|cap|cup|notin|setminus|subseteq|supseteq|emptyset|exists";
        this.MORE_SYMBOLS = "leq|geq|neq|gg|ll|equiv|sim|propto|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|to|mapsto|cap|cup|in|int|iint|iiint|oint|inf|notin|subset|supset|subseteq|supseteq|emptyset|exists|forall|nabla|partial|infty|dots|cdots|vdots|ddots|perp|parallel|angle|triangle|cong|approx|times|div|pm|mp|cdot|circ|ast|star|oplus|otimes|ominus|odot|wedge|vee|neg|implies|iff";
        this.PROTECTED_CMD_PREFIXES = [
            "int", "iint", "iiint", "inf", "infty", "injlim", "intercal",
            "subseteq", "subseteqq", "subsetneq", "subsetneqq",
            "supseteq", "supseteqq", "supsetneq", "supsetneqq",
            "simeq", "approxeq",
            "limits", "limsup", "liminf",
            "cdots", "cdotp", "dotsb", "dotsc", "dotsi", "dotsm", "dotso",
            "leqq", "leqslant", "geqq", "geqslant",
            "lll", "llbracket", "llcorner", "llless", "ggg", "gggtr",
            "pmod", "pmb", "top",
            "circeq", "circlearrowleft", "circlearrowright", "circledast", "circledcirc", "circleddash", "circledR", "circledS",
            "triangleleft", "trianglelefteq", "triangleq", "triangleright", "trianglerighteq", "triangledown",
            "leftarrowtail", "rightarrowtail", "leftrightarrows"
        ];
        this.NON_MATH_ENVS = new Set(['tikzpicture', 'circuitikz', 'forest', 'smartdiagram', 'document', 'itemize', 'enumerate']);
        this.TEXT_LIKE_CMDS = new Set([
            'text', 'textbf', 'textit', 'textrm', 'textsf', 'texttt',
            'mbox', 'hbox', 'mathrm', 'operatorname', 'color', 'textcolor',
            'ce', 'pu', 'label', 'ref', 'eqref', 'tag'
        ]);
        this.RE_ODD_BACKSLASH_CMD = /(?:^|[^\\])(?:\\\\)*\\[A-Za-z]+$/;
        this.RE_ODD_TRAILING_BACKSLASH = /(?:^|[^\\])(?:\\\\)*\\$/;
        this.RE_BEGIN_END_ARG = /\\(?:begin|end)\{[A-Za-z]*$/;
        this.RE_DELIMITER_MODIFIER = /\\(?:left|right|[bB]igg?)\s*\\?$/;

        this.bindEvents();
    }

    getSnippets() {
        const rawSnippets = this.getSnippetsFn().filter(s => s.enabled);
        const compiled = rawSnippets.map((snip, idx) => {
            const item = { ...snip, _order: idx };
            const opts = String(item.options || '');
            const isRegex = opts.includes('r') || item.is_regex;
            item._isRegex = isRegex;
            if (isRegex && typeof item.trigger === 'string') {
                const rawSource = item.trigger;
                const expanded = rawSource
                    .replace(/\$\{GREEK\}/g, this.GREEK)
                    .replace(/\$\{SYMBOL\}/g, this.SYMBOL)
                    .replace(/\$\{MORE_SYMBOLS\}/g, this.MORE_SYMBOLS)
                    .replace(/\$\{VISUAL\}/g, "");
                try {
                    const anchored = expanded.endsWith('$') ? expanded : expanded + '$';
                    item.compiledRegex = new RegExp(anchored);
                } catch (_) {
                    item.compiledRegex = null;
                }
                item._expectsBackslash = expanded.startsWith('\\\\') || expanded.startsWith('\\(') || expanded.startsWith('\\');
                item._isAutoSpace = rawSource.includes('${MORE_SYMBOLS})([A-Za-z])');
            } else {
                const trigStr = String(item.trigger || '');
                item._expectsBackslash = trigStr.startsWith('\\');
                item._isAutoSpace = false;
            }
            return item;
        });

        compiled.sort((a, b) => {
            const prioDiff = (b.priority || 0) - (a.priority || 0);
            if (prioDiff !== 0) return prioDiff;
            const lenA = a._isRegex ? 0 : String(a.trigger || '').length;
            const lenB = b._isRegex ? 0 : String(b.trigger || '').length;
            if (lenB !== lenA) return lenB - lenA;
            return (a._order || 0) - (b._order || 0);
        });
        return compiled;
    }

    hasActiveTabStops() {
        return Array.isArray(this.activeTabStops) && this.activeTabStops.length > 0;
    }

    notifyTabStops() {
        if (this.onTabStopsChange) {
            const currentIndex = this.totalStopsForCurrent > 0
                ? Math.max(0, this.totalStopsForCurrent - this.activeTabStops.length)
                : 0;
            const displayArr = this.activeTabStops.length > 0
                ? new Array(this.totalStopsForCurrent)
                : [];
            this.onTabStopsChange(displayArr, currentIndex);
        }
    }

    clearTabStops() {
        this.activeTabStops = [];
        this.totalStopsForCurrent = 0;
        this.notifyTabStops();
    }

    getContextMode(textBefore) {
        const contextRadio = document.querySelector('input[name="sandbox-context"]:checked');
        const forcedMath = contextRadio && contextRadio.value === 'math';
        const stack = [forcedMath ? { type: 'display-math', env: 'sandbox' } : { type: 'text' }];

        let i = 0;
        const n = textBefore.length;
        const isAlpha = (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');

        while (i < n) {
            const ch = textBefore[i];
            const top = stack[stack.length - 1];

            if (ch === '\\') {
                if (i + 1 < n && !isAlpha(textBefore[i + 1])) {
                    i += 2;
                    continue;
                }
                let j = i + 1;
                while (j < n && isAlpha(textBefore[j])) j++;
                const cmd = textBefore.slice(i + 1, j);
                let k = j;
                while (k < n && (textBefore[k] === ' ' || textBefore[k] === '\t')) k++;

                if ((cmd === 'begin' || cmd === 'end') && k < n && textBefore[k] === '{') {
                    const close = textBefore.indexOf('}', k + 1);
                    if (close !== -1) {
                        const envName = textBefore.slice(k + 1, close).trim();
                        if (cmd === 'begin') {
                            const envType = this.NON_MATH_ENVS.has(envName) ? 'text-env' : 'display-math';
                            stack.push({ type: envType, env: envName });
                        } else {
                            for (let idx = stack.length - 1; idx > 0; idx--) {
                                if (stack[idx].env === envName) {
                                    stack.length = idx;
                                    break;
                                }
                            }
                        }
                        i = close + 1;
                        continue;
                    }
                }

                if ((top.type === 'inline-math' || top.type === 'display-math') && this.TEXT_LIKE_CMDS.has(cmd) && k < n && textBefore[k] === '{') {
                    stack.push({ type: 'math-text', cmd, braceDepth: 1 });
                    i = k + 1;
                    continue;
                }

                i = j;
                continue;
            }

            if (top.type === 'math-text') {
                if (ch === '{') {
                    top.braceDepth++;
                } else if (ch === '}') {
                    top.braceDepth--;
                    if (top.braceDepth <= 0) stack.pop();
                } else if (ch === '$') {
                    stack.push({ type: 'inline-math' });
                }
                i++;
                continue;
            }

            if (ch === '$') {
                if (i + 1 < n && textBefore[i + 1] === '$') {
                    if (top.type === 'display-math' && !top.env) {
                        stack.pop();
                    } else {
                        stack.push({ type: 'display-math', env: null });
                    }
                    i += 2;
                } else {
                    if (top.type === 'inline-math') {
                        stack.pop();
                    } else {
                        stack.push({ type: 'inline-math' });
                    }
                    i++;
                }
                continue;
            }

            i++;
        }

        const finalTop = stack[stack.length - 1];
        const inDisplayMath = finalTop.type === 'display-math';
        const inInlineMath = finalTop.type === 'inline-math';
        return {
            inMath: inDisplayMath || inInlineMath,
            inDisplayMath,
            inInlineMath,
            inTextCommand: finalTop.type === 'math-text'
        };
    }

    isMathMode(textBefore) {
        return this.getContextMode(textBefore).inMath;
    }

    findMatchingSnippet(textBefore, manualTab = false) {
        const ctx = this.getContextMode(textBefore);
        if (ctx.inTextCommand) return null;
        if (this.RE_BEGIN_END_ARG.test(textBefore)) return null;
        const inBackslashCmd = this.RE_ODD_BACKSLASH_CMD.test(textBefore);

        const snippets = this.getSnippets();
        for (const snip of snippets) {
            const opts = String(snip.options || '');
            const isAuto = opts.includes('A');
            if (manualTab ? isAuto : !isAuto) continue;

            if (opts.includes('M') && !ctx.inDisplayMath) continue;
            if (opts.includes('n') && !ctx.inInlineMath) continue;
            if (opts.includes('m') && !ctx.inMath) continue;
            if (opts.includes('t') && ctx.inMath) continue;
            if (inBackslashCmd && !snip._expectsBackslash) continue;

            if (snip._isRegex) {
                const regex = snip.compiledRegex;
                if (!regex) continue;
                const matchResult = textBefore.match(regex);
                if (!matchResult) continue;
                if (snip._isAutoSpace) {
                    const candidate = (matchResult[1] || '') + (matchResult[2] || '');
                    if (this.PROTECTED_CMD_PREFIXES.some(cmd => cmd.startsWith(candidate))) continue;
                }
                return { snip, matchResult, matchLength: matchResult[0].length };
            } else {
                const trig = String(snip.trigger || '');
                if (!trig || !textBefore.endsWith(trig)) continue;
                const prefix = textBefore.slice(0, -trig.length);
                if (!snip._expectsBackslash && this.RE_ODD_TRAILING_BACKSLASH.test(prefix)) continue;
                if ((trig === '(' || trig === '[' || trig === '{') && this.RE_DELIMITER_MODIFIER.test(prefix)) continue;
                if (opts.includes('w')) {
                    const charBefore = prefix.slice(-1);
                    if (charBefore && /\w/.test(charBefore)) continue;
                }
                return { snip, matchResult: [trig], matchLength: trig.length };
            }
        }
        return null;
    }

    shiftRangesAfter(threshold, delta, skipRange = null) {
        if (delta === 0) return;
        for (const group of this.activeTabStops) {
            for (const r of group.ranges) {
                if (r === skipRange) continue;
                if (r.start >= threshold) {
                    r.start += delta;
                    r.end += delta;
                }
            }
        }
    }

    syncMirrorsForActiveGroup() {
        if (this.activeTabStops.length === 0) return;
        const group = this.activeTabStops[0];
        if (!group || group.ranges.length <= 1) return;
        const primary = group.ranges[0];
        const newText = this.textarea.value.slice(primary.start, primary.end);
        const selStart = this.textarea.selectionStart;
        const selEnd = this.textarea.selectionEnd;

        for (let mIdx = 1; mIdx < group.ranges.length; mIdx++) {
            const mirror = group.ranges[mIdx];
            const curMirrorText = this.textarea.value.slice(mirror.start, mirror.end);
            if (curMirrorText === newText) continue;
            const oldEnd = mirror.end;
            const mirrorDelta = newText.length - (mirror.end - mirror.start);
            this.textarea.setRangeText(newText, mirror.start, mirror.end);
            mirror.end = mirror.start + newText.length;
            this.shiftRangesAfter(oldEnd, mirrorDelta, mirror);
        }

        this.textarea.setSelectionRange(selStart, selEnd);
        this.lastValLength = this.textarea.value.length;
    }

    bindEvents() {
        this.textarea.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if ((e.key === ')' || e.key === ']' || e.key === '}') && !e.ctrlKey && !e.altKey && !e.metaKey) {
                if (this.hasActiveTabStops() && this.textarea.selectionStart === this.textarea.selectionEnd) {
                    const cursorPos = this.textarea.selectionStart;
                    if (this.textarea.value[cursorPos] === e.key && this.activeTabStops.length >= 2) {
                        const curG = this.activeTabStops[0];
                        const nextG = this.activeTabStops[1];
                        if (
                            curG.ranges.length === 1 &&
                            curG.ranges[0].end === cursorPos &&
                            nextG.ranges.length === 1 &&
                            nextG.ranges[0].start === cursorPos + 1 &&
                            nextG.ranges[0].end === cursorPos + 1
                        ) {
                            e.preventDefault();
                            this.textarea.setSelectionRange(cursorPos + 1, cursorPos + 1);
                            this.activeTabStops.shift();
                            if (this.activeTabStops.length === 1) {
                                this.clearTabStops();
                            } else {
                                this.notifyTabStops();
                            }
                            updateSandboxKaTeX();
                            return;
                        }
                    }
                }
            }
            if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                if (this.textarea.selectionStart === this.textarea.selectionEnd) {
                    const cursorPos = this.textarea.selectionStart;
                    const textBefore = this.textarea.value.slice(0, cursorPos);
                    const manualHit = this.findMatchingSnippet(textBefore, true);
                    if (
                        manualHit &&
                        (!this.hasActiveTabStops() || (cursorPos - manualHit.matchLength >= this.activeTabStops[0].ranges[0].start))
                    ) {
                        e.preventDefault();
                        this.executeSnippet(manualHit.snip, manualHit.matchResult, manualHit.matchLength, cursorPos);
                        updateSandboxKaTeX();
                        return;
                    }
                }
                if (this.hasActiveTabStops()) {
                    e.preventDefault();
                    this.activeTabStops.shift();
                    if (this.activeTabStops.length > 0) {
                        const nextGroup = this.activeTabStops[0];
                        const r = nextGroup.ranges[0];
                        this.textarea.setSelectionRange(r.start, r.end);
                        if (this.activeTabStops.length === 1 && nextGroup.ranges.length === 1 && r.start === r.end) {
                            this.clearTabStops();
                        } else {
                            this.notifyTabStops();
                        }
                    } else {
                        this.clearTabStops();
                    }
                }
            } else if (e.key === 'Escape' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                this.clearTabStops();
            }
        });

        this.textarea.addEventListener('input', (e) => {
            if (this.isExpanding) return;

            let currentVal = this.textarea.value;
            const delta = currentVal.length - this.lastValLength;
            this.lastValLength = currentVal.length;
            let cursorPos = this.textarea.selectionStart;

            if (this.activeTabStops.length > 0 && (delta !== 0 || e.inputType)) {
                const primary = this.activeTabStops[0].ranges[0];
                const oldPrimaryEnd = primary.end;
                const newPrimaryEnd = primary.end + delta;
                if (newPrimaryEnd >= primary.start && cursorPos >= primary.start && cursorPos <= newPrimaryEnd) {
                    if (delta !== 0) {
                        primary.end = newPrimaryEnd;
                        this.shiftRangesAfter(oldPrimaryEnd, delta, primary);
                    }
                    if (this.activeTabStops[0].ranges.length > 1) {
                        this.isExpanding = true;
                        try {
                            this.syncMirrorsForActiveGroup();
                        } finally {
                            this.isExpanding = false;
                        }
                        currentVal = this.textarea.value;
                        cursorPos = this.textarea.selectionStart;
                    }
                    this.notifyTabStops();
                } else if (delta !== 0) {
                    this.clearTabStops();
                }
            }

            if (e.isComposing || (e.inputType !== 'insertText' && e.inputType !== 'insertCompositionText')) {
                updateSandboxKaTeX();
                return;
            }

            const textBefore = currentVal.slice(0, cursorPos);
            const hit = this.findMatchingSnippet(textBefore, false);
            if (hit) {
                this.executeSnippet(hit.snip, hit.matchResult, hit.matchLength, cursorPos);
            }

            updateSandboxKaTeX();
        });

        this.textarea.addEventListener('blur', () => {
            // Keep tabstops if clicking inside sandbox preview
        });
    }

    executeSnippet(snip, match, matchLength, cursorPos) {
        let replacement = snip.replacement;

        // Function replacement (e.g. iden matrix)
        if (snip.is_function && typeof snip.replacement === 'string') {
            try {
                const fn = new Function('match', 'return (' + snip.replacement + ')(match)');
                replacement = fn(match);
            } catch (_) {
                replacement = snip.replacement;
            }
        } else if (snip._isRegex) {
            replacement = replacement.replace(/\[\[(\d+)\]\]/g, (_, g1) => match[parseInt(g1, 10) + 1] || '');
        }

        const groupsMap = new Map();
        let finalStr = "";
        let currentIndex = 0;

        const regex = /\$(\d+)|\$\{(\d+):([^}]+)\}|\$\{VISUAL\}/g;
        let m;

        while ((m = regex.exec(replacement)) !== null) {
            finalStr += replacement.slice(currentIndex, m.index);
            let id = 0, defVal = "";
            if (m[0] === '${VISUAL}') {
                id = 1;
            } else {
                const isBrace = m[2] !== undefined;
                id = parseInt(isBrace ? m[2] : m[1], 10);
                defVal = isBrace ? m[3] : '';
            }

            if (!groupsMap.has(id)) {
                groupsMap.set(id, { id, ranges: [] });
            }
            groupsMap.get(id).ranges.push({
                start: finalStr.length,
                end: finalStr.length + defVal.length
            });

            finalStr += defVal;
            currentIndex = regex.lastIndex;
        }
        finalStr += replacement.slice(currentIndex);

        let newGroups = Array.from(groupsMap.values()).sort((a, b) => a.id - b.id);
        if (
            newGroups.length === 1 &&
            newGroups[0].ranges.length === 1 &&
            newGroups[0].ranges[0].start === finalStr.length &&
            newGroups[0].ranges[0].end === finalStr.length
        ) {
            newGroups = [];
        } else if (newGroups.length > 0) {
            const lastG = newGroups[newGroups.length - 1];
            const lastR = lastG.ranges[0];
            if (lastG.ranges.length > 1 || lastR.end < finalStr.length || lastR.start !== lastR.end) {
                newGroups.push({
                    id: lastG.id + 1,
                    ranges: [{ start: finalStr.length, end: finalStr.length }]
                });
            }
        }

        const startPos = cursorPos - matchLength;
        const snipDelta = finalStr.length - matchLength;

        this.isExpanding = true;
        try {
            this.textarea.setSelectionRange(startPos, cursorPos);

            if (!document.execCommand('insertText', false, finalStr)) {
                this.textarea.setRangeText(finalStr, startPos, cursorPos, 'end');
            }

            this.lastValLength = this.textarea.value.length;

            newGroups.forEach(g => {
                g.ranges.forEach(r => {
                    r.start += startPos;
                    r.end += startPos;
                });
            });

            if (this.activeTabStops.length > 0) {
                const outerPrimary = this.activeTabStops[0].ranges[0];
                if (startPos >= outerPrimary.start && cursorPos <= outerPrimary.end) {
                    const oldOuterEnd = outerPrimary.end;
                    outerPrimary.end += snipDelta;
                    this.shiftRangesAfter(oldOuterEnd, snipDelta, outerPrimary);
                    if (this.activeTabStops[0].ranges.length > 1) {
                        this.syncMirrorsForActiveGroup();
                    }
                    if (newGroups.length > 0) {
                        this.activeTabStops = [...newGroups, ...this.activeTabStops.slice(1)];
                        this.totalStopsForCurrent = this.activeTabStops.length;
                    }
                } else {
                    this.activeTabStops = newGroups;
                    this.totalStopsForCurrent = newGroups.length;
                }
            } else {
                this.activeTabStops = newGroups;
                this.totalStopsForCurrent = newGroups.length;
            }

            if (newGroups.length > 0) {
                const firstRange = this.activeTabStops[0].ranges[0];
                this.textarea.setSelectionRange(firstRange.start, firstRange.end);
            }
        } finally {
            this.isExpanding = false;
        }
        this.notifyTabStops();
    }
}

function initSandboxEngine() {
    const input = $('sandbox-input');
    if (!input) return;
    sandboxEngine = new SandboxQuantumEngine(input, () => doc ? doc.snippets : [], {
        onTabStopsChange: (tabStops, currentIndex) => {
            const hint = $('sandbox-tabstops-hint');
            const text = $('tabstops-text');
            if (tabStops && tabStops.length > 0) {
                hint.classList.add('active');
                text.textContent = `第 ${currentIndex + 1}/${tabStops.length} 处占位符 · 按 Tab 跳跃`;
            } else {
                hint.classList.remove('active');
                text.textContent = '无活动占位符';
            }
        }
    });
}

function updateSandboxKaTeX() {
    const preview = $('sandbox-katex-preview');
    if (!preview) return;
    const val = $('sandbox-input').value.trim();
    if (!val) {
        preview.innerHTML = '<span class="text-muted italic">（公式效果将在此处实时呈现）</span>';
        return;
    }

    try {
        const contextRadio = document.querySelector('input[name="sandbox-context"]:checked');
        const isTextContext = contextRadio && contextRadio.value === 'text';

        const isSingleDisplay = val.startsWith('$$') && val.endsWith('$$') && val.length >= 4 && !val.slice(2, -2).includes('$$');
        const isSingleInline = !isSingleDisplay && val.startsWith('$') && val.endsWith('$') && val.length >= 2 && !val.slice(1, -1).includes('$');

        if (isTextContext && !isSingleDisplay && !isSingleInline && window.renderMathInElement) {
            preview.textContent = val;
            window.renderMathInElement(preview, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false }
                ],
                throwOnError: false
            });
        } else if (window.katex) {
            let mathText = val;
            let displayMode = true;
            if (isSingleDisplay) {
                mathText = val.slice(2, -2).trim();
                displayMode = true;
            } else if (isSingleInline) {
                mathText = val.slice(1, -1).trim();
                displayMode = false;
            }
            katex.render(mathText, preview, {
                displayMode,
                throwOnError: false
            });
        } else {
            preview.textContent = val;
        }
    } catch (err) {
        preview.innerHTML = `<span class="text-danger">${err.message}</span>`;
    }
}

// =============================================================================
// 3. 分类与列表渲染
// =============================================================================

function renderCategoriesNav() {
    const nav = $('category-nav');
    nav.replaceChildren();

    const snippets = doc ? doc.snippets : [];
    $('total-badge').textContent = snippets.length;

    // Count per category
    const counts = { all: snippets.length };
    snippets.forEach(s => {
        const cat = s.category || 'general';
        counts[cat] = (counts[cat] || 0) + 1;
    });

    const categoriesList = [
        ['all', '全部快捷键'],
        ['math_symbol', '数学符号'],
        ['greek', '希腊字母'],
        ['env', '环境与矩阵'],
        ['sub_sup', '上下标与修饰'],
        ['calculus', '微积分与求和'],
        ['logic_relation', '逻辑与关系符'],
        ['text_style', '文本与排版'],
        ['sets_symbols', '数集与特殊字体'],
        ['regex', '高级正则模式'],
        ['general', '通用规则']
    ];

    categoriesList.forEach(([key, title]) => {
        const count = counts[key] || 0;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nav-item' + (activeCategory === key ? ' active' : '');
        btn.dataset.category = key;
        btn.innerHTML = `<span>${title}</span><span class="badge">${count}</span>`;
        btn.onclick = () => {
            activeCategory = key;
            $('current-category-title').textContent = title;
            renderCategoriesNav();
            renderSnippetsList();
        };
        nav.appendChild(btn);
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function highlightTabStops(text) {
    if (typeof text !== 'string') return '';
    const escaped = escapeHtml(text);
    return escaped
        .replace(/\$(\d+)|\$\{(\d+):([^}]+)\}|\$\{VISUAL\}/g, match => `<span class="tabstop-mark">${match}</span>`)
        .replace(/\[\[(\d+)\]\]/g, match => `<span class="capture-mark">${match}</span>`);
}

function getFilteredSnippets() {
    if (!doc || !Array.isArray(doc.snippets)) return [];
    let list = [...doc.snippets];

    // 1. Category Filter
    if (activeCategory !== 'all') {
        list = list.filter(s => (s.category || 'general') === activeCategory);
    }

    // 2. Mode / Status Filter
    if (activeFilter === 'opt-m') {
        list = list.filter(s => s.options && (s.options.includes('m') || s.options.includes('M') || s.options.includes('n')));
    } else if (activeFilter === 'opt-t') {
        list = list.filter(s => s.options && s.options.includes('t'));
    } else if (activeFilter === 'opt-A') {
        list = list.filter(s => s.options && s.options.includes('A'));
    } else if (activeFilter === 'opt-r') {
        list = list.filter(s => s.is_regex || (s.options && s.options.includes('r')));
    } else if (activeFilter === 'opt-w') {
        list = list.filter(s => s.options && s.options.includes('w'));
    } else if (activeFilter === 'disabled') {
        list = list.filter(s => !s.enabled);
    }

    // 3. Search Query
    if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        list = list.filter(s =>
            (s.trigger && s.trigger.toLowerCase().includes(q)) ||
            (s.replacement && s.replacement.toLowerCase().includes(q)) ||
            (s.description && s.description.toLowerCase().includes(q)) ||
            (s.options && s.options.toLowerCase().includes(q))
        );
    }

    // 4. Sort
    if (sortMode === 'trigger') {
        list.sort((a, b) => a.trigger.localeCompare(b.trigger));
    } else if (sortMode === 'priority') {
        list.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    return list;
}

function renderSnippetsList() {
    const container = $('snippets-container');
    container.replaceChildren();

    const filtered = getFilteredSnippets();
    $('current-count-desc').textContent = `显示 ${filtered.length} / 共 ${doc ? doc.snippets.length : 0} 条规则`;

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state text-center text-muted py-10';
        empty.innerHTML = `
            <i class="ph ph-magnifying-glass text-3xl mb-2"></i>
            <p>未找到符合条件的快捷键规则</p>
        `;
        container.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();

    filtered.forEach(snip => {
        const card = document.createElement('div');
        card.className = 'snippet-card' + (snip.enabled ? '' : ' disabled');
        card.dataset.id = snip.id;

        const isRegex = snip.is_regex || (snip.options && snip.options.includes('r'));

        // Tags
        const tags = [];
        if (snip.options.includes('m')) tags.push('<span class="opt-tag opt-math" title="所有数学模式">Math</span>');
        if (snip.options.includes('M')) tags.push('<span class="opt-tag opt-math" title="仅块级数学 $$...$$">BlockMath</span>');
        if (snip.options.includes('n')) tags.push('<span class="opt-tag opt-math" title="仅行内数学 $...$">InlineMath</span>');
        if (snip.options.includes('t')) tags.push('<span class="opt-tag opt-text" title="正文模式">Text</span>');
        if (snip.options.includes('A')) {
            tags.push('<span class="opt-tag opt-auto" title="自动展开">Auto</span>');
        } else {
            tags.push('<span class="opt-tag" title="按 Tab 键展开">Tab</span>');
        }
        if (isRegex) tags.push('<span class="opt-tag opt-regex" title="正则表达式">Regex</span>');
        if (snip.options.includes('w')) tags.push('<span class="opt-tag" title="单词边界">Word</span>');
        if (snip.priority) tags.push(`<span class="opt-tag" title="优先级">Prio: ${snip.priority}</span>`);

        card.innerHTML = `
            <div class="card-top">
                <div class="trigger-badge ${isRegex ? 'regex-type' : ''}" title="${isRegex ? '正则表达式触发词' : '文本触发词'}">
                    <span>${escapeHtml(snip.trigger)}</span>
                </div>
                <div class="card-actions">
                    <label class="switch" title="${snip.enabled ? '已启用 (点击停用)' : '已停用 (点击启用)'}">
                        <input type="checkbox" ${snip.enabled ? 'checked' : ''} data-toggle-id="${snip.id}">
                        <span class="slider"></span>
                    </label>
                    <button type="button" class="btn-icon-tiny" data-edit-id="${snip.id}" title="编辑规则">
                        <i class="ph ph-pencil-simple"></i>
                    </button>
                    <button type="button" class="btn-icon-tiny" data-clone-id="${snip.id}" title="复制规则">
                        <i class="ph ph-copy"></i>
                    </button>
                    <button type="button" class="btn-icon-tiny text-danger" data-delete-id="${snip.id}" title="删除规则">
                        <i class="ph ph-trash"></i>
                    </button>
                </div>
            </div>

            <div class="card-replacement-box" title="展开替换预览">
                <code>${highlightTabStops(snip.replacement)}</code>
            </div>

            <div class="card-bottom">
                <div class="card-tags">${tags.join('')}</div>
                ${snip.description ? `<div class="card-desc" title="${escapeHtml(snip.description)}">${escapeHtml(snip.description)}</div>` : ''}
            </div>
        `;

        fragment.appendChild(card);
    });

    container.appendChild(fragment);
}

// =============================================================================
// 4. 模态弹窗与 CRUD 操作
// =============================================================================

function openEditModal(snippet = null) {
    const modal = $('edit-modal');
    const form = $('snippet-form');
    form.reset();
    $('conflict-alert').hidden = true;

    // Populate category select
    const catSelect = $('edit-category');
    catSelect.replaceChildren();
    Object.entries(categoriesMap).forEach(([k, v]) => {
        if (k === 'all') return;
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = v;
        catSelect.appendChild(opt);
    });

    if (snippet) {
        $('modal-title').textContent = '编辑快捷键';
        $('edit-id').value = snippet.id;
        $('edit-trigger').value = snippet.trigger;
        $('edit-replacement').value = snippet.replacement;
        $('edit-priority').value = snippet.priority || 0;
        $('edit-description').value = snippet.description || '';
        $('edit-category').value = snippet.category || 'general';

        const opts = snippet.options || '';
        $('opt-m').checked = opts.includes('m');
        if ($('opt-M')) $('opt-M').checked = opts.includes('M');
        if ($('opt-n')) $('opt-n').checked = opts.includes('n');
        $('opt-t').checked = opts.includes('t');
        $('opt-A').checked = opts.includes('A');
        $('opt-r').checked = snippet.is_regex || opts.includes('r');
        $('opt-w').checked = opts.includes('w');
    } else {
        $('modal-title').textContent = '新建快捷键';
        $('edit-id').value = '';
        $('edit-priority').value = 0;
        $('edit-category').value = activeCategory !== 'all' ? activeCategory : 'math_symbol';
        $('opt-m').checked = true;
        if ($('opt-M')) $('opt-M').checked = false;
        if ($('opt-n')) $('opt-n').checked = false;
        $('opt-A').checked = true;
    }

    modal.hidden = false;
    $('edit-trigger').focus();
    checkConflict();
}

function closeEditModal() {
    $('edit-modal').hidden = true;
}

function checkConflict() {
    const trig = $('edit-trigger').value.trim();
    const curId = $('edit-id').value;
    const isM = $('opt-m').checked;
    const isBlockM = $('opt-M') ? $('opt-M').checked : false;
    const isInlineN = $('opt-n') ? $('opt-n').checked : false;
    const isT = $('opt-t').checked;
    const alertEl = $('conflict-alert');

    if (!trig || !doc) {
        alertEl.hidden = true;
        return;
    }

    const conflict = doc.snippets.find(s => {
        if (s.id === curId || !s.enabled) return false;
        if (s.trigger !== trig) return false;
        const hasM = s.options.includes('m');
        const hasBlockM = s.options.includes('M');
        const hasInlineN = s.options.includes('n');
        const hasT = s.options.includes('t');
        if (isM && (hasM || hasBlockM || hasInlineN)) return true;
        if (isBlockM && (hasM || hasBlockM)) return true;
        if (isInlineN && (hasM || hasInlineN)) return true;
        if (isT && hasT) return true;
        if (!isM && !isBlockM && !isInlineN && !isT && !hasM && !hasBlockM && !hasInlineN && !hasT) return true;
        return false;
    });

    if (conflict) {
        alertEl.hidden = false;
        alertEl.textContent = `提示：触发词 “${trig}” 已存在于现有规则 (${conflict.replacement.slice(0, 25)}) 中，且生效模式重合。`;
    } else {
        alertEl.hidden = true;
    }
}

function saveSnippetFromForm(e) {
    e.preventDefault();
    const id = $('edit-id').value;
    const trigger = $('edit-trigger').value.trim();
    const replacement = $('edit-replacement').value;
    const category = $('edit-category').value;
    const priority = parseInt($('edit-priority').value, 10) || 0;
    const description = $('edit-description').value.trim();

    let options = '';
    if ($('opt-m').checked) options += 'm';
    if ($('opt-M') && $('opt-M').checked) options += 'M';
    if ($('opt-n') && $('opt-n').checked) options += 'n';
    if ($('opt-t').checked) options += 't';
    if ($('opt-A').checked) options += 'A';
    if ($('opt-r').checked) options += 'r';
    if ($('opt-w').checked) options += 'w';

    const isRegex = $('opt-r').checked;

    if (!trigger) {
        notice('请填写触发词', true);
        return;
    }

    if (id) {
        // Edit existing
        const idx = doc.snippets.findIndex(s => s.id === id);
        if (idx !== -1) {
            doc.snippets[idx] = {
                ...doc.snippets[idx],
                trigger,
                replacement,
                options,
                is_regex: isRegex,
                category,
                priority,
                description
            };
        }
    } else {
        // Create new
        const newSnip = {
            id: 'snip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            trigger,
            replacement,
            options,
            is_regex: isRegex,
            category,
            priority,
            description,
            enabled: true
        };
        doc.snippets.unshift(newSnip);
    }

    closeEditModal();
    renderCategoriesNav();
    renderSnippetsList();
    updateStatus();
    notice('规则已暂存，按 Ctrl+S 即可保存并同步至阅读器');
}

function cloneSnippet(id) {
    const orig = doc.snippets.find(s => s.id === id);
    if (!orig) return;
    const cloned = {
        ...orig,
        id: 'snip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        trigger: orig.trigger + '_copy',
        description: orig.description ? orig.description + ' (副本)' : '副本'
    };
    const idx = doc.snippets.findIndex(s => s.id === id);
    doc.snippets.splice(idx + 1, 0, cloned);
    renderCategoriesNav();
    renderSnippetsList();
    updateStatus();
    notice(`已复制规则 “${orig.trigger}”`);
}

function deleteSnippet(id) {
    const snip = doc.snippets.find(s => s.id === id);
    if (!snip) return;
    if (confirm(`确定要删除快捷键 “${snip.trigger}” 吗？`)) {
        doc.snippets = doc.snippets.filter(s => s.id !== id);
        renderCategoriesNav();
        renderSnippetsList();
        updateStatus();
        notice(`已删除规则 “${snip.trigger}”`);
    }
}

function toggleSnippet(id, enabled) {
    const snip = doc.snippets.find(s => s.id === id);
    if (snip) {
        snip.enabled = enabled;
        renderSnippetsList();
        updateStatus();
    }
}

// =============================================================================
// 5. 导入与导出
// =============================================================================

function openIOModal(tab = 'export') {
    const modal = $('io-modal');
    modal.hidden = false;
    switchIOTab(tab);
}

function switchIOTab(tab) {
    const isExport = tab === 'export';
    $('tab-export-btn').classList.toggle('active', isExport);
    $('tab-import-btn').classList.toggle('active', !isExport);
    $('panel-export').hidden = !isExport;
    $('panel-import').hidden = isExport;

    if (isExport && doc) {
        $('export-text').value = JSON.stringify(doc.snippets, null, 2);
    }
}

async function doImport() {
    const raw = $('import-text').value.trim();
    if (!raw) {
        notice('请粘贴要导入的配置内容', true);
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        notice('JSON 解析失败，请确保格式正确', true);
        return;
    }

    const mode = document.querySelector('input[name="import-mode"]:checked').value;

    await action(async () => {
        const data = await api('import', { data: parsed, mode });
        acceptData(data);
        $('io-modal').hidden = true;
        notice(`导入成功！已更新快捷键配置。`);
    });
}

// =============================================================================
// 6. 全局事件绑定与生命周期
// =============================================================================

function bindEvents() {
    // 搜索
    $('search-input').addEventListener('input', (e) => {
        searchQuery = e.target.value;
        $('search-clear').hidden = !searchQuery;
        renderSnippetsList();
    });
    $('search-clear').onclick = () => {
        $('search-input').value = '';
        searchQuery = '';
        $('search-clear').hidden = true;
        renderSnippetsList();
        $('search-input').focus();
    };

    // 模式筛选 Pills
    $('mode-filters').addEventListener('click', (e) => {
        const pill = e.target.closest('.pill');
        if (!pill) return;
        $('mode-filters').querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        activeFilter = pill.dataset.filter;
        renderSnippetsList();
    });

    // 排序
    $('sort-select').addEventListener('change', (e) => {
        sortMode = e.target.value;
        renderSnippetsList();
    });

    // 批量开关
    $('btn-batch-toggle').onclick = () => {
        const filtered = getFilteredSnippets();
        if (filtered.length === 0) return;
        const allEnabled = filtered.every(s => s.enabled);
        const newState = !allEnabled;
        filtered.forEach(s => s.enabled = newState);
        renderSnippetsList();
        updateStatus();
        notice(`已${newState ? '启用' : '停用'}当前筛选的 ${filtered.length} 条规则`);
    };

    // 列表内代理事件
    $('snippets-container').addEventListener('click', (e) => {
        const editBtn = e.target.closest('[data-edit-id]');
        if (editBtn) {
            const snip = doc.snippets.find(s => s.id === editBtn.dataset.editId);
            if (snip) openEditModal(snip);
            return;
        }
        const cloneBtn = e.target.closest('[data-clone-id]');
        if (cloneBtn) {
            cloneSnippet(cloneBtn.dataset.cloneId);
            return;
        }
        const deleteBtn = e.target.closest('[data-delete-id]');
        if (deleteBtn) {
            deleteSnippet(deleteBtn.dataset.deleteId);
            return;
        }
    });

    $('snippets-container').addEventListener('change', (e) => {
        const toggle = e.target.closest('[data-toggle-id]');
        if (toggle) {
            toggleSnippet(toggle.dataset.toggleId, toggle.checked);
        }
    });

    // 新建按钮
    $('btn-new-snippet').onclick = () => openEditModal(null);
    $('modal-close-btn').onclick = closeEditModal;
    $('modal-cancel-btn').onclick = closeEditModal;
    $('snippet-form').onsubmit = saveSnippetFromForm;

    // 表单辅助标签插入
    document.querySelectorAll('.helper-tag').forEach(tag => {
        tag.onclick = () => {
            const ins = tag.dataset.insert;
            const textarea = $('edit-replacement');
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.setRangeText(ins, start, end, 'end');
            textarea.focus();
        };
    });

    // 冲突检查
    $('edit-trigger').addEventListener('input', checkConflict);
    $('opt-m').addEventListener('change', checkConflict);
    if ($('opt-M')) $('opt-M').addEventListener('change', checkConflict);
    if ($('opt-n')) $('opt-n').addEventListener('change', checkConflict);
    $('opt-t').addEventListener('change', checkConflict);

    // 复制路径
    $('copy-path-wrap').onclick = () => {
        const path = $('config-path').textContent;
        navigator.clipboard.writeText(path).then(() => {
            notice('已复制配置文件路径至剪贴板');
        });
    };

    // 顶栏操作
    $('btn-toggle-sandbox').onclick = () => {
        const panel = $('sandbox-panel');
        panel.classList.toggle('collapsed');
    };
    $('sandbox-close').onclick = () => {
        $('sandbox-panel').classList.add('collapsed');
    };
    $('sandbox-reset').onclick = () => {
        $('sandbox-input').value = '';
        if (sandboxEngine) sandboxEngine.clearTabStops();
        updateSandboxKaTeX();
        $('sandbox-input').focus();
    };

    // 沙盒示例 Chips
    document.querySelectorAll('.sample-chip').forEach(chip => {
        chip.onclick = () => {
            const sample = chip.dataset.sample || '';
            const needTextMode = (sample === 'mk' || sample === 'dm');
            const targetRadio = document.querySelector(`input[name="sandbox-context"][value="${needTextMode ? 'text' : 'math'}"]`);
            if (targetRadio && !targetRadio.checked) {
                targetRadio.checked = true;
            }
            const input = $('sandbox-input');
            if (sandboxEngine) {
                sandboxEngine.clearTabStops();
                sandboxEngine.lastValLength = 0;
            }
            input.value = sample;
            input.focus();
            input.setSelectionRange(sample.length, sample.length);
            input.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'insertText',
                data: sample
            }));
        };
    });

    // 上下文单选
    document.querySelectorAll('input[name="sandbox-context"]').forEach(r => {
        r.onchange = () => {
            if (sandboxEngine) sandboxEngine.clearTabStops();
            updateSandboxKaTeX();
        };
    });

    // 导入导出
    $('btn-import-export').onclick = () => openIOModal('export');
    $('tab-export-btn').onclick = () => switchIOTab('export');
    $('tab-import-btn').onclick = () => switchIOTab('import');
    $('io-close-btn').onclick = () => $('io-modal').hidden = true;
    $('btn-copy-export').onclick = () => {
        navigator.clipboard.writeText($('export-text').value).then(() => notice('已复制 JSON 文本至剪贴板'));
    };
    $('btn-download-export').onclick = () => {
        const blob = new Blob([$('export-text').value], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'latex-snippets.json';
        a.click();
        URL.revokeObjectURL(url);
    };
    $('btn-do-import').onclick = doImport;

    // 重新加载
    $('reload').onclick = () => {
        if (isDirty() && !confirm('当前有未保存的更改，重新加载将放弃这些更改，是否继续？')) {
            return;
        }
        action(async () => {
            const data = await api('snippets');
            acceptData(data);
            notice('已重新加载最新配置');
        });
    };

    // 恢复备份
    $('restore').onclick = () => {
        if (!confirm('确定要恢复上一版备份吗？当前设置将被覆盖。')) return;
        action(async () => {
            const data = await api('restore', {});
            acceptData(data);
            notice('已成功恢复至上一版备份并同步至阅读器');
        });
    };

    // 保存设置 (Ctrl+S)
    const saveAction = () => {
        if (!doc) return;
        action(async () => {
            const data = await api('save', {
                snippets: doc.snippets,
                revision: doc.revision
            });
            acceptData(data);
            notice('🎉 保存成功！已同步更新至 static/config.js。阅读器刷新即可生效。');
        });
    };
    $('save').onclick = saveAction;

    // 退出
    $('quit').onclick = async () => {
        if (isDirty() && !confirm('您有未保存的更改，退出将不会保存这些修改，确定退出吗？')) {
            return;
        }
        try {
            await api('quit', {});
        } catch (_) {}
        document.body.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#4b5563;">
                <div style="font-size:48px;margin-bottom:12px;">👋</div>
                <h2 style="font-size:20px;color:#111827;margin-bottom:8px;">服务已安全关闭</h2>
                <p style="font-size:14px;color:#6b7280;">您可以随时通过根目录的 Snippet-Manager.bat 再次打开管理工具。</p>
            </div>
        `;
        window.close();
    };

    // 全局快捷键
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveAction();
        } else if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            e.preventDefault();
            $('search-input').focus();
        } else if (e.key === 'Escape') {
            if (!$('edit-modal').hidden) closeEditModal();
            else if (!$('io-modal').hidden) $('io-modal').hidden = true;
        }
    });

    // 防误触关闭
    window.addEventListener('beforeunload', (e) => {
        if (isDirty()) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
}

// 启动入口
async function init() {
    bindEvents();
    await action(async () => {
        const data = await api('snippets');
        acceptData(data);
    });
}

document.addEventListener('DOMContentLoaded', init);
