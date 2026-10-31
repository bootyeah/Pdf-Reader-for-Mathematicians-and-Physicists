        const annoSearchInput = document.getElementById('anno-search-input');
        if (annoSearchInput) {
            // 换成防抖函数，防止打字太快卡死
            annoSearchInput.addEventListener('input', debouncedUpdateSidebar); 
        }

        els.saveStatusBtn.addEventListener('click', performSave);

        const spaceSaveToggle = document.getElementById('space-save-toggle');
        spaceSaveToggle?.addEventListener('click', (e) => {
            const enabled = spaceSaveToggle.getAttribute('aria-pressed') !== 'true';
            spaceSaveToggle.setAttribute('aria-pressed', String(enabled));
            spaceSaveToggle.title = enabled
                ? '空格：保存（有未保存修改时）+ 抓手；点击关闭空格保存'
                : '空格：仅抓手；点击启用空格保存';
            if (e.detail > 0) spaceSaveToggle.blur();
        });
        spaceSaveToggle?.addEventListener('keydown', (e) => {
            // 保留按钮自身的空格激活，避免同时触发阅读器的抓手/保存。
            if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') e.stopPropagation();
        });

        const _readerShutdownChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('reader_shutdown_bus') : null;

        let _readerClosingToken = '';
        let _readerExitRequested = false;

        function _newShutdownToken() {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        }

        async function _requestServerShutdown(token) {
            const body = JSON.stringify({ token });
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 1000);
            try {
                const response = await fetch('/api/shutdown', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body, keepalive: true, signal: controller.signal
                });
                if (response.ok) return;
            } catch (_) {} finally { clearTimeout(timer); }
            try {
                navigator.sendBeacon?.('/api/shutdown', new Blob([body], { type: 'application/json' }));
            } catch (_) {}
        }

        function _broadcastShutdown(token) {
            const message = { action: 'APP_SHUTDOWN', token };
            try { _readerShutdownChannel?.postMessage(message); } catch (_) {}
            try { localStorage.setItem('reader_app_shutdown_trigger', JSON.stringify(message)); } catch (_) {}
            // Notify child pages before closing, so their local draft writes can finish.
            for (const child of window._readerChildWindows || []) {
                try { if (child && !child.closed) child.postMessage(message, location.origin); } catch (_) {}
            }
            try {
                if (window.opener && !window.opener.closed) window.opener.postMessage(message, location.origin);
            } catch (_) {}
        }

        function _markReaderClosing(token) {
            if (!/^[a-f0-9]{32}$/.test(token || '') || _readerClosingToken) return false;
            _readerClosingToken = token;
            // Native browser window titles include this exact marker plus the browser suffix.
            // Keep it until the backend's 2.8-second shutdown deadline has passed.
            document.title = 'PDF Reader Pro - Closing ' + token;
            if (els.closeAppBtn) {
                els.closeAppBtn.disabled = true;
                els.closeAppBtn.innerHTML = '<i class="ph ph-spinner text-[20px] animate-spin text-red-500"></i>';
            }
            return true;
        }

        function _closeCurrentReaderTab() {
            try { window.close(); } catch (_) {}
            setTimeout(() => {
                try { window.close(); } catch (_) {}
                if (!window.closed && document.body) {
                    document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#f9fafb;color:#6b7280;font-family:sans-serif;"><div style="font-size:18px;font-weight:600;margin-bottom:8px;">阅读器退出请求已发送</div><div style="font-size:13px;">浏览器未允许自动关闭此标签页，请按 Ctrl+W 关闭。</div></div>';
                    document.title = 'PDF 阅读器 - 已退出';
                }
            }, 4000);
        }

        async function _handleRemoteShutdown(token) {
            if (!_markReaderClosing(token)) return;
            try { await saveAnnotationsToStorage(); } catch (_) {}
            try { window.PhoneHandwriting?.stop?.(); } catch (_) {}
            _closeCurrentReaderTab();
        }

        if (_readerShutdownChannel) {
            _readerShutdownChannel.onmessage = e => {
                if (e.data?.action === 'APP_SHUTDOWN') _handleRemoteShutdown(e.data.token);
            };
        }
        window.addEventListener('storage', e => {
            if (e.key !== 'reader_app_shutdown_trigger') return;
            try {
                const message = JSON.parse(e.newValue);
                if (message?.action === 'APP_SHUTDOWN') _handleRemoteShutdown(message.token);
            } catch (_) {}
        });
        window.addEventListener('message', e => {
            if (e.origin !== location.origin) return;
            if (e.data?.action === 'APP_SHUTDOWN' || e.data?.type === 'APP_SHUTDOWN') _handleRemoteShutdown(e.data.token);
        });

        async function closeAppAndServer() {
            if (_readerExitRequested || _readerClosingToken) return;
            if (state.isSaving) {
                alert('正在保存，请等保存完成后再关闭。');
                return;
            }
            if (state.unsavedChanges && !confirm('检测到当前有未保存的修改，是否确定关闭页面并退出后台引擎？')) return;
            _readerExitRequested = true;
            if (els.closeAppBtn) els.closeAppBtn.disabled = true;
            try { await saveAnnotationsToStorage(); } catch (_) {}
            if (typeof CloudSync !== 'undefined') {
                try {
                    await Promise.race([CloudSync.flushQueue(), new Promise(resolve => setTimeout(resolve, 8000))]);
                } catch (_) {}
            }
            if (state.isSaving) {
                _readerExitRequested = false;
                if (els.closeAppBtn) els.closeAppBtn.disabled = false;
                alert('正在保存，请等保存完成后再关闭。');
                return;
            }
            const token = _newShutdownToken();
            if (!_markReaderClosing(token)) return;
            _broadcastShutdown(token);
            await _requestServerShutdown(token);
            _closeCurrentReaderTab();
        }

        if (els.closeAppBtn) {
            els.closeAppBtn.addEventListener('click', e => {
                e.stopPropagation();
                closeAppAndServer();
            });
        }

        async function verifyPermission(fileHandle) {
            const options = { mode: 'readwrite' };
            // 1. 检查是否已经拥有权限 (如果之前允许过，直接返回 true)
            if ((await fileHandle.queryPermission(options)) === 'granted') {
                return true;
            }
            // 2. 如果没有权限，立刻趁着用户的“点击动作”还没过期，弹出系统授权框
            if ((await fileHandle.requestPermission(options)) === 'granted') {
                return true;
            }
            return false; // 用户点击了拒绝
        }

        // 🛡️ 保存重入闸门：大文件编码 + 写盘需要数秒，期间保存按钮 / Ctrl+S / 空格 都可能再次触发，
        //    两个保存并发会对同一份 PDF 做两次「截断 + 写入」，足以写坏你唯一的那份文件。
        async function performSave() {
            if (state.isSaving || !state.pdfDoc) return;
            state.isSaving = true;
            els.saveStatusBtn.disabled = true;
            try {
                const saveLoadToken = state.loadToken;
                await state.annotationsReady;
                if (state.loadToken !== saveLoadToken) return;
                if (state.isEditingNote) {
                    const anno = commitNoteEdit();
                    if (anno) renderNotePreview(els.noteInput.value, anno, state.activePageNum);
                }
                if (state.currentPhysicalPage > 0) {
                    state.annotations.settings ||= {};
                    state.annotations.settings.lastPage = state.currentPhysicalPage;
                }
                saveAnnotationsToStorage();
                const context = {
                    loadToken: saveLoadToken, rawFile: state.rawFile,
                    fileHandle: state.fileHandle, localPath: state.localFilePath,
                    fileName: state.fileName, fingerprint: state.fingerprint,
                    annotations: JSON.stringify(state.annotations)
                };
                if (typeof CloudSync !== 'undefined') CloudSync.upload();
                await performSaveInner(context);
            } finally {
                state.isSaving = false;
                els.saveStatusBtn.disabled = !state.pdfDoc;
            }
        }

        async function performSaveInner(context) {
            const isCurrent = () => state.loadToken === context.loadToken;
            if (!context.rawFile) return;
            if (typeof PDFLib === 'undefined') { alert("保存组件未加载"); return; }
            const { PDFDocument, PDFName, PDFHexString } = PDFLib; 
            
            // 此时用户的“点击”或“Ctrl+S”动作是绝对新鲜的，绝不会触发超时拦截。
            if (context.fileHandle) {
                try {
                    const hasPermission = await verifyPermission(context.fileHandle);
                    if (!isCurrent()) return;
                    if (!hasPermission) {
                        alert("保存已取消：需要允许浏览器修改该文件才能原位保存。");
                        return; // 没有权限，直接中止，避免白白消耗 CPU
                    }
                } catch (error) {
                    console.warn("权限请求被拒绝或发生错误:", error);
                    if (isCurrent()) alert('保存已取消：无法取得文件写入权限。');
                    return;
                }
            }
            
            const originalIconClass = els.saveIcon.className; 
            els.saveIcon.className = "ph ph-spinner animate-spin text-xl"; 

            try {
                // 1. 核心破解：加上 { ignoreEncryption: true }，无视 Springer 等防篡改锁！
                const data = await context.rawFile.arrayBuffer();
                if (!isCurrent()) return;
                const pdfDoc = await PDFDocument.load(data, { ignoreEncryption: true });
                if (!isCurrent()) return;
                // 为没有 /ID 的 PDF 补充标识，兼容外部阅读器；本阅读器始终
                // 按页面内容识别文档，避免不同 PDF 复用 /ID 时串批注。
                if (!pdfDoc.context.trailerInfo.ID && /^[a-f0-9]{32}$/i.test(context.fingerprint)) {
                    pdfDoc.context.trailerInfo.ID = pdfDoc.context.obj([
                        PDFHexString.of(context.fingerprint), PDFHexString.of(context.fingerprint)
                    ]);
                }
                const jsonString = context.annotations;
                
                // 2. 将 JSON 强制转为 Hex 十六进制，根除任何特殊符号引起的 PDF 解析崩溃
                const utf8Bytes = new TextEncoder().encode(jsonString);
                // 🚀 性能优化：使用固定长度数组替代字符串 += 拼接，提速10倍以上
                const hexArray = new Array(utf8Bytes.length);
                for (let i = 0; i < utf8Bytes.length; i++) {
                    hexArray[i] = utf8Bytes[i].toString(16).padStart(2, '0');
                }
                const hexStr = hexArray.join('');
                
                // 3. 极简挂载：写入最外围、最稳定的 Info 字典，绝不破坏 PDF 内部结构
                pdfDoc.getInfoDict().set(PDFName.of('ReaderProAnnos'), PDFHexString.of(hexStr));

                const pdfBytes = await pdfDoc.save();
                if (!isCurrent()) return;
                const blob = new Blob([pdfBytes], { type: 'application/pdf' });
                
                // 原位保存目标 = 当前窗口这份文档自己的磁盘路径（唯一真源，绝不跨文档复用）
                const localPath = context.localPath;

                async function writeHandle(handle) {
                    const writable = await handle.createWritable();
                    try {
                        await writable.write(blob);
                        await writable.close();
                    } catch (error) {
                        try { await writable.abort(); } catch (_) {}
                        throw error;
                    }
                }
                function saved(handle = context.fileHandle) {
                    if (!isCurrent()) return;
                    state.rawFile = new File([blob], context.fileName, { type: 'application/pdf' });
                    state.fileHandle = handle;
                    state.annotationBase = context.annotations;
                    // 编码/写盘期间仍允许编辑；只清除此次快照实际覆盖的修改。
                    updateSaveStatus(JSON.stringify(state.annotations) !== context.annotations);
                    saveAnnotationsToStorage();
                    updateDocMeta();
                }

                if (context.fileHandle) {
                    await writeHandle(context.fileHandle);
                    saved();
                } else if (localPath) {
                    // 🚀 后台引擎本地文件原位覆盖保存！
                    try {
                        const saveUrl = '/api/save-file?path=' + encodeURIComponent(localPath);
                        const saveResp = await fetch(saveUrl, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/octet-stream', 
                                'X-File-Path': encodeURIComponent(localPath) 
                            },
                            body: blob
                        });
                        const saveResult = await saveResp.json();
                        if (saveResp.ok && saveResult.ok) {
                            saved();
                        } else {
                            throw new Error(saveResult.error || "未知错误");
                        }
                    } catch (saveErr) {
                        console.error("原位保存失败:", saveErr);
                        if (isCurrent()) alert("原位保存失败：" + saveErr.message + "\n请确保通过 starter(H).bat 启动了本地服务。");
                    }
                } else {
                    if (window.showSaveFilePicker) {
                        try {
                            const handle = await window.showSaveFilePicker({ suggestedName: context.fileName, types: [{ description: 'PDF', accept: {'application/pdf': ['.pdf']} }] });
                            if (!isCurrent()) return;
                            await writeHandle(handle);
                            saved(handle);
                        } catch (e) { if (isCurrent() && e.name !== 'AbortError') download(blob); }
                    } else download(blob);
                }
                
                function download(b) { 
                    const l = document.createElement('a'); 
                    l.href = URL.createObjectURL(b); 
                    l.download = context.fileName; 
                    l.click(); 
                    setTimeout(() => URL.revokeObjectURL(l.href), 60000);
                    saved(null);
                }
            } catch (err) { 
                console.error(err); 
                if (isCurrent()) alert("保存失败: " + err.message); 
            } finally { 
                if (isCurrent()) {
                    els.saveIcon.className = originalIconClass;
                    updateSaveStatus(state.unsavedChanges);
                }
            }
        }

        let isDragging = false, startX, startY, initialLeft, initialTop;
        const dragHeader = document.getElementById('note-header');
        dragHeader.addEventListener('mousedown', (e) => { isDragging = true; startX = e.clientX; startY = e.clientY; const r = els.noteModal.getBoundingClientRect(); initialLeft = r.left; initialTop = r.top; dragHeader.style.cursor = 'grabbing'; });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const r = els.noteModal.getBoundingClientRect();
            const nextLeft = Math.max(8, Math.min(window.innerWidth - r.width - 8, initialLeft + e.clientX - startX));
            const nextTop = Math.max(8, Math.min(window.innerHeight - r.height - 8, initialTop + e.clientY - startY));
            els.noteModal.style.left = `${nextLeft}px`;
            els.noteModal.style.top = `${nextTop}px`;
        });
        const stopNoteHeaderDrag = () => { if (isDragging) { isDragging = false; dragHeader.style.cursor = 'move'; } };
        document.addEventListener('mouseup', stopNoteHeaderDrag);
        window.addEventListener('blur', stopNoteHeaderDrag);

        document.getElementById('font-minus-btn').addEventListener('click', (e) => { e.stopPropagation(); adjustFontSize(-0.2); });
        document.getElementById('font-plus-btn').addEventListener('click', (e) => { e.stopPropagation(); adjustFontSize(0.2); });

        function adjustFontSize(delta) {
            if (!state.activeAnnotationId) return;
            const anno = state.annotations[state.activePageNum]?.find(a => a.id === state.activeAnnotationId);
            
            if (anno) {
                if (anno.type === 'text') {
                    // 文本块调节倍率 (最少缩小到 0.4 倍)
                    if (state.isEditingNote) {
                        anno.fontSizeScale = Math.max(0.4, (anno.fontSizeScale || 1) + delta);
                        resetTextAnnotationSize(anno);
                        renderAnnotations(state.activePageNum);
                        updateSaveStatus(true);
                    } else {
                        performAction(() => {
                            anno.fontSizeScale = Math.max(0.4, (anno.fontSizeScale || 1) + delta);
                            resetTextAnnotationSize(anno);
                        }, [state.activePageNum]);
                    }
                } 
                else if (MARKER_CONFIG[anno.type]) {
                    const conf = MARKER_CONFIG[anno.type];
                    const minSize = conf.defaultSize; // 默认大小就是最小底线，防止缩太小不见了
                    
                    // 把传入的 0.2 倍率转化为像素 (点击一次放大或缩小 2 像素)
                    const sizeChange = delta > 0 ? 2 : -2;
                    
                    if (state.isEditingNote) {
                        anno.size = Math.max(minSize, (anno.size || minSize) + sizeChange);
                        renderAnnotations(state.activePageNum); // 立即重绘看效果
                        updateSaveStatus(true);
                    } else {
                        performAction(() => {
                            anno.size = Math.max(minSize, (anno.size || minSize) + sizeChange);
                        }, [state.activePageNum]);
                    }
                }
            }
        }


        // =========================================================================
        // =========================================================================
        let isSidecarOpen = false;
        
        // 封装为全局函数：支持强制打开/关闭，且支持静默展开（不强制滑动屏幕）
        function toggleSidecar(forceOpen = null, skipScroll = false) {
            const targetState = forceOpen !== null ? forceOpen : !isSidecarOpen;
            if (isSidecarOpen === targetState) return;
            
            isSidecarOpen = targetState;
            if (isSidecarOpen) {
                document.body.classList.add('show-sidecars');
                els.sidecarBtn.classList.add('text-blue-600', 'bg-blue-50');
                els.sidecarBtn.classList.remove('text-gray-600');
                if (!skipScroll) {
                    setTimeout(() => els.container.scrollBy({ left: 300, behavior: 'smooth' }), 50);
                }
            } else {
                document.body.classList.remove('show-sidecars');
                els.sidecarBtn.classList.remove('text-blue-600', 'bg-blue-50');
                els.sidecarBtn.classList.add('text-gray-600');
                if (!skipScroll) {
                    els.container.scrollBy({ left: -els.container.scrollLeft, behavior: 'smooth' });
                }
            }
        }

        // 按钮点击依然执行标准展开（带有屏幕滑动反馈）
        els.sidecarBtn.addEventListener('click', () => toggleSidecar());

        
        // 1. 切换按钮状态 (仅作为左键拖拽的开关)
        els.handToolBtn.addEventListener('click', () => {
            state.isHandToolActive = !state.isHandToolActive;
            if (state.isHandToolActive) {
                els.handToolBtn.classList.add('text-blue-600', 'bg-blue-50');
                els.handToolBtn.classList.remove('text-gray-600');
                els.container.style.cursor = 'grab';
                // 如果开启了抓手，把当前的标注工具强行切回 cursor
                if(state.currentTool !== 'cursor') {
                    state.currentTool = 'cursor';
                    updateToolButtons();
                }
            } else {
                els.handToolBtn.classList.remove('text-blue-600', 'bg-blue-50');
                els.handToolBtn.classList.add('text-gray-600');
                els.container.style.cursor = '';
                state.handDrag.isDragging = false; 
                state.handDrag.isSpaceDown = false;
            }
        });

        const endHandDrag = () => {
            if (state.handDrag.isDragging) {
                state.handDrag.isDragging = false;
                // 判断是保持抓手还是恢复默认
                els.container.style.cursor = (state.isHandToolActive || state.handDrag.isSpaceDown) ? 'grab' : '';
            }
        };

        state.handDrag.isSpaceDown = false;
        window.addEventListener('keydown', (e) => {
            // 当焦点不在输入框时，按空格键触发
            if ((e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && !e.target.isContentEditable) {
                // 如果当前交互发生在副阅读器小窗、白板、导图或对话/视频悬浮窗内，不劫持主阅读器状态
                const companionPanel = document.getElementById('companion-pdf-panel');
                if (companionPanel && !companionPanel.hidden) {
                    if (e.target.closest?.('#companion-pdf-panel') || companionPanel.contains(document.activeElement) || companionPanel.matches?.(':hover')) {
                        return;
                    }
                }
                const whiteboardPanel = document.getElementById('handwriting-whiteboard');
                if (whiteboardPanel && !whiteboardPanel.hidden) {
                    if (e.target.closest?.('#handwriting-whiteboard') || whiteboardPanel.contains(document.activeElement) || whiteboardPanel.matches?.(':hover')) {
                        return;
                    }
                }
                const mindmapPanel = document.getElementById('mindmap-panel');
                if (mindmapPanel && !mindmapPanel.classList.contains('hidden')) {
                    if (e.target.closest?.('#mindmap-panel') || mindmapPanel.contains(document.activeElement) || mindmapPanel.matches?.(':hover')) {
                        return;
                    }
                }
                for (const sel of ['#ds-chat-panel', '#video-panel', '#formula-input-panel']) {
                    const panelEl = document.querySelector(sel);
                    if (panelEl && panelEl.style.display !== 'none' && !panelEl.classList.contains('hidden')) {
                        if (e.target.closest?.(sel) || panelEl.contains(document.activeElement) || panelEl.matches?.(':hover')) {
                            return;
                        }
                    }
                }

                e.preventDefault(); // 阻止按空格页面向下滚动
                
                if (document.activeElement && document.activeElement !== document.body) {
                    document.activeElement.blur();
                }
                
                if (state.currentTool !== 'cursor') {
                    state.currentTool = 'cursor';
                    updateToolButtons(); // 刷新顶部工具栏UI，去掉高亮
                    
                    // 【防错补丁】：如果用户正在画直线/箭头画到一半时按了空格，强行中断并清理残留线条
                    if (state.drawingArrow && state.drawingArrow.isDrawing) {
                        state.drawingArrow.isDrawing = false;
                        document.getElementById('temp-drawing-svg')?.remove();
                    }
                }

                if (!state.handDrag.isSpaceDown) {
                    state.handDrag.isSpaceDown = true;
                    els.container.style.cursor = 'grab'; // 变成抓手图标
                    
                    // 仅在开启空格保存且有未保存修改时保存；抓手始终可用。
                    if (spaceSaveToggle?.getAttribute('aria-pressed') !== 'false' && state.unsavedChanges) {
                        performSave();
                    }
                }
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
                state.handDrag.isSpaceDown = false;
                if (!state.isHandToolActive) {
                    els.container.style.cursor = '';
                }
                endHandDrag();
            }
        });

        // 解决因保存弹窗、Alt+Tab 切屏导致松开空格键的 keyup 事件丢失，从而引起抓手死锁的问题
        window.addEventListener('blur', () => {
            if (state.handDrag.isSpaceDown) {
                state.handDrag.isSpaceDown = false;
                if (!state.isHandToolActive) {
                    els.container.style.cursor = '';
                }
                endHandDrag();
            }
        });

        // 鼠标重回主视口时，若未按压鼠标按键，强制结束残留拖拽
        els.container.addEventListener('pointerenter', (e) => {
            if (!(e.buttons & 1) && !(e.buttons & 4)) {
                if (state.handDrag.isDragging) {
                    endHandDrag();
                }
            }
        });

        // 2. 在 Window 级别捕获鼠标左键按下
        window.addEventListener('mousedown', (e) => {
            // 只响应左键 (e.button === 0) 或者 中键滚轮按下 (e.button === 1)
            // 只要点亮了抓手图标，或者按住了空格键，就可以抓取！
            const canGrab = state.isHandToolActive || state.handDrag.isSpaceDown;
            
            if (canGrab && (e.button === 0 || e.button === 1)) {
                if (!e.target.closest('#viewer-container')) return;

                e.preventDefault(); // 防止选中文本
                e.stopPropagation();
                state.handDrag.isDragging = true;
                state.handDrag.startX = e.clientX;
                state.handDrag.startY = e.clientY;
                state.handDrag.scrollLeft = els.container.scrollLeft;
                state.handDrag.scrollTop = els.container.scrollTop;

                els.container.style.cursor = 'grabbing'; // 变成握拳
            }
        }, { capture: true });

        // 3. 鼠标移动：更新滚动条
        window.addEventListener('mousemove', (e) => {
            if (state.handDrag.isDragging) {
                // 如果左键和中键都松开了，强行终止拖拽
                // (e.buttons = 1 是左键, 4 是中键，如果都不是说明物理松手了)
                if (!(e.buttons & 1) && !(e.buttons & 4)) {
                    endHandDrag();
                    return;
                }

                e.preventDefault();
                e.stopPropagation();

                const dx = e.clientX - state.handDrag.startX;
                const dy = e.clientY - state.handDrag.startY;

                els.container.scrollLeft = state.handDrag.scrollLeft - dx;
                els.container.scrollTop = state.handDrag.scrollTop - dy;
            }
        }, { capture: true, passive: false });

        // 4. 正常的鼠标松开处理
        window.addEventListener('mouseup', (e) => {
            if (state.handDrag.isDragging && (e.button === 0 || e.button === 1)) {
                endHandDrag();
            }
        });

        window.addEventListener('click', (e) => {
            const canGrab = state.isHandToolActive || state.handDrag.isSpaceDown;
            if (canGrab && e.target.closest('#viewer-container')) {
                e.stopPropagation(); // 绝对拦截，吃掉点击事件
                e.preventDefault();
            }
        }, { capture: true });
        

        init();

        // =========================================================================
        // 👁️ 批注视界隐形引擎 (Annotations Visibility Engine)
        // =========================================================================
        els.toggleVisBtn.addEventListener('click', () => {
            state.showAnnotations = !state.showAnnotations;
            
            if (state.showAnnotations) {
                // 恢复显示：解除护盾，恢复红色
                document.body.classList.remove('hide-annotations');
                els.visIcon.classList.remove('text-gray-400');
                els.visIcon.classList.add('text-red-600');
                els.toggleVisBtn.title = "隐藏所有批注 (沉浸阅读)";
            } else {
                // 沉浸模式：挂载护盾，图标变灰
                document.body.classList.add('hide-annotations');
                els.visIcon.classList.remove('text-red-600');
                els.visIcon.classList.add('text-gray-400');
                els.toggleVisBtn.title = "显示所有批注";
            }
        });

        // =========================================================================
        // =========================================================================

        const tabAnnos = document.getElementById('tab-annos');
        const tabSnippets = document.getElementById('tab-snippets');
        const saveSnippetBtn = document.getElementById('save-snippet-btn');

        // 1. 保存当前文本块到素材库
        if (saveSnippetBtn) {
            saveSnippetBtn.addEventListener('click', () => {
                if (!state.activeAnnotationId) return;
                const anno = state.annotations[state.activePageNum]?.find(a => a.id === state.activeAnnotationId);
                
                if (anno && anno.type === 'text') {
                    if (!state.annotations['snippets']) state.annotations['snippets'] = [];
                    
                    // 核心动作：存入素材库，支持撤销，并自动触发文件写入！
                    performAction(() => {
                        state.annotations['snippets'].push({
                            id: nextAnnotationId('snip_'),
                            text: anno.text,
                            color: anno.color,
                            timestamp: new Date().toLocaleString()
                        });
                    }, ['snippets']);
                    
                    // UI 反馈
                    saveSnippetBtn.innerHTML = '<i class="ph-fill ph-check-circle text-green-500"></i>';
                    setTimeout(() => {
                        saveSnippetBtn.innerHTML = '<i class="ph-fill ph-star"></i>';
                    }, 1000);
                }
            });
        }

        // 2. 侧边栏模式切换
        tabAnnos.addEventListener('click', () => setSidebarMode('annotations'));
        tabSnippets.addEventListener('click', () => setSidebarMode('snippets'));

        // 3. 渲染素材库列表
        function renderSnippetsSidebar() {
            if (state.sidebarMode !== 'snippets') return;
            const list = els.sidebarList;
            list.innerHTML = '';

            const snippets = state.annotations['snippets'] || [];

            const header = document.createElement('div');
            header.className = 'text-xs text-gray-500 px-2 py-2 mb-2 bg-orange-50 border border-orange-100 rounded flex items-center gap-2';
            header.innerHTML = '<i class="ph-fill ph-info text-orange-400 text-lg"></i> <span>点击素材即可<b>空降</b>至屏幕中央</span>';
            list.appendChild(header);

            if (snippets.length === 0) {
                list.innerHTML += `<div class="text-center text-gray-400 text-sm mt-8 p-4"><i class="ph-fill ph-star text-3xl mb-2 opacity-30"></i><p>暂无素材</p></div>`;
                return;
            }

            // 倒序渲染，最新保存的在最上面
            [...snippets].reverse().forEach(snip => {
                const div = document.createElement('div');
                div.className = 'sidebar-item p-2.5 mb-2 bg-white rounded shadow-sm cursor-pointer border border-gray-100 hover:border-orange-300 group relative transition-all';
                
                // 删除素材按钮
                const delBtn = document.createElement('button');
                delBtn.className = 'absolute top-1.5 right-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity';
                delBtn.innerHTML = '<i class="ph ph-trash"></i>';
                delBtn.onclick = (e) => {
                    e.stopPropagation(); // 阻止触发天降
                    performAction(() => {
                        state.annotations['snippets'] = state.annotations['snippets'].filter(s => s.id !== snip.id);
                    }, ['snippets']);
                };
                
                // 渲染 LaTeX 预览
                const previewBox = document.createElement('div');
                previewBox.className = 'text-sm text-gray-700 bg-gray-50 p-2 rounded pointer-events-none mt-1';
                previewBox.style.color = snip.color || '#000';
                previewBox.textContent = snip.text; // 预先填充
                
                const safeTime = typeof escapeHtmlText === 'function' ? escapeHtmlText(snip.timestamp || '') : String(snip.timestamp || '');
                div.innerHTML = `<div class="text-[10px] text-gray-400 font-mono mb-1"><i class="ph-fill ph-star text-orange-400 mr-1"></i>${safeTime}</div>`;
                div.appendChild(delBtn);
                div.appendChild(previewBox);
                
                // 异步渲染 LaTeX，防止卡顿
                setTimeout(() => renderLatex(previewBox), 10);

                // 核心交互：一键天降
                div.addEventListener('click', () => {
                    dropSnippetToScreenCenter(snip);
                });

                list.appendChild(div);
            });
        }

        // 4. 一键天降核心算法 (纯相对坐标映射)
        function dropSnippetToScreenCenter(snip) {
            // 获取当前阅读器视窗的正中心绝对坐标
            const rect = els.container.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            // 利用浏览器原生 API，瞬间找到屏幕最中心的 DOM 元素
            const elAtCenter = document.elementFromPoint(centerX, centerY);
            if (!elAtCenter) return;

            // 向上追溯，找到它属于哪一页
            const wrapper = elAtCenter.closest('.page-wrapper');
            if (!wrapper) {
                alert("⚠️ 请将某一页的 PDF 滚动到屏幕中央后再使用天降！");
                return;
            }

            const targetPageNum = parseInt(wrapper.dataset.pageNum);
            const wrapperRect = wrapper.getBoundingClientRect();

            // 将屏幕中心的绝对坐标，完美转换为 PDF 该页内部的相对比例 (0.0~1.0)
            let relativeX = (centerX - wrapperRect.left) / wrapperRect.width;
            let relativeY = (centerY - wrapperRect.top) / wrapperRect.height;
            
            // 微调：减去文本块预估尺寸的一半，让文本块绝对居中
            relativeX -= 0.05; 
            relativeY -= 0.02;

            // 执行插入与保存
            performAction(() => {
                if (!state.annotations[targetPageNum]) state.annotations[targetPageNum] = [];
                state.annotations[targetPageNum].push({
                    id: nextAnnotationId(),
                    type: 'text',
                    color: snip.color,
                    x: relativeX,
                    y: relativeY,
                    text: snip.text,
                    timestamp: new Date().toLocaleString()
                });
            }, [targetPageNum]);

            // 视觉反馈：让刚才被放置的页面闪烁一下
            wrapper.style.transition = 'filter 0.3s';
            wrapper.style.filter = 'brightness(0.9) contrast(1.1)';
            setTimeout(() => { wrapper.style.filter = ''; }, 300);
            setSidebarMode('annotations');
        }

        // =========================================================================
        // =========================================================================

