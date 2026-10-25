        function init() {
            // 【新增】彻底封杀浏览器的自带滚动记忆功能
            if ('scrollRestoration' in history) {
                history.scrollRestoration = 'manual';
            }

            updateSaveStatus(false);
            initHistory();
             if (typeof updateSliderUI === 'function') updateSliderUI(state.scale, false);

            if (window.location.search.includes('mode=receiver')) {
                // 1. 提取旧窗口给的接头暗号 (sid)
                const urlParams = new URLSearchParams(window.location.search);
                const sid = urlParams.get('sid');

                // 2. 清理 URL 尾巴，让用户的地址栏保持纯净
                const cleanUrl = window.location.href.replace(/([?&])mode=receiver(&sid=\d+)?/, '');
                window.history.replaceState(null, '', cleanUrl);

                // 3. 监听老网页隔空投送过来的消息
                window.addEventListener('message', async (e) => {
                    if (!e.data) return;

                    if (e.data.action === 'PING' && e.data.sid === sid) {
                        if (e.source) e.source.postMessage({ action: 'PONG', sid: sid }, '*');
                        return;
                    }

                    // 正常接收：包含高级门禁卡的传送方案
                    if (e.data.type === 'TRANSFER_FILE') {
                        state.fileHandle = e.data.handle || null;
                        state.localFilePath = null;   // 投递过来的文件只带 文件/句柄，没有磁盘路径
                        updateDocMeta();
                        await loadPDFFromFile(e.data.file);
                    } 
                    else if (e.data.type === 'TRANSFER_BUFFER') {
                        state.fileHandle = null;
                        state.localFilePath = null;
                        updateDocMeta();
                        
                        // 将二进制流当场重塑为 Blob 对象，伪装成 File 喂给阅读器
                        const blob = new Blob([e.data.buffer], { type: 'application/pdf' });
                        blob.name = e.data.name; 
                        await loadPDFFromFile(blob);
                    }
                });

                // 4. 传统回拨（对 Live Server / http 环境依然有效）
                if (window.opener) {
                    window.opener.postMessage({ action: 'READY', sid: sid }, '*');
                }

                // 5. 接收页是脚本新开的窗口：这里再尽力抢一次前台。
                //    window.open 在有手势时本来就会开在前台，这一句只兜住"被浏览器丢到后台"的情况
                //    （无手势的 focus() 可能被忽略，那就只能由用户自己切过去了）
                try { window.focus(); } catch (e) {}
            }

            // 🔗 快捷入口的「Ctrl + 点击 → 新标签页」：本页按 URL 里的路径自己去读这份教材。
            //    好处是发送端完全不用先下载一遍，新标签页开出来就是前台 + 正在加载，
            //    观感与下拉里的「新页打开」完全一致。
            const openPath = new URLSearchParams(window.location.search).get('open');
            if (openPath) {
                // 立刻把参数从地址栏摘掉（刷新时不会重复触发），随后异步加载
                try {
                    const u = new URL(window.location.href);
                    u.searchParams.delete('open');
                    window.history.replaceState(null, '', u.href);
                } catch (e) {}
                (async () => {
                    try {
                        const resp = await fetch('/api/read-file?path=' + encodeURIComponent(openPath));
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        const blob = await resp.blob();
                        const name = openPath.split(/[\\/]/).pop() || 'document.pdf';
                        await processSelectedFile(new File([blob], name, { type: 'application/pdf' }), null, false, openPath);
                    } catch (err) {
                        console.error("按路径打开教材失败:", err);
                        alert(`未能打开教材：${err.message}\n请确认已通过 starter(H).bat 启动本地服务。`);
                    }
                })();
            }
        }

        function initHistory() {
            // 初始状态存入唯一的全量快照，后续全部采用增量 Delta
            state.history = [{ type: 'FULL', data: JSON.stringify(state.annotations) }];
            state.historyIndex = 0;
        }

        // 注意：原有的 saveHistory 函数被彻底删除，其逻辑已被融入 performAction 的增量追踪中！

        function undo() {
            if (state.historyIndex > 0) {
                const step = state.history[state.historyIndex];
                if (step.type === 'FULL') {
                    state.annotations = JSON.parse(step.data);
                } else if (step.backward) {
                    Object.keys(step.backward).forEach(k => {
                        if (step.backward[k] === "[]" && k !== 'snippets') state.annotations[k] = []; 
                        else state.annotations[k] = JSON.parse(step.backward[k]);
                    });
                }
                state.historyIndex--;
                refreshUI();
                updateSaveStatus(true);     // 【修改】将状态判定提前
                saveAnnotationsToStorage(); // 这样这里的防呆逻辑才能准确判断状态
            }
        }

        function redo() {
            if (state.historyIndex < state.history.length - 1) {
                state.historyIndex++;
                const step = state.history[state.historyIndex];
                if (step.type === 'FULL') {
                    state.annotations = JSON.parse(step.data);
                } else if (step.forward) {
                    Object.keys(step.forward).forEach(k => {
                        if (step.forward[k] === "[]" && k !== 'snippets') state.annotations[k] = [];
                        else state.annotations[k] = JSON.parse(step.forward[k]);
                    });
                }
                refreshUI();
                updateSaveStatus(true);     // 【修改】将状态判定提前
                saveAnnotationsToStorage();
            }
        }
        

        // ================= 侧边栏高性能防抖引擎 =================
        let sidebarDebounceTimer = null;

        // UI 防抖剥离：保护主线程，密集拖拽和画图时不卡顿
        function debouncedUpdateSidebar() {
            clearTimeout(sidebarDebounceTimer);
            sidebarDebounceTimer = setTimeout(() => {
                if (state.sidebarMode === 'snippets') {
                    renderSnippetsSidebar();
                } else if (state.sidebarMode === 'search') {
                    // 搜索模式由其专属引擎接管，保持不变
                } else {
                    updateSidebar();
                }
            }, 150); // 150ms 延时完美平衡跟手度与性能
        }

        function refreshUI() {
            // 画布局部重绘（极速，立即执行，保证阅读不卡）
            state.pagesRendered.forEach(pageNum => {
                renderAnnotations(pageNum);
            });
            // 侧边栏的DOM重排交由防抖队列处理
            debouncedUpdateSidebar();
        }

        document.addEventListener('keydown', (e) => {
            // 智能判断：当前光标是否在输入框(INPUT)或文本域(TEXTAREA)内
            const isTyping = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

            if ((e.ctrlKey || e.metaKey) && e.key === 'z') { 
                if (isTyping) return;
                e.preventDefault(); undo(); 
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'y') { 
                if (isTyping) return;
                e.preventDefault(); redo(); 
            }
            
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); toggleSearch(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); performSave(); }

            // 只有在非打字状态，且没有按住 Ctrl/Alt/Meta 等修饰键时才触发
            if (!isTyping && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const key = e.key.toLowerCase(); // 兼容大小写（开启 CapsLock 也能用）
                
                if (key === 'h') {
                    e.preventDefault();
                    const highlightBtn = document.querySelector('button[data-tool="highlight"]');
                    if (highlightBtn) highlightBtn.click();
                }
                
                if (key === 'u') {
                    e.preventDefault();
                    const underlineBtn = document.querySelector('button[data-tool="underline"]');
                    if (underlineBtn) underlineBtn.click(); // 多次按下会自动在下划线/直线间切换，完美继承原生逻辑
                }
            }
        });

        document.addEventListener('click', (e) => {
            // 原有的笔记弹窗关闭逻辑
            if (!els.noteModal.classList.contains('hidden') && !e.target.closest('#note-modal')) {
                rollbackLivePreview();
                els.noteModal.classList.add('hidden');
                state.activeAnnotationId = null;
                state.isEditingNote = false;
            }

            if (state.isOutlineOpen && !e.target.closest('#outline-panel') && !e.target.closest('#outline-trigger-btn')) {
                toggleOutline(false);
            }
        });

        function updateSaveStatus(isDirty) {
            state.unsavedChanges = isDirty;
            if (isDirty) {
                els.saveStatusBtn.classList.remove('btn-saved'); els.saveStatusBtn.classList.add('btn-unsaved');
                els.saveIcon.className = 'ph ph-floppy-disk text-2xl animate-pulse'; 
                els.saveStatusBtn.title = state.fileHandle ? "点击覆盖保存到原文件" : "点击保存更改到本地";
            } else {
                els.saveStatusBtn.classList.remove('btn-unsaved'); els.saveStatusBtn.classList.add('btn-saved');
                els.saveIcon.className = 'ph ph-check-circle text-2xl'; 
                els.saveStatusBtn.title = "所有更改已保存";
            }
        }
        
        // 彻底脱离主渲染链条，后台默默提取庞大的 Hex 字典，拒绝阻塞首屏！
        async function runAsyncWakeUpTail(file, fingerprint) {
            state.fingerprint = fingerprint;
            console.log("PDF Fingerprint:", state.fingerprint);

            let embeddedAnnos = {};
            let localAnnos = {};

            try {
                // 1. 极速读取本地 indexedDB 缓存（无阻塞）
                const localKey = `pdf_annos_${state.fingerprint}`;
                const localData = await localforage.getItem(localKey);
                if (localData) {
                    localAnnos = typeof localData === 'string' ? JSON.parse(localData) : localData;
                }

                // 2. 懒加载读取底层的超大二进制字典 (此时首屏早已渲染完毕，用户已经在看书了)
                state.pdfData = await file.arrayBuffer();
                const { PDFDocument, PDFName } = PDFLib;
                const libDoc = await PDFDocument.load(state.pdfData.slice(0), { ignoreEncryption: true });
                
                const customObj = libDoc.getInfoDict().get(PDFName.of('ReaderProAnnos'));
                if (customObj && customObj.value) {
                    const hex = customObj.value;
                    const bytes = new Uint8Array(hex.length / 2);
                    for (let i = 0; i < hex.length; i += 2) {
                        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
                    }
                    const text = new TextDecoder().decode(bytes);
                    embeddedAnnos = JSON.parse(text);
                    console.log("✅ 异步尾流：成功从底层 Hex 字典中完美读取批注！");
                }
            } catch (e) { 
                console.warn("异步尾流：未读取到内嵌批注或发生错误", e); 
            }

            // 3. 数据合并与状态初始化
            if (Object.keys(embeddedAnnos).length > 0) {
                state.annotations = embeddedAnnos;
                saveAnnotationsToStorage();
            } else if (Object.keys(localAnnos).length > 0) {
                state.annotations = localAnnos;
            } else {
                state.annotations = {};
            }

            if (state.annotations['settings'] && typeof state.annotations['settings'].pageOffset === 'number') {
                state.pageOffset = state.annotations['settings'].pageOffset;
                
                // 如果曾经设置过偏移，恢复右上角 UI 按钮的状态
                if (state.pageOffset > 0) {
                    els.resetOffsetBtn.classList.remove('hidden');
                    els.resetOffsetBtn.classList.add('flex');
                    els.setOffsetBtn.classList.add('hidden');
                    els.setOffsetBtn.classList.remove('flex');
                }
                
                // 强制下一帧重新渲染 HUD
                state.currentPhysicalPage = -1;
                updateHUDAndOutline(); 
            }

            initHistory();
            updateSidebar();

            // 4. 时空空降：在当前用户正看着的（已渲染的）页面上，瞬间叠加批注！
            state.pagesRendered.forEach(pageNum => {
                renderAnnotations(pageNum);
            });

            // ================= 自动恢复到上次阅读的页码 =================
            // 兼容旧数据：若内嵌(embedded)版本缺少 lastPage，但本地缓存有，则补上
            if ((!state.annotations['settings'] || !state.annotations['settings'].lastPage)
                && localAnnos['settings'] && localAnnos['settings'].lastPage) {
                if (!state.annotations['settings']) state.annotations['settings'] = {};
                state.annotations['settings'].lastPage = localAnnos['settings'].lastPage;
            }

            // 等待首屏布局稳定后恢复：150ms 先快速到位；700ms 后若用户未手动滚动则再校准一次
            // （第二次校准兼容异形页渲染后对 pageDimensions 的尺寸修正）
            setTimeout(() => {
                restoreLastPage();
                setTimeout(() => {
                    if (lastRestoreScrollTop !== null
                        && Math.abs(els.container.scrollTop - lastRestoreScrollTop) < 5) {
                        restoreLastPage();
                    }
                }, 700);
            }, 150);
        }

        // 📌 恢复上次阅读页码：坐标计算与 HUD 视界雷达 (updateHUDAndOutline) 完全同源
        let lastRestoreScrollTop = null;

        function restoreLastPage() {
            if (!state.annotations || !state.annotations['settings']) return;
            const targetPage = parseInt(state.annotations['settings'].lastPage, 10);
            if (!(targetPage > 1) || state.pageDimensions.length === 0) return;

            const pageMargin = 24; // 与 .page-wrapper { margin-bottom: 24px } 及雷达常量保持一致
            let targetScrollTop = 0;
            const count = Math.min(targetPage - 1, state.pageDimensions.length);
            for (let i = 0; i < count; i++) {
                targetScrollTop += (state.pageDimensions[i].height * state.scale) + pageMargin;
            }
            els.container.scrollTop = targetScrollTop;
            lastRestoreScrollTop = targetScrollTop;
        }

        async function saveAnnotationsToStorage() {
            if (!state.fingerprint) return;
            
            // ================= 新增：条件拦截记录最后阅读位置 =================
            // 只有在文档处于有新修改（unsavedChanges 为真）状态时，正常保存才会带上页码。
            // 完美拦截干净状态下你用空格(Ctrl+S)抓手工具乱触发位置更新。
            if (state.unsavedChanges) {
                if (!state.annotations['settings']) {
                    state.annotations['settings'] = {};
                }
                if (state.currentPhysicalPage && state.currentPhysicalPage > 0) {
                    state.annotations['settings'].lastPage = state.currentPhysicalPage;
                }
            }
            // =======================================================

            const key = `pdf_annos_${state.fingerprint}`;
            try {
                await localforage.setItem(key, state.annotations);
            } catch(e) {
                console.error("Local data save error", e);
            }
        }

        let isOpeningInNewWindow = false;

        // 🎨 保存模式指示器
        //    绿色标题 = 「本地原位保存模式」（快捷入口，或 Ctrl+点击开出来的新标签页）—— 唯一的染色信号；
        //    文件句柄模式（主按钮 / 下拉新页打开）虽然同样能原位覆盖，但不再染色，信息只放在 title 悬浮提示里；
        //    两种都没有时才是降级：灰标题 + 一行小字「另存为模式」。
        function updateDocMeta() {
            const isLocalPathMode = !!state.localFilePath;
            const canSaveInPlace = isLocalPathMode || !!state.fileHandle;
            if (els.docTitle) {
                els.docTitle.classList.toggle('text-green-600', isLocalPathMode);
                els.docTitle.classList.toggle('text-gray-500', !isLocalPathMode);
                const mode = isLocalPathMode ? '保存方式：原位覆盖（本地路径）'
                    : canSaveInPlace ? '保存方式：原位覆盖（文件句柄）'
                    : '保存方式：另存为 / 下载副本';
                els.docTitle.title = (els.docTitle.textContent || '未打开文档') + '\n' + mode;
            }
            if (!els.docMeta) return;
            if (canSaveInPlace) {
                els.docMeta.classList.add('hidden');
            } else {
                els.docMeta.textContent = '另存为模式 · 无法原位覆盖';
                els.docMeta.classList.remove('hidden', 'text-green-600');
                els.docMeta.classList.add('text-gray-400');
            }
        }

        // newWindow：本次是否要在新标签页并行打开（由调用方显式传入，避免全局标志残留串味）
        // localPath ：本次文件在磁盘上的真实路径（快捷入口提供），用于原位静默保存
        async function processSelectedFile(file, handle, newWindow = false, localPath = null) {
            if (newWindow) {
                // 🚀 新窗口发信端模式：生成唯一暗号 (Session ID)
                const sid = Date.now().toString();
                const connector = window.location.href.includes('?') ? '&' : '?';
                const newUrl = window.location.href + connector + 'mode=receiver&sid=' + sid;

                // 开新标签页：选完文件（或点完下拉项）之后立刻开，浏览器会把它切到前台
                const newWin = window.open(newUrl, '_blank');
                if (!newWin) {
                    alert("未能打开新标签页：多半被浏览器的弹窗拦截拦住了。\n请在地址栏右侧允许本站弹窗后重试。");
                    return;
                }
                
                // 只要虫洞开着，我们就每隔 200ms 向里扔探测器，直到收到新窗口的回声。
                let pingTimer = setInterval(() => {
                    if (newWin && !newWin.closed) {
                        newWin.postMessage({ action: 'PING', sid: sid }, '*');
                    } else {
                        cleanup(); // 新窗口被手动关闭了，停止探测
                    }
                }, 200);

                // 兜底：新页面若一直没回音（引擎没起、被扩展拦截），20 秒后也摘掉监听器与定时器，
                // 避免这个 once 用的 messageHandler 永久驻留
                let giveUpTimer = setTimeout(() => cleanup(), 20000);
                function cleanup() {
                    clearInterval(pingTimer);
                    clearTimeout(giveUpTimer);
                    window.removeEventListener('message', messageHandler);
                }

                // 注意这里要改成 async (e)，因为里面要用到 await
                const messageHandler = async (e) => {
                    // 核对暗号，无视任何身份拦截
                    if (e.data && (e.data.action === 'READY' || e.data.action === 'PONG') && e.data.sid === sid) {
                        cleanup(); // 收到回音，立即停止声呐

                        if (newWin) {
                            try {
                                // 尝试 A 计划：投递完整的高级门禁卡（在 VS Code 服务器环境下完美运行，支持原位保存）
                                newWin.postMessage({ type: 'TRANSFER_FILE', file: file, handle: handle }, '*');
                            } catch (err) {
                                // 此时立刻放弃传送门禁卡，执行 B 计划：将 PDF 抽成纯粹的二进制水流，强行灌注过去！
                                console.warn("本地离线沙盒拦截：无法克隆物理文件句柄。启动二进制流降级传送...");
                                const arrayBuffer = await file.arrayBuffer();
                                newWin.postMessage({ 
                                    type: 'TRANSFER_BUFFER', 
                                    buffer: arrayBuffer, 
                                    name: file.name
                                }, '*');
                            }
                        }
                    }
                };
                window.addEventListener('message', messageHandler);
            } else {
                // 🚀 当前页打开模式（原逻辑还原）
                state.fileHandle = handle || null;
                // 原位保存路径只跟随「当前窗口真正打开的这份文档」：带路径打开才绑定，其余一律解绑，
                // 杜绝把这份文档的批注写进上一份文件
                state.localFilePath = localPath || null;
                updateDocMeta();
                // await：让调用方（快捷入口）能等真正加载完再放开防连点闸门，
                // 避免两份 PDF 并发 loadPDFFromFile 互相 revoke blobUrl、交错写 state
                await loadPDFFromFile(file);
            }
        }

        async function triggerFileSelect(newWindow = false) {
            // 注意：这里不再清空 state.localFilePath —— 取消选择时当前文档并没有换，
            // 原位保存目标必须继续指向它；真正换文档时由 processSelectedFile 重新绑定
            if (window.showOpenFilePicker) {
                // ⚠️ 顺序铁律：必须先 showOpenFilePicker，最后才 window.open。
                //    window.open() 会「消耗」掉本次用户手势（transient activation），
                //    若在它之后再调用 showOpenFilePicker，后者会直接抛
                //    SecurityError: Must be handling a user gesture to show a file picker，
                //    连 file input 兜底也会因为同样原因打不开。
                //    （新标签页因此只能在选完文件之后开，可能被弹窗拦截 —— 已做 null 兜底提示）
                try {
                    const [handle] = await window.showOpenFilePicker({
                        types: [{ description: 'PDF Files', accept: { 'application/pdf': ['.pdf'] } }],
                        multiple: false
                    });
                    const file = await handle.getFile();
                    processSelectedFile(file, handle, newWindow, null);
                } catch (err) {
                    if (err.name !== 'AbortError') { 
                        console.error(err); 
                        // 只有退回 <input> 这条路才需要中转标志（change 事件里拿不到 newWindow 参数）
                        isOpeningInNewWindow = newWindow;
                        els.fileInput.click();
                    } 
                }
            } else {
                isOpeningInNewWindow = newWindow;
                els.fileInput.click(); 
            }
        }

        // 事件绑定：主按钮覆盖当前，下拉图标开新窗口
        els.openBtn.addEventListener('click', () => triggerFileSelect(false));
        if (els.openNewBtn) els.openNewBtn.addEventListener('click', (e) => { e.stopPropagation(); triggerFileSelect(true); });

        // =========================================================================
        // 📁 顶部快捷教材文件夹双按钮 (Quick Folder Shortcuts)
        // =========================================================================
        const QUICK_FOLDERS_KEY = 'pdf_reader_quick_folders';
        const DEFAULT_QUICK_FOLDERS = {
            btn1: {
                path: 'D:\\下载\\数学专业课',
                label: '数',
                name: '数学专业课'
            },
            btn2: {
                path: 'D:\\下载\\物理专业课',
                label: '物',
                name: '物理专业课'
            }
        };

        function loadQuickFoldersConfig() {
            try {
                const saved = localStorage.getItem(QUICK_FOLDERS_KEY);
                if (saved) {
                    const parsed = JSON.parse(saved);
                    return {
                        btn1: Object.assign({}, DEFAULT_QUICK_FOLDERS.btn1, parsed.btn1 || {}),
                        btn2: Object.assign({}, DEFAULT_QUICK_FOLDERS.btn2, parsed.btn2 || {})
                    };
                }
            } catch (e) {
                console.warn("读取快捷文件夹配置失败，使用默认配置:", e);
            }
            return JSON.parse(JSON.stringify(DEFAULT_QUICK_FOLDERS));
        }

        function saveQuickFoldersConfig(config) {
            try {
                localStorage.setItem(QUICK_FOLDERS_KEY, JSON.stringify(config));
            } catch (e) {
                console.error("保存快捷文件夹配置失败:", e);
            }
        }

        let quickFoldersConfig = loadQuickFoldersConfig();
        const quickFolderBtn1 = document.getElementById('quick-folder-btn-1');
        const quickFolderBtn2 = document.getElementById('quick-folder-btn-2');
        const quickFolderModal = document.getElementById('quick-folder-modal');
        const quickFolderPathInput = document.getElementById('quick-folder-path-input');
        const quickFolderLabelInput = document.getElementById('quick-folder-label-input');
        const quickFolderModalTitle = document.getElementById('quick-folder-modal-title');
        const closeQuickFolderBtn = document.getElementById('close-quick-folder-btn');
        const cancelQuickFolderBtn = document.getElementById('cancel-quick-folder-btn');
        const saveQuickFolderBtn = document.getElementById('save-quick-folder-btn');
        const resetQuickFolderBtn = document.getElementById('reset-quick-folder-btn');
        const browseQuickFolderBtn = document.getElementById('browse-quick-folder-btn');

        // 从完整路径里拆出「文件夹名」与「1 字简称」(如 D:\下载\数学专业课 → { name: '数学专业课', label: '数' })
        function parseFolderPath(pathStr) {
            const segs = (pathStr || '').replace(/[\\\/]+$/, '').split(/[\\\/]/);
            const name = segs[segs.length - 1] || '';
            return { name: name, label: name.substring(0, 1) };
        }

        function updateQuickFolderButtonsUI() {
            if (quickFolderBtn1) {
                const conf1 = quickFoldersConfig.btn1;
                // 按钮只有 19px 宽，简称统一截断成 1 个字（兼容历史遗留的 2 字配置）
                quickFolderBtn1.textContent = (conf1.label || '数').substring(0, 1);
                quickFolderBtn1.title = `${conf1.name || conf1.path} (${conf1.path})\n点击直接选择打开 PDF 教材\nCtrl + 点击：在新标签页并行打开\n右键更改设置`;
            }
            if (quickFolderBtn2) {
                const conf2 = quickFoldersConfig.btn2;
                quickFolderBtn2.textContent = (conf2.label || '物').substring(0, 1);
                quickFolderBtn2.title = `${conf2.name || conf2.path} (${conf2.path})\n点击直接选择打开 PDF 教材\nCtrl + 点击：在新标签页并行打开\n右键更改设置`;
            }
        }
        updateQuickFolderButtonsUI();

        let quickFolderBusy = false; // 防连点：原生选择窗口没关闭前，忽略重复点击

        // 🚀 核心：直接在目标文件夹中打开系统文件选择对话框，直接选取文件并加载
        // openInNewTab：Ctrl/Cmd + 点击 —— 选完文件后开一个新标签页，由它自己按路径读取
        async function pickAndOpenFileFromFolder(folderPath, openInNewTab = false) {
            if (quickFolderBusy) return;
            quickFolderBusy = true;
            try {
                const resp = await fetch('/api/pick-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folder: folderPath })
                });
                const data = await resp.json();
                if (data.cancelled) {
                    return; // 用户取消选择，静默返回
                }
                if (!data.ok || !data.path) {
                    alert(`选择文件失败：${data.error || '未知错误'}`);
                    return;
                }
                if (!/\.pdf$/i.test(data.name || '')) {
                    alert(`快捷入口只支持打开 PDF 文件：\n${data.name || data.path}`);
                    return;
                }

                // 🚀 Ctrl+点击：新标签页自己按 URL 里的路径去读这份文件。
                //    观感与下拉里的「新页打开」一致：选完文件才开页，开出来就在前台并且已经在加载；
                //    也不需要在当前窗口先下载一遍（省一份内存、少一次拷贝）。
                if (openInNewTab) {
                    const target = new URL(window.location.href);
                    target.search = '';                               // 清掉可能残留的查询串
                    target.searchParams.set('open', data.path);       // 路径由 URLSearchParams 负责编码
                    const win = window.open(target.href, '_blank');
                    if (!win) {
                        alert("未能打开新标签页：多半被浏览器的弹窗拦截拦住了。\n请在地址栏右侧允许本站弹窗后重试。");
                    }
                    return;
                }

                // 🛡️ 换文档前的未保存提醒：批注只落在本地缓存里，没有写进 PDF 就先问一句
                if (state.unsavedChanges) {
                    const proceed = confirm(
                        `当前文档「${state.fileName || '未命名'}」还有未保存到 PDF 的批注改动。\n\n` +
                        `继续打开新文件不会删除本地缓存，但要重新打开这份文档才能继续编辑它。\n\n` +
                        `确定要打开「${data.name}」吗？`
                    );
                    if (!proceed) return;
                }

                const fileResp = await fetch('/api/read-file?path=' + encodeURIComponent(data.path));
                if (!fileResp.ok) {
                    throw new Error(`读取文件失败 (HTTP ${fileResp.status})`);
                }
                const blob = await fileResp.blob();
                const file = new File([blob], data.name, { type: 'application/pdf' });

                // 带上磁盘真实路径，由 processSelectedFile 把它绑定为原位静默保存目标
                // await：PDF 真正加载完之前保持 quickFolderBusy，杜绝并发加载串味
                await processSelectedFile(file, null, false, data.path);
            } catch (err) {
                console.error("选取并打开文件异常:", err);
                alert(`未能读取或打开所选文件。\n请确保通过 starter(H).bat 启动了本地服务。\n\n错误信息：${err.message}`);
            } finally {
                quickFolderBusy = false;
            }
        }

        // 打开特定文件夹（在 Windows 资源管理器中查看）
        async function openSystemFolder(folderPath) {
            try {
                const resp = await fetch('/api/open-folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: folderPath })
                });
                const data = await resp.json();
                if (!data.ok) {
                    alert(`打开文件夹失败：${data.error || '未知错误'}`);
                }
            } catch (err) {
                console.error("呼叫后台打开文件夹失败:", err);
                alert(`未能连接后台 Python 引擎。\n请确保通过 starter(H).bat 启动了本地阅读器服务。\n\n尝试打开的路径：\n${folderPath}`);
            }
        }

        // 左键点击：唤起文件选择器选 PDF 打开；Ctrl/Cmd + 左键：在新标签页并行打开
        function handleQuickFolderClick(btnKey, e) {
            e.preventDefault();
            e.stopPropagation();
            const openInNewTab = !!(e.ctrlKey || e.metaKey);
            pickAndOpenFileFromFolder(quickFoldersConfig[btnKey].path, openInNewTab);
        }
        if (quickFolderBtn1) quickFolderBtn1.addEventListener('click', (e) => handleQuickFolderClick('btn1', e));
        if (quickFolderBtn2) quickFolderBtn2.addEventListener('click', (e) => handleQuickFolderClick('btn2', e));

        // 右键设置弹窗状态
        let currentEditingBtnKey = null; // 'btn1' 或 'btn2'

        function openQuickFolderModal(btnKey) {
            currentEditingBtnKey = btnKey;
            // loadQuickFoldersConfig 保证 btn1/btn2 一定存在，无需再兜底默认值
            const conf = quickFoldersConfig[btnKey];
            const isLeft = (btnKey === 'btn1');

            if (quickFolderModalTitle) {
                quickFolderModalTitle.textContent = isLeft 
                    ? '快捷入口设置 · 左侧按钮 (数学)' 
                    : '快捷入口设置 · 右侧按钮 (物理)';
            }
            if (quickFolderPathInput) {
                quickFolderPathInput.value = conf.path || '';
            }
            if (quickFolderLabelInput) {
                quickFolderLabelInput.value = (conf.label || (isLeft ? '数' : '物')).substring(0, 1);
            }
            if (quickFolderModal) {
                quickFolderModal.classList.remove('hidden');
            }
            setTimeout(() => {
                if (quickFolderPathInput) {
                    quickFolderPathInput.focus();
                    quickFolderPathInput.select();
                }
            }, 60);
        }

        function closeQuickFolderModal() {
            if (quickFolderModal) {
                quickFolderModal.classList.add('hidden');
            }
            currentEditingBtnKey = null;
        }

        // 绑定右键菜单
        if (quickFolderBtn1) {
            quickFolderBtn1.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openQuickFolderModal('btn1');
            });
        }
        if (quickFolderBtn2) {
            quickFolderBtn2.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openQuickFolderModal('btn2');
            });
        }

        // 弹窗内部事件
        if (closeQuickFolderBtn) closeQuickFolderBtn.addEventListener('click', closeQuickFolderModal);
        if (cancelQuickFolderBtn) cancelQuickFolderBtn.addEventListener('click', closeQuickFolderModal);

        if (quickFolderModal) {
            // 点击黑色半透明背景关闭
            quickFolderModal.addEventListener('click', (e) => {
                if (e.target === quickFolderModal) closeQuickFolderModal();
            });
        }

        // 允许在路径输入框和标签输入框内正常使用浏览器原生右键菜单（复制/粘贴）
        // Esc 关弹窗由下面的 window 级监听统一负责，此处不再重复绑定
        if (quickFolderPathInput) {
            quickFolderPathInput.addEventListener('contextmenu', (e) => e.stopPropagation());
            quickFolderPathInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleSaveQuickFolder(); }
            });
        }
        if (quickFolderLabelInput) {
            quickFolderLabelInput.addEventListener('contextmenu', (e) => e.stopPropagation());
            quickFolderLabelInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleSaveQuickFolder(); }
            });
        }

        // 弹窗中「在资源管理器中打开文件夹」按钮
        const openFolderExplorerBtn = document.getElementById('open-folder-explorer-btn');
        if (openFolderExplorerBtn) {
            openFolderExplorerBtn.addEventListener('click', () => {
                const curPath = (quickFolderPathInput ? quickFolderPathInput.value.trim() : '');
                if (curPath) {
                    openSystemFolder(curPath);
                } else if (currentEditingBtnKey && quickFoldersConfig[currentEditingBtnKey]) {
                    openSystemFolder(quickFoldersConfig[currentEditingBtnKey].path);
                }
            });
        }

        // 恢复默认按钮
        if (resetQuickFolderBtn) {
            resetQuickFolderBtn.addEventListener('click', () => {
                if (!currentEditingBtnKey) return;
                const def = DEFAULT_QUICK_FOLDERS[currentEditingBtnKey];
                if (quickFolderPathInput) quickFolderPathInput.value = def.path;
                if (quickFolderLabelInput) quickFolderLabelInput.value = def.label;
            });
        }

        // 浏览系统文件夹按钮
        if (browseQuickFolderBtn) {
            browseQuickFolderBtn.addEventListener('click', async () => {
                const currentVal = (quickFolderPathInput ? quickFolderPathInput.value.trim() : '');
                const idleHtml = browseQuickFolderBtn.innerHTML; // 记下常态图标，选完原样还原
                try {
                    browseQuickFolderBtn.disabled = true;
                    browseQuickFolderBtn.innerHTML = '<i class="ph ph-spinner text-xs animate-spin"></i> <span>选择中</span>';
                    const resp = await fetch('/api/pick-folder', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ initial_dir: currentVal })
                    });
                    const data = await resp.json();
                    if (data.ok && data.path) {
                        if (quickFolderPathInput) quickFolderPathInput.value = data.path;
                        // 智能推断 1 个字的简称
                        const parsed = parseFolderPath(data.path);
                        if (quickFolderLabelInput && parsed.label) {
                            quickFolderLabelInput.value = parsed.label;
                        }
                    } else if (!data.cancelled) {
                        alert(`选择文件夹失败：${data.error || '未知错误'}`);
                    }
                } catch (err) {
                    console.warn("调用后台文件夹选择器失败:", err);
                    alert("无法调起本地窗口，请直接在此输入或粘贴文件夹路径。");
                } finally {
                    browseQuickFolderBtn.disabled = false;
                    browseQuickFolderBtn.innerHTML = idleHtml;
                }
            });
        }

        // 探测文件夹是否存在（返回 null 表示探测失败/离线，此时不阻断保存）
        async function checkFolderExists(pathStr) {
            try {
                const resp = await fetch('/api/check-folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: pathStr })
                });
                const data = await resp.json();
                return data.ok ? !!data.exists : null;
            } catch (_) {
                return null;
            }
        }

        // 保存设置
        async function handleSaveQuickFolder() {
            if (!currentEditingBtnKey) return;
            const newPath = (quickFolderPathInput ? quickFolderPathInput.value.trim() : '');
            if (!newPath) {
                alert("请输入有效的文件夹路径！");
                if (quickFolderPathInput) quickFolderPathInput.focus();
                return;
            }

            const parsed = parseFolderPath(newPath);
            // 简称统一 1 个字（按钮宽度只有 19px）
            let newLabel = (quickFolderLabelInput ? quickFolderLabelInput.value.trim() : '').substring(0, 1);
            if (!newLabel) {
                newLabel = parsed.label || (currentEditingBtnKey === 'btn1' ? '数' : '物');
            }

            // 路径不存在先提醒（防止打错字后一路静默失败）；用户确认后仍可保存，
            // 兼顾移动硬盘/网络盘暂时未挂载的情况
            const exists = await checkFolderExists(newPath);
            if (exists === false && !confirm(`该文件夹当前不存在：\n${newPath}\n\n仍要保存这个路径吗？`)) {
                if (quickFolderPathInput) quickFolderPathInput.focus();
                return;
            }

            quickFoldersConfig[currentEditingBtnKey] = {
                path: newPath,
                label: newLabel,
                name: parsed.name || newLabel
            };

            saveQuickFoldersConfig(quickFoldersConfig);
            updateQuickFolderButtonsUI();
            closeQuickFolderModal();
        }

        if (saveQuickFolderBtn) {
            saveQuickFolderBtn.addEventListener('click', handleSaveQuickFolder);
        }

        // 全局键盘监听 Esc 关闭快捷文件夹弹窗
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && quickFolderModal && !quickFolderModal.classList.contains('hidden')) {
                closeQuickFolderModal();
            }
        });

        // 复制文档标题
        if (els.copyDocTitleBtn) {
            els.copyDocTitleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const nameToCopy = state.fileName || (els.docTitle && els.docTitle.textContent !== '未打开文档' ? els.docTitle.textContent : '');
                if (!nameToCopy) return;
                navigator.clipboard.writeText(nameToCopy).then(() => {
                    const icon = els.copyDocTitleBtn.querySelector('i');
                    if (icon) {
                        icon.className = 'ph ph-check text-green-600 text-[14px]';
                        setTimeout(() => { icon.className = 'ph ph-copy text-[14px]'; }, 1500);
                    }
                }).catch(() => {});
            });
        }

        // 旧版 input 选择器 fallback（仅当 showOpenFilePicker 不存在或抛错时才会走到）
        els.fileInput.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            // 取走 triggerFileSelect 在点开对话框前留下的「新窗口打开」意图，用完立刻复位
            const openInNewWindow = isOpeningInNewWindow;
            isOpeningInNewWindow = false;
            processSelectedFile(file, null, openInNewWindow);
            els.fileInput.value = ''; // 清空选择，允许下次继续选中同一文件
        });

        async function loadPDFFromFile(file) {
            if (file.type !== 'application/pdf') { alert('请选择 PDF 文件'); return; }

            // 🛡️ 加载序号令牌：三个入口（快捷 / 主按钮 / 新页打开的接收端）理论上可能并发触发，
            //    后一次加载会 revoke 前一次的 blobUrl、并交错写 pdfDoc / pageDimensions / 骨架。
            //    每个 await 之后比对令牌，过期的那次就地退出（并把它的 PDFDocument 释放掉）。
            const loadToken = ++state.loadToken;
            const isStale = () => state.loadToken !== loadToken;

            state.fileName = file.name;
            state.rawFile = file; // 挂载物理文件引用
            state.pdfData = null; // 抹除阻塞的全局大内存占用
            
            try {
                // 1. 回收旧虫洞
                if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
                
                // 【新增】物理清零容器的滚动状态，清除上一个文件留下的“残影”
                els.container.scrollTop = 0;
                
                // 2. 🚀 开启新虫洞：生成极轻量级的 Blob 虚拟指针 (O(1) 耗时，直接跳过 GB 级内存复制)
                state.blobUrl = URL.createObjectURL(file);
                                
                const cmapsAbsoluteUrl = new URL('./lib/cmaps/', window.location.href).href;
                const standardFontsAbsoluteUrl = new URL('./lib/standard_fonts/', window.location.href).href;

                // 核心：直接把 URL 喂给 PDF.js，启动原生的底部分块流式读取 (Range Requests)
                const loadingTask = pdfjsLib.getDocument({
                    url: state.blobUrl, 
                    cMapUrl: cmapsAbsoluteUrl,                
                    cMapPacked: true,
                    standardFontDataUrl: standardFontsAbsoluteUrl, 
                    fontExtraProperties: true
                });
                state.pdfDoc = await loadingTask.promise;

                // 过期令牌：说明用户又开了另一份，主动释放本次的 worker 文档后退出
                if (isStale()) {
                    try { await state.pdfDoc.destroy(); } catch (_) {}
                    return;
                }
                
                // 3. 🚀 同构尺寸坍缩假设 (O(1) 替代 O(N))
                // 智能嗅探基准尺寸：如果>=3页读取第3页；否则读取最后1页 (避开封面异形)
                const numPages = state.pdfDoc.numPages;
                const basePageNum = numPages >= 3 ? 3 : numPages;
                const basePage = await state.pdfDoc.getPage(basePageNum);
                if (isStale()) return;
                const baseVp = basePage.getViewport({ scale: 1 });
                
                // 瞬间将基础尺寸灌满整个千页/万页数组！
                state.pageDimensions = Array.from({ length: numPages }, () => ({ width: baseVp.width, height: baseVp.height }));

                // UI 状态就绪
                els.docTitle.textContent = file.name;
                els.docTitle.title = file.name;
                updateDocMeta(); // 刷新标题颜色与悬浮提示（此处文件名已就位，提示里能带上正确的名字）
                els.emptyState.classList.add('hidden');
                els.saveStatusBtn.disabled = false;
                state.pagesRendered.clear();
                
                state.pageOffset = 0;
                state.currentPhysicalPage = -1;
                els.hudTotal.textContent = numPages;
                els.pageHud.classList.remove('opacity-0', 'pointer-events-none');
                els.pageHud.classList.add('opacity-100', 'pointer-events-auto');
                
                // 确保重置按钮隐藏，定位按钮显示
                els.resetOffsetBtn.classList.add('hidden');
                els.resetOffsetBtn.classList.remove('flex');
                els.setOffsetBtn.classList.remove('hidden');
                els.setOffsetBtn.classList.add('flex');
                
                // 立即计算一次
                setTimeout(updateHUDAndOutline, 100);

                // 解析顶层目录
                const outline = await state.pdfDoc.getOutline();
                if (isStale()) return;
                if (outline && outline.length > 0) {
                    renderOutline(outline);
                    els.outlineTriggerBtn.classList.remove('hidden');
                } else {
                    els.outlineTriggerBtn.classList.add('hidden');    
                    toggleOutline(false);                             
                }

                // 4. 瞬间生成 DOM 物理骨架（true = 强制重建：换文档时必须丢弃上一份的
                //    canvas 位图与 observer 订阅，否则页数相同的两份 PDF 会残留旧图像）
                generatePageSkeletons(true);
                updateSaveStatus(false);
                
                // 5. 🚀 斩断串行锁链：首屏渲染完毕后，立刻启动异步尾流去提取大批注！
                // 不使用 await，让它在后台静默运行
                // ⚠️ pdf.js 3.11 的 PDFDocumentProxy 只有 fingerprints（数组），没有 fingerprint。
                //    取 [0]（前 1KB 的 MD5），否则指纹恒为 undefined，IndexedDB 缓存/指纹校验全部静默失效。
                runAsyncWakeUpTail(file, (state.pdfDoc.fingerprints || [])[0] || '');

            } catch (err) {
                // 已被后一次加载取代时，本次 blobUrl 被回收导致的失败属预期，静默退出不打扰用户
                if (isStale()) return;
                console.error(err);
                alert("无法打开 PDF 文件");
            }
        }

