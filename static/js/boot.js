        function recordJumpPosition() {
            if (state.pageDimensions.length === 0 || !state.pdfDoc) return;

            const container = els.container;
            const viewportHeight = container.clientHeight;
            const centerY = container.scrollTop + (viewportHeight / 2);
            const offset = centerY - els.pagesContainer.offsetTop;
            const currentCenterPage = pdfPageAtOffset(offset);
            const pageTopY = pdfPageTop(currentCenterPage);
            const currentPageHeight = state.pageDimensions[currentCenterPage - 1].height * state.scale + PDF_PAGE_GAP;

            // 计算屏幕中央在该页内部的相对比例
            const ratioY = (offset - pageTopY) / currentPageHeight;

            state.lastScrollPosition = {
                pageNum: currentCenterPage,
                ratioY: ratioY
            };

            els.backJumpBtn.classList.remove('translate-y-24', 'opacity-0', 'pointer-events-none');
            els.backJumpBtn.classList.add('translate-y-0', 'opacity-100', 'pointer-events-auto', 'shadow-2xl', 'hover:scale-110');
        }

        els.backJumpBtn.addEventListener('click', () => {
            if (state.lastScrollPosition !== null && state.pageDimensions.length > 0) {
                const container = els.container;
                const { pageNum, ratioY } = state.lastScrollPosition;
                if (pageNum > state.pageDimensions.length) return;
                const targetPageTopY = pdfPageTop(pageNum);
                
                // 获取目标页面的真实高度
                const currentPageHeight = state.pageDimensions[pageNum - 1].height * state.scale + PDF_PAGE_GAP;
                
                // 还原目标中心点的绝对坐标
                const targetCenterY = targetPageTopY + (currentPageHeight * ratioY);
                
                // 减去半个屏幕高度，算出最终的 scrollTop
                const targetScrollTop = els.pagesContainer.offsetTop + targetCenterY - container.clientHeight / 2;
                
                // 瞬间滑动回去
                container.scrollTop = targetScrollTop;
                
                // 重置状态并隐藏按钮
                state.lastScrollPosition = null;
                els.backJumpBtn.classList.add('translate-y-24', 'opacity-0', 'pointer-events-none');
                els.backJumpBtn.classList.remove('translate-y-0', 'opacity-100', 'pointer-events-auto', 'shadow-2xl', 'hover:scale-110');
            }
        });

        
        const exportAnnoBtn = document.getElementById('export-anno-btn');
        const importAnnoBtn = document.getElementById('import-anno-btn');
        const importAnnoInput = document.getElementById('import-anno-input');

        // =====================================================================
        // 📥 批注回灌的唯一入口：本地「导入批注」与云端「取回批注」都走这里，
        //    指纹校验、合并/覆盖策略、撤销栈包装全部共用一套逻辑。
        //    options.mode  ：'ask'（默认，弹确认框）| 'merge' | 'overwrite'
        //    options.source：仅用于日志/提示的来源说明
        //    返回 true = 已应用；false = 用户取消或数据非法
        // =====================================================================
        function importAnnotationBundle(importedData, options = {}) {
            if (!state.pdfDoc) {
                alert("请先打开一个 PDF 文件，再导入批注！");
                return false;
            }
            // 校验是否是合法的批注文件
            if (!importedData || importedData.app !== "PDFReaderPro" || !isAnnotationTable(importedData.annotations)) {
                alert("无效的批注文件格式，解析失败！");
                return false;
            }

            // 核心防错：比对 PDF 指纹
            if (importedData.fingerprint !== state.fingerprint) {
                const confirmImport = confirm(`⚠️ 警告：指纹校验不匹配！\n\n此批注文件似乎属于另一个 PDF：\n[ ${importedData.fileName || '未知文件'} ]\n当前打开的 PDF：\n[ ${state.fileName} ]\n\n如果它们是同一篇文档的不同版本，您可以强制导入，但坐标可能会发生错位。\n\n是否继续强制导入？`);
                if (!confirmImport) return false;
            }

            let mode = options.mode || 'ask';
            if (mode === 'ask') {
                mode = confirm("📥 导入选项：\n\n[确定] - 与当前页面已有的批注【合并】\n[取消] - 清空当前页面所有批注，完全【覆盖】")
                    ? 'merge' : 'overwrite';
            }

            const incoming = importedData.annotations;
            if (!els.noteModal.classList.contains('hidden')) {
                if (state.isEditingNote) commitNoteEdit();
                window.FormulaInput?.reset();
                endCursorTracking();
                els.noteModal.classList.add('hidden');
                state.activeAnnotationId = null;
                state.originalAnnoSnapshot = null;
            }

            // 🚀 包装进 performAction：支持 Ctrl+Z 完美一键撤销！
            performAction(() => {
                if (mode === 'merge') {
                    // 智能合并：遍历导入的每一页
                    Object.keys(incoming).forEach(pageNum => {
                        // settings 是「本机阅读状态」（上次读到第几页 / 页码偏移），不是批注，一律不动
                        if (pageNum === 'settings' || !Array.isArray(incoming[pageNum])) return;
                        if (!state.annotations[pageNum]) state.annotations[pageNum] = [];

                        // 根据 ID 去重，防止同一个批注被导入两次
                        const existingIds = new Set(state.annotations[pageNum].map(a => a.id));
                        const newAnnos = incoming[pageNum].filter(a => {
                            if (existingIds.has(a.id)) return false;
                            existingIds.add(a.id);
                            return true;
                        });

                        state.annotations[pageNum].push(...newAnnos);
                    });
                    if (incoming.mindmap) {
                        state.annotations['mindmap'] = incoming.mindmap;
                    }
                } else {
                    // 暴力覆盖：批注整表替换，但保留本机的 settings（阅读位置属于本机状态）
                    const localSettings = state.annotations['settings'];
                    const replaced = {};
                    Object.keys(incoming).forEach(pageNum => { if (pageNum !== 'settings') replaced[pageNum] = incoming[pageNum]; });
                    if (localSettings) replaced['settings'] = localSettings;
                    state.annotations = replaced;
                }
            });

            window.MindMap?.render?.();
            console.log(`批注已导入（${mode === 'merge' ? '合并' : '覆盖'}）来源：${options.source || '本地文件'}`);
            return true;
        }

        // 1. 导出批注逻辑
        exportAnnoBtn.addEventListener('click', () => {
            if (!state.pdfDoc || Object.keys(state.annotations).length === 0) {
                alert("当前没有可导出的批注数据！");
                return;
            }

            // 构造标准化的导出数据结构
            const exportData = {
                app: "PDFReaderPro",
                version: "5.0.0",
                fingerprint: state.fingerprint,  // 绑定 PDF 指纹防错
                fileName: state.fileName,        // 记录原文件名
                timestamp: new Date().toISOString(),
                annotations: state.annotations   // 核心批注数据
            };

            // 转化为 JSON Blob
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            
            // 触发下载
            const a = document.createElement('a');
            a.href = url;
            // 去除原 PDF 后缀，加上 _annotations.json
            const baseName = state.fileName ? state.fileName.replace(/\.[^/.]+$/, "") : "document";
            a.download = `${baseName}_annotations.json`;
            a.click();
            URL.revokeObjectURL(url);
        });

        // 2. 触发导入弹窗
        importAnnoBtn.addEventListener('click', () => {
            if (!state.pdfDoc) {
                alert("请先打开一个 PDF 文件，再导入批注！");
                return;
            }
            importAnnoInput.click();
        });

        // 3. 处理导入的文件
        let annotationImportGeneration = 0;
        importAnnoInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const token = state.loadToken, generation = ++annotationImportGeneration;
            const isCurrent = () => state.loadToken === token && generation === annotationImportGeneration;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    if (!isCurrent()) return;
                    importAnnotationBundle(JSON.parse(event.target.result), { source: file.name });
                } catch (err) {
                    console.error("导入批注失败:", err);
                    alert("导入失败：" + err.message);
                } finally {
                    importAnnoInput.value = ''; // 释放 input，允许用户重复导入同一个文件
                }
            };
            reader.onerror = () => {
                if (isCurrent()) alert('导入失败：无法读取批注文件。');
                importAnnoInput.value = '';
            };
            
            reader.readAsText(file);
        });

        // =========================================================================
        // 🛡️ 全局防跳出与系统误触护盾 (Anti-Navigation Shield) - 兼容鼠标宏定制版
        // =========================================================================

        // 1. 拦截触控板手势、鼠标原生后退指令 (历史记录劫持陷阱)
        history.pushState(null, null, location.href);
        window.addEventListener('popstate', function () {
            history.pushState(null, null, location.href);
            console.log("🛡️ 已拦截意外的页面跳转行为，保护工作进度。");
        });

        // 2. 拦截拖拽覆盖 (防止手滑把 PDF 拖到网页空白处，导致浏览器直接打开该 PDF 从而顶掉当前工作站)
        window.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'none'; 
        });
        window.addEventListener('drop', (e) => {
            e.preventDefault();
        });

        // 3. 拦截右键拖动 (封杀 Edge/浏览器的“右键鼠标手势”返回上一页)
        window.addEventListener('mousedown', (e) => {
            if (e.button === 2) { // 2 代表鼠标右键
                // 阻止浏览器捕捉右键拖拽作为系统手势（如画出蓝色轨迹线）
                e.preventDefault(); 
            }
        });
        
        // 顺手屏蔽网页原生的右键菜单，防止按右键时弹出一大块菜单挡住视线
        window.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        // 4. 封杀浏览器 bfcache 缓存回跳：从缓存恢复页面时强制重置滚动，
        //    改由应用自身恢复上次阅读位置（配合 init 中的 scrollRestoration = 'manual'）
        window.addEventListener('pageshow', (e) => {
            if (e.persisted) {
                if (els.container) els.container.scrollTop = 0;
                if (typeof restoreLastPage === 'function') setTimeout(restoreLastPage, 0);
            }
        });
