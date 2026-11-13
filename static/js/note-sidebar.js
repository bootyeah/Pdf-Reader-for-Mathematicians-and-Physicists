        function rollbackLivePreview() {
            if (state.originalAnnoSnapshot && state.activeAnnotationId && state.isEditingNote) {
                const pNum = state.activePageNum;
                if (state.annotations[pNum]) {
                    const idx = state.annotations[pNum].findIndex(a => a.id === state.activeAnnotationId);
                    if (idx !== -1) {
                        // 判断是否在预览时发生了修改，如果有，用快照覆盖回去并重绘本页
                        if (JSON.stringify(state.annotations[pNum][idx]) !== JSON.stringify(state.originalAnnoSnapshot)) {
                            state.annotations[pNum][idx] = JSON.parse(JSON.stringify(state.originalAnnoSnapshot));
                            renderAnnotations(pNum);
                        }
                    }
                }
            }
            state.originalAnnoSnapshot = null;
        }

        function openNoteModal(anno, pageNum, clientX, clientY, forceEditMode = false) {
            window.FormulaInput?.reset();
            state.activeAnnotationId = anno.id;
            state.activePageNum = pageNum;
            
            state.originalAnnoSnapshot = JSON.parse(JSON.stringify(anno));

            if (anno.type === 'text') {
                els.noteInput.placeholder = '点击编辑文本';
                const initialVal = (anno.note === '点击编辑文本' || anno.text === '点击编辑文本') ? '' : (anno.note || anno.text || '');
                els.noteInput.value = initialVal;
            } else {
                els.noteInput.placeholder = '支持 LaTeX 公式，如 $$x^2$$';
                els.noteInput.value = anno.note || '';
            }
            els.noteModal.classList.remove('hidden');
            window.FloatingWindowLayers?.bringToFront(els.noteModal);
            
            const sizeControls = document.getElementById('text-size-controls');
            const snippetBtn = document.getElementById('save-snippet-btn'); 

            // 1. A- / A+ 字号控制：文本块 和 矢量图章 均可使用
            if (anno.type === 'text' || MARKER_CONFIG[anno.type]) {
                sizeControls.classList.remove('hidden'); 
            } else {
                sizeControls.classList.add('hidden');
            }

            // 2. 存为素材控制：仅 文本块 (包含公式和TikZ) 允许收藏，图章不需要
            if (anno.type === 'text') {
                snippetBtn.classList.remove('hidden'); 
            } else {
                snippetBtn.classList.add('hidden'); 
            }

            const defaultW = 320; // 加大后的默认宽度
            const defaultH = 260; // 加大后的默认高度

            // 核心：每次打开，强行覆盖拉伸状态，恢复成默认大小！
            els.noteModal.style.width = `${defaultW}px`;
            els.noteModal.style.height = `${defaultH}px`;

            // 用新尺寸计算防止溢出屏幕的边界
            let left = clientX + 20, top = clientY;
            if (left + defaultW > window.innerWidth) left = clientX - defaultW - 20;
            if (top + defaultH > window.innerHeight) top = window.innerHeight - defaultH - 10;
            
            els.noteModal.style.left = `${Math.max(10, left)}px`;
            els.noteModal.style.top = `${Math.max(10, top)}px`;
            window.FloatingWindowLayers?.clearViewportBase(els.noteModal);

            if (anno.note && !forceEditMode) {
                setNoteMode('preview');
                renderNotePreview(anno.note, anno, pageNum);
            } else {
                setNoteMode('edit');
                setTimeout(() => els.noteInput.focus(), 50);
            }
        }

        // 把当前输入框里的内容落库（写数据 + 存本地 + 进撤销栈 + 刷新界面）。
        // 「保存」按钮与「点击弹窗外部」共用这一条路径，两者行为完全一致。
        function commitNoteEdit() {
            if (!state.activeAnnotationId || !state.isEditingNote) return null;

            clearTimeout(state.livePreviewTimer); // 停掉尚未执行的实时预览，避免关闭弹窗后再去重绘

            // 实时预览已经写过 anno.text；先还原编辑前的文本，让 Delta 撤销栈
            // 记录真正的前后差异（包括公式插入后等待预览、再点击保存的情况）。
            const liveAnno = state.annotations[state.activePageNum]?.find(a => a.id === state.activeAnnotationId);
            const sizingKeys = ['width', 'height', 'fontSizeScale', 'size'];
            const liveSizing = {};
            if (liveAnno && state.originalAnnoSnapshot) {
                // 内容自适应和 A-/A+ 的实时变化与文本一起进入同一条撤销记录。
                for (const key of sizingKeys) {
                    if (Object.prototype.hasOwnProperty.call(liveAnno, key)) liveSizing[key] = liveAnno[key];
                    if (Object.prototype.hasOwnProperty.call(state.originalAnnoSnapshot, key)) liveAnno[key] = state.originalAnnoSnapshot[key];
                    else delete liveAnno[key];
                }
                if (liveAnno.type === 'text') {
                    liveAnno.text = state.originalAnnoSnapshot.text;
                    liveAnno.tikzBase64 = state.originalAnnoSnapshot.tikzBase64;
                    liveAnno.imgH = state.originalAnnoSnapshot.imgH;
                }
            }

            let currentAnno = null;
            performAction(() => {
                const anno = state.annotations[state.activePageNum]?.find(a => a.id === state.activeAnnotationId);
                if (anno) {
                    currentAnno = anno;
                    const newText = els.noteInput.value;
                    if (state.originalAnnoSnapshot) {
                        for (const key of sizingKeys) {
                            if (Object.prototype.hasOwnProperty.call(liveSizing, key)) anno[key] = liveSizing[key];
                            else delete anno[key];
                        }
                    }
                    if (anno.type === 'text') {
                        if (!state.originalAnnoSnapshot || state.originalAnnoSnapshot.text !== newText) {
                            anno.text = newText;
                            resetTextAnnotationSize(anno);
                            // 擦除本地 TeX 渲染图片的缓存，强迫它读取新尺寸重新生成
                            anno.tikzBase64 = null;
                            anno.imgH = null;
                        }

                    } else {
                        if (anno.note !== newText) {
                            anno.note = newText;
                            anno.tikzBase64 = null;
                        }
                    }
                }
            }, [state.activePageNum]);

            state.originalAnnoSnapshot = null; // 保存成功后清空快照
            setNoteMode('preview');

            return currentAnno;
        }

        let closeNoteLivePreview = null;
        function setNoteMode(mode) {
            closeNoteLivePreview?.();
            closeNoteLivePreview = null;
            if (mode !== 'edit') window.FormulaInput?.reset();
            const selectAllBtn = document.getElementById('select-all-btn'); 
            const copyBtn = document.getElementById('copy-note-btn');
            
            if (mode === 'edit') {
                if (!state.isEditingNote && !state.originalAnnoSnapshot) {
                    const anno = state.annotations[state.activePageNum]?.find(a => a.id === state.activeAnnotationId);
                    if (anno) state.originalAnnoSnapshot = JSON.parse(JSON.stringify(anno));
                }
                els.noteInput.classList.remove('hidden'); els.notePreview.classList.add('hidden');
                els.toggleEditBtn.textContent = '取消'; els.saveNoteBtn.textContent = '保存';
                if (copyBtn) copyBtn.classList.remove('hidden');
                if (selectAllBtn) selectAllBtn.classList.remove('hidden'); 
                state.isEditingNote = true;
                closeNoteLivePreview = window.LatexLivePreview.open(els.noteInput, els.noteModal, {
                    avoid: findTextAnnotationDiv(state.activeAnnotationId, state.activePageNum),
                    // 预览右键改了光标后，立即把正文文本块上的红光标同步过去。
                    onCaretMove: () => {
                        refreshActiveTextCursor();
                        if (typeof window.syncVirtualCursor === 'function') window.syncVirtualCursor();
                    }
                });

                // 上一个文本块可能还留着幻影节点；先把它按源码重建干净，再把光标画到本次编辑的块上。
                clearTimeout(state.livePreviewTimer);
                endCursorTracking();
                refreshActiveTextCursor();

                if (typeof window.syncVirtualCursor === 'function') {
                    if (cursorSyncFrameId) cancelAnimationFrame(cursorSyncFrameId);
                    requestAnimationFrame(window.syncVirtualCursor);
                }
                
            } else {
                els.noteInput.classList.add('hidden'); els.notePreview.classList.remove('hidden');
                els.toggleEditBtn.textContent = '编辑'; els.saveNoteBtn.textContent = '确定';
                if (copyBtn) copyBtn.classList.add('hidden');
                if (selectAllBtn) selectAllBtn.classList.add('hidden');    
                state.isEditingNote = false;
                // 退出编辑：幻影节点插在正文中间，直接删会把公式内容一起带走，必须按源码整块重建
                endCursorTracking();
            }
        }

        function renderNotePreview(text, anno = null, pageNum = null) {
            els.notePreview.textContent = text || '无笔记内容';
            if (!text) els.notePreview.innerHTML = '<span class="text-gray-400 italic">无笔记内容</span>';
            else renderLatex(els.notePreview, anno, pageNum);
        }

        els.notePreview.addEventListener('click', () => { setNoteMode('edit'); els.noteInput.focus(); });

        els.toggleEditBtn.addEventListener('click', () => {
            if (state.isEditingNote) {
                rollbackLivePreview();
                const anno = state.annotations[state.activePageNum]?.find(a => a.id === state.activeAnnotationId);
                let content = anno?.note;
                if (anno?.type === 'text') content = anno.text;
                
                els.noteInput.value = content || '';
                setNoteMode('preview'); renderNotePreview(content, anno, state.activePageNum);
            } else { setNoteMode('edit'); els.noteInput.focus(); }
        });

        els.saveNoteBtn.addEventListener('click', () => {
            if (!state.activeAnnotationId) return;
            if (state.isEditingNote) {
                const currentAnno = commitNoteEdit();
                renderNotePreview(els.noteInput.value, currentAnno, state.activePageNum);
            } else {
                els.noteModal.classList.add('hidden');
                state.activeAnnotationId = null;
            }
        });

        class QuantumSnippetEngine {
            constructor(textarea, snippets, options = {}) {
                this.textarea = textarea;
                this.snippets = snippets.map((snip, idx) => ({ ...snip, _order: idx }));
                this.activeTabStops = [];
                this.lastValLength = textarea.value.length;
                this.isExpanding = false;
                this.onCommit = typeof options.onCommit === 'function' ? options.onCommit : null;

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

                this.initSnippets();
                this.bindEvents();
            }

            hasActiveTabStops() {
                return Array.isArray(this.activeTabStops) && this.activeTabStops.length > 0;
            }

            clearTabStops() {
                this.activeTabStops = [];
            }

            initSnippets() {
                this.snippets.forEach(snip => {
                    const opts = String(snip.options || '');
                    const isRegex = opts.includes('r') || snip.trigger instanceof RegExp;
                    snip._isRegex = isRegex;
                    if (isRegex) {
                        const rawSource = snip.trigger instanceof RegExp ? snip.trigger.source : String(snip.trigger || '');
                        const flags = snip.trigger instanceof RegExp ? snip.trigger.flags : '';
                        const expanded = rawSource
                            .replace(/\$\{GREEK\}/g, this.GREEK)
                            .replace(/\$\{SYMBOL\}/g, this.SYMBOL)
                            .replace(/\$\{MORE_SYMBOLS\}/g, this.MORE_SYMBOLS)
                            .replace(/\$\{VISUAL\}/g, "");
                        snip.trigger = new RegExp(expanded, flags);
                        const anchored = expanded.endsWith('$') ? expanded : expanded + '$';
                        snip._compiledRegex = new RegExp(anchored, flags);
                        snip._expectsBackslash = expanded.startsWith('\\\\') || expanded.startsWith('\\(') || expanded.startsWith('\\');
                        snip._isAutoSpace = rawSource.includes('${MORE_SYMBOLS})([A-Za-z])');
                    } else {
                        const trigStr = String(snip.trigger || '');
                        snip._expectsBackslash = trigStr.startsWith('\\');
                        snip._isAutoSpace = false;
                    }
                });

                // 按优先级降序排列；同优先级下，纯文本触发词按长度降序，消除短词后缀遮蔽
                this.snippets.sort((a, b) => {
                    const prioDiff = (b.priority || 0) - (a.priority || 0);
                    if (prioDiff !== 0) return prioDiff;
                    const lenA = a._isRegex ? 0 : String(a.trigger || '').length;
                    const lenB = b._isRegex ? 0 : String(b.trigger || '').length;
                    if (lenB !== lenA) return lenB - lenA;
                    return (a._order || 0) - (b._order || 0);
                });
            }

            // 智能上下文状态机：一次扫描同时识别行内数学($...$)、块级数学($$...$$ / \begin{})、
            // 非数学绘图环境(tikzpicture / circuitikz / forest 等)以及数学内嵌文本(\text{} / \ce{} 等)
            getContextMode(textBefore) {
                const stack = [{ type: 'text' }];
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

                for (const snip of this.snippets) {
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
                        e.preventDefault();
                        if (this.onCommit) {
                            this.onCommit(e);
                        } else if (typeof commitNoteEdit === 'function') {
                            const currentAnno = commitNoteEdit();
                            if (currentAnno && typeof renderNotePreview === 'function') {
                                renderNotePreview(this.textarea.value, currentAnno, state.activePageNum);
                            }
                            els.noteModal?.classList.add('hidden');
                            state.activeAnnotationId = null;
                        }
                        return;
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
                                    }
                                    this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
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
                                    this.activeTabStops = [];
                                }
                                this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
                            }
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
                        } else if (delta !== 0) {
                            this.clearTabStops();
                        }
                    }

                    // 中文等输入法组字期间不触发缩写，避免误伤拼音（如 dm/mk）
                    if (e.isComposing) return;
                    if (e.inputType !== 'insertText' && e.inputType !== 'insertCompositionText') return;

                    const textBefore = currentVal.slice(0, cursorPos);
                    const hit = this.findMatchingSnippet(textBefore, false);
                    if (hit) {
                        this.executeSnippet(hit.snip, hit.matchResult, hit.matchLength, cursorPos);
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
                    replacement = replacement.replace(/\[\[(\d+)\]\]/g, (m, g1) => match[parseInt(g1, 10) + 1] || '');
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

                    // 🌟 模拟人类输入推入 Ctrl+Z 撤销栈；失败则优雅降级回 setRangeText
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
                            }
                        } else {
                            this.activeTabStops = newGroups;
                        }
                    } else {
                        this.activeTabStops = newGroups;
                    }

                    if (newGroups.length > 0) {
                        const firstRange = this.activeTabStops[0].ranges[0];
                        this.textarea.setSelectionRange(firstRange.start, firstRange.end);
                    }
                } finally {
                    this.isExpanding = false;
                }

                // 触发原生的实时预览引擎 (Live Preview)
                this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }

        // 导出至全局 window，供思维导图等模块共用
        window.QuantumSnippetEngine = QuantumSnippetEngine;

        // 【挂载启动引擎】
        new QuantumSnippetEngine(els.noteInput, LATEX_SNIPPETS);

        
        // 1. 上下文嗅探与幻影注入
        function injectPhantomCursor(text, cursorIndex, idPrefix = 'phantom-cursor') {
            if (typeof text !== 'string') return '';
            if (text.length === 0) return `<span id="${idPrefix}" style="display:inline-block;width:0;height:1em;vertical-align:middle;"></span>`;

            const escapeHTML = (str) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

            const envs = LATEX_CONFIG.environments.join('|');
            const tikzRegex = new RegExp("\\\\begin\\{(" + envs + ")\\}[\\s\\S]*?\\\\end\\{\\1\\}", 'g');
            const mathRegex = /(\$\$[\s\S]*?\$\$|\$[\s\S]*?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g;

            let match;
            
            let isInsideTikz = false;
            while ((match = tikzRegex.exec(text)) !== null) {
                if (cursorIndex >= match.index && cursorIndex <= tikzRegex.lastIndex) {
                    isInsideTikz = true;
                    break;
                }
            }
            if (isInsideTikz) return escapeHTML(text); // 遇到 TikZ，不注入任何幻影节点！

            // 如果不是 TikZ，继续处理 KaTeX 数学公式的光标包裹
            let mathBlocks = [];
            while ((match = mathRegex.exec(text)) !== null) {
                mathBlocks.push({ start: match.index, end: mathRegex.lastIndex });
            }
            let insideMath = mathBlocks.find(b => cursorIndex >= b.start && cursorIndex <= b.end);

            if (insideMath) {
                const before = escapeHTML(text.substring(0, insideMath.start));
                // 提取公式原文（未转义），用于判断是块级还是行内
                const rawInside = text.substring(insideMath.start, insideMath.end);
                const inside = escapeHTML(rawInside);
                const after = escapeHTML(text.substring(insideMath.end));
                
                const isBlockMath = rawInside.startsWith('$$') || rawInside.startsWith('\\[');
                if (isBlockMath) {
                    return `${before}<div id="${idPrefix}-block" style="display:block; text-align:center; width:100%; transition: all 0.2s;">${inside}</div>${after}`;
                } else {
                    return `${before}<span id="${idPrefix}-block" style="display:inline-block; transition: all 0.2s;">${inside}</span>${after}`;
                }
            } else {
                const before = escapeHTML(text.substring(0, cursorIndex));
                const after = escapeHTML(text.substring(cursorIndex));
                return `${before}<span id="${idPrefix}" style="display:inline-block;width:0px;height:1em;vertical-align:middle;">&#8203;</span>${after}`;
            }
        }

        // 正文文本块与旁侧预览共用同一套红色竖线 / 公式红框样式。
        function paintVirtualCursor(cursor, rect, isText, origin = { left: 0, top: 0 }) {
            cursor.style.left = `${rect.left - origin.left - (isText ? 0 : 2)}px`;
            cursor.style.top = `${rect.top - origin.top - (isText ? 0 : 2)}px`;
            cursor.style.width = isText ? '2px' : `${rect.width + 4}px`;
            cursor.style.height = `${isText ? Math.max(rect.height, 14) : rect.height + 4}px`;
            cursor.style.backgroundColor = isText ? 'rgba(239, 68, 68, 0.7)' : 'rgba(239, 68, 68, 0.1)';
            cursor.style.border = isText ? 'none' : '1.5px dashed rgba(239, 68, 68, 0.6)';
            cursor.style.boxShadow = isText ? '0 0 4px rgba(239, 68, 68, 0.5)' : 'none';
            cursor.classList.toggle('animate-pulse', isText);
        }

        // 2. 物理坐标侦测与高频雷达追踪 (rAF Loop)
        let cursorSyncFrameId = null;

        // 画面上当前承载幻影光标的文本块。光标只认它，绝不认文档里其它块残留的幻影节点；
        // 否则切换文本块时红光标会停在上一个块上，直到重排（缩放/刷新）把残留节点抹掉。
        let phantomMemo = { div: null, annotationId: null, pageNum: null, version: -1, cursor: -1, text: null };

        function findTextAnnotationDiv(annotationId, pageNum = state.activePageNum) {
            const container = document.getElementById(`annotation-layer-${pageNum}`);
            if (!container) return null;
            const idStr = String(annotationId);
            for (const div of container.querySelectorAll('.text-annotation')) {
                if (div.dataset.id === idStr) return div;
            }
            const anno = (state.annotations[pageNum] || []).find(a => a.id === annotationId);
            const source = (anno?.text || '').replace(/\r\n?/g, '\n');
            for (const div of container.querySelectorAll('.text-annotation')) {
                if (textAnnotationSources.get(div) === source) return div;
            }
            // data-id 会被幻影注入时重写的 innerHTML 丢掉，此处仅作最后兜底。
            return container.querySelector(`.text-annotation[data-id="${annotationId}"]`);
        }

        // 只认当前文本块里的幻影节点。(按 id 找会误中其它块遗留的那一个)
        function phantomCursorIn(div) {
            if (!div || !div.isConnected) return null;
            return div.querySelector('#phantom-cursor') || div.querySelector('#phantom-cursor-block');
        }

        // 把「输入框光标 + 当前文本」画到文本块上，供下面的雷达逐帧读取坐标。
        // 只在开块、切块、雷达发现画面过期时调用；打字走 30ms 防抖那条路，保持跟手。
        function renderCursorPreview(annotationId, pageNum, text, cursorIndex) {
            const anno = state.annotations[pageNum]?.find(a => a.id === annotationId);
            if (!anno || anno.type !== 'text') return;
            const div = findTextAnnotationDiv(annotationId, pageNum);
            if (!div) return; // 文本块不在渲染窗口里（如已翻到别的页），雷达会隐藏光标
            const source = String(text ?? '');
            const index = Math.max(0, Math.min(Number(cursorIndex) || 0, source.length));
            const isPlaceholder = !source || source === '点击编辑文本';
            if (isPlaceholder) {
                div.innerHTML = `<span id="phantom-cursor" style="display:inline-block;width:0px;height:1em;vertical-align:middle;">&#8203;</span><span style="color:#9ca3af;">点击编辑文本</span>`;
                div.style.color = '#9ca3af';
                div.classList.add('text-placeholder');
            } else {
                div.style.color = anno.color || '#000000';
                div.classList.remove('text-placeholder');
                div.innerHTML = injectPhantomCursor(source, index) || '点击编辑文本';
            }
            renderLatex(div, anno, pageNum);
            phantomMemo = { div, annotationId, pageNum, version: textAnnotationRenderVersion, cursor: index, text: source };
        }

        // 让画面上的幻影节点回到与输入框光标一致的位置。没有任何失效时保持不动，避免空转重绘。
        function refreshActiveTextCursor() {
            if (!state.isEditingNote || state.activeAnnotationId == null) return;
            const anno = state.annotations[state.activePageNum]?.find(a => a.id === state.activeAnnotationId);
            if (!anno || anno.type !== 'text') return;
            const text = els.noteInput.value;
            const index = els.noteInput.selectionStart ?? 0;
            if (phantomMemo.div?.isConnected && textAnnotationSources.get(phantomMemo.div) === text
                && phantomMemo.version === textAnnotationRenderVersion
                && phantomMemo.cursor === index && phantomMemo.text === text
                && phantomCursorIn(phantomMemo.div)) return;
            renderCursorPreview(state.activeAnnotationId, state.activePageNum, text, index);
        }

        // 注入过幻影光标的画面只能用源码整块重建，绝不能就地摘掉幻影节点：
        // 幻影节点是插在文本中间的，KaTeX 一次编译后 DOM 会被改写成一堆嵌套 span，
        // 只删那个节点会把公式内容一起带走（实测只剩 "head  tail"），而且再也编译不回来。
        function restoreTextBlockFromSource(div, annotationId, pageNum, source) {
            if (!div?.isConnected) return;
            const anno = state.annotations[pageNum]?.find(a => a.id === annotationId);
            if (!anno || anno.type !== 'text') return;
            const isPlaceholder = !source || source === '点击编辑文本';
            if (isPlaceholder) {
                div.textContent = '点击编辑文本';
                div.style.color = '#9ca3af';
                div.classList.add('text-placeholder');
            } else {
                div.textContent = source;
                div.style.color = anno.color || '#000000';
                div.classList.remove('text-placeholder');
            }
            renderLatex(div, anno, pageNum);
        }

        // 结束光标追踪时把画面还原成纯源码：先重建，再摘幻影节点。
        // 没注入过幻影节点的块（例如右键定位后一个字都没动）本来就是干净渲染，不必重绘。
        function endCursorTracking() {
            const { div, annotationId, pageNum, text } = phantomMemo;
            if (div) {
                if (phantomCursorIn(div)) restoreTextBlockFromSource(div, annotationId, pageNum, text);
                else clearPhantomCursor();
            }
        }

        // 摘掉幻影节点并作废位置缓存。节点的宿主块已由 endCursorTracking() 重建。
        function clearPhantomCursor() {
            for (const phantom of document.querySelectorAll('#phantom-cursor, #phantom-cursor-block')) phantom.remove();
            phantomMemo = { div: null, annotationId: null, pageNum: null, version: -1, cursor: -1, text: null };
        }

        window.syncVirtualCursor = function() {
            if (cursorSyncFrameId) cancelAnimationFrame(cursorSyncFrameId);
            cursorSyncFrameId = null;
            // 1. 如果退出了编辑模式，彻底清理光标并终止雷达
            if (!state.isEditingNote) {
                const vCursor = document.getElementById('virtual-cursor');
                if (vCursor) vCursor.style.display = 'none';
                return;
            }

            // 2. 🚀 只要还在编辑状态，雷达绝对不能停！立刻挂载下一帧扫描！
            cursorSyncFrameId = requestAnimationFrame(window.syncVirtualCursor);

            if (phantomMemo.text === els.noteInput.value) {
                refreshActiveTextCursor();
            }

            // 3. 只取「当前正在编辑的文本块」里的幻影节点，其它块的一律不算数
            const phantom = phantomCursorIn(phantomMemo.div);
            let vCursor = document.getElementById('virtual-cursor');

            // 4. 如果因为防抖延迟暂时没找到节点，先隐藏光标，但雷达继续工作
            if (!phantom) {
                if (vCursor) vCursor.style.display = 'none';
                return;
            }

            // 5. 找到了节点，开始绘制物理光标
            if (!vCursor) {
                vCursor = document.createElement('div');
                vCursor.id = 'virtual-cursor';
                vCursor.className = 'fixed pointer-events-none z-[100]';
                document.body.appendChild(vCursor);
            }

            vCursor.style.display = 'block';
            paintVirtualCursor(vCursor, phantom.getBoundingClientRect(), phantom.id === 'phantom-cursor');
        };

        els.noteInput.addEventListener('input', (e) => {
            if (!state.activeAnnotationId || !state.isEditingNote) return;

            const anno = state.annotations[state.activePageNum].find(a => a.id === state.activeAnnotationId);
            if (!anno || anno.type !== 'text') return;

            const newText = e.target.value;

            // 🌟 智能嗅探：判断当前输入的内容是否包含需要呼叫本地 TeX 引擎的 TikZ 图形
            const hasTexGraphics = LATEX_CONFIG.environments.some(env => 
                newText.includes(`\\begin{${env}}`)
            );
            
            // 如果只有 KaTeX 和纯文本，仅延迟 30ms（丝滑跟手）；如果有 TikZ，延迟 300ms（防止本地进程频繁重启）
            const delay = hasTexGraphics ? 300 : 30;

            clearTimeout(state.livePreviewTimer);
            const targetId = state.activeAnnotationId;
            const targetPage = state.activePageNum;
            state.livePreviewTimer = setTimeout(() => {
                // 防抖期间可能已经关闭或切到了别的文本块，这次预览就此作废。
                if (!state.isEditingNote || state.activeAnnotationId !== targetId || state.activePageNum !== targetPage) return;

                const contentChanged = anno.text !== newText;
                if (contentChanged) {
                    anno.text = newText;
                    anno.tikzBase64 = null;
                    anno.imgH = null;
                }

                // 2. 极速查询该文本块所在的真实 DOM 节点（data-id 会被幻影注入抹掉，按源码定位）
                const textDiv = findTextAnnotationDiv(targetId, targetPage);
                if (contentChanged) resetTextAnnotationSize(anno, textDiv);

                if (textDiv) {
                    const cursorPos = els.noteInput.selectionStart ?? 0;
                    const isPlaceholder = !newText || newText === '点击编辑文本';
                    if (isPlaceholder) {
                        textDiv.innerHTML = `<span id="phantom-cursor" style="display:inline-block;width:0px;height:1em;vertical-align:middle;">&#8203;</span><span style="color:#9ca3af;">点击编辑文本</span>`;
                        textDiv.style.color = '#9ca3af';
                        textDiv.classList.add('text-placeholder');
                    } else {
                        textDiv.style.color = anno.color || '#000000';
                        textDiv.classList.remove('text-placeholder');
                        const injectedHTML = injectPhantomCursor(newText, cursorPos);
                        textDiv.innerHTML = injectedHTML || '';
                    }
                    
                    // 3. 调用原生的渲染引擎重新生成
                    renderLatex(textDiv, anno, targetPage);
                    phantomMemo = { div: textDiv, annotationId: targetId, pageNum: targetPage, version: textAnnotationRenderVersion, cursor: cursorPos, text: newText };
                }
            }, delay); 
        });

        const triggerCursorSync = () => {
            if (state.isEditingNote && state.activeAnnotationId) {
                // 主动抛出一个轻量级的 input 事件，触发上面的防抖渲染和位置计算
                els.noteInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        };
        // 监听方向键移动
        els.noteInput.addEventListener('keyup', (e) => {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) triggerCursorSync();
        });
        // 监听鼠标点击改变光标位置
        els.noteInput.addEventListener('mouseup', triggerCursorSync);

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

        function moveNoteCursorFromPreview(div, annotationId, pageNum, clientX, clientY) {
            const anno = state.annotations[pageNum]?.find(item => item.id === annotationId);
            if (!anno || anno.type !== 'text') return;
            const source = textAnnotationSources.get(div) ?? (anno.text || '');
            let index = textAnnotationOffsetAtPoint(div, source, clientX, clientY);
            const isCurrent = !els.noteModal.classList.contains('hidden')
                && state.activeAnnotationId === annotationId && state.activePageNum === pageNum;

            if (!isCurrent) {
                if (!els.noteModal.classList.contains('hidden')) commitNoteEdit();
                els.modalTitle.textContent = '编辑文本块';
                openNoteModal({ ...anno, note: anno.text }, pageNum, clientX, clientY, true);
            } else if (!state.isEditingNote) {
                setNoteMode('edit');
            }

            // 刚打字就右键时，画面仍可能是前一版；只换算偏移，绝不覆盖输入或重置取消快照。
            const current = els.noteInput.value;
            if (source !== current) {
                let prefix = 0, suffix = 0;
                while (prefix < source.length && prefix < current.length && source[prefix] === current[prefix]) prefix++;
                while (suffix < source.length - prefix && suffix < current.length - prefix
                    && source[source.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix++;
                if (index >= source.length - suffix) index += current.length - source.length;
                else if (index > prefix) index = Math.min(index, current.length - suffix);
            }
            index = Math.max(0, Math.min(index, current.length));
            els.noteInput.focus({ preventScroll: true });
            els.noteInput.setSelectionRange(index, index);
            // setSelectionRange 不会自动滚动 textarea；镜像排版兼顾自动折行，只滚动输入框。
            if (els.noteInput.scrollHeight > els.noteInput.clientHeight) {
                const style = getComputedStyle(els.noteInput);
                const mirror = document.createElement('div');
                mirror.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;';
                for (const property of ['font', 'letterSpacing', 'wordSpacing', 'textIndent', 'tabSize', 'padding', 'direction']) {
                    mirror.style[property] = style[property];
                }
                mirror.style.width = els.noteInput.clientWidth + 'px';
                mirror.textContent = current.slice(0, index);
                const caret = document.createElement('span');
                caret.textContent = current.slice(index) || '\u200b';
                mirror.appendChild(caret);
                document.body.appendChild(mirror);
                const top = caret.offsetTop;
                const height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
                if (top < els.noteInput.scrollTop) els.noteInput.scrollTop = top;
                else if (top + height > els.noteInput.scrollTop + els.noteInput.clientHeight) {
                    els.noteInput.scrollTop = top + height - els.noteInput.clientHeight;
                }
                mirror.remove();
            }
            // 立即把画面上的光标挪到新位置，不等 30ms 防抖，避免红光标先停在旧文本块上。
            refreshActiveTextCursor();
            if (typeof window.syncVirtualCursor === 'function') window.syncVirtualCursor();
        }

        const copyNoteBtn = document.getElementById('copy-note-btn');
        if (copyNoteBtn) {
            copyNoteBtn.addEventListener('click', async () => {
                const textToCopy = els.noteInput.value;
                let success = false;
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(textToCopy);
                        success = true;
                    }
                } catch (e) {}
                if (!success) {
                    try {
                        const ta = document.createElement('textarea');
                        ta.value = textToCopy;
                        ta.style.position = 'fixed';
                        ta.style.opacity = '0';
                        document.body.appendChild(ta);
                        ta.focus();
                        ta.select();
                        success = document.execCommand('copy');
                        document.body.removeChild(ta);
                        els.noteInput.focus();
                    } catch (e) {}
                }
                const origText = copyNoteBtn.textContent;
                copyNoteBtn.textContent = '已复制';
                copyNoteBtn.classList.add('text-green-600');
                setTimeout(() => {
                    copyNoteBtn.textContent = origText;
                    copyNoteBtn.classList.remove('text-green-600');
                }, 1500);
            });
        }

        document.getElementById('select-all-btn').addEventListener('click', () => {
            els.noteInput.focus();  // 确保输入框获得焦点
            els.noteInput.select(); // 原生 API：瞬间全选输入框内的所有文字
        });

        document.getElementById('delete-note-btn').addEventListener('click', () => {
            if (!state.activeAnnotationId) return;
            clearTimeout(state.livePreviewTimer);
            setNoteMode('preview');
            state.originalAnnoSnapshot = null;
            const targetId = state.activeAnnotationId;
            state.activeAnnotationId = null;
            performAction(() => {
                if (state.annotations[state.activePageNum]) {
                    state.annotations[state.activePageNum] = state.annotations[state.activePageNum].filter(a => a.id !== targetId);
                }
            }, [state.activePageNum]);
            els.noteModal.classList.add('hidden');
        });
        document.getElementById('close-note-btn').addEventListener('click', () => {
            clearTimeout(state.livePreviewTimer);
            rollbackLivePreview();
            setNoteMode('preview');
            els.noteModal.classList.add('hidden');
            state.activeAnnotationId = null;
        });

        els.toggleSidebarBtn.addEventListener('click', () => {
            state.sidebarOpen = !state.sidebarOpen;
            const sb = els.sidebar;
            if (window.innerWidth >= 768) {
                if (state.sidebarOpen) { sb.classList.remove('w-0', 'px-0'); sb.classList.add('w-64'); }
                else { sb.classList.remove('w-64'); sb.classList.add('w-0', 'px-0'); }
            } else {
                if (state.sidebarOpen) { sb.classList.remove('-translate-x-full'); sb.classList.add('translate-x-0'); }
                else { sb.classList.add('-translate-x-full'); sb.classList.remove('translate-x-0'); }
            }
        });

        // ================= 侧边栏虚拟分页渲染引擎 =================
        let sidebarRenderState = { items: [], currentIndex: 0, chunkSize: 30, observer: null };

        const locateCurrentPageButton = document.getElementById('anno-locate-current-page');
        locateCurrentPageButton.addEventListener('keydown', (event) => {
            // 保留按钮的空格激活，避免触发阅读器的空格抓手/保存快捷键。
            if (event.code === 'Space') event.stopPropagation();
        });
        locateCurrentPageButton.addEventListener('click', () => {
            if (!state.pdfDoc || state.sidebarMode !== 'annotations') return;
            updateHUDAndOutline();
            const pageNum = state.currentPhysicalPage;
            const annotations = state.annotations[pageNum];
            if (!annotations?.length) return;

            const searchInput = document.getElementById('anno-search-input');
            const query = searchInput.value.trim().toLowerCase();
            // 当前页被筛选隐藏时，恢复完整列表后再定位。
            if (query && !annotations.some(anno =>
                (anno.text || '').toLowerCase().includes(query) ||
                (anno.note || '').toLowerCase().includes(query))) {
                searchInput.value = '';
            }
            // 防止尚未执行的输入防抖刷新把刚定位的列表重置。
            clearTimeout(sidebarDebounceTimer);
            updateSidebar(pageNum);
        });

        // 提取原有的 DOM 创建与点击动画逻辑
        function createSidebarAnnoDom(anno, pageNum, highlightMatch) {
            const div = document.createElement('div');
            div.className = 'sidebar-item p-3 mb-2 bg-white rounded shadow-sm cursor-pointer border border-gray-100 hover:border-blue-200 group';
            
            let icon = 'ph-highlighter';
            let titleText = anno.text;
            if (anno.type === 'text') { icon = 'ph-text-t'; titleText = anno.text || '[空文本]'; }
            if (anno.type === 'underline') icon = 'ph-text-u';
            if (anno.type === 'arrow') icon = 'ph-arrow-up-right';
            if (anno.type === 'implies') icon = 'ph-arrow-up-right';
            if (anno.type === 'equivalence') icon = 'ph-arrows-left-right';
            if (anno.type === 'parenthesis') icon = 'ph-brackets-round';
            if (anno.type === 'brace') icon = 'ph-brackets-curly';
            if (anno.type === 'line') icon = 'ph-minus';
            if (anno.type === 'rect') icon = 'ph-rectangle';
            if (anno.type === 'highlight-block') icon = 'ph-highlighter'; 
            if (anno.type === 'free-parenthesis') icon = 'ph-brackets-round';
            
            const displayTitle = highlightMatch(titleText);
            const displayNote = highlightMatch(anno.note);
            
            const notePrev = (anno.note && anno.type !== 'text') 
                ? `<div class="mt-2 text-xs text-gray-600 bg-gray-50 p-1.5 rounded border border-gray-100 italic truncate"><i class="ph ph-note-pencil mr-1"></i>${displayNote}</div>` 
                : '';
            
            let iconHtml = `<i class="ph ${icon} mt-0.5 shrink-0 text-lg" style="color: ${anno.color || '#eab308'}"></i>`;
            
            if (MARKER_CONFIG[anno.type]) {
                const conf = MARKER_CONFIG[anno.type];
                const customColor = anno.color || conf.color;
                const dynamicFill = conf.fill === 'none' ? 'none' : customColor;
                const dynamicStroke = conf.stroke === 'none' ? 'none' : customColor;
                iconHtml = `<svg viewBox="${conf.viewBox}" class="mt-0.5 shrink-0 w-[18px] h-[18px]" fill="${dynamicFill}" stroke="${dynamicStroke}" stroke-width="${conf.strokeWidth}">${conf.inner}</svg>`;
            }
            
            div.innerHTML = `<div class="flex items-start gap-2">${iconHtml}<div class="overflow-hidden"><div class="text-sm text-gray-800 leading-snug font-medium truncate">"${displayTitle}"</div><div class="text-xs text-gray-400 mt-1">${anno.timestamp}</div></div></div>${notePrev}`;
            
            // 完美还原原来的点击跳转与凸显动画逻辑
            div.addEventListener('click', () => {
                const loadToken = state.loadToken;
                recordJumpPosition();
                const wrapper = scrollPdfPageIntoView(Number(pageNum), 'center');
                if (!wrapper) return;

                let isOutOfBounds = false;
                if (anno.x !== undefined && anno.x > 0.95) isOutOfBounds = true;
                else if (anno.start && anno.end && Math.max(anno.start.x, anno.end.x) > 0.95) isOutOfBounds = true;
                
                if (isOutOfBounds && typeof toggleSidecar === 'function') {
                    toggleSidecar(true, true); 
                }

                const doHighlight = (targetWrapper) => {
                    if (state.loadToken !== loadToken || !targetWrapper?.isConnected) return;
                    let hlX = 0, hlY = 0, hlW = 0, hlH = 0;
                    const w = parseFloat(targetWrapper.style.width) || targetWrapper.clientWidth;
                    const h = parseFloat(targetWrapper.style.height) || targetWrapper.clientHeight;

                    if (anno.type === 'text') {
                        const textNodes = targetWrapper.querySelectorAll('.text-annotation');
                        let foundNode = null;
                        for (let el of textNodes) {
                            if (Math.abs(parseFloat(el.style.left) - anno.x * w) < 2 && Math.abs(parseFloat(el.style.top) - anno.y * h) < 2) { foundNode = el; break; }
                        }
                        hlX = anno.x * w; hlY = anno.y * h;
                        if (foundNode) {
                            const rect = foundNode.getBoundingClientRect();
                            hlW = rect.width; hlH = rect.height;
                        }
                        else { hlW = anno.width ? anno.width * w : 100; hlH = anno.height ? anno.height * h : 30; }
                    } else if (MARKER_CONFIG[anno.type]) {
                        const actualSize = (anno.size || MARKER_CONFIG[anno.type].defaultSize || 8) * state.scale;
                        hlX = anno.x * w; hlY = anno.y * h; hlW = actualSize; hlH = actualSize;
                    } else if (anno.start && anno.end) {
                        const geometry = isArrowAnnotation(anno) ? arrowGeometry(anno, parseInt(pageNum), w, h) : null;
                        const x1 = geometry ? geometry.start.x : anno.start.x * w, y1 = geometry ? geometry.start.y : anno.start.y * h;
                        const x2 = geometry ? geometry.end.x : anno.end.x * w, y2 = geometry ? geometry.end.y : anno.end.y * h;
                        hlX = Math.min(x1, x2); hlY = Math.min(y1, y2);
                        hlW = Math.max(Math.abs(x1 - x2), 24); hlH = Math.max(Math.abs(y1 - y2), 24);
                        
                        // 补偿多段工具在 DOM 骨架中的视觉尺寸
                        if (anno.type === 'highlight-block') {
                            const th = anno.thickness * w;
                            hlX -= th / 2; hlY -= th / 2;
                            hlW += th; hlH += th;
                        } else if (anno.type === 'free-parenthesis') {
                            // 估算跨行括号的空间包围盒
                            const th = anno.thickness * h;
                            hlW = Math.max(hlW, Math.abs(anno.localX * w)) + 24;
                            hlH = Math.max(hlH, Math.abs(anno.lineOffset * th) + th) + 24;
                        }
                    } else if (anno.rects && anno.rects.length > 0) {
                        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                        anno.rects.forEach(r => { minX = Math.min(minX, r.x * w); minY = Math.min(minY, r.y * h); maxX = Math.max(maxX, (r.x + r.w) * w); maxY = Math.max(maxY, (r.y + r.h) * h); });
                        hlX = minX; hlY = minY; hlW = maxX - minX; hlH = maxY - minY;
                    }

                    const hlBox = document.createElement('div');
                    hlBox.style.position = 'absolute';
                    const padding = 12; 
                    const pctX = (hlX / w) * 100; const pctY = (hlY / h) * 100;
                    const pctW = (hlW / w) * 100; const pctH = (hlH / h) * 100;

                    hlBox.style.left = `calc(${pctX}% - ${padding}px)`;
                    hlBox.style.top = `calc(${pctY}% - ${padding}px)`;
                    hlBox.style.width = `calc(${pctW}% + ${padding * 2}px)`;
                    hlBox.style.height = `calc(${pctH}% + ${padding * 2}px)`;
                    
                    hlBox.style.borderRadius = '8px';
                    hlBox.style.pointerEvents = 'none'; 
                    hlBox.style.zIndex = '99999';       

                    targetWrapper.appendChild(hlBox);

                    hlBox.animate([
                        { boxShadow: '0 0 0 1px rgba(59, 130, 246, 1), 0 0 15px rgba(59, 130, 246, 0.6)', backgroundColor: 'rgba(59, 130, 246, 0.2)', opacity: 1 },
                        { boxShadow: '0 0 0 8px rgba(59, 130, 246, 0), 0 0 25px rgba(59, 130, 246, 0)', backgroundColor: 'rgba(59, 130, 246, 0)', opacity: 0 },
                        { boxShadow: '0 0 0 1px rgba(59, 130, 246, 1), 0 0 15px rgba(59, 130, 246, 0.6)', backgroundColor: 'rgba(59, 130, 246, 0.2)', opacity: 1 },
                        { boxShadow: '0 0 0 8px rgba(59, 130, 246, 0), 0 0 25px rgba(59, 130, 246, 0)', backgroundColor: 'rgba(59, 130, 246, 0)', opacity: 0 }
                    ], { duration: 2500, easing: 'ease-out', fill: 'forwards' }).onfinish = () => hlBox.remove(); 
                };

                setTimeout(() => doHighlight(wrapper), 350);
            });

            return div;
        }

        function escapeHtmlText(str) {
            return String(str ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        // 全新的 updateSidebar 函数：采用虚拟列表技术
        function updateSidebar(scrollToPage = null) {
            const list = els.sidebarList;
            
            // 1. 清理并断开旧的哨兵侦听器
            if (sidebarRenderState.observer) {
                sidebarRenderState.observer.disconnect();
                sidebarRenderState.observer = null;
            }

            const searchInput = document.getElementById('anno-search-input');
            const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

            const highlightMatch = (text) => {
                if (!text) return '';
                const raw = String(text);
                if (!query) return escapeHtmlText(raw);
                const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                let result = '';
                let lastIndex = 0;
                let m;
                while ((m = regex.exec(raw)) !== null) {
                    result += escapeHtmlText(raw.slice(lastIndex, m.index));
                    result += `<mark class="bg-yellow-200 text-yellow-900 rounded-sm px-0.5">${escapeHtmlText(m[0])}</mark>`;
                    lastIndex = regex.lastIndex;
                }
                result += escapeHtmlText(raw.slice(lastIndex));
                return result;
            };

            const sortedPages = Object.keys(state.annotations)
                .filter(k => k !== 'snippets' && k !== 'settings' && k !== 'mindmap')
                .sort((a,b) => parseInt(a) - parseInt(b));
            
            let total = 0;
            sidebarRenderState.items = []; // 抹平存储所有需要渲染的项

            // 2. 极速扁平化数据抽取（0 DOM操作，毫秒级）
            sortedPages.forEach(pageNum => {
                const annos = state.annotations[pageNum].filter(anno => {
                    if (!query) return true;
                    const textMatch = (anno.text || '').toLowerCase().includes(query);
                    const noteMatch = (anno.note || '').toLowerCase().includes(query);
                    return textMatch || noteMatch;
                });

                if (annos.length > 0) {
                    sidebarRenderState.items.push({ type: 'header', pageNum });
                    annos.forEach(anno => {
                        total++;
                        sidebarRenderState.items.push({ type: 'anno', pageNum, anno });
                    });
                }
            });

            els.annoCount.textContent = total;
            list.innerHTML = '';
            sidebarRenderState.currentIndex = 0;

            if (sidebarRenderState.items.length === 0) {
                list.innerHTML = `<div class="text-center text-gray-400 text-sm mt-10 p-4"><i class="ph ph-${query ? 'magnifying-glass' : 'highlighter'} text-3xl mb-2 opacity-30"></i><p>${query ? '未找到相关批注' : '暂无批注'}</p></div>`;
                return;
            }

            // 3. 切片分发渲染逻辑 (每滚动一次，只渲染 30 个)
            const renderChunk = (chunkSize = sidebarRenderState.chunkSize) => {
                const fragment = document.createDocumentFragment();
                const end = Math.min(sidebarRenderState.currentIndex + chunkSize, sidebarRenderState.items.length);
                
                for (let i = sidebarRenderState.currentIndex; i < end; i++) {
                    const itemData = sidebarRenderState.items[i];
                    
                    if (itemData.type === 'header') {
                        const pageHeader = document.createElement('div');
                        pageHeader.className = 'flex justify-between items-center mt-4 mb-2 px-2';
                        pageHeader.dataset.pageNum = itemData.pageNum;
                        pageHeader.innerHTML = `
                            <span class="text-xs font-bold text-gray-400 uppercase">第 ${itemData.pageNum} 页</span>
                            <button class="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-red-50" title="清除本页所有批注" onclick="clearPageAnnotations(${itemData.pageNum})">
                                <i class="ph ph-trash"></i>
                            </button>
                        `;
                        fragment.appendChild(pageHeader);
                    } else {
                        const annoDom = createSidebarAnnoDom(itemData.anno, itemData.pageNum, highlightMatch);
                        fragment.appendChild(annoDom);
                    }
                }
                
                list.appendChild(fragment);
                sidebarRenderState.currentIndex = end;

                // 4. 部署动态加载哨兵 (当哨兵出现在视野时，触发下一批渲染)
                if (sidebarRenderState.currentIndex < sidebarRenderState.items.length) {
                    const sentinel = document.createElement('div');
                    sentinel.className = "h-4 w-full opacity-0"; // 隐形触发器
                    list.appendChild(sentinel);
                    
                    if (!sidebarRenderState.observer) {
                        sidebarRenderState.observer = new IntersectionObserver((entries, observer) => {
                            for (const entry of entries) {
                                if (!entry.isIntersecting || !entry.target.isConnected) continue;
                                observer.unobserve(entry.target);
                                entry.target.remove();
                                renderChunk(); // 触发加载下一页
                            }
                        }, { root: list, rootMargin: '200px' }); // 提前 200px 加载，用户完全无感
                    }
                    sidebarRenderState.observer.observe(sentinel);
                }
            };

            // 定位时补齐目标页及其后的一批列表项，普通刷新仍只渲染首批。
            const targetIndex = scrollToPage === null ? -1 : sidebarRenderState.items.findIndex(
                item => item.type === 'header' && Number(item.pageNum) === scrollToPage
            );
            renderChunk(Math.max(0, targetIndex) + sidebarRenderState.chunkSize);
            if (targetIndex !== -1) {
                const pageHeader = list.querySelector(`[data-page-num="${scrollToPage}"]`);
                // 只滚动批注列表，保持正文阅读位置不变。
                list.scrollTo({ top: pageHeader.offsetTop - 8, behavior: 'smooth' });
            }
        }

