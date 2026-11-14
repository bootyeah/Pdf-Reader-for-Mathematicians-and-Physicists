(function () {
    'use strict';

    // 量子速录引擎（Reader 笔记编辑窗与 Snippet-Manager 沙盒共用）
    class QuantumSnippetEngine {
        constructor(textarea, snippetsOrGetter, options = {}) {
            this.textarea = textarea;
            this.activeTabStops = [];
            this.totalStopsForCurrent = 0;
            this.lastValLength = textarea.value.length;
            this.isExpanding = false;
            this.onCommit = typeof options.onCommit === 'function' ? options.onCommit : null;
            this.onTabStopsChange = typeof options.onTabStopsChange === 'function' ? options.onTabStopsChange : null;
            this.onAfterChange = typeof options.onAfterChange === 'function' ? options.onAfterChange : null;
            this.isForcedMath = typeof options.isForcedMath === 'function' ? options.isForcedMath : null;
            this._onlyEnabled = !!options.onlyEnabled;

            // 动态替换模板变量（移除 SYMBOL 中的 pm|mp 以免截断 pmat 矩阵，保留 +- / -+ 快捷输入）
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

            if (typeof snippetsOrGetter === 'function') {
                this._snippetsFn = snippetsOrGetter;
                this.snippets = [];
            } else {
                this._snippetsFn = null;
                this.snippets = this._compileSnippets(Array.isArray(snippetsOrGetter) ? snippetsOrGetter : []);
            }

            this.bindEvents();
        }

        _compileSnippets(rawList) {
            const filtered = (rawList || []).filter(s => (
                s && (this._onlyEnabled ? !!s.enabled : s.enabled !== false)
            ));
            const compiled = filtered.map((snip, idx) => {
                const item = { ...snip, _order: idx };
                const opts = String(item.options || '');
                const isRegex = opts.includes('r') || item.trigger instanceof RegExp || !!item.is_regex;
                item._isRegex = isRegex;
                if (isRegex) {
                    const rawSource = item.trigger instanceof RegExp ? item.trigger.source : String(item.trigger || '');
                    const flags = item.trigger instanceof RegExp
                        ? item.trigger.flags
                        : String(item.regex_flags || '');
                    const expanded = rawSource
                        .replace(/\$\{GREEK\}/g, this.GREEK)
                        .replace(/\$\{SYMBOL\}/g, this.SYMBOL)
                        .replace(/\$\{MORE_SYMBOLS\}/g, this.MORE_SYMBOLS)
                        .replace(/\$\{VISUAL\}/g, "");
                    const anchored = expanded.endsWith('$') ? expanded : expanded + '$';
                    try {
                        item.trigger = new RegExp(expanded, flags);
                        item._compiledRegex = new RegExp(anchored, flags);
                    } catch (_) {
                        item._compiledRegex = null;
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

            // 按优先级降序排列；同优先级下，纯文本触发词按长度降序，消除短词后缀遮蔽
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

        getSnippets() {
            if (!this._snippetsFn) return this.snippets;
            return this._compileSnippets(this._snippetsFn());
        }

        hasActiveTabStops() {
            return Array.isArray(this.activeTabStops) && this.activeTabStops.length > 0;
        }

        notifyTabStops() {
            if (!this.onTabStopsChange) return;
            const currentIndex = this.totalStopsForCurrent > 0
                ? Math.max(0, this.totalStopsForCurrent - this.activeTabStops.length)
                : 0;
            const displayArr = this.activeTabStops.length > 0
                ? new Array(this.totalStopsForCurrent)
                : [];
            this.onTabStopsChange(displayArr, currentIndex);
        }

        clearTabStops() {
            this.activeTabStops = [];
            this.totalStopsForCurrent = 0;
            this.notifyTabStops();
        }

        // 智能上下文状态机：一次扫描同时识别行内数学($...$)、块级数学($$...$$ / \begin{})、
        // 非数学绘图环境(tikzpicture / circuitikz / forest 等)以及数学内嵌文本(\text{} / \ce{} 等)
        getContextMode(textBefore) {
            const forcedMath = this.isForcedMath ? !!this.isForcedMath() : false;
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
                    const regex = snip._compiledRegex;
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
            // 拦截快捷键：支持 Ctrl+Enter 快速提交保存，拦截 Tab 键执行手动展开与多级占位符跃迁
            this.textarea.addEventListener('keydown', (e) => {
                if (e.isComposing || e.keyCode === 229) return;
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    if (this.onCommit) {
                        e.preventDefault();
                        this.onCommit(e);
                        return;
                    }
                    if (typeof commitNoteEdit === 'function') {
                        e.preventDefault();
                        const currentAnno = commitNoteEdit();
                        if (currentAnno && typeof renderNotePreview === 'function') {
                            renderNotePreview(this.textarea.value, currentAnno, state.activePageNum);
                        }
                        els.noteModal?.classList.add('hidden');
                        state.activeAnnotationId = null;
                        return;
                    }
                }
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
                                this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
                                if (this.onAfterChange) this.onAfterChange();
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
                            this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
                        } else {
                            this.clearTabStops();
                        }
                        if (this.onAfterChange) this.onAfterChange();
                    }
                } else if (e.key === 'Escape' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    this.clearTabStops();
                }
            });

            // 核心拦截层
            this.textarea.addEventListener('input', (e) => {
                if (this.isExpanding) return;

                let currentVal = this.textarea.value;
                const delta = currentVal.length - this.lastValLength;
                this.lastValLength = currentVal.length;
                let cursorPos = this.textarea.selectionStart;

                // 纯数学增量追踪 + 同名占位符实时镜像同步（含选中默认值等长覆盖 delta === 0 的场景）
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

                // 中文等输入法组字期间不触发缩写，避免误伤拼音（如 dm/mk）
                if (e.isComposing) {
                    if (this.onAfterChange) this.onAfterChange();
                    return;
                }
                if (e.inputType !== 'insertText' && e.inputType !== 'insertCompositionText') {
                    if (this.onAfterChange) this.onAfterChange();
                    return;
                }

                const textBefore = currentVal.slice(0, cursorPos);
                const hit = this.findMatchingSnippet(textBefore, false);
                if (hit) {
                    this.executeSnippet(hit.snip, hit.matchResult, hit.matchLength, cursorPos);
                } else if (this.onAfterChange) {
                    this.onAfterChange();
                }
            });

            // 失去焦点时自动清理残存状态
            this.textarea.addEventListener('blur', () => {
                this.clearTabStops();
            });
        }

        executeSnippet(snip, match, matchLength, cursorPos) {
            let replacement = snip.replacement;

            // 1. 处理函数映射 (如 iden 矩阵)
            if (typeof replacement === 'function') {
                replacement = replacement(match);
            }
            // 2. 处理正则组替换 (Obsidian 语法的 [[0]] 映射为 regex match[1])
            else if (snip._isRegex) {
                replacement = String(replacement ?? '').replace(/\[\[(\d+)\]\]/g, (m, g1) => match[parseInt(g1, 10) + 1] || '');
            } else {
                replacement = String(replacement ?? '');
            }

            const groupsMap = new Map();
            let finalStr = "";
            let currentIndex = 0;

            // 解析时空占位符：$0, $1, ${1:def}, ${VISUAL}
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

                // 模拟人类输入推入 Ctrl+Z 撤销栈；失败则优雅降级回 setRangeText
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
            // 触发原生的实时预览引擎 (Live Preview)
            this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
            if (this.onAfterChange) this.onAfterChange();
        }
    }

    window.QuantumSnippetEngine = QuantumSnippetEngine;
})();
