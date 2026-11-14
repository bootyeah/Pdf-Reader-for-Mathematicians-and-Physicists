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
                    delete liveAnno.tikzBase64;
                    delete liveAnno.tikzSource;
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
                            delete anno.tikzBase64;
                            delete anno.tikzSource;
                            anno.imgH = null;
                        }

                    } else {
                        if (anno.note !== newText) {
                            anno.note = newText;
                            delete anno.tikzBase64;
                            delete anno.tikzSource;
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

                if (typeof scheduleVirtualCursorSync === 'function') scheduleVirtualCursorSync();
                else if (typeof window.syncVirtualCursor === 'function') window.syncVirtualCursor();
                
            } else {
                els.noteInput.classList.add('hidden'); els.notePreview.classList.remove('hidden');
                els.toggleEditBtn.textContent = '编辑'; els.saveNoteBtn.textContent = '确定';
                if (copyBtn) copyBtn.classList.add('hidden');
                if (selectAllBtn) selectAllBtn.classList.add('hidden');    
                state.isEditingNote = false;
                // 退出编辑：幻影节点插在正文中间，直接删会把公式内容一起带走，必须按源码整块重建
                endCursorTracking();
                if (typeof window.syncVirtualCursor === 'function') window.syncVirtualCursor();
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

        // 速录引擎定义已拆至 static/js/quantum-snippet-engine.js

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
        function paintVirtualCursor(cursor, rect, isText, origin = { left: 0, top: 0 }, minHeight = 14) {
            cursor.style.left = `${rect.left - origin.left - (isText ? 0 : 2)}px`;
            cursor.style.top = `${rect.top - origin.top - (isText ? 0 : 2)}px`;
            cursor.style.width = isText ? '2px' : `${rect.width + 4}px`;
            cursor.style.height = `${isText ? Math.max(rect.height, minHeight) : rect.height + 4}px`;
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
            let vCursor = document.getElementById('virtual-cursor');
            let vInnerCursor = document.getElementById('virtual-inner-cursor');
            // 1. 如果退出了编辑模式，彻底清理光标并终止调度
            if (!state.isEditingNote) {
                if (vCursor) vCursor.style.display = 'none';
                if (vInnerCursor) vInnerCursor.style.display = 'none';
                return;
            }

            if (phantomMemo.text === els.noteInput.value) {
                refreshActiveTextCursor();
            }

            // 2. 只取「当前正在编辑的文本块」里的幻影节点，其它块的一律不算数
            const phantom = phantomCursorIn(phantomMemo.div);

            // 3. 如果因为防抖延迟暂时没找到节点，先隐藏光标，等待渲染完成再同步
            if (!phantom) {
                if (vCursor) vCursor.style.display = 'none';
                if (vInnerCursor) vInnerCursor.style.display = 'none';
                return;
            }

            // 4. 找到了节点，开始绘制物理光标
            if (!vCursor) {
                vCursor = document.createElement('div');
                vCursor.id = 'virtual-cursor';
                vCursor.className = 'fixed pointer-events-none z-[100]';
                document.body.appendChild(vCursor);
            }

            const isBlock = phantom.id === 'phantom-cursor-block';
            vCursor.style.display = 'block';
            paintVirtualCursor(vCursor, phantom.getBoundingClientRect(), !isBlock);

            if (!isBlock) {
                if (vInnerCursor) vInnerCursor.style.display = 'none';
                return;
            }
            if (phantomMemo.text === els.noteInput.value && typeof window.formulaCursorRect === 'function') {
                const innerRect = window.formulaCursorRect(phantom, els.noteInput.value, els.noteInput.selectionStart ?? 0);
                if (innerRect) {
                    if (!vInnerCursor) {
                        vInnerCursor = document.createElement('div');
                        vInnerCursor.id = 'virtual-inner-cursor';
                        vInnerCursor.className = 'fixed pointer-events-none z-[100]';
                        document.body.appendChild(vInnerCursor);
                    }
                    vInnerCursor.style.display = 'block';
                    paintVirtualCursor(vInnerCursor, innerRect, true, { left: 0, top: 0 }, 6);
                } else if (vInnerCursor) {
                    vInnerCursor.style.display = 'none';
                }
            }
        };

        function scheduleVirtualCursorSync() {
            if (!state.isEditingNote) {
                if (typeof window.syncVirtualCursor === 'function') window.syncVirtualCursor();
                return;
            }
            if (cursorSyncFrameId) return;
            cursorSyncFrameId = requestAnimationFrame(window.syncVirtualCursor);
        }

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
                    delete anno.tikzBase64;
                    delete anno.tikzSource;
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
                    scheduleVirtualCursorSync();
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
        // 事件驱动同步物理光标位置，替代空转 rAF 轮询
        ['keyup', 'mouseup', 'click', 'scroll', 'select', 'focus', 'input'].forEach(ev => {
            els.noteInput.addEventListener(ev, scheduleVirtualCursorSync);
        });
        els.container?.addEventListener('scroll', scheduleVirtualCursorSync, { passive: true });
        window.addEventListener('resize', scheduleVirtualCursorSync);
        document.addEventListener('selectionchange', () => {
            if (state.isEditingNote && document.activeElement === els.noteInput) scheduleVirtualCursorSync();
        });

        // KaTeX 反向光标映射已拆至 static/js/katex-cursor-mapper.js（window.textAnnotationOffsetAtPoint）

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
            
            const fallbackLabels = {
                text: '[空文本]',
                rect: '[区域批注]',
                pen: '[画笔批注]',
                ink: '[画笔批注]',
                highlight: '[高亮批注]',
                'highlight-block': '[高亮批注]',
                underline: '[下划线批注]',
                arrow: '[箭头批注]',
                implies: '[推导符号]',
                equivalence: '[等价符号]',
                brace: '[花括号批注]',
                parenthesis: '[括号批注]',
                'free-parenthesis': '[自由括号]',
                line: '[线段批注]'
            };
            const hasRawText = typeof titleText === 'string' && titleText.trim().length > 0;
            const titleHtml = hasRawText
                ? `"${highlightMatch(titleText)}"`
                : escapeHtmlText(fallbackLabels[anno.type] || '[批注]');
            const timestampHtml = anno.timestamp
                ? `<div class="text-xs text-gray-400 mt-1">${escapeHtmlText(anno.timestamp)}</div>`
                : '';
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
            
            div.innerHTML = `<div class="flex items-start gap-2">${iconHtml}<div class="overflow-hidden"><div class="text-sm text-gray-800 leading-snug font-medium truncate">${titleHtml}</div>${timestampHtml}</div></div>${notePrev}`;
            
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

