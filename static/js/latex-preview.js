// 思维导图与批注共用的旁侧预览；只渲染草稿，不改写批注或撤销记录。
(() => {
    let active = null;

    function open(input, anchor, { avoid = null, onCaretMove = null } = {}) {
        active?.();
        const panel = document.createElement('aside');
        panel.className = 'latex-live-preview';
        panel.setAttribute('aria-label', 'LaTeX 实时预览');
        const viewport = document.createElement('div');
        viewport.className = 'latex-preview-viewport';
        const body = document.createElement('div');
        body.className = 'latex-preview-body';
        const cursor = document.createElement('div');
        cursor.className = 'latex-preview-cursor';
        cursor.setAttribute('aria-hidden', 'true');
        viewport.append(body, cursor);
        panel.append(viewport);
        document.body.appendChild(panel);

        // 浏览预览时保持输入焦点，避免导图的 blur 保存和批注的外部点击保存。
        panel.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
        for (const event of ['pointerdown', 'click', 'dblclick', 'wheel']) {
            panel.addEventListener(event, e => e.stopPropagation());
        }
        // 与正文文本块一致：在预览上右键，把输入框光标挪到对应的源码位置。
        panel.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            moveCaretFromPreview(e.clientX, e.clientY);
        });

        function moveCaretFromPreview(clientX, clientY) {
            if (closed || typeof textAnnotationOffsetAtPoint !== 'function') return;
            const source = lastText ?? '';
            let index = textAnnotationOffsetAtPoint(body, source, clientX, clientY);
            // 防抖期间画面可能仍是上一版；按公共前后缀把偏移换算到当前输入。
            const current = input.value;
            if (source !== current) {
                let prefix = 0, suffix = 0;
                while (prefix < source.length && prefix < current.length && source[prefix] === current[prefix]) prefix++;
                while (suffix < source.length - prefix && suffix < current.length - prefix
                    && source[source.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix++;
                if (index >= source.length - suffix) index += current.length - source.length;
                else if (index > prefix) index = Math.min(index, current.length - suffix);
            }
            index = Math.max(0, Math.min(index, current.length));
            input.focus({ preventScroll: true });
            input.setSelectionRange(index, index);
            scrollInputToCaret(index);
            paint();
            onCaretMove?.(index);
        }
        // setSelectionRange 不会自动滚动 textarea；用镜像排版求光标所在行。
        function scrollInputToCaret(index) {
            if (input.scrollHeight <= input.clientHeight) return;
            const style = getComputedStyle(input);
            const mirror = document.createElement('div');
            mirror.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;';
            for (const property of ['font', 'letterSpacing', 'wordSpacing', 'textIndent', 'tabSize', 'padding', 'direction']) {
                mirror.style[property] = style[property];
            }
            mirror.style.width = input.clientWidth + 'px';
            mirror.textContent = input.value.slice(0, index);
            const caret = document.createElement('span');
            caret.textContent = input.value.slice(index) || '\u200b';
            mirror.appendChild(caret);
            document.body.appendChild(mirror);
            const top = caret.offsetTop;
            const height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
            if (top < input.scrollTop) input.scrollTop = top;
            else if (top + height > input.scrollTop + input.clientHeight) input.scrollTop = top + height - input.clientHeight;
            mirror.remove();
        }

        let timer, frame, lastText, lastCursor, lastPosition, closed = false;
        function paint() {
            const index = input.selectionStart ?? 0;
            if (closed || (input.value === lastText && index === lastCursor)) return;
            lastText = input.value;
            lastCursor = index;
            body.classList.toggle('is-empty', !lastText.trim());
            // 独立的幻影节点命名，避免与正文红标的清理、定位相互干扰。
            body.innerHTML = injectPhantomCursor(lastText, index, 'latex-preview-phantom');
            if (!lastText) body.appendChild(document.createTextNode('输入内容后在此预览'));
            renderLatex(body);
            followCursor = true;
        }
        let followCursor = false, lastLayout;
        function syncCursor() {
            const phantom = body.querySelector('#latex-preview-phantom, #latex-preview-phantom-block');
            cursor.hidden = !phantom;
            if (!phantom) return;
            let rect = phantom.getBoundingClientRect();
            const visible = body.getBoundingClientRect();
            const layout = Math.round(rect.top - visible.top + body.scrollTop);
            if (layout !== lastLayout) followCursor = true;
            lastLayout = layout;
            if (followCursor) {
                const margin = parseFloat(getComputedStyle(body).paddingTop) + 8;
                if (rect.top < visible.top + margin) body.scrollTop -= visible.top + margin - rect.top;
                else if (rect.bottom > visible.bottom - margin) body.scrollTop += rect.bottom - visible.bottom + margin;
                rect = phantom.getBoundingClientRect();
                followCursor = false;
            }
            paintVirtualCursor(cursor, rect, phantom.id === 'latex-preview-phantom', viewport.getBoundingClientRect());
        }
        function update() {
            clearTimeout(timer);
            const hasGraphics = LATEX_CONFIG.environments.some(env => input.value.includes(`\\begin{${env}}`));
            timer = setTimeout(paint, hasGraphics ? 300 : 30);
        }
        function position() {
            const rect = anchor.getBoundingClientRect();
            if (!input.isConnected || !rect.width || !rect.height) { close(); return; }
            const gap = 10, margin = 8;
            const width = Math.min(320, innerWidth - margin * 2);
            const height = Math.min(Math.max(rect.height, 180), 400, innerHeight - margin * 2);
            const sideTop = Math.max(margin, Math.min(rect.top, innerHeight - height - margin));
            // 只放在输入框左右两侧，不再上下摆放。
            const sides = [
                { left: rect.right + gap, top: sideTop, maxHeight: height },
                { left: rect.left - width - gap, top: sideTop, maxHeight: height }
            ];
            const candidates = sides.filter(p => p.left >= margin && p.left + width <= innerWidth - margin);
            const source = avoid?.isConnected ? avoid.getBoundingClientRect() : null;
            // 文本块还支持在正文上右键定位光标，旁侧预览尽量不盖住这块正文。
            // 两侧都放不下时，贴着空间更大的一侧并夹进视口。
            const roomRight = innerWidth - rect.right, roomLeft = rect.left;
            const placement = candidates.find(p => !source || p.left + width <= source.left || p.left >= source.right ||
                p.top + p.maxHeight <= source.top || p.top >= source.bottom) || candidates[0] || {
                left: roomRight >= roomLeft ? innerWidth - width - margin : margin, top: sideTop, maxHeight: height
            };
            const { left, top, maxHeight } = placement;
            const nextPosition = [left, top, width, maxHeight].map(Math.round).join(',');
            if (nextPosition !== lastPosition) {
                lastPosition = nextPosition;
                Object.assign(panel.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: maxHeight + 'px' });
            }
            // 方向键、鼠标选字、Tab 占位和程序设置选区都可能不触发 input。
            if (input.value === lastText && (input.selectionStart ?? 0) !== lastCursor) paint();
            syncCursor();
            frame = requestAnimationFrame(position);
        }
        function close() {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            cancelAnimationFrame(frame);
            input.removeEventListener('input', update);
            panel.remove();
            if (active === close) active = null;
        }
        input.addEventListener('input', update);
        active = close;
        paint();
        position();
        return close;
    }

    window.LatexLivePreview = { open };
})();
