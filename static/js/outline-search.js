        // 共享搜索状态先初始化；后续可选控件的绑定不得阻断文档打开时的清理。
        const SEARCH_ROW_HEIGHT = 104;
        let searchSidebarView = null;
        let searchSidebarFrame = 0;
        let outlineMapSortFrame = 0;
        let activeOutlineElement = null;

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
                cancelAnimationFrame(outlineMapSortFrame);
                outlineMapSortFrame = 0;
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
                    // 让出当前任务后解析目标，避免阻塞目录 DOM 的构建。
                    setTimeout(async () => {
                        try {
                            if (isStale()) return;
                            const pageIndex = await resolvePdfDestinationPage(pdfDoc, item.dest);
                            if (pageIndex !== null) {
                                if (isStale()) return;
                                const physicalPage = pageIndex + 1;
                                // 赋予 DOM 属性，方便后续操作
                                titleDiv.dataset.targetPage = physicalPage;
                                // 推入全局地图
                                state.outlineMap.push({
                                    pageNum: physicalPage,
                                    element: titleDiv, order
                                });
                                // 每帧统一排序；同页条目按目录本身的顺序，独立于异步完成顺序。
                                if (!outlineMapSortFrame) outlineMapSortFrame = requestAnimationFrame(() => {
                                    outlineMapSortFrame = 0;
                                    if (isStale()) return;
                                    state.outlineMap.sort((a, b) => a.pageNum - b.pageNum || a.order - b.order);
                                    updateCurrentOutline();
                                });
                            }
                        } catch (e) { /* 解析失败忽略 */ }
                    }, 0);
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

        function performAction(actionFn, affectedPages = null) {
            // 普通编辑显式提供受影响的页；导入等整表操作保留完整比较。
            const affectedKeys = affectedPages && [...new Set(affectedPages.map(String))];
            // 页内锚点随撤销快照保存，避免撤销/重做时按新的缩放重新猜测旧终点。
            normalizeArrowAnchors(state.annotations, affectedKeys);
            // 1. 只为受影响的页创建撤销快照。
            const beforeState = {};
            (affectedKeys || Object.keys(state.annotations)).forEach(k => {
                beforeState[k] = JSON.stringify(state.annotations[k]);
            });

            // 2. 执行工具动作
            actionFn(); 
            normalizeArrowAnchors(state.annotations, affectedKeys);

            // 3. 执行后：比对状态，提取纯净 Delta (差异包)
            const afterState = {};
            (affectedKeys || Object.keys(state.annotations)).forEach(k => {
                afterState[k] = JSON.stringify(state.annotations[k]);
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
                    
                    spans.forEach(span => {
                        const text = span.textContent || '';
                        const start = domText.length;
                        domText += text;
                        mapping.push({ 
                            node: span.firstChild || span, 
                            start: start, 
                            end: domText.length 
                        });
                    });

                    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                    let domMatch;
                    let currentMatchIdx = 0;
                    let foundExact = false;

                    while ((domMatch = regex.exec(domText)) !== null) {
                        if (currentMatchIdx === targetMatchIndex) {
                            const matchStart = domMatch.index;
                            const matchEnd = matchStart + domMatch[0].length;

                            const startMap = mapping.find(m => matchStart >= m.start && matchStart < m.end);
                            const endMap = mapping.find(m => matchEnd > m.start && matchEnd <= m.end);

                            if (startMap && endMap) {
                                try {
                                    const range = document.createRange();
                                    range.setStart(startMap.node, matchStart - startMap.start);
                                    range.setEnd(endMap.node, matchEnd - endMap.start);

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

        

