        // 共享搜索状态先初始化；后续可选控件的绑定不得阻断文档打开时的清理。
        const SEARCH_ROW_HEIGHT = 104;
        let searchSidebarView = null;
        let searchSidebarFrame = 0;
        let outlineMapSortFrame = 0;
        let outlineMapNeedsSort = false;
        let activeOutlineElement = null;
        let outlineDestQueue = [];
        let outlineDestPumping = false;
        let currentTimeIntervalId = null;
        const OUTLINE_DEST_BATCH_SIZE = 12;

        function pumpOutlineDestQueue() {
            if (outlineDestPumping || outlineDestQueue.length === 0) return;
            outlineDestPumping = true;
            setTimeout(async () => {
                try {
                    const batch = outlineDestQueue.splice(0, OUTLINE_DEST_BATCH_SIZE);
                    await Promise.all(batch.map(async ({ pdfDoc, loadToken, dest, titleDiv, order }) => {
                        if (state.loadToken !== loadToken || state.pdfDoc !== pdfDoc) return;
                        try {
                            const pageIndex = await resolvePdfDestinationPage(pdfDoc, dest);
                            if (pageIndex === null || state.loadToken !== loadToken || state.pdfDoc !== pdfDoc) return;
                            const physicalPage = pageIndex + 1;
                            titleDiv.dataset.targetPage = physicalPage;
                            state.outlineMap.push({
                                pageNum: physicalPage,
                                element: titleDiv,
                                order
                            });
                            outlineMapNeedsSort = true;
                            if (!outlineMapSortFrame) {
                                outlineMapSortFrame = requestAnimationFrame(() => {
                                    outlineMapSortFrame = 0;
                                    if (state.loadToken !== loadToken || state.pdfDoc !== pdfDoc) return;
                                    updateCurrentOutline();
                                });
                            }
                        } catch (_) { /* 解析失败忽略 */ }
                    }));
                } finally {
                    outlineDestPumping = false;
                    if (outlineDestQueue.length > 0) pumpOutlineDestQueue();
                }
            }, 0);
        }

        function flushOutlineMapSort() {
            if (outlineMapSortFrame) {
                cancelAnimationFrame(outlineMapSortFrame);
                outlineMapSortFrame = 0;
            }
            if (!outlineMapNeedsSort) return;
            outlineMapNeedsSort = false;
            state.outlineMap.sort((a, b) => a.pageNum - b.pageNum || a.order - b.order);
        }

        // =========================================================================
        // =========================================================================
        
        // 1. 递归渲染多层级目录，并自动挂载跳跃引擎
        async function renderOutline(outlineData, container = els.outlineContent, level = 0, pdfDoc = state.pdfDoc, loadToken = state.loadToken) {
            const isStale = () => state.loadToken !== loadToken || state.pdfDoc !== pdfDoc;
            if (isStale()) return;
            if (level === 0) {
                container.innerHTML = '';
                state.outlineMap = []; // 清空旧地图
                state.outlineNextOrder = 0;
                outlineDestQueue = [];
                cancelAnimationFrame(outlineMapSortFrame);
                outlineMapSortFrame = 0;
                outlineMapNeedsSort = false;
                activeOutlineElement = null;
            }

            const ul = document.createElement('ul');
            ul.className = level === 0 ? 'space-y-0.5' : 'ml-3 mt-0.5 space-y-0.5 border-l border-gray-200 pl-2';

            for (const item of outlineData) {
                if (isStale()) return;
                const li = document.createElement('li');
                const titleDiv = document.createElement('div');
                titleDiv.className = 'outline-item py-1 px-2 hover:bg-blue-50 hover:text-blue-600 rounded cursor-pointer transition-colors flex items-center justify-between group';
                
                const textSpan = document.createElement('span');
                textSpan.className = 'truncate leading-relaxed flex-1 group-hover:text-blue-600 transition-colors'; 
                if (level === 0) textSpan.classList.add('font-bold', 'text-gray-900');
                else textSpan.classList.add('text-gray-700'); 
                
                textSpan.textContent = item.title;
                textSpan.title = item.title;
                titleDiv.appendChild(textSpan);

                if (item.dest) {
                    const order = state.outlineNextOrder++;
                    // 分批让出主线程解析目标页，避免上千条目录同时创建数百个宏任务阻塞首屏与 PDF Worker。
                    outlineDestQueue.push({ pdfDoc, loadToken, dest: item.dest, titleDiv, order });
                    pumpOutlineDestQueue();
                }

                titleDiv.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (item.dest) {
                        navigateToDestination(item.dest);
                        toggleOutline(false);
                    }
                });

                li.appendChild(titleDiv);

                if (item.items && item.items.length > 0) {
                    const indicator = document.createElement('div');
                    indicator.className = 'w-1.5 h-1.5 bg-gray-300 rounded-full mr-2 shrink-0 group-hover:bg-blue-400 transition-colors';
                    titleDiv.insertBefore(indicator, textSpan);
                    
                    await renderOutline(item.items, li, level + 1, pdfDoc, loadToken); // 递归
                } else if (level === 0) {
                    textSpan.classList.add('ml-3.5');
                }
                ul.appendChild(li);
            }
            if (!isStale()) container.appendChild(ul);
        }

        // 当前页属于起始页不晚于它的最后一个目录条目，兼容没有独立目录项的页。
        function updateCurrentOutline(scroll = false, block = 'nearest') {
            flushOutlineMapSort();
            let activeItem = null;
            let low = 0, high = state.outlineMap.length;
            while (low < high) {
                const mid = (low + high) >>> 1;
                if (state.outlineMap[mid].pageNum <= state.currentPhysicalPage) low = mid + 1;
                else high = mid;
            }
            if (low) activeItem = state.outlineMap[low - 1].element;
            if (activeOutlineElement !== activeItem) activeOutlineElement?.classList.remove('active-outline');
            activeOutlineElement = activeItem;
            if (!activeItem) return;
            activeItem.classList.add('active-outline');
            if (!scroll || !state.isOutlineOpen) return;

            // 只滚动目录列表，避免影响正文阅读位置或目录标题栏。
            const content = els.outlineContent;
            const contentRect = content.getBoundingClientRect();
            const itemRect = activeItem.getBoundingClientRect();
            let delta = 0;
            if (block === 'center') {
                delta = itemRect.top + itemRect.height / 2 - contentRect.top - content.clientHeight / 2;
            } else if (itemRect.top < contentRect.top) {
                delta = itemRect.top - contentRect.top;
            } else if (itemRect.bottom > contentRect.top + content.clientHeight) {
                delta = itemRect.bottom - contentRect.top - content.clientHeight;
            }
            content.scrollTo({ top: content.scrollTop + delta, behavior: 'smooth' });
        }

        const locateCurrentOutlineButton = document.getElementById('outline-locate-current-page');
        // 浏览器可能仍持有更新前的 HTML；缺少新增按钮时保留目录和搜索核心功能。
        locateCurrentOutlineButton?.addEventListener('keydown', (event) => {
            // 空格仍可激活按钮，不触发阅读器的抓手/保存快捷键。
            if (event.code === 'Space') event.stopPropagation();
        });
        locateCurrentOutlineButton?.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!state.pdfDoc) return;
            updateHUDAndOutline();
            updateCurrentOutline(true, 'center');
        });

        // 2. 状态开关与丝滑面板动画
        function toggleOutline(forceState = null) {
            state.isOutlineOpen = forceState !== null ? forceState : !state.isOutlineOpen;
            const icon = els.outlineTriggerBtn.querySelector('i');
            const panel = els.outlinePanel;
            
            if (state.isOutlineOpen) {
                if (state.isTimePanelOpen && typeof toggleTimePanel === 'function') {
                    toggleTimePanel(false);
                }
                // 丝滑展开：解除隐身，恢复原生尺寸与位置，允许点击
                panel.classList.remove('opacity-0', 'invisible', 'scale-y-95', '-translate-y-2', '-translate-y-3', 'pointer-events-none');
                panel.classList.add('opacity-100', 'visible', 'scale-y-100', 'translate-y-0', 'pointer-events-auto');
                // 图标优雅翻转
                icon.classList.add('rotate-180');
            } else {
                // 丝滑收起：开启隐身，轻微上浮并微缩，阻断点击
                panel.classList.remove('opacity-100', 'visible', 'scale-y-100', 'translate-y-0', 'pointer-events-auto');
                panel.classList.add('opacity-0', 'invisible', 'scale-y-95', '-translate-y-3', 'pointer-events-none');
                // 图标复位
                icon.classList.remove('rotate-180');
            }
        }

        // 3. 独立绑定把手与关闭按钮的点击事件
        els.outlineTriggerBtn.addEventListener('click', (e) => { 
            e.stopPropagation(); 
            toggleOutline(); 
        });
        els.closeOutlineBtn.addEventListener('click', (e) => { 
            e.stopPropagation(); 
            toggleOutline(false); 
        });

        // 4. 时间与倒计时下拉面板
        function updateCurrentTimeDisplay() {
            if (!els.currentTimeDisplay) return;
            const now = new Date();
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const ss = String(now.getSeconds()).padStart(2, '0');
            els.currentTimeDisplay.textContent = `${hh}:${mm}:${ss}`;
        }

        function toggleTimePanel(forceState = null) {
            if (!els.timePanel || !els.timeTriggerBtn) return;
            state.isTimePanelOpen = forceState !== null ? forceState : !state.isTimePanelOpen;
            const icon = els.timeTriggerBtn.querySelector('svg, i');
            const panel = els.timePanel;
            els.timeTriggerBtn.setAttribute('aria-expanded', String(state.isTimePanelOpen));

            if (state.isTimePanelOpen) {
                if (state.isOutlineOpen) toggleOutline(false);
                updateCurrentTimeDisplay();
                if (currentTimeIntervalId === null) {
                    currentTimeIntervalId = setInterval(updateCurrentTimeDisplay, 1000);
                }
                panel.classList.remove('opacity-0', 'invisible', 'scale-y-95', '-translate-y-2', '-translate-y-3', 'pointer-events-none');
                panel.classList.add('opacity-100', 'visible', 'scale-y-100', 'translate-y-0', 'pointer-events-auto');
                icon?.classList.add('rotate-180');
            } else {
                if (currentTimeIntervalId !== null) {
                    clearInterval(currentTimeIntervalId);
                    currentTimeIntervalId = null;
                }
                panel.classList.remove('opacity-100', 'visible', 'scale-y-100', 'translate-y-0', 'pointer-events-auto');
                panel.classList.add('opacity-0', 'invisible', 'scale-y-95', '-translate-y-3', 'pointer-events-none');
                icon?.classList.remove('rotate-180');
            }
        }

        (function initTimeAndCountdown() {
            if (!els.timeTriggerBtn || !els.timePanel) return;

            updateCurrentTimeDisplay();
            if (state.isTimePanelOpen && currentTimeIntervalId === null) {
                currentTimeIntervalId = setInterval(updateCurrentTimeDisplay, 1000);
            }

            let countdownTimerId = null;
            let countdownEndTime = 0;
            let countdownRemainingSec = 25 * 60;
            let countdownRunning = false;

            function formatCountdown(totalSec) {
                const sec = Math.max(0, Math.ceil(totalSec));
                const h = Math.floor(sec / 3600);
                const m = Math.floor((sec % 3600) / 60);
                const s = sec % 60;
                if (h > 0) {
                    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
                }
                return [m, s].map(v => String(v).padStart(2, '0')).join(':');
            }

            function readConfiguredCountdownSec() {
                const minVal = Math.max(0, Math.min(999, parseInt(els.countdownMinInput?.value, 10) || 0));
                const secVal = Math.max(0, Math.min(59, parseInt(els.countdownSecInput?.value, 10) || 0));
                return minVal * 60 + secVal;
            }

            function renderCountdownDisplay(isFinished = false) {
                if (!els.countdownDisplay) return;
                els.countdownDisplay.textContent = isFinished ? '00:00' : formatCountdown(countdownRemainingSec);
                els.countdownDisplay.classList.toggle('text-red-500', isFinished);
                els.countdownDisplay.classList.toggle('text-blue-600', !isFinished);
            }

            function syncCountdownFromInputs() {
                if (countdownRunning) return;
                countdownRemainingSec = readConfiguredCountdownSec();
                renderCountdownDisplay(false);
                if (els.countdownStartBtn) els.countdownStartBtn.textContent = '开始';
            }

            function tickCountdown() {
                const leftMs = countdownEndTime - Date.now();
                if (leftMs <= 0) {
                    clearInterval(countdownTimerId);
                    countdownTimerId = null;
                    countdownRunning = false;
                    countdownRemainingSec = 0;
                    if (els.countdownMinInput) els.countdownMinInput.disabled = false;
                    if (els.countdownSecInput) els.countdownSecInput.disabled = false;
                    if (els.countdownStartBtn) els.countdownStartBtn.textContent = '开始';
                    renderCountdownDisplay(true);
                    if (!state.isTimePanelOpen) toggleTimePanel(true);
                    return;
                }
                countdownRemainingSec = Math.ceil(leftMs / 1000);
                renderCountdownDisplay(false);
            }

            function toggleCountdownStartPause() {
                if (countdownRunning) {
                    clearInterval(countdownTimerId);
                    countdownTimerId = null;
                    countdownRunning = false;
                    countdownRemainingSec = Math.max(0, Math.ceil((countdownEndTime - Date.now()) / 1000));
                    if (els.countdownMinInput) els.countdownMinInput.disabled = false;
                    if (els.countdownSecInput) els.countdownSecInput.disabled = false;
                    if (els.countdownStartBtn) els.countdownStartBtn.textContent = countdownRemainingSec > 0 ? '继续' : '开始';
                    renderCountdownDisplay(false);
                } else {
                    if (countdownRemainingSec <= 0) {
                        countdownRemainingSec = readConfiguredCountdownSec();
                    }
                    if (countdownRemainingSec <= 0) return;
                    countdownRunning = true;
                    countdownEndTime = Date.now() + countdownRemainingSec * 1000;
                    if (els.countdownMinInput) els.countdownMinInput.disabled = true;
                    if (els.countdownSecInput) els.countdownSecInput.disabled = true;
                    if (els.countdownStartBtn) els.countdownStartBtn.textContent = '暂停';
                    renderCountdownDisplay(false);
                    clearInterval(countdownTimerId);
                    countdownTimerId = setInterval(tickCountdown, 250);
                }
            }

            function resetCountdown() {
                clearInterval(countdownTimerId);
                countdownTimerId = null;
                countdownRunning = false;
                if (els.countdownMinInput) els.countdownMinInput.disabled = false;
                if (els.countdownSecInput) els.countdownSecInput.disabled = false;
                countdownRemainingSec = readConfiguredCountdownSec();
                if (els.countdownStartBtn) els.countdownStartBtn.textContent = '开始';
                renderCountdownDisplay(false);
            }

            els.timeTriggerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleTimePanel();
            });
            els.closeTimeBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleTimePanel(false);
            });
            els.timePanel.addEventListener('click', (e) => e.stopPropagation());
            els.timePanel.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && (e.target === els.countdownMinInput || e.target === els.countdownSecInput)) {
                    e.preventDefault();
                    countdownRemainingSec = readConfiguredCountdownSec();
                    if (!countdownRunning) toggleCountdownStartPause();
                }
            });
            els.countdownMinInput?.addEventListener('input', syncCountdownFromInputs);
            els.countdownSecInput?.addEventListener('input', syncCountdownFromInputs);
            els.countdownStartBtn?.addEventListener('click', toggleCountdownStartPause);
            els.countdownResetBtn?.addEventListener('click', resetCountdown);

            syncCountdownFromInputs();
        })();

        function performAction(actionFn, affectedPages = null) {
            // 普通编辑显式提供受影响的页；导入等整表操作保留完整比较。
            const affectedKeys = affectedPages && [...new Set(affectedPages.map(String))];
            // 页内锚点随撤销快照保存，避免撤销/重做时按新的缩放重新猜测旧终点。
            normalizeArrowAnchors(state.annotations, affectedKeys);
            const cleanSlice = (val) => (Array.isArray(val) && typeof stripTransientAnnotationFields === 'function')
                ? val.map(stripTransientAnnotationFields)
                : val;
            // 1. 只为受影响的页创建撤销快照。
            const beforeState = {};
            (affectedKeys || Object.keys(state.annotations)).forEach(k => {
                beforeState[k] = JSON.stringify(cleanSlice(state.annotations[k]));
            });

            // 2. 执行工具动作
            actionFn(); 
            normalizeArrowAnchors(state.annotations, affectedKeys);

            // 3. 执行后：比对状态，提取纯净 Delta (差异包)
            const afterState = {};
            (affectedKeys || Object.keys(state.annotations)).forEach(k => {
                afterState[k] = JSON.stringify(cleanSlice(state.annotations[k]));
            });

            const backward = {};
            const forward = {};
            let changed = false;

            const allKeys = new Set([...Object.keys(beforeState), ...Object.keys(afterState)]);
            allKeys.forEach(k => {
                if (beforeState[k] !== afterState[k]) {
                    const fallback = (k === 'mindmap' || k === 'settings') ? 'null' : '[]';
                    backward[k] = beforeState[k] || fallback;
                    forward[k] = afterState[k] || fallback;
                    changed = true;
                }
            });

            // 4. 后续撤销记录只保存变更页的前后状态。
            if (changed) {
                if (state.historyIndex < state.history.length - 1) {
                    state.history = state.history.slice(0, state.historyIndex + 1);
                }
                state.history.push({ type: 'DELTA', backward, forward });
                state.historyIndex++;
                if (state.history.length > 50 && !state.annotationsLoading) {
                    state.history.shift();
                    state.historyIndex--;
                }
            }

            if (changed) {
                updateSaveStatus(true);
                saveAnnotationsToStorage();
            }
            refreshUI(affectedKeys || (changed ? Object.keys(forward) : null)); 
        }

        function toggleSearch() {
            if (els.searchBar.classList.contains('hidden')) {
                els.searchBar.classList.remove('hidden');
                els.searchInput.focus();
            } else {
                els.searchBar.classList.add('hidden');
                clearSearchHighlights();
                if (state.searchAbortController) state.searchAbortController.abort();
                setSidebarMode('annotations'); 
            }
        }

        function setSidebarMode(mode) {
            state.sidebarMode = mode;
            const annoSearchContainer = document.getElementById('anno-search-input')?.parentElement?.parentElement;
            const tabAnnosEl = document.getElementById('tab-annos');
            const tabSnippetsEl = document.getElementById('tab-snippets');

            if (mode === 'annotations') {
                if (tabAnnosEl) tabAnnosEl.className = 'cursor-pointer text-blue-600 font-bold';
                if (tabSnippetsEl) tabSnippetsEl.className = 'cursor-pointer text-gray-400 hover:text-orange-500 transition-colors';
                annoSearchContainer?.classList.remove('hidden');
                updateSidebar();
            } else if (mode === 'snippets') {
                if (tabAnnosEl) tabAnnosEl.className = 'cursor-pointer text-gray-400 hover:text-blue-600 transition-colors';
                if (tabSnippetsEl) tabSnippetsEl.className = 'cursor-pointer text-orange-500 font-bold';
                annoSearchContainer?.classList.add('hidden');
                if (typeof renderSnippetsSidebar === 'function') renderSnippetsSidebar();
            } else if (mode === 'search') {
                if (tabAnnosEl) tabAnnosEl.className = 'cursor-pointer text-gray-400';
                if (tabSnippetsEl) tabSnippetsEl.className = 'cursor-pointer text-gray-400 hover:text-orange-500 transition-colors';
                annoSearchContainer?.classList.add('hidden');
                if (!state.sidebarOpen) els.toggleSidebarBtn.click();
                renderSearchSidebar();
            }
        }

        // =========================================================================
        // ⚠️ 极其重要：这里是恢复被误删的事件绑定（护眼模式、搜索框回车、按钮点击等）
        // =========================================================================
        els.eyeProtectionBtn.addEventListener('click', () => {
            state.isEyeProtectionMode = !state.isEyeProtectionMode;
            
            if (state.isEyeProtectionMode) {
                document.body.classList.add('eye-protection-mode');
                els.eyeProtectionBtn.classList.add('text-green-600', 'bg-green-50');
                els.eyeProtectionBtn.classList.remove('text-gray-600');
            } else {
                document.body.classList.remove('eye-protection-mode');
                els.eyeProtectionBtn.classList.remove('text-green-600', 'bg-green-50');
                els.eyeProtectionBtn.classList.add('text-gray-600');
            }
        });

        els.toggleSearchBtn.addEventListener('click', toggleSearch);
        els.searchClose.addEventListener('click', toggleSearch);
        els.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') executeSearch(); });
        els.searchNext.addEventListener('click', () => navigateSearch(1));
        els.searchPrev.addEventListener('click', () => navigateSearch(-1));
        // =========================================================================

        async function executeSearch() {
            const query = els.searchInput.value.trim().toLowerCase();
            if (!query || !state.pdfDoc) return;
            state.searchAbortController?.abort();
            state.searchAbortController = new AbortController();
            const signal = state.searchAbortController.signal;
            const searchDoc = state.pdfDoc;
            const isStale = () => signal.aborted || state.pdfDoc !== searchDoc;
            state.searchMatches = [];
            state.searchQuery = query;
            state.currentMatchIndex = -1;
            clearSearchHighlights();
            setSidebarMode('search');
            els.searchCount.textContent = '搜索中';
            const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            let sliceStart = performance.now(), lastRefresh = sliceStart;
            for (let pageNum = 1; pageNum <= searchDoc.numPages; pageNum++) {
                if (isStale()) return;
                let fullText;
                try { fullText = await getPdfSearchText(searchDoc, pageNum); }
                catch (error) {
                    if (isStale()) return;
                    console.warn('页面文本检索失败:', pageNum, error);
                    continue;
                }
                if (isStale()) return;
                const lower = fullText.toLowerCase();
                regex.lastIndex = 0;
                let match, pageMatchIndex = 0;
                while ((match = regex.exec(lower)) !== null) {
                    state.searchMatches.push({ pageNum, pageMatchIndex: pageMatchIndex++,
                        snippet: fullText.substring(Math.max(0, match.index - 15), match.index + match[0].length + 15).replace(/\s+/g, ' ') });
                    if (pageMatchIndex % 256 === 0 && performance.now() - sliceStart >= 8) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                        if (isStale()) return;
                        sliceStart = performance.now();
                    }
                }
                if (performance.now() - lastRefresh >= 50) {
                    renderSearchSidebar();
                    els.searchCount.textContent = `0/${state.searchMatches.length}`;
                    lastRefresh = performance.now();
                }
                if (performance.now() - sliceStart >= 8) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                    if (isStale()) return;
                    sliceStart = performance.now();
                }
            }
            if (isStale()) return;
            renderSearchSidebar();
            if (state.searchMatches.length) {
                state.currentMatchIndex = 0;
                updateSearchUI();
                jumpToMatch();
            } else {
                els.searchCount.textContent = '未找到';
                if (searchSidebarView) searchSidebarView.count.textContent = '未找到相关内容';
            }
        }

        function renderSearchSidebar() {
            if (state.sidebarMode !== 'search') return;
            const list = els.sidebarList;
            let view = searchSidebarView;
            if (!view || !view.host.isConnected || view.matches !== state.searchMatches) {
                list.replaceChildren();
                list.scrollTop = 0;
                const header = document.createElement('div');
                header.className = 'pdf-search-header';
                const count = document.createElement('span');
                const close = document.createElement('button');
                close.id = 'exit-search-mode-btn';
                close.textContent = '退出检索';
                close.onclick = () => {
                    state.searchAbortController?.abort();
                    setSidebarMode('annotations');
                    if (!els.searchBar.classList.contains('hidden')) toggleSearch();
                };
                header.append(count, close);
                const host = document.createElement('div');
                host.className = 'pdf-search-results';
                list.append(header, host);
                view = searchSidebarView = { header, host, count, rows: new Map(), matches: state.searchMatches };
            }
            view.count.textContent = `检索结果 (${state.searchMatches.length})`;
            const scrollTop = Math.max(0, list.scrollTop - view.host.offsetTop);
            const start = Math.max(0, Math.floor(scrollTop / SEARCH_ROW_HEIGHT) - 3);
            const end = Math.min(state.searchMatches.length, start + Math.ceil(list.clientHeight / SEARCH_ROW_HEIGHT) + 7);
            setPdfStyle(view.host, 'height', state.searchMatches.length * SEARCH_ROW_HEIGHT + 'px');
            for (const [index, row] of view.rows) if (index < start || index >= end) { row.remove(); view.rows.delete(index); }
            for (let index = start; index < end; index++) {
                let row = view.rows.get(index);
                if (!row) {
                    const match = state.searchMatches[index];
                    row = document.createElement('div');
                    row.id = `search-sidebar-item-${index}`;
                    row.className = 'pdf-search-row sidebar-item';
                    row.style.top = index * SEARCH_ROW_HEIGHT + 'px';
                    const label = document.createElement('div');
                    label.className = 'pdf-search-page';
                    label.textContent = `P. ${match.pageNum}`;
                    const snippet = document.createElement('div');
                    snippet.className = 'pdf-search-snippet';
                    snippet.title = match.snippet;
                    const query = state.searchQuery || els.searchInput.value.trim().toLowerCase();
                    const text = '...' + match.snippet + '...';
                    let from = 0, at;
                    while (query && (at = text.toLowerCase().indexOf(query, from)) >= 0) {
                        snippet.append(document.createTextNode(text.slice(from, at)));
                        const mark = document.createElement('mark');
                        mark.textContent = text.slice(at, at + query.length);
                        snippet.append(mark);
                        from = at + query.length;
                    }
                    snippet.append(document.createTextNode(text.slice(from)));
                    row.append(label, snippet);
                    row.onclick = () => { state.currentMatchIndex = index; updateSearchUI(); jumpToMatch(); };
                    view.host.append(row);
                    view.rows.set(index, row);
                }
                row.classList.toggle('pdf-search-active', index === state.currentMatchIndex);
            }
        }
        els.sidebarList.addEventListener('scroll', () => {
            if (state.sidebarMode !== 'search' || searchSidebarFrame) return;
            searchSidebarFrame = requestAnimationFrame(() => { searchSidebarFrame = 0; renderSearchSidebar(); });
        }, { passive: true });
        function highlightSidebarSearchItem(index) {
            if (state.sidebarMode !== 'search' || index < 0) return;
            renderSearchSidebar();
            const view = searchSidebarView, list = els.sidebarList;
            const top = view.host.offsetTop + index * SEARCH_ROW_HEIGHT;
            if (top < list.scrollTop + view.header.offsetHeight) list.scrollTop = top - view.header.offsetHeight;
            else if (top + SEARCH_ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + SEARCH_ROW_HEIGHT - list.clientHeight;
            renderSearchSidebar();
        }

        function jumpToMatch() {
            if (state.searchMatches.length === 0 || state.currentMatchIndex < 0) return;
            const matchInfo = state.searchMatches[state.currentMatchIndex];
            const pageNum = matchInfo.pageNum;
            const targetMatchIndex = matchInfo.pageMatchIndex; 
            const query = state.searchQuery || els.searchInput.value.trim();
            const loadToken = state.loadToken;
            const matches = state.searchMatches;
            const isCurrent = () => state.loadToken === loadToken && state.searchMatches === matches && state.searchMatches[state.currentMatchIndex] === matchInfo && state.sidebarMode === 'search';
            recordJumpPosition();
            const wrapper = scrollPdfPageIntoView(pageNum, 'center');
            if (!wrapper) return;
            
            const doHighlightFlow = () => {
                if (!isCurrent()) return;
                clearSearchHighlights();
                highlightSidebarSearchItem(state.currentMatchIndex);
                
                let retryCount = 0;
                
                const tryHighlight = () => {
                    if (!isCurrent() || !wrapper.isConnected) return;
                    const textLayer = document.getElementById(`text-layer-${pageNum}`);
                    if (!textLayer) return;
                    
                    const spans = Array.from(textLayer.querySelectorAll('span'));
                    
                    if (spans.length === 0) {
                        if (retryCount++ < 40) setTimeout(tryHighlight, 50);
                        return;
                    }

                    let domText = '';
                    const mapping = [];
                    
                    for (const child of textLayer.childNodes) {
                        if (child.nodeType !== 1) continue;
                        if (child.tagName === 'SPAN') {
                            const text = child.textContent || '';
                            const start = domText.length;
                            domText += text;
                            mapping.push({
                                node: child.firstChild || child,
                                start: start,
                                end: domText.length,
                                isBr: false
                            });
                        } else if (child.tagName === 'BR') {
                            const start = domText.length;
                            domText += ' ';
                            mapping.push({
                                node: child,
                                start: start,
                                end: domText.length,
                                isBr: true
                            });
                        }
                    }

                    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                    let domMatch;
                    let currentMatchIdx = 0;
                    let foundExact = false;

                    while ((domMatch = regex.exec(domText)) !== null) {
                        if (currentMatchIdx === targetMatchIndex) {
                            const matchStart = domMatch.index;
                            const matchEnd = matchStart + domMatch[0].length;

                            let startIdx = mapping.findIndex(m => matchStart >= m.start && matchStart < m.end);
                            while (startIdx !== -1 && startIdx < mapping.length && mapping[startIdx].isBr) startIdx++;
                            let endIdx = mapping.findIndex(m => matchEnd > m.start && matchEnd <= m.end);
                            while (endIdx > 0 && mapping[endIdx]?.isBr) endIdx--;

                            const startMap = startIdx >= 0 ? mapping[startIdx] : null;
                            const endMap = endIdx >= 0 ? mapping[endIdx] : null;

                            if (startMap && endMap && !startMap.isBr && !endMap.isBr) {
                                try {
                                    const range = document.createRange();
                                    range.setStart(startMap.node, Math.max(0, matchStart - startMap.start));
                                    range.setEnd(endMap.node, Math.min((endMap.end - endMap.start), matchEnd - endMap.start));

                                    const rects = Array.from(range.getClientRects());
                                    const wrapperRect = wrapper.getBoundingClientRect();
                                    
                                    const highlightLayer = document.createElement('div');
                                    highlightLayer.id = 'search-highlight-layer';
                                    highlightLayer.className = 'absolute inset-0 pointer-events-none z-20';
                                    
                                    rects.forEach(rect => {
                                        if (rect.width > 0 && rect.height > 0) {
                                            const div = document.createElement('div');
                                            div.className = 'search-vector-highlight';
                                            
                                            const pctX = ((rect.left - wrapperRect.left) / wrapperRect.width) * 100;
                                            const pctY = ((rect.top - wrapperRect.top) / wrapperRect.height) * 100;
                                            const pctW = (rect.width / wrapperRect.width) * 100;
                                            const pctH = (rect.height / wrapperRect.height) * 100;

                                            // 利用 calc() 维持固定的物理边距补偿，框体核心随页面自由缩放！
                                            div.style.left = `calc(${pctX}% - 2px)`;
                                            div.style.top = `${pctY}%`;
                                            div.style.width = `calc(${pctW}% + 4px)`;
                                            div.style.height = `${pctH}%`;
                                            
                                            highlightLayer.appendChild(div);
                                        }
                                    });
                                    wrapper.appendChild(highlightLayer);
                                    foundExact = true;
                                } catch(e) { console.warn("Range 选区越界:", e); }
                            }
                            break;
                        }
                        currentMatchIdx++;
                    }
                    
                    if (!foundExact) {
                        const fallbackRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                        spans.forEach(span => {
                            if (fallbackRegex.test(span.textContent)) {
                                span.style.backgroundColor = "rgba(255, 165, 0, 0.4)";
                                span.style.borderRadius = "2px";
                                span.classList.add('fallback-highlight');
                            }
                        });
                    }
                };
                
                tryHighlight();
            };

            if (state.pagesRendered.has(pageNum)) {
                doHighlightFlow();
            } else {
                renderPageHighQuality(pageNum).then(doHighlightFlow);
            }
        }

        function clearSearchHighlights() { 
            document.querySelectorAll('#search-highlight-layer').forEach(el => el.remove());
            
            document.querySelectorAll('.fallback-highlight').forEach(span => {
                span.style.backgroundColor = '';
                span.classList.remove('fallback-highlight');
            });
        }
        
        function navigateSearch(dir) {
            if (state.searchMatches.length === 0) return;
            state.currentMatchIndex += dir;
            if (state.currentMatchIndex >= state.searchMatches.length) state.currentMatchIndex = 0;
            if (state.currentMatchIndex < 0) state.currentMatchIndex = state.searchMatches.length - 1;
            updateSearchUI();
            jumpToMatch();
        }

        function updateSearchUI() { 
            els.searchCount.textContent = `${state.currentMatchIndex + 1}/${state.searchMatches.length}`; 
        }

        

