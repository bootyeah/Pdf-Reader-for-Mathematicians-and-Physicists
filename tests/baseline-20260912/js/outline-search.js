        // =========================================================================
        // =========================================================================
        
        // 1. 递归渲染多层级目录，并自动挂载跳跃引擎
        async function renderOutline(outlineData, container = els.outlineContent, level = 0) {
            if (level === 0) {
                container.innerHTML = '';
                state.outlineMap = []; // 清空旧地图
            }

            const ul = document.createElement('ul');
            ul.className = level === 0 ? 'space-y-0.5' : 'ml-3 mt-0.5 space-y-0.5 border-l border-gray-200 pl-2';

            for (const item of outlineData) {
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
                    // 不阻塞主线程，放到微任务队列
                    setTimeout(async () => {
                        try {
                            let explicitDest = typeof item.dest === 'string' ? await state.pdfDoc.getDestination(item.dest) : item.dest;
                            if (explicitDest) {
                                const pageIndex = await state.pdfDoc.getPageIndex(explicitDest[0]);
                                const physicalPage = pageIndex + 1;
                                // 赋予 DOM 属性，方便后续操作
                                titleDiv.dataset.targetPage = physicalPage;
                                // 推入全局地图
                                state.outlineMap.push({
                                    pageNum: physicalPage,
                                    element: titleDiv
                                });
                                // 按照页码从小到大排序。如果有多个目录指向同一页，后加入的（子目录）排在后面
                                state.outlineMap.sort((a, b) => a.pageNum - b.pageNum);
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
                    
                    await renderOutline(item.items, li, level + 1); // 递归
                } else if (level === 0) {
                    textSpan.classList.add('ml-3.5');
                }
                ul.appendChild(li);
            }
            container.appendChild(ul);
        }

        // 2. 状态开关与丝滑面板动画
        function toggleOutline(forceState = null) {
            state.isOutlineOpen = forceState !== null ? forceState : !state.isOutlineOpen;
            const icon = els.outlineTriggerBtn.querySelector('i');
            const panel = els.outlinePanel;
            
            if (state.isOutlineOpen) {
                // 丝滑展开：解除隐身，恢复原生尺寸与位置，允许点击
                panel.classList.remove('opacity-0', 'invisible', 'scale-y-95', '-translate-y-2', 'pointer-events-none');
                panel.classList.add('opacity-100', 'visible', 'scale-y-100', 'translate-y-0', 'pointer-events-auto');
                // 图标优雅翻转
                icon.classList.add('rotate-180');
            } else {
                // 丝滑收起：开启隐身，轻微上浮并微缩，阻断点击
                panel.classList.remove('opacity-100', 'visible', 'scale-y-100', 'translate-y-0', 'pointer-events-auto');
                panel.classList.add('opacity-0', 'invisible', 'scale-y-95', '-translate-y-2', 'pointer-events-none');
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

        function performAction(actionFn) {
            // 1. 执行前：记录当前各页状态快照 (浅层极速 stringify，只耗时 0.1ms)
            const beforeState = {};
            Object.keys(state.annotations).forEach(k => {
                beforeState[k] = JSON.stringify(state.annotations[k]);
            });

            // 2. 执行工具动作
            actionFn(); 

            // 3. 执行后：比对状态，提取纯净 Delta (差异包)
            const afterState = {};
            Object.keys(state.annotations).forEach(k => {
                afterState[k] = JSON.stringify(state.annotations[k]);
            });

            const backward = {};
            const forward = {};
            let changed = false;

            const allKeys = new Set([...Object.keys(beforeState), ...Object.keys(afterState)]);
            allKeys.forEach(k => {
                if (beforeState[k] !== afterState[k]) {
                    backward[k] = beforeState[k] || "[]";
                    forward[k] = afterState[k] || "[]";
                    changed = true;
                }
            });

            // 4. 只将 Delta 差异推入撤销栈，内存消耗降低 99%
            if (changed) {
                if (state.historyIndex < state.history.length - 1) {
                    state.history = state.history.slice(0, state.historyIndex + 1);
                }
                state.history.push({ type: 'DELTA', backward, forward });
                state.historyIndex++;
                if (state.history.length > 50) {
                    state.history.shift();
                    state.historyIndex--;
                }
            }

            saveAnnotationsToStorage();
            updateSaveStatus(true);
            refreshUI(); 
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
            const annoInput = document.getElementById('anno-search-input');
            if (!annoInput) return;
            const annoSearchContainer = annoInput.parentElement.parentElement;
            
            if (mode === 'search') {
                if (!state.sidebarOpen) els.toggleSidebarBtn.click(); 
                annoSearchContainer.classList.add('hidden'); 
                renderSearchSidebar();
            } else {
                annoSearchContainer.classList.remove('hidden'); 
                updateSidebar(); 
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

            if (state.pdfDoc) {
                const visiblePages = Array.from(state.pagesRendered);
                state.pagesRendered.clear();
                visiblePages.forEach(pageNum => {
                    renderPageHighQuality(pageNum, true);
                });
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

            if (state.searchAbortController) state.searchAbortController.abort();
            state.searchAbortController = new AbortController();
            const signal = state.searchAbortController.signal;

            state.searchMatches = [];
            state.currentMatchIndex = -1;
            clearSearchHighlights();

            setSidebarMode('search');
            els.sidebarList.innerHTML = `<div class="text-center text-gray-400 mt-10 p-4"><i class="ph ph-spinner animate-spin text-3xl mb-4"></i><p class="text-sm font-bold text-gray-600">深度检索中...</p><p class="text-xs mt-2 opacity-60">采用异步切片引擎，拒绝卡顿</p></div>`;
            els.searchCount.textContent = "搜索中";

            const numPages = state.pdfDoc.numPages;
            let totalMatches = 0;

            for (let i = 1; i <= numPages; i++) {
                if (signal.aborted) return; 
                if (i % 3 === 0) await new Promise(resolve => setTimeout(resolve, 0));

                const page = await state.pdfDoc.getPage(i);
                const textContent = await page.getTextContent();
                
                const fullText = textContent.items.map(item => item.str + (item.hasEOL ? ' ' : '')).join('');
                const lowerFullText = fullText.toLowerCase();
                
                const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                let match;
                let pageMatchCount = 0; 

                while ((match = regex.exec(lowerFullText)) !== null) {
                    const startIdx = match.index;
                    const endIdx = match.index + match[0].length;
                    
                    const snippetStart = Math.max(0, startIdx - 15);
                    const snippetEnd = Math.min(lowerFullText.length, endIdx + 15);
                    const snippet = fullText.substring(snippetStart, snippetEnd).replace(/\s+/g, ' ');

                    state.searchMatches.push({
                        pageNum: i,
                        pageMatchIndex: pageMatchCount,
                        snippet: snippet
                    });
                    pageMatchCount++;
                    totalMatches++;
                }

                if (pageMatchCount > 0) {
                    renderSearchSidebar(); 
                    els.searchCount.textContent = `0/${totalMatches}`;
                }
            }

            if (state.searchMatches.length > 0) {
                state.currentMatchIndex = 0;
                updateSearchUI();
                jumpToMatch();
            } else { 
                els.searchCount.textContent = "未找到"; 
                els.sidebarList.innerHTML = `<div class="text-center text-gray-400 mt-10 p-4"><i class="ph ph-magnifying-glass text-3xl mb-2 opacity-30"></i><p>未找到相关内容</p></div>`;
            }
        }

        function renderSearchSidebar() {
            if (state.sidebarMode !== 'search') return;
            const list = els.sidebarList;
            list.innerHTML = '';
            
            const query = els.searchInput.value.trim();
            const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');

            const header = document.createElement('div');
            header.className = 'flex justify-between items-center mt-2 mb-2 px-2 sticky top-0 bg-white z-10 pb-2 border-b border-gray-100 shadow-sm';
            header.innerHTML = `
                <span class="text-xs font-bold text-blue-600 uppercase flex items-center gap-1"><i class="ph ph-radar text-lg animate-pulse"></i> 检索结果 (${state.searchMatches.length})</span>
                <button id="exit-search-mode-btn" class="text-gray-500 hover:text-red-500 hover:bg-red-50 text-xs px-2 py-1 rounded transition border border-transparent hover:border-red-200">退出检索</button>
            `;
            list.appendChild(header);

            document.getElementById('exit-search-mode-btn').addEventListener('click', () => {
                setSidebarMode('annotations');
                if (!els.searchBar.classList.contains('hidden')) toggleSearch(); 
            });

            state.searchMatches.forEach((match, index) => {
                const div = document.createElement('div');
                div.id = `search-sidebar-item-${index}`;
                div.className = 'sidebar-item p-3 mb-2 mx-2 bg-white rounded-lg shadow-sm cursor-pointer border border-gray-100 hover:border-blue-300 transition-all text-sm group';
                
                const displaySnippet = match.snippet.replace(regex, '<mark class="bg-orange-200 text-orange-900 rounded-sm font-bold px-1 shadow-sm">$1</mark>');
                
                div.innerHTML = `
                    <div class="flex justify-between items-center mb-1.5">
                        <span class="text-[10px] font-bold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200 group-hover:bg-blue-100 group-hover:text-blue-700 transition-colors">P. ${match.pageNum}</span>
                    </div>
                    <div class="text-gray-600 leading-relaxed break-all text-[13px] italic">...${displaySnippet}...</div>
                `;
                
                div.addEventListener('click', () => {
                    state.currentMatchIndex = index;
                    updateSearchUI();
                    jumpToMatch();
                });
                
                list.appendChild(div);
            });
            
            highlightSidebarSearchItem(state.currentMatchIndex);
        }

        function highlightSidebarSearchItem(index) {
            if (state.sidebarMode !== 'search' || index < 0) return;
            document.querySelectorAll('[id^="search-sidebar-item-"]').forEach(el => {
                el.classList.remove('border-blue-400', 'bg-blue-50', 'ring-2', 'ring-blue-100');
                el.classList.add('border-gray-100', 'bg-white');
            });
            const active = document.getElementById(`search-sidebar-item-${index}`);
            if (active) {
                active.classList.remove('border-gray-100', 'bg-white');
                active.classList.add('border-blue-400', 'bg-blue-50', 'ring-2', 'ring-blue-100');
                active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        function jumpToMatch() {
            if (state.searchMatches.length === 0 || state.currentMatchIndex < 0) return;
            const matchInfo = state.searchMatches[state.currentMatchIndex];
            const pageNum = matchInfo.pageNum;
            const targetMatchIndex = matchInfo.pageMatchIndex; 
            const query = els.searchInput.value.trim();
            
            const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
            
            const doHighlightFlow = () => {
                recordJumpPosition(); 
                wrapper.scrollIntoView({ behavior: 'auto', block: 'center' });
                clearSearchHighlights();
                highlightSidebarSearchItem(state.currentMatchIndex);
                
                let retryCount = 0;
                
                const tryHighlight = () => {
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
            const existingLayer = document.getElementById('search-highlight-layer');
            if (existingLayer) existingLayer.remove();
            
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

        

