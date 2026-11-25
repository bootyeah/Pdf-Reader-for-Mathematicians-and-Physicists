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
    let draggingNodeObj = null;
    let activeDockTray = null; // null | 'tag' | 'page' | 'connect' | 'move' | 'sheet'
    let dockConnectMode = 'link'; // 'link' | 'converge' | 'fuse'
    let activeSheetTargetId = null;
    let isSpaceDown = false;
    let isPanning = false;
    let startPanX = 0, startPanY = 0;
    let panStartX = 0, panStartY = 0;
    let didPanMove = false;
    // 仅用于视图排版，不写入批注；撤销、保存仍沿用原始树与连线模型。
    let convergenceLayouts = [];
    // 规范化缓存、DOM 脏标记、SVG 预览上下文缓存与公式 HTML 缓存
    let _lastNormalizedMindmapData = null;
    let _lastNormalizedPageCount = -1;
    let _lastNormalizedActivePageId = null;
    let _lastNormalizedActivePage = null;
    let _lastNormalizedNodeCount = -1;
    let _mindmapDomDirty = true;
    let _lastRenderedMindmapRef = null;
    let _lastRenderedActivePageId = null;
    let _lastRenderIndex = null;
    let _lastHighlightedPdfPage = -1;
    let _lastHighlightedRenderRef = null;
    let _lastHighlightedActivePageVal = undefined;
    let _svgLayoutCache = null;
    const _nodeContentHtmlCache = new Map();
    const MAX_NODE_CONTENT_CACHE = 500;

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
    let lastRawReparentTargetId = undefined;
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
            dock: document.getElementById('mm-command-dock'),
            dockTray: document.getElementById('mm-dock-tray'),
            dockBar: document.getElementById('mm-dock-bar')
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

        if (data && data === _lastNormalizedMindmapData &&
            Array.isArray(data.pages) && data.pages.length === _lastNormalizedPageCount &&
            data.activePageId === _lastNormalizedActivePageId &&
            _lastNormalizedActivePage && _lastNormalizedActivePage.id === data.activePageId &&
            Array.isArray(data.nodes) && data.nodes === _lastNormalizedActivePage.nodes &&
            data.nodes.length === _lastNormalizedNodeCount && data.nodes.length > 0 &&
            data.root === data.nodes[0]) {
            data.page = _lastNormalizedActivePage.page;
            if (!Number.isFinite(Number(data.zoom))) {
                data.zoom = _lastNormalizedActivePage.zoom || 1.0;
            } else {
                _lastNormalizedActivePage.zoom = Number(data.zoom);
            }
            return data;
        }

        const hasPages = data && Array.isArray(data.pages) && data.pages.length > 0;
        const hasNodes = data && (data.root || (Array.isArray(data.nodes) && data.nodes.length > 0));

        if (!data || (!hasPages && !hasNodes)) {
            data = createDefaultMindMapData();
            state.annotations['mindmap'] = data;
            _lastNormalizedMindmapData = data;
            _lastNormalizedPageCount = data.pages.length;
            _lastNormalizedActivePageId = data.activePageId;
            _lastNormalizedActivePage = data.pages[0];
            _lastNormalizedNodeCount = data.nodes.length;
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
            _lastNormalizedMindmapData = data;
            _lastNormalizedPageCount = 1;
            _lastNormalizedActivePageId = firstPage.id;
            _lastNormalizedActivePage = firstPage;
            _lastNormalizedNodeCount = data.nodes.length;
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
            _lastNormalizedMindmapData = data;
            _lastNormalizedPageCount = 1;
            _lastNormalizedActivePageId = fallbackPage.id;
            _lastNormalizedActivePage = fallbackPage;
            _lastNormalizedNodeCount = data.nodes.length;
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
        _lastNormalizedMindmapData = data;
        _lastNormalizedPageCount = data.pages.length;
        _lastNormalizedActivePageId = activePage.id;
        _lastNormalizedActivePage = activePage;
        _lastNormalizedNodeCount = data.nodes.length;
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
            _lastNormalizedMindmapData = null;
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
            _lastNormalizedMindmapData = null;
            _mindmapDomDirty = true;
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

    // 单次 O(N) 预扫描：收集节点总数、节点表、入向连线数、自动合流来源数、主干节点集合及同级移动能力，消除 O(N^2) 渲染遍历
    function buildRenderIndex(data) {
        const chains = getAllMainChains(data);
        const nodeMap = new Map();
        const incomingMergeCount = new Map();
        const forkConvergenceCount = new Map();
        const verticalSpineIds = new Set();
        const moveStepFlags = new Map();
        let total = 0;

        function countNonEmptyTracks(branches) {
            if (!Array.isArray(branches) || !branches.length) return 0;
            let count = 0;
            for (let i = 0; i < branches.length; i++) {
                if (Array.isArray(branches[i]) && branches[i].length > 0) count++;
            }
            return count;
        }

        function visit(node, isVerticalSpine, listInfo) {
            if (!node) return;
            total++;
            nodeMap.set(node.id, node);
            if (isVerticalSpine) verticalSpineIds.add(node.id);

            if (listInfo) {
                const { index, length, isForkTrack, trackIndex, trackCount } = listInfo;
                const canUp = index > 0 || (isForkTrack && trackCount > 1 && trackIndex > 0);
                const canDown = index + 1 < length || (isForkTrack && trackCount > 1 && trackIndex + 1 < trackCount);
                moveStepFlags.set(node.id, { canUp, canDown });
            }

            if ((Array.isArray(node.mergeTo) && node.mergeTo.length) ||
                (Array.isArray(node.convergeTo) && node.convergeTo.length)) {
                const seenTargets = new Set();
                if (Array.isArray(node.mergeTo)) {
                    for (let i = 0; i < node.mergeTo.length; i++) seenTargets.add(node.mergeTo[i]);
                }
                if (Array.isArray(node.convergeTo)) {
                    for (let i = 0; i < node.convergeTo.length; i++) seenTargets.add(node.convergeTo[i]);
                }
                seenTargets.forEach(tId => {
                    incomingMergeCount.set(tId, (incomingMergeCount.get(tId) || 0) + 1);
                });
            }

            const nonEmptyTracks = (node.forkConverge !== false) ? countNonEmptyTracks(node.branches) : 0;

            if (Array.isArray(node.branches)) {
                const trackCount = node.branches.length;
                for (let tIdx = 0; tIdx < trackCount; tIdx++) {
                    const track = node.branches[tIdx];
                    if (!Array.isArray(track)) continue;
                    const tLen = track.length;
                    for (let sIdx = 0; sIdx < tLen; sIdx++) {
                        const bNode = track[sIdx];
                        if (isVerticalSpine && sIdx > 0) {
                            const prevB = track[sIdx - 1];
                            if (prevB && prevB.forkConverge !== false) {
                                const prevTracks = countNonEmptyTracks(prevB.branches);
                                if (prevTracks > 0) forkConvergenceCount.set(bNode.id, prevTracks);
                            }
                        }
                        visit(bNode, isVerticalSpine, {
                            index: sIdx,
                            length: tLen,
                            isForkTrack: true,
                            trackIndex: tIdx,
                            trackCount
                        });
                    }
                }
            }

            if (Array.isArray(node.convergeChildren) && node.convergeChildren.length) {
                const cLen = node.convergeChildren.length;
                if (nonEmptyTracks > 0 && node.convergeChildren[0]) {
                    forkConvergenceCount.set(node.convergeChildren[0].id, nonEmptyTracks);
                }
                for (let i = 0; i < cLen; i++) {
                    visit(node.convergeChildren[i], false, {
                        index: i,
                        length: cLen,
                        isForkTrack: false,
                        trackIndex: 0,
                        trackCount: 0
                    });
                }
            }

            if (Array.isArray(node.children) && node.children.length) {
                const chLen = node.children.length;
                const childIsSpine = Boolean(listInfo && listInfo.isChainRoot);
                for (let i = 0; i < chLen; i++) {
                    const ch = node.children[i];
                    if (childIsSpine && i > 0) {
                        const prevCh = node.children[i - 1];
                        if (prevCh && prevCh.forkConverge !== false) {
                            const prevTracks = countNonEmptyTracks(prevCh.branches);
                            if (prevTracks > 0) forkConvergenceCount.set(ch.id, prevTracks);
                        }
                    }
                    visit(ch, childIsSpine, {
                        index: i,
                        length: chLen,
                        isForkTrack: false,
                        trackIndex: 0,
                        trackCount: 0
                    });
                }
            }
        }

        for (let cIdx = 0; cIdx < chains.length; cIdx++) {
            const chainRoot = chains[cIdx];
            if (chainRoot) {
                visit(chainRoot, true, {
                    index: cIdx,
                    length: chains.length,
                    isForkTrack: false,
                    trackIndex: 0,
                    trackCount: 0,
                    isChainRoot: true
                });
            }
        }

        return { total, nodeMap, incomingMergeCount, forkConvergenceCount, verticalSpineIds, moveStepFlags };
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
            return;
        }

        // 情况 A：连入已有的目标节点（实线合流至下一个子节点）
        if (existingTargetId) {
            if (findNodeInTree(data.root, existingTargetId)) {
                commitMindMapChange((d) => {
                    validIds.forEach(srcId => {
                        if (srcId === existingTargetId) return;
                        const src = findNodeInTree(d.root, srcId);
                        if (!src) return;
                        if (!Array.isArray(src.convergeTo)) src.convergeTo = [];
                        if (!src.convergeTo.includes(existingTargetId)) {
                            src.convergeTo.push(existingTargetId);
                        }
                        // 确保清理旧版 mergeTo 中可能残留的同一目标，避免虚实线重叠
                        if (Array.isArray(src.mergeTo)) {
                            src.mergeTo = src.mergeTo.filter(id => id !== existingTargetId);
                        }
                    });
                });
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

        return actionType === 'added';
    }

    // 自由合流（Converge）：将并行分支、多选子节点或推演阶段汇合至下游节点
    function convergeBranches(nodeId, options = {}) {
        if (!options?.forceFork && selectedNodeIds.size > 1) {
            convergeNodesToNext(Array.from(selectedNodeIds));
            return;
        }

        const data = getMindMapData();
        const targetId = nodeId || selectedNodeId;
        if (!targetId) {
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
        return true;
    }

    function updateCardTagBadgeInPlace(nodeId, nextTag) {
        const els = getEls();
        if (!els.treeRoot) return false;
        const card = els.treeRoot.querySelector(`.mm-card[data-id="${nodeId}"]`);
        const head = card?.querySelector(':scope > .mm-card-head');
        const leftInfo = head?.querySelector(':scope > .mm-card-left');
        if (!card || !head || !leftInfo) return false;

        let tagBadge = leftInfo.querySelector(':scope > .mm-math-tag');
        if (nextTag && MATH_TAGS[nextTag]) {
            const tagDef = MATH_TAGS[nextTag];
            if (!tagBadge) {
                tagBadge = document.createElement('button');
                tagBadge.type = 'button';
                tagBadge.onclick = (e) => {
                    e.stopPropagation();
                    selectNode(nodeId, false);
                    openDockTray('tag');
                };
                const pageGroup = leftInfo.querySelector(':scope > .mm-page-badge-group');
                if (pageGroup) leftInfo.insertBefore(tagBadge, pageGroup);
                else leftInfo.appendChild(tagBadge);
            }
            tagBadge.className = `mm-math-tag mm-tag-${nextTag}`;
            tagBadge.title = `理论定位: ${tagDef.label}（点击更改）`;
            tagBadge.innerHTML = `<i class="ph ${tagDef.icon}"></i><span>${tagDef.label}</span>`;
        } else if (tagBadge) {
            tagBadge.remove();
        }
        head.classList.toggle('is-empty-head', leftInfo.children.length === 0);
        return true;
    }

    function updateCardPageBadgeInPlace(nodeId, nextPage) {
        const els = getEls();
        if (!els.treeRoot) return false;
        const card = els.treeRoot.querySelector(`.mm-card[data-id="${nodeId}"]`);
        const head = card?.querySelector(':scope > .mm-card-head');
        const leftInfo = head?.querySelector(':scope > .mm-card-left');
        if (!card || !head || !leftInfo) return false;

        let group = leftInfo.querySelector(':scope > .mm-page-badge-group');
        if (nextPage != null && nextPage > 0) {
            const curReadingPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
            const isCurrent = (nextPage === curReadingPage);
            if (!group) {
                group = document.createElement('div');
                const pageBadge = document.createElement('button');
                pageBadge.type = 'button';
                pageBadge.className = 'mm-page-badge';
                pageBadge.oncontextmenu = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    selectNode(nodeId, false);
                    openDockTray('page');
                };
                group.appendChild(pageBadge);
                leftInfo.appendChild(group);
            }
            group.className = 'mm-page-badge-group' + (isCurrent ? ' is-active-page' : '');
            const pageBadge = group.querySelector(':scope > .mm-page-badge');
            if (pageBadge) {
                pageBadge.title = `点击直达 PDF 第 ${nextPage} 页（右键在底部操作台修改）`;
                pageBadge.innerHTML = `<i class="ph ph-bookmark-simple"></i><span>P.${nextPage}${isCurrent ? ' · 当前' : ''}</span>`;
                pageBadge.onclick = (e) => {
                    e.stopPropagation();
                    locatePdfPage(nextPage);
                };
            }
        } else if (group) {
            group.remove();
        }
        head.classList.toggle('is-empty-head', leftInfo.children.length === 0);
        return true;
    }

    function setNodeTag(nodeId, tagKey) {
        const normalizedTag = (tagKey && MATH_TAGS[tagKey]) ? tagKey : null;
        const canPatchInPlace = isMindmapOpen && !_mindmapDomDirty;
        commitMindMapChange((data) => {
            const node = findNodeInTree(data.root, nodeId);
            if (node) {
                node.tag = normalizedTag;
            }
        }, { render: false });
        if (canPatchInPlace && updateCardTagBadgeInPlace(nodeId, normalizedTag)) {
            _mindmapDomDirty = false;
            _lastRenderedMindmapRef = state.annotations['mindmap'];
            _svgLayoutCache = null;
            renderCommandDock();
            scheduleSvgConnectionsUpdate();
        } else if (isMindmapOpen) {
            renderTree();
        }
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
        });
    }

    function setNodePage(nodeId, newPage) {
        const normalizedPage = (newPage && newPage > 0) ? parseInt(newPage, 10) : null;
        const canPatchInPlace = isMindmapOpen && !_mindmapDomDirty;
        commitMindMapChange((data) => {
            const node = findNodeInTree(data.root, nodeId);
            if (node) {
                node.page = normalizedPage;
            }
        }, { render: false });
        _lastHighlightedPdfPage = -1;
        if (canPatchInPlace && updateCardPageBadgeInPlace(nodeId, normalizedPage)) {
            _mindmapDomDirty = false;
            _lastRenderedMindmapRef = state.annotations['mindmap'];
            _svgLayoutCache = null;
            renderCommandDock();
            scheduleSvgConnectionsUpdate();
        } else if (isMindmapOpen) {
            renderTree();
        }
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
        renderTree({ skipSvg: true });
        centerView(false, false, { skipSvg: true });
        updateSvgConnections();
        createdPage.panX = panX;
        createdPage.panY = panY;
        if (selectedNodeId) selectNode(selectedNodeId, false);
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
        _lastNormalizedMindmapData = null;

        selectedNodeId = null;
        selectedNodeIds.clear();

        const hasSavedPan = Number.isFinite(targetPage.panX) && Number.isFinite(targetPage.panY);
        if (hasSavedPan) {
            panX = targetPage.panX;
            panY = targetPage.panY;
            renderTree();
        } else {
            renderTree({ skipSvg: true });
            centerView(false, false, { skipSvg: true });
            updateSvgConnections();
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
            return true;
        }

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

    // ==========================================
    // 3.1 底部统一上下文操作台 (#mm-command-dock) 与单层内联抽屉 (#mm-dock-tray)
    // ==========================================

    function closeDockTray(options = {}) {
        const hadTray = Boolean(activeDockTray);
        const hadMerge = Boolean(mergingSourceNodeId || (mergingSourceNodeIds && mergingSourceNodeIds.length > 0));
        const hadReparent = Boolean(reparentingSourceNodeId);
        if (!hadTray && !hadMerge && !hadReparent) return;

        activeDockTray = null;
        activeSheetTargetId = null;
        if (!options.keepInteractive) {
            if (hadMerge) stopInteractiveMergeMode({ silentDock: true, keepTray: true });
            if (hadReparent) stopInteractiveReparentMode({ silentDock: true, keepTray: true });
        }
        if (!options.silentDock && isMindmapOpen) {
            renderCommandDock();
        }
    }

    function closeAllPopovers() {
        closeDockTray();
    }

    function openDockTray(trayName, targetId = null, options = {}) {
        if (!trayName) {
            closeDockTray();
            return;
        }
        if (trayName !== 'connect' && (mergingSourceNodeId || (mergingSourceNodeIds && mergingSourceNodeIds.length > 0))) {
            stopInteractiveMergeMode({ silentDock: true, keepTray: true });
        }
        if (trayName !== 'move' && reparentingSourceNodeId) {
            stopInteractiveReparentMode({ silentDock: true, keepTray: true });
        }
        if (trayName === 'sheet') {
            activeSheetTargetId = targetId || getActiveMindMapPage()?.id || null;
        } else {
            activeSheetTargetId = null;
            if (targetId && !selectedNodeIds.has(targetId)) {
                selectNode(targetId, false);
            }
        }
        if (trayName === 'connect') {
            if (options.mode) {
                dockConnectMode = options.mode;
            } else if (activeDockTray !== 'connect' && !mergingSourceNodeId) {
                dockConnectMode = selectedNodeIds.size > 1 ? 'converge' : 'link';
            }
        }
        activeDockTray = trayName;
        renderCommandDock({ focusTrayInput: options.focusInput !== false });
    }

    function toggleDockTray(trayName, targetId = null, options = {}) {
        if (activeDockTray === trayName && (!targetId || activeSheetTargetId === targetId)) {
            closeDockTray();
        } else {
            openDockTray(trayName, targetId, options);
        }
    }

    // 启动交互式自由合并连线模式（与连接面板单层融合，零额外顶部横幅）
    function startInteractiveMergeMode(sourceIds) {
        stopInteractiveReparentMode({ silentDock: true, keepTray: true });
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

        dockConnectMode = 'link';
        activeDockTray = 'connect';
        activeSheetTargetId = null;
        if (isMindmapOpen) {
            renderCommandDock({ focusTrayInput: false });
        }
    }

    function stopInteractiveMergeMode(options = {}) {
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
        document.querySelectorAll('.mm-connector-merge-preview').forEach(path => path.remove());
        if (!options.keepTray && activeDockTray === 'connect') {
            activeDockTray = null;
        }
        if (!options.silentDock && isMindmapOpen) {
            renderCommandDock();
        }
    }

    // 启动交互式更改挂载父节点模式（与顺序/挂载面板单层融合，零额外顶部横幅）
    function startInteractiveReparentMode(nodeId) {
        stopInteractiveMergeMode({ silentDock: true, keepTray: true });
        const data = getMindMapData();
        const targetId = nodeId || selectedNodeId;
        if (!targetId) return;
        const res = findParentAndList(data.root, targetId);
        if (!res || (res.containerType === 'chains' && data.nodes.length <= 1)) {
            return;
        }

        if (selectedNodeId !== targetId || selectedNodeIds.size > 1) {
            selectNode(targetId, false, false);
        }

        reparentingSourceNodeId = targetId;
        reparentingTargetNodeId = null;
        lastRawReparentTargetId = undefined;
        reparentMouseX = 0;
        reparentMouseY = 0;

        const els = getEls();
        if (els.viewport) {
            els.viewport.classList.add('is-reparenting-mode');
        }

        document.querySelectorAll('.mm-card.mm-reparent-source').forEach(c => c.classList.remove('mm-reparent-source'));
        const card = document.querySelector(`.mm-card[data-id="${targetId}"]`);
        if (card) card.classList.add('mm-reparent-source');

        activeDockTray = 'move';
        activeSheetTargetId = null;
        if (isMindmapOpen) {
            renderCommandDock({ focusTrayInput: false });
        }
    }

    function stopInteractiveReparentMode(options = {}) {
        reparentingSourceNodeId = null;
        reparentingTargetNodeId = null;
        lastRawReparentTargetId = undefined;
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
        document.querySelectorAll('.mm-connector-reparent-preview').forEach(path => path.remove());
        if (!options.keepTray && activeDockTray === 'move') {
            activeDockTray = null;
        }
        if (!options.silentDock && isMindmapOpen) {
            renderCommandDock();
        }
    }

    function showMindMapPagePickerPopover(pageId) {
        const targetId = pageId || getActiveMindMapPage()?.id;
        if (!targetId) return;
        openDockTray('sheet', targetId);
    }

    function refocusSelectedCard() {
        if (!selectedNodeId) return;
        const card = getEls().treeRoot?.querySelector(`.mm-card[data-id="${selectedNodeId}"]`);
        card?.focus({ preventScroll: true });
    }

    function renderDockTray(data, activePage, options = {}) {
        const els = getEls();
        const tray = els.dockTray;
        if (!tray) return;

        if (!activeDockTray) {
            tray.hidden = true;
            tray.replaceChildren();
            return;
        }

        const prevReparentQuery = tray.querySelector('#mm-reparent-search')?.value || '';
        const prevConnectQuery = tray.querySelector('#mm-connect-search')?.value || '';
        const curReadingPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;

        if (activeDockTray === 'sheet') {
            const pages = getMindMapPages(data);
            const targetPage = pages.find(p => p && p.id === (activeSheetTargetId || data.activePageId)) || activePage;
            if (!targetPage) {
                activeDockTray = null;
                tray.hidden = true;
                tray.replaceChildren();
                return;
            }
            tray.hidden = false;
            const curAssignedPage = targetPage.page || '';
            tray.innerHTML = `
                <div class="mm-tray-head">
                    <span class="mm-tray-title" title="${escapeMindMapText(targetPage.title || '当前导图页')}">
                        <i class="ph ph-bookmark-simple"></i>
                        <span>导图页设置 · ${escapeMindMapText(targetPage.title || '当前页')}</span>
                    </span>
                    <button type="button" id="mm-pop-close" class="mm-tray-close" aria-label="关闭导图页设置"><i class="ph ph-x"></i></button>
                </div>
                <div class="mm-tray-row">
                    <button type="button" id="mm-pop-bind-cur" class="mm-tray-btn ${targetPage.page === curReadingPage ? 'is-active' : ''}">
                        <i class="ph ph-book-open-text"></i>
                        <span>当前阅读页 (P.${curReadingPage})</span>
                    </button>
                    ${targetPage.page ? `<button type="button" id="mm-pop-locate" class="mm-tray-btn" title="跳转到 PDF 第 ${targetPage.page} 页"><i class="ph ph-arrow-square-out"></i><span>定位 P.${targetPage.page}</span></button>` : ''}
                </div>
                <div class="mm-tray-row">
                    <input type="number" id="mm-pop-input" class="mm-tray-input" min="1" max="9999" value="${curAssignedPage}" placeholder="关联 PDF 页码…" aria-label="导图页关联 PDF 页码">
                    <button type="button" id="mm-pop-clear" class="mm-tray-btn is-danger">清除</button>
                    <button type="button" id="mm-pop-ok" class="mm-tray-btn is-primary">确定</button>
                </div>
                <div class="mm-tray-divider"></div>
                <div class="mm-tray-row">
                    <input type="text" id="mm-sheet-rename-input" class="mm-tray-input" value="${escapeMindMapText(targetPage.title || '')}" placeholder="导图页名称" aria-label="导图页名称">
                    <button type="button" id="mm-sheet-rename-ok" class="mm-tray-btn">改名</button>
                    <button type="button" id="mm-sheet-add-after" class="mm-tray-btn" title="在右侧新建导图页 (Alt+T)"><i class="ph ph-plus"></i><span>新页</span></button>
                    <button type="button" id="mm-sheet-delete" class="mm-tray-btn is-danger" title="${pages.length > 1 ? '删除此导图页' : '清空重置此导图页'}" aria-label="${pages.length > 1 ? '删除此导图页' : '清空重置此导图页'}"><i class="ph ph-trash"></i></button>
                </div>
            `;

            const input = tray.querySelector('#mm-pop-input');
            const renameInput = tray.querySelector('#mm-sheet-rename-input');
            const applySheetPdf = (nextPage) => {
                setMindMapPagePdfPage(targetPage.id, nextPage);
                closeDockTray();
            };

            tray.querySelector('#mm-pop-ok').onclick = () => {
                const val = input.value.trim();
                applySheetPdf(val ? parseInt(val, 10) : null);
            };
            tray.querySelector('#mm-pop-bind-cur').onclick = () => applySheetPdf(curReadingPage);
            tray.querySelector('#mm-pop-clear').onclick = () => applySheetPdf(null);
            const locateBtn = tray.querySelector('#mm-pop-locate');
            if (locateBtn) {
                locateBtn.onclick = () => {
                    if (data.activePageId !== targetPage.id) {
                        switchMindMapPage(targetPage.id, { locatePdf: true });
                    } else if (targetPage.page) {
                        locatePdfPage(targetPage.page);
                    }
                    closeDockTray();
                };
            }
            const commitSheetRename = () => {
                const nextTitle = renameInput.value.trim();
                if (nextTitle && nextTitle !== targetPage.title) {
                    renameMindMapPage(targetPage.id, nextTitle);
                }
                closeDockTray();
            };
            tray.querySelector('#mm-sheet-rename-ok').onclick = commitSheetRename;
            tray.querySelector('#mm-sheet-add-after').onclick = () => {
                closeDockTray({ silentDock: true });
                addMindMapPage({ insertAfterId: targetPage.id });
            };
            tray.querySelector('#mm-sheet-delete').onclick = () => {
                closeDockTray({ silentDock: true });
                deleteMindMapPage(targetPage.id);
            };
            tray.querySelector('#mm-pop-close').onclick = () => closeDockTray();

            input.onkeydown = (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = input.value.trim();
                    applySheetPdf(val ? parseInt(val, 10) : null);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeDockTray();
                }
            };
            renameInput.onkeydown = (e) => {
                e.stopPropagation();
                if (e.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter') {
                    e.preventDefault();
                    commitSheetRename();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeDockTray();
                }
            };
            if (options.focusTrayInput) {
                input.focus({ preventScroll: true });
                input.select();
            }
            return;
        }

        const leadId = mergingSourceNodeId || reparentingSourceNodeId || selectedNodeId || [...selectedNodeIds][0] || null;
        const node = leadId ? findNodeInTree(data, leadId) : null;
        if (!node) {
            activeDockTray = null;
            tray.hidden = true;
            tray.replaceChildren();
            return;
        }

        if (activeDockTray === 'tag') {
            tray.hidden = false;
            tray.innerHTML = `
                <div class="mm-tray-head">
                    <span class="mm-tray-title"><i class="ph ph-tag"></i><span>数学理论角色</span></span>
                    <div class="mm-tray-head-right">
                        <button type="button" id="mm-tag-clear" class="mm-tray-link-danger">清除角色</button>
                        <button type="button" id="mm-pop-close" class="mm-tray-close" aria-label="关闭角色面板"><i class="ph ph-x"></i></button>
                    </div>
                </div>
                <div class="mm-tray-tag-grid">
                    ${Object.entries(MATH_TAGS).map(([k, t]) => `
                        <button type="button" class="mm-tag-pick-btn mm-tag-${k} ${node.tag === k ? 'is-active' : ''}" data-key="${k}">
                            <i class="ph ${t.icon}"></i><span>${t.label}</span>
                        </button>
                    `).join('')}
                </div>
            `;
            tray.querySelectorAll('.mm-tag-pick-btn').forEach(btn => {
                btn.onclick = () => {
                    const k = btn.dataset.key;
                    closeDockTray({ silentDock: true });
                    setNodeTag(node.id, k);
                };
            });
            tray.querySelector('#mm-tag-clear').onclick = () => {
                closeDockTray({ silentDock: true });
                setNodeTag(node.id, null);
            };
            tray.querySelector('#mm-pop-close').onclick = () => {
                closeDockTray();
                refocusSelectedCard();
            };
            return;
        }

        if (activeDockTray === 'page') {
            tray.hidden = false;
            const curAssignedPage = node.page || '';
            tray.innerHTML = `
                <div class="mm-tray-head">
                    <span class="mm-tray-title"><i class="ph ph-bookmark-simple"></i><span>设置关联页码</span></span>
                    <button type="button" id="mm-pop-close" class="mm-tray-close" aria-label="关闭页码面板"><i class="ph ph-x"></i></button>
                </div>
                <div class="mm-tray-row">
                    <button type="button" id="mm-pop-bind-cur" class="mm-tray-btn ${node.page === curReadingPage ? 'is-active' : ''}">
                        <i class="ph ph-book-open-text"></i>
                        <span>当前阅读页 (P.${curReadingPage})</span>
                    </button>
                    ${node.page ? `<button type="button" id="mm-pop-locate" class="mm-tray-btn" title="定位到 PDF 第 ${node.page} 页"><i class="ph ph-arrow-square-out"></i><span>定位 P.${node.page}</span></button>` : ''}
                </div>
                <div class="mm-tray-row">
                    <input type="number" id="mm-pop-input" class="mm-tray-input" min="1" max="9999" value="${curAssignedPage}" placeholder="输入 PDF 页码…" aria-label="PDF 页码">
                    <button type="button" id="mm-pop-clear" class="mm-tray-btn is-danger">清除</button>
                    <button type="button" id="mm-pop-ok" class="mm-tray-btn is-primary">确定</button>
                </div>
            `;
            const input = tray.querySelector('#mm-pop-input');
            const applyNodePdf = (nextPage) => {
                closeDockTray({ silentDock: true });
                setNodePage(node.id, nextPage);
                refocusSelectedCard();
            };
            tray.querySelector('#mm-pop-ok').onclick = () => {
                const val = input.value.trim();
                applyNodePdf(val ? parseInt(val, 10) : null);
            };
            tray.querySelector('#mm-pop-bind-cur').onclick = () => applyNodePdf(curReadingPage);
            tray.querySelector('#mm-pop-clear').onclick = () => applyNodePdf(null);
            const locateBtn = tray.querySelector('#mm-pop-locate');
            if (locateBtn) {
                locateBtn.onclick = () => {
                    if (node.page) locatePdfPage(node.page);
                };
            }
            tray.querySelector('#mm-pop-close').onclick = () => {
                closeDockTray();
                refocusSelectedCard();
            };
            input.onkeydown = (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = input.value.trim();
                    applyNodePdf(val ? parseInt(val, 10) : null);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeDockTray();
                    refocusSelectedCard();
                }
            };
            if (options.focusTrayInput) {
                input.focus({ preventScroll: true });
                input.select();
            }
            return;
        }

        if (activeDockTray === 'connect') {
            tray.hidden = false;
            const res = findParentAndList(data, node.id);
            const candidates = getReparentCandidates(data, node.id, true);
            const initialSources = (mergingSourceNodeIds && mergingSourceNodeIds.length > 0)
                ? mergingSourceNodeIds
                : (selectedNodeIds.has(node.id) ? [...selectedNodeIds] : [node.id]);
            const sources = new Set(initialSources);
            sources.add(node.id);
            const canConvergeFork = isVerticalSpineNode(data, node.id)
                && (node.branches?.length || res?.containerType === 'fork-track');
            let mode = dockConnectMode || (sources.size > 1 ? 'converge' : 'link');

            tray.innerHTML = `
                <div class="mm-tray-head">
                    <span class="mm-tray-title">
                        <i class="ph ph-git-merge"></i>
                        <span>连接节点${sources.size > 1 ? ` · ${sources.size} 项` : ''}</span>
                    </span>
                    <button type="button" id="mm-pop-close" class="mm-tray-close" aria-label="关闭连接面板"><i class="ph ph-x"></i></button>
                </div>
                ${canConvergeFork ? '<button type="button" id="mm-pop-converge-fork" class="mm-connect-secondary"><i class="ph ph-arrows-merge"></i><span>合流当前并行分支</span></button>' : ''}
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
                    <button type="button" id="mm-pop-pick-canvas" class="mm-pop-canvas-btn ${mergingSourceNodeId ? 'is-active' : ''}" title="在画布上直接点击目标节点连线 (快捷键 M)">
                        <i class="ph ph-cursor-click"></i>
                        <span>${mergingSourceNodeId ? '点选中' : '点选'}</span>
                    </button>
                </div>
                ${mergingSourceNodeId ? '<div id="mm-merge-target-hint" class="mm-tray-hint is-live" role="status">点击画布目标建立连线 · 再点解除 · Esc 取消</div>' : ''}
                <div id="mm-merge-cand-list" class="mm-connect-list custom-scrollbar"></div>
                <button type="button" id="mm-pop-converge-next" class="mm-connect-primary"></button>
                <div id="mm-connect-existing" style="display:none;"></div>
            `;

            const list = tray.querySelector('#mm-merge-cand-list');
            const search = tray.querySelector('#mm-connect-search');
            const primary = tray.querySelector('#mm-pop-converge-next');
            const canvasPickBtn = tray.querySelector('#mm-pop-pick-canvas');
            if (prevConnectQuery) search.value = prevConnectQuery;

            function renderCandidates() {
                canvasPickBtn.style.display = mode === 'link' ? 'inline-flex' : 'none';
                primary.hidden = mode !== 'converge';
                primary.textContent = `合流为新阶段 · ${sources.size} 项`;

                list.replaceChildren();
                const choices = mode === 'converge'
                    ? [{ id: node.id, text: node.text || '当前节点', current: true }, ...candidates]
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
                        row.title = mode === 'fuse' ? '将当前节点内容并入此节点' : linked ? '解除此连线' : '连线到此节点';
                        row.onclick = () => {
                            const activeSources = [...sources];
                            closeDockTray({ silentDock: true });
                            if (mode === 'fuse') {
                                fuseNodeInto(node.id, cand.id);
                            } else if (activeSources.length > 1) {
                                activeSources.forEach(sId => toggleMergeLink(sId, cand.id));
                            } else {
                                toggleMergeLink(node.id, cand.id);
                            }
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
                    } else if (mode === 'converge' && !cand.current) {
                        const intoBtn = document.createElement('button');
                        intoBtn.type = 'button';
                        intoBtn.className = 'mm-pop-link-action';
                        intoBtn.title = '实线合流汇入此已有节点';
                        intoBtn.textContent = '汇入';
                        intoBtn.onclick = (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            const activeSources = [...sources];
                            closeDockTray({ silentDock: true });
                            convergeNodesToNext(activeSources, cand.id);
                        };
                        row.appendChild(intoBtn);
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

            tray.querySelectorAll('[data-mode]').forEach(tab => {
                tab.onclick = () => {
                    mode = tab.dataset.mode;
                    dockConnectMode = mode;
                    if (mode !== 'link' && mergingSourceNodeId) {
                        stopInteractiveMergeMode({ keepTray: true, silentDock: true });
                        canvasPickBtn.classList.remove('is-active');
                        const hintEl = tray.querySelector('#mm-merge-target-hint');
                        if (hintEl) hintEl.remove();
                    }
                    tray.querySelectorAll('[data-mode]').forEach(t => {
                        const active = (t === tab);
                        t.setAttribute('aria-selected', String(active));
                        t.classList.toggle('is-active', active);
                    });
                    renderCandidates();
                };
            });
            search.oninput = renderCandidates;
            search.onkeydown = (e) => {
                e.stopPropagation();
                if (e.key === 'Escape') {
                    e.preventDefault();
                    closeDockTray();
                    refocusSelectedCard();
                }
            };
            primary.onclick = () => {
                const activeSources = [...sources];
                closeDockTray({ silentDock: true });
                convergeNodesToNext(activeSources);
            };
            canvasPickBtn.onclick = (e) => {
                e.stopPropagation();
                if (mergingSourceNodeId) {
                    stopInteractiveMergeMode({ keepTray: true });
                } else {
                    startInteractiveMergeMode([...sources]);
                }
            };
            const forkBtn = tray.querySelector('#mm-pop-converge-fork');
            if (forkBtn) {
                forkBtn.onclick = () => {
                    closeDockTray({ silentDock: true });
                    convergeBranches(node.id, { forceFork: true });
                };
            }

            const links = [];
            getIncomingMergeSources(data, node.id).forEach(src => links.push({
                source: src.id, target: node.id, solid: src.convergeTo?.includes(node.id), text: `← ${src.text || '节点'}`
            }));
            [['convergeTo', true], ['mergeTo', false]].forEach(([key, solid]) => {
                (node[key] || []).forEach(id => {
                    const target = findNodeInTree(data, id);
                    if (target) links.push({ source: node.id, target: id, solid, text: `→ ${target.text || '节点'}` });
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
                        closeDockTray({ silentDock: true });
                        if (link.solid) toggleConvergeLink(link.source, link.target);
                        else toggleMergeLink(link.source, link.target);
                    };
                    chip.append(name, del);
                    bar.appendChild(chip);
                });
                const existingWrap = tray.querySelector('#mm-connect-existing');
                existingWrap.style.display = 'block';
                existingWrap.replaceChildren(bar);
            }
            tray.querySelector('#mm-pop-close').onclick = () => {
                closeDockTray();
                refocusSelectedCard();
            };
            renderCandidates();
            return;
        }

        if (activeDockTray === 'move') {
            tray.hidden = false;
            const res = findParentAndList(data, node.id);
            const chains = getAllMainChains(data);
            const isChainRoot = Boolean(res && res.containerType === 'chains');
            const canReparent = !(isChainRoot && chains.length <= 1);
            const canUp = canMoveNodeStep(data, node.id, -1);
            const canDown = canMoveNodeStep(data, node.id, 1);
            const canPromote = canPromoteNode(data, node.id);
            const canDemote = canDemoteNode(data, node.id);
            const hasSub = (node.children && node.children.length > 0) || (node.branches && node.branches.length > 0);
            const candidates = canReparent ? getReparentCandidates(data, node.id) : [];

            tray.innerHTML = `
                <div class="mm-tray-head">
                    <span class="mm-tray-title"><i class="ph ph-arrows-out-cardinal"></i><span>顺序与层级挂载</span></span>
                    <div class="mm-tray-head-right">
                        ${hasSub ? `<button type="button" id="mm-move-toggle-fold" class="mm-tray-btn" style="height:21px;padding:0 6px;font-size:10.5px;">${isChainRoot ? '折叠/展开子支' : (node.collapsed ? '展开下属' : '折叠下属')}</button>` : ''}
                        <button type="button" id="mm-pop-close" class="mm-tray-close" aria-label="关闭移动面板"><i class="ph ph-x"></i></button>
                    </div>
                </div>
                <div class="mm-tray-move-grid">
                    <button type="button" id="mm-move-up" class="mm-tray-btn" ${canUp ? '' : 'disabled'} title="同级上移 / 前移 (Alt+↑)"><i class="ph ph-arrow-up"></i><span>上移</span></button>
                    <button type="button" id="mm-move-down" class="mm-tray-btn" ${canDown ? '' : 'disabled'} title="同级下移 / 后移 (Alt+↓)"><i class="ph ph-arrow-down"></i><span>下移</span></button>
                    <button type="button" id="mm-move-promote" class="mm-tray-btn" ${canPromote ? '' : 'disabled'} title="提升一层级 (Alt+←)"><i class="ph ph-arrow-left"></i><span>升级</span></button>
                    <button type="button" id="mm-move-demote" class="mm-tray-btn" ${canDemote ? '' : 'disabled'} title="挂载为上一同级的子节点 (Alt+→)"><i class="ph ph-arrow-right"></i><span>降级</span></button>
                </div>
                ${canReparent ? `
                    <div class="mm-tray-divider"></div>
                    <div class="mm-pop-search-wrap">
                        <div class="mm-pop-search-field">
                            <i class="ph ph-magnifying-glass mm-pop-search-icon"></i>
                            <input id="mm-reparent-search" class="mm-pop-search-input" type="search" placeholder="搜索新父节点…" aria-label="搜索新父节点">
                        </div>
                        <button type="button" id="mm-reparent-pick-canvas" class="mm-pop-canvas-btn ${reparentingSourceNodeId === node.id ? 'is-active' : ''}" title="在画布上直接点击新父节点 (快捷键 R)">
                            <i class="ph ph-cursor-click"></i>
                            <span>${reparentingSourceNodeId === node.id ? '点选中' : '点选'}</span>
                        </button>
                    </div>
                    ${reparentingSourceNodeId === node.id ? '<div id="mm-reparent-target-hint" class="mm-tray-hint is-live" role="status">直接点击画布上的新父节点完成挂载 · Esc 取消</div>' : ''}
                    <div id="mm-reparent-list" class="mm-connect-list custom-scrollbar"></div>
                ` : ''}
            `;

            tray.querySelector('#mm-move-up').onclick = () => moveNodeStep(node.id, -1);
            tray.querySelector('#mm-move-down').onclick = () => moveNodeStep(node.id, 1);
            tray.querySelector('#mm-move-promote').onclick = () => promoteNode(node.id);
            tray.querySelector('#mm-move-demote').onclick = () => demoteNode(node.id);
            const foldBtn = tray.querySelector('#mm-move-toggle-fold');
            if (foldBtn) {
                foldBtn.onclick = () => toggleNodeCollapse(node.id);
            }
            tray.querySelector('#mm-pop-close').onclick = () => {
                closeDockTray();
                refocusSelectedCard();
            };

            if (canReparent) {
                const listEl = tray.querySelector('#mm-reparent-list');
                const searchInput = tray.querySelector('#mm-reparent-search');
                const canvasBtn = tray.querySelector('#mm-reparent-pick-canvas');
                const currentParentId = res && res.parent ? res.parent.id : null;
                if (prevReparentQuery) searchInput.value = prevReparentQuery;

                const renderReparentList = () => {
                    listEl.replaceChildren();
                    const q = searchInput.value.trim().toLocaleLowerCase();
                    const filtered = candidates.filter(c => String(c.text || '').toLocaleLowerCase().includes(q));
                    filtered.forEach(cand => {
                        const isCurParent = (cand.id === currentParentId);
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'mm-connect-row';
                        btn.style.paddingLeft = `${Math.min(cand.depth, 4) * 10 + 6}px`;
                        btn.innerHTML = `
                            <i class="ph ${cand.depth === 0 ? 'ph-compass' : 'ph-arrow-elbow-down-right'} text-gray-400 text-xs shrink-0"></i>
                            <span class="truncate">${escapeMindMapText(cand.text)}</span>
                            ${isCurParent ? '<small style="color:#2563eb;background:#eff6ff;">当前父级</small>' : `<small>主链 ${toRoman(cand.chainIdx)}</small>`}
                        `;
                        btn.onclick = () => {
                            closeDockTray({ silentDock: true });
                            reparentNode(node.id, cand.id);
                        };
                        listEl.appendChild(btn);
                    });
                    if (!listEl.children.length) {
                        listEl.innerHTML = '<p class="mm-pop-empty-text">无匹配节点</p>';
                    }
                };

                searchInput.oninput = renderReparentList;
                searchInput.onkeydown = (e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        closeDockTray();
                        refocusSelectedCard();
                    }
                };
                canvasBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    if (reparentingSourceNodeId === node.id) {
                        stopInteractiveReparentMode({ keepTray: true });
                    } else {
                        startInteractiveReparentMode(node.id);
                    }
                };
                renderReparentList();
            }
        }
    }

    function renderCommandDock(options = {}) {
        const els = getEls();
        if (!els.dock || !els.dockBar) return;

        const data = getMindMapData();
        const activePage = getActiveMindMapPage(data);
        const chains = getAllMainChains(data);
        const count = selectedNodeIds.size;

        els.dock.classList.toggle('is-idle', count === 0 && activeDockTray !== 'sheet');

        // 1. 多节点选中态：聚焦批量合流与批量连线
        if (count > 1) {
            if (activeDockTray && activeDockTray !== 'connect') {
                activeDockTray = null;
                activeSheetTargetId = null;
            }
            els.dockBar.innerHTML = `
                <span class="mm-dock-sel-badge">已选 ${count} 项</span>
                <button type="button" id="mm-dock-multi-converge" class="mm-dock-btn mm-dock-pill mm-dock-primary" title="将所选节点实线合流至新阶段节点 (Enter)">
                    <i class="ph ph-arrows-merge"></i><span>合流新节点</span>
                </button>
                <button type="button" id="mm-dock-multi-connect" class="mm-dock-btn mm-dock-pill ${(activeDockTray === 'connect' || mergingSourceNodeId) ? 'is-active' : ''}" title="连线或合流至已有目标节点 (M)">
                    <i class="ph ph-git-merge"></i><span>连线目标</span>
                </button>
                <button type="button" id="mm-dock-multi-clear" class="mm-dock-btn" title="取消多选 (Esc)" aria-label="取消多选">
                    <i class="ph ph-x"></i>
                </button>
            `;
            els.dockBar.querySelector('#mm-dock-multi-converge').onclick = () => {
                closeDockTray({ silentDock: true });
                convergeNodesToNext([...selectedNodeIds]);
            };
            els.dockBar.querySelector('#mm-dock-multi-connect').onclick = () => {
                toggleDockTray('connect', null, { mode: 'link' });
            };
            els.dockBar.querySelector('#mm-dock-multi-clear').onclick = () => {
                closeDockTray({ silentDock: true });
                selectNode(null, false);
            };
            renderDockTray(data, activePage, options);
            return;
        }

        // 2. 单节点选中态：纯图标紧凑上下文操作栏
        const singleId = selectedNodeId || (count === 1 ? [...selectedNodeIds][0] : null);
        const node = singleId ? findNodeInTree(data, singleId) : null;
        if (node) {
            const res = findParentAndList(data, node.id);
            const isChainRoot = Boolean(res && res.containerType === 'chains');
            const isPrimaryRoot = Boolean(data.root && data.root.id === node.id && chains.length <= 1);
            const isVerticalMain = isVerticalSpineNode(data, node.id);
            const hasForkTracks = Array.isArray(node.branches) && node.branches.some(t => Array.isArray(t) && t.length > 0);
            const forkOwner = hasForkTracks ? node : (res?.containerType === 'fork-track' ? res.parent : null);
            let needsForkConverge = false;
            if (isVerticalMain && forkOwner) {
                const ownerIsRoot = chains.some(c => c && c.id === forkOwner.id);
                const ownerRes = ownerIsRoot ? null : findParentAndList(data, forkOwner.id);
                const ownerHasDownstream = ownerIsRoot
                    ? Boolean(!forkOwner.collapsed && Array.isArray(forkOwner.children) && forkOwner.children.length > 0)
                    : Boolean(ownerRes && ownerRes.list && ownerRes.index < ownerRes.list.length - 1);
                needsForkConverge = forkOwner.forkConverge === false || !ownerHasDownstream;
            }
            const hasTag = Boolean(node.tag && MATH_TAGS[node.tag]);
            const hasPage = Boolean(node.page && node.page > 0);
            const hasLinks = Boolean(
                (Array.isArray(node.mergeTo) && node.mergeTo.length > 0) ||
                (Array.isArray(node.convergeTo) && node.convergeTo.length > 0) ||
                getIncomingMergeSources(data, node.id).length > 0
            );

            const downTitle = isChainRoot
                ? '向下推进主链阶段 (Enter)'
                : (isVerticalMain ? '向下推进下一阶段 (Enter)' : '向下添加同级节点 (Enter)');
            const rightTitle = isChainRoot
                ? '在右侧新建并列主链 (Tab)'
                : '向右展开子分支 (Tab)';
            const tagTitle = hasTag
                ? `数学角色：${MATH_TAGS[node.tag].label}（点击更改）`
                : '标记数学理论角色';
            const pageTitle = hasPage
                ? `已关联 P.${node.page}（左键修改 · 右键切换当前页 P）`
                : '关联 PDF 页码（左键设置 · 右键绑定当前页 P）';
            const delTitle = isPrimaryRoot
                ? '清空重置导图 (Del)'
                : (isChainRoot ? '删除整条主链 (Del)' : '删除节点 (Del)');

            els.dockBar.innerHTML = `
                <button type="button" id="mm-dock-add-down" class="mm-dock-btn" title="${downTitle}" aria-label="${downTitle}">
                    <i class="ph ph-rows-plus-bottom"></i>
                </button>
                <button type="button" id="mm-dock-add-right" class="mm-dock-btn" title="${rightTitle}" aria-label="${rightTitle}">
                    <i class="ph ph-columns-plus-right"></i>
                </button>
                ${isVerticalMain ? `
                    <button type="button" id="mm-dock-fork" class="mm-dock-btn" title="向下拆分并行推演 (Shift+Enter)" aria-label="向下拆分并行推演">
                        <i class="ph ph-git-fork"></i>
                    </button>
                ` : ''}
                ${needsForkConverge ? `
                    <button type="button" id="mm-dock-converge-fork" class="mm-dock-btn" title="合流并行分支至下游主节点" aria-label="合流并行分支为主节点">
                        <i class="ph ph-arrows-merge"></i>
                    </button>
                ` : ''}
                <span class="mm-dock-sep" aria-hidden="true"></span>
                <button type="button" id="mm-dock-edit" class="mm-dock-btn" title="编辑内容与公式 (双击 / F2)" aria-label="编辑节点">
                    <i class="ph ph-pencil-simple"></i>
                </button>
                <button type="button" id="mm-dock-tag" class="mm-dock-btn ${activeDockTray === 'tag' ? 'is-active' : ''} ${hasTag ? 'has-value' : ''}" title="${tagTitle}" aria-label="数学理论角色">
                    <i class="ph ph-tag"></i>
                </button>
                <button type="button" id="mm-dock-page" class="mm-dock-btn ${activeDockTray === 'page' ? 'is-active' : ''} ${hasPage ? 'has-value' : ''}" title="${pageTitle}" aria-label="关联页码">
                    <i class="ph ph-bookmark-simple"></i>
                </button>
                <span class="mm-dock-sep" aria-hidden="true"></span>
                <button type="button" id="mm-dock-connect" class="mm-dock-btn ${(activeDockTray === 'connect' || mergingSourceNodeId) ? 'is-active' : ''} ${hasLinks ? 'has-value' : ''}" title="连接节点：连线、合流与内容融合 (M)" aria-label="连接节点">
                    <i class="ph ph-git-merge"></i>
                </button>
                <button type="button" id="mm-dock-move" class="mm-dock-btn ${(activeDockTray === 'move' || reparentingSourceNodeId) ? 'is-active' : ''}" title="调整顺序、升降级与挂载父节点 (Alt+方向键 / R)" aria-label="顺序与挂载">
                    <i class="ph ph-arrows-out-cardinal"></i>
                </button>
                <span class="mm-dock-sep" aria-hidden="true"></span>
                <button type="button" id="mm-dock-delete" class="mm-dock-btn mm-dock-danger" title="${delTitle}" aria-label="${delTitle}">
                    <i class="ph ph-trash"></i>
                </button>
            `;

            els.dockBar.querySelector('#mm-dock-add-down').onclick = () => {
                closeDockTray({ silentDock: true });
                if (isChainRoot) addChildNode(node.id);
                else addSiblingNode(node.id);
            };
            els.dockBar.querySelector('#mm-dock-add-right').onclick = () => {
                closeDockTray({ silentDock: true });
                if (isChainRoot) addMainChain(null, node.id);
                else addChildNode(node.id);
            };
            const forkBtn = els.dockBar.querySelector('#mm-dock-fork');
            if (forkBtn) {
                forkBtn.onclick = () => {
                    closeDockTray({ silentDock: true });
                    forkNodeBranch(node.id);
                };
            }
            const convForkBtn = els.dockBar.querySelector('#mm-dock-converge-fork');
            if (convForkBtn) {
                convForkBtn.onclick = () => {
                    closeDockTray({ silentDock: true });
                    convergeBranches(node.id, { forceFork: true });
                };
            }
            els.dockBar.querySelector('#mm-dock-edit').onclick = () => {
                closeDockTray({ silentDock: true });
                startEditingNode(node.id);
            };
            els.dockBar.querySelector('#mm-dock-tag').onclick = () => toggleDockTray('tag');
            const pageBtn = els.dockBar.querySelector('#mm-dock-page');
            pageBtn.onclick = () => toggleDockTray('page');
            pageBtn.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeDockTray({ silentDock: true });
                const curPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
                setNodePage(node.id, node.page === curPage ? null : curPage);
            };
            els.dockBar.querySelector('#mm-dock-connect').onclick = () => toggleDockTray('connect');
            els.dockBar.querySelector('#mm-dock-move').onclick = () => toggleDockTray('move');
            els.dockBar.querySelector('#mm-dock-delete').onclick = () => {
                closeDockTray({ silentDock: true });
                deleteNode(node.id);
            };

            renderDockTray(data, activePage, options);
            return;
        }

        // 3. 画布空闲态：安静轻量的全局快捷胶囊
        if (activeDockTray && activeDockTray !== 'sheet') {
            activeDockTray = null;
        }
        els.dockBar.innerHTML = `
            <button type="button" id="mm-dock-add-chain" class="mm-dock-btn mm-dock-pill" title="新建一条并列主链 (Alt+N)">
                <i class="ph ph-plus"></i><span>主链</span>
            </button>
            <span class="mm-dock-sep" aria-hidden="true"></span>
            <button type="button" id="mm-dock-sheet-btn" class="mm-dock-btn mm-dock-pill ${activeDockTray === 'sheet' ? 'is-active' : ''} ${activePage?.page ? 'has-value' : ''}" title="导图页设置与关联页码 (左键设置 · 右键绑定当前页 P)">
                <i class="ph ph-bookmark-simple"></i><span>${activePage?.page ? `P.${activePage.page}` : '本页'}</span>
            </button>
            <button type="button" id="mm-dock-fit-btn" class="mm-dock-btn" title="自适应全图视野 (Ctrl+0)" aria-label="自适应全图视野">
                <i class="ph ph-corners-out"></i>
            </button>
            <button type="button" id="mm-dock-expand-btn" class="mm-dock-btn" title="展开 / 折叠所有子分支" aria-label="展开或折叠所有子分支">
                <i class="ph ph-arrows-in-line-vertical"></i>
            </button>
        `;
        els.dockBar.querySelector('#mm-dock-add-chain').onclick = () => {
            closeDockTray({ silentDock: true });
            addMainChain();
        };
        const sheetBtn = els.dockBar.querySelector('#mm-dock-sheet-btn');
        sheetBtn.onclick = () => toggleDockTray('sheet', activePage?.id);
        sheetBtn.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!activePage) return;
            closeDockTray({ silentDock: true });
            const curPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
            setMindMapPagePdfPage(activePage.id, activePage.page === curPage ? null : curPage);
        };
        els.dockBar.querySelector('#mm-dock-fit-btn').onclick = () => centerView(true, true);
        els.dockBar.querySelector('#mm-dock-expand-btn').onclick = () => toggleAllNodes(null);

        renderDockTray(data, activePage, options);
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
        closeDockTray({ silentDock: true });
        selectNode(nodeId, false);
        getEls().dock?.classList.add('is-editing-dim');
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

        // 自适应高度并按帧合并更新贝塞尔连接线（高度未变时不重算全图连线）
        let lastAutoHeight = 0;
        const autoHeight = () => {
            textarea.style.height = 'auto';
            const nextHeight = Math.max(48, textarea.scrollHeight);
            textarea.style.height = nextHeight + 'px';
            if (nextHeight !== lastAutoHeight) {
                lastAutoHeight = nextHeight;
                scheduleSvgConnectionsUpdate();
            }
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
                getEls().dock?.classList.remove('is-editing-dim');
                renderCommandDock();
                updateSvgConnections();
                if (refocus) cardEl.focus({ preventScroll: true });
            } else {
                getEls().dock?.classList.remove('is-editing-dim');
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

            // 2. Tab 键：优先由共用的 QuantumSnippetEngine 执行 LaTeX 手动展开或占位符跳转（如 \dfrac{$0}{$1}）
            if (e.key === 'Tab') {
                if (e.defaultPrevented || (snippetEngine && snippetEngine.hasActiveTabStops())) {
                    // 已被 QuantumSnippetEngine 拦截（执行了 Tab 展开或跳入下一/末尾占位符），不退出编辑、不新建子节点
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
        if (!text || text.trim() === '') {
            targetEl.classList.add('mm-empty-prompt');
            targetEl.textContent = '双击编辑节点内容...';
            return;
        }
        targetEl.classList.remove('mm-empty-prompt');
        const source = String(text).replace(/\r\n?/g, '\n');
        const mayHaveTikz = Boolean(window.TikzRender && source.includes('\\begin{'));
        const blocks = mayHaveTikz ? window.TikzRender.scanTikzBlocks(source, false) : [];
        const hasMath = source.includes('$') || source.includes('\\(') || source.includes('\\[');

        if (blocks.length === 0) {
            if (!hasMath || !window.renderMathInElement) {
                targetEl.textContent = source;
                return;
            }
            const cachedHtml = _nodeContentHtmlCache.get(source);
            if (cachedHtml !== undefined) {
                // LRU 命中：直接复用已渲染的 KaTeX HTML，跳过重复公式解析
                _nodeContentHtmlCache.delete(source);
                _nodeContentHtmlCache.set(source, cachedHtml);
                targetEl.innerHTML = cachedHtml;
                return;
            }
            targetEl.textContent = source;
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
                if (_nodeContentHtmlCache.size >= MAX_NODE_CONTENT_CACHE) {
                    _nodeContentHtmlCache.delete(_nodeContentHtmlCache.keys().next().value);
                }
                _nodeContentHtmlCache.set(source, targetEl.innerHTML);
            } catch (err) {
                console.warn('KaTeX render warning:', err);
            }
            return;
        }

        targetEl.innerHTML = '';
        let offset = 0;
        blocks.forEach(block => {
            targetEl.appendChild(document.createTextNode(source.slice(offset, block.start)));
            renderNodeTikz(targetEl, block.code);
            offset = block.end;
        });
        targetEl.appendChild(document.createTextNode(source.slice(offset)));

        if (hasMath && window.renderMathInElement) {
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
        const hasChildren = node.children && node.children.length > 0;
        const ownForkHasDownstream = isRoot
            ? (!node.collapsed && hasChildren)
            : Boolean(options.hasDownstream);
        const ownForkNeedsConverge = (isRoot || isSpine) && hasForkBranches && (node.forkConverge === false || !ownForkHasDownstream);
        const data = options.data || getMindMapData();
        const renderIndex = options.renderIndex || null;

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
            draggingNodeObj = node;
            card.classList.add('dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', node.id);
            }
        });
        card.addEventListener('dragend', () => {
            draggingNodeId = null;
            draggingNodeObj = null;
            card.classList.remove('dragging');
            document.querySelectorAll('.mm-card[data-drop-hint]').forEach(el => {
                el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-merge');
                delete el.dataset.dropHint;
            });
        });
        card.addEventListener('dragover', (e) => {
            if (!draggingNodeId || draggingNodeId === node.id) return;
            const dragSrcNode = draggingNodeObj || findNodeInTree(data, draggingNodeId);
            if (dragSrcNode && isNodeInSubtree(dragSrcNode, node.id)) return;
            e.preventDefault();
            const rect = card.getBoundingClientRect();
            const relY = (e.clientY - rect.top) / Math.max(1, rect.height);
            let nextClass, nextHint;
            if (e.shiftKey) {
                nextClass = 'drag-over-merge';
                nextHint = '松开连线汇入';
            } else if (e.altKey || isRoot || (relY >= 0.28 && relY <= 0.72)) {
                nextClass = 'drag-over-child';
                nextHint = '移为子节点';
            } else if (relY < 0.28) {
                nextClass = 'drag-over-top';
                nextHint = '插入此节点之前';
            } else {
                nextClass = 'drag-over-bottom';
                nextHint = '插入此节点之后';
            }
            if (card.dataset.dropHint !== nextHint || !card.classList.contains(nextClass)) {
                card.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-merge');
                card.classList.add(nextClass);
                card.dataset.dropHint = nextHint;
            }
        });
        card.addEventListener('dragleave', () => {
            card.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-merge');
            delete card.dataset.dropHint;
        });
        card.addEventListener('drop', (e) => {
            if (!draggingNodeId || draggingNodeId === node.id) return;
            const dragSrcNode = draggingNodeObj || findNodeInTree(data, draggingNodeId);
            if (dragSrcNode && isNodeInSubtree(dragSrcNode, node.id)) return;
            e.preventDefault();
            e.stopPropagation();
            const srcId = draggingNodeId;
            const isChildDrop = card.classList.contains('drag-over-child');
            const isTopDrop = card.classList.contains('drag-over-top');
            card.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-merge');
            delete card.dataset.dropHint;
            draggingNodeId = null;
            draggingNodeObj = null;

            if (e.shiftKey) {
                // Shift+拖拽释放：直接建立自由汇合连线
                toggleMergeLink(srcId, node.id);
            } else if (isChildDrop) {
                reparentNode(srcId, node.id);
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
                } else if (!(srcNode && isNodeInSubtree(srcNode, node.id))) {
                    stopInteractiveReparentMode();
                    reparentNode(srcId, node.id);
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
                } else {
                    stopInteractiveMergeMode();
                    sources.forEach(srcId => toggleMergeLink(srcId, node.id));
                }
                return;
            }
            const wasSelected = (selectedNodeId === node.id && selectedNodeIds.size === 1);
            const isMulti = (e.ctrlKey || e.metaKey || e.shiftKey);
            if (!isMulti && (selectedNodeId !== node.id || activeDockTray === 'sheet')) {
                activeDockTray = null;
                activeSheetTargetId = null;
            }
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

        // 编辑框内保留原生系统菜单方便复制/粘贴；其余区域与主阅读器一致支持无遮挡右键平移
        card.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.mm-inline-editor')) {
                e.stopPropagation();
                return;
            }
        });

        // 卡片顶部纯粹徽标栏（主链编号、里程碑序号、数学角色、关联页码；零悬停散落按钮）
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

        // 主干链里程碑序号徽标
        if (isSpine && spineIndex !== null && !forkLabel) {
            const spineBadge = document.createElement('span');
            spineBadge.className = 'mm-spine-index';
            spineBadge.title = `主链第 ${spineIndex + 1} 推演阶段`;
            spineBadge.textContent = `§${spineIndex + 1}`;
            leftInfo.appendChild(spineBadge);
        }

        // 数学理论角色标签徽标 (公理/定义/引理/定理/命题/证明/动机/推论/反例)
        if (node.tag && MATH_TAGS[node.tag]) {
            const tagDef = MATH_TAGS[node.tag];
            const tagBadge = document.createElement('button');
            tagBadge.type = 'button';
            tagBadge.className = `mm-math-tag mm-tag-${node.tag}`;
            tagBadge.title = `理论定位: ${tagDef.label}（点击更改）`;
            tagBadge.innerHTML = `<i class="ph ${tagDef.icon}"></i><span>${tagDef.label}</span>`;
            tagBadge.onclick = (e) => {
                e.stopPropagation();
                selectNode(node.id, false);
                openDockTray('tag');
            };
            leftInfo.appendChild(tagBadge);
        }

        // 页面 Badge：仅在指定了页码时显示，干净无叉号，单击跳转 PDF、右键在操作台修改
        if (node.page != null && node.page > 0) {
            const curReadingPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
            const isCurrent = (node.page === curReadingPage);

            const pageBadgeGroup = document.createElement('div');
            pageBadgeGroup.className = 'mm-page-badge-group' + (isCurrent ? ' is-active-page' : '');

            const pageBadge = document.createElement('button');
            pageBadge.type = 'button';
            pageBadge.className = 'mm-page-badge';
            pageBadge.title = `点击直达 PDF 第 ${node.page} 页（右键在底部操作台修改）`;
            pageBadge.innerHTML = `<i class="ph ph-bookmark-simple"></i><span>P.${node.page}${isCurrent ? ' · 当前' : ''}</span>`;
            pageBadge.onclick = (e) => {
                e.stopPropagation();
                locatePdfPage(node.page);
            };
            pageBadge.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectNode(node.id, false);
                openDockTray('page');
            };
            pageBadgeGroup.appendChild(pageBadge);
            leftInfo.appendChild(pageBadgeGroup);
        }

        if (leftInfo.children.length === 0) {
            head.classList.add('is-empty-head');
        }
        head.appendChild(leftInfo);
        card.appendChild(head);

        // 卡片内容展示区（保留 card.draggable = true，支持从卡片任意区域拖拽重排或重挂载）
        const body = document.createElement('div');
        body.className = 'mm-card-body';
        renderNodeContent(body, node.text);
        card.appendChild(body);

        cardWrapper.appendChild(card);

        // 折叠/展开胶囊按钮（仅在非根节点确有下属分支时安静显现）
        const hasLateralForkSub = !isRoot && !isSpine && hasForkBranches;
        if ((hasChildren || hasLateralForkSub) && !isRoot) {
            cardWrapper.classList.add('has-children', 'has-toggle');
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'mm-branch-toggle' + (node.collapsed ? ' is-collapsed' : '');
            toggleBtn.setAttribute('aria-expanded', String(!node.collapsed));
            const childCount = node.collapsed ? Math.max(1, countCollapsedDescendants(node, isSpine)) : 0;
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
                    childrenRow.appendChild(createBranchDOM(child, node, 1, idx, {
                        chainIdx,
                        data,
                        renderIndex,
                        hasDownstream: idx < node.children.length - 1
                    }));
                });
            } else {
                childrenRow.className = 'mm-children-row mm-lateral-column';
                node.children.forEach(child => {
                    childrenRow.appendChild(createBranchDOM(child, node, level + 1, null, { chainIdx, data, renderIndex }));
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

            const forkDownstreamActive = ownForkHasDownstream && node.forkConverge !== false;
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
                        forkLabel: label,
                        data,
                        renderIndex,
                        hasDownstream: (bIdx < track.length - 1) || forkDownstreamActive,
                        parentForkNeedsConverge: ownForkNeedsConverge
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
                        isLateralFork: true,
                        data,
                        renderIndex
                    }));
                });

                tracksWrap.appendChild(trackCol);
            });

            forkRow.appendChild(tracksWrap);

            if (node.forkConverge !== false && Array.isArray(node.convergeChildren) && node.convergeChildren.length > 0) {
                const convCol = document.createElement('div');
                convCol.className = 'mm-lateral-converge-col';
                node.convergeChildren.forEach((convNode, cIdx) => {
                    convCol.appendChild(createBranchDOM(convNode, node, level + 1, cIdx, { chainIdx, data, renderIndex }));
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
        if (!convergenceLayouts.length) return;
        const activeLayouts = [];
        // Phase 1: 批量读取所有合流分支的卡片尺寸，避免多组布局间读写交替引发强制同步回流
        for (const layout of convergenceLayouts) {
            if (!layout.row.isConnected) continue;
            const columns = [];
            layout.ordered.forEach(entry => {
                const card = entry.branch.querySelector(':scope > .mm-card-wrapper');
                entry.width = card.offsetWidth;
                entry.height = card.offsetHeight;
                (columns[entry.rank] ||= []).push(entry);
            });
            activeLayouts.push({ row: layout.row, entries: layout.entries, ordered: layout.ordered, columns });
        }
        // Phase 2: 纯数值计算 + 批量样式写入
        for (const { row, entries, ordered, columns } of activeLayouts) {
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

    let svgUpdateRaf = 0;
    function scheduleSvgConnectionsUpdate() {
        if (svgUpdateRaf) return;
        svgUpdateRaf = requestAnimationFrame(() => {
            svgUpdateRaf = 0;
            updateSvgConnections();
        });
    }

    function updateSvgConnections(options = {}) {
        if (svgUpdateRaf) {
            cancelAnimationFrame(svgUpdateRaf);
            svgUpdateRaf = 0;
        }
        const els = getEls();
        if (!els.canvas || !els.treeRoot) return;
        if (!options.skipConvergencePosition) {
            positionConvergenceLayouts();
        }

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
                stroke-width="${id.endsWith('-active') ? '1.8' : '1.5'}" stroke-linecap="round" />
        </marker>`).join('')}</defs>`;

        const data = options.data || getMindMapData();
        const chains = getAllMainChains(data);
        if (!chains || chains.length === 0) {
            _svgLayoutCache = null;
            return;
        }

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

        // O(N) 预收集纵向主干集合与入向实线来源数，避免绘制过程中 O(N^2) 重复查找
        const incomingCountMap = new Map();
        const verticalSpineIds = new Set();
        (function markSpines(list, isRootLevel) {
            if (!Array.isArray(list)) return;
            for (let i = 0; i < list.length; i++) {
                const n = list[i];
                if (!n) continue;
                verticalSpineIds.add(n.id);
                if (isRootLevel && Array.isArray(n.children)) markSpines(n.children, false);
                if (Array.isArray(n.branches)) {
                    for (let t = 0; t < n.branches.length; t++) {
                        markSpines(n.branches[t], false);
                    }
                }
            }
        })(chains, true);
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

        function routeHitsObstacles(pts, fromId, toId) {
            return window.MindMapRouter.routeHitsObstacles(allCardBounds, pts, fromId, toId);
        }
        function roundedRoute(points) {
            return window.MindMapRouter.roundedRoute(points);
        }
        // 记录所有实线折线段与卡片端口占用情况，供按 M 建立的虚线箭头智能避让，防止与实线重合
        const solidSegments = [];
        const solidEndpoints = [];
        const solidEndpointsByNode = new Map();
        const placedMergeRoutes = [];
        const pathFrag = document.createDocumentFragment();
        const solidPaths = [];
        const convergenceTargets = new Set();

        function pushSolidEndpoint(nodeId, x, y) {
            const ep = { nodeId, x, y };
            solidEndpoints.push(ep);
            let list = solidEndpointsByNode.get(nodeId);
            if (!list) {
                list = [];
                solidEndpointsByNode.set(nodeId, list);
            }
            list.push(ep);
        }

        function recordSolidRoute(fromId, toId, pts) {
            if (!Array.isArray(pts) || pts.length < 2) return;
            const first = pts[0];
            const last = pts[pts.length - 1];
            pushSolidEndpoint(fromId, first[0], first[1]);
            pushSolidEndpoint(toId, last[0], last[1]);
            for (let i = 0; i < pts.length - 1; i++) {
                const x1 = pts[i][0], y1 = pts[i][1];
                const x2 = pts[i + 1][0], y2 = pts[i + 1][1];
                const len = Math.hypot(x2 - x1, y2 - y1);
                if (len >= 1) {
                    solidSegments.push({
                        x1, y1, x2, y2, len,
                        minX: x1 < x2 ? x1 : x2,
                        maxX: x1 > x2 ? x1 : x2,
                        minY: y1 < y2 ? y1 : y2,
                        maxY: y1 > y2 ? y1 : y2,
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
            solidPaths.push(path);
            pathFrag.appendChild(path);
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
            if (!verticalSpineIds.has(node.id)) drawHorizontalFork(node);
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
            if (!preview) {
                convergenceTargets.add(toId);
                solidPaths.push(path);
            }
            pathFrag.appendChild(path);
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
        const routerCtx = {
            allCardBounds,
            solidEndpoints,
            solidEndpointsByNode,
            solidSegments,
            placedMergeRoutes
        };
        const getMergeCardPort = (rect, side, isTarget, shift = 0) =>
            window.MindMapRouter.getMergeCardPort(rect, side, isTarget, shift);
        const scoreMergeCandidate = (cand, fromId, toId, bestScore = Infinity) =>
            window.MindMapRouter.scoreMergeCandidate(cand, fromId, toId, routerCtx, bestScore);

        function drawCustomMergeLinks(fromCard, toCard, fromId, toId, preview = false, targetContainer = pathFrag) {
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
                const sc = scoreMergeCandidate(cand, fromId, toId, bestScore);
                if (sc < bestScore) {
                    bestScore = sc;
                    best = cand;
                }
            }

            if (!preview && best && best.pts) {
                placedMergeRoutes.push({
                    p1: best.p1,
                    p2: best.p2,
                    pts: best.pts,
                    minX: best.minX,
                    maxX: best.maxX,
                    minY: best.minY,
                    maxY: best.maxY
                });
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
            targetContainer.appendChild(path);
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
        if (convergenceTargets.size > 0) {
            for (let i = 0; i < solidPaths.length; i++) {
                const path = solidPaths[i];
                if (convergenceTargets.has(path.dataset.childId)) {
                    path.classList.add('mm-connector-converge');
                    path.dataset.convergenceId = path.dataset.childId;
                }
            }
        }
        svg.appendChild(pathFrag);
        if (selectedNodeId || selectedNodeIds.size > 0) {
            highlightConnections(selectedNodeId);
        }

        _svgLayoutCache = {
            svg,
            cards,
            cardBounds,
            solidEndpointsByNode,
            drawCustomMergeLinks
        };

        updateInteractivePreviewPaths(canvasRect, zoom);
    }

    // 交互式连线/挂载预览增量更新：仅重绘 1 条跟随鼠标的预览路径，避免 mousemove 触发全图重算
    function updateInteractivePreviewPaths(providedCanvasRect = null, providedZoom = null) {
        const els = getEls();
        const svg = els.svgCanvas || document.getElementById('mindmap-svg-canvas');
        if (!svg || !els.canvas) return;
        const activeSourceIds = (mergingSourceNodeIds && mergingSourceNodeIds.length > 0)
            ? mergingSourceNodeIds
            : (mergingSourceNodeId ? [mergingSourceNodeId] : []);
        const hasReparent = Boolean(reparentingSourceNodeId);

        if (activeSourceIds.length === 0 && !hasReparent) {
            svg.querySelectorAll('.mm-connector-merge-preview, .mm-connector-reparent-preview').forEach(p => p.remove());
            return;
        }
        if (!_svgLayoutCache || _svgLayoutCache.svg !== svg || !svg.isConnected) {
            updateSvgConnections();
            return;
        }

        const { cards, cardBounds, solidEndpointsByNode, drawCustomMergeLinks } = _svgLayoutCache;
        const canvasRect = providedCanvasRect || els.canvas.getBoundingClientRect();
        const zoom = providedZoom || currentZoom || 1.0;
        if (zoom <= 0) return;

        svg.querySelectorAll('.mm-connector-merge-preview, .mm-connector-reparent-preview').forEach(p => p.remove());
        const previewFrag = document.createDocumentFragment();
        const getMergeCardPort = (rect, side, isTarget, shift = 0) =>
            window.MindMapRouter.getMergeCardPort(rect, side, isTarget, shift);

        // 4. 若处于交互式点击连线合并模式，实时为所有选中的源节点绘制跟随鼠标或吸附目标的动态预览曲线
        if (activeSourceIds.length > 0) {
            const targetCard = mergingTargetNodeId ? cards.get(mergingTargetNodeId) : null;
            if (mergingTargetNodeId && targetCard) {
                activeSourceIds.forEach(srcId => {
                    const srcCard = cards.get(srcId);
                    if (srcCard) {
                        drawCustomMergeLinks(srcCard, targetCard, srcId, mergingTargetNodeId, true, previewFrag);
                    }
                });
            } else if (mergeMouseX && mergeMouseY) {
                activeSourceIds.forEach(srcId => {
                    const sB = cardBounds(srcId);
                    if (sB) {
                        const endX = (mergeMouseX - canvasRect.left) / zoom;
                        const endY = (mergeMouseY - canvasRect.top) / zoom;
                        const dx = endX - sB.cx;
                        const dy = endY - sB.cy;
                        const side = Math.abs(dx) > Math.abs(dy)
                            ? (dx >= 0 ? 'right' : 'left')
                            : (dy >= 0 ? 'bottom' : 'top');
                        let p1 = getMergeCardPort(sB, side, false, 0);
                        const srcEps = solidEndpointsByNode.get(srcId);
                        const portBusy = Boolean(srcEps && srcEps.some(ep => Math.hypot(p1.x - ep.x, p1.y - ep.y) < 9));
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
                        previewFrag.appendChild(previewPath);
                    }
                });
            }
        }

        // 5. 若处于交互式更改挂载父节点模式，实时绘制从候选新父节点指向当前节点的预览流线
        if (hasReparent && cards.has(reparentingSourceNodeId)) {
            const childB = cardBounds(reparentingSourceNodeId);
            if (childB) {
                let startX = null, startY = null;
                if (reparentingTargetNodeId && cards.has(reparentingTargetNodeId)) {
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
                    previewFrag.appendChild(previewPath);
                }
            }
        }

        if (previewFrag.childNodes.length > 0) {
            svg.appendChild(previewFrag);
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
        const activePage = getActiveMindMapPage(data);
        const activePageVal = activePage?.page ?? null;
        if (
            _lastHighlightedPdfPage === curPage &&
            _lastHighlightedRenderRef === _lastRenderedMindmapRef &&
            _lastHighlightedActivePageVal === activePageVal
        ) {
            return;
        }
        _lastHighlightedPdfPage = curPage;
        _lastHighlightedRenderRef = _lastRenderedMindmapRef;
        _lastHighlightedActivePageVal = activePageVal;

        const pages = getMindMapPages(data);
        const nodeMap = _lastRenderIndex?.nodeMap || null;

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
            const node = (nodeMap && nodeMap.get(nId)) || findNodeInTree(data, nId);
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
                els.bindPageText.textContent = boundPage ? `P.${boundPage}` : '';
            }
            els.bindPageBtn.title = boundPage
                ? `当前导图页已绑定 PDF 第 ${boundPage} 页（左键打开页设置 · 右键解绑或切换当前阅读页）`
                : '导图页设置与关联页码（点击展开 · 右键一键绑定当前阅读页）';
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
                pageBadge.innerHTML = `<i class="ph-fill ph-book-open-text text-[10px]"></i><span>${isCurPdf ? `P.${pageObj.page} · 当前` : `P.${pageObj.page}`}</span>`;
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
                    openDockTray('sheet', pageObj.id);
                });

                const clearBtn = document.createElement('button');
                clearBtn.type = 'button';
                clearBtn.className = 'mm-page-clear-btn';
                clearBtn.innerHTML = '<i class="ph ph-x"></i>';
                clearBtn.title = '解除此导图页的 PDF 页码关联';
                clearBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    setMindMapPagePdfPage(pageObj.id, null);
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
                e.preventDefault();
                e.stopPropagation();
                openDockTray('sheet', pageObj.id);
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
                els.pagesList.scrollLeft = Math.min(tabLeft, tabRight - els.pagesList.clientWidth);
            }
        }
    }

    function renderTree(options = {}) {
        const els = getEls();
        if (!els.treeRoot) return;

        const data = getMindMapData();
        renderPagesBar(data);
        const chains = getAllMainChains(data);
        const renderIndex = buildRenderIndex(data);
        _lastRenderIndex = renderIndex;
        _lastHighlightedPdfPage = -1;
        const total = renderIndex.total;
        if (selectedNodeId && !renderIndex.nodeMap.has(selectedNodeId)) selectedNodeId = null;
        selectedNodeIds = new Set([...selectedNodeIds].filter(id => renderIndex.nodeMap.has(id)));
        if (selectedNodeId && !selectedNodeIds.has(selectedNodeId)) selectedNodeIds = new Set([selectedNodeId]);
        if (!selectedNodeId) selectedNodeId = [...selectedNodeIds].pop() || null;
        if (mergingSourceNodeId && !renderIndex.nodeMap.has(mergingSourceNodeId)) stopInteractiveMergeMode();
        if (reparentingSourceNodeId && !renderIndex.nodeMap.has(reparentingSourceNodeId)) stopInteractiveReparentMode();
        if (els.nodeCount) {
            const pageCount = getMindMapPages(data).length;
            els.nodeCount.textContent = chains.length > 1 ? `${chains.length}·${total}` : String(total);
            els.nodeCount.title = pageCount > 1
                ? `共 ${pageCount} 页思维导图 · 当前页 ${chains.length} 条主链 · ${total} 个节点`
                : (chains.length > 1 ? `${chains.length} 条主链 · ${total} 个节点` : `${total} 个节点`);
        }

        const hadFocus = !!(document.activeElement && document.activeElement.classList &&
            document.activeElement.classList.contains('mm-card') && els.treeRoot.contains(document.activeElement));

        _svgLayoutCache = null;
        const treeFrag = document.createDocumentFragment();
        chains.forEach((chainRoot, idx) => {
            if (chainRoot) {
                treeFrag.appendChild(createBranchDOM(chainRoot, null, 0, null, { chainIdx: idx, data, renderIndex }));
            }
        });
        els.treeRoot.replaceChildren(treeFrag);
        prepareConvergenceLayouts(data);
        updateSelectionTools();

        // 新导图只有根节点时给出轻量上手引导，添加首个节点后自动消失
        if (total === 1 && els.treeRoot.firstElementChild) {
            const guide = document.createElement('div');
            guide.className = 'mm-empty-guide';
            guide.innerHTML = '<p>点选根节点后：</p>'
                + '<div><kbd>Enter</kbd><span>向下推进主链阶段</span></div>'
                + '<div><kbd>Tab</kbd><span>向右展开分支或新主链</span></div>'
                + '<div><kbd>操作台</kbd><span>底部集中管理角色 · 页码 · 连线</span></div>';
            els.treeRoot.firstElementChild.appendChild(guide);
        }

        // 整树重建后把键盘焦点还给选中节点，保证快捷键连续可用
        if (hadFocus && selectedNodeId) {
            const card = els.treeRoot.querySelector(`.mm-card[data-id="${selectedNodeId}"]`);
            if (card) card.focus({ preventScroll: true });
        }

        _mindmapDomDirty = false;
        _lastRenderedMindmapRef = data;
        _lastRenderedActivePageId = data.activePageId;

        // 同步应用当前画布变换并单次绘制 SVG 流线
        applyTransform(data);
        if (!options.skipSvg) {
            updateSvgConnections({ data });
        }
    }

    // ==========================================
    // 6. 独立缩放、自由平移与居中视野 (Transform 2D 引擎)
    // ==========================================

    function applyTransform(dataArg = null) {
        const els = getEls();
        if (!els.canvas) return;
        els.canvas.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${currentZoom})`;
        if (els.viewport) {
            const bgX = ((panX % 22) + 22) % 22;
            const bgY = ((panY % 22) + 22) % 22;
            els.viewport.style.backgroundPosition = `${bgX}px ${bgY}px`;
        }
        if (els.zoomVal) {
            const zoomText = `${Math.round(currentZoom * 100)}%`;
            if (els.zoomVal.textContent !== zoomText) {
                els.zoomVal.textContent = zoomText;
            }
        }
        const d = dataArg || state.annotations?.['mindmap'];
        let activePage = null;
        if (d && Array.isArray(d.pages)) {
            if (_lastNormalizedActivePage && _lastNormalizedActivePage.id === d.activePageId) {
                activePage = _lastNormalizedActivePage;
            } else {
                activePage = d.pages.find(p => p && p.id === d.activePageId) || d.pages[0] || null;
            }
        }
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

    function centerView(smooth = true, autoFit = false, options = {}) {
        const els = getEls();
        if (!els.viewport || !els.canvas || !els.treeRoot) return;

        const vpW = els.viewport.clientWidth || 380;
        const vpH = els.viewport.clientHeight || 600;

        const treeW = els.treeRoot.offsetWidth || (els.treeRoot.firstElementChild ? els.treeRoot.firstElementChild.offsetWidth : 260);
        const treeH = els.treeRoot.offsetHeight || (els.treeRoot.firstElementChild ? els.treeRoot.firstElementChild.offsetHeight : 300);

        if (autoFit && treeW > 0 && treeH > 0) {
            const fitW = (vpW - 48) / treeW;
            const fitH = (vpH - 96) / treeH;
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
                const svg = els.svgCanvas || document.getElementById('mindmap-svg-canvas');
                if (!options.skipSvg && (!svg || svg.childElementCount <= 1)) {
                    updateSvgConnections();
                }
            }, 300);
        } else {
            els.canvas.style.transition = '';
            applyTransform();
            if (!options.skipSvg) {
                updateSvgConnections();
            }
        }
    }

    function ensureNodeVisible(card) {
        const els = getEls();
        if (!els.viewport || !card) return;
        const cardRect = card.getBoundingClientRect();
        const vpRect = els.viewport.getBoundingClientRect();
        const pad = 24;
        const padBottom = 68;

        let deltaX = 0;
        let deltaY = 0;

        if (cardRect.left < vpRect.left + pad) {
            deltaX = (vpRect.left + pad) - cardRect.left;
        } else if (cardRect.right > vpRect.right - pad) {
            deltaX = (vpRect.right - pad) - cardRect.right;
        }

        if (cardRect.top < vpRect.top + pad) {
            deltaY = (vpRect.top + pad) - cardRect.top;
        } else if (cardRect.bottom > vpRect.bottom - padBottom) {
            deltaY = (vpRect.bottom - padBottom) - cardRect.bottom;
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
        const count = selectedNodeIds.size || (selectedNodeId ? 1 : 0);
        const label = document.getElementById('mindmap-selection-label');
        if (label) label.textContent = count ? `已选 ${count} 项` : '点选节点开始编辑';
        renderCommandDock();
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
            const data = getMindMapData();
            const needsRender = _mindmapDomDirty ||
                _lastRenderedMindmapRef !== data ||
                _lastRenderedActivePageId !== data.activePageId ||
                !els.treeRoot ||
                els.treeRoot.childElementCount === 0;
            if (needsRender) {
                renderTree({ skipSvg: true });
                centerView(false, true, { skipSvg: true });
                updateSvgConnections({ data });
            } else {
                centerView(false, true, { skipSvg: true });
                updateActivePageHighlight();
            }
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
        let pendingWidth = null;
        let resizerRaf = 0;

        els.resizer.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startWidth = els.panel.offsetWidth;
            pendingWidth = null;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            pendingWidth = Math.min(860, Math.max(280, startWidth + (e.clientX - startX)));
            if (!resizerRaf) {
                resizerRaf = requestAnimationFrame(() => {
                    resizerRaf = 0;
                    if (pendingWidth !== null) {
                        els.panel.style.width = `${pendingWidth}px`;
                        pendingWidth = null;
                    }
                });
            }
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                if (resizerRaf) {
                    cancelAnimationFrame(resizerRaf);
                    resizerRaf = 0;
                }
                if (pendingWidth !== null) {
                    els.panel.style.width = `${pendingWidth}px`;
                    pendingWidth = null;
                }
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
                    toggleDockTray('sheet', activePage.id);
                }
            });
            els.bindPageBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const activePage = getActiveMindMapPage();
                if (!activePage) return;
                const curPage = (state.currentPhysicalPage && state.currentPhysicalPage > 0) ? state.currentPhysicalPage : 1;
                setMindMapPagePdfPage(activePage.id, activePage.page === curPage ? null : curPage);
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

        if (els.dockTray) {
            els.dockTray.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeDockTray();
                    refocusSelectedCard();
                    return;
                }
                const tab = e.target.closest?.('[role="tab"][data-mode]');
                if (tab && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                    e.preventDefault();
                    e.stopPropagation();
                    const tabs = [...els.dockTray.querySelectorAll('[role="tab"][data-mode]')];
                    if (tabs.length > 0) {
                        const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                        next?.click();
                        next?.focus({ preventScroll: true });
                    }
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
                if (mergingSourceNodeId) {
                    stopInteractiveMergeMode();
                }
                if (reparentingSourceNodeId) {
                    stopInteractiveReparentMode();
                }
                if (activeDockTray) {
                    closeDockTray();
                }
                const ae = document.activeElement;
                if (ae && ae.classList && ae.classList.contains('mm-card') && panel.contains(ae)) {
                    ae.blur();
                }
            }, { capture: true });

            // 右键与主阅读器一致支持全域无遮挡拖拽平移；原地右击取消交互态或安静选中卡片，不弹出右键菜单
            els.viewport.addEventListener('contextmenu', (e) => {
                if (e.target.closest('.mm-inline-editor')) {
                    e.stopPropagation();
                    return;
                }
                if (e.target.closest('#mm-command-dock')) {
                    if (e.target.tagName === 'INPUT') {
                        e.stopPropagation();
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                if (rightPanMoved) {
                    rightPanMoved = false;
                    return;
                }
                if (mergingSourceNodeId) {
                    stopInteractiveMergeMode();
                    return;
                }
                if (reparentingSourceNodeId) {
                    stopInteractiveReparentMode();
                    return;
                }
                const cardEl = e.target.closest('.mm-card');
                if (cardEl && cardEl.dataset.id && !selectedNodeIds.has(cardEl.dataset.id)) {
                    activeDockTray = null;
                    activeSheetTargetId = null;
                    selectNode(cardEl.dataset.id, false);
                }
            });

            els.viewport.addEventListener('wheel', (e) => {
                e.stopPropagation(); // 严格阻断向主阅读器冒泡
                if (e.target.closest('#mm-command-dock')) {
                    if (!e.ctrlKey && !e.metaKey) {
                        const listScrollable = e.target.closest('.mm-connect-list');
                        if (listScrollable && listScrollable.scrollHeight > listScrollable.clientHeight) {
                            return;
                        }
                    }
                    e.preventDefault();
                    return;
                }
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    const rect = els.viewport.getBoundingClientRect();
                    const mouseX = e.clientX - rect.left;
                    const mouseY = e.clientY - rect.top;
                    const factor = e.deltaY < 0 ? 1.1 : 0.9;
                    zoomAt(currentZoom * factor, mouseX, mouseY);
                } else {
                    // 若光标悬停在横向可滚动的公式/节点正文上方，且用户正在横向滚动，优先由该节点横向滚动
                    const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY)) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
                    if (delta !== 0) {
                        const scrollable = e.target.closest('.mm-card-body, .katex-display, .katex');
                        if (scrollable && scrollable.scrollWidth > scrollable.clientWidth) {
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

            // 视口平移（支持空白画布直接左键拖拽、全域右键拖拽、中键拖拽与空格抓手模式）
            els.viewport.addEventListener('mousedown', (e) => {
                if (e.target.closest('#mm-command-dock') || e.target.closest('.mm-inline-editor')) return;

                const isMiddle = (e.button === 1);
                const isLeft = (e.button === 0);
                const isRight = (e.button === 2);
                const isOverCard = !!e.target.closest('.mm-card');
                const isOverButton = !!e.target.closest('button');

                // 右键拖拽平移支持（与全局主阅读器右键拖屏交互完全统一）
                if (isRight && !isOverButton) {
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
                        updateInteractivePreviewPaths();
                    });
                }

                // 交互式更改挂载父节点模式下实时高亮候选父节点并绘制预览流线
                if (reparentingSourceNodeId && isMindmapOpen) {
                    reparentMouseX = e.clientX;
                    reparentMouseY = e.clientY;
                    const target = e.target.closest?.('#mindmap-tree-root .mm-card');
                    const rawTargetId = target && target.dataset.id !== reparentingSourceNodeId ? target.dataset.id : null;
                    if (rawTargetId !== lastRawReparentTargetId) {
                        lastRawReparentTargetId = rawTargetId;
                        const data = getMindMapData();
                        const srcNode = rawTargetId ? findNodeInTree(data, reparentingSourceNodeId) : null;
                        const validTargetId = (rawTargetId && !(srcNode && isNodeInSubtree(srcNode, rawTargetId))) ? rawTargetId : null;
                        if (validTargetId !== reparentingTargetNodeId || rawTargetId) {
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
                    }
                    if (reparentPreviewFrame === null) reparentPreviewFrame = requestAnimationFrame(() => {
                        reparentPreviewFrame = null;
                        updateInteractivePreviewPaths();
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
                // 点击空白处退出合并连线模式、退出重挂载模式、收起操作抽屉或取消卡片选中
                if (!e.target.closest('.mm-card') && !e.target.closest('button') && !e.target.closest('#mm-command-dock')) {
                    if (reparentingSourceNodeId) {
                        stopInteractiveReparentMode();
                        return;
                    }
                    if (mergingSourceNodeId || (mergingSourceNodeIds && mergingSourceNodeIds.length > 0)) {
                        stopInteractiveMergeMode();
                        return;
                    }
                    activeDockTray = null;
                    activeSheetTargetId = null;
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
                } else if (mergingSourceNodeId || (mergingSourceNodeIds && mergingSourceNodeIds.length > 0)) {
                    stopInteractiveMergeMode();
                } else if (activeDockTray) {
                    closeDockTray();
                    refocusSelectedCard();
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
                        setMindMapPagePdfPage(activePage.id, activePage.page === curPage ? null : curPage);
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
                } else if (selectedNodeId) {
                    startInteractiveReparentMode(selectedNodeId);
                }
            } else if ((e.key === 'm' || e.key === 'M') && !hasModifier) {
                e.preventDefault();
                e.stopPropagation();
                const sources = selectedNodeIds.size > 1 ? Array.from(selectedNodeIds) : (selectedNodeId ? [selectedNodeId] : []);
                if (mergingSourceNodeId) {
                    stopInteractiveMergeMode();
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
                    setNodePage(selectedNodeId, (node && node.page === curPage) ? null : curPage);
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

    function resetForDocument() {
        editingNodeId = null;
        selectedNodeId = null;
        selectedNodeIds.clear();
        draggingNodeId = null;
        draggingNodeObj = null;
        _lastNormalizedMindmapData = null;
        _mindmapDomDirty = true;
        _lastRenderIndex = null;
        _lastHighlightedPdfPage = -1;
        _svgLayoutCache = null;
        stopInteractiveMergeMode();
        stopInteractiveReparentMode();
        closeAllPopovers();
        if (isMindmapOpen) {
            const els = getEls();
            els.dock?.classList.remove('is-editing-dim');
            els.treeRoot?.replaceChildren();
            els.svgCanvas?.querySelectorAll('path, g.mm-dynamic')?.forEach(n => n.remove());
            els.pagesList?.replaceChildren();
            if (els.nodeCount) els.nodeCount.textContent = '0';
            renderCommandDock();
        }
    }

    function syncFromHistory() {
        _lastNormalizedMindmapData = null;
        _mindmapDomDirty = true;
        _lastRenderIndex = null;
        _lastHighlightedPdfPage = -1;
        _svgLayoutCache = null;
        stopInteractiveMergeMode();
        stopInteractiveReparentMode();
        closeAllPopovers();
        if (state.annotations?.['mindmap']) {
            const data = getMindMapData();
            const activePage = getActiveMindMapPage(data);
            const savedZoom = Number(activePage?.zoom ?? data?.zoom);
            if (Number.isFinite(savedZoom)) currentZoom = Math.min(2.5, Math.max(0.35, savedZoom));
            if (Number.isFinite(Number(activePage?.panX))) panX = Number(activePage.panX);
            if (Number.isFinite(Number(activePage?.panY))) panY = Number(activePage.panY);
        }
        if (isMindmapOpen) {
            renderTree();
        }
    }

    function onAnnotationsLoaded() {
        editingNodeId = null;
        selectedNodeId = null;
        selectedNodeIds.clear();
        draggingNodeId = null;
        draggingNodeObj = null;
        _lastNormalizedMindmapData = null;
        _mindmapDomDirty = true;
        _lastRenderIndex = null;
        _lastHighlightedPdfPage = -1;
        _svgLayoutCache = null;
        stopInteractiveMergeMode();
        stopInteractiveReparentMode();
        closeAllPopovers();
        if (state.annotations?.['mindmap']) {
            getMindMapData();
        }
        const activePage = state.annotations?.['mindmap'] ? getActiveMindMapPage() : null;
        const savedZoom = Number(activePage?.zoom ?? state.annotations?.['mindmap']?.zoom);
        currentZoom = Number.isFinite(savedZoom) ? Math.min(2.5, Math.max(0.35, savedZoom)) : 1.0;
        if (Number.isFinite(Number(activePage?.panX))) panX = Number(activePage.panX);
        if (Number.isFinite(Number(activePage?.panY))) panY = Number(activePage.panY);
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
        syncFromHistory: syncFromHistory,
        resetForDocument: resetForDocument,
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

