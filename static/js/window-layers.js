// 悬浮小窗层级：点击（或打开）哪个小窗，就把它提到所有小窗的最上层。
// 只在 BASE 起的一小段连续层级里重排，不会越过截图遮罩、划词气泡等更高层的界面。
(() => {
    const BASE = 2040;
    // 从下到上；初始顺序沿用原来的固定层级（与 style.css 中的默认值一致）。
    const order = ['note-modal', 'companion-pdf-panel', 'handwriting-whiteboard', 'video-panel', 'ds-chat-panel', 'dict-panel'];
    // 跟随某个小窗同层升降的附属浮层（如文本编辑框旁的 LaTeX 预览）：element -> 所属小窗 id
    const followers = new Map();

    function apply() {
        order.forEach((id, i) => {
            const el = document.getElementById(id);
            if (el) el.style.zIndex = String(BASE + i);
        });
        for (const [el, id] of followers) {
            if (!el.isConnected) { followers.delete(el); continue; }
            el.style.zIndex = String(BASE + order.indexOf(id));
        }
    }

    function ownerOf(target) {
        for (let el = target; el && el !== document.body; el = el.parentElement) {
            if (order.includes(el.id)) return el.id;
            if (followers.has(el)) return followers.get(el);
        }
        return null;
    }

    function bringToFront(target) {
        const id = typeof target === 'string' ? target : ownerOf(target);
        const index = order.indexOf(id);
        if (index === -1) return;
        if (index !== order.length - 1) {
            order.splice(index, 1);
            order.push(id);
        }
        apply();
    }

    // 让 follower 与 anchor 所在的小窗保持同一层级；anchor 不属于任何小窗时不做处理。
    function attach(follower, anchor) {
        const id = ownerOf(anchor);
        if (!id) return;
        followers.set(follower, id);
        follower.style.zIndex = String(BASE + order.indexOf(id));
    }

    // 捕获阶段监听：各小窗内部会 stopPropagation，这里仍能先收到点击。
    window.addEventListener('pointerdown', e => {
        if (ownerOf(e.target)) bringToFront(e.target);
    }, true);

    apply();
    function normalizeCollapseDirection(dir) {
        return dir === 'down' ? 'down' : 'up';
    }

    function collapseDirectionHtml(id, dir = 'up', extraClass = '') {
        const d = normalizeCollapseDirection(dir);
        const cls = extraClass ? ` ${extraClass}` : '';
        return `<span id="${id}" class="window-collapse-dir-btn${cls}" role="group" aria-label="折叠方向">`
            + `<button type="button" class="window-collapse-dir-part${d === 'up' ? ' is-active' : ''}" data-collapse-dir="up" aria-pressed="${d === 'up'}" title="向上折叠（固定顶边）">↑</button>`
            + `<button type="button" class="window-collapse-dir-part${d === 'down' ? ' is-active' : ''}" data-collapse-dir="down" aria-pressed="${d === 'down'}" title="向下折叠（固定底边）">↓</button>`
            + `</span>`;
    }

    function syncCollapseDirectionControl(containerEl, dir) {
        if (!containerEl) return;
        const d = normalizeCollapseDirection(dir);
        for (const part of containerEl.querySelectorAll('[data-collapse-dir]')) {
            const active = part.dataset.collapseDir === d;
            part.classList.toggle('is-active', active);
            part.setAttribute('aria-pressed', String(active));
        }
    }

    function bindCollapseDirectionControl(containerEl, getDir, onChange) {
        if (!containerEl) return;
        syncCollapseDirectionControl(containerEl, typeof getDir === 'function' ? getDir() : 'up');
        containerEl.addEventListener('dblclick', e => e.stopPropagation());
        containerEl.addEventListener('click', e => {
            e.stopPropagation();
            const part = e.target.closest('[data-collapse-dir]');
            if (!part) return;
            const nextDir = normalizeCollapseDirection(part.dataset.collapseDir);
            const prevDir = typeof getDir === 'function' ? normalizeCollapseDirection(getDir()) : 'up';
            syncCollapseDirectionControl(containerEl, nextDir);
            if (nextDir !== prevDir && typeof onChange === 'function') {
                onChange(nextDir);
            }
        });
    }

    // Keep the anchored edge fixed across expand/collapse transitions: top edge for 'up', bottom edge for 'down'.
    function computeCollapseAnchorTop({ dir, collapsing, rect, collapsedHeight, expandedHeight, minTop = 0, maxBottom = window.innerHeight - 8 }) {
        const d = normalizeCollapseDirection(dir);
        const targetHeight = collapsing ? collapsedHeight : expandedHeight;
        const rawTop = d === 'down'
            ? (rect.bottom - targetHeight)
            : rect.top;
        const upperTop = Math.max(minTop, maxBottom - targetHeight);
        return Math.max(minTop, Math.min(Math.round(rawTop), upperTop));
    }

    // 视口高度变化（如进入/退出全屏或缩放窗口）时，保持贴近底部的悬浮窗继续贴合新视口底部。
    const viewportTrackers = new WeakMap();
    const fullscreenSyncHandlers = new Map();
    const BOTTOM_ANCHOR_GAP = 48;

    function isAtViewportBottom(top, height, viewportH) {
        if (!(height > 0) || !(viewportH > 0)) return false;
        const bottomGap = viewportH - (top + height);
        const minTop = Math.max(88, Math.min(120, viewportH * 0.16));
        return bottomGap <= BOTTOM_ANCHOR_GAP && top > minTop;
    }

    function hasViewportBase(panel) {
        return !!(panel && viewportTrackers.has(panel));
    }

    function resetViewportBase(panel, viewportH = window.innerHeight) {
        if (!panel) return;
        const top = panel.offsetTop;
        const height = panel.offsetHeight;
        if (!(height > 0)) return;
        viewportTrackers.set(panel, {
            viewportH,
            lastTop: top,
            lastHeight: height,
            anchored: isAtViewportBottom(top, height, viewportH)
        });
    }

    function clearViewportBase(panel) {
        if (panel) viewportTrackers.delete(panel);
    }

    function noteViewportClamped(panel, viewportH = window.innerHeight) {
        if (!panel) return;
        const tracker = viewportTrackers.get(panel);
        if (!tracker) return;
        tracker.viewportH = viewportH;
        tracker.lastTop = panel.offsetTop;
        tracker.lastHeight = panel.offsetHeight;
    }

    function syncViewportBottom(panel, options = {}) {
        if (!panel) return false;
        if (document.fullscreenElement && document.fullscreenElement !== document.documentElement) return false;
        const nextH = window.innerHeight;
        const curHeight = panel.offsetHeight;
        if (!(curHeight > 0) || !(nextH > 0)) return false;

        const curTop = panel.offsetTop;
        const tracker = viewportTrackers.get(panel);
        if (!tracker) {
            viewportTrackers.set(panel, {
                viewportH: nextH,
                lastTop: curTop,
                lastHeight: curHeight,
                anchored: isAtViewportBottom(curTop, curHeight, nextH)
            });
            return false;
        }

        const prevH = tracker.viewportH;
        if (nextH === prevH) return false;

        const movedExternally = Math.abs(curTop - tracker.lastTop) > 1 || Math.abs(curHeight - tracker.lastHeight) > 1;
        const anchored = movedExternally
            ? isAtViewportBottom(curTop, curHeight, prevH)
            : tracker.anchored;

        const delta = nextH - prevH;
        let shifted = false;
        if (anchored && delta !== 0) {
            const minTop = Number.isFinite(options.minTop) ? options.minTop : 0;
            const maxTop = Number.isFinite(options.maxTop)
                ? options.maxTop
                : Math.max(minTop, nextH - 48);
            const nextTop = Math.max(minTop, Math.min(Math.round(curTop + delta), maxTop));
            if (nextTop !== curTop) {
                panel.style.top = nextTop + 'px';
                shifted = true;
            }
        }

        tracker.viewportH = nextH;
        tracker.lastTop = panel.offsetTop;
        tracker.lastHeight = panel.offsetHeight;
        tracker.anchored = anchored;
        return shifted;
    }

    function bindViewportFullscreenSync(panel, handler) {
        if (panel && typeof handler === 'function') {
            fullscreenSyncHandlers.set(panel, handler);
        }
    }

    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement && document.fullscreenElement !== document.documentElement) return;
        for (const [panel, handler] of fullscreenSyncHandlers) {
            if (!panel.isConnected) {
                fullscreenSyncHandlers.delete(panel);
                continue;
            }
            handler();
        }
    });

    window.FloatingWindowLayers = {
        bringToFront,
        attach,
        normalizeCollapseDirection,
        collapseDirectionHtml,
        syncCollapseDirectionControl,
        bindCollapseDirectionControl,
        computeCollapseAnchorTop,
        hasViewportBase,
        resetViewportBase,
        clearViewportBase,
        noteViewportClamped,
        syncViewportBottom,
        bindViewportFullscreenSync
    };
})();
