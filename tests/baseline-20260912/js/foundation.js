        pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.js';
        
        function getBracePath(x1, y1, x2, y2) {
            const dx = x2 - x1;
            const dy = y2 - y1;
            
            // 智能判断方向：纵向位移大于横向，则是垂直括号；反之则是水平括号
            if (Math.abs(dy) > Math.abs(dx)) {
                // 垂直大括号
                const x = x1, y = y1, w = dx, h = dy;
                return `M ${x} ${y} 
                        Q ${x+w/2} ${y} ${x+w/2} ${y+h/4} 
                        Q ${x+w/2} ${y+h/2} ${x+w} ${y+h/2} 
                        Q ${x+w/2} ${y+h/2} ${x+w/2} ${y+3*h/4} 
                        Q ${x+w/2} ${y+h} ${x} ${y+h}`;
            } else {
                // 水平大括号
                const x = x1, y = y1, w = dx, h = dy;
                return `M ${x} ${y} 
                        Q ${x} ${y+h/2} ${x+w/4} ${y+h/2} 
                        Q ${x+w/2} ${y+h/2} ${x+w/2} ${y+h} 
                        Q ${x+w/2} ${y+h/2} ${x+3*w/4} ${y+h/2} 
                        Q ${x+w} ${y+h/2} ${x+w} ${y}`;
            }
        }

        function getImpliesPath(x1, y1, x2, y2, scale = 1, bidirectional = false) {
            const dx = x2 - x1;
            const dy = y2 - y1;
            if (Math.hypot(dx, dy) < 1) return "";
            
            const angle = Math.atan2(dy, dx);
            // 两种双线箭头共用紧凑尺寸；短箭头进一步缩小，避免两端交叠。
            const size = Math.min(0.7 * scale, Math.hypot(dx, dy) / 20);
            const gap = 2.5 * size; // 双线的一半间距
            const headLen = 10 * size; // 箭头两翼的长度
            const headAngle = Math.PI / 6; // 30度夹角
            
            // 法向量
            const nx = -Math.sin(angle) * gap;
            const ny = Math.cos(angle) * gap;
            
            // 箭头尖端及两翼
            const tipX = x2, tipY = y2;
            const wing1X = x2 - headLen * Math.cos(angle - headAngle);
            const wing1Y = y2 - headLen * Math.sin(angle - headAngle);
            const wing2X = x2 - headLen * Math.cos(angle + headAngle);
            const wing2Y = y2 - headLen * Math.sin(angle + headAngle);
            
            // 将双线回缩，让其正好顶在箭头V字翼的内侧
            const backoff = gap / Math.tan(headAngle);
            const endCenterX = x2 - Math.cos(angle) * backoff;
            const endCenterY = y2 - Math.sin(angle) * backoff;
            const startCenterX = x1 + (bidirectional ? Math.cos(angle) * backoff : 0);
            const startCenterY = y1 + (bidirectional ? Math.sin(angle) * backoff : 0);
            const startHead = bidirectional
                ? `M ${x1 + headLen * Math.cos(angle - headAngle)} ${y1 + headLen * Math.sin(angle - headAngle)} L ${x1} ${y1} L ${x1 + headLen * Math.cos(angle + headAngle)} ${y1 + headLen * Math.sin(angle + headAngle)}`
                : '';
            
            // 返回包含3段的一体化 SVG 路径
            return `M ${startCenterX + nx} ${startCenterY + ny} L ${endCenterX + nx} ${endCenterY + ny} 
                    M ${startCenterX - nx} ${startCenterY - ny} L ${endCenterX - nx} ${endCenterY - ny} 
                    M ${wing1X} ${wing1Y} L ${tipX} ${tipY} L ${wing2X} ${wing2Y} ${startHead}`;
        }

        function updateBubbleTail(pathEl, cx, cy, ax, ay, scale) {
            const dx = ax - cx;
            const dy = ay - cy;
            const dist = Math.hypot(dx, dy);
            
            const localScale = scale * 0.7; 
            const localDist = dist / localScale;
            
            const maxTail = 40;
            const tailLen = Math.min(localDist, maxTail);

            // 距离小于 8px 不显示尾巴
            if (localDist < 8) {
                pathEl.setAttribute('d', '');
                return;
            }

            const angle = Math.atan2(dy, dx);
            const radius = 6;

            const spread = 0.65; // 稍微加大张角，让极小尺寸下的尾巴融合更平滑
            const b1x = Math.cos(angle - spread) * radius;
            const b1y = Math.sin(angle - spread) * radius;
            const b2x = Math.cos(angle + spread) * radius;
            const b2y = Math.sin(angle + spread) * radius;

            const tx = Math.cos(angle) * tailLen;
            const ty = Math.sin(angle) * tailLen;

            // 二次贝塞尔曲线
            const d = `M ${b1x} ${b1y} Q ${tx * 0.4} ${ty * 0.4} ${tx} ${ty} Q ${tx * 0.4} ${ty * 0.4} ${b2x} ${b2y} Z`;
            pathEl.setAttribute('d', d);
        }

        const state = {
            pdfDoc: null,
            pdfData: null, 
            rawFile: null,
            blobUrl: null,
            fileName: '',
            showAnnotations: true,
            fileHandle: null, 
            localFilePath: null,
            fingerprint: '',
            pageDimensions: [],
            scale: 1.0,
            pagesRendered: new Set(),
            renderTasks: {}, 
            annotations: {}, 
            history: [], 
            historyIndex: -1,
            currentTool: 'cursor', 
            currentColor: '#fde047',
            activeAnnotationId: null,
            activePageNum: 1,
            isEditingNote: false,
            sidebarOpen: true, 
            unsavedChanges: false,
            isSaving: false,         // 保存重入闸门（见 extras.js performSave）
            loadToken: 0,            // 文档加载序号：并发加载时淘汰过期的那一次（见 loadPDFFromFile）
            isEyeProtectionMode: false,
            drawingArrow: { isDrawing: false, startX: 0, startY: 0, pageWrapper: null, tempSvgLine: null, pageNum: 0 },
            draggingText: { isDragging: false, isPressed: false, id: null, pageNum: 0, startX: 0, startY: 0, offsetX: 0, offsetY: 0 }, 
            draggingBubble: null,
            searchMatches: [], 
            currentMatchIndex: -1,
            isHandToolActive: false,
            handDrag: { isDragging: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 },
            lastScrollPosition: null,
            livePreviewTimer: null,     
            originalAnnoSnapshot: null,
            searchAbortController: null, // 用于中断连续搜索
            sidebarMode: 'annotations',   // 记录侧边栏当前所处模式
            isOutlineOpen: false,
            pageOffset: 0,           // 物理页码与逻辑页码的偏移量
            outlineMap: [],          // 存储解析后的扁平化目录地图，用于 O(1) 查找
            currentPhysicalPage: 1   // 记录当前屏幕中心的物理页
        };

        const els = {
            container: document.getElementById('viewer-container'),
            pagesContainer: document.getElementById('pages-container'),
            toggleVisBtn: document.getElementById('toggle-visibility-btn'),
            visIcon: document.getElementById('visibility-icon'),
            fileInput: document.getElementById('file-input'),
            docTitle: document.getElementById('doc-title'),
            copyDocTitleBtn: document.getElementById('copy-doc-title-btn'),
            docMeta: document.getElementById('doc-meta'),
            emptyState: document.getElementById('empty-state'),
            toolBtns: document.querySelectorAll('.tool-btn'),
            colorBtns: document.querySelectorAll('.color-btn'),
            customColorInput: document.getElementById('custom-color-input'),
            noteModal: document.getElementById('note-modal'),
            noteInput: document.getElementById('note-input'),
            notePreview: document.getElementById('note-preview'),
            modalTitle: document.getElementById('modal-title'),
            zoomLevel: document.getElementById('zoom-level'),
            sidebar: document.getElementById('sidebar'),
            sidebarList: document.getElementById('sidebar-list'),
            annoCount: document.getElementById('annotation-count'),
            saveStatusBtn: document.getElementById('save-status-btn'),
            saveIcon: document.getElementById('save-icon'),
            toggleEditBtn: document.getElementById('toggle-edit-btn'),
            saveNoteBtn: document.getElementById('save-note-btn'),
            toggleSidebarBtn: document.getElementById('toggle-sidebar'),
            fullscreenBtn: document.getElementById('fullscreen-btn'),
            searchBar: document.getElementById('search-bar'),
            searchInput: document.getElementById('search-input'),
            searchCount: document.getElementById('search-count'),
            searchPrev: document.getElementById('search-prev'),
            searchNext: document.getElementById('search-next'),
            searchClose: document.getElementById('search-close'),
            toggleSearchBtn: document.getElementById('toggle-search-btn'),
            eyeProtectionBtn: document.getElementById('eye-protection-btn'),
            openBtn: document.getElementById('open-btn'),
            openNewBtn: document.getElementById('open-new-btn'),
            closeAppBtn: document.getElementById('close-app-btn'),
            handToolBtn: document.getElementById('hand-tool-btn'),
            backJumpBtn: document.getElementById('back-jump-btn'),
            sidecarBtn: document.getElementById('sidecar-btn'),
            outlineTriggerBtn: document.getElementById('outline-trigger-btn'),
            outlinePanel: document.getElementById('outline-panel'),
            outlineContent: document.getElementById('outline-content'),
            closeOutlineBtn: document.getElementById('close-outline-btn'),
            pageHud: document.getElementById('page-hud'),
            hudCurrent: document.getElementById('hud-current-page'),
            hudTotal: document.getElementById('hud-total-pages'),
            hudPhysicalTotal: document.getElementById('hud-physical-total'),
            hudPhysicalNumber: document.getElementById('hud-physical-number'),
            setOffsetBtn: document.getElementById('set-offset-btn'),
            resetOffsetBtn: document.getElementById('reset-offset-btn')
        };

        const textResizeDataMap = new WeakMap();
        const globalTextResizeObserver = new ResizeObserver(entries => {
            // 如果正处于全局缩放期间，直接忽略回调
            if (state.isZooming) return;

            for (let entry of entries) {
                const target = entry.target;
                
                if (!target.isConnected) {
                    globalTextResizeObserver.unobserve(target); // 主动解绑已销毁的节点
                    continue;
                }

                // 从 WeakMap 中取出该 DOM 绑定的数据
                const data = textResizeDataMap.get(target);
                if (!data) continue;

                const { anno, w, h } = data;

                const newW = entry.borderBoxSize ? entry.borderBoxSize[0].inlineSize / w : entry.contentRect.width / w;
                const newH = entry.borderBoxSize ? entry.borderBoxSize[0].blockSize / h : entry.contentRect.height / h;
                
                if (newW === 0 || newH === 0) continue;

                // 首次挂载时的触发不保存
                if (data.isFirstResize) {
                    data.isFirstResize = false; 
                    continue; 
                }

                // 尺寸确实发生变化时才更新，容差稍微放宽至 0.02
                if (!anno.width || Math.abs(anno.width - newW) > 0.02 || Math.abs(anno.height - newH) > 0.02) {
                    anno.width = newW;
                    anno.height = newH;
                    updateSaveStatus(true);
                }
            }
        });

