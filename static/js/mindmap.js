/**
 * mindmap.js - PDF 阅读器多主链、自由分支与合并思维导图功能
 * 
 * 功能点：
 * 1. 支持多条并列主链（Multi-Main-Chains），每条主链可独立推演、自由分支（Fork）与汇合（Merge/Converge）。
 * 2. 支持主链内部开启并行分支（1 拆多路并行子主链）并支持合流汇入下游节点，同时保留右侧横向细节侧支。
 * 3. 支持跨分支、跨主链的任意节点自由连线汇合（DAG 多对一汇入）以及双节点内容融合合并。
 * 4. 独立于 PDF 的缩放（35%-250%）与自由平移浏览，滚轮严格隔离不影响 PDF。
 * 5. 页面关联可选化：新建节点默认不绑定页码，可按需绑定或解绑，支持 KaTeX 公式与 TikZ 图形渲染。
 * 6. 导图数据原生存储于 state.annotations['mindmap'] 中，无缝参与保存、撤销/重做与云端同步。
 */

(() => {
    // 内部状态
    let isMindmapOpen = false;
    let currentZoom = 1.0;
    let panX = 0;
    let panY = 0;
    let selectedNodeId = null;
    let selectedNodeIds = new Set();
    let editingNodeId = null;
    let draggingNodeId = null;
    let activePopoverNodeId = null;
    let isSpaceDown = false;
    let isPanning = false;
    let startPanX = 0, startPanY = 0;
    let panStartX = 0, panStartY = 0;
    let didPanMove = false;
    // 仅用于视图排版，不写入批注；撤销、保存仍沿用原始树与连线模型。
    let convergenceLayouts = [];

    // 交互式自由合并连线状态
    let mergingSourceNodeId = null;
    let mergingSourceNodeIds = [];
    let mergingTargetNodeId = null;
    let mergePreviewFrame = null;
    let mergeMouseX = 0;
    let mergeMouseY = 0;

    // 交互式更改挂载父节点（画布点选挂载）状态
    let reparentingSourceNodeId = null;
    let reparentingTargetNodeId = null;
    let reparentPreviewFrame = null;
    let reparentMouseX = 0;
    let reparentMouseY = 0;

    // 罗马数字辅助（用于主链编号：主链 I, II, III...）
    const ROMAN_NUMS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
    function toRoman(num) {
        return ROMAN_NUMS[num] || String(num + 1);
    }

    function escapeMindMapText(text) {
        return String(text).replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char]));
    }

    // 交互轻提示（替代原生 alert，提升现代感）
    function showMindmapToast(message, type = 'info') {
        let toast = document.getElementById('mm-toast-msg');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'mm-toast-msg';
            toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-3.5 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-200 pointer-events-none flex items-center gap-1.5 opacity-0 translate-y-2';
            document.body.appendChild(toast);
        }
        const isSuccess = type === 'success';
        const isWarn = type === 'warn';
        toast.className = `fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-3.5 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-200 pointer-events-none flex items-center gap-1.5 opacity-100 translate-y-0 ${
            isSuccess ? 'bg-emerald-600 text-white' : isWarn ? 'bg-amber-600 text-white' : 'bg-gray-800 text-white'
        }`;
        toast.innerHTML = `<i class="ph ${isSuccess ? 'ph-check-circle' : isWarn ? 'ph-warning-circle' : 'ph-info'} text-sm"></i><span>${escapeMindMapText(message)}</span>`;
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            if (toast) toast.className = toast.className.replace('opacity-100 translate-y-0', 'opacity-0 translate-y-2');
        }, 2200);
    }

    // DOM 元素缓存
    let _cachedEls = null;
    const getEls = () => {
        if (_cachedEls && _cachedEls.panel?.isConnected) return _cachedEls;
        const elsObj = {
            btn: document.getElementById('mindmap-btn'),
            panel: document.getElementById('mindmap-panel'),
            pagesBar: document.getElementById('mindmap-pages-bar'),
            pagesList: document.getElementById('mindmap-pages-list'),
            addPageBtn: document.getElementById('mindmap-add-page-btn'),
            bindPageBtn: document.getElementById('mindmap-bind-page-btn'),
            bindPageText: document.getElementById('mindmap-bind-page-text'),
            viewport: document.getElementById('mindmap-viewport'),
            canvas: document.getElementById('mindmap-canvas'),
            svgCanvas: document.getElementById('mindmap-svg-canvas'),
            treeRoot: document.getElementById('mindmap-tree-root'),
            resizer: document.getElementById('mindmap-resizer'),
            nodeCount: document.getElementById('mindmap-node-count'),
            zoomVal: document.getElementById('mindmap-zoom-val'),
            zoomIn: document.getElementById('mindmap-zoom-in'),
            zoomOut: document.getElementById('mindmap-zoom-out'),
            closeBtn: document.getElementById('mindmap-close-btn'),
            shortcutBtn: document.getElementById('mindmap-shortcut-btn'),
            centerBtn: document.getElementById('mindmap-center-btn'),
            toggleAllBtn: document.getElementById('mindmap-toggle-all-btn'),
            bindCurrentBtn: document.getElementById('mindmap-bind-current-btn'),
            addChainBtn: document.getElementById('mindmap-add-chain-btn'),
            forkBtn: document.getElementById('mindmap-fork-btn'),
            mergeBtn: document.getElementById('mindmap-merge-btn')
        };
        if (elsObj.panel && elsObj.treeRoot) _cachedEls = elsObj;
        return elsObj;
    };

    // ==========================================
    // 1. 数据存取与多主链 + 自由分支合并模型规范
    // ==========================================

    // 数学理论角色体系标签库
    const MATH_TAGS = {
        axiom: { label: '公理', color: 'amber', icon: 'ph-compass' },
        def: { label: '定义', color: 'blue', icon: 'ph-bookmark-simple' },
        lemma: { label: '引理', color: 'cyan', icon: 'ph-wrench' },
        thm: { label: '定理', color: 'purple', icon: 'ph-lightning' },
        prop: { label: '命题', color: 'fuchsia', icon: 'ph-cube' },
        proof: { label: '证明', color: 'amber', icon: 'ph-pencil-line' },
        idea: { label: '动机', color: 'emerald', icon: 'ph-sparkle' },
        cor: { label: '推论', color: 'indigo', icon: 'ph-target' },
        counter: { label: '反例', color: 'rose', icon: 'ph-warning' }
    };

    function createDefaultRootNode(customText = null) {
        const now = Date.now();
        const rand = Math.random().toString(36).slice(2, 6);
        return {
            id: 'mm_root_' + now + '_' + rand,
            text: customText || (state.fileName ? state.fileName.replace(/\.pdf$/i, '') : '主链 I：核心理论脉络'),
            page: null, // 默认无关联页面
            collapsed: false,
            mergeTo: [],
            children: [],
            branches: []
        };
    }

    function createDefaultMindMapPage(index = 0, options = {}) {
        const now = Date.now();
        const rand = Math.random().toString(36).slice(2, 6);
        const pageNum = index + 1;
        const defaultRootTitle = index === 0
            ? (state.fileName ? state.fileName.replace(/\.pdf$/i, '') : '主链 I：核心理论脉络')
            : `第 ${pageNum} 页：核心理论脉络`;
        const rootNode = options.root || createDefaultRootNode(options.rootText || defaultRootTitle);
        const nodes = Array.isArray(options.nodes) && options.nodes.length > 0 ? options.nodes : [rootNode];
        const pdfPage = (options.page && Number(options.page) > 0) ? parseInt(options.page, 10) : null;
        return {
            id: options.id || ('mm_page_' + now + '_' + rand),
            title: (typeof options.title === 'string' && options.title.trim()) ? options.title.trim() : `第 ${pageNum} 页`,
            page: pdfPage, // 导图页绑定的 PDF 页码（默认 null，与节点一致）
            zoom: Number.isFinite(Number(options.zoom)) ? Number(options.zoom) : 1.0,
            panX: Number.isFinite(Number(options.panX)) ? Number(options.panX) : null,
            panY: Number.isFinite(Number(options.panY)) ? Number(options.panY) : null,
            root: nodes[0],
            nodes: nodes
        };
    }

    function normalizeChainNodes(container) {
        if (!container || typeof container !== 'object') return;
        if (!Array.isArray(container.nodes) || container.nodes.length === 0) {
            container.nodes = container.root ? [container.root] : [createDefaultRootNode()];
        }
        // JSON 快照会将 root 与 nodes[0] 反序列化为两个对象。
        // 用持久化 ID 恢复别名，不能用对象引用判断是否是另一条主链。
        if (container.root && !container.nodes.some(node => node && node.id === container.root.id)) {
            container.nodes.unshift(container.root);
        }
        const seen = new Set();
        const uniqueNodes = container.nodes.filter(node => {
            if (!node || seen.has(node.id)) return false;
            seen.add(node.id);
            return true;
        });
        // 查找/移动节点会持有 nodes 列表引用；正常读取不能替换该数组。
        if (uniqueNodes.length !== container.nodes.length) container.nodes = uniqueNodes;
        if (container.nodes.length === 0) {
            container.nodes.push(createDefaultRootNode());
        }
        container.root = container.nodes[0];
    }

    function createDefaultMindMapData() {
        const firstPage = createDefaultMindMapPage(0);
        return {
            version: 4,
            activePageId: firstPage.id,
            pages: [firstPage],
            page: firstPage.page,
            zoom: firstPage.zoom,
            root: firstPage.root,
            nodes: firstPage.nodes
        };
    }

    function getMindMapData() {
        if (!state.annotations) state.annotations = {};
        let data = state.annotations['mindmap'];

        const hasPages = data && Array.isArray(data.pages) && data.pages.length > 0;
        const hasNodes = data && (data.root || (Array.isArray(data.nodes) && data.nodes.length > 0));

        if (!data || (!hasPages && !hasNodes)) {
            data = createDefaultMindMapData();
            state.annotations['mindmap'] = data;
            return data;
        }

        if (!hasPages) {
            normalizeChainNodes(data);
            const firstPage = createDefaultMindMapPage(0, {
                id: data.activePageId || ('mm_page_' + Date.now()),
                page: (data.page && Number(data.page) > 0) ? parseInt(data.page, 10) : null,
                zoom: Number.isFinite(Number(data.zoom)) ? Number(data.zoom) : 1.0,
                root: data.root,
                nodes: data.nodes
            });
            data.pages = [firstPage];
            data.activePageId = firstPage.id;
            data.page = firstPage.page;
            data.zoom = firstPage.zoom;
            return data;
        }

        const seenPageIds = new Set();
        const validPages = [];
        data.pages.forEach((p, idx) => {
            if (!p || typeof p !== 'object') return;
            if (!p.id || seenPageIds.has(p.id)) {
                p.id = 'mm_page_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).slice(2, 5);
            }
            seenPageIds.add(p.id);
            if (typeof p.title !== 'string' || !p.title.trim()) {
                p.title = `第 ${validPages.length + 1} 页`;
            }
            p.page = (p.page && Number(p.page) > 0) ? parseInt(p.page, 10) : null;
            p.zoom = Number.isFinite(Number(p.zoom)) ? Number(p.zoom) : 1.0;
            validPages.push(p);
        });

        if (validPages.length === 0) {
            const fallbackPage = createDefaultMindMapPage(0);
            data.pages = [fallbackPage];
            data.activePageId = fallbackPage.id;
            data.nodes = fallbackPage.nodes;
            data.root = fallbackPage.root;
            data.page = fallbackPage.page;
            data.zoom = fallbackPage.zoom;
            return data;
        }
        if (validPages.length !== data.pages.length) {
            data.pages = validPages;
        }

        const activePage = data.pages.find(p => p.id === data.activePageId) || data.pages[0];
        data.activePageId = activePage.id;

        const belongsToOtherPage = data.pages.some(other => other !== activePage && other.nodes === data.nodes);
        if (!belongsToOtherPage && Array.isArray(data.nodes) && data.nodes.length > 0) {
            normalizeChainNodes(data);
            activePage.nodes = data.nodes;
            activePage.root = data.root;
        } else {
            normalizeChainNodes(activePage);
            data.nodes = activePage.nodes;
            data.root = activePage.root;
        }

        data.pages.forEach(p => {
            if (p !== activePage) {
                normalizeChainNodes(p);
            }
        });

        data.page = activePage.page;
        if (!Number.isFinite(Number(data.zoom))) {
            data.zoom = activePage.zoom || 1.0;
        } else {
            activePage.zoom = Number(data.zoom);
        }
        return data;
    }

    function getMindMapPages(data = null) {
        const d = data || getMindMapData();
        return Array.isArray(d.pages) ? d.pages : [];
    }

    function getActiveMindMapPage(data = null) {
        const d = data || getMindMapData();
        const pages = getMindMapPages(d);
        return pages.find(p => p && p.id === d.activePageId) || pages[0] || null;
    }

    function getAllMainChains(data = null) {
        const d = data || getMindMapData();
        if (Array.isArray(d.nodes) && d.nodes.length > 0) return d.nodes;
        return d.root ? [d.root] : [];
    }

    // options.render === false：只写数据、不整树重建
    function commitMindMapChange(mutatorFn, options = {}) {
        getMindMapData();
        const runMutator = () => {
            const data = getMindMapData();
            mutatorFn(data);
            if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
                if (data.root) data.nodes = [data.root];
            } else {
                data.root = data.nodes[0];
            }
            const activePage = getActiveMindMapPage(data);
            if (activePage) {
                activePage.nodes = data.nodes;
                activePage.root = data.root;
                data.page = activePage.page ?? null;
                data.zoom = activePage.zoom || currentZoom || 1.0;
            }
            state.annotations['mindmap'] = data;
        };

        if (typeof performAction === 'function') {
            performAction(runMutator, ['mindmap']);
        } else {
            runMutator();
            if (typeof updateSaveStatus === 'function') updateSaveStatus(true);
            if (typeof saveAnnotationsToStorage === 'function') saveAnnotationsToStorage();
        }
        if (options.render !== false) renderTree();
    }

    // 在单棵树（含并行分支 branches、合流节点 convergeChildren 与侧向子节点 children）内递归查找节点
    function findNodeInSingleRoot(node, id) {
        if (!node) return null;
        if (node.id === id) return node;
        if (Array.isArray(node.branches)) {
            for (const track of node.branches) {
                if (Array.isArray(track)) {
                    for (const bNode of track) {
                        const found = findNodeInSingleRoot(bNode, id);
                        if (found) return found;
                    }
                }
            }
        }
        if (Array.isArray(node.convergeChildren)) {
            for (const cNode of node.convergeChildren) {
                const found = findNodeInSingleRoot(cNode, id);
                if (found) return found;
            }
        }
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                const found = findNodeInSingleRoot(child, id);
                if (found) return found;
            }
        }
        return null;
    }

    // 树与多主链全局遍历查找
    function findNodeInTree(rootOrData, id) {
        if (!id) return null;
        if (rootOrData && Array.isArray(rootOrData.nodes)) {
            for (const chainRoot of rootOrData.nodes) {
                const found = findNodeInSingleRoot(chainRoot, id);
                if (found) return found;
            }
            return null;
        }
        const primaryRoot = (rootOrData && rootOrData.root) ? rootOrData.root : rootOrData;
        const foundInPrimary = findNodeInSingleRoot(primaryRoot, id);
        if (foundInPrimary) return foundInPrimary;

        // 同步在其余并列主链中检索
        const data = getMindMapData();
        if (data && Array.isArray(data.nodes)) {
            for (const chainRoot of data.nodes) {
                if (chainRoot === primaryRoot) continue;
                const found = findNodeInSingleRoot(chainRoot, id);
                if (found) return found;
            }
        }
        return null;
    }

    function findParentAndListInNode(curr, id, parent = null) {
        if (!curr) return null;
        if (curr.id === id) {
            return {
                parent,
                list: parent ? parent.children : null,
                index: parent && parent.children ? parent.children.indexOf(curr) : 0,
                node: curr,
                containerType: parent ? 'children' : 'root'
            };
        }
        // 搜索并行分叉轨道 branches
        if (Array.isArray(curr.branches)) {
            for (let tIdx = 0; tIdx < curr.branches.length; tIdx++) {
                const track = curr.branches[tIdx];
                if (!Array.isArray(track)) continue;
                for (let sIdx = 0; sIdx < track.length; sIdx++) {
                    if (track[sIdx].id === id) {
                        return {
                            parent: curr,
                            list: track,
                            index: sIdx,
                            trackIndex: tIdx,
                            branchesList: curr.branches,
                            isForkTrack: true,
                            node: track[sIdx],
                            containerType: 'fork-track'
                        };
                    }
                    const subRes = findParentAndListInNode(track[sIdx], id, curr);
                    if (subRes) return subRes;
                }
            }
        }
        // 搜索侧向并行分支合流节点 convergeChildren
        if (Array.isArray(curr.convergeChildren)) {
            for (let i = 0; i < curr.convergeChildren.length; i++) {
                if (curr.convergeChildren[i].id === id) {
                    return {
                        parent: curr,
                        list: curr.convergeChildren,
                        index: i,
                        node: curr.convergeChildren[i],
                        containerType: 'converge',
                        isConvergeList: true
                    };
                }
                const res = findParentAndListInNode(curr.convergeChildren[i], id, curr);
                if (res) return res;
            }
        }
        // 搜索常规子节点 children
        if (Array.isArray(curr.children)) {
            for (let i = 0; i < curr.children.length; i++) {
                if (curr.children[i].id === id) {
                    return {
                        parent: curr,
                        list: curr.children,
                        index: i,
                        node: curr.children[i],
                        containerType: 'children'
                    };
                }
                const res = findParentAndListInNode(curr.children[i], id, curr);
                if (res) return res;
            }
        }
        return null;
    }

    function findParentAndList(rootOrData, id, parent = null) {
        if (!id) return null;
        const data = (rootOrData && Array.isArray(rootOrData.nodes)) ? rootOrData : getMindMapData();
        const chains = getAllMainChains(data);
        const primaryRoot = (rootOrData && !Array.isArray(rootOrData.nodes) && !rootOrData.root)
            ? rootOrData
            : (chains[0] || null);

        // 检查是否为顶层主链根节点
        for (let cIdx = 0; cIdx < chains.length; cIdx++) {
            if (chains[cIdx] && chains[cIdx].id === id) {
                return {
                    parent: null,
                    list: data.nodes,
                    index: cIdx,
                    chainIndex: cIdx,
                    node: chains[cIdx],
                    containerType: 'chains'
                };
            }
        }

        if (primaryRoot) {
            const primaryRes = findParentAndListInNode(primaryRoot, id, parent);
            if (primaryRes) return primaryRes;
        }

        for (let cIdx = 0; cIdx < chains.length; cIdx++) {
            if (chains[cIdx] === primaryRoot) continue;
            const res = findParentAndListInNode(chains[cIdx], id, null);
            if (res) {
                res.chainIndex = cIdx;
                return res;
            }
        }
        return null;
    }

    // 判断节点是否处于纵向主干推演流（主链根、主干一级节点、或纵向主干的并行分叉轨道）
    function isVerticalSpineNode(data, nodeId) {
        if (!nodeId) return false;
        const d = (data && Array.isArray(data.nodes)) ? data : getMindMapData();
        const chains = getAllMainChains(d);
        if (chains.some(c => c && c.id === nodeId)) return true;
        const res = findParentAndList(d.root, nodeId);
        if (!res || !res.parent) return false;
        if (res.containerType === 'children' && chains.some(c => c && c.id === res.parent.id)) {
            return true;
        }
        if (res.containerType === 'fork-track') {
            return isVerticalSpineNode(d, res.parent.id);
        }
        return false;
    }

    function countNodesInSingle(node) {
        if (!node) return 0;
        let c = 1;
        if (Array.isArray(node.branches)) {
            for (const track of node.branches) {
                if (Array.isArray(track)) {
                    for (const bNode of track) c += countNodesInSingle(bNode);
                }
            }
        }
        if (Array.isArray(node.convergeChildren)) {
            for (const cNode of node.convergeChildren) c += countNodesInSingle(cNode);
        }
        if (Array.isArray(node.children)) {
            for (const ch of node.children) c += countNodesInSingle(ch);
        }
        return c;
    }

    function countCollapsedDescendants(node, isSpine) {
        if (!node) return 0;
        if (isSpine) {
            // 纵向主干阶段节点：折叠仅隐藏右侧横向论证子节点 (node.children) 及其下属所有后代，
            // 下方并行主链推演与支线 (node.branches) 仍保持展示，不计入此折叠数量。
            if (!Array.isArray(node.children) || node.children.length === 0) return 0;
            return node.children.reduce((sum, ch) => sum + countNodesInSingle(ch), 0);
        }
        // 侧向子节点：折叠隐藏右侧所有下属后代（包含子节点、侧向推演分支与合流节点）
        return Math.max(0, countNodesInSingle(node) - 1);
    }

    function countNodes(rootOrData) {
        if (!rootOrData) return 0;
        if (Array.isArray(rootOrData.nodes)) {
            return rootOrData.nodes.reduce((sum, ch) => sum + countNodesInSingle(ch), 0);
        }
        if (rootOrData.root) {
            return countNodesInSingle(rootOrData.root);
        }
        const data = getMindMapData();
        if (data && rootOrData === data.root && Array.isArray(data.nodes) && data.nodes.length > 1) {
            return data.nodes.reduce((sum, ch) => sum + countNodesInSingle(ch), 0);
        }
        return countNodesInSingle(rootOrData);
    }

    // 遍历所有节点
    function walkAllNodes(data, callback) {
        const chains = getAllMainChains(data);
        const visit = (node, depth = 0, chainIdx = 0) => {
            if (!node) return;
            callback(node, depth, chainIdx);
            if (Array.isArray(node.branches)) {
                node.branches.forEach(track => {
                    if (Array.isArray(track)) {
                        track.forEach(bNode => visit(bNode, depth + 1, chainIdx));
                    }
                });
            }
            if (Array.isArray(node.convergeChildren)) {
                node.convergeChildren.forEach(cNode => visit(cNode, depth + 1, chainIdx));
            }
            if (Array.isArray(node.children)) {
                node.children.forEach(ch => visit(ch, depth + 1, chainIdx));
            }
        };
        chains.forEach((chainRoot, cIdx) => visit(chainRoot, 0, cIdx));
    }

    // 查询所有汇入 targetNodeId 的上游合并/合流源节点
    function getIncomingMergeSources(data, targetNodeId) {
        const sources = [];
        walkAllNodes(data, (n) => {
            if ((Array.isArray(n.mergeTo) && n.mergeTo.includes(targetNodeId)) ||
                (Array.isArray(n.convergeTo) && n.convergeTo.includes(targetNodeId))) {
                sources.push(n);
            }
        });
        return sources;
    }

    // 判断一个节点是否为紧跟在分叉节点之后的自动合流节点
    function getForkConvergenceSources(data, nodeId) {
        const res = findParentAndList(data.root, nodeId);
        if (!res || !res.list) return [];
        // 情形 A：侧向子节点并行分支的右侧合流节点
        if (res.containerType === 'converge' && res.index === 0 && res.parent) {
            const owner = res.parent;
            if (Array.isArray(owner.branches) && owner.branches.length > 0 && owner.forkConverge !== false) {
                const tips = [];
                owner.branches.forEach(track => {
                    if (Array.isArray(track) && track.length > 0) {
                        tips.push(track[track.length - 1]);
                    }
                });
                return tips;
            }
            return [];
        }
        // 情形 B：纵向主干分叉汇入下一主干阶段节点（仅限纵向主干节点，避免侧向同级子节点误判）
        if (res.index <= 0) return [];
        if (!isVerticalSpineNode(data, nodeId)) return [];
        const prevNode = res.list[res.index - 1];
        if (prevNode && Array.isArray(prevNode.branches) && prevNode.branches.length > 0 && prevNode.forkConverge !== false) {
            const tips = [];
            prevNode.branches.forEach(track => {
                if (Array.isArray(track) && track.length > 0) {
                    tips.push(track[track.length - 1]);
                }
            });
            return tips;
        }
        return [];
    }

    function isNodeInSubtree(parent, searchId) {
        if (!parent) return false;
        if (parent.id === searchId) return true;
        if (Array.isArray(parent.branches)) {
            for (const track of parent.branches) {
                if (Array.isArray(track)) {
                    for (const bNode of track) {
                        if (isNodeInSubtree(bNode, searchId)) return true;
                    }
                }
            }
        }
        if (Array.isArray(parent.convergeChildren)) {
            for (const cNode of parent.convergeChildren) {
                if (isNodeInSubtree(cNode, searchId)) return true;
            }
        }
        if (Array.isArray(parent.children)) {
            for (const ch of parent.children) {
                if (isNodeInSubtree(ch, searchId)) return true;
            }
        }
        return false;
    }

    // 收集所有可以作为挂载父节点或合并目标的候选列表
    function getReparentCandidates(root, targetNodeId, includeSelfDescendants = false) {
        const candidates = [];
        const data = getMindMapData();
        const targetNode = findNodeInTree(data.root, targetNodeId);
        if (!targetNode) return candidates;

        walkAllNodes(data, (node, depth, chainIdx) => {
            if (node.id === targetNodeId) return;
            if (!includeSelfDescendants && isNodeInSubtree(targetNode, node.id)) return;
            candidates.push({
                id: node.id,
                text: node.text || (depth === 0 ? `主链 ${toRoman(chainIdx)}` : '未命名节点'),
                depth: depth,
                chainIdx: chainIdx
            });
        });
        return candidates;
    }

    // ==========================================
    // 2. 多主链增删、自由分支（Fork）与合并（Merge/Converge）
    // ==========================================

    // 新建一条并列主链
    function addMainChain(customTitle = null, insertAfterId = null) {
        const now = Date.now();
        const newChainId = 'mm_chain_' + now + '_' + Math.random().toString(36).slice(2, 5);
        const firstStepId = 'mm_' + now + '_s1_' + Math.random().toString(36).slice(2, 5);
        const hasCustomTitle = (typeof customTitle === 'string' && customTitle.trim().length > 0);

        commitMindMapChange((d) => {
            if (!Array.isArray(d.nodes)) d.nodes = d.root ? [d.root] : [];
            const nextIdx = d.nodes.length;
            const title = hasCustomTitle ? customTitle.trim() : `主链 ${toRoman(nextIdx)}：并行理论脉络`;
            const newChain = {
                id: newChainId,
                text: title,
                page: null,
                collapsed: false,
                mergeTo: [],
                children: [
                    {
                        id: firstStepId,
                        text: '§1 核心概念与起点',
                        tag: 'def',
                        page: null,
                        collapsed: false,
                        children: [],
                        branches: [],
                        mergeTo: []
                    }
                ]
            };
            if (insertAfterId) {
                const idx = d.nodes.findIndex(n => n && n.id === insertAfterId);
                if (idx !== -1) {
                    d.nodes.splice(idx + 1, 0, newChain);
                    d.root = d.nodes[0];
                    return;
                }
            }
            d.nodes.push(newChain);
            d.root = d.nodes[0];
        });

        selectedNodeId = newChainId;
        showMindmapToast('已新建并列主链', 'success');
        setTimeout(() => {
            const card = document.querySelector(`.mm-tree-branch[data-id="${newChainId}"] > .mm-card-wrapper > .mm-card`);
            if (card) {
                ensureNodeVisible(card);
                if (!hasCustomTitle) {
                    startEditingNode(newChainId);
                }
            }
        }, 50);
        return newChainId;
    }

    function addChildNode(parentId) {
        const data = getMindMapData();
        const pId = parentId || (data.root ? data.root.id : null);
        const newNodeId = 'mm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

        commitMindMapChange((d) => {
            const r = findParentAndList(d.root, pId);
            // 若当前节点处于侧向节点的横向并行分支轨道内，向右添加即沿该并行支线向右顺延推进
            if (r && r.containerType === 'fork-track' && r.parent && !isVerticalSpineNode(d, r.parent.id) && Array.isArray(r.list)) {
                r.list.splice(r.index + 1, 0, {
                    id: newNodeId,
                    text: '新建子节点',
                    page: null,
                    collapsed: false,
                    children: [],
                    branches: [],
                    mergeTo: []
                });
                return;
            }
            const parent = findNodeInTree(d.root, pId);
            if (!parent) return;
            if (!parent.children) parent.children = [];
            parent.children.push({
                id: newNodeId,
                text: '新建子节点',
                page: null, // 明确：默认不关联页码
                collapsed: false,
                children: [],
                branches: [],
                mergeTo: []
            });
            parent.collapsed = false;
        });

        selectedNodeId = newNodeId;
        setTimeout(() => {
            const card = document.querySelector(`.mm-tree-branch[data-id="${newNodeId}"] > .mm-card-wrapper > .mm-card`);
            if (card) {
                ensureNodeVisible(card);
                startEditingNode(newNodeId);
            }
        }, 50);
    }

    function addSiblingNode(nodeId) {
        const data = getMindMapData();
        const res = findParentAndList(data.root, nodeId);
        if (!res) {
            if (data.root) addChildNode(data.root.id);
            return;
        }

        // 若是某条主链的顶层根节点，向下推进即为在该主链添加主干节点
        if (res.containerType === 'chains') {
            addChildNode(nodeId);
            return;
        }

        const newNodeId = 'mm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        commitMindMapChange((d) => {
            const r = findParentAndList(d.root, nodeId);
            if (!r) return;
            // 若当前节点处于侧向节点的横向并行分支轨道内，向下添加即在下方并列新增一条并行支线
            if (r.containerType === 'fork-track' && r.parent && !isVerticalSpineNode(d, r.parent.id) && Array.isArray(r.branchesList)) {
                const nextTrackIdx = r.branchesList.length;
                const labelChar = String.fromCharCode(65 + (nextTrackIdx % 26));
                r.branchesList.splice(r.trackIndex + 1, 0, [
                    {
                        id: newNodeId,
                        text: `并行分支 ${labelChar}`,
                        tag: 'lemma',
                        page: null,
                        collapsed: false,
                        children: [],
                        branches: [],
                        mergeTo: []
                    }
                ]);
                return;
            }
            if (r.list) {
                r.list.splice(r.index + 1, 0, {
                    id: newNodeId,
                    text: '新建同级',
                    page: null, // 默认不关联页码
                    collapsed: false,
                    children: [],
                    branches: [],
                    mergeTo: []
                });
            }
        });

        selectedNodeId = newNodeId;
        setTimeout(() => {
            const card = document.querySelector(`.mm-tree-branch[data-id="${newNodeId}"] > .mm-card-wrapper > .mm-card`);
            if (card) {
                ensureNodeVisible(card);
                startEditingNode(newNodeId);
            }
        }, 50);
    }

    // 并行推演只用于纵向主链；横向子链通过普通子节点与自由合流展开。
    function forkNodeBranch(nodeId) {
        const data = getMindMapData();
        const targetId = nodeId || selectedNodeId || (data.root ? data.root.id : null);
        if (!targetId) return;

        const res = findParentAndList(data.root, targetId);
        if (!res || !res.node) return;
        if (!isVerticalSpineNode(data, targetId)) {
            showMindmapToast('横向子链：Tab 添加子节点，Enter 添加同级，多选后合流');
            return false;
        }

        const now = Date.now();
        let focusNodeId = null;

        commitMindMapChange((d) => {
            const node = findNodeInTree(d.root, targetId);
            if (!node) return;
            node.collapsed = false;

            if (!Array.isArray(node.branches) || node.branches.length === 0) {
                // 首次分叉：生成两条并行推演支线（支线 A 与 支线 B）
                const idA = 'mm_fork_' + now + '_a';
                const idB = 'mm_fork_' + now + '_b';
                node.branches = [
                    [{ id: idA, text: '并行分支 A', tag: 'lemma', page: null, collapsed: false, children: [], branches: [], mergeTo: [] }],
                    [{ id: idB, text: '并行分支 B', tag: 'lemma', page: null, collapsed: false, children: [], branches: [], mergeTo: [] }]
                ];
                if (node.forkConverge === undefined) node.forkConverge = true;
                focusNodeId = idA;
            } else {
                // 已有并行分叉：再追加一条并行分支轨道
                const idx = node.branches.length;
                const labelChar = String.fromCharCode(65 + (idx % 26));
                const idNext = 'mm_fork_' + now + '_' + idx;
                node.branches.push([
                    { id: idNext, text: `并行分支 ${labelChar}`, tag: 'lemma', page: null, collapsed: false, children: [], branches: [], mergeTo: [] }
                ]);
                focusNodeId = idNext;
            }
        });

        showMindmapToast('已开启并行分支轨道', 'success');
        if (focusNodeId) {
            selectedNodeId = focusNodeId;
            setTimeout(() => {
                const card = document.querySelector(`.mm-tree-branch[data-id="${focusNodeId}"] > .mm-card-wrapper > .mm-card`);
                if (card) {
                    ensureNodeVisible(card);
                    startEditingNode(focusNodeId);
                }
            }, 50);
        }
    }

    // 自由合流与连接下游子节点：
    // 支持：将多个子节点（或选中的任意节点）合流连接到已有的下一个子节点，或者一键创建进一步的新子节点并完成汇合连线
    function convergeNodesToNext(sourceNodeIds, existingTargetId = null) {
        const data = getMindMapData();
        const rawIds = Array.isArray(sourceNodeIds) ? sourceNodeIds : [sourceNodeIds];
        const validIds = [...new Set(rawIds.filter(id => id && findNodeInTree(data.root, id)))];
        if (validIds.length === 0) {
            showMindmapToast('请先选中至少一个要连接/汇合的子节点', 'warn');
            return;
        }

        // 情况 A：连入已有的目标节点（实线合流至下一个子节点）
        if (existingTargetId) {
            if (findNodeInTree(data.root, existingTargetId)) {
                let linkedCount = 0;
                commitMindMapChange((d) => {
                    validIds.forEach(srcId => {
                        if (srcId === existingTargetId) return;
                        const src = findNodeInTree(d.root, srcId);
                        if (!src) return;
                        if (!Array.isArray(src.convergeTo)) src.convergeTo = [];
                        if (!src.convergeTo.includes(existingTargetId)) {
                            src.convergeTo.push(existingTargetId);
                            linkedCount++;
                        }
                        // 确保清理旧版 mergeTo 中可能残留的同一目标，避免虚实线重叠
                        if (Array.isArray(src.mergeTo)) {
                            src.mergeTo = src.mergeTo.filter(id => id !== existingTargetId);
                        }
                    });
                });
                const tgt = findNodeInTree(data.root, existingTargetId);
                const tgtName = tgt ? (tgt.text || '目标节点').slice(0, 14) : '目标节点';
                showMindmapToast(`已将 ${validIds.length} 个子节点实线合流汇入「${tgtName}」`, 'success');
                selectNode(existingTargetId, true);
                return;
            }
        }

        // 情况 B：自动创建进一步的新子节点，并将选中的子节点全部实线合流汇入
        let createdNodeId = null;
        commitMindMapChange((d) => {
            const newId = 'mm_conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            createdNodeId = newId;
            const newNode = {
                id: newId,
                text: '进一步子节点',
                tag: 'thm',
                page: null,
                collapsed: false,
                children: [],
                branches: [],
                convergeTo: [],
                mergeTo: []
            };

            const nodeInfos = validIds.map(id => findParentAndList(d.root, id)).filter(Boolean);
            if (nodeInfos.length === 0) return;

            // 如果处于同一父级下，按在同级列表中的顺序排序，确保由排在最前的节点承载进一步子分支
            nodeInfos.sort((a, b) => {
                if (a.parent && b.parent && a.parent.id === b.parent.id) {
                    return a.index - b.index;
                }
                return 0;
            });

            // 承载节点挂载新子节点，并自动展开父级保证可见
            const leadInfo = nodeInfos[0];
            const leadNode = leadInfo.node;
            if (!Array.isArray(leadNode.children)) leadNode.children = [];
            leadNode.children.push(newNode);
            leadNode.collapsed = false;
            if (leadInfo.parent) leadInfo.parent.collapsed = false;

            // 所有其余选中的源节点均通过 convergeTo 实线合流汇入该进一步子节点
            validIds.forEach(id => {
                if (id === leadNode.id) return;
                const otherNode = findNodeInTree(d.root, id);
                if (!otherNode) return;
                if (!Array.isArray(otherNode.convergeTo)) otherNode.convergeTo = [];
                if (!otherNode.convergeTo.includes(newId)) {
                    otherNode.convergeTo.push(newId);
                }
                // 清理可能误存的 mergeTo
                if (Array.isArray(otherNode.mergeTo)) {
                    otherNode.mergeTo = otherNode.mergeTo.filter(mId => mId !== newId);
                }
            });
        });

        if (createdNodeId) {
            selectNode(createdNodeId, true);
            showMindmapToast(`已将 ${validIds.length} 个子节点实线合流至进一步子节点`, 'success');
            setTimeout(() => {
                const card = document.querySelector(`.mm-tree-branch[data-id="${createdNodeId}"] > .mm-card-wrapper > .mm-card`);
                if (card) {
                    ensureNodeVisible(card);
                    startEditingNode(createdNodeId);
                }
            }, 60);
        }
    }

    // 自由实线合流连线（切换 sourceId -> targetId 的实线合流）
    function toggleConvergeLink(sourceId, targetId) {
        if (!sourceId || !targetId || sourceId === targetId) return false;
        let actionType = 'added';

        commitMindMapChange((d) => {
            const src = findNodeInTree(d.root, sourceId);
            const tgt = findNodeInTree(d.root, targetId);
            if (!src || !tgt) return;
            if (!Array.isArray(src.convergeTo)) src.convergeTo = [];

            const existingIdx = src.convergeTo.indexOf(targetId);
            if (existingIdx !== -1) {
                src.convergeTo.splice(existingIdx, 1);
                actionType = 'removed';
            } else {
                src.convergeTo.push(targetId);
                actionType = 'added';
                // 清理旧版虚线连线避免重叠
                if (Array.isArray(src.mergeTo)) {
                    src.mergeTo = src.mergeTo.filter(id => id !== targetId);
                }
            }
        });

        const data = getMindMapData();
        const tgtNode = findNodeInTree(data.root, targetId);
        const tgtName = tgtNode ? (tgtNode.text || '目标节点').slice(0, 14) : '目标节点';
        if (actionType === 'added') {
            showMindmapToast(`已建立实线合流 →「${tgtName}」`, 'success');
        } else {
            showMindmapToast(`已解除与「${tgtName}」的实线合流`, 'info');
        }
        return actionType === 'added';
    }

    // 自由合流（Converge）：将并行分支、多选子节点或推演阶段汇合至下游节点
    function convergeBranches(nodeId) {
        if (selectedNodeIds.size > 1) {
            convergeNodesToNext(Array.from(selectedNodeIds));
            return;
        }

        const data = getMindMapData();
        const targetId = nodeId || selectedNodeId;
        if (!targetId) {
            showMindmapToast('请先选中一个分支节点以执行合流', 'warn');
            return;
        }

        const res = findParentAndList(data.root, targetId);
        if (!res) return;

        // 情形 1：当前节点自身带有并行分叉 (node.branches)，或当前节点位于某个并行分叉轨道内 (fork-track)
        let forkOwnerId = null;
        if (Array.isArray(res.node.branches) && res.node.branches.length > 0) {
            forkOwnerId = res.node.id;
        } else if (res.containerType === 'fork-track' && res.parent) {
            forkOwnerId = res.parent.id;
        }

        if (forkOwnerId) {
            let convergedNodeId = null;
            let isNewlyCreated = false;
            commitMindMapChange((d) => {
                const ownerRes = findParentAndList(d.root, forkOwnerId);
                if (!ownerRes || !ownerRes.node || !ownerRes.list) return;
                ownerRes.node.forkConverge = true;

                if (isVerticalSpineNode(d, forkOwnerId)) {
                    // 根节点的下游是本链首个阶段，不能把另一条独立主链当作结论。
                    const nextList = ownerRes.containerType === 'chains'
                        ? (ownerRes.node.children ||= []) : ownerRes.list;
                    const nextIndex = ownerRes.containerType === 'chains' ? 0 : ownerRes.index + 1;
                    const nextNode = nextList[nextIndex];
                    if (nextNode) {
                        convergedNodeId = nextNode.id;
                    } else {
                        convergedNodeId = 'mm_conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
                        isNewlyCreated = true;
                        nextList.splice(nextIndex, 0, {
                            id: convergedNodeId,
                            text: '汇合结论 / 主定理',
                            tag: 'thm',
                            page: null,
                            collapsed: false,
                            children: [],
                            branches: [],
                            mergeTo: []
                        });
                    }
                } else {
                    // 侧向子节点：在并行支线右侧创建或聚焦专属合流结论节点
                    if (!Array.isArray(ownerRes.node.convergeChildren)) {
                        ownerRes.node.convergeChildren = [];
                    }
                    if (ownerRes.node.convergeChildren.length > 0) {
                        convergedNodeId = ownerRes.node.convergeChildren[0].id;
                    } else {
                        convergedNodeId = 'mm_conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
                        isNewlyCreated = true;
                        ownerRes.node.convergeChildren.push({
                            id: convergedNodeId,
                            text: '汇合结论',
                            tag: 'thm',
                            page: null,
                            collapsed: false,
                            children: [],
                            branches: [],
                            mergeTo: []
                        });
                    }
                }
            });

            if (convergedNodeId) {
                selectedNodeId = convergedNodeId;
                showMindmapToast('已将各条并行分支合流至下游节点', 'success');
                setTimeout(() => {
                    const card = document.querySelector(`.mm-tree-branch[data-id="${convergedNodeId}"] > .mm-card-wrapper > .mm-card`);
                    if (card) {
                        ensureNodeVisible(card);
                        if (isNewlyCreated) {
                            startEditingNode(convergedNodeId);
                        }
                    }
                }, 50);
            }
            return;
        }

        // 情形 2：常规节点或跨主链节点 —— 启动交互式自由合并连线模式，让用户直接点选目标节点汇入
        startInteractiveMergeMode(targetId);
    }

    // 自由连线合并（切换 sourceId -> targetId 的汇合连线）
    function toggleMergeLink(sourceId, targetId) {
        if (!sourceId || !targetId || sourceId === targetId) return false;
        let actionType = 'added';

        commitMindMapChange((d) => {
            const src = findNodeInTree(d.root, sourceId);
            const tgt = findNodeInTree(d.root, targetId);
            if (!src || !tgt) return;
            if (!Array.isArray(src.mergeTo)) src.mergeTo = [];

            const existingIdx = src.mergeTo.indexOf(targetId);
            if (existingIdx !== -1) {
                src.mergeTo.splice(existingIdx, 1);
                actionType = 'removed';
            } else {
                src.mergeTo.push(targetId);
                actionType = 'added';
            }
        });

        const data = getMindMapData();
        const tgtNode = findNodeInTree(data.root, targetId);
        const tgtName = tgtNode ? (tgtNode.text || '目标节点').slice(0, 14) : '目标节点';
        if (actionType === 'added') {
            showMindmapToast(`已建立汇合连线 →「${tgtName}」`, 'success');
        } else {
            showMindmapToast(`已解除与「${tgtName}」的汇合连线`, 'info');
        }
        return actionType === 'added';
    }

    // 双节点融合合并（将 sourceId 的文本内容、子分支、页码与连线并入 targetId）
    function fuseNodeInto(sourceId, targetId) {
        if (!sourceId || !targetId || sourceId === targetId) return;
        const data = getMindMapData();
        const srcCheck = findNodeInTree(data.root, sourceId);
        const tgtCheck = findNodeInTree(data.root, targetId);
        if (!srcCheck || !tgtCheck) return;
        if (isNodeInSubtree(srcCheck, targetId)) {
            showMindmapToast('不能将父节点融合并入其自身子孙节点中', 'warn');
            return;
        }

        commitMindMapChange((d) => {
            const srcRes = findParentAndList(d.root, sourceId);
            const tgt = findNodeInTree(d.root, targetId);
            if (!srcRes || !srcRes.list || !tgt) return;

            if (srcRes.containerType === 'chains' && d.nodes.length <= 1) {
                return;
            }

            const [srcNode] = srcRes.list.splice(srcRes.index, 1);
            if (srcRes.containerType === 'fork-track' && srcRes.list.length === 0 && srcRes.branchesList) {
                srcRes.branchesList.splice(srcRes.trackIndex, 1);
            }

            // 合并文本
            const srcText = (srcNode.text || '').trim();
            const tgtText = (tgt.text || '').trim();
            if (srcText && srcText !== tgtText) {
                tgt.text = tgtText ? `${tgtText} ；${srcText}` : srcText;
            }
            if (!tgt.page && srcNode.page) tgt.page = srcNode.page;
            if (!tgt.tag && srcNode.tag) tgt.tag = srcNode.tag;

            // 迁移子节点与并行分叉
            if (Array.isArray(srcNode.children) && srcNode.children.length > 0) {
                if (!Array.isArray(tgt.children)) tgt.children = [];
                tgt.children.push(...srcNode.children);
            }
            if (Array.isArray(srcNode.branches) && srcNode.branches.length > 0) {
                if (!Array.isArray(tgt.branches)) tgt.branches = [];
                tgt.branches.push(...srcNode.branches);
            }
            if (Array.isArray(srcNode.convergeChildren) && srcNode.convergeChildren.length > 0) {
                if (!Array.isArray(tgt.convergeChildren)) tgt.convergeChildren = [];
                tgt.convergeChildren.push(...srcNode.convergeChildren);
            }
            if (Array.isArray(srcNode.convergeTo) && srcNode.convergeTo.length > 0) {
                if (!Array.isArray(tgt.convergeTo)) tgt.convergeTo = [];
                srcNode.convergeTo.forEach(cId => {
                    if (cId !== targetId && !tgt.convergeTo.includes(cId)) tgt.convergeTo.push(cId);
                });
            }
            if (Array.isArray(srcNode.mergeTo) && srcNode.mergeTo.length > 0) {
                if (!Array.isArray(tgt.mergeTo)) tgt.mergeTo = [];
                srcNode.mergeTo.forEach(mId => {
                    if (mId !== targetId && !tgt.mergeTo.includes(mId)) tgt.mergeTo.push(mId);
                });
            }

            // 重定向所有指向 sourceId 的外部汇合连线与合流连线
            walkAllNodes(d, (n) => {
                if (Array.isArray(n.mergeTo)) {
                    n.mergeTo = n.mergeTo
                        .map(id => (id === sourceId ? targetId : id))
                        .filter((id, idx, arr) => id !== n.id && arr.indexOf(id) === idx);
                }
                if (Array.isArray(n.convergeTo)) {
                    n.convergeTo = n.convergeTo
                        .map(id => (id === sourceId ? targetId : id))
                        .filter((id, idx, arr) => id !== n.id && arr.indexOf(id) === idx);
                }
            });
        });

        selectNode(targetId, false);
        showMindmapToast('已将两节点融合合并', 'success');
    }

    function deleteNode(nodeId) {
        const data = getMindMapData();
        const res = findParentAndList(data.root, nodeId);
        if (!res) return;

        // 顶层主链根节点的删除处理
        if (res.containerType === 'chains') {
            if (data.nodes.length > 1) {
                commitMindMapChange((d) => {
                    d.nodes.splice(res.index, 1);
                    d.root = d.nodes[0];
                    // 清理残留的跨链 mergeTo 与 convergeTo 引用
                    const validIds = new Set();
                    walkAllNodes(d, n => validIds.add(n.id));
                    walkAllNodes(d, n => {
                        if (Array.isArray(n.mergeTo)) {
                            n.mergeTo = n.mergeTo.filter(id => validIds.has(id));
                        }
                        if (Array.isArray(n.convergeTo)) {
                            n.convergeTo = n.convergeTo.filter(id => validIds.has(id));
                        }
                    });
                });
                if (selectedNodeId === nodeId) selectedNodeId = null;
                selectedNodeIds.delete(nodeId);
                showMindmapToast('已删除主链（Ctrl+Z 可撤销）');
            } else {
                if (confirm('是否清空思维导图并重置？')) {
                    commitMindMapChange((d) => {
                        d.root.text = state.fileName ? state.fileName.replace(/\.pdf$/i, '') : '思维导图';
                        d.root.page = null;
                        d.root.children = [];
                        d.root.branches = [];
                        d.root.convergeChildren = [];
                        d.root.convergeTo = [];
                        d.root.mergeTo = [];
                        d.nodes = [d.root];
                    });
                }
            }
            return;
        }

        commitMindMapChange((d) => {
            const r = findParentAndList(d.root, nodeId);
            if (r && r.list) {
                const delNode = r.node;
                const deletingIds = new Set();
                const collectSubIds = (n) => {
                    if (!n) return;
                    deletingIds.add(n.id);
                    (n.children || []).forEach(collectSubIds);
                    (n.convergeChildren || []).forEach(collectSubIds);
                    (n.branches || []).forEach(t => (t || []).forEach(collectSubIds));
                };
                collectSubIds(delNode);

                // 若被删节点的直接子节点被外部存活节点通过 convergeTo 共享引用，则将该共享结论过户给存活来源节点
                const directOwned = [...(delNode.children || []), ...(delNode.convergeChildren || [])];
                directOwned.forEach(ch => {
                    let survivingOwner = null;
                    walkAllNodes(d, n => {
                        if (!survivingOwner && !deletingIds.has(n.id) && Array.isArray(n.convergeTo) && n.convergeTo.includes(ch.id)) {
                            survivingOwner = n;
                        }
                    });
                    if (survivingOwner) {
                        survivingOwner.convergeTo = survivingOwner.convergeTo.filter(id => id !== ch.id);
                        if (!Array.isArray(survivingOwner.children)) survivingOwner.children = [];
                        if (!survivingOwner.children.some(c => c.id === ch.id)) {
                            survivingOwner.children.push(ch);
                        }
                    }
                });

                r.list.splice(r.index, 1);
                // 若并行分叉中的某条轨道已空，自动移除空轨道
                if (r.containerType === 'fork-track' && r.list.length === 0 && r.branchesList) {
                    r.branchesList.splice(r.trackIndex, 1);
                    if (r.branchesList.length === 0 && r.parent && Array.isArray(r.parent.convergeChildren) && r.parent.convergeChildren.length > 0) {
                        if (!Array.isArray(r.parent.children)) r.parent.children = [];
                        r.parent.children.push(...r.parent.convergeChildren);
                        r.parent.convergeChildren = [];
                    }
                }
            }
            // 同步清理指向已删除节点的 mergeTo 与 convergeTo 引用
            const validIds = new Set();
            walkAllNodes(d, n => validIds.add(n.id));
            walkAllNodes(d, n => {
                if (Array.isArray(n.mergeTo)) {
                    n.mergeTo = n.mergeTo.filter(id => validIds.has(id));
                }
                if (Array.isArray(n.convergeTo)) {
                    n.convergeTo = n.convergeTo.filter(id => validIds.has(id));
                }
            });
        });

        if (selectedNodeId === nodeId) selectedNodeId = null;
        selectedNodeIds.delete(nodeId);
        showMindmapToast('已删除节点（Ctrl+Z 可撤销）');
    }

    // 重新连接/更改归属（将节点挂载到新父节点下）
    function reparentNode(nodeId, newParentId) {
        if (!nodeId || !newParentId || nodeId === newParentId) return;
        commitMindMapChange((d) => {
            const res = findParentAndList(d.root, nodeId);
            const newParent = findNodeInTree(d.root, newParentId);
            if (!res || !newParent || !res.list) return;
            if (res.containerType === 'chains' && d.nodes.length <= 1) return;
            if (isNodeInSubtree(res.node, newParentId)) return;

            const [movingNode] = res.list.splice(res.index, 1);
            if (res.containerType === 'fork-track' && res.list.length === 0 && res.branchesList) {
                res.branchesList.splice(res.trackIndex, 1);
            }
            if (!newParent.children) newParent.children = [];
            newParent.children.push(movingNode);
            newParent.collapsed = false;
        });
        selectedNodeId = nodeId;
    }

    // 相对移动（用于拖拽调整主干/并行分支/侧枝的前后顺序）
    function moveNodeRelative(sourceId, targetId, pos = 'after') {
        if (!sourceId || !targetId || sourceId === targetId) return;
        commitMindMapChange((d) => {
            const sourceRes = findParentAndList(d.root, sourceId);
            const targetRes = findParentAndList(d.root, targetId);
            if (!sourceRes || !targetRes || !sourceRes.list || !targetRes.list) return;
            if (sourceRes.containerType === 'chains' && targetRes.containerType !== 'chains') return;
            if (isNodeInSubtree(sourceRes.node, targetId)) return;

            const [movingNode] = sourceRes.list.splice(sourceRes.index, 1);
            if (sourceRes.containerType === 'fork-track' && sourceRes.list.length === 0 && sourceRes.branchesList) {
                sourceRes.branchesList.splice(sourceRes.trackIndex, 1);
            }
            const targetIndex = targetRes.list.indexOf(targetRes.node);
            if (targetIndex === -1) {
                targetRes.list.push(movingNode);
            } else {
                const insertIdx = (pos === 'before') ? targetIndex : targetIndex + 1;
                targetRes.list.splice(insertIdx, 0, movingNode);
            }
        });
        selectedNodeId = sourceId;
    }

    // 检查同级节点是否可上移/下移（或并行轨道左移/右移）
    function canMoveNodeStep(data, nodeId, delta) {
        if (!nodeId || !delta) return false;
        const res = findParentAndList(data, nodeId);
        if (!res || !res.list) return false;
        const nextIdx = res.index + delta;
        if (nextIdx >= 0 && nextIdx < res.list.length) return true;
        if (res.containerType === 'fork-track' && res.branchesList && res.branchesList.length > 1) {
            const nextTrack = res.trackIndex + delta;
            return nextTrack >= 0 && nextTrack < res.branchesList.length;
        }
        return false;
    }

    // 同级节点顺序一键上移/下移（delta = -1 上移/前移，delta = 1 下移/后移）
    function moveNodeStep(nodeId, delta) {
        const data = getMindMapData();
        if (!canMoveNodeStep(data, nodeId, delta)) return false;
        commitMindMapChange((d) => {
            const res = findParentAndList(d.root, nodeId);
            if (!res || !res.list) return;
            const nextIdx = res.index + delta;
            if (nextIdx >= 0 && nextIdx < res.list.length) {
                const [item] = res.list.splice(res.index, 1);
                res.list.splice(nextIdx, 0, item);
            } else if (res.containerType === 'fork-track' && res.branchesList && res.branchesList.length > 1) {
                const nextTrack = res.trackIndex + delta;
                if (nextTrack >= 0 && nextTrack < res.branchesList.length) {
                    const [track] = res.branchesList.splice(res.trackIndex, 1);
                    res.branchesList.splice(nextTrack, 0, track);
                }
            }
        });
        selectNode(nodeId, false);
        return true;
    }

    // 检查节点是否可升级（提升到父节点的同级列表，置于父节点之后）
    function canPromoteNode(data, nodeId) {
        if (!nodeId) return false;
        const res = findParentAndList(data, nodeId);
        if (!res || !res.parent || res.containerType === 'chains') return false;
        const parentRes = findParentAndList(data, res.parent.id);
        return Boolean(parentRes && parentRes.list && parentRes.containerType !== 'chains');
    }

    // 节点升级（Alt+Left）：提升一层级，成为原父节点的后续同级节点
    function promoteNode(nodeId) {
        const data = getMindMapData();
        if (!canPromoteNode(data, nodeId)) return false;
        commitMindMapChange((d) => {
            const res = findParentAndList(d.root, nodeId);
            if (!res || !res.parent || !res.list) return;
            const parentRes = findParentAndList(d.root, res.parent.id);
            if (!parentRes || !parentRes.list || parentRes.containerType === 'chains') return;
            const [movingNode] = res.list.splice(res.index, 1);
            if (res.containerType === 'fork-track' && res.list.length === 0 && res.branchesList) {
                res.branchesList.splice(res.trackIndex, 1);
            }
            const pIdx = parentRes.list.indexOf(res.parent);
            parentRes.list.splice(pIdx >= 0 ? pIdx + 1 : parentRes.list.length, 0, movingNode);
        });
        selectNode(nodeId, false);
        showMindmapToast('已提升节点层级', 'success');
        return true;
    }

    // 检查节点是否可降级（移入紧邻的上一个同级节点的 children 中）
    function canDemoteNode(data, nodeId) {
        if (!nodeId) return false;
        const res = findParentAndList(data, nodeId);
        return Boolean(res && res.list && res.index > 0 && res.containerType !== 'chains');
    }

    // 节点降级（Alt+Right）：挂载到上一个同级节点之下成为其子节点
    function demoteNode(nodeId) {
        const data = getMindMapData();
        if (!canDemoteNode(data, nodeId)) return false;
        commitMindMapChange((d) => {
            const res = findParentAndList(d.root, nodeId);
            if (!res || !res.list || res.index <= 0 || res.containerType === 'chains') return;
            const prevSibling = res.list[res.index - 1];
            if (!prevSibling) return;
            const [movingNode] = res.list.splice(res.index, 1);
            if (!Array.isArray(prevSibling.children)) prevSibling.children = [];
            prevSibling.children.push(movingNode);
            prevSibling.collapsed = false;
        });
        selectNode(nodeId, false);
        showMindmapToast('已挂载为上一同级节点的子节点', 'success');
        return true;
    }

    function setNodeTag(nodeId, tagKey) {
        commitMindMapChange((data) => {
            const node = findNodeInTree(data.root, nodeId);
            if (node) {
                node.tag = (tagKey && MATH_TAGS[tagKey]) ? tagKey : null;
            }
        });
    }

    function toggleNodeCollapse(nodeId) {
        commitMindMapChange((data) => {
            const chains = getAllMainChains(data);
            const isChainRoot = chains.some(c => c.id === nodeId);
            if (isChainRoot) {
                const chainRoot = chains.find(c => c.id === nodeId);
                if (!chainRoot) return;
                chainRoot.collapsed = false;
                let anyCollapsed = false;
                const checkSub = (n) => {
                    if (n.collapsed) anyCollapsed = true;
                    if (Array.isArray(n.children)) n.children.forEach(checkSub);
                    if (Array.isArray(n.branches)) n.branches.forEach(t => t.forEach(checkSub));
                };
                (chainRoot.children || []).forEach(checkSub);
                const targetCollapse = !anyCollapsed;
                const applySub = (n) => {
                    const hasSub = (n.children && n.children.length > 0) || (n.branches && n.branches.length > 0);
                    if (hasSub) {
                        n.collapsed = targetCollapse;
                        if (n.children) n.children.forEach(applySub);
                        if (n.branches) n.branches.forEach(t => t.forEach(applySub));
                    }
                };
                (chainRoot.children || []).forEach(applySub);
                return;
            }

            const node = findNodeInTree(data.root, nodeId);
            if (node) {
                node.collapsed = !node.collapsed;
            }
        });
    }

    function toggleAllNodes(expand = null) {
        commitMindMapChange((data) => {
            const chains = getAllMainChains(data);
            if (chains.length === 0) return;

            let targetExpand = expand;
            if (targetExpand === null) {
                let anyCollapsed = false;
                walkAllNodes(data, (n, depth) => {
                    if (depth > 0 && n.collapsed) anyCollapsed = true;
                });
                targetExpand = anyCollapsed;
            }

            walkAllNodes(data, (n, depth) => {
                if (depth === 0) {
                    n.collapsed = false;
                } else {
                    const hasSub = (n.children && n.children.length > 0) || (n.branches && n.branches.length > 0);
                    n.collapsed = targetExpand ? false : (hasSub ? true : false);
                }
            });
            showMindmapToast(targetExpand ? '已展开所有分支' : '已折叠所有子分支', 'info');
        });
    }

    function setNodePage(nodeId, newPage) {
        commitMindMapChange((data) => {
            const node = findNodeInTree(data.root, nodeId);
            if (node) {
                node.page = (newPage && newPage > 0) ? parseInt(newPage, 10) : null;
            }
        });
    }

    // 为指定思维导图页设置或清除绑定的 PDF 页码（与节点页码绑定行为完全一致）
    function setMindMapPagePdfPage(pageId, newPage) {
        commitMindMapChange((data) => {
            const pages = getMindMapPages(data);
            const targetId = pageId || data.activePageId;
            const targetPage = pages.find(p => p && p.id === targetId) || getActiveMindMapPage(data);
            if (targetPage) {
                targetPage.page = (newPage && Number(newPage) > 0) ? parseInt(newPage, 10) : null;
                if (targetPage.id === data.activePageId) {
                    data.page = targetPage.page;
                }
            }
        });
    }

    // 新增一页思维导图并切换到新页
    function addMindMapPage(options = {}) {
        const opts = (typeof options === 'string') ? { title: options } : (options || {});
        if (editingNodeId) {
            const activeEditor = document.querySelector('.mm-inline-editor');
            if (activeEditor) activeEditor.blur();
        }
        stopInteractiveMergeMode();
        stopInteractiveReparentMode();
        closeAllPopovers();

        const curData = getMindMapData();
        const prevPage = getActiveMindMapPage(curData);
        if (prevPage) {
            prevPage.zoom = currentZoom;
            prevPage.panX = panX;
            prevPage.panY = panY;
        }

        let createdPage = null;
        commitMindMapChange((data) => {
            const pages = getMindMapPages(data);
            const nextIndex = pages.length;
            const pdfPage = (opts.page && Number(opts.page) > 0)
                ? parseInt(opts.page, 10)
                : ((opts.pdfPage && Number(opts.pdfPage) > 0) ? parseInt(opts.pdfPage, 10) : null);
            createdPage = createDefaultMindMapPage(nextIndex, {
                title: opts.title,
                page: pdfPage,
                rootText: opts.rootText
            });
            if (opts.insertAfterId) {
                const idx = pages.findIndex(p => p && p.id === opts.insertAfterId);
                if (idx !== -1) {
                    pages.splice(idx + 1, 0, createdPage);
                } else {
                    pages.push(createdPage);
                }
            } else {
                pages.push(createdPage);
            }
            data.activePageId = createdPage.id;
            data.nodes = createdPage.nodes;
            data.root = createdPage.root;
            data.page = createdPage.page;
            currentZoom = 1.0;
            data.zoom = 1.0;
        }, { render: false });

        if (!createdPage) return null;
        selectedNodeId = createdPage.root ? createdPage.root.id : null;
        selectedNodeIds = new Set(selectedNodeId ? [selectedNodeId] : []);
        renderTree();
        centerView(false, false);
        createdPage.panX = panX;
        createdPage.panY = panY;
        if (selectedNodeId) selectNode(selectedNodeId, false);
        showMindmapToast(
            createdPage.page
                ? `已新建「${createdPage.title}」并绑定第 ${createdPage.page} 页`
                : `已新建导图页「${createdPage.title}」`,
            'success'
        );
        return createdPage.id;
    }

    // 切换到指定的思维导图页
    function switchMindMapPage(pageId, options = {}) {
        if (!pageId) return false;
        if (editingNodeId) {
            const activeEditor = document.querySelector('.mm-inline-editor');
            if (activeEditor) activeEditor.blur();
        }
        stopInteractiveMergeMode();
        stopInteractiveReparentMode();
        closeAllPopovers();

        const data = getMindMapData();
        const pages = getMindMapPages(data);
        const targetPage = pages.find(p => p && p.id === pageId);
        if (!targetPage) return false;

        const prevPage = getActiveMindMapPage(data);
        if (prevPage && prevPage.id !== targetPage.id) {
            prevPage.zoom = currentZoom;
            prevPage.panX = panX;
            prevPage.panY = panY;
        }

        data.activePageId = targetPage.id;
        normalizeChainNodes(targetPage);
        data.nodes = targetPage.nodes;
        data.root = targetPage.root;
        data.page = targetPage.page ?? null;
        currentZoom = Number.isFinite(Number(targetPage.zoom))
            ? Math.min(2.5, Math.max(0.35, Number(targetPage.zoom)))
            : 1.0;
        data.zoom = currentZoom;

        selectedNodeId = null;
        selectedNodeIds.clear();

        const hasSavedPan = Number.isFinite(targetPage.panX) && Number.isFinite(targetPage.panY);
        if (hasSavedPan) {
            panX = targetPage.panX;
            panY = targetPage.panY;
        }

        renderTree();
        if (!hasSavedPan) {
            centerView(false, false);
            targetPage.panX = panX;
            targetPage.panY = panY;
        }

        if (typeof saveAnnotationsToStorage === 'function') {
            saveAnnotationsToStorage();
        }
        if (options.locatePdf && targetPage.page) {
            locatePdfPage(targetPage.page);
        }
        return true;
    }

    // 重命名思维导图页
    function renameMindMapPage(pageId, newTitle) {
        const trimmed = (typeof newTitle === 'string') ? newTitle.trim() : '';
        if (!trimmed) return false;
        const data = getMindMapData();
        const targetId = pageId || data.activePageId;
        const targetPage = getMindMapPages(data).find(p => p && p.id === targetId);
        if (!targetPage) return false;
        if (targetPage.title === trimmed) return true;

        commitMindMapChange((d) => {
            const p = getMindMapPages(d).find(item => item && item.id === targetId);
            if (p) p.title = trimmed;
        });
        return true;
    }

    // 删除或重置思维导图页
    function deleteMindMapPage(pageId, options = {}) {
        if (editingNodeId) {
            const activeEditor = document.querySelector('.mm-inline-editor');
            if (activeEditor) activeEditor.blur();
        }
        stopInteractiveMergeMode();
        stopInteractiveReparentMode();
        closeAllPopovers();

        const data = getMindMapData();
        const pages = getMindMapPages(data);
        const targetId = pageId || data.activePageId;
        const idx = pages.findIndex(p => p && p.id === targetId);
        if (idx === -1) return false;

        if (pages.length <= 1) {
            if (options.confirm !== false && typeof confirm === 'function') {
                if (!confirm('当前仅剩一页思维导图，是否清空重置本页内容？')) return false;
            }
            commitMindMapChange((d) => {
                const onlyPage = getMindMapPages(d)[0];
                const freshRoot = createDefaultRootNode();
                if (onlyPage) {
                    onlyPage.title = '第 1 页';
                    onlyPage.page = null;
                    onlyPage.root = freshRoot;
                    onlyPage.nodes = [freshRoot];
                    d.activePageId = onlyPage.id;
                }
                d.nodes = [freshRoot];
                d.root = freshRoot;
                d.page = null;
            });
            selectedNodeId = null;
            selectedNodeIds.clear();
            showMindmapToast('已重置当前思维导图页');
            return true;
        }

        const removedTitle = pages[idx].title || `第 ${idx + 1} 页`;
        commitMindMapChange((d) => {
            const list = getMindMapPages(d);
            const delIdx = list.findIndex(p => p && p.id === targetId);
            if (delIdx === -1 || list.length <= 1) return;
            list.splice(delIdx, 1);
            if (d.activePageId === targetId) {
                const nextActive = list[Math.min(delIdx, list.length - 1)] || list[0];
                if (nextActive) {
                    d.activePageId = nextActive.id;
                    normalizeChainNodes(nextActive);
                    d.nodes = nextActive.nodes;
                    d.root = nextActive.root;
                    d.page = nextActive.page ?? null;
                    currentZoom = Number.isFinite(Number(nextActive.zoom)) ? nextActive.zoom : 1.0;
                    d.zoom = currentZoom;
                    if (Number.isFinite(nextActive.panX) && Number.isFinite(nextActive.panY)) {
                        panX = nextActive.panX;
                        panY = nextActive.panY;
                    }
                }
            }
        });
        selectedNodeId = null;
        selectedNodeIds.clear();
        showMindmapToast(`已删除「${removedTitle}」（Ctrl+Z 可撤销）`);
        return true;
    }

    // 页签行内重命名输入框
    function startInlineRenamePageTab(pageId, tabEl = null) {
        const data = getMindMapData();
        const pageObj = getMindMapPages(data).find(p => p && p.id === pageId);
        if (!pageObj) return;
        const targetTab = tabEl || document.querySelector(`.mm-page-tab[data-page-id="${pageId}"]`);
        const titleEl = targetTab ? targetTab.querySelector('.mm-page-tab-title') : null;
        if (!titleEl) return;

        const existingInput = targetTab.querySelector('.mm-page-tab-rename-input');
        if (existingInput) {
            existingInput.focus();
            existingInput.select();
            return;
        }

        const originalTitle = pageObj.title || '第 1 页';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'mm-page-tab-rename-input';
        input.value = originalTitle;
        input.setAttribute('aria-label', '重命名思维导图页');

        titleEl.replaceWith(input);
        input.focus();
        input.select();

        let done = false;
        const finishRename = (save) => {
            if (done) return;
            done = true;
            const nextTitle = input.value.trim();
            if (save && nextTitle && nextTitle !== originalTitle) {
                renameMindMapPage(pageId, nextTitle);
                showMindmapToast(`已重命名为「${nextTitle}」`, 'success');
            } else {
                renderPagesBar(getMindMapData());
            }
        };

        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('dblclick', e => e.stopPropagation());
        input.addEventListener('mousedown', e => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                finishRename(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finishRename(false);
            }
        });
        input.addEventListener('blur', () => finishRename(true));
    }

    // ==========================================
    // 3. 定位 PDF、交互式合并连线与功能弹窗
    // ==========================================

    function locatePdfPage(pageNum) {
        if (!pageNum || pageNum < 1) return;
        const total = (state.pageDimensions && state.pageDimensions.length) || (state.pdfDoc ? state.pdfDoc.numPages : 9999);
        const target = Math.min(pageNum, total);

        if (typeof recordJumpPosition === 'function') {
            recordJumpPosition();
        }

        if (typeof scrollPdfPageIntoView === 'function') {
            scrollPdfPageIntoView(target, 'start');
        } else if (typeof pdfPageTop === 'function' && els.container) {
            els.container.scrollTo({ top: pdfPageTop(target), behavior: 'smooth' });
        }

        // 高亮目标页面以获得即时视觉反馈
        const wrapper = document.getElementById(`page-wrapper-${target}`);
        if (wrapper) {
            wrapper.classList.remove('page-locate-highlight');
            void wrapper.offsetWidth;
            wrapper.classList.add('page-locate-highlight');
            setTimeout(() => wrapper.classList.remove('page-locate-highlight'), 1300);
        }
    }

    // 启动交互式自由合并连线模式（支持单节点或多选节点批量连线，点击画布目标直接连线，或一键合流至新子节点）
    function startInteractiveMergeMode(sourceIds) {
        closeAllPopovers();
        stopInteractiveReparentMode();
        const data = getMindMapData();
        const raw = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
        const validIds = raw.filter(id => id && findNodeInTree(data.root, id));
        if (validIds.length === 0) {
            if (selectedNodeIds.size > 0) {
                validIds.push(...Array.from(selectedNodeIds).filter(id => findNodeInTree(data.root, id)));
            } else if (selectedNodeId && findNodeInTree(data.root, selectedNodeId)) {
                validIds.push(selectedNodeId);
            }
        }
        if (validIds.length === 0) return;

        mergingSourceNodeIds = validIds;
        mergingSourceNodeId = validIds[0];
        mergingTargetNodeId = null;
        mergeMouseX = 0;
        mergeMouseY = 0;
        const els = getEls();
        if (els.viewport) {
            els.viewport.classList.add('is-merging-mode');
        }

        document.querySelectorAll('.mm-card.mm-merge-source').forEach(c => c.classList.remove('mm-merge-source'));
        validIds.forEach(id => {
            const card = document.querySelector(`.mm-card[data-id="${id}"]`);
            if (card) card.classList.add('mm-merge-source');
        });

        // 顶部悬浮操作条
        let banner = document.getElementById('mm-merge-banner');
        if (banner) banner.remove();
        banner = document.createElement('div');
        banner.id = 'mm-merge-banner';

        const firstNode = findNodeInTree(data.root, validIds[0]);
        const shortName = validIds.length > 1
            ? `选中的 ${validIds.length} 个子节点`
            : `「${(firstNode?.text || '当前节点').slice(0, 10)}」`;

        banner.innerHTML = `
            <i class="ph ph-git-merge text-indigo-600 text-sm"></i>
            <span class="mm-merge-instruction" title="${escapeMindMapText(shortName)}">选择连线目标${validIds.length > 1 ? ` · ${validIds.length} 个来源` : ''}</span>
            <button type="button" id="mm-banner-converge-btn" class="mm-text-tool">
                <i class="ph ph-plus"></i><span>新建合流</span>
            </button>
            <button type="button" id="mm-banner-list-btn" class="mm-text-tool">从列表选</button>
            <button type="button" id="mm-banner-cancel-btn" class="text-gray-400 hover:text-gray-700 p-0.5 rounded-full transition" title="取消 (Esc)"><i class="ph ph-x"></i></button>
        `;
        const hint = document.createElement('span');
        hint.id = 'mm-merge-target-hint';
        hint.setAttribute('role', 'status');
        hint.textContent = '点击目标完成连线 · Esc 取消';
        banner.appendChild(hint);

        if (els.viewport) {
            els.viewport.appendChild(banner);
        }

        const convBtn = banner.querySelector('#mm-banner-converge-btn');
        if (convBtn) {
            convBtn.onclick = (e) => {
                e.stopPropagation();
                const sources = [...mergingSourceNodeIds];
                stopInteractiveMergeMode();
                convergeNodesToNext(sources);
            };
        }
        const listBtn = banner.querySelector('#mm-banner-list-btn');
        if (listBtn) {
            listBtn.onclick = (e) => {
                e.stopPropagation();
                const anchor = document.querySelector(`.mm-card[data-id="${mergingSourceNodeId}"]`) || banner;
                const srcId = mergingSourceNodeId;
                stopInteractiveMergeMode();
                showMergePopover(srcId, anchor);
            };
        }
        const cancelBtn = banner.querySelector('#mm-banner-cancel-btn');
        if (cancelBtn) {
            cancelBtn.onclick = (e) => {
                e.stopPropagation();
                stopInteractiveMergeMode();
            };
        }
    }

    function stopInteractiveMergeMode() {
        mergingSourceNodeId = null;
        mergingSourceNodeIds = [];
        mergingTargetNodeId = null;
        mergeMouseX = 0;
        mergeMouseY = 0;
        if (mergePreviewFrame !== null) cancelAnimationFrame(mergePreviewFrame);
        mergePreviewFrame = null;
        const els = getEls();
        if (els.viewport) {
            els.viewport.classList.remove('is-merging-mode');
        }
        document.querySelectorAll('.mm-card.mm-merge-source').forEach(c => c.classList.remove('mm-merge-source'));
        document.querySelectorAll('.mm-card.mm-merge-target').forEach(c => c.classList.remove('mm-merge-target'));
        const banner = document.getElementById('mm-merge-banner');
        if (banner) banner.remove();
        document.querySelectorAll('.mm-connector-merge-preview').forEach(path => path.remove());
    }

    // 启动交互式更改挂载父节点模式（在画布上直接点击任意非下属节点即可完成挂载切换）
    function startInteractiveReparentMode(nodeId) {
        closeAllPopovers();
        stopInteractiveMergeMode();
        const data = getMindMapData();
        const targetId = nodeId || selectedNodeId;
        if (!targetId) return;
        const res = findParentAndList(data.root, targetId);
        if (!res || (res.containerType === 'chains' && data.nodes.length <= 1)) {
            showMindmapToast('主链根节点不可挂载到其他节点下', 'warn');
            return;
        }

        reparentingSourceNodeId = targetId;
        reparentingTargetNodeId = null;
        reparentMouseX = 0;
        reparentMouseY = 0;

        const els = getEls();
        if (els.viewport) {
            els.viewport.classList.add('is-reparenting-mode');
        }

        document.querySelectorAll('.mm-card.mm-reparent-source').forEach(c => c.classList.remove('mm-reparent-source'));
        const card = document.querySelector(`.mm-card[data-id="${targetId}"]`);
        if (card) card.classList.add('mm-reparent-source');

        let banner = document.getElementById('mm-reparent-banner');
        if (banner) banner.remove();
        banner = document.createElement('div');
        banner.id = 'mm-reparent-banner';

        const shortName = (res.node?.text || '当前节点').slice(0, 12);

        banner.innerHTML = `
            <i class="ph ph-arrow-bend-up-left text-amber-600 text-sm"></i>
            <span class="mm-merge-instruction" title="${escapeMindMapText(shortName)}">点击目标父节点挂载「${escapeMindMapText(shortName)}」</span>
            <button type="button" id="mm-reparent-list-btn" class="mm-text-tool">列表选择</button>
            <button type="button" id="mm-reparent-cancel-btn" class="text-gray-400 hover:text-gray-700 p-0.5 rounded-full transition" title="取消 (Esc)"><i class="ph ph-x"></i></button>
        `;
        const hint = document.createElement('span');
        hint.id = 'mm-reparent-target-hint';
        hint.style.cssText = 'flex-basis:100%;color:#64748b;font-size:10px;';
        hint.textContent = '直接点击画布上的新父节点完成挂载 · Alt+↑/↓ 调整同级顺序 · Esc 取消';
        banner.appendChild(hint);

        if (els.viewport) {
            els.viewport.appendChild(banner);
        }

        const listBtn = banner.querySelector('#mm-reparent-list-btn');
        if (listBtn) {
            listBtn.onclick = (e) => {
                e.stopPropagation();
                const anchor = document.querySelector(`.mm-card[data-id="${reparentingSourceNodeId}"]`) || banner;
                const src = reparentingSourceNodeId;
                stopInteractiveReparentMode();
                showReparentPopover(src, anchor);
            };
        }
        const cancelBtn = banner.querySelector('#mm-reparent-cancel-btn');
        if (cancelBtn) {
            cancelBtn.onclick = (e) => {
                e.stopPropagation();
                stopInteractiveReparentMode();
            };
        }
    }

    function stopInteractiveReparentMode() {
        reparentingSourceNodeId = null;
        reparentingTargetNodeId = null;
        reparentMouseX = 0;
        reparentMouseY = 0;
        if (reparentPreviewFrame !== null) cancelAnimationFrame(reparentPreviewFrame);
        reparentPreviewFrame = null;
        const els = getEls();
        if (els.viewport) {
            els.viewport.classList.remove('is-reparenting-mode');
        }
        document.querySelectorAll('.mm-card.mm-reparent-source').forEach(c => c.classList.remove('mm-reparent-source'));
        document.querySelectorAll('.mm-card.mm-reparent-target').forEach(c => c.classList.remove('mm-reparent-target'));
        const banner = document.getElementById('mm-reparent-banner');
        if (banner) banner.remove();
        document.querySelectorAll('.mm-connector-reparent-preview').forEach(path => path.remove());
    }

    // 弹出自由合并与汇合管理面板（支持：关联连线、分支合流、节点内容融合、解除已有连线）
    function showMergePopover(nodeId, anchorEl) {
        closeAllPopovers();
        activePopoverNodeId = nodeId;
        const data = getMindMapData();
        const node = findNodeInTree(data, nodeId);
        if (!node) return;
        const res = findParentAndList(data, nodeId);
        const candidates = getReparentCandidates(data, nodeId, true);
        const sources = new Set(selectedNodeIds.has(nodeId) ? selectedNodeIds : [nodeId]);
        sources.add(nodeId);
        const canConvergeFork = isVerticalSpineNode(data, nodeId)
            && (node.branches?.length || res?.containerType === 'fork-track');
        let mode = sources.size > 1 ? 'converge' : 'link';

        const pop = document.createElement('div');
        pop.id = 'mm-popover-dialog';
        pop.className = 'mm-connect-popover';
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', '连接节点');
        pop.style.width = '275px';
        pop.innerHTML = `
            <div class="mm-pop-header">
                <div class="mm-pop-title-wrap">
                    <i class="ph ph-link-simple text-blue-500 text-sm shrink-0"></i>
                    <h4 class="mm-pop-title">连接节点</h4>
                    <span class="mm-pop-node-chip truncate" title="${escapeMindMapText(node.text || '当前节点')}">${escapeMindMapText(node.text || '当前节点')}</span>
                </div>
                <button type="button" id="mm-pop-close" class="mm-pop-close-btn" aria-label="关闭连接面板"><i class="ph ph-x"></i></button>
            </div>
            <div class="mm-pop-tabs" role="tablist" aria-label="连接方式">
                <button type="button" role="tab" data-mode="link" class="mm-pop-tab ${mode === 'link' ? 'is-active' : ''}" aria-selected="${mode === 'link'}">连线</button>
                <button type="button" role="tab" data-mode="converge" class="mm-pop-tab ${mode === 'converge' ? 'is-active' : ''}" aria-selected="${mode === 'converge'}">合流</button>
                <button type="button" role="tab" data-mode="fuse" class="mm-pop-tab ${mode === 'fuse' ? 'is-active' : ''}" aria-selected="${mode === 'fuse'}">融合</button>
            </div>
            <div class="mm-pop-search-wrap">
                <div class="mm-pop-search-field">
                    <i class="ph ph-magnifying-glass mm-pop-search-icon"></i>
                    <input id="mm-connect-search" class="mm-pop-search-input" type="search" placeholder="搜索节点…" aria-label="搜索节点">
                </div>
                <button type="button" id="mm-pop-pick-canvas" class="mm-pop-canvas-btn" title="在画布上直接点击目标节点 (快捷键 M)">
                    <i class="ph ph-cursor-click"></i>
                    <span>点选</span>
                </button>
            </div>
            <div id="mm-merge-cand-list" class="mm-connect-list custom-scrollbar"></div>
            <button type="button" id="mm-pop-converge-next" class="mm-connect-primary"></button>
            ${canConvergeFork ? '<button type="button" id="mm-pop-converge-fork" class="mm-connect-secondary"><i class="ph ph-git-merge"></i> 合流当前并行分支</button>' : ''}
            <div id="mm-connect-existing" style="display:none;"></div>`;

        const list = pop.querySelector('#mm-merge-cand-list');
        const search = pop.querySelector('#mm-connect-search');
        const primary = pop.querySelector('#mm-pop-converge-next');
        const canvasPickBtn = pop.querySelector('#mm-pop-pick-canvas');

        function renderCandidates() {
            canvasPickBtn.style.display = mode === 'link' ? 'inline-flex' : 'none';
            primary.hidden = mode !== 'converge';
            primary.textContent = `合流为新阶段 · ${sources.size} 项`;

            list.replaceChildren();
            const choices = mode === 'converge'
                ? [{ id: nodeId, text: node.text || '当前节点', current: true }, ...candidates]
                : candidates;
            const query = search.value.trim().toLocaleLowerCase();
            choices.filter(c => String(c.text).toLocaleLowerCase().includes(query)).forEach(cand => {
                const row = document.createElement(mode === 'converge' ? 'label' : 'button');
                row.className = 'mm-connect-row';
                if (mode === 'converge') {
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = sources.has(cand.id);
                    checkbox.disabled = !!cand.current;
                    checkbox.onchange = () => {
                        if (checkbox.checked) sources.add(cand.id); else sources.delete(cand.id);
                        primary.textContent = `合流为新阶段 · ${sources.size} 项`;
                    };
                    row.appendChild(checkbox);
                } else {
                    row.type = 'button';
                    const linked = node.mergeTo?.includes(cand.id);
                    row.title = mode === 'fuse' ? '将当前节点内容移入此节点' : linked ? '解除此连线' : '连线到此节点';
                    row.onclick = () => {
                        closeAllPopovers();
                        if (mode === 'fuse') fuseNodeInto(nodeId, cand.id);
                        else toggleMergeLink(nodeId, cand.id);
                    };
                }
                const text = document.createElement('span');
                text.textContent = cand.text || '未命名节点';
                text.title = text.textContent;
                const context = document.createElement('small');
                context.textContent = cand.current ? '当前' : `主链 ${toRoman(cand.chainIdx)}`;
                row.append(text, context);

                if (mode === 'link') {
                    const linked = node.mergeTo?.includes(cand.id);
                    const actionBadge = document.createElement('span');
                    if (linked) {
                        actionBadge.className = 'mm-pop-linked-tag';
                        actionBadge.innerHTML = '<i class="ph ph-check"></i><span>已连</span>';
                    } else {
                        actionBadge.className = 'mm-pop-link-action';
                        actionBadge.textContent = '连接';
                    }
                    row.appendChild(actionBadge);
                } else if (mode === 'fuse') {
                    const actionBadge = document.createElement('span');
                    actionBadge.className = 'mm-pop-link-action';
                    actionBadge.style.background = '#fef3c7';
                    actionBadge.style.color = '#d97706';
                    actionBadge.textContent = '并入';
                    row.appendChild(actionBadge);
                }

                list.appendChild(row);
            });
            if (!list.children.length) list.innerHTML = '<p class="mm-pop-empty-text">无匹配节点</p>';
        }

        pop.querySelectorAll('[data-mode]').forEach(tab => {
            tab.onclick = () => {
                mode = tab.dataset.mode;
                pop.querySelectorAll('[data-mode]').forEach(t => {
                    const active = (t === tab);
                    t.setAttribute('aria-selected', String(active));
                    t.classList.toggle('is-active', active);
                });
                renderCandidates();
            };
        });
        search.oninput = renderCandidates;
        pop.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); closeAllPopovers(); anchorEl.focus?.({ preventScroll: true }); }
            const tab = e.target.closest('[data-mode]');
            if (tab && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                const tabs = [...pop.querySelectorAll('[data-mode]')];
                const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : 2)) % tabs.length];
                next.click(); next.focus();
            }
        });
        primary.onclick = () => { closeAllPopovers(); convergeNodesToNext([...sources]); };
        canvasPickBtn.onclick = () => {
            closeAllPopovers();
            startInteractiveMergeMode([...sources]);
        };
        const fork = pop.querySelector('#mm-pop-converge-fork');
        if (fork) fork.onclick = () => { closeAllPopovers(); convergeBranches(nodeId); };

        const links = [];
        getIncomingMergeSources(data, nodeId).forEach(src => links.push({
            source: src.id, target: nodeId, solid: src.convergeTo?.includes(nodeId), text: `← ${src.text || '节点'}`
        }));
        [['convergeTo', true], ['mergeTo', false]].forEach(([key, solid]) => {
            (node[key] || []).forEach(id => {
                const target = findNodeInTree(data, id);
                if (target) links.push({ source: nodeId, target: id, solid, text: `→ ${target.text || '节点'}` });
            });
        });
        if (links.length) {
            const bar = document.createElement('div');
            bar.className = 'mm-pop-links-bar';
            bar.innerHTML = '<span class="mm-pop-links-label">已连:</span>';
            links.forEach(link => {
                const chip = document.createElement('span');
                chip.className = 'mm-pop-chip';
                chip.title = `${link.solid ? '合流' : '引用'}：${link.text}`;
                const name = document.createElement('span');
                name.textContent = link.text.replace(/^[←→]\s*/, '');
                const del = document.createElement('button');
                del.type = 'button';
                del.setAttribute('aria-label', `解除连接：${link.text}`);
                del.innerHTML = '×';
                del.onclick = (e) => {
                    e.stopPropagation();
                    if (link.solid) toggleConvergeLink(link.source, link.target);
                    else toggleMergeLink(link.source, link.target);
                    closeAllPopovers();
                };
                chip.append(name, del);
                bar.appendChild(chip);
            });
            const existingWrap = pop.querySelector('#mm-connect-existing');
            existingWrap.style.display = 'block';
            existingWrap.replaceChildren(bar);
        }
        pop.querySelector('#mm-pop-close').onclick = closeAllPopovers;
        renderCandidates();
        document.body.appendChild(pop);
        const rect = anchorEl.getBoundingClientRect();
        pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12))}px`;
        pop.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - pop.offsetHeight - 12))}px`;
        setTimeout(() => window.addEventListener('click', onDocClickOutsidePopover, { capture: true }), 10);
    }

    // 弹出快捷修改页码气泡（支持节点与思维导图页绑定 PDF 页码）
    function showPagePickerPopover(targetId, anchorEl, options = {}) {
        closeAllPopovers();
        const isPageTarget = Boolean(options && options.targetType === 'page');
        activePopoverNodeId = targetId;
        const data = getMindMapData();
        const targetObj = isPageTarget
            ? (getMindMapPages(data).find(p => p && p.id === (targetId || data.activePageId)) || getActiveMindMapPage(data))
            : findNodeInTree(data, targetId);
        if (!targetObj) return;

        const pop = document.createElement('div');
        pop.id = 'mm-popover-dialog';
        pop.style.width = '296px';
        
        const curReadingPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
        const curAssignedPage = targetObj.page || '';
        const titleLabel = isPageTarget ? '设置导图页关联页码' : '设置关联页码';
        const chipLabel = isPageTarget ? (targetObj.title || '当前导图页') : '';

        pop.innerHTML = `
            <div class="mm-pop-header">
                <div class="mm-pop-title-wrap">
                    <i class="ph ph-link text-blue-500 text-base"></i>
                    <h4 class="mm-pop-title">${titleLabel}</h4>
                    ${chipLabel ? `<span class="mm-pop-node-chip truncate" title="${escapeMindMapText(chipLabel)}">${escapeMindMapText(chipLabel)}</span>` : ''}
                </div>
                <button type="button" id="mm-pop-close" class="mm-pop-close-btn" title="关闭"><i class="ph ph-x"></i></button>
            </div>
            <div style="padding: 12px 14px; display: flex; flex-direction: column; gap: 10px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 11.5px; color: #64748b; flex-shrink: 0;">PDF 页码:</span>
                    <input type="number" id="mm-pop-input" min="1" max="9999" value="${curAssignedPage}" placeholder="未关联页码" class="mm-pop-search-input" style="padding-left: 10px;">
                </div>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-top: 8px; border-top: 1px solid #f1f5f9;">
                    <button type="button" id="mm-pop-bind-cur" style="padding: 4px 8px; border-radius: 6px; border: 1px solid #bfdbfe; background: #eff6ff; color: #2563eb; font-size: 11px; font-weight: 500; cursor: pointer; transition: all 0.15s ease;">当前阅读页 (P. ${curReadingPage})</button>
                    <div style="display: flex; gap: 6px;">
                        <button type="button" id="mm-pop-clear" style="padding: 4px 8px; border-radius: 6px; border: none; background: transparent; color: #94a3b8; font-size: 11px; cursor: pointer;">清除</button>
                        <button type="button" id="mm-pop-ok" class="mm-connect-primary" style="margin: 0; padding: 5px 12px; font-size: 11px;">确定</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(pop);

        const safeAnchor = anchorEl || getEls().bindPageBtn || getEls().pagesBar || getEls().panel;
        const rect = safeAnchor ? safeAnchor.getBoundingClientRect() : { left: 60, top: 80, bottom: 110 };
        let left = rect.left;
        let top = rect.bottom + 6;
        if (left + 296 > window.innerWidth) left = window.innerWidth - 306;
        if (top + 160 > window.innerHeight) top = rect.top - 160;
        pop.style.left = `${Math.max(8, left)}px`;
        pop.style.top = `${Math.max(8, top)}px`;

        const input = pop.querySelector('#mm-pop-input');
        input.focus();
        input.select();

        const applyPageVal = (nextPage) => {
            if (isPageTarget) {
                setMindMapPagePdfPage(targetObj.id, nextPage);
                if (nextPage) {
                    showMindmapToast(`已将「${targetObj.title || '导图页'}」绑定至第 ${nextPage} 页`, 'success');
                } else {
                    showMindmapToast(`已取消「${targetObj.title || '导图页'}」的页码关联`);
                }
            } else {
                setNodePage(targetId, nextPage);
            }
        };

        const commit = () => {
            const val = input.value.trim();
            applyPageVal(val ? parseInt(val, 10) : null);
            closeAllPopovers();
        };

        pop.querySelector('#mm-pop-ok').onclick = commit;
        pop.querySelector('#mm-pop-bind-cur').onclick = () => {
            applyPageVal(curReadingPage);
            closeAllPopovers();
        };
        pop.querySelector('#mm-pop-clear').onclick = () => {
            applyPageVal(null);
            closeAllPopovers();
        };
        pop.querySelector('#mm-pop-close').onclick = closeAllPopovers;

        input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); closeAllPopovers(); }
        };

        setTimeout(() => {
            window.addEventListener('click', onDocClickOutsidePopover, { capture: true });
        }, 10);
    }

    function showMindMapPagePickerPopover(pageId, anchorEl) {
        const targetId = pageId || getActiveMindMapPage()?.id;
        if (!targetId) return;
        showPagePickerPopover(targetId, anchorEl || getEls().bindPageBtn || getEls().pagesBar, { targetType: 'page' });
    }

    // 弹出设置数学理论角色标签弹窗
    function showTagPickerPopover(nodeId, anchorEl) {
        closeAllPopovers();
        const data = getMindMapData();
        const node = findNodeInTree(data, nodeId);
        if (!node) return;

        const pop = document.createElement('div');
        pop.id = 'mm-popover-dialog';
        pop.style.width = '300px';

        pop.innerHTML = `
            <div class="mm-pop-header">
                <div class="mm-pop-title-wrap">
                    <i class="ph ph-tag text-blue-500 text-base"></i>
                    <div>
                        <h4 class="mm-pop-title">数学理论角色</h4>
                        <p class="mm-pop-subtitle">标记该节点在推演论证中的角色定位</p>
                    </div>
                </div>
                <button type="button" id="mm-pop-close" class="mm-pop-close-btn" title="关闭"><i class="ph ph-x"></i></button>
            </div>
            <div style="padding: 12px 14px;">
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 10px;">
                    ${Object.entries(MATH_TAGS).map(([k, t]) => `
                        <button type="button" class="mm-tag-pick-btn mm-tag-${k} ${node.tag === k ? 'is-active' : ''}" data-key="${k}" style="padding: 6px 4px; border-radius: 6px; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; transition: all 0.15s ease;">
                            <i class="ph ${t.icon}"></i><span>${t.label}</span>
                        </button>
                    `).join('')}
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 8px; border-top: 1px solid #f1f5f9;">
                    <button type="button" id="mm-tag-clear" style="padding: 3px 8px; border-radius: 6px; border: none; background: transparent; color: #ef4444; font-size: 11px; cursor: pointer;">清除角色</button>
                    <span style="font-size: 10px; color: #94a3b8; font-family: monospace;">Math Logic</span>
                </div>
            </div>
        `;

        document.body.appendChild(pop);

        const rect = anchorEl.getBoundingClientRect();
        let left = rect.left;
        let top = rect.bottom + 6;
        if (left + 300 > window.innerWidth) left = window.innerWidth - 310;
        if (top + 220 > window.innerHeight) top = rect.top - 220;
        pop.style.left = `${Math.max(8, left)}px`;
        pop.style.top = `${Math.max(8, top)}px`;

        pop.querySelectorAll('.mm-tag-pick-btn').forEach(btn => {
            btn.onclick = () => {
                const k = btn.dataset.key;
                setNodeTag(nodeId, k);
                showMindmapToast(`已标记为「${MATH_TAGS[k].label}」`, 'success');
                closeAllPopovers();
            };
        });

        pop.querySelector('#mm-tag-clear').onclick = () => {
            setNodeTag(nodeId, null);
            showMindmapToast('已清除角色标签');
            closeAllPopovers();
        };

        pop.querySelector('#mm-pop-close').onclick = closeAllPopovers;

        setTimeout(() => {
            window.addEventListener('click', onDocClickOutsidePopover, { capture: true });
        }, 10);
    }

    // 弹出更换父节点弹窗
    function showReparentPopover(nodeId, anchorEl) {
        closeAllPopovers();
        activePopoverNodeId = nodeId;
        const data = getMindMapData();
        const node = findNodeInTree(data, nodeId);
        if (!node) return;
        const res = findParentAndList(data, nodeId);

        const candidates = getReparentCandidates(data, nodeId);

        if (candidates.length === 0) {
            showMindmapToast('当前没有其他可挂载的目标节点！', 'warn');
            return;
        }

        const pop = document.createElement('div');
        pop.id = 'mm-popover-dialog';
        pop.style.width = '290px';

        pop.innerHTML = `
            <div class="mm-pop-header">
                <div class="mm-pop-title-wrap">
                    <i class="ph ph-arrow-bend-up-left text-blue-500 text-sm shrink-0"></i>
                    <h4 class="mm-pop-title">选择新父节点</h4>
                    <span class="mm-pop-node-chip truncate" title="${escapeMindMapText(node.text || '当前节点')}">${escapeMindMapText(node.text || '当前节点')}</span>
                </div>
                <button type="button" id="mm-pop-close" class="mm-pop-close-btn" title="关闭"><i class="ph ph-x"></i></button>
            </div>
            <div class="mm-pop-search-wrap">
                <div class="mm-pop-search-field">
                    <i class="ph ph-magnifying-glass mm-pop-search-icon"></i>
                    <input id="mm-reparent-search" class="mm-pop-search-input" type="search" placeholder="搜索新父节点…" aria-label="搜索新父节点">
                </div>
                <button type="button" id="mm-reparent-pick-canvas" class="mm-pop-canvas-btn" title="在画布上直接点击新父节点 (快捷键 R)">
                    <i class="ph ph-cursor-click"></i>
                    <span>点选</span>
                </button>
            </div>
            <div id="mm-reparent-list" class="mm-connect-list custom-scrollbar" style="margin-bottom: 8px; max-height: 190px;"></div>
        `;

        const listEl = pop.querySelector('#mm-reparent-list');
        const searchInput = pop.querySelector('#mm-reparent-search');
        const currentParentId = res && res.parent ? res.parent.id : null;

        function renderReparentList() {
            listEl.replaceChildren();
            const q = searchInput.value.trim().toLocaleLowerCase();
            const filtered = candidates.filter(c => String(c.text || '').toLocaleLowerCase().includes(q));
            filtered.forEach(cand => {
                const isCurParent = (cand.id === currentParentId);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'mm-connect-row';
                btn.style.paddingLeft = `${Math.min(cand.depth, 4) * 11 + 8}px`;
                btn.innerHTML = `
                    <i class="ph ${cand.depth === 0 ? 'ph-compass' : 'ph-arrow-elbow-down-right'} text-gray-400 text-xs shrink-0"></i>
                    <span class="truncate">${escapeMindMapText(cand.text)}</span>
                    ${isCurParent ? '<small style="color:#2563eb;background:#eff6ff;">当前父级</small>' : `<small>主链 ${toRoman(cand.chainIdx)}</small>`}
                `;
                btn.onclick = () => {
                    reparentNode(nodeId, cand.id);
                    showMindmapToast(`已挂载至「${cand.text}」`, 'success');
                    closeAllPopovers();
                };
                listEl.appendChild(btn);
            });
            if (!listEl.children.length) {
                listEl.innerHTML = '<p class="mm-pop-empty-text">无匹配节点</p>';
            }
        }

        const canvasBtn = pop.querySelector('#mm-reparent-pick-canvas');
        if (canvasBtn) {
            canvasBtn.onclick = (ev) => {
                ev.stopPropagation();
                closeAllPopovers();
                startInteractiveReparentMode(nodeId);
            };
        }

        searchInput.oninput = renderReparentList;
        renderReparentList();

        document.body.appendChild(pop);

        const rect = anchorEl.getBoundingClientRect();
        let left = rect.left;
        let top = rect.bottom + 6;
        if (left + 295 > window.innerWidth) left = window.innerWidth - 305;
        if (top + pop.offsetHeight > window.innerHeight - 10) top = Math.max(8, rect.top - pop.offsetHeight - 6);
        pop.style.left = `${Math.max(8, left)}px`;
        pop.style.top = `${Math.max(8, top)}px`;

        pop.querySelector('#mm-pop-close').onclick = closeAllPopovers;

        setTimeout(() => {
            window.addEventListener('click', onDocClickOutsidePopover, { capture: true });
        }, 10);
    }

    function onDocClickOutsidePopover(e) {
        const pop = document.getElementById('mm-popover-dialog');
        const ctx = document.getElementById('mm-context-menu');
        const clickedInsidePop = pop && pop.contains(e.target);
        const clickedInsideCtx = ctx && ctx.contains(e.target);

        if (!clickedInsidePop && !clickedInsideCtx) {
            closeAllPopovers();
        }
    }

    function closeAllPopovers() {
        const pop = document.getElementById('mm-popover-dialog');
        if (pop) pop.remove();
        const ctx = document.getElementById('mm-context-menu');
        if (ctx) ctx.remove();
        activePopoverNodeId = null;
        window.removeEventListener('click', onDocClickOutsidePopover, { capture: true });
        window.removeEventListener('contextmenu', onDocClickOutsidePopover, { capture: true });
    }

    // 自定义卡片右键菜单
    function showCardContextMenu(e, nodeId) {
        e.preventDefault();
        e.stopPropagation();
        closeAllPopovers();
        if (!selectedNodeIds.has(nodeId)) {
            selectNode(nodeId, false);
        }

        const data = getMindMapData();
        const node = findNodeInTree(data.root, nodeId);
        if (!node) return;
        const res = findParentAndList(data.root, nodeId);
        const isChainRoot = (res && res.containerType === 'chains');
        const isPrimaryRoot = (data.root && data.root.id === nodeId && getAllMainChains(data).length <= 1);
        const isVerticalMain = isVerticalSpineNode(data, nodeId);
        const curReadingPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
        const hasChildren = (node.children && node.children.length > 0) || (node.branches && node.branches.length > 0);

        const menu = document.createElement('div');
        menu.id = 'mm-context-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', '节点操作');

        let html = '';

        if (selectedNodeIds.size > 1) {
            html += `
                <div class="mm-menu-item font-semibold text-indigo-700 bg-indigo-50/70" data-action="converge-multi">
                    <div class="menu-left"><i class="ph ph-git-merge text-indigo-600"></i><span>合流所选 ${selectedNodeIds.size} 个子节点到新节点</span></div>
                    <span class="mm-menu-shortcut">Enter</span>
                </div>
                <div class="mm-menu-item text-indigo-700" data-action="merge-multi-interactive">
                    <div class="menu-left"><i class="ph ph-cursor-click text-indigo-600"></i><span>批量连线所选 ${selectedNodeIds.size} 个节点...</span></div>
                    <span class="mm-menu-shortcut">M</span>
                </div>
                <div class="mm-menu-divider"></div>
            `;
        }

        if (isVerticalMain) {
            html += `
                <div class="mm-menu-item" data-action="fork-branch">
                    <div class="menu-left"><i class="ph ph-git-fork text-blue-600"></i><span>向下拆分并行推演</span></div>
                    <span class="mm-menu-shortcut">Shift+Enter</span>
                </div>
            `;
        }

        html += `
            <div class="mm-menu-item" data-action="pick-tag">
                <div class="menu-left"><i class="ph ph-tag text-teal-600"></i><span>标记数学角色...</span></div>
            </div>
            <div class="mm-menu-item" data-action="bind-current">
                <div class="menu-left"><i class="ph ph-bookmark-simple text-blue-600"></i><span>${node.page === curReadingPage ? '解除绑定当前页' : `绑定当前页 (P. ${curReadingPage})`}</span></div>
                <span class="mm-menu-shortcut">P</span>
            </div>
            <div class="mm-menu-item" data-action="pick-page">
                <div class="menu-left"><i class="ph ph-link text-blue-500"></i><span>指定关联页码...</span></div>
            </div>
        `;

        if (!isChainRoot) {
            html += `
                <div class="mm-menu-item" data-action="reparent">
                    <div class="menu-left"><i class="ph ph-arrow-bend-up-left text-purple-500"></i><span>更改挂载父节点...</span></div>
                    <span class="mm-menu-shortcut">R</span>
                </div>
            `;
        }

        if (isChainRoot) {
            html += `
                <div class="mm-menu-item" data-action="add-main-chain">
                    <div class="menu-left"><i class="ph ph-plus-square text-blue-600"></i><span>新建一条并列主链</span></div>
                    <span class="mm-menu-shortcut">Alt+N</span>
                </div>
                <div class="mm-menu-item" data-action="toggle-all-branches">
                    <div class="menu-left"><i class="ph ph-arrows-in-line-vertical text-gray-500"></i><span>折叠/展开全部子分支</span></div>
                </div>
            `;
        } else if (hasChildren) {
            html += `
                <div class="mm-menu-item" data-action="toggle-collapse">
                    <div class="menu-left"><i class="ph ${node.collapsed ? 'ph-caret-right' : 'ph-caret-left'} text-gray-500"></i><span>${node.collapsed ? '展开下属分支' : '折叠下属分支'}</span></div>
                </div>
            `;
        }

        html += `
            <div class="mm-menu-divider"></div>
            <div class="mm-menu-item danger" data-action="delete">
                <div class="menu-left"><i class="ph ph-trash text-red-500"></i><span>${isPrimaryRoot ? '清空重置导图' : (isChainRoot ? '删除整条主链' : '删除节点')}</span></div>
                <span class="mm-menu-shortcut">Del</span>
            </div>
        `;

        menu.innerHTML = html;
        menu.querySelectorAll('.mm-menu-item').forEach(item => {
            item.tabIndex = 0;
            item.setAttribute('role', 'menuitem');
        });
        menu.addEventListener('keydown', event => {
            event.stopPropagation();
            const items = [...menu.querySelectorAll('.mm-menu-item')];
            const index = items.indexOf(document.activeElement);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                items[index]?.click();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                closeAllPopovers();
                getEls().treeRoot.querySelector(`.mm-card[data-id="${nodeId}"]`)?.focus({ preventScroll: true });
            }
        });
        document.body.appendChild(menu);

        const menuW = 216;
        const menuH = menu.offsetHeight || 260;
        let x = e.clientX;
        let y = e.clientY;
        if (x + menuW > window.innerWidth - 10) x = window.innerWidth - menuW - 10;
        if (y + menuH > window.innerHeight - 10) y = window.innerHeight - menuH - 10;
        menu.style.left = `${Math.max(10, x)}px`;
        menu.style.top = `${Math.max(10, y)}px`;

        menu.addEventListener('click', (ev) => {
            const item = ev.target.closest('.mm-menu-item');
            if (!item) return;
            const act = item.dataset.action;
            closeAllPopovers();

            const cardEl = document.querySelector(`.mm-tree-branch[data-id="${nodeId}"] > .mm-card-wrapper > .mm-card`);
            if (act === 'converge-multi') convergeNodesToNext(Array.from(selectedNodeIds));
            else if (act === 'merge-multi-interactive') startInteractiveMergeMode(Array.from(selectedNodeIds));
            else if (act === 'fork-branch') forkNodeBranch(nodeId);
            else if (act === 'add-main-chain') addMainChain();
            else if (act === 'bind-current') {
                if (node.page === curReadingPage) {
                    setNodePage(nodeId, null);
                    showMindmapToast('已取消页码关联');
                } else {
                    setNodePage(nodeId, curReadingPage);
                    showMindmapToast(`已绑定第 ${curReadingPage} 页`, 'success');
                }
            }
            else if (act === 'pick-page') {
                if (cardEl) showPagePickerPopover(nodeId, cardEl);
            }
            else if (act === 'pick-tag') {
                if (cardEl) showTagPickerPopover(nodeId, cardEl);
            }
            else if (act === 'reparent') {
                if (cardEl) showReparentPopover(nodeId, cardEl);
            }
            else if (act === 'toggle-all-branches') toggleAllNodes(null);
            else if (act === 'toggle-collapse') toggleNodeCollapse(nodeId);
            else if (act === 'delete') deleteNode(nodeId);
        });

        setTimeout(() => {
            window.addEventListener('click', onDocClickOutsidePopover, { capture: true });
            window.addEventListener('contextmenu', onDocClickOutsidePopover, { capture: true });
        }, 10);
    }

    // 自定义思维导图页签右键菜单
    function showPageTabContextMenu(e, pageId) {
        e.preventDefault();
        e.stopPropagation();
        closeAllPopovers();

        const data = getMindMapData();
        const pages = getMindMapPages(data);
        const pageObj = pages.find(p => p && p.id === pageId);
        if (!pageObj) return;

        const curReadingPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
        const tabEl = document.querySelector(`.mm-page-tab[data-page-id="${pageId}"]`);

        const menu = document.createElement('div');
        menu.id = 'mm-context-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', '导图页操作');

        let html = `
            <div class="mm-menu-item" data-action="bind-current-page">
                <div class="menu-left"><i class="ph ph-bookmark-simple text-blue-600"></i><span>${pageObj.page === curReadingPage ? '解除绑定当前页' : `绑定当前页 (P. ${curReadingPage})`}</span></div>
                <span class="mm-menu-shortcut">P</span>
            </div>
            <div class="mm-menu-item" data-action="pick-pdf-page">
                <div class="menu-left"><i class="ph ph-link text-blue-500"></i><span>指定关联页码...</span></div>
            </div>
        `;
        if (pageObj.page) {
            html += `
                <div class="mm-menu-item" data-action="locate-pdf-page">
                    <div class="menu-left"><i class="ph ph-arrow-square-out text-indigo-600"></i><span>定位到关联页 (P. ${pageObj.page})</span></div>
                </div>
            `;
        }
        html += `
            <div class="mm-menu-divider"></div>
            <div class="mm-menu-item" data-action="rename-page">
                <div class="menu-left"><i class="ph ph-pencil-simple text-teal-600"></i><span>重命名导图页...</span></div>
                <span class="mm-menu-shortcut">双击</span>
            </div>
            <div class="mm-menu-item" data-action="add-page-after">
                <div class="menu-left"><i class="ph ph-plus-circle text-blue-600"></i><span>在右侧新建导图页</span></div>
                <span class="mm-menu-shortcut">Alt+T</span>
            </div>
            <div class="mm-menu-divider"></div>
            <div class="mm-menu-item danger" data-action="delete-page">
                <div class="menu-left"><i class="ph ph-trash text-red-500"></i><span>${pages.length > 1 ? '删除此导图页' : '清空重置此导图页'}</span></div>
            </div>
        `;

        menu.innerHTML = html;
        document.body.appendChild(menu);

        const menuW = 210;
        const menuH = menu.offsetHeight || 220;
        let x = e.clientX;
        let y = e.clientY;
        if (x + menuW > window.innerWidth - 10) x = window.innerWidth - menuW - 10;
        if (y + menuH > window.innerHeight - 10) y = window.innerHeight - menuH - 10;
        menu.style.left = `${Math.max(10, x)}px`;
        menu.style.top = `${Math.max(10, y)}px`;

        menu.addEventListener('click', (ev) => {
            const item = ev.target.closest('.mm-menu-item');
            if (!item) return;
            const act = item.dataset.action;
            closeAllPopovers();

            if (act === 'bind-current-page') {
                if (pageObj.page === curReadingPage) {
                    setMindMapPagePdfPage(pageId, null);
                    showMindmapToast(`已取消「${pageObj.title}」的页码关联`);
                } else {
                    setMindMapPagePdfPage(pageId, curReadingPage);
                    showMindmapToast(`已将「${pageObj.title}」绑定至第 ${curReadingPage} 页`, 'success');
                }
            } else if (act === 'pick-pdf-page') {
                showMindMapPagePickerPopover(pageId, tabEl || getEls().bindPageBtn);
            } else if (act === 'locate-pdf-page' && pageObj.page) {
                if (data.activePageId !== pageId) {
                    switchMindMapPage(pageId, { locatePdf: true });
                } else {
                    locatePdfPage(pageObj.page);
                }
            } else if (act === 'rename-page') {
                startInlineRenamePageTab(pageId, tabEl);
            } else if (act === 'add-page-after') {
                addMindMapPage({ insertAfterId: pageId });
            } else if (act === 'delete-page') {
                deleteMindMapPage(pageId);
            }
        });

        setTimeout(() => {
            window.addEventListener('click', onDocClickOutsidePopover, { capture: true });
            window.addEventListener('contextmenu', onDocClickOutsidePopover, { capture: true });
        }, 10);
    }

    // 自定义画布空白区右键菜单
    function showCanvasContextMenu(e) {
        if (e.target.closest('.mm-card') || e.target.closest('button') || e.target.closest('#mm-context-menu') || e.target.closest('#mm-popover-dialog')) return;
        e.preventDefault();
        closeAllPopovers();

        const activePage = getActiveMindMapPage();
        const curReadingPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;

        const menu = document.createElement('div');
        menu.id = 'mm-context-menu';

        menu.innerHTML = `
            <div class="mm-menu-item" data-action="add-chain">
                <div class="menu-left"><i class="ph ph-plus-circle text-blue-600"></i><span>新建并列主链</span></div>
                <span class="mm-menu-shortcut">Alt+N</span>
            </div>
            <div class="mm-menu-item" data-action="add-page">
                <div class="menu-left"><i class="ph ph-file-plus text-indigo-600"></i><span>新增思维导图页</span></div>
                <span class="mm-menu-shortcut">Alt+T</span>
            </div>
            <div class="mm-menu-item" data-action="bind-page-pdf">
                <div class="menu-left"><i class="ph ph-bookmark-simple text-blue-500"></i><span>${activePage && activePage.page === curReadingPage ? '解除本导图页当前页关联' : `本导图页绑定当前页 (P. ${curReadingPage})`}</span></div>
                <span class="mm-menu-shortcut">P</span>
            </div>
            <div class="mm-menu-item" data-action="pick-page-pdf">
                <div class="menu-left"><i class="ph ph-link text-blue-500"></i><span>设置本导图页关联页码...</span></div>
            </div>
            <div class="mm-menu-divider"></div>
            <div class="mm-menu-item" data-action="center">
                <div class="menu-left"><i class="ph ph-crosshair text-blue-500"></i><span>居中视野</span></div>
                <span class="mm-menu-shortcut">Ctrl+0</span>
            </div>
            <div class="mm-menu-item" data-action="fit">
                <div class="menu-left"><i class="ph ph-corners-out text-emerald-500"></i><span>自适应全图缩放</span></div>
            </div>
            <div class="mm-menu-item" data-action="reset-zoom">
                <div class="menu-left"><i class="ph ph-magnifying-glass text-indigo-500"></i><span>重置缩放到 100%</span></div>
            </div>
            <div class="mm-menu-divider"></div>
            <div class="mm-menu-item" data-action="expand-all">
                <div class="menu-left"><i class="ph ph-arrows-out-simple text-gray-600"></i><span>展开所有分支</span></div>
            </div>
            <div class="mm-menu-item" data-action="collapse-all">
                <div class="menu-left"><i class="ph ph-arrows-in-simple text-gray-600"></i><span>折叠所有分支</span></div>
            </div>
        `;

        document.body.appendChild(menu);

        const menuW = 210;
        const menuH = menu.offsetHeight || 240;
        let x = e.clientX;
        let y = e.clientY;
        if (x + menuW > window.innerWidth - 10) x = window.innerWidth - menuW - 10;
        if (y + menuH > window.innerHeight - 10) y = window.innerHeight - menuH - 10;
        menu.style.left = `${Math.max(10, x)}px`;
        menu.style.top = `${Math.max(10, y)}px`;

        menu.addEventListener('click', (ev) => {
            const item = ev.target.closest('.mm-menu-item');
            if (!item) return;
            const act = item.dataset.action;
            closeAllPopovers();

            if (act === 'add-chain') addMainChain();
            else if (act === 'add-page') addMindMapPage();
            else if (act === 'bind-page-pdf') {
                const cur = getActiveMindMapPage();
                if (!cur) return;
                if (cur.page === curReadingPage) {
                    setMindMapPagePdfPage(cur.id, null);
                    showMindmapToast(`已取消「${cur.title}」的页码关联`);
                } else {
                    setMindMapPagePdfPage(cur.id, curReadingPage);
                    showMindmapToast(`已将「${cur.title}」绑定至第 ${curReadingPage} 页`, 'success');
                }
            }
            else if (act === 'pick-page-pdf') {
                const cur = getActiveMindMapPage();
                if (cur) showMindMapPagePickerPopover(cur.id, getEls().bindPageBtn);
            }
            else if (act === 'center') centerView(true, false);
            else if (act === 'fit') centerView(true, true);
            else if (act === 'reset-zoom') applyZoom(1.0);
            else if (act === 'expand-all') toggleAllNodes(true);
            else if (act === 'collapse-all') toggleAllNodes(false);
        });

        setTimeout(() => {
            window.addEventListener('click', onDocClickOutsidePopover, { capture: true });
            window.addEventListener('contextmenu', onDocClickOutsidePopover, { capture: true });
        }, 10);
    }

    // ==========================================
    // 4. 输入、KaTeX 数学公式与 TikZ 图形渲染
    // ==========================================

    function startEditingNode(nodeId) {
        const branchEl = document.querySelector(`.mm-tree-branch[data-id="${nodeId}"]`);
        if (!branchEl) return;
        const cardEl = branchEl.querySelector(':scope > .mm-card-wrapper > .mm-card');
        const bodyEl = cardEl ? cardEl.querySelector('.mm-card-body') : null;
        if (!bodyEl) return;

        // 已在编辑同一节点（例如“单击已选中节点进入编辑”后紧跟 dblclick）：仅聚焦，不重建编辑器
        const existing = bodyEl.querySelector('.mm-inline-editor');
        if (existing) {
            existing.focus({ preventScroll: true });
            return;
        }

        const data = getMindMapData();
        const node = findNodeInTree(data, nodeId);
        if (!node) return;

        editingNodeId = nodeId;
        selectNode(nodeId, false);
        // 可拖拽祖先会吞掉 textarea 内的鼠标选字，编辑期间强制关闭
        cardEl.draggable = false;
        cardEl.classList.add('is-editing');

        bodyEl.innerHTML = '';
        const editorContainer = document.createElement('div');
        editorContainer.className = 'mm-editor-container';

        const textarea = document.createElement('textarea');
        textarea.className = 'mm-inline-editor';
        textarea.value = node.text || '';
        textarea.placeholder = '输入内容，支持 LaTeX 公式、TikZ 绘图与速录快捷键（如 mk, dm, beg, @a, fr...）';
        editorContainer.appendChild(textarea);

        const hint = document.createElement('div');
        hint.className = 'mm-editor-hint';
        hint.innerHTML = '<span>Shift+Enter 保存 · Enter 换行 · Esc 取消</span>';
        hint.title = 'Tab：跳到下一个公式占位 / 无占位时添加子节点\nShift+Enter / Ctrl+Enter 保存退出；Enter 换行；支持 LaTeX 公式、TikZ 绘图与速录（mk, dm, beg, fr...）';
        editorContainer.appendChild(hint);

        bodyEl.appendChild(editorContainer);
        const closeLivePreview = window.LatexLivePreview.open(textarea, cardEl);

        // 挂载与阅读器文本块共用的量子速录快捷键引擎 (QuantumSnippetEngine + LATEX_SNIPPETS)
        let snippetEngine = null;
        const snippets = (typeof LATEX_SNIPPETS !== 'undefined') ? LATEX_SNIPPETS : [];
        if (window.QuantumSnippetEngine && snippets.length > 0) {
            snippetEngine = new window.QuantumSnippetEngine(textarea, snippets, {
                onCommit: () => finish(true, true)
            });
        }

        // 自适应高度并实时更新贝塞尔连接线
        const autoHeight = () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.max(48, textarea.scrollHeight) + 'px';
            updateSvgConnections();
        };
        autoHeight();
        textarea.addEventListener('input', autoHeight);

        textarea.focus({ preventScroll: true });
        // 新建节点（占位文字）自动全选，方便直接覆盖输入；已有内容则把光标放到末尾，避免误删
        const originalText = node.text || '';
        const PLACEHOLDER_TEXTS = [
            '新建子节点', '新建同级', '进一步子节点', '推演结论', '未命名节点', '主逻辑分支 1', '主逻辑分支 2',
            '论证细节 / 辅助引理', '汇合定理 / 综合结论', '并行支线 1', '并行支线 2'
        ];
        const isPlaceholder = !originalText || PLACEHOLDER_TEXTS.includes(originalText) ||
            /^§\d+\s+主干推演阶段/.test(originalText) ||
            /^并行分支\s+[A-Z]$/.test(originalText) ||
            /^主链\s+[IVX\d]+：/.test(originalText);

        if (isPlaceholder) {
            textarea.select();
        } else {
            const len = textarea.value.length;
            textarea.setSelectionRange(len, len);
        }

        let committed = false;
        // 结束编辑：就地刷新该节点内容，不整树重建
        const finish = (save, refocus) => {
            if (committed) return;
            committed = true;
            closeLivePreview();
            editingNodeId = null;

            let finalText = originalText;
            if (save) {
                const trimmed = textarea.value.trim();
                const chains = getAllMainChains(data);
                const isRoot = chains.some(r => r && r.id === nodeId);
                finalText = trimmed || (isRoot ? '核心主题' : '未命名节点');
                if (finalText !== originalText) {
                    commitMindMapChange((d) => {
                        const n = findNodeInTree(d, nodeId);
                        if (n) n.text = finalText;
                    }, { render: false });
                }
            }

            if (bodyEl.isConnected) {
                renderNodeContent(bodyEl, finalText);
                cardEl.classList.remove('is-editing');
                cardEl.draggable = true;
                updateSvgConnections();
                requestAnimationFrame(updateSvgConnections);
                if (refocus) cardEl.focus({ preventScroll: true });
            } else {
                renderTree();
            }
        };

        textarea.addEventListener('keydown', (e) => {
            e.stopPropagation(); // 严格阻断冒泡，防止触发阅读器快捷键
            // 中文输入法组字过程中的 Enter/Esc 交给输入法，不视为提交
            if (e.isComposing || e.keyCode === 229) return;

            // 1. Ctrl+Enter / Cmd+Enter：兼容阅读器文本块快捷保存逻辑
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                finish(true, true);
                return;
            }

            // 2. Tab 键：优先由共用的 QuantumSnippetEngine 执行 LaTeX 占位符跳转（如 \dfrac{$0}{$1}）
            if (e.key === 'Tab') {
                if (snippetEngine && snippetEngine.hasActiveTabStops()) {
                    // 放行交给 QuantumSnippetEngine 的 keydown 监听器处理，光标跳入下一占位符，不退出编辑、不新建子节点
                    return;
                }
                // 无激活占位符时：保存当前内容并快速新建子节点（导图经典分级输入流程）
                e.preventDefault();
                finish(true, false);
                addChildNode(nodeId);
                return;
            }

            // 3. Enter 键与 Shift+Enter 键：Enter 换行，Shift+Enter 退出保存
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    // Shift+Enter：退出并保存
                    e.preventDefault();
                    finish(true, true);
                    return;
                }
                // 普通 Enter：正常换行（走原生 textarea 换行逻辑，并保证连接线自适应高度更新）
                requestAnimationFrame(autoHeight);
                return;
            }

            // 4. Escape 键：优先清除公式占位符跳跃点；若无跳跃点则取消编辑
            if (e.key === 'Escape') {
                e.preventDefault();
                if (snippetEngine && snippetEngine.hasActiveTabStops()) {
                    snippetEngine.clearTabStops();
                    return;
                }
                finish(false, true);
                return;
            }
        });

        textarea.addEventListener('keyup', (e) => e.stopPropagation());

        textarea.addEventListener('blur', () => {
            finish(true, false);
        });
    }

    let contentLayoutFrame = null;
    function scheduleContentLayout() {
        if (contentLayoutFrame !== null) return;
        contentLayoutFrame = requestAnimationFrame(() => {
            contentLayoutFrame = null;
            if (isMindmapOpen) updateSvgConnections();
        });
    }

    function renderNodeTikz(targetEl, code) {
        const figure = document.createElement('div');
        figure.className = 'mm-tikz ignored-by-katex';
        figure.textContent = '图形渲染中…';
        figure.setAttribute('role', 'status');
        figure.setAttribute('aria-busy', 'true');
        targetEl.appendChild(figure);

        const loadToken = state.loadToken;
        // 编辑、撤销、重建树或切换文档后，旧编译结果不能改写当前节点。
        const isCurrent = () => state.loadToken === loadToken && targetEl.contains(figure);
        const showError = message => {
            if (!isCurrent()) return;
            figure.classList.add('mm-tikz-error');
            figure.setAttribute('aria-busy', 'false');
            figure.textContent = '图形渲染失败：' + message;
            scheduleContentLayout();
        };
        const showResult = entry => {
            if (!isCurrent() || entry.status === 'pending') return;
            if (entry.status === 'error') {
                showError(entry.error || '请检查 LaTeX 语法或本地引擎日志');
                return;
            }
            const img = document.createElement('img');
            img.alt = 'TikZ 图形';
            img.draggable = false;
            img.onload = () => {
                if (!isCurrent() || !targetEl.isConnected) return;
                // 沿用文本块的图形字号比例，由 CSS 限制在卡片宽度内。
                img.style.width = (img.naturalWidth / 8) + 'em';
                scheduleContentLayout();
            };
            img.onerror = () => showError('图形加载失败，请检查本地引擎输出');
            figure.setAttribute('aria-busy', 'false');
            figure.replaceChildren(img);
            img.src = entry.dataUrl;
            scheduleContentLayout();
        };

        // 与文本块共用环境配置、宏包、编译接口和缓存；重复节点合并编译请求。
        const entry = window.TikzRender.requestTikzSvg(code, { extractBody: false }, settled => {
            if (targetEl.isConnected) showResult(settled);
        });
        showResult(entry);
    }

    function renderNodeContent(targetEl, text) {
        targetEl.innerHTML = '';
        if (!text || text.trim() === '') {
            targetEl.classList.add('mm-empty-prompt');
            targetEl.textContent = '双击编辑节点内容...';
            return;
        }
        targetEl.classList.remove('mm-empty-prompt');
        const source = String(text).replace(/\r\n?/g, '\n');
        const blocks = window.TikzRender ? window.TikzRender.scanTikzBlocks(source, false) : [];
        let offset = 0;
        blocks.forEach(block => {
            targetEl.appendChild(document.createTextNode(source.slice(offset, block.start)));
            renderNodeTikz(targetEl, block.code);
            offset = block.end;
        });
        targetEl.appendChild(document.createTextNode(source.slice(offset)));

        if (window.renderMathInElement) {
            try {
                window.renderMathInElement(targetEl, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$', right: '$', display: false },
                        { left: '\\(', right: '\\)', display: false },
                        { left: '\\[', right: '\\]', display: true }
                    ],
                    throwOnError: false,
                    strict: false,
                    ignoredClasses: ['ignored-by-katex']
                });
            } catch (err) {
                console.warn('KaTeX render warning:', err);
            }
        }
    }

    // ==========================================
    // 5. 树 DOM 构建：多主链、并行分支与跨链汇合体系
    // ==========================================

    function createBranchDOM(node, parentNode = null, level = 0, spineIndex = null, options = {}) {
        const isRoot = (level === 0);
        const isSpine = (level === 1);
        const chainIdx = options.chainIdx || 0;
        const forkLabel = options.forkLabel || null;
        const isLateralFork = !!options.isLateralFork;
        const hasForkBranches = Array.isArray(node.branches) && node.branches.some(t => Array.isArray(t) && t.length > 0);
        const data = getMindMapData();
        const incomingMerges = getIncomingMergeSources(data, node.id);
        const forkConvergenceSources = getForkConvergenceSources(data, node.id);
        const totalIncomingCount = incomingMerges.length + (forkConvergenceSources.length > 1 ? forkConvergenceSources.length : 0);

        const branchContainer = document.createElement('div');
        branchContainer.className = 'mm-tree-branch'
            + (isRoot ? ' mm-root-branch' : (isSpine ? ' mm-spine-branch' : ' mm-lateral-branch'))
            + (hasForkBranches ? ' has-fork' : '')
            + (node.children?.length && !node.collapsed ? ' has-children' : '')
            + (selectedNodeIds.has(node.id) ? ' is-selected-branch' : '');
        branchContainer.dataset.id = node.id;
        branchContainer.dataset.level = level;
        if (isRoot) {
            branchContainer.dataset.chainTheme = String(chainIdx % 5);
        }

        // 1. 卡片外包装 (包装卡片、折叠小按钮、悬浮快捷添加/分叉手柄)
        const cardWrapper = document.createElement('div');
        cardWrapper.className = 'mm-card-wrapper'
            + (isRoot ? ' mm-root-wrapper' : (isSpine ? ' mm-spine-wrapper' : ''))
            + (selectedNodeIds.has(node.id) ? ' is-selected-wrapper' : '');

        // 2. 卡片本体 (遵循阅读器严谨统一的设计规范)
        const card = document.createElement('div');
        card.className = 'mm-card'
            + (isRoot ? ' mm-root-card' : '')
            + (isSpine ? ' mm-spine-card' : '')
            + (forkLabel ? ' mm-fork-card' : '')
            + (selectedNodeIds.has(node.id) ? (selectedNodeIds.size > 1 ? ' selected is-multi-selected' : ' selected') : '')
            + (mergingSourceNodeId === node.id ? ' mm-merge-source' : '')
            + (reparentingSourceNodeId === node.id ? ' mm-reparent-source' : '');
        card.tabIndex = 0;
        card.dataset.id = node.id;
        card.dataset.level = level;
        card.draggable = true;

        // 拖拽移动/跨分支重挂载/合并支持
        card.addEventListener('dragstart', (e) => {
            if (card.classList.contains('is-editing') || mergingSourceNodeId || reparentingSourceNodeId) {
                e.preventDefault();
                return;
            }
            draggingNodeId = node.id;
            card.classList.add('dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', node.id);
            }
        });
        card.addEventListener('dragend', () => {
            draggingNodeId = null;
            card.classList.remove('dragging');
            document.querySelectorAll('.mm-card[data-drop-hint]').forEach(el => {
                el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-merge');
                delete el.dataset.dropHint;
            });
        });
        card.addEventListener('dragover', (e) => {
            if (!draggingNodeId || draggingNodeId === node.id) return;
            const dragSrcNode = findNodeInTree(data, draggingNodeId);
            if (dragSrcNode && isNodeInSubtree(dragSrcNode, node.id)) return;
            e.preventDefault();
            const rect = card.getBoundingClientRect();
            const relY = (e.clientY - rect.top) / Math.max(1, rect.height);
            card.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-merge');
            if (e.shiftKey) {
                card.classList.add('drag-over-merge');
                card.dataset.dropHint = '松开连线汇入';
            } else if (e.altKey || isRoot || (relY >= 0.28 && relY <= 0.72)) {
                card.classList.add('drag-over-child');
                card.dataset.dropHint = '移为子节点';
            } else if (relY < 0.28) {
                card.classList.add('drag-over-top');
                card.dataset.dropHint = '插入此节点之前';
            } else {
                card.classList.add('drag-over-bottom');
                card.dataset.dropHint = '插入此节点之后';
            }
        });
        card.addEventListener('dragleave', () => {
            card.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-merge');
            delete card.dataset.dropHint;
        });
        card.addEventListener('drop', (e) => {
            if (!draggingNodeId || draggingNodeId === node.id) return;
            const dragSrcNode = findNodeInTree(data, draggingNodeId);
            if (dragSrcNode && isNodeInSubtree(dragSrcNode, node.id)) return;
            e.preventDefault();
            e.stopPropagation();
            const srcId = draggingNodeId;
            const isChildDrop = card.classList.contains('drag-over-child');
            const isTopDrop = card.classList.contains('drag-over-top');
            card.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-merge');
            delete card.dataset.dropHint;
            draggingNodeId = null;

            if (e.shiftKey) {
                // Shift+拖拽释放：直接建立自由汇合连线
                toggleMergeLink(srcId, node.id);
            } else if (isChildDrop) {
                reparentNode(srcId, node.id);
                showMindmapToast(`已挂载至「${node.text || '节点'}」`, 'success');
            } else {
                moveNodeRelative(srcId, node.id, isTopDrop ? 'before' : 'after');
            }
        });

        // 点击选中；若处于交互式合并连线态或交互式挂载态，点击目标节点即完成操作
        card.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('.mm-inline-editor')) return;
            if (reparentingSourceNodeId) {
                e.stopPropagation();
                e.preventDefault();
                const srcId = reparentingSourceNodeId;
                const srcNode = findNodeInTree(data, srcId);
                if (srcId === node.id) {
                    stopInteractiveReparentMode();
                    showMindmapToast('已取消更改挂载');
                } else if (srcNode && isNodeInSubtree(srcNode, node.id)) {
                    showMindmapToast('不能挂载到自身的子孙节点下', 'warn');
                } else {
                    stopInteractiveReparentMode();
                    reparentNode(srcId, node.id);
                    showMindmapToast(`已挂载至「${node.text || '节点'}」`, 'success');
                }
                return;
            }
            if (mergingSourceNodeId || (mergingSourceNodeIds && mergingSourceNodeIds.length > 0)) {
                e.stopPropagation();
                e.preventDefault();
                const sources = (mergingSourceNodeIds && mergingSourceNodeIds.length > 0)
                    ? mergingSourceNodeIds
                    : [mergingSourceNodeId];
                if (sources.includes(node.id)) {
                    stopInteractiveMergeMode();
                    showMindmapToast('已取消合并连线模式');
                } else {
                    stopInteractiveMergeMode();
                    sources.forEach(srcId => toggleMergeLink(srcId, node.id));
                }
                return;
            }
            const wasSelected = (selectedNodeId === node.id);
            const isMulti = (e.ctrlKey || e.metaKey || e.shiftKey);
            selectNode(node.id, false, isMulti);
            if (!card.classList.contains('is-editing')) {
                card.focus({ preventScroll: true });
            }
            if (!isMulti && wasSelected && e.detail === 1 && e.target.closest('.mm-card-body')) {
                const sel = window.getSelection && window.getSelection();
                if (sel && !sel.isCollapsed && card.contains(sel.anchorNode)) return;
                startEditingNode(node.id);
            }
        });

        // 双击就地编辑
        card.addEventListener('dblclick', (e) => {
            if (e.target.closest('button') || e.target.closest('.mm-inline-editor')) return;
            e.stopPropagation();
            startEditingNode(node.id);
        });

        // 自定义右键菜单（编辑框内保留系统菜单，方便复制/粘贴）
        card.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.mm-inline-editor')) {
                e.stopPropagation();
                return;
            }
            if (mergingSourceNodeId || reparentingSourceNodeId) {
                e.preventDefault();
                e.stopPropagation();
                stopInteractiveMergeMode();
                stopInteractiveReparentMode();
                return;
            }
            showCardContextMenu(e, node.id);
        });

        // 卡片顶部信息与操作行
        const head = document.createElement('div');
        head.className = 'mm-card-head';

        const leftInfo = document.createElement('div');
        leftInfo.className = 'mm-card-left';

        // 根节点专属身份微标（支持多主链编号：主链 I、主链 II...）
        if (isRoot) {
            const rootBadge = document.createElement('span');
            rootBadge.className = 'mm-root-badge';
            const totalChains = getAllMainChains(data).length;
            rootBadge.title = totalChains > 1 ? `第 ${chainIdx + 1} 条独立主链（共 ${totalChains} 条主链）` : '核心主线 / 论文理论主题';
            rootBadge.innerHTML = `<i class="ph ph-git-commit"></i><span>${totalChains > 1 ? `主链 ${toRoman(chainIdx)}` : '主链 I'}</span>`;
            leftInfo.appendChild(rootBadge);
        }

        // 主干链里程碑序号徽标（已去除支线 ABCD 轨道标签）
        if (isSpine && spineIndex !== null && !forkLabel) {
            const spineBadge = document.createElement('span');
            spineBadge.className = 'mm-spine-index';
            spineBadge.title = `主链第 ${spineIndex + 1} 推演阶段`;
            spineBadge.textContent = `§${spineIndex + 1}`;
            leftInfo.appendChild(spineBadge);
        }

        // 数学理论角色标签徽标 (公理/定义/引理/定理/证明/推论/反例)
        if (node.tag && MATH_TAGS[node.tag]) {
            const tagDef = MATH_TAGS[node.tag];
            const tagBadge = document.createElement('button');
            tagBadge.type = 'button';
            tagBadge.className = `mm-math-tag mm-tag-${node.tag}`;
            tagBadge.title = `理论定位: ${tagDef.label} (点击更改)`;
            tagBadge.innerHTML = `<i class="ph ${tagDef.icon}"></i><span>${tagDef.label}</span>`;
            tagBadge.onclick = (e) => {
                e.stopPropagation();
                showTagPickerPopover(node.id, tagBadge);
            };
            leftInfo.appendChild(tagBadge);
        }

        // 页面 Badge：仅在指定了页码时显示，支持一键定位、双向联动与快速解绑
        if (node.page != null && node.page > 0) {
            const curReadingPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
            const isCurrent = (node.page === curReadingPage);

            const pageBadgeGroup = document.createElement('div');
            pageBadgeGroup.className = 'mm-page-badge-group' + (isCurrent ? ' is-active-page' : '');

            const pageBadge = document.createElement('button');
            pageBadge.type = 'button';
            pageBadge.className = 'mm-page-badge';
            pageBadge.title = `点击直达 PDF 第 ${node.page} 页（右键修改）`;
            pageBadge.innerHTML = `<i class="ph ph-bookmark-simple"></i><span>P.${node.page}${isCurrent ? ' · 当前' : ''}</span>`;
            pageBadge.onclick = (e) => {
                e.stopPropagation();
                locatePdfPage(node.page);
            };
            pageBadge.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                showPagePickerPopover(node.id, pageBadge);
            };
            pageBadgeGroup.appendChild(pageBadge);

            const clearPageBtn = document.createElement('button');
            clearPageBtn.type = 'button';
            clearPageBtn.className = 'mm-page-clear-btn';
            clearPageBtn.title = '解除该页码关联';
            clearPageBtn.innerHTML = '<i class="ph ph-x"></i>';
            clearPageBtn.onclick = (e) => {
                e.stopPropagation();
                setNodePage(node.id, null);
                showMindmapToast('已解除页码关联');
            };
            pageBadgeGroup.appendChild(clearPageBtn);

            leftInfo.appendChild(pageBadgeGroup);
        }

        if (leftInfo.children.length === 0) {
            head.classList.add('is-empty-head');
        }
        head.appendChild(leftInfo);

        // 纯图标快捷操作栏：同级上下移动、选新父节点、主节点向下拆分并行推演、连接汇合与更多菜单
        const actions = document.createElement('div');
        actions.className = 'mm-card-actions';

        if (!isRoot) {
            const canUp = canMoveNodeStep(data, node.id, -1);
            const canDown = canMoveNodeStep(data, node.id, 1);

            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.className = 'mm-act-btn mm-act-move-up';
            upBtn.disabled = !canUp;
            upBtn.title = '同级上移 (Alt+↑)';
            upBtn.setAttribute('aria-label', upBtn.title);
            upBtn.innerHTML = '<i class="ph ph-arrow-up"></i>';
            upBtn.onclick = (e) => {
                e.stopPropagation();
                moveNodeStep(node.id, -1);
            };
            actions.appendChild(upBtn);

            const downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.className = 'mm-act-btn mm-act-move-down';
            downBtn.disabled = !canDown;
            downBtn.title = '同级下移 (Alt+↓)';
            downBtn.setAttribute('aria-label', downBtn.title);
            downBtn.innerHTML = '<i class="ph ph-arrow-down"></i>';
            downBtn.onclick = (e) => {
                e.stopPropagation();
                moveNodeStep(node.id, 1);
            };
            actions.appendChild(downBtn);

            const reparentActBtn = document.createElement('button');
            reparentActBtn.type = 'button';
            reparentActBtn.className = 'mm-act-btn mm-act-reparent' + (reparentingSourceNodeId === node.id ? ' text-amber-600' : '');
            reparentActBtn.title = '选新父节点 (点击在画布点选目标父节点 / 快捷键 R)';
            reparentActBtn.setAttribute('aria-label', '选新父节点');
            reparentActBtn.innerHTML = '<i class="ph ph-arrow-bend-up-left"></i>';
            reparentActBtn.onclick = (e) => {
                e.stopPropagation();
                if (reparentingSourceNodeId === node.id) {
                    stopInteractiveReparentMode();
                    showMindmapToast('已退出更改挂载模式');
                } else {
                    startInteractiveReparentMode(node.id);
                }
            };
            actions.appendChild(reparentActBtn);
        }

        if (isRoot || isSpine) {
            const forkActBtn = document.createElement('button');
            forkActBtn.type = 'button';
            forkActBtn.className = 'mm-act-btn mm-act-fork';
            forkActBtn.title = '向下拆分并行推演 (Shift+Enter)';
            forkActBtn.setAttribute('aria-label', '向下拆分并行推演');
            forkActBtn.innerHTML = '<i class="ph ph-git-fork"></i>';
            forkActBtn.onclick = (e) => {
                e.stopPropagation();
                forkNodeBranch(node.id);
            };
            actions.appendChild(forkActBtn);
        }

        // 合并连线 / 汇合到其他节点
        const hasOutMerge = Array.isArray(node.mergeTo) && node.mergeTo.length > 0;
        const mergeActBtn = document.createElement('button');
        mergeActBtn.type = 'button';
        mergeActBtn.className = 'mm-act-btn mm-act-merge' + ((hasOutMerge || totalIncomingCount > 0) ? ' text-violet-600' : '');
        mergeActBtn.title = '连接节点：合流、连线与内容融合';
        mergeActBtn.setAttribute('aria-label', mergeActBtn.title);
        mergeActBtn.innerHTML = '<i class="ph ph-git-merge"></i>';
        mergeActBtn.onclick = (e) => {
            e.stopPropagation();
            showMergePopover(node.id, mergeActBtn);
        };
        actions.appendChild(mergeActBtn);

        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'mm-act-btn mm-act-more';
        moreBtn.title = '更多操作：新增、标签、页码、移动与删除';
        moreBtn.setAttribute('aria-label', '更多节点操作');
        moreBtn.setAttribute('aria-haspopup', 'menu');
        moreBtn.innerHTML = '<i class="ph ph-dots-three"></i>';
        moreBtn.onclick = (e) => {
            const rect = moreBtn.getBoundingClientRect();
            showCardContextMenu({ preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation(),
                clientX: rect.left, clientY: rect.bottom + 6 }, node.id);
            if (!e.detail) document.querySelector('#mm-context-menu .mm-menu-item')?.focus();
        };
        actions.appendChild(moreBtn);

        head.appendChild(actions);
        card.appendChild(head);

        // 卡片内容展示区（保留 card.draggable = true，支持从卡片任意区域拖拽重排或重挂载）
        const body = document.createElement('div');
        body.className = 'mm-card-body';
        renderNodeContent(body, node.text);
        card.appendChild(body);

        cardWrapper.appendChild(card);

        // 下方添加阶段 / 同级节点 (Enter)，右侧添加子节点 (Tab)。
        const quickAddDown = document.createElement('button');
        quickAddDown.type = 'button';
        quickAddDown.className = 'mm-quick-add-child mm-quick-add-down';
        quickAddDown.title = isRoot
            ? '向下开启主链第一个阶段 (Enter)'
            : (isSpine ? '向下推进下一阶段 (Enter)' : (isLateralFork ? '在下方并列新增一条并行支线 (Enter)' : '向下添加同级节点 (Enter)'));
        quickAddDown.innerHTML = '<i class="ph ph-plus"></i>';
        quickAddDown.onmousedown = (e) => e.stopPropagation();
        quickAddDown.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (isRoot) {
                addChildNode(node.id);
            } else {
                addSiblingNode(node.id);
            }
        };
        cardWrapper.appendChild(quickAddDown);

        // 悬浮快捷微按钮：右侧展开侧向论证分支 / 子节点 (Tab)；主链根节点右侧 + 号在右边新增并列主链
        const quickAddRight = document.createElement('button');
        quickAddRight.type = 'button';
        quickAddRight.className = 'mm-quick-add-sibling mm-quick-add-right';
        quickAddRight.title = isRoot
            ? '在右侧新建并列主链 (Tab)'
            : (isLateralFork ? '沿当前并行支线向右顺延节点 (Tab)' : '向右展开论证细节 / 侧向子分支 (Tab)');
        quickAddRight.innerHTML = '<i class="ph ph-plus"></i>';
        quickAddRight.onmousedown = (e) => e.stopPropagation();
        quickAddRight.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (isRoot) {
                addMainChain(null, node.id);
            } else {
                addChildNode(node.id);
            }
        };
        cardWrapper.appendChild(quickAddRight);

        // 折叠/展开胶囊按钮
        const hasChildren = node.children && node.children.length > 0;
        const hasLateralForkSub = !isRoot && !isSpine && hasForkBranches;
        if ((hasChildren || hasLateralForkSub) && !isRoot) {
            cardWrapper.classList.add('has-children', 'has-toggle');
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'mm-branch-toggle' + (node.collapsed ? ' is-collapsed' : '');
            toggleBtn.setAttribute('aria-expanded', String(!node.collapsed));
            const childCount = Math.max(1, countCollapsedDescendants(node, isSpine));
            toggleBtn.title = node.collapsed ? `已折叠 ${childCount} 个下属节点，点击展开` : '折叠右侧分支';
            toggleBtn.innerHTML = node.collapsed
                ? `<i class="ph ph-caret-right text-xs"></i><span>${childCount}</span>`
                : `<i class="ph ph-caret-left text-xs"></i>`;
            toggleBtn.onmousedown = (e) => e.stopPropagation();
            toggleBtn.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                toggleNodeCollapse(node.id);
            };
            cardWrapper.appendChild(toggleBtn);
        } else if (hasChildren && isRoot) {
            cardWrapper.classList.add('has-children');
        }

        branchContainer.appendChild(cardWrapper);

        // 子节点渲染：主链根节点的 children 构成纵向主干链；其他节点的 children 构成右侧横向论证分支
        if (hasChildren && !node.collapsed) {
            const childrenRow = document.createElement('div');
            if (isRoot) {
                childrenRow.className = 'mm-children-row mm-spine-column';
                node.children.forEach((child, idx) => {
                    childrenRow.appendChild(createBranchDOM(child, node, 1, idx, { chainIdx }));
                });
            } else {
                childrenRow.className = 'mm-children-row mm-lateral-column';
                node.children.forEach(child => {
                    childrenRow.appendChild(createBranchDOM(child, node, level + 1, null, { chainIdx }));
                });
            }
            branchContainer.appendChild(childrenRow);
        }

        // 并行分叉支线渲染：
        // - 纵向主干节点 (isRoot || isSpine)：在节点下方横向并列排布多条纵向推演支线
        // - 侧向子节点 (!isRoot && !isSpine)：在节点右侧纵向并列排布多条横向推演支线，并支持右侧合流节点
        if (hasForkBranches && (isRoot || isSpine)) {
            const forkRow = document.createElement('div');
            forkRow.className = 'mm-fork-branches-row';
            forkRow.dataset.forkOwnerId = node.id;

            node.branches.forEach((track, tIdx) => {
                if (!Array.isArray(track) || track.length === 0) return;
                const trackCol = document.createElement('div');
                trackCol.className = 'mm-fork-column';
                trackCol.dataset.trackIndex = String(tIdx);

                const trackLetter = String.fromCharCode(65 + (tIdx % 26));
                track.forEach((branchNode, bIdx) => {
                    const label = track.length > 1 ? `${trackLetter}${bIdx + 1}` : `支线 ${trackLetter}`;
                    trackCol.appendChild(createBranchDOM(branchNode, node, 1, bIdx, {
                        chainIdx,
                        forkLabel: label
                    }));
                });

                forkRow.appendChild(trackCol);
            });

            // 根节点先分叉，再汇入第一主干阶段；DOM 顺序也必须沿推演方向。
            if (isRoot) {
                branchContainer.insertBefore(forkRow, branchContainer.querySelector(':scope > .mm-children-row'));
            } else {
                branchContainer.appendChild(forkRow);
            }
        } else if (hasForkBranches && !isRoot && !isSpine && !node.collapsed) {
            const forkRow = document.createElement('div');
            forkRow.className = 'mm-fork-branches-row mm-lateral-fork-row';
            forkRow.dataset.forkOwnerId = node.id;

            const tracksWrap = document.createElement('div');
            tracksWrap.className = 'mm-lateral-fork-tracks';

            node.branches.forEach((track, tIdx) => {
                if (!Array.isArray(track) || track.length === 0) return;
                const trackCol = document.createElement('div');
                trackCol.className = 'mm-fork-column mm-lateral-fork-column';
                trackCol.dataset.trackIndex = String(tIdx);

                const trackLetter = String.fromCharCode(65 + (tIdx % 26));
                track.forEach((branchNode, bIdx) => {
                    const label = track.length > 1 ? `${trackLetter}${bIdx + 1}` : `支线 ${trackLetter}`;
                    trackCol.appendChild(createBranchDOM(branchNode, node, level + 1, bIdx, {
                        chainIdx,
                        forkLabel: label,
                        isLateralFork: true
                    }));
                });

                tracksWrap.appendChild(trackCol);
            });

            forkRow.appendChild(tracksWrap);

            if (node.forkConverge !== false && Array.isArray(node.convergeChildren) && node.convergeChildren.length > 0) {
                const convCol = document.createElement('div');
                convCol.className = 'mm-lateral-converge-col';
                node.convergeChildren.forEach((convNode, cIdx) => {
                    convCol.appendChild(createBranchDOM(convNode, node, level + 1, cIdx, { chainIdx }));
                });
                forkRow.appendChild(convCol);
            }

            branchContainer.appendChild(forkRow);
        }

        return branchContainer;
    }

    // ==========================================
    // 6. SVG 贝塞尔流线引擎：多主链、并行分叉合流与自由合并连线
    // ==========================================

    function prepareConvergenceLayouts(data) {
        convergenceLayouts = [];
        // 同一个横向论证区域改用分层排布，共享结论不再占据首个来源的子树高度。
        // 保留复杂并行轨道原有排布；它们的跨区域连接仍由 SVG 独立处理。
        const rows = [...getEls().treeRoot.querySelectorAll('.mm-lateral-column')];
        const nodes = new Map();
        walkAllNodes(data, node => nodes.set(node.id, node));
        for (const row of rows) {
            if (!row.isConnected || row.closest('.mm-convergence-layout') || row.querySelector('.has-fork')) continue;
            const branches = [...row.querySelectorAll('.mm-tree-branch')];
            const entries = new Map(branches.map((branch, order) => [branch.dataset.id, {
                id: branch.dataset.id, branch, order, parents: new Set(), next: new Set(), rank: 0
            }]));
            let shared = false;
            const connect = (source, target) => {
                if (!entries.has(target) || source.id === target) return;
                source.next.add(target);
                entries.get(target).parents.add(source.id);
            };
            entries.forEach(entry => {
                const node = nodes.get(entry.id);
                if (!node) return;
                if (!node.collapsed) (node.children || []).forEach(child => connect(entry, child.id));
                (node.convergeTo || []).forEach(id => {
                    if (entries.has(id)) { connect(entry, id); shared = true; }
                });
            });
            if (!shared) continue;
            const indegree = new Map([...entries].map(([id, entry]) => [id, entry.parents.size]));
            const ordered = [...entries.values()].filter(entry => !entry.parents.size);
            for (let i = 0; i < ordered.length; i++) {
                const entry = ordered[i];
                entry.next.forEach(id => {
                    const next = entries.get(id);
                    next.rank = Math.max(next.rank, entry.rank + 1);
                    indegree.set(id, indegree.get(id) - 1);
                    if (!indegree.get(id)) ordered.push(next);
                });
            }
            // 已有数据若含循环引用，保持原树视图，不隐藏节点。
            if (ordered.length !== entries.size) continue;
            branches.forEach(branch => branch.remove());
            row.replaceChildren();
            row.classList.add('mm-convergence-layout');
            ordered.forEach(entry => {
                entry.branch.querySelectorAll(':scope > .mm-children-row').forEach(el => el.remove());
                row.appendChild(entry.branch);
            });
            convergenceLayouts.push({ row, entries, ordered });
        }
        positionConvergenceLayouts();
    }

    function positionConvergenceLayouts() {
        for (const { row, entries, ordered } of convergenceLayouts) {
            if (!row.isConnected) continue;
            const columns = [];
            ordered.forEach(entry => {
                const card = entry.branch.querySelector(':scope > .mm-card-wrapper');
                entry.width = card.offsetWidth;
                entry.height = card.offsetHeight;
                (columns[entry.rank] ||= []).push(entry);
            });
            // 自右向左预估每个节点的独占子分支高度跨度，避免同一列中多子节点父卡片与相邻卡片挤在一起
            for (let r = columns.length - 1; r >= 0; r--) {
                const col = columns[r] || [];
                col.forEach(entry => {
                    const exclChildren = [...entry.next]
                        .map(id => entries.get(id))
                        .filter(ch => ch && ch.parents.size === 1);
                    if (exclChildren.length > 1) {
                        const chSpan = exclChildren.reduce((s, ch) => s + (ch.spanHeight || ch.height), 0)
                            + (exclChildren.length - 1) * 32;
                        entry.spanHeight = Math.max(entry.height, chSpan);
                    } else {
                        entry.spanHeight = entry.height;
                    }
                });
            }
            let x = 0;
            columns.forEach(column => {
                column.forEach(entry => {
                    entry.x = x;
                    const parents = [...entry.parents].map(id => entries.get(id));
                    entry.cy = parents.length
                        ? parents.reduce((sum, p) => sum + p.cy, 0) / parents.length
                        : 0;
                });
                column.sort((a, b) => a.cy - b.cy || a.order - b.order);
                // 多路输出围绕原中心展开，邻接卡片至少保留 32px 间隔。
                const desiredCenter = column.reduce((sum, e) => sum + e.cy, 0) / column.length;
                let bottom = -Infinity;
                column.forEach(entry => {
                    const halfSpan = (entry.spanHeight || entry.height) / 2;
                    entry.cy = Math.max(entry.cy, bottom + 32 + halfSpan);
                    bottom = entry.cy + halfSpan;
                });
                const shift = desiredCenter - column.reduce((sum, e) => sum + e.cy, 0) / column.length;
                column.forEach(entry => { entry.cy += shift; });
                x += Math.max(...column.map(entry => entry.width)) + 64;
            });
            const top = Math.min(...ordered.map(entry => entry.cy - entry.height / 2));
            const bottom = Math.max(...ordered.map(entry => entry.cy + entry.height / 2));
            ordered.forEach(entry => {
                entry.branch.style.left = `${entry.x}px`;
                entry.branch.style.top = `${entry.cy - entry.height / 2 - top}px`;
            });
            row.style.width = `${x - 64}px`;
            row.style.height = `${bottom - top}px`;
        }
    }

    function updateSvgConnections() {
        const els = getEls();
        if (!els.canvas || !els.treeRoot) return;
        positionConvergenceLayouts();

        let svg = els.svgCanvas || document.getElementById('mindmap-svg-canvas');
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.id = 'mindmap-svg-canvas';
            svg.setAttribute('class', 'pointer-events-none absolute inset-0 overflow-visible');
            svg.style.zIndex = '1';
            svg.style.width = '100%';
            svg.style.height = '100%';
            els.canvas.insertBefore(svg, els.treeRoot);
        }

        // 所有实线共用方向箭头；末端采用圆弧形设计 (⌒ 造型，而非尖锐角标 >)。
        svg.innerHTML = `<defs>${[
            ['mm-spine-arrow', 'var(--mm-flow-color)'], ['mm-spine-arrow-active', 'var(--mm-flow-active-color)'],
            ['mm-merge-arrow', '#818cf8'], ['mm-merge-arrow-active', '#4f46e5'],
            ['mm-reparent-arrow-active', '#d97706']
        ].map(([id, color]) => `<marker id="${id}" viewBox="0 0 10 10" refX="7.5" refY="5"
            markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M 1.5 1.5 C 5.5 2, 7.5 3.5, 7.5 5 C 7.5 6.5, 5.5 8, 1.5 8.5" fill="none" stroke="${color}"
                stroke-width="${id.endsWith('-active') ? '2' : '1.6'}" stroke-linecap="round" />
        </marker>`).join('')}</defs>`;

        const data = getMindMapData();
        const chains = getAllMainChains(data);
        if (!chains || chains.length === 0) return;

        const canvasRect = els.canvas.getBoundingClientRect();
        const zoom = currentZoom || 1.0;
        if (zoom <= 0) return;

        // 每轮只测量一次卡片；缩放后的坐标统一换回导图坐标。
        const cards = new Map();
        els.treeRoot.querySelectorAll('.mm-card').forEach(card => cards.set(card.dataset.id, card));
        const rects = new Map();
        function getCardEl(id) { return cards.get(id); }
        function bounds(el) {
            const r = el.getBoundingClientRect();
            return { left: (r.left - canvasRect.left) / zoom, right: (r.right - canvasRect.left) / zoom,
                top: (r.top - canvasRect.top) / zoom, bottom: (r.bottom - canvasRect.top) / zoom,
                cx: (r.left + r.width / 2 - canvasRect.left) / zoom,
                cy: (r.top + r.height / 2 - canvasRect.top) / zoom };
        }
        function cardBounds(id) {
            if (!rects.has(id) && cards.has(id)) rects.set(id, bounds(cards.get(id)));
            return rects.get(id);
        }
        function forkRow(id) {
            return getCardEl(id)?.closest('.mm-tree-branch')?.querySelector(':scope > .mm-fork-branches-row');
        }

        // 预收集每个节点的入向实线来源数（树父节点 + convergeTo），用于通道共享与防重叠避让
        const incomingCountMap = new Map();
        walkAllNodes(data, n => {
            (n.children || []).forEach(c => incomingCountMap.set(c.id, (incomingCountMap.get(c.id) || 0) + 1));
            (n.convergeTo || []).forEach(tId => incomingCountMap.set(tId, (incomingCountMap.get(tId) || 0) + 1));
        });

        // 垂直通道去重记录：不同来源且不同汇合目标的竖线段若在同列间隙发生 Y 区间重叠，自动错开车道 X 坐标
        const usedVerticalLanes = [];
        function allocateVerticalLane(baseX, y1, y2, fromId, toId, minX = -Infinity, maxX = Infinity) {
            const minY = Math.min(y1, y2);
            const maxY = Math.max(y1, y2);
            if (maxY - minY < 2) return baseX;
            const isSharedTarget = (incomingCountMap.get(toId) || 0) > 1;
            const groupKey = isSharedTarget ? `in:${toId}` : `out:${fromId}`;

            // 若同组（同一分叉源或同一合流目标）已分配过车道，直接复用以保持共享主干整洁汇合
            const existingSameGroup = usedVerticalLanes.find(l =>
                l.groupKey === groupKey && Math.abs(l.baseX - baseX) <= 8
            );
            if (existingSameGroup) {
                existingSameGroup.minY = Math.min(existingSameGroup.minY, minY);
                existingSameGroup.maxY = Math.max(existingSameGroup.maxY, maxY);
                return existingSameGroup.x;
            }

            let candidateX = baseX;
            const offsets = [0, -8, 7, -15, 13, -22];
            for (const off of offsets) {
                const testX = Math.max(minX, Math.min(maxX, baseX + off));
                const conflict = usedVerticalLanes.some(l =>
                    l.groupKey !== groupKey &&
                    Math.abs(l.x - testX) < 5.5 &&
                    Math.min(l.maxY, maxY) > Math.max(l.minY, minY) - 4
                );
                if (!conflict) {
                    candidateX = testX;
                    break;
                }
            }
            usedVerticalLanes.push({ baseX, x: candidateX, minY, maxY, groupKey });
            return candidateX;
        }

        // 检测折线段是否穿过无关卡片内部（用于跨阶段/跨列长连线自动绕障）
        const allCardBounds = [];
        cards.forEach((_, id) => {
            const b = cardBounds(id);
            if (b) allCardBounds.push({ id, ...b });
        });

        function segmentHitsAnyCard(x1, y1, x2, y2, ignoreId1, ignoreId2, pad = 4) {
            const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
            const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
            return allCardBounds.filter(c => {
                if (c.id === ignoreId1 || c.id === ignoreId2) return false;
                return maxX > c.left - pad && minX < c.right + pad &&
                       maxY > c.top - pad && minY < c.bottom + pad;
            });
        }

        function routeHitsObstacles(pts, fromId, toId) {
            const hits = [];
            for (let i = 0; i < pts.length - 1; i++) {
                const segHits = segmentHitsAnyCard(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], fromId, toId, 3);
                segHits.forEach(h => { if (!hits.some(x => x.id === h.id)) hits.push(h); });
            }
            return hits;
        }

        // 圆角折线沿布局留白走线。分叉共用出口，汇合共用入口，采用柔和圆弧过渡，末端留 5px 呼吸空间。
        function roundedRoute(points) {
            // 1. 消除极近重复点并拉直 <= 1.2px 的微像素抖动
            const raw = points.filter((p, i) => !i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) >= 0.4);
            if (raw.length === 0) return '';
            if (raw.length === 1) return `M ${raw[0].join(' ')}`;
            if (raw.length === 4) {
                // 横向微差校准：若起点与终点高度几乎一致 (<= 1.2px)，直接拉平中间转折，消除微小 S 弯
                if (Math.abs(raw[0][1] - raw[3][1]) <= 1.2 && raw[3][0] > raw[0][0]) {
                    return `M ${raw[0][0]} ${raw[0][1]} L ${raw[3][0]} ${raw[3][1]}`;
                }
                if (Math.abs(raw[0][0] - raw[3][0]) <= 1.2 && raw[3][1] > raw[0][1]) {
                    return `M ${raw[0][0]} ${raw[0][1]} L ${raw[3][0]} ${raw[3][1]}`;
                }
            }
            // 2. 合并共线中间顶点，确保圆角半径按完整直线段长度计算
            const clean = [raw[0]];
            for (let i = 1; i < raw.length - 1; i++) {
                const prev = clean[clean.length - 1], cur = raw[i], next = raw[i + 1];
                const dx1 = cur[0] - prev[0], dy1 = cur[1] - prev[1];
                const dx2 = next[0] - cur[0], dy2 = next[1] - cur[1];
                const collinearSameDir = Math.abs(dx1 * dy2 - dy1 * dx2) < 1.0 && (dx1 * dx2 + dy1 * dy2) >= 0;
                if (!collinearSameDir) clean.push(cur);
            }
            clean.push(raw[raw.length - 1]);
            if (clean.length === 2) {
                return `M ${clean[0].join(' ')} L ${clean[1].join(' ')}`;
            }

            let d = `M ${clean[0].join(' ')}`;
            for (let i = 1; i < clean.length - 1; i++) {
                const prev = clean[i - 1], cur = clean[i], next = clean[i + 1];
                const lenIn = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
                const lenOut = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
                if (lenIn < 0.5 || lenOut < 0.5) {
                    d += ` L ${cur.join(' ')}`;
                    continue;
                }
                const r = Math.min(14, lenIn / 2, lenOut / 2);
                const entry = cur.map((v, k) => v + (prev[k] - v) * r / lenIn);
                const exit = cur.map((v, k) => v + (next[k] - v) * r / lenOut);
                d += ` L ${entry.join(' ')} Q ${cur.join(' ')} ${exit.join(' ')}`;
            }
            return d + ` L ${clean[clean.length - 1].join(' ')}`;
        }
        // 记录所有实线折线段与卡片端口占用情况，供按 M 建立的虚线箭头智能避让，防止与实线重合
        const solidSegments = [];
        const solidEndpoints = [];
        const placedMergeRoutes = [];
        function recordSolidRoute(fromId, toId, pts) {
            if (!Array.isArray(pts) || pts.length < 2) return;
            const first = pts[0];
            const last = pts[pts.length - 1];
            solidEndpoints.push({ nodeId: fromId, x: first[0], y: first[1] });
            solidEndpoints.push({ nodeId: toId, x: last[0], y: last[1] });
            for (let i = 0; i < pts.length - 1; i++) {
                const x1 = pts[i][0], y1 = pts[i][1];
                const x2 = pts[i + 1][0], y2 = pts[i + 1][1];
                const len = Math.hypot(x2 - x1, y2 - y1);
                if (len >= 1) {
                    solidSegments.push({
                        x1, y1, x2, y2, len,
                        ux: (x2 - x1) / len,
                        uy: (y2 - y1) / len,
                        fromId, toId
                    });
                }
            }
        }

        function appendFlow(fromId, toId, axis, lane = null, detail = false) {
            const f = cardBounds(fromId), t = cardBounds(toId);
            if (!f || !t) return;
            let points;
            if (axis === 'vertical') {
                const y = lane ?? (t.top - 20);
                points = [[f.cx, f.bottom + 2], [f.cx, y], [t.cx, y], [t.cx, t.top - 5]];
            } else {
                const start = f.right + 2;
                const inConvLayout = Boolean(getCardEl(toId)?.closest('.mm-convergence-layout'));
                const baseX = inConvLayout ? t.left - 28 : (lane ?? (t.left - 20));
                const x = allocateVerticalLane(baseX, f.cy, t.cy, fromId, toId, start + 10, t.left - 12);
                points = [[start, f.cy], [x, f.cy], [x, t.cy], [t.left - 5, t.cy]];
            }
            recordSolidRoute(fromId, toId, points);
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', roundedRoute(points));
            path.setAttribute('class', detail ? 'mm-connector-path' : 'mm-connector-spine');
            path.setAttribute('marker-end', 'url(#mm-spine-arrow)');
            path.dataset.parentId = fromId;
            path.dataset.childId = toId;
            svg.appendChild(path);
        }
        function tracksOf(node) {
            return (node.branches || []).filter(track => Array.isArray(track) && track.length);
        }

        function drawLateralConnections(node) {
            if (!node || node.collapsed) return;
            const children = node.children || [];
            const first = children.length && cardBounds(children[0].id);
            children.forEach(child => {
                appendFlow(node.id, child.id, 'horizontal', first ? first.left - 20 : null, true);
                drawLateralConnections(child);
            });
            if (!isVerticalSpineNode(data, node.id)) drawHorizontalFork(node);
        }
        function drawHorizontalFork(node, nextId = null, exitLane = null) {
            if (node.collapsed) return false;
            const tracks = tracksOf(node);
            if (!tracks.length) return false;
            const row = forkRow(node.id);
            const tracksEl = row?.querySelector(':scope > .mm-lateral-fork-tracks');
            const rowBounds = tracksEl && bounds(tracksEl);
            const convergence = node.forkConverge !== false ? (node.convergeChildren || []) : [];
            const target = convergence[0]?.id || (node.forkConverge !== false ? nextId : null);
            const targetLane = convergence.length ? rowBounds?.right + 20 : exitLane;
            tracks.forEach(track => drawHorizontalSequence(track, node.id, target,
                rowBounds ? rowBounds.left - 20 : null, targetLane));
            if (convergence.length) drawHorizontalSequence(convergence, null, nextId, null, exitLane);
            return !!target;
        }
        function drawHorizontalSequence(sequence, upstreamId = null, downstreamId = null, entryLane = null, exitLane = null) {
            if (!sequence.length) return;
            if (upstreamId) appendFlow(upstreamId, sequence[0].id, 'horizontal', entryLane);
            sequence.forEach((node, i) => {
                // 子细节与推演轨道分别遍历，嵌套分叉仅在此处绘制一次。
                if (!node.collapsed) (node.children || []).forEach(child => {
                    appendFlow(node.id, child.id, 'horizontal', null, true);
                    drawLateralConnections(child);
                });
                const nextId = sequence[i + 1]?.id || downstreamId;
                const lane = sequence[i + 1] ? null : exitLane;
                const converged = drawHorizontalFork(node, nextId, lane);
                if (nextId && !converged) appendFlow(node.id, nextId, 'horizontal', lane);
            });
        }
        function drawSpineSequence(sequence, upstreamId = null, downstreamId = null, entryLane = null, exitLane = null) {
            if (!Array.isArray(sequence) || !sequence.length) return;
            if (upstreamId) appendFlow(upstreamId, sequence[0].id, 'vertical', entryLane);
            sequence.forEach((node, i) => {
                drawLateralConnections(node);
                const nextId = sequence[i + 1]?.id || downstreamId;
                const lane = sequence[i + 1] ? null : exitLane;
                const tracks = tracksOf(node);
                if (tracks.length) {
                    const row = forkRow(node.id);
                    const r = row && bounds(row);
                    const converge = node.forkConverge !== false && nextId;
                    tracks.forEach(track => drawSpineSequence(track, node.id, converge ? nextId : null,
                        r ? r.top - 20 : null, lane ?? (r ? r.bottom + 20 : null)));
                    if (!converge && nextId) appendFlow(node.id, nextId, 'vertical', lane);
                } else if (nextId) appendFlow(node.id, nextId, 'vertical', lane);
            });
        }
        chains.forEach(root => {
            const sequence = !root.collapsed ? (root.children || []) : [];
            const tracks = tracksOf(root);
            if (tracks.length) {
                const row = forkRow(root.id);
                const r = row && bounds(row);
                const target = root.forkConverge !== false ? sequence[0]?.id : null;
                tracks.forEach(track => drawSpineSequence(track, root.id, target,
                    r ? r.top - 20 : null, r ? r.bottom + 20 : null));
                drawSpineSequence(sequence, target ? null : root.id);
            } else drawSpineSequence(sequence, root.id);
        });

        // 3.1 先绘制实线合流分支连线 (node.convergeTo)，以便后续虚线箭头完整避让全部实线
        function drawSolidConvergeLinks(fromCard, toCard, fromId, toId, preview = false) {
            if (!fromCard || !toCard) return;
            const f = cardBounds(fromId);
            const t = cardBounds(toId);
            if (!f || !t) return;

            let points;
            const startX = f.right + 2;

            if (t.left > f.right + 10) {
                // 目标在右侧下游：采用教科书式平滑正交圆角分支，与常规树分支入口完全对齐
                const inConvLayout = Boolean(toCard.closest('.mm-convergence-layout'));
                const baseLane = inConvLayout ? t.left - 28 : t.left - 20;
                const lane = allocateVerticalLane(baseLane, f.cy, t.cy, fromId, toId, f.right + 10, t.left - 12);
                points = [[startX, f.cy], [lane, f.cy], [lane, t.cy], [t.left - 5, t.cy]];

                // 若跨多列合流折线穿过中间列的卡片，自动借道上下行间走廊绕行，保持末端水平正向进入目标
                const obstacles = routeHitsObstacles(points, fromId, toId);
                if (obstacles.length > 0) {
                    const exitX = Math.min(f.right + 18, lane);
                    const entryX = Math.min(lane, t.left - 14);
                    const minObsTop = Math.min(...obstacles.map(o => o.top));
                    const maxObsBottom = Math.max(...obstacles.map(o => o.bottom));
                    const corridorAbove = minObsTop - 16;
                    const corridorBelow = maxObsBottom + 16;
                    const midY = Math.abs(f.cy - corridorAbove) + Math.abs(t.cy - corridorAbove) <=
                                 Math.abs(f.cy - corridorBelow) + Math.abs(t.cy - corridorBelow)
                        ? corridorAbove
                        : corridorBelow;
                    const detourPts = [
                        [startX, f.cy],
                        [exitX, f.cy],
                        [exitX, midY],
                        [entryX, midY],
                        [entryX, t.cy],
                        [t.left - 5, t.cy]
                    ];
                    if (routeHitsObstacles(detourPts, fromId, toId).length < obstacles.length) {
                        points = detourPts;
                    }
                }
            } else if (Math.abs(t.cx - f.cx) < 50) {
                // 同列或上下相邻节点（如连入同级兄弟）：走右侧呼吸留白
                const baseLane = Math.max(f.right, t.right) + 24;
                const lane = allocateVerticalLane(baseLane, f.cy, t.cy, fromId, toId, Math.max(f.right, t.right) + 12, Infinity);
                points = [[startX, f.cy], [lane, f.cy], [lane, t.cy], [t.right + 5, t.cy]];
            } else if (t.right < f.left) {
                // 目标在左侧上游：沿左侧通道绕行接入
                const baseLane = Math.min(f.left, t.left) - 20;
                const lane = allocateVerticalLane(baseLane, f.cy, t.cy, fromId, toId, -Infinity, Math.min(f.left, t.left) - 12);
                points = [[f.left - 2, f.cy], [lane, f.cy], [lane, t.cy], [t.left - 5, t.cy]];
            } else {
                // 其他方位通用平滑对齐
                const lane = (f.cx < t.cx) ? t.left - 20 : t.right + 20;
                points = [[startX, f.cy], [lane, f.cy], [lane, t.cy], [t.left - 5, t.cy]];
            }

            if (!preview) recordSolidRoute(fromId, toId, points);
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', roundedRoute(points));
            const isHighlighted = (selectedNodeId === fromId || selectedNodeId === toId || selectedNodeIds.has(fromId) || selectedNodeIds.has(toId));
            path.setAttribute('class', preview ? 'mm-connector-converge-preview' : `mm-connector-converge${isHighlighted ? ' highlighted' : ''}`);
            path.setAttribute('marker-end', 'url(#mm-spine-arrow)');
            path.dataset.parentId = fromId;
            path.dataset.childId = toId;
            svg.appendChild(path);
        }

        walkAllNodes(data, (node) => {
            if (!Array.isArray(node.convergeTo) || node.convergeTo.length === 0) return;
            const fromCard = getCardEl(node.id);
            if (!fromCard) return;
            node.convergeTo.forEach(targetId => {
                const toCard = getCardEl(targetId);
                if (toCard) {
                    drawSolidConvergeLinks(fromCard, toCard, node.id, targetId);
                }
            });
        });

        // 3.2 绘制跨分支 / 跨主链自由合并虚线箭头 (node.mergeTo，智能避让已有实线与卡片)
        function getMergeCardPort(rect, side, isTarget, shift = 0) {
            const gap = isTarget ? 5 : 2;
            if (side === 'left' || side === 'right') {
                const maxShift = Math.max(0, (rect.bottom - rect.top) / 2 - 9);
                const s = Math.max(-maxShift, Math.min(maxShift, shift));
                return {
                    x: side === 'left' ? rect.left - gap : rect.right + gap,
                    y: rect.cy + s,
                    nx: side === 'left' ? -1 : 1,
                    ny: 0,
                    side
                };
            }
            const maxShift = Math.max(0, (rect.right - rect.left) / 2 - 14);
            const s = Math.max(-maxShift, Math.min(maxShift, shift));
            return {
                x: rect.cx + s,
                y: side === 'top' ? rect.top - gap : rect.bottom + gap,
                nx: 0,
                ny: side === 'top' ? -1 : 1,
                side
            };
        }

        function pointToSolidSegDist(px, py, seg) {
            const proj = Math.max(0, Math.min(seg.len, (px - seg.x1) * seg.ux + (py - seg.y1) * seg.uy));
            const cx = seg.x1 + seg.ux * proj;
            const cy = seg.y1 + seg.uy * proj;
            return Math.hypot(px - cx, py - cy);
        }

        function sampleCubicBezier(p1, cp1, cp2, p2, steps = 24) {
            const pts = [];
            let length = 0;
            for (let k = 0; k <= steps; k++) {
                const t = k / steps;
                const mt = 1 - t;
                const x = mt * mt * mt * p1.x + 3 * mt * mt * t * cp1.x + 3 * mt * t * t * cp2.x + t * t * t * p2.x;
                const y = mt * mt * mt * p1.y + 3 * mt * mt * t * cp1.y + 3 * mt * t * t * cp2.y + t * t * t * p2.y;
                if (k > 0) length += Math.hypot(x - pts[k - 1].x, y - pts[k - 1].y);
                pts.push({ x, y });
            }
            return { pts, length };
        }

        function scoreMergeCandidate(cand, fromId, toId) {
            const { p1, cp1, cp2, p2, basePenalty } = cand;
            let score = basePenalty || 0;

            // 1. 避免与实线共用同一卡片锚点（防止虚线起点/终点压在实线箭头上）
            for (const ep of solidEndpoints) {
                if (ep.nodeId === fromId) {
                    const d = Math.hypot(p1.x - ep.x, p1.y - ep.y);
                    if (d < 11) score += (11 - d) * 48;
                } else if (ep.nodeId === toId) {
                    const d = Math.hypot(p2.x - ep.x, p2.y - ep.y);
                    if (d < 11) score += (11 - d) * 48;
                }
            }
            for (const mr of placedMergeRoutes) {
                if (Math.hypot(p1.x - mr.p1.x, p1.y - mr.p1.y) < 9) score += 220;
                if (Math.hypot(p2.x - mr.p2.x, p2.y - mr.p2.y) < 9) score += 220;
            }

            // 2. 沿贝塞尔曲线采样检测卡片穿透与实线平行重叠
            const { pts, length } = sampleCubicBezier(p1, cp1, cp2, p2, 24);
            score += length * 0.025;

            for (let k = 1; k < pts.length - 1; k++) {
                const pt = pts[k];
                const prev = pts[k - 1];
                const next = pts[k + 1];
                const tLen = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
                const tx = (next.x - prev.x) / tLen;
                const ty = (next.y - prev.y) / tLen;

                // 检查是否穿过无关卡片或回穿源/目标卡片内部
                if (k >= 2 && k <= pts.length - 3) {
                    for (const c of allCardBounds) {
                        if (c.id === fromId || c.id === toId) {
                            if (k >= 3 && k <= pts.length - 4 &&
                                pt.x > c.left + 2 && pt.x < c.right - 2 &&
                                pt.y > c.top + 2 && pt.y < c.bottom - 2) {
                                score += 1200;
                            }
                        } else if (pt.x > c.left - 6 && pt.x < c.right + 6 &&
                                   pt.y > c.top - 6 && pt.y < c.bottom + 6) {
                            score += 950;
                        }
                    }
                }

                // 检查与所有实线段的平行重合与近距离贴靠
                for (const seg of solidSegments) {
                    const d = pointToSolidSegDist(pt.x, pt.y, seg);
                    if (d < 15) {
                        const align = Math.abs(tx * seg.ux + ty * seg.uy);
                        if (align > 0.68) {
                            // 平行贴靠或共线重叠施加重罚，迫使虚线走弧线或空置侧边通道
                            score += (15 - d) * 40 * align;
                        } else if (d < 6) {
                            // 交叉穿过实线施加轻度惩罚，优先挑选完全不交叉的外围弧线
                            score += (6 - d) * 10;
                        }
                    }
                }

                // 避免多条虚线互相重叠
                for (const mr of placedMergeRoutes) {
                    const dm = Math.hypot(pt.x - mr.pts[k].x, pt.y - mr.pts[k].y);
                    if (dm < 12) {
                        score += (12 - dm) * 24;
                    }
                }
            }

            cand.pts = pts;
            return score;
        }

        function drawCustomMergeLinks(fromCard, toCard, fromId, toId, preview = false) {
            if (!fromCard || !toCard) return;
            const f = cardBounds(fromId) || bounds(fromCard);
            const t = cardBounds(toId) || bounds(toCard);
            if (!f || !t) return;

            const dx = t.cx - f.cx;
            const dy = t.cy - f.cy;
            const signX = dx >= 0 ? 1 : -1;
            const signY = dy >= 0 ? 1 : -1;
            const sameCol = Math.min(f.right, t.right) > Math.max(f.left, t.left) - 18;
            const sameRow = Math.min(f.bottom, t.bottom) > Math.max(f.top, t.top) - 18;
            const hFrom = dx >= 0 ? 'right' : 'left';
            const hTo = dx >= 0 ? 'left' : 'right';
            const vFrom = dy >= 0 ? 'bottom' : 'top';
            const vTo = dy >= 0 ? 'top' : 'bottom';

            const candidates = [];

            // 候选组 1：左右外侧 C 形圆弧通道（适用于同列兄弟节点、跨阶段主干节点，自动挑无实线的一侧）
            if (sameCol || Math.abs(dx) < 180) {
                for (const bulge of [28, 46, 68]) {
                    for (const shiftMag of [0, 10]) {
                        const p1R = getMergeCardPort(f, 'right', false, signY * shiftMag);
                        const p2R = getMergeCardPort(t, 'right', true, -signY * shiftMag);
                        const laneR = Math.max(f.right, t.right) + bulge;
                        candidates.push({
                            p1: p1R,
                            cp1: { x: laneR, y: p1R.y },
                            cp2: { x: laneR, y: p2R.y },
                            p2: p2R,
                            basePenalty: (sameCol ? 8 : 30) + bulge * 0.22 + shiftMag * 0.2
                        });

                        const p1L = getMergeCardPort(f, 'left', false, signY * shiftMag);
                        const p2L = getMergeCardPort(t, 'left', true, -signY * shiftMag);
                        const laneL = Math.min(f.left, t.left) - bulge;
                        candidates.push({
                            p1: p1L,
                            cp1: { x: laneL, y: p1L.y },
                            cp2: { x: laneL, y: p2L.y },
                            p2: p2L,
                            basePenalty: (sameCol ? 8 : 30) + bulge * 0.22 + shiftMag * 0.2
                        });
                    }
                }
            }

            // 候选组 2：上下外侧 U 形拱桥通道（适用于同行节点已有水平实线连接、或中间存在障碍卡片）
            if (sameRow || !sameCol) {
                const fQuarter = Math.round((f.right - f.left) * 0.28);
                const tQuarter = Math.round((t.right - t.left) * 0.28);
                for (const bulge of [26, 44, 66]) {
                    for (const useQuarter of [false, true]) {
                        const sF = useQuarter ? signX * fQuarter : 0;
                        const sT = useQuarter ? -signX * tQuarter : 0;
                        const p1T = getMergeCardPort(f, 'top', false, sF);
                        const p2T = getMergeCardPort(t, 'top', true, sT);
                        const laneT = Math.min(f.top, t.top) - bulge;
                        candidates.push({
                            p1: p1T,
                            cp1: { x: p1T.x, y: laneT },
                            cp2: { x: p2T.x, y: laneT },
                            p2: p2T,
                            basePenalty: (sameRow ? 10 : 24) + bulge * 0.22 + (useQuarter ? 0 : 4)
                        });

                        const p1B = getMergeCardPort(f, 'bottom', false, sF);
                        const p2B = getMergeCardPort(t, 'bottom', true, sT);
                        const laneB = Math.max(f.bottom, t.bottom) + bulge;
                        candidates.push({
                            p1: p1B,
                            cp1: { x: p1B.x, y: laneB },
                            cp2: { x: p2B.x, y: laneB },
                            p2: p2B,
                            basePenalty: (sameRow ? 10 : 24) + bulge * 0.22 + (useQuarter ? 0 : 4)
                        });
                    }
                }
            }

            // 候选组 3：横向侧边对连 + 法向拱度偏移（避免与水平/正交实线共线）
            if (!sameCol) {
                const hGap = Math.max(16, Math.abs(dx) - ((f.right - f.left) + (t.right - t.left)) / 2);
                const camberScale = Math.min(1, Math.max(0.45, hGap / 90));
                for (const shift of [0, -10, 10]) {
                    for (const rawCamber of [0, -32, 32, -54, 54]) {
                        const camber = Math.round(rawCamber * camberScale);
                        const p1 = getMergeCardPort(f, hFrom, false, shift);
                        const p2 = getMergeCardPort(t, hTo, true, shift);
                        const spanX = Math.max(24, Math.min(90, Math.abs(p2.x - p1.x) * 0.45));
                        candidates.push({
                            p1,
                            cp1: { x: p1.x + p1.nx * spanX, y: p1.y + camber },
                            cp2: { x: p2.x + p2.nx * spanX, y: p2.y + camber * 0.35 },
                            p2,
                            basePenalty: 6 + Math.abs(shift) * 0.35 + Math.abs(rawCamber) * 0.16
                        });
                    }
                }
            }

            // 候选组 4：纵向底/顶对连 + 横向拱度偏移（避免与主干竖向实线共线）
            if (!sameRow) {
                const fShift = Math.round((f.right - f.left) * 0.24);
                const tShift = Math.round((t.right - t.left) * 0.24);
                const vGap = Math.max(12, Math.abs(dy) - ((f.bottom - f.top) + (t.bottom - t.top)) / 2);
                const camberScale = Math.min(1, Math.max(0.3, vGap / 70));
                for (const dir of [0, 1, -1]) {
                    for (const rawCamberX of [0, 26, -26, 46, -46]) {
                        const camberX = Math.round(rawCamberX * camberScale);
                        const p1 = getMergeCardPort(f, vFrom, false, dir * fShift);
                        const p2 = getMergeCardPort(t, vTo, true, dir * tShift);
                        const spanY = Math.max(12, Math.min(80, Math.abs(p2.y - p1.y) * 0.45));
                        candidates.push({
                            p1,
                            cp1: { x: p1.x + dx * 0.12 + camberX, y: p1.y + p1.ny * spanY },
                            cp2: { x: p2.x - dx * 0.12 + camberX * 0.35, y: p2.y + p2.ny * spanY },
                            p2,
                            basePenalty: 8 + Math.abs(dir) * 4 + Math.abs(rawCamberX) * 0.16
                        });
                    }
                }
            }

            // 候选组 5：对角 L 形正交出射圆弧（利用上下空置边连入左右边，或左右边连入上下空置边，天然避开正交树分支）
            if (!sameCol && !sameRow) {
                const fQuarter = Math.round((f.right - f.left) * 0.24);
                const tQuarter = Math.round((t.right - t.left) * 0.24);
                for (const s1 of [0, signX * fQuarter]) {
                    for (const s2 of [0, -signY * 9]) {
                        const p1 = getMergeCardPort(f, vFrom, false, s1);
                        const p2 = getMergeCardPort(t, hTo, true, s2);
                        candidates.push({
                            p1,
                            cp1: { x: p1.x, y: p1.y + p1.ny * Math.max(26, Math.abs(p2.y - p1.y) * 0.52) },
                            cp2: { x: p2.x + p2.nx * Math.max(30, Math.abs(p2.x - p1.x) * 0.52), y: p2.y },
                            p2,
                            basePenalty: 11 + (s1 ? 1 : 3) + Math.abs(s2) * 0.15
                        });
                    }
                }
                for (const s1 of [0, signY * 9]) {
                    for (const s2 of [0, -signX * tQuarter]) {
                        const p1 = getMergeCardPort(f, hFrom, false, s1);
                        const p2 = getMergeCardPort(t, vTo, true, s2);
                        candidates.push({
                            p1,
                            cp1: { x: p1.x + p1.nx * Math.max(30, Math.abs(p2.x - p1.x) * 0.52), y: p1.y },
                            cp2: { x: p2.x, y: p2.y + p2.ny * Math.max(26, Math.abs(p2.y - p1.y) * 0.52) },
                            p2,
                            basePenalty: 11 + Math.abs(s1) * 0.15 + (s2 ? 1 : 3)
                        });
                    }
                }
            }

            let best = candidates[0];
            let bestScore = Infinity;
            for (const cand of candidates) {
                const sc = scoreMergeCandidate(cand, fromId, toId);
                if (sc < bestScore) {
                    bestScore = sc;
                    best = cand;
                }
            }

            if (!preview && best && best.pts) {
                placedMergeRoutes.push({ p1: best.p1, p2: best.p2, pts: best.pts });
            }

            const { p1, cp1, cp2, p2 } = best;
            const d = `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${cp1.x.toFixed(1)} ${cp1.y.toFixed(1)}, ${cp2.x.toFixed(1)} ${cp2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);

            const isHighlighted = (selectedNodeId === fromId || selectedNodeId === toId || selectedNodeIds.has(fromId) || selectedNodeIds.has(toId));
            path.setAttribute('class', preview ? 'mm-connector-merge-preview' : `mm-connector-merge ${isHighlighted ? 'highlighted' : ''}`);
            path.setAttribute('marker-end', isHighlighted || preview ? 'url(#mm-merge-arrow-active)' : 'url(#mm-merge-arrow)');
            path.dataset.parentId = fromId;
            path.dataset.childId = toId;
            svg.appendChild(path);
        }

        walkAllNodes(data, (node) => {
            if (!Array.isArray(node.mergeTo) || node.mergeTo.length === 0) return;
            const fromCard = getCardEl(node.id);
            if (!fromCard) return;
            node.mergeTo.forEach(targetId => {
                const toCard = getCardEl(targetId);
                if (toCard) {
                    drawCustomMergeLinks(fromCard, toCard, node.id, targetId);
                }
            });
        });

        // 同一合流的结构父子边与显式 convergeTo 边采用同一视觉角色。
        const convergenceTargets = new Set([...svg.querySelectorAll('.mm-connector-converge')]
            .map(path => path.dataset.childId));
        svg.querySelectorAll('.mm-connector-path, .mm-connector-spine, .mm-connector-converge').forEach(path => {
            if (convergenceTargets.has(path.dataset.childId)) {
                path.classList.add('mm-connector-converge');
                path.dataset.convergenceId = path.dataset.childId;
            }
        });
        highlightConnections(selectedNodeId);

        // 4. 若处于交互式点击连线合并模式，实时为所有选中的源节点绘制跟随鼠标或吸附目标的动态预览曲线
        const activeSourceIds = (mergingSourceNodeIds && mergingSourceNodeIds.length > 0)
            ? mergingSourceNodeIds
            : (mergingSourceNodeId ? [mergingSourceNodeId] : []);

        if (activeSourceIds.length > 0) {
            if (mergingTargetNodeId && getCardEl(mergingTargetNodeId)) {
                activeSourceIds.forEach(srcId => {
                    const srcCard = getCardEl(srcId);
                    if (srcCard) {
                        drawCustomMergeLinks(srcCard, getCardEl(mergingTargetNodeId), srcId, mergingTargetNodeId, true);
                    }
                });
            } else if (mergeMouseX && mergeMouseY) {
                activeSourceIds.forEach(srcId => {
                    const srcCard = getCardEl(srcId);
                    const sB = cardBounds(srcId) || (srcCard && bounds(srcCard));
                    if (sB) {
                        const endX = (mergeMouseX - canvasRect.left) / zoom;
                        const endY = (mergeMouseY - canvasRect.top) / zoom;
                        const dx = endX - sB.cx;
                        const dy = endY - sB.cy;
                        const side = Math.abs(dx) > Math.abs(dy)
                            ? (dx >= 0 ? 'right' : 'left')
                            : (dy >= 0 ? 'bottom' : 'top');
                        let p1 = getMergeCardPort(sB, side, false, 0);
                        const portBusy = solidEndpoints.some(ep => ep.nodeId === srcId && Math.hypot(p1.x - ep.x, p1.y - ep.y) < 9);
                        if (portBusy) {
                            const shiftDir = (side === 'left' || side === 'right') ? (dy >= 0 ? 10 : -10) : (dx >= 0 ? 14 : -14);
                            p1 = getMergeCardPort(sB, side, false, shiftDir);
                        }

                        const dist = Math.max(28, Math.hypot(endX - p1.x, endY - p1.y) * 0.42);
                        const cp1x = p1.x + p1.nx * dist + (p1.ny !== 0 ? (endX - p1.x) * 0.18 : 0);
                        const cp1y = p1.y + p1.ny * dist + (p1.nx !== 0 ? (endY - p1.y) * 0.18 : 0);
                        const cp2x = endX - (endX - p1.x) * 0.25;
                        const cp2y = endY - (endY - p1.y) * 0.25;

                        const previewPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                        previewPath.setAttribute('d', `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`);
                        previewPath.setAttribute('class', 'mm-connector-merge-preview');
                        previewPath.setAttribute('marker-end', 'url(#mm-merge-arrow-active)');
                        svg.appendChild(previewPath);
                    }
                });
            }
        }

        // 5. 若处于交互式更改挂载父节点模式，实时绘制从候选新父节点指向当前节点的预览流线
        if (reparentingSourceNodeId && getCardEl(reparentingSourceNodeId)) {
            const childB = cardBounds(reparentingSourceNodeId);
            if (childB) {
                let startX = null, startY = null;
                if (reparentingTargetNodeId && getCardEl(reparentingTargetNodeId)) {
                    const pB = cardBounds(reparentingTargetNodeId);
                    if (pB) {
                        startX = pB.right + 2;
                        startY = pB.cy;
                    }
                } else if (reparentMouseX && reparentMouseY) {
                    startX = (reparentMouseX - canvasRect.left) / zoom;
                    startY = (reparentMouseY - canvasRect.top) / zoom;
                }
                if (startX !== null && startY !== null) {
                    const endX = childB.left - 5;
                    const endY = childB.cy;
                    const dx = endX - startX;
                    const spanX = Math.max(28, Math.abs(dx) * 0.42);
                    const previewPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    previewPath.setAttribute('d', `M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${(startX + spanX).toFixed(1)} ${startY.toFixed(1)}, ${(endX - spanX).toFixed(1)} ${endY.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`);
                    previewPath.setAttribute('class', 'mm-connector-reparent-preview');
                    previewPath.setAttribute('marker-end', 'url(#mm-reparent-arrow-active)');
                    svg.appendChild(previewPath);
                }
            }
        }
    }

    function highlightConnections(nodeId) {
        const paths = document.querySelectorAll('.mm-connector-path, .mm-connector-spine, .mm-connector-merge, .mm-connector-converge');
        const touchesSelection = path => nodeId &&
            (selectedNodeIds.has(path.dataset.parentId) || selectedNodeIds.has(path.dataset.childId));
        const activeConvergences = new Set([...paths]
            .filter(path => path.dataset.convergenceId && touchesSelection(path))
            .map(path => path.dataset.convergenceId));
        const activePaths = [];
        paths.forEach(p => {
            const active = !!(touchesSelection(p) || activeConvergences.has(p.dataset.convergenceId));
            p.classList.toggle('highlighted', active);
            const marker = p.classList.contains('mm-connector-merge') ? 'mm-merge-arrow' : 'mm-spine-arrow';
            p.setAttribute('marker-end', `url(#${marker}${active ? '-active' : ''})`);
            if (active) activePaths.push(p);
        });
        // 将高亮连线提升至 SVG 顶层（位于普通灰线之上、动态预览线之下），避免复杂交错图中激活箭头被灰线压盖
        if (activePaths.length > 0) {
            const svg = document.getElementById('mindmap-svg-canvas');
            const firstPreview = svg?.querySelector('.mm-connector-merge-preview, .mm-connector-reparent-preview');
            activePaths.forEach(p => {
                if (svg && p.parentNode === svg) {
                    if (firstPreview) svg.insertBefore(p, firstPreview);
                    else svg.appendChild(p);
                }
            });
        }
    }

    function updateActivePageHighlight() {
        if (!isMindmapOpen) return;
        const curPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
        const data = getMindMapData();
        const pages = getMindMapPages(data);
        const activePage = getActiveMindMapPage(data);

        document.querySelectorAll('.mm-page-badge-group').forEach(group => {
            const tabPageId = group.dataset.pageId;
            if (tabPageId) {
                const pageObj = pages.find(p => p && p.id === tabPageId);
                if (pageObj && pageObj.page) {
                    const isCur = (pageObj.page === curPage);
                    group.classList.toggle('is-active-page', isCur);
                    const tab = group.closest('.mm-page-tab');
                    if (tab) tab.classList.toggle('is-reading-page', isCur);
                    const span = group.querySelector('.mm-page-badge span');
                    if (span) {
                        span.textContent = isCur ? `P.${pageObj.page} · 当前` : `P.${pageObj.page}`;
                    }
                }
                return;
            }
            const branch = group.closest('.mm-tree-branch');
            if (!branch) return;
            const nId = branch.dataset.id;
            const node = findNodeInTree(data, nId);
            if (node && node.page) {
                const isCur = (node.page === curPage);
                group.classList.toggle('is-active-page', isCur);
                const span = group.querySelector('.mm-page-badge span');
                if (span) {
                    span.textContent = isCur ? `P.${node.page} · 当前` : `P.${node.page}`;
                }
            }
        });

        const els = getEls();
        if (els.bindPageBtn && activePage) {
            els.bindPageBtn.classList.toggle('is-active-page', Boolean(activePage.page && activePage.page === curPage));
        }
    }

    function renderPagesBar(data = null) {
        const els = getEls();
        const d = data || getMindMapData();
        const pages = getMindMapPages(d);
        const activePage = getActiveMindMapPage(d);
        const curReadingPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;

        if (els.bindPageBtn) {
            const boundPage = activePage && activePage.page ? activePage.page : null;
            const isCurPdf = Boolean(boundPage && boundPage === curReadingPage);
            els.bindPageBtn.classList.toggle('is-bound', Boolean(boundPage));
            els.bindPageBtn.classList.toggle('is-active-page', isCurPdf);
            if (els.bindPageText) {
                els.bindPageText.textContent = boundPage ? `P.${boundPage}` : '绑页码';
            }
            els.bindPageBtn.title = boundPage
                ? `当前导图页已绑定 PDF 第 ${boundPage} 页（左键修改关联页码 · 右键解绑或切换当前阅读页）`
                : '为当前导图页绑定 PDF 页码（点击设置 · 右键一键绑定当前阅读页）';
        }

        if (!els.pagesList) return;
        els.pagesList.innerHTML = '';

        pages.forEach((pageObj, idx) => {
            if (!pageObj) return;
            const isActive = Boolean(activePage && pageObj.id === activePage.id);
            const isCurPdf = Boolean(pageObj.page && pageObj.page === curReadingPage);

            const tab = document.createElement('div');
            tab.className = `mm-page-tab${isActive ? ' is-active' : ''}${isCurPdf ? ' is-reading-page' : ''}`;
            tab.dataset.pageId = pageObj.id;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(isActive));
            tab.tabIndex = isActive ? 0 : -1;
            const displayTitle = pageObj.title || `第 ${idx + 1} 页`;
            tab.title = pageObj.page
                ? `${displayTitle} · 已绑定 PDF 第 ${pageObj.page} 页（双击重命名 · 右键更多操作）`
                : `${displayTitle}（双击重命名 · 右键绑定页码或更多操作）`;

            const titleSpan = document.createElement('span');
            titleSpan.className = 'mm-page-tab-title truncate';
            titleSpan.textContent = displayTitle;
            tab.appendChild(titleSpan);

            // 与节点完全一致的 PDF 页码关联徽章组 (.mm-page-badge-group)
            if (pageObj.page) {
                const badgeGroup = document.createElement('div');
                badgeGroup.className = `mm-page-badge-group mm-tab-page-badge ${isCurPdf ? 'is-active-page' : ''}`;
                badgeGroup.dataset.pageId = pageObj.id;

                const pageBadge = document.createElement('button');
                pageBadge.type = 'button';
                pageBadge.className = 'mm-page-badge';
                pageBadge.innerHTML = `<i class="ph-fill ph-BookOpenText text-[10px]"></i><span>${isCurPdf ? `P.${pageObj.page} · 当前` : `P.${pageObj.page}`}</span>`;
                pageBadge.title = `点击定位到 PDF 第 ${pageObj.page} 页（右键修改关联页码）`;
                pageBadge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!isActive) {
                        switchMindMapPage(pageObj.id, { locatePdf: true });
                    } else {
                        locatePdfPage(pageObj.page);
                    }
                });
                pageBadge.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showMindMapPagePickerPopover(pageObj.id, badgeGroup);
                });

                const clearBtn = document.createElement('button');
                clearBtn.type = 'button';
                clearBtn.className = 'mm-page-clear-btn';
                clearBtn.innerHTML = '<i class="ph-bold ph-x"></i>';
                clearBtn.title = '解除此导图页的 PDF 页码关联';
                clearBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    setMindMapPagePdfPage(pageObj.id, null);
                    showMindmapToast(`已取消「${displayTitle}」的页码关联`);
                });

                badgeGroup.appendChild(pageBadge);
                badgeGroup.appendChild(clearBtn);
                tab.appendChild(badgeGroup);
            }

            if (pages.length > 1) {
                const closeBtn = document.createElement('button');
                closeBtn.type = 'button';
                closeBtn.className = 'mm-page-tab-close';
                closeBtn.innerHTML = '<i class="ph ph-x"></i>';
                closeBtn.title = `删除「${displayTitle}」`;
                closeBtn.setAttribute('aria-label', `删除${displayTitle}`);
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteMindMapPage(pageObj.id);
                });
                tab.appendChild(closeBtn);
            }

            tab.addEventListener('click', (e) => {
                if (e.target.closest('button') || e.target.closest('input')) return;
                if (!isActive) {
                    switchMindMapPage(pageObj.id);
                }
            });

            tab.addEventListener('dblclick', (e) => {
                if (e.target.closest('button') || e.target.closest('.mm-page-badge-group')) return;
                e.stopPropagation();
                startInlineRenamePageTab(pageObj.id, tab);
            });

            tab.addEventListener('contextmenu', (e) => {
                if (e.target.closest('.mm-page-badge-group')) return;
                showPageTabContextMenu(e, pageObj.id);
            });

            tab.addEventListener('keydown', (e) => {
                if (e.target.tagName === 'INPUT') return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isActive) switchMindMapPage(pageObj.id);
                } else if (e.key === 'F2') {
                    e.preventDefault();
                    e.stopPropagation();
                    startInlineRenamePageTab(pageObj.id, tab);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    e.stopPropagation();
                    const nextIdx = (idx + (e.key === 'ArrowRight' ? 1 : pages.length - 1)) % pages.length;
                    const nextPage = pages[nextIdx];
                    if (nextPage) {
                        switchMindMapPage(nextPage.id);
                        els.pagesList.querySelector(`.mm-page-tab[data-page-id="${nextPage.id}"]`)?.focus({ preventScroll: true });
                    }
                }
            });

            els.pagesList.appendChild(tab);
        });

        const activeTabEl = els.pagesList.querySelector('.mm-page-tab.is-active');
        if (activeTabEl && els.pagesList.scrollWidth > els.pagesList.clientWidth) {
            const tabLeft = activeTabEl.offsetLeft;
            const tabRight = tabLeft + activeTabEl.offsetWidth;
            const viewLeft = els.pagesList.scrollLeft;
            const viewRight = viewLeft + els.pagesList.clientWidth;
            if (tabLeft < viewLeft) {
                els.pagesList.scrollLeft = tabLeft;
            } else if (tabRight > viewRight) {
                els.pagesList.scrollLeft = tabRight - els.pagesList.clientWidth;
            }
        }
    }

    function renderTree() {
        const els = getEls();
        if (!els.treeRoot) return;

        const data = getMindMapData();
        renderPagesBar(data);
        const chains = getAllMainChains(data);
        const total = countNodes(data);
        if (selectedNodeId && !findNodeInTree(data, selectedNodeId)) selectedNodeId = null;
        selectedNodeIds = new Set([...selectedNodeIds].filter(id => findNodeInTree(data, id)));
        if (selectedNodeId && !selectedNodeIds.has(selectedNodeId)) selectedNodeIds = new Set([selectedNodeId]);
        if (!selectedNodeId) selectedNodeId = [...selectedNodeIds].pop() || null;
        if (mergingSourceNodeId && !findNodeInTree(data, mergingSourceNodeId)) stopInteractiveMergeMode();
        if (reparentingSourceNodeId && !findNodeInTree(data, reparentingSourceNodeId)) stopInteractiveReparentMode();
        if (els.nodeCount) {
            const pageCount = getMindMapPages(data).length;
            els.nodeCount.textContent = chains.length > 1 ? `${chains.length}·${total}` : String(total);
            els.nodeCount.title = pageCount > 1
                ? `共 ${pageCount} 页思维导图 · 当前页 ${chains.length} 条主链 · ${total} 个节点`
                : (chains.length > 1 ? `${chains.length} 条主链 · ${total} 个节点` : `${total} 个节点`);
        }

        const hadFocus = !!(document.activeElement && document.activeElement.classList &&
            document.activeElement.classList.contains('mm-card') && els.treeRoot.contains(document.activeElement));

        els.treeRoot.innerHTML = '';
        chains.forEach((chainRoot, idx) => {
            if (chainRoot) {
                els.treeRoot.appendChild(createBranchDOM(chainRoot, null, 0, null, { chainIdx: idx }));
            }
        });
        prepareConvergenceLayouts(data);
        updateSelectionTools();

        // 新导图只有根节点时给出轻量上手引导，添加首个节点后自动消失
        if (total === 1 && els.treeRoot.firstElementChild) {
            const guide = document.createElement('div');
            guide.className = 'mm-empty-guide';
            guide.innerHTML = '<p>点选根节点后：</p>'
                + '<div><kbd>Enter</kbd><span>向下推进主链阶段</span></div>'
                + '<div><kbd>Shift+Enter</kbd><span>拆分并行分支</span></div>'
                + '<div><kbd>右键</kbd><span>标签 · 页码 · 合并等更多操作</span></div>';
            els.treeRoot.firstElementChild.appendChild(guide);
        }

        // 整树重建后把键盘焦点还给选中节点，保证快捷键连续可用
        if (hadFocus && selectedNodeId) {
            const card = els.treeRoot.querySelector(`.mm-card[data-id="${selectedNodeId}"]`);
            if (card) card.focus({ preventScroll: true });
        }

        // 同步应用当前画布变换并立即绘制流线，同时在下一帧与异步排版后二次校准
        applyTransform();
        updateSvgConnections();

        // 延迟执行贝塞尔流线更新，确保 DOM 几何尺寸和 KaTeX 渲染就绪
        requestAnimationFrame(() => {
            updateSvgConnections();
            setTimeout(updateSvgConnections, 60);
        });
    }

    // ==========================================
    // 6. 独立缩放、自由平移与居中视野 (Transform 2D 引擎)
    // ==========================================

    function applyTransform() {
        const els = getEls();
        if (!els.canvas) return;
        els.canvas.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${currentZoom})`;
        if (els.viewport) {
            els.viewport.style.backgroundPosition = `${panX}px ${panY}px`;
        }
        if (els.zoomVal) {
            els.zoomVal.textContent = `${Math.round(currentZoom * 100)}%`;
        }
        const activePage = getActiveMindMapPage();
        if (activePage) {
            activePage.zoom = currentZoom;
            activePage.panX = panX;
            activePage.panY = panY;
        }
    }

    function applyZoom(scale) {
        const els = getEls();
        const vpW = els.viewport ? els.viewport.clientWidth : 380;
        const vpH = els.viewport ? els.viewport.clientHeight : 600;
        zoomAt(scale, vpW / 2, vpH / 3);
    }

    function zoomAt(targetZoom, originX, originY) {
        const newZoom = Math.min(2.5, Math.max(0.35, Math.round(targetZoom * 100) / 100));
        if (Math.abs(newZoom - currentZoom) < 0.001) return;

        const ratio = newZoom / currentZoom;
        panX = Math.round(originX - (originX - panX) * ratio);
        panY = Math.round(originY - (originY - panY) * ratio);
        currentZoom = newZoom;
        applyTransform();

        const data = getMindMapData();
        data.zoom = currentZoom;
    }

    function setZoomDelta(delta) {
        applyZoom(currentZoom + delta);
    }

    function centerView(smooth = true, autoFit = false) {
        const els = getEls();
        if (!els.viewport || !els.canvas || !els.treeRoot) return;

        const vpW = els.viewport.clientWidth || 380;
        const vpH = els.viewport.clientHeight || 600;

        const treeW = els.treeRoot.offsetWidth || (els.treeRoot.firstElementChild ? els.treeRoot.firstElementChild.offsetWidth : 260);
        const treeH = els.treeRoot.offsetHeight || (els.treeRoot.firstElementChild ? els.treeRoot.firstElementChild.offsetHeight : 300);

        if (autoFit && treeW > 0 && treeH > 0) {
            const fitW = (vpW - 48) / treeW;
            const fitH = (vpH - 80) / treeH;
            const targetZoom = Math.min(1.0, Math.max(0.35, Math.min(fitW, fitH)));
            currentZoom = Math.round(targetZoom * 100) / 100;
            const data = getMindMapData();
            data.zoom = currentZoom;
        }

        // 窄侧栏装不下整图时从主链起点显示，保留向右平移查看细节的空间。
        panX = Math.max(24, Math.round((vpW - treeW * currentZoom) / 2));
        panY = Math.max(24, Math.round((vpH - treeH * currentZoom) / 7));

        if (smooth) {
            els.canvas.style.transition = 'transform 0.28s cubic-bezier(0.16, 1, 0.3, 1)';
            applyTransform();
            setTimeout(() => {
                if (els.canvas) els.canvas.style.transition = '';
                updateSvgConnections();
            }, 300);
        } else {
            els.canvas.style.transition = '';
            applyTransform();
            updateSvgConnections();
        }
    }

    function ensureNodeVisible(card) {
        const els = getEls();
        if (!els.viewport || !card) return;
        const cardRect = card.getBoundingClientRect();
        const vpRect = els.viewport.getBoundingClientRect();
        const pad = 24;

        let deltaX = 0;
        let deltaY = 0;

        if (cardRect.left < vpRect.left + pad) {
            deltaX = (vpRect.left + pad) - cardRect.left;
        } else if (cardRect.right > vpRect.right - pad) {
            deltaX = (vpRect.right - pad) - cardRect.right;
        }

        if (cardRect.top < vpRect.top + pad) {
            deltaY = (vpRect.top + pad) - cardRect.top;
        } else if (cardRect.bottom > vpRect.bottom - pad) {
            deltaY = (vpRect.bottom - pad) - cardRect.bottom;
        }

        if (deltaX !== 0 || deltaY !== 0) {
            panX += Math.round(deltaX);
            panY += Math.round(deltaY);
            applyTransform();
        }
    }

    function updateCanvasCursor() {
        const els = getEls();
        if (!els.viewport) return;
        if (isPanning && didPanMove) {
            els.viewport.classList.add('is-panning');
            els.viewport.classList.remove('can-grab');
        } else if (isSpaceDown) {
            els.viewport.classList.remove('is-panning');
            els.viewport.classList.add('can-grab');
        } else {
            els.viewport.classList.remove('is-panning', 'can-grab');
        }
    }

    // 树状键盘导航 (↑父级/上一节点, ↓下一节点/分叉, ←上一主链/兄弟, →下一主链/侧向细节)
    function handleTreeNavigation(key) {
        if (!selectedNodeId) return false;
        const data = getMindMapData();
        const chains = getAllMainChains(data);
        const currNode = findNodeInTree(data, selectedNodeId);
        if (!currNode) return false;

        const res = findParentAndList(data, selectedNodeId);
        const isLateralForkTrack = !!(res && res.isForkTrack && res.parent && !isVerticalSpineNode(data, res.parent.id));

        if (key === 'ArrowUp') {
            if (isLateralForkTrack && res.trackIndex > 0 && res.parent.branches[res.trackIndex - 1].length > 0) {
                const prevTrack = res.parent.branches[res.trackIndex - 1];
                const targetIdx = Math.min(res.index, prevTrack.length - 1);
                selectNode(prevTrack[targetIdx].id, true);
                return true;
            }
            if (res && res.list && res.index > 0 && !isLateralForkTrack) {
                selectNode(res.list[res.index - 1].id, true);
                return true;
            }
            if (res && res.parent) {
                selectNode(res.parent.id, true);
                return true;
            }
        } else if (key === 'ArrowDown') {
            if (isLateralForkTrack && res.trackIndex < res.parent.branches.length - 1 && res.parent.branches[res.trackIndex + 1].length > 0) {
                const nextTrack = res.parent.branches[res.trackIndex + 1];
                const targetIdx = Math.min(res.index, nextTrack.length - 1);
                selectNode(nextTrack[targetIdx].id, true);
                return true;
            }
            if (res && res.list && res.index < res.list.length - 1 && !isLateralForkTrack) {
                selectNode(res.list[res.index + 1].id, true);
                return true;
            }
            if (Array.isArray(currNode.branches) && currNode.branches.length > 0 && currNode.branches[0].length > 0) {
                selectNode(currNode.branches[0][0].id, true);
                return true;
            }
            if (currNode.children && currNode.children.length > 0 && !currNode.collapsed) {
                selectNode(currNode.children[0].id, true);
                return true;
            }
        } else if (key === 'ArrowLeft') {
            const rootIdx = chains.findIndex(r => r && r.id === selectedNodeId);
            if (rootIdx > 0) {
                selectNode(chains[rootIdx - 1].id, true);
                return true;
            }
            if (isLateralForkTrack) {
                if (res.index > 0) {
                    selectNode(res.list[res.index - 1].id, true);
                    return true;
                }
                if (res.parent) {
                    selectNode(res.parent.id, true);
                    return true;
                }
            }
            if (res && res.isConvergeList && res.parent && Array.isArray(res.parent.branches) && res.parent.branches.length > 0) {
                const firstTrack = res.parent.branches[0];
                if (firstTrack && firstTrack.length > 0) {
                    selectNode(firstTrack[firstTrack.length - 1].id, true);
                    return true;
                }
            }
            if (res && res.isForkTrack && res.parent && Array.isArray(res.parent.branches)) {
                if (res.trackIndex > 0 && res.parent.branches[res.trackIndex - 1].length > 0) {
                    selectNode(res.parent.branches[res.trackIndex - 1][0].id, true);
                    return true;
                }
            }
            if (res && res.parent) {
                selectNode(res.parent.id, true);
                return true;
            }
        } else if (key === 'ArrowRight') {
            const rootIdx = chains.findIndex(r => r && r.id === selectedNodeId);
            if (rootIdx !== -1 && rootIdx < chains.length - 1) {
                selectNode(chains[rootIdx + 1].id, true);
                return true;
            }
            if (isLateralForkTrack) {
                if (res.index < res.list.length - 1) {
                    selectNode(res.list[res.index + 1].id, true);
                    return true;
                }
                if (res.parent && Array.isArray(res.parent.convergeChildren) && res.parent.convergeChildren.length > 0) {
                    selectNode(res.parent.convergeChildren[0].id, true);
                    return true;
                }
            }
            if (res && res.isForkTrack && !isLateralForkTrack && res.parent && Array.isArray(res.parent.branches)) {
                if (res.trackIndex < res.parent.branches.length - 1 && res.parent.branches[res.trackIndex + 1].length > 0) {
                    selectNode(res.parent.branches[res.trackIndex + 1][0].id, true);
                    return true;
                }
            }
            if (currNode.children && currNode.children.length > 0 && !currNode.collapsed) {
                selectNode(currNode.children[0].id, true);
                return true;
            }
            if (!isVerticalSpineNode(data, selectedNodeId) && Array.isArray(currNode.branches) && currNode.branches.length > 0 && currNode.branches[0].length > 0 && !currNode.collapsed) {
                selectNode(currNode.branches[0][0].id, true);
                return true;
            }
        }
        return false;
    }

    function updateSelectionTools() {
        const els = getEls();
        const count = selectedNodeIds.size || (selectedNodeId ? 1 : 0);
        const label = document.getElementById('mindmap-selection-label');
        if (label) label.textContent = count ? `已选 ${count} 项` : '点选节点开始编辑';
        if (els.forkBtn) {
            const vertical = selectedNodeId && isVerticalSpineNode(getMindMapData(), selectedNodeId);
            els.forkBtn.hidden = count === 1 && !vertical;
            els.forkBtn.disabled = count !== 1 || !vertical;
        }
        if (els.bindCurrentBtn) els.bindCurrentBtn.disabled = count !== 1;
        if (els.mergeBtn) {
            els.mergeBtn.disabled = !count;
            const text = els.mergeBtn.querySelector('span');
            if (text) text.textContent = count > 1 ? '合流' : '连接';
            els.mergeBtn.title = count > 1 ? `将所选 ${count} 个节点合流为新节点 (Enter)` : '合流、连线与内容融合';
        }
    }

    function selectNode(nodeId, scrollIntoView = true, isMulti = false) {
        if (!nodeId) {
            selectedNodeId = null;
            selectedNodeIds.clear();
            document.querySelectorAll('.mm-card.selected').forEach(c => c.classList.remove('selected', 'is-multi-selected'));
            document.querySelectorAll('.mm-tree-branch.is-selected-branch').forEach(b => b.classList.remove('is-selected-branch'));
            document.querySelectorAll('.mm-card-wrapper.is-selected-wrapper').forEach(w => w.classList.remove('is-selected-wrapper'));
            highlightConnections(null);
            updateSelectionTools();
            return;
        }

        if (isMulti) {
            if (selectedNodeIds.has(nodeId)) {
                selectedNodeIds.delete(nodeId);
                const lastId = Array.from(selectedNodeIds).pop();
                selectedNodeId = lastId || null;
            } else {
                selectedNodeIds.add(nodeId);
                selectedNodeId = nodeId;
            }
        } else {
            selectedNodeIds.clear();
            selectedNodeIds.add(nodeId);
            selectedNodeId = nodeId;
        }

        document.querySelectorAll('.mm-card.selected').forEach(c => c.classList.remove('selected', 'is-multi-selected'));
        document.querySelectorAll('.mm-tree-branch.is-selected-branch').forEach(b => b.classList.remove('is-selected-branch'));
        document.querySelectorAll('.mm-card-wrapper.is-selected-wrapper').forEach(w => w.classList.remove('is-selected-wrapper'));

        selectedNodeIds.forEach(id => {
            const branchEl = document.querySelector(`.mm-tree-branch[data-id="${id}"]`);
            if (branchEl) {
                branchEl.classList.add('is-selected-branch');
                const wrapper = branchEl.querySelector(':scope > .mm-card-wrapper');
                if (wrapper) wrapper.classList.add('is-selected-wrapper');
                const card = branchEl.querySelector(':scope > .mm-card-wrapper > .mm-card');
                if (card) {
                    card.classList.add('selected');
                    if (selectedNodeIds.size > 1) {
                        card.classList.add('is-multi-selected');
                    }
                }
            }
        });

        highlightConnections(selectedNodeId);
        updateSelectionTools();

        if (scrollIntoView && selectedNodeId) {
            const card = document.querySelector(`.mm-card[data-id="${selectedNodeId}"]`);
            if (card) {
                ensureNodeVisible(card);
            }
        }
    }

    // ==========================================
    // 7. 面板展开/收起与拖拽调宽
    // ==========================================

    function toggleMindmap(forceOpen = null) {
        const targetState = forceOpen !== null ? forceOpen : !isMindmapOpen;
        if (isMindmapOpen === targetState) return;

        isMindmapOpen = targetState;
        const els = getEls();
        if (!els.panel || !els.btn) return;

        if (isMindmapOpen) {
            els.panel.classList.remove('hidden');
            els.btn.classList.add('text-blue-600', 'bg-blue-50');
            els.btn.classList.remove('text-gray-600');
            renderTree();
            setTimeout(() => centerView(false, true), 60);
        } else {
            els.panel.classList.add('hidden');
            els.btn.classList.remove('text-blue-600', 'bg-blue-50');
            els.btn.classList.add('text-gray-600');
            isSpaceDown = false;
            isPanning = false;
            stopInteractiveMergeMode();
            stopInteractiveReparentMode();
            updateCanvasCursor();
            closeAllPopovers();
        }
    }

    function initResizer() {
        const els = getEls();
        if (!els.resizer || !els.panel) return;

        const savedWidth = localStorage.getItem('reader_mindmap_width');
        if (savedWidth) {
            const w = parseInt(savedWidth, 10);
            if (w >= 280 && w <= 860) {
                els.panel.style.width = `${w}px`;
            }
        }

        let isDragging = false;
        let startX = 0;
        let startWidth = 0;

        els.resizer.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startWidth = els.panel.offsetWidth;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const newW = Math.min(860, Math.max(280, startWidth + (e.clientX - startX)));
            els.panel.style.width = `${newW}px`;
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                localStorage.setItem('reader_mindmap_width', els.panel.offsetWidth);
                updateSvgConnections();
            }
        });
    }

    // ==========================================
    // 8. 滚轮隔离与自由拖拽平移
    // ==========================================

    function setupEventListeners() {
        const els = getEls();

        // 按钮事件
        if (els.btn) {
            els.btn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleMindmap();
            });
        }
        if (els.closeBtn) {
            els.closeBtn.addEventListener('click', () => toggleMindmap(false));
        }
        if (els.shortcutBtn) {
            els.shortcutBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleMindmap(false);
            });
        }
        if (els.centerBtn) {
            els.centerBtn.addEventListener('click', () => centerView(true, false));
            els.centerBtn.addEventListener('dblclick', () => centerView(true, true));
        }
        if (els.zoomIn) {
            els.zoomIn.addEventListener('click', () => setZoomDelta(0.1));
        }
        if (els.zoomOut) {
            els.zoomOut.addEventListener('click', () => setZoomDelta(-0.1));
        }
        if (els.zoomVal) {
            els.zoomVal.addEventListener('click', () => applyZoom(1.0));
        }
        if (els.toggleAllBtn) {
            els.toggleAllBtn.addEventListener('click', () => {
                toggleAllNodes(null);
            });
        }
        if (els.addChainBtn) {
            els.addChainBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                addMainChain();
            });
        }
        if (els.addPageBtn) {
            els.addPageBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                addMindMapPage();
            });
            els.addPageBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const curPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
                addMindMapPage({ page: curPage });
            });
        }
        if (els.bindPageBtn) {
            els.bindPageBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const activePage = getActiveMindMapPage();
                if (activePage) {
                    showMindMapPagePickerPopover(activePage.id, els.bindPageBtn);
                }
            });
            els.bindPageBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const activePage = getActiveMindMapPage();
                if (!activePage) return;
                const curPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
                if (activePage.page === curPage) {
                    setMindMapPagePdfPage(activePage.id, null);
                    showMindmapToast(`已取消「${activePage.title}」的页码关联`);
                } else {
                    setMindMapPagePdfPage(activePage.id, curPage);
                    showMindmapToast(`已将「${activePage.title}」绑定至第 ${curPage} 页`, 'success');
                }
            });
        }
        if (els.pagesList) {
            els.pagesList.addEventListener('wheel', (e) => {
                e.stopPropagation();
                if (els.pagesList.scrollWidth > els.pagesList.clientWidth) {
                    e.preventDefault();
                    els.pagesList.scrollLeft += (e.deltaY || e.deltaX);
                }
            }, { passive: false });
        }
        if (els.forkBtn) {
            els.forkBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!selectedNodeId) {
                    const data = getMindMapData();
                    const chains = getAllMainChains(data);
                    const firstChain = chains[0];
                    const fallbackId = (firstChain && firstChain.children && firstChain.children[0])
                        ? firstChain.children[0].id
                        : (firstChain ? firstChain.id : null);
                    if (fallbackId) {
                        forkNodeBranch(fallbackId);
                    } else {
                        showMindmapToast('请先点击选中一个节点，再开启并行分支', 'warn');
                    }
                    return;
                }
                forkNodeBranch(selectedNodeId);
            });
        }
        if (els.mergeBtn) {
            els.mergeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (mergingSourceNodeId) {
                    stopInteractiveMergeMode();
                    showMindmapToast('已退出合并连线模式');
                    return;
                }
                if (selectedNodeIds.size > 1) {
                    convergeNodesToNext(Array.from(selectedNodeIds));
                    return;
                }
                if (!selectedNodeId) {
                    showMindmapToast('请先选中源节点，再点击「合并」或按 M 键选择汇入目标！', 'warn');
                    return;
                }
                showMergePopover(selectedNodeId, els.mergeBtn);
            });
        }
        if (els.bindCurrentBtn) {
            els.bindCurrentBtn.addEventListener('click', () => {
                if (!selectedNodeId) {
                    showMindmapToast('请先在思维导图中点击选中一个节点，再绑定当前页！', 'warn');
                    return;
                }
                const curPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
                const data = getMindMapData();
                const node = findNodeInTree(data, selectedNodeId);
                if (node && node.page === curPage) {
                    setNodePage(selectedNodeId, null);
                    showMindmapToast(`已取消节点与第 ${curPage} 页的关联`);
                } else {
                    setNodePage(selectedNodeId, curPage);
                    showMindmapToast(`已成功绑定当前正文第 ${curPage} 页`, 'success');
                }
            });
        }

        // 核心滚轮隔离与缩放：导图区域滚轮绝对不影响底层 PDF
        if (els.viewport) {
            let isRightMouseDown = false;
            let rightPanMoved = false;
            // 抓手手势的点击拦截保留到下次按下，覆盖 mouseup 后的 click / dblclick。
            let suppressPanClick = false;

            // overflow:hidden 的视口仍可能被 focus()/选字悄悄滚动，导致平移坐标错位；始终归零
            els.viewport.addEventListener('scroll', () => {
                if (els.viewport.scrollTop || els.viewport.scrollLeft) {
                    els.viewport.scrollTop = 0;
                    els.viewport.scrollLeft = 0;
                }
            });

            // 在导图面板外点击时释放导图键盘焦点，避免 Delete/Enter 等误作用于导图节点
            window.addEventListener('mousedown', (e) => {
                suppressPanClick = false;
                const panel = getEls().panel;
                if (!panel || panel.contains(e.target)) return;
                if (e.target.closest && (e.target.closest('#mm-context-menu') || e.target.closest('#mm-popover-dialog'))) return;
                if (mergingSourceNodeId) {
                    stopInteractiveMergeMode();
                }
                if (reparentingSourceNodeId) {
                    stopInteractiveReparentMode();
                }
                const ae = document.activeElement;
                if (ae && ae.classList && ae.classList.contains('mm-card') && panel.contains(ae)) {
                    ae.blur();
                }
            }, { capture: true });

            // 右键自定义空白区菜单 (若执行了右键拖拽平移，则阻断弹出)
            els.viewport.addEventListener('contextmenu', (e) => {
                if (mergingSourceNodeId) {
                    e.preventDefault();
                    e.stopPropagation();
                    stopInteractiveMergeMode();
                    showMindmapToast('已取消合并连线模式');
                    return;
                }
                if (reparentingSourceNodeId) {
                    e.preventDefault();
                    e.stopPropagation();
                    stopInteractiveReparentMode();
                    showMindmapToast('已取消更改挂载模式');
                    return;
                }
                if (rightPanMoved) {
                    e.preventDefault();
                    e.stopPropagation();
                    rightPanMoved = false;
                    return;
                }
                showCanvasContextMenu(e);
            });

            els.viewport.addEventListener('wheel', (e) => {
                e.stopPropagation(); // 严格阻断向主阅读器冒泡
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    const rect = els.viewport.getBoundingClientRect();
                    const mouseX = e.clientX - rect.left;
                    const mouseY = e.clientY - rect.top;
                    const factor = e.deltaY < 0 ? 1.1 : 0.9;
                    zoomAt(currentZoom * factor, mouseX, mouseY);
                } else {
                    // 若光标悬停在横向可滚动的公式/节点正文上方，且用户正在横向滚动，优先由该节点横向滚动
                    const scrollable = e.target.closest('.mm-card-body, .katex-display, .katex');
                    if (scrollable && scrollable.scrollWidth > scrollable.clientWidth) {
                        const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY)) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
                        if (delta !== 0) {
                            const canScrollLeft = scrollable.scrollLeft > 0;
                            const canScrollRight = scrollable.scrollLeft < (scrollable.scrollWidth - scrollable.clientWidth - 1);
                            if ((delta < 0 && canScrollLeft) || (delta > 0 && canScrollRight)) {
                                scrollable.scrollLeft += delta;
                                e.preventDefault();
                                return;
                            }
                        }
                    }
                    e.preventDefault();
                    if (e.shiftKey) {
                        panX -= (e.deltaY || e.deltaX);
                    } else {
                        panY -= e.deltaY;
                        if (e.deltaX) panX -= e.deltaX;
                    }
                    applyTransform();
                }
            }, { passive: false });

            // 视口平移（支持空白画布直接左键拖拽、右键拖拽、中键拖拽与空格抓手模式）
            els.viewport.addEventListener('mousedown', (e) => {
                if (e.target.closest('#mm-popover-dialog') || e.target.closest('.mm-inline-editor') || e.target.closest('#mm-context-menu') || e.target.closest('#mm-merge-banner') || e.target.closest('#mm-reparent-banner')) return;

                const isMiddle = (e.button === 1);
                const isLeft = (e.button === 0);
                const isRight = (e.button === 2);
                const isOverCard = !!e.target.closest('.mm-card');
                const isOverButton = !!e.target.closest('button');

                // 右键拖拽平移支持（与全局主阅读器右键拖屏交互完全统一）
                if (isRight && !isOverCard && !isOverButton) {
                    isRightMouseDown = true;
                    rightPanMoved = false;
                    startPanX = e.clientX;
                    startPanY = e.clientY;
                    panStartX = panX;
                    panStartY = panY;
                    return;
                }

                // 允许在画布空白处直接左键拖拽平移，或按住空格/中键在任意位置拖拽平移
                if (isMiddle || (isLeft && (!isOverCard && !isOverButton || isSpaceDown))) {
                    isPanning = true;
                    didPanMove = false;
                    suppressPanClick = isSpaceDown;
                    startPanX = e.clientX;
                    startPanY = e.clientY;
                    panStartX = panX;
                    panStartY = panY;
                    updateCanvasCursor();
                    if (isMiddle || isSpaceDown) e.preventDefault();
                }
            });

            window.addEventListener('mousemove', (e) => {
                // 交互式合并连线模式下实时跟随鼠标绘制动态预览流线
                if (mergingSourceNodeId && isMindmapOpen) {
                    mergeMouseX = e.clientX;
                    mergeMouseY = e.clientY;
                    const target = e.target.closest?.('#mindmap-tree-root .mm-card');
                    const targetId = target && target.dataset.id !== mergingSourceNodeId ? target.dataset.id : null;
                    if (targetId !== mergingTargetNodeId) {
                        mergingTargetNodeId = targetId;
                        document.querySelectorAll('.mm-merge-target').forEach(card => card.classList.remove('mm-merge-target'));
                        if (targetId) target.classList.add('mm-merge-target');
                        const hint = document.getElementById('mm-merge-target-hint');
                        if (hint) {
                            const data = getMindMapData();
                            const source = findNodeInTree(data, mergingSourceNodeId);
                            const node = targetId && findNodeInTree(data, targetId);
                            hint.textContent = node
                                ? `${source?.mergeTo?.includes(targetId) ? '解除连线' : '连线汇入'} → ${(node.text || '目标节点').slice(0, 24)}`
                                : '点击目标建立连线 · 再点已有目标解除 · Esc 取消';
                        }
                    }
                    if (mergePreviewFrame === null) mergePreviewFrame = requestAnimationFrame(() => {
                        mergePreviewFrame = null;
                        updateSvgConnections();
                    });
                }

                // 交互式更改挂载父节点模式下实时高亮候选父节点并绘制预览流线
                if (reparentingSourceNodeId && isMindmapOpen) {
                    reparentMouseX = e.clientX;
                    reparentMouseY = e.clientY;
                    const target = e.target.closest?.('#mindmap-tree-root .mm-card');
                    const data = getMindMapData();
                    const srcNode = findNodeInTree(data, reparentingSourceNodeId);
                    const rawTargetId = target && target.dataset.id !== reparentingSourceNodeId ? target.dataset.id : null;
                    const validTargetId = (rawTargetId && !(srcNode && isNodeInSubtree(srcNode, rawTargetId))) ? rawTargetId : null;
                    if (validTargetId !== reparentingTargetNodeId) {
                        reparentingTargetNodeId = validTargetId;
                        document.querySelectorAll('.mm-reparent-target').forEach(card => card.classList.remove('mm-reparent-target'));
                        if (validTargetId && target) target.classList.add('mm-reparent-target');
                        const hint = document.getElementById('mm-reparent-target-hint');
                        if (hint) {
                            const tNode = validTargetId && findNodeInTree(data, validTargetId);
                            hint.textContent = tNode
                                ? `点击挂载为「${(tNode.text || '目标节点').slice(0, 22)}」的子节点`
                                : (rawTargetId ? '不可挂载到自身的子孙节点下' : '直接点击画布上的新父节点完成挂载 · Alt+↑/↓ 调整同级顺序 · Esc 取消');
                        }
                    }
                    if (reparentPreviewFrame === null) reparentPreviewFrame = requestAnimationFrame(() => {
                        reparentPreviewFrame = null;
                        updateSvgConnections();
                    });
                }

                // 右键平移处理
                if (isRightMouseDown && (e.buttons & 2)) {
                    const dx = e.clientX - startPanX;
                    const dy = e.clientY - startPanY;
                    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                        rightPanMoved = true;
                        panX = panStartX + dx;
                        panY = panStartY + dy;
                        applyTransform();
                    }
                    return;
                }

                if (!isPanning) return;
                if (!(e.buttons & 1) && !(e.buttons & 4)) {
                    isPanning = false;
                    didPanMove = false;
                    updateCanvasCursor();
                    return;
                }
                const dx = e.clientX - startPanX;
                const dy = e.clientY - startPanY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                    if (!didPanMove) {
                        didPanMove = true;
                        updateCanvasCursor();
                    }
                    panX = panStartX + dx;
                    panY = panStartY + dy;
                    applyTransform();
                    e.preventDefault();
                }
            });

            window.addEventListener('mouseup', (e) => {
                if (isRightMouseDown && e.button === 2) {
                    isRightMouseDown = false;
                }
                if (isPanning) {
                    isPanning = false;
                    didPanMove = false;
                    updateCanvasCursor();
                }
            });

            els.viewport.addEventListener('click', (e) => {
                if (suppressPanClick || didPanMove || rightPanMoved) {
                    e.stopPropagation();
                    e.preventDefault();
                    didPanMove = false;
                    rightPanMoved = false;
                    return;
                }
                // 点击空白处退出合并连线模式、退出重挂载模式或取消卡片选中
                if (!e.target.closest('.mm-card') && !e.target.closest('button') && !e.target.closest('#mm-popover-dialog') && !e.target.closest('#mm-context-menu') && !e.target.closest('#mm-merge-banner') && !e.target.closest('#mm-reparent-banner')) {
                    if (reparentingSourceNodeId) {
                        stopInteractiveReparentMode();
                        showMindmapToast('已取消更改挂载模式');
                        return;
                    }
                    if (mergingSourceNodeId || (mergingSourceNodeIds && mergingSourceNodeIds.length > 0)) {
                        stopInteractiveMergeMode();
                        showMindmapToast('已取消合并连线模式');
                        return;
                    }
                    selectedNodeId = null;
                    selectedNodeIds.clear();
                    document.querySelectorAll('.mm-card.selected').forEach(c => c.classList.remove('selected', 'is-multi-selected'));
                    document.querySelectorAll('.mm-tree-branch.is-selected-branch').forEach(b => b.classList.remove('is-selected-branch'));
                    document.querySelectorAll('.mm-card-wrapper.is-selected-wrapper').forEach(w => w.classList.remove('is-selected-wrapper'));
                    highlightConnections(null);
                    updateSelectionTools();
                }
            }, { capture: true });

            els.viewport.addEventListener('dblclick', (e) => {
                if (suppressPanClick) {
                    e.stopPropagation();
                    e.preventDefault();
                }
            }, { capture: true });

            // 鼠标移出导图视口时，立刻清理可能残留的空格抓手与平移状态，防止状态被卡住
            els.viewport.addEventListener('mouseleave', () => {
                if (isSpaceDown) {
                    isSpaceDown = false;
                }
                if (isPanning) {
                    isPanning = false;
                    didPanMove = false;
                }
                updateCanvasCursor();
            });

            els.viewport.addEventListener('mouseenter', (e) => {
                if (!e.buttons) {
                    isPanning = false;
                    didPanMove = false;
                }
                updateCanvasCursor();
            });
        }

        // 交互焦点判断助手
        function isMindmapInteractive(e) {
            const els = getEls();
            if (!isMindmapOpen || !els.panel || els.panel.classList.contains('hidden')) return false;
            if (e && e.target && (e.target instanceof Node) && els.panel.contains(e.target)) return true;
            return (els.panel.matches && els.panel.matches(':hover')) || (document.activeElement && (document.activeElement instanceof Node) && els.panel.contains(document.activeElement));
        }

        // 键盘快捷键（空格抓手平移、T 收起导图、Tab 侧向分支、Enter 下一阶段、Shift+Enter 开启并行分支、Alt+方向键 调整顺序与层级、R 点选挂载、M 合并连线、Alt+N 新建主链、Delete 删除、F2 编辑、P 绑定当前页）
        window.addEventListener('keydown', (e) => {
            const isSpaceKey = (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar');
            const isInputTarget = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable);

            // 空格键平移抓手模式
            if (isSpaceKey && !isInputTarget) {
                if (isMindmapInteractive(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isSpaceDown) {
                        isSpaceDown = true;
                        updateCanvasCursor();
                    }
                    return;
                }
            }

            if (isInputTarget || e.isComposing || e.keyCode === 229) return;

            // T：打开 / 关闭思维导图
            if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 't' || e.key === 'T' || e.code === 'KeyT')) {
                const ae = document.activeElement;
                if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
                e.preventDefault();
                e.stopPropagation();
                toggleMindmap();
                return;
            }

            if (!isMindmapOpen) return;

            // Ctrl+0 自适应居中
            if ((e.ctrlKey || e.metaKey) && (e.key === '0' || e.code === 'Digit0')) {
                if (isMindmapInteractive(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    centerView(true, true);
                    return;
                }
            }

            // 必须在思维导图区域聚焦或悬停时才响应导图快捷键
            if (!isMindmapInteractive(e)) return;

            // Alt+N：快速新建一条并列主链
            if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                e.stopPropagation();
                addMainChain();
                return;
            }

            // Alt+T：快速新增一页思维导图
            if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 't' || e.key === 'T')) {
                e.preventDefault();
                e.stopPropagation();
                addMindMapPage();
                return;
            }

            // Alt + ↑/↓/←/→：一键调整同级子节点顺序与父子挂载层级
            if (e.altKey && !e.ctrlKey && !e.metaKey && selectedNodeId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'ArrowUp') moveNodeStep(selectedNodeId, -1);
                else if (e.key === 'ArrowDown') moveNodeStep(selectedNodeId, 1);
                else if (e.key === 'ArrowLeft') promoteNode(selectedNodeId);
                else if (e.key === 'ArrowRight') demoteNode(selectedNodeId);
                return;
            }

            if (e.key === 'Escape') {
                if (reparentingSourceNodeId) {
                    stopInteractiveReparentMode();
                    showMindmapToast('已取消更改挂载模式');
                } else if (mergingSourceNodeId || (mergingSourceNodeIds && mergingSourceNodeIds.length > 0)) {
                    stopInteractiveMergeMode();
                    showMindmapToast('已取消合并连线模式');
                } else if (document.getElementById('mm-popover-dialog') || document.getElementById('mm-context-menu')) {
                    closeAllPopovers();
                } else if (selectedNodeId || selectedNodeIds.size > 0) {
                    selectedNodeId = null;
                    selectedNodeIds.clear();
                    document.querySelectorAll('.mm-card.selected').forEach(c => c.classList.remove('selected', 'is-multi-selected'));
                    document.querySelectorAll('.mm-tree-branch.is-selected-branch').forEach(b => b.classList.remove('is-selected-branch'));
                    document.querySelectorAll('.mm-card-wrapper.is-selected-wrapper').forEach(w => w.classList.remove('is-selected-wrapper'));
                    highlightConnections(null);
                    updateSelectionTools();
                }
                return;
            }

            const hasModifier = e.ctrlKey || e.metaKey || e.altKey;

            // 未选中节点时按 P：直接为当前思维导图页绑定/解绑当前阅读页
            if (!selectedNodeId && selectedNodeIds.size === 0) {
                if ((e.key === 'p' || e.key === 'P') && !hasModifier) {
                    const activePage = getActiveMindMapPage();
                    if (activePage) {
                        e.preventDefault();
                        e.stopPropagation();
                        const curPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
                        if (activePage.page === curPage) {
                            setMindMapPagePdfPage(activePage.id, null);
                            showMindmapToast(`已取消「${activePage.title}」与第 ${curPage} 页的关联`);
                        } else {
                            setMindMapPagePdfPage(activePage.id, curPage);
                            showMindmapToast(`已将「${activePage.title}」绑定至第 ${curPage} 页`, 'success');
                        }
                    }
                }
                return;
            }
            // 焦点在工具栏按钮上时，Enter/空格交还给按钮本身
            if (e.key === 'Enter' && e.target && e.target.tagName === 'BUTTON') return;

            // 多选状态下：按 Enter 或 Tab 直接合流所选节点到新进一步子节点
            if (selectedNodeIds.size > 1 && !hasModifier && (e.key === 'Enter' || e.key === 'Tab')) {
                e.preventDefault();
                e.stopPropagation();
                convergeNodesToNext(Array.from(selectedNodeIds));
                return;
            }

            if (e.key === 'Tab' && !hasModifier) {
                e.preventDefault();
                e.stopPropagation();
                if (selectedNodeId) {
                    const data = getMindMapData();
                    const chains = getAllMainChains(data);
                    if (chains.some(r => r && r.id === selectedNodeId)) {
                        addMainChain(null, selectedNodeId);
                    } else {
                        addChildNode(selectedNodeId);
                    }
                }
            } else if (e.key === 'Enter' && e.shiftKey && !hasModifier) {
                // Shift+Enter：开启并行分支
                e.preventDefault();
                e.stopPropagation();
                if (selectedNodeId) forkNodeBranch(selectedNodeId);
            } else if (e.key === 'Enter' && !hasModifier) {
                e.preventDefault();
                e.stopPropagation();
                if (selectedNodeId) {
                    const data = getMindMapData();
                    const chains = getAllMainChains(data);
                    if (chains.some(r => r && r.id === selectedNodeId)) {
                        addChildNode(selectedNodeId);
                    } else {
                        addSiblingNode(selectedNodeId);
                    }
                }
            } else if ((e.key === 'r' || e.key === 'R') && !hasModifier) {
                e.preventDefault();
                e.stopPropagation();
                if (reparentingSourceNodeId) {
                    stopInteractiveReparentMode();
                    showMindmapToast('已退出更改挂载模式');
                } else if (selectedNodeId) {
                    startInteractiveReparentMode(selectedNodeId);
                }
            } else if ((e.key === 'm' || e.key === 'M') && !hasModifier) {
                e.preventDefault();
                e.stopPropagation();
                const sources = selectedNodeIds.size > 1 ? Array.from(selectedNodeIds) : (selectedNodeId ? [selectedNodeId] : []);
                if (mergingSourceNodeId) {
                    stopInteractiveMergeMode();
                    showMindmapToast('已退出合并连线模式');
                } else if (sources.length > 0) {
                    startInteractiveMergeMode(sources);
                }
            } else if ((e.key === 'Delete' || e.key === 'Backspace') && !hasModifier) {
                e.preventDefault();
                e.stopPropagation();
                if (selectedNodeId) deleteNode(selectedNodeId);
            } else if (e.key === 'F2') {
                e.preventDefault();
                e.stopPropagation();
                if (selectedNodeId) startEditingNode(selectedNodeId);
            } else if ((e.key === 'p' || e.key === 'P') && !hasModifier) {
                if (selectedNodeId) {
                    e.preventDefault();
                    e.stopPropagation();
                    const curPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
                    const data = getMindMapData();
                    const node = findNodeInTree(data, selectedNodeId);
                    if (node && node.page === curPage) {
                        setNodePage(selectedNodeId, null);
                        showMindmapToast(`已取消节点与第 ${curPage} 页的关联`);
                    } else {
                        setNodePage(selectedNodeId, curPage);
                        showMindmapToast(`已成功绑定当前正文第 ${curPage} 页`, 'success');
                    }
                }
            } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                if (handleTreeNavigation(e.key)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        });

        window.addEventListener('keyup', (e) => {
            const isSpaceKey = (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar');
            if (isSpaceKey) {
                if (isSpaceDown) {
                    isSpaceDown = false;
                    updateCanvasCursor();
                }
            }
        });

        window.addEventListener('blur', () => {
            if (isSpaceDown || isPanning) {
                isSpaceDown = false;
                isPanning = false;
                updateCanvasCursor();
            }
        });

        // 窗口尺寸变化时重新计算 SVG 贝塞尔流线
        window.addEventListener('resize', () => {
            if (isMindmapOpen) {
                updateSvgConnections();
            }
        });

        // 监听正文滚动，联动更新当前页对应的思维导图节点 Badge
        const mainViewer = document.getElementById('viewer-container');
        if (mainViewer) {
            let scrollTimer = null;
            mainViewer.addEventListener('scroll', () => {
                if (!isMindmapOpen) return;
                if (scrollTimer) return;
                scrollTimer = setTimeout(() => {
                    scrollTimer = null;
                    updateActivePageHighlight();
                }, 200);
            }, { passive: true });
        }

        initResizer();
    }

    // ==========================================
    // 9. 生命周期回调
    // ==========================================

    function onAnnotationsLoaded() {
        editingNodeId = null;
        selectedNodeId = null;
        selectedNodeIds.clear();
        draggingNodeId = null;
        stopInteractiveMergeMode();
        stopInteractiveReparentMode();
        closeAllPopovers();
        if (state.annotations?.['mindmap']) {
            getMindMapData();
        }
        const activePage = state.annotations?.['mindmap'] ? getActiveMindMapPage() : null;
        const savedZoom = Number(activePage?.zoom ?? state.annotations?.['mindmap']?.zoom);
        currentZoom = Number.isFinite(savedZoom) ? Math.min(2.5, Math.max(0.35, savedZoom)) : 1.0;
        if (isMindmapOpen) {
            renderTree();
        }
    }

    // 页面就绪后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupEventListeners);
    } else {
        setupEventListeners();
    }

    // 导出全局对象
    window.MindMap = {
        toggle: toggleMindmap,
        render: renderTree,
        onAnnotationsLoaded: onAnnotationsLoaded,
        locatePage: locatePdfPage,
        center: centerView,
        addMainChain: addMainChain,
        getPages: getMindMapPages,
        getActivePage: getActiveMindMapPage,
        addPage: addMindMapPage,
        switchPage: switchMindMapPage,
        deletePage: deleteMindMapPage,
        renamePage: renameMindMapPage,
        setPagePdfPage: setMindMapPagePdfPage,
        setNodePage: setNodePage,
        showPagePicker: showMindMapPagePickerPopover,
        forkBranch: forkNodeBranch,
        convergeBranches: convergeBranches,
        convergeNodesToNext: convergeNodesToNext,
        toggleConvergeLink: toggleConvergeLink,
        toggleMergeLink: toggleMergeLink,
        fuseNodeInto: fuseNodeInto,
        reparentNode: reparentNode,
        moveNodeStep: moveNodeStep,
        promoteNode: promoteNode,
        demoteNode: demoteNode,
        startInteractiveReparentMode: startInteractiveReparentMode,
        countCollapsedDescendants: countCollapsedDescendants
    };
})();

