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
            state.activeAnnotationId = anno.id;
            state.activePageNum = pageNum;
            
            state.originalAnnoSnapshot = JSON.parse(JSON.stringify(anno));

            els.noteInput.value = anno.note || ''; 
            els.noteModal.classList.remove('hidden');
            
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

            if (anno.note && !forceEditMode) {
                setNoteMode('preview');
                renderNotePreview(anno.note, anno, pageNum);
            } else {
                setNoteMode('edit');
                setTimeout(() => els.noteInput.focus(), 50);
            }
        }

        function setNoteMode(mode) {
            const selectAllBtn = document.getElementById('select-all-btn'); 
            
            if (mode === 'edit') {
                els.noteInput.classList.remove('hidden'); els.notePreview.classList.add('hidden');
                els.toggleEditBtn.textContent = '取消'; els.saveNoteBtn.textContent = '保存';
                if (selectAllBtn) selectAllBtn.classList.remove('hidden'); 
                state.isEditingNote = true;
                
                if (typeof window.syncVirtualCursor === 'function') {
                    if (cursorSyncFrameId) cancelAnimationFrame(cursorSyncFrameId);
                    requestAnimationFrame(window.syncVirtualCursor);
                }
                
                if (state.activeAnnotationId) {
                    setTimeout(() => els.noteInput.dispatchEvent(new Event('input', { bubbles: true })), 20);
                }
                
            } else {
                els.noteInput.classList.add('hidden'); els.notePreview.classList.remove('hidden');
                els.toggleEditBtn.textContent = '编辑'; els.saveNoteBtn.textContent = '确定';
                if (selectAllBtn) selectAllBtn.classList.add('hidden');    
                state.isEditingNote = false;
                // 雷达会在下一帧检测到 isEditingNote 为 false 并自动销毁
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
                const anno = state.annotations[state.activePageNum].find(a => a.id === state.activeAnnotationId);
                let content = anno.note;
                if (anno.type === 'text') content = anno.text;
                
                els.noteInput.value = content || '';
                setNoteMode('preview'); renderNotePreview(content, anno, state.activePageNum);
            } else { setNoteMode('edit'); els.noteInput.focus(); }
        });

        els.saveNoteBtn.addEventListener('click', () => {
            if (!state.activeAnnotationId) return;
            if (state.isEditingNote) {
                let currentAnno = null;
                performAction(() => {
                    const anno = state.annotations[state.activePageNum].find(a => a.id === state.activeAnnotationId);
                    if (anno) {
                        currentAnno = anno;
                        const newText = els.noteInput.value;
                        if (anno.type === 'text') {
                            
                            if (!state.originalAnnoSnapshot || state.originalAnnoSnapshot.text !== newText) {
                                anno.text = newText;
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
                });
                
                state.originalAnnoSnapshot = null; // 保存成功后清空快照
                
                setNoteMode('preview'); 
                renderNotePreview(els.noteInput.value, currentAnno, state.activePageNum);
            } else {
                els.noteModal.classList.add('hidden');
                state.activeAnnotationId = null;
            }
        });

        class QuantumSnippetEngine {
            constructor(textarea, snippets) {
                this.textarea = textarea;
                this.snippets = snippets.map(snip => ({ ...snip }));
                this.activeTabStops = [];
                this.currentTabStopIndex = -1;
                this.lastValLength = textarea.value.length;
                
                // 动态替换模板变量
                this.GREEK = "alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|vartheta|Theta|iota|kappa|lambda|Lambda|mu|nu|xi|Xi|pi|Pi|rho|varrho|sigma|Sigma|tau|upsilon|Upsilon|phi|varphi|Phi|chi|psi|Psi|omega|Omega";
                this.SYMBOL = "infty|sum|prod|lim|pm|mp|nabla|times|cdot|propto|equiv|neq|geq|leq|gg|ll|sim|simeq|leftrightarrow|longleftrightarrow|to|mapsto|implies|impliedby|cap|cup|in|notin|setminus|subseteq|supseteq|emptyset|exists";
                
                this.initSnippets();
                this.bindEvents();
            }

            initSnippets() {
                this.snippets.forEach(snip => {
                    // 确保只处理字符串类型的 trigger，防止重复初始化报错
                    if (snip.options.includes('r') && typeof snip.trigger === 'string') {
                        let tStr = snip.trigger
                            .replace(/\$\{GREEK\}/g, this.GREEK)
                            .replace(/\$\{SYMBOL\}/g, this.SYMBOL)
                            .replace(/\$\{VISUAL\}/g, "");
                        snip.trigger = new RegExp(tStr);
                    }
                });
            }


            // 极简智能上下文嗅探：判断光标前是否在数学模式 (如 $$ 或 \begin{})
            isMathMode(textBefore) {
                const clean = textBefore.replace(/\\\$/g, '');
                const displayMathCount = (clean.match(/\$\$/g) || []).length;
                if (displayMathCount % 2 === 1) return true;
                const inlineMathCount = (clean.replace(/\$\$/g, '').match(/\$/g) || []).length;
                if (inlineMathCount % 2 === 1) return true;
                const begins = (clean.match(/\\begin\{[^}]+\}/g) || []).length;
                const ends = (clean.match(/\\end\{[^}]+\}/g) || []).length;
                if (begins > ends) return true;
                return false;
            }

            bindEvents() {
                // 拦截 Tab 键，执行多级穿梭跃迁
                this.textarea.addEventListener('keydown', (e) => {
                    if (e.key === 'Tab' && this.activeTabStops.length > 0) {
                        e.preventDefault();
                        this.currentTabStopIndex++;
                        if (this.currentTabStopIndex >= this.activeTabStops.length) {
                            this.activeTabStops = [];
                            this.currentTabStopIndex = -1;
                        } else {
                            const ts = this.activeTabStops[this.currentTabStopIndex];
                            this.textarea.setSelectionRange(ts.start, ts.end);
                        }
                    } else if (e.key === 'Escape' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        this.activeTabStops = [];
                    }
                });

                // 核心拦截层
                this.textarea.addEventListener('input', (e) => {
                    const currentVal = this.textarea.value;
                    const delta = currentVal.length - this.lastValLength;
                    this.lastValLength = currentVal.length;

                    // 纯数学增量追踪 (Delta Tracking)，无论输入多长，跳跃点依然绝对精准
                    if (this.activeTabStops.length > 0 && delta !== 0) {
                        for (let i = this.currentTabStopIndex + 1; i < this.activeTabStops.length; i++) {
                            this.activeTabStops[i].start += delta;
                            this.activeTabStops[i].end += delta;
                        }
                    }

                    // 仅当用户手动输入字符时触发解析
                    if (e.inputType !== 'insertText' && e.inputType !== 'insertCompositionText') return;

                    const cursorPos = this.textarea.selectionStart;
                    const textBefore = currentVal.slice(0, cursorPos);
                    const inMath = this.isMathMode(textBefore);

                    for (const snip of this.snippets) {
                        const reqMath = snip.options.includes('m');
                        const reqText = snip.options.includes('t');
                        if (reqMath && !inMath) continue;
                        if (reqText && inMath) continue;

                        const isRegex = snip.options.includes('r') || snip.trigger instanceof RegExp;
                        let matchResult = null;
                        let matchLength = 0;

                        if (isRegex) {
                            const regexStr = snip.trigger instanceof RegExp ? snip.trigger.source : snip.trigger;
                            const finalRegexStr = regexStr.endsWith('$') ? regexStr : regexStr + '$'; // 强制匹配光标末尾
                            const flags = snip.trigger instanceof RegExp ? snip.trigger.flags : '';
                            const regex = new RegExp(finalRegexStr, flags);
                            matchResult = textBefore.match(regex);
                            if (matchResult) matchLength = matchResult[0].length;
                        } else {
                            if (textBefore.endsWith(snip.trigger)) {
                                if (snip.options.includes('w')) { // 词边界检查
                                    const charBefore = textBefore.slice(0, -snip.trigger.length).slice(-1);
                                    if (charBefore && /\w/.test(charBefore)) continue;
                                }
                                matchResult = [snip.trigger];
                                matchLength = snip.trigger.length;
                            }
                        }

                        if (matchResult) {
                            this.executeSnippet(snip, matchResult, matchLength, cursorPos);
                            break; // 触发成功，中止检测
                        }
                    }
                });
                
                // 失去焦点时自动清理残存状态
                this.textarea.addEventListener('blur', () => {
                    this.activeTabStops = [];
                    this.currentTabStopIndex = -1;
                });
            }

            executeSnippet(snip, match, matchLength, cursorPos) {
                let replacement = snip.replacement;
                
                // 1. 处理函数映射 (如 iden 矩阵)
                if (typeof replacement === 'function') {
                    replacement = replacement(match);
                } 
                // 2. 处理正则组替换 (Obsidian 语法的 [[0]] 映射为 regex match[1])
                else if (snip.options.includes('r') || snip.trigger instanceof RegExp) {
                    replacement = replacement.replace(/\[\[(\d+)\]\]/g, (m, g1) => match[parseInt(g1) + 1] || '');
                }

                let tabStops = [];
                let finalStr = "";
                let currentIndex = 0;
                
                // 解析时空占位符：$0, $1, ${1:def}, ${VISUAL}
                const regex = /\$(\d+)|\$\{(\d+):([^}]+)\}|\$\{VISUAL\}/g;
                let m;

                while ((m = regex.exec(replacement)) !== null) {
                    finalStr += replacement.slice(currentIndex, m.index);
                    
                    let id = 0, defVal = "";
                    if (m[0] === '${VISUAL}') {
                        id = 1; // Obsidian 中 VISUAL 通常等同于 $1
                    } else {
                        const isBrace = m[2] !== undefined;
                        id = parseInt(isBrace ? m[2] : m[1]);
                        defVal = isBrace ? m[3] : '';
                    }

                    tabStops.push({
                        id: id,
                        start: finalStr.length,
                        end: finalStr.length + defVal.length,
                        defVal: defVal
                    });

                    finalStr += defVal;
                    currentIndex = regex.lastIndex;
                }
                finalStr += replacement.slice(currentIndex);

                // 1. 去重：如果同名占位符出现多次（如 tayl 里的多个 $0），只保留第一个输入点
                const uniqueTabStops = [];
                const seenIds = new Set();
                tabStops.forEach(ts => {
                    if (!seenIds.has(ts.id)) {
                        seenIds.add(ts.id);
                        uniqueTabStops.push(ts);
                    }
                });

                // 2. 排序：适配 Obsidian LaTeX Suite 逻辑，严格按 0, 1, 2, 3 数字顺序跳转
                uniqueTabStops.sort((a, b) => a.id - b.id);
                tabStops = uniqueTabStops;

                const startPos = cursorPos - matchLength;
                
                this.textarea.setSelectionRange(startPos, cursorPos);
                
                // 🌟 欺骗浏览器原生系统：模拟人类粘贴/打字，完美推入 Ctrl+Z 撤销栈
                // 如果在极个别奇葩环境下 execCommand 失败，则优雅降级回 setRangeText
                if (!document.execCommand('insertText', false, finalStr)) {
                    this.textarea.setRangeText(finalStr, startPos, cursorPos, 'end');
                }
                
                // 更新增量追踪器
                this.lastValLength = this.textarea.value.length;

                // 偏移计算与光标挂载
                tabStops.forEach(ts => {
                    ts.start += startPos;
                    ts.end += startPos;
                });

                if (tabStops.length > 0) {
                    this.activeTabStops = tabStops;
                    this.currentTabStopIndex = 0;
                    const ts = this.activeTabStops[0];
                    this.textarea.setSelectionRange(ts.start, ts.end);
                }
                
                // 优雅接驳原项目：抛出一个无害的 input 事件，触发原生的实时预览引擎 (Live Preview)
                this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        
        // 【挂载启动引擎】
        new QuantumSnippetEngine(els.noteInput, LATEX_SNIPPETS);

        
        // 1. 上下文嗅探与幻影注入
        function injectPhantomCursor(text, cursorIndex) {
            if (typeof text !== 'string') return '';
            if (text.length === 0) return '<span id="phantom-cursor" style="display:inline-block;width:0;height:1em;vertical-align:middle;"></span>';

            const escapeHTML = (str) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

            const envs = LATEX_CONFIG.environments.join('|');
            const tikzRegex = new RegExp("\\\\begin\\{(" + envs + ")\\}[\\s\\S]*?\\\\end\\{\\1\\}", 'g');
            const mathRegex = /(\$\$[\s\S]*?\$\$|\$[\s\S]*?\$)/g;

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
                
                const isBlockMath = rawInside.startsWith('$$') && rawInside.endsWith('$$');
                if (isBlockMath) {
                    return `${before}<div id="phantom-cursor-block" style="display:block; text-align:center; width:100%; transition: all 0.2s;">${inside}</div>${after}`;
                } else {
                    return `${before}<span id="phantom-cursor-block" style="display:inline-block; transition: all 0.2s;">${inside}</span>${after}`;
                }
            } else {
                const before = escapeHTML(text.substring(0, cursorIndex));
                const after = escapeHTML(text.substring(cursorIndex));
                return `${before}<span id="phantom-cursor" style="display:inline-block;width:0px;height:1em;vertical-align:middle;">&#8203;</span>${after}`;
            }
        }

        // 2. 物理坐标侦测与高频雷达追踪 (rAF Loop)
        let cursorSyncFrameId = null;

        window.syncVirtualCursor = function() {
            // 1. 如果退出了编辑模式，彻底清理光标并终止雷达
            if (!state.isEditingNote) {
                const vCursor = document.getElementById('virtual-cursor');
                if (vCursor) vCursor.style.display = 'none';
                if (cursorSyncFrameId) cancelAnimationFrame(cursorSyncFrameId);
                cursorSyncFrameId = null;
                return;
            }

            // 2. 🚀 只要还在编辑状态，雷达绝对不能停！立刻挂载下一帧扫描！
            cursorSyncFrameId = requestAnimationFrame(window.syncVirtualCursor);

            // 3. 寻找 DOM 里的幻影节点
            const phantom = document.getElementById('phantom-cursor') || document.getElementById('phantom-cursor-block');
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
            const phantomRect = phantom.getBoundingClientRect();

            if (phantom.id === 'phantom-cursor') {
                // 纯文本光标形态 (闪烁的竖线)
                vCursor.style.left = `${phantomRect.left}px`;
                vCursor.style.top = `${phantomRect.top}px`;
                vCursor.style.width = '2px';
                vCursor.style.height = `${Math.max(phantomRect.height, 14)}px`;
                vCursor.style.backgroundColor = 'rgba(239, 68, 68, 0.7)';
                vCursor.style.border = 'none';
                vCursor.style.boxShadow = '0 0 4px rgba(239, 68, 68, 0.5)';
                if (!vCursor.classList.contains('animate-pulse')) vCursor.classList.add('animate-pulse');
            } else {
                // 公式/图形遮罩形态 (半透明红框包裹)
                vCursor.style.left = `${phantomRect.left - 2}px`;
                vCursor.style.top = `${phantomRect.top - 2}px`;
                vCursor.style.width = `${phantomRect.width + 4}px`;
                vCursor.style.height = `${phantomRect.height + 4}px`;
                vCursor.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
                vCursor.style.border = '1.5px dashed rgba(239, 68, 68, 0.6)';
                vCursor.style.boxShadow = 'none';
                vCursor.classList.remove('animate-pulse');
            }
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
            state.livePreviewTimer = setTimeout(() => {
                if (anno.text !== newText) {
                    anno.text = newText;
                    anno.tikzBase64 = null;
                    anno.imgH = null;
                }

                // 2. 极速查询该文本块所在的真实 DOM 节点
                const container = document.getElementById(`annotation-layer-${state.activePageNum}`);
                if (!container) return;
                const textDiv = container.querySelector(`.text-annotation[data-id="${state.activeAnnotationId}"]`);
                
                if (textDiv) {
                    const cursorPos = els.noteInput.selectionStart;
                    const injectedHTML = injectPhantomCursor(newText, cursorPos);
                    
                    textDiv.innerHTML = injectedHTML || '点击编辑';
                    
                    // 3. 调用原生的渲染引擎重新生成
                    renderLatex(textDiv, anno, state.activePageNum);
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

        document.getElementById('select-all-btn').addEventListener('click', () => {
            els.noteInput.focus();  // 确保输入框获得焦点
            els.noteInput.select(); // 原生 API：瞬间全选输入框内的所有文字
        });

        document.getElementById('delete-note-btn').addEventListener('click', () => {
            if (!state.activeAnnotationId) return;
            performAction(() => {
                state.annotations[state.activePageNum] = state.annotations[state.activePageNum].filter(a => a.id !== state.activeAnnotationId);
            });
            els.noteModal.classList.add('hidden');
        });
        document.getElementById('close-note-btn').addEventListener('click', () => {
            rollbackLivePreview();
            els.noteModal.classList.add('hidden');
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
                const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
                recordJumpPosition();

                let isOutOfBounds = false;
                if (anno.x !== undefined && anno.x > 0.95) isOutOfBounds = true;
                else if (anno.start && anno.end && Math.max(anno.start.x, anno.end.x) > 0.95) isOutOfBounds = true;
                
                if (isOutOfBounds && typeof toggleSidecar === 'function') {
                    toggleSidecar(true, true); 
                }

                const doHighlight = (targetWrapper) => {
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
                        if (foundNode) { hlW = foundNode.offsetWidth; hlH = foundNode.offsetHeight; } 
                        else { hlW = anno.width ? anno.width * w : 100; hlH = anno.height ? anno.height * h : 30; }
                    } else if (MARKER_CONFIG[anno.type]) {
                        const actualSize = (anno.size || MARKER_CONFIG[anno.type].defaultSize || 8) * state.scale;
                        hlX = anno.x * w; hlY = anno.y * h; hlW = actualSize; hlH = actualSize;
                    } else if (anno.start && anno.end) {
                        const x1 = anno.start.x * w, y1 = anno.start.y * h;
                        const x2 = anno.end.x * w, y2 = anno.end.y * h;
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

                if (wrapper) {
                    wrapper.scrollIntoView({ behavior: 'auto', block: 'center' });
                    setTimeout(() => doHighlight(wrapper), 350);
                } else {
                    renderPageHighQuality(parseInt(pageNum)).then(() => {
                        const newWrapper = document.getElementById(`page-wrapper-${pageNum}`);
                        newWrapper.scrollIntoView({ behavior: 'auto', block: 'center' });
                        setTimeout(() => doHighlight(newWrapper), 350);
                    });
                }
            });

            return div;
        }

        // 全新的 updateSidebar 函数：采用虚拟列表技术
        function updateSidebar() {
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
                if (!query) return text;
                const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                return text.replace(regex, '<mark class="bg-yellow-200 text-yellow-900 rounded-sm px-0.5">$1</mark>');
            };

            const sortedPages = Object.keys(state.annotations)
                .filter(k => k !== 'snippets' && k !== 'settings')
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
            const renderChunk = () => {
                const fragment = document.createDocumentFragment();
                const end = Math.min(sidebarRenderState.currentIndex + sidebarRenderState.chunkSize, sidebarRenderState.items.length);
                
                for (let i = sidebarRenderState.currentIndex; i < end; i++) {
                    const itemData = sidebarRenderState.items[i];
                    
                    if (itemData.type === 'header') {
                        const pageHeader = document.createElement('div');
                        pageHeader.className = 'flex justify-between items-center mt-4 mb-2 px-2';
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
                        sidebarRenderState.observer = new IntersectionObserver((entries) => {
                            if (entries[0].isIntersecting) {
                                sentinel.remove(); 
                                renderChunk(); // 触发加载下一页
                            }
                        }, { root: list, rootMargin: '200px' }); // 提前 200px 加载，用户完全无感
                    }
                    sidebarRenderState.observer.observe(sentinel);
                }
            };

            // 首次启动渲染（只生成首屏的几十个DOM）
            renderChunk();
        }

