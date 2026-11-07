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
    window.FloatingWindowLayers = { bringToFront, attach };
})();
