/* 手机会话属于阅读器页面；收起/后台低频保活，恢复显示时立即同步。 */
(() => {
    async function api(body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
            const response = await fetch('/api/formula/phone', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: controller.signal
            });
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || '手机同步失败');
            return data;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('手机同步超时，正在自动重试');
            throw error;
        } finally { clearTimeout(timer); }
    }
    const sessions = new Set();
    class Session {
        constructor({ purpose = 'formula', engine, change, error, active = () => true,
                      context = null, sidecarTrack = false }) {
            Object.assign(this, { purpose, engine, change, error, active, context, sidecarTrack });
            sessions.add(this);
            this.id = ''; this.generation = 0; this.timer = null; this.starting = null;
            this.state = {}; this.pairing = null; this.sidecarDocSeq = 0;
            this.ws = null; this.wsUrl = ''; this.wsRetryTimer = null;
            this.connection = 'lan'; this.switching = false;
            this.connectionKey = 'pdf_reader_phone_connection_' + purpose;
            try {
                const keys = purpose === 'unified'
                    ? [this.connectionKey, 'pdf_reader_phone_connection_whiteboard', 'pdf_reader_phone_connection_formula']
                    : [this.connectionKey];
                if (keys.some(k => localStorage.getItem(k) === 'internet')) this.connection = 'internet';
            } catch (_) {}
            this.pollGeneration = null; this.refreshPending = false; this.failures = 0;
            document.addEventListener('visibilitychange', () => {
                if (!this.id) return;
                if (!document.hidden) this.refresh();
                else this.schedule();
            });
            window.addEventListener('pagehide', e => {
                if (!e.persisted && this.id) navigator.sendBeacon('/api/formula/phone',
                    new Blob([JSON.stringify({ action: 'close', session: this.id })], { type: 'application/json' }));
            });
        }
        closeWs() {
            clearTimeout(this.wsRetryTimer); this.wsRetryTimer = null;
            if (this.ws) {
                const old = this.ws; this.ws = null;
                try { old.onclose = old.onmessage = old.onerror = null; old.close(); } catch (_) {}
            }
            this.wsUrl = '';
        }
        connectWs(wsUrl, generation = this.generation) {
            if (!wsUrl || typeof WebSocket !== 'function' || generation !== this.generation || !this.id) return;
            if (this.ws && this.wsUrl === wsUrl && this.ws.readyState <= 1) return;
            this.closeWs();
            this.wsUrl = wsUrl;
            let sock;
            try { sock = new WebSocket(wsUrl); } catch (_) { return; }
            this.ws = sock;
            sock.onmessage = ev => {
                if (this.ws !== sock || generation !== this.generation || !this.id) return;
                let msg;
                try { msg = JSON.parse(ev.data); } catch (_) { return; }
                if (msg?.type !== 'state') return;
                if (Number.isFinite(msg.seq) && msg.seq < (this.state.seq ?? -1)) return;
                this.applyState(msg, true);
            };
            sock.onclose = () => {
                if (this.ws !== sock) return;
                this.ws = null;
                if (generation === this.generation && this.id && wsUrl) {
                    this.wsRetryTimer = setTimeout(() => this.connectWs(wsUrl, generation), 2500);
                }
            };
            sock.onerror = () => {};
        }
        applyState(payload, fromWs = false) {
            // sidecarDocs 是一次性增量快照，绝不持久化进 this.state；
            // 否则后续切页或退出映射时会把旧快照反复回放，导致非当前页只剩早先一部分笔迹。
            const { sidecarDocs, ...rest } = payload;
            const prevSidecarSeq = this.sidecarDocSeq;
            const hasDelta = !!(sidecarDocs && typeof sidecarDocs === 'object');
            if (Number.isFinite(payload.sidecarDocSeq)) {
                if (!fromWs || hasDelta) {
                    this.sidecarDocSeq = Math.max(this.sidecarDocSeq, payload.sidecarDocSeq);
                } else {
                    const wsCoversActive = payload.sidecarDocSeq === prevSidecarSeq + 1
                        && payload.scene === 'sidecar'
                        && Number.isInteger(payload.sidecarPage) && payload.sidecarPage > 0
                        && payload.sidecarDocPage === payload.sidecarPage
                        && !!payload.doc
                        && (!payload.pageId || payload.pageId === `sidecar:${payload.sidecarPage}`);
                    if (wsCoversActive) {
                        this.sidecarDocSeq = Math.max(this.sidecarDocSeq, payload.sidecarDocSeq);
                    }
                }
            }
            this.state = { ...this.state, ...rest };
            this.change(hasDelta ? { ...this.state, sidecarDocs } : this.state, this.pairing);
            if (fromWs && this.sidecarTrack && Number.isFinite(payload.sidecarDocSeq) && payload.sidecarDocSeq > this.sidecarDocSeq) {
                this.refresh();
            }
        }
        close() {
            ++this.generation; clearTimeout(this.timer); this.timer = null;
            this.closeWs();
            if (this.id) api({ action: 'close', session: this.id }).catch(() => {});
            this.id = ''; this.state = {}; this.pairing = null; this.starting = null;
            this.sidecarDocSeq = 0;
            this.pollGeneration = null; this.refreshPending = false; this.failures = 0;
            this.switching = false;
        }
        acceptPairing(info) {
            if (!info || (info.pairingRev ?? 0) < (this.pairing?.pairingRev ?? 0)) return;
            this.pairing = info;
            if (info.connection) this.connection = info.connection;
            if (info.wsUrl) this.connectWs(info.wsUrl, this.generation);
        }
        extraContext() {
            if (typeof this.context !== 'function') return {};
            const ctx = this.context();
            const out = {};
            if (ctx?.activePurpose) out.activePurpose = ctx.activePurpose;
            if (ctx?.activeTarget) out.activeTarget = ctx.activeTarget;
            return out;
        }
        async start(replace = false) {
            if (replace) this.close();
            if (this.id) { this.change(this.state, this.pairing); this.refresh(); return; }
            if (this.starting) return this.starting;
            const generation = this.generation;
            this.starting = (async () => {
                try {
                    const data = await api({ action: 'start', engine: this.engine(), purpose: this.purpose,
                        connection: this.connection, ...this.extraContext() });
                    if (generation !== this.generation) { api({ action: 'close', session: data.session }).catch(() => {}); return; }
                    this.id = data.session; this.acceptPairing(data);
                    this.change(this.state, this.pairing);
                    this.poll(generation);
                } catch (error) { if (generation === this.generation) this.error(error.message); }
                finally { if (generation === this.generation) this.starting = null; }
            })();
            return this.starting;
        }
        async setConnection(connection, retry = false) {
            if (this.switching || !['lan', 'internet'].includes(connection)) return;
            const generation = this.generation;
            this.connection = connection; this.switching = true;
            try {
                localStorage.setItem(this.connectionKey, connection);
                if (this.purpose === 'unified') {
                    localStorage.setItem('pdf_reader_phone_connection_formula', connection);
                    localStorage.setItem('pdf_reader_phone_connection_whiteboard', connection);
                }
            } catch (_) {}
            this.change(this.state, { connection, status: 'starting', qr: '', urls: [], message: '正在切换连接方式…' });
            try {
                await this.start();
                if (generation !== this.generation || !this.id) return;
                const data = await api({ action: 'connection', session: this.id, engine: this.engine(), connection, retry });
                if (generation !== this.generation) return;
                this.acceptPairing(data.pairing);
            } catch (error) {
                if (generation === this.generation) this.error(error.message);
            } finally {
                if (generation === this.generation) {
                    this.switching = false;
                    this.change(this.state, this.pairing);
                    this.refresh();
                }
            }
        }
        schedule(generation = this.generation) {
            clearTimeout(this.timer); this.timer = null;
            if (generation !== this.generation || !this.id || this.pollGeneration === generation) return;
            const delay = document.hidden || !this.active() ? 30000 : Math.min(30000, 700 * 2 ** Math.min(this.failures, 6));
            this.timer = setTimeout(() => this.poll(generation), delay);
        }
        refresh() {
            if (this.pollGeneration === this.generation) { this.refreshPending = true; return; }
            this.poll(this.generation);
        }
        async poll(generation) {
            if (generation !== this.generation || !this.id) return;
            if (this.pollGeneration === generation) return;
            clearTimeout(this.timer); this.timer = null; this.pollGeneration = generation;
            try {
                const payload = { action: 'state', session: this.id, engine: this.engine(), rev: this.state.rev,
                    pairingRev: this.pairing?.pairingRev, ...this.extraContext() };
                if (this.sidecarTrack) payload.sidecarDocSeq = this.sidecarDocSeq;
                const data = await api(payload);
                if (generation !== this.generation) return;
                this.failures = 0;
                if (Number.isFinite(data.seq) && data.seq < (this.state.seq ?? -1)) {
                    if (this.sidecarTrack && Number.isFinite(data.sidecarDocSeq) && data.sidecarDocSeq > this.sidecarDocSeq) {
                        this.refreshPending = true;
                    }
                    return;
                }
                if (!this.switching) this.acceptPairing(data.pairing);
                this.applyState(data, false);
            } catch (error) {
                if (generation === this.generation) { this.failures++; this.error(error.message); }
            } finally {
                if (generation === this.generation) {
                    this.pollGeneration = null;
                    if (this.refreshPending) { this.refreshPending = false; this.refresh(); }
                    else this.schedule(generation);
                }
            }
        }
        async action(action, extra = {}) {
            if (!this.id) return this.error('请先扫码连接手机');
            const generation = this.generation;
            try {
                const body = { action, session: this.id, engine: extra.engine ?? this.engine(), ...extra };
                if (this.sidecarTrack) body.sidecarDocSeq = this.sidecarDocSeq;
                const data = await api(body);
                if (generation !== this.generation) return;
                if (Number.isFinite(data.seq) && data.seq < (this.state.seq ?? -1)) {
                    if (this.sidecarTrack && Number.isFinite(data.sidecarDocSeq) && data.sidecarDocSeq > this.sidecarDocSeq) {
                        this.refresh();
                    }
                    return data;
                }
                this.acceptPairing(data.pairing);
                this.applyState(data, false);
                return data;
            } catch (error) { if (generation === this.generation) this.error(error.message); }
        }
    }

    // 统一手写会话中枢：公式编辑框、独立手写白板、无界草稿本共享同一个扫码连接与画板。
    const consumers = new Map();
    let sharedSession = null;
    let lastActiveConsumerId = 'whiteboard';

    function pickActiveConsumer() {
        for (const id of ['formula', 'sidecar', 'whiteboard']) {
            const c = consumers.get(id);
            if (c?.active?.()) return c;
        }
        return consumers.get(lastActiveConsumerId) || consumers.values().next().value || null;
    }

    function ensureSharedSession() {
        if (sharedSession) return sharedSession;
        sharedSession = new Session({
            purpose: 'unified',
            sidecarTrack: true,
            engine: () => pickActiveConsumer()?.engine?.() || '',
            active: () => {
                for (const c of consumers.values()) if (c.active?.()) return true;
                return false;
            },
            context: () => {
                const c = pickActiveConsumer();
                return c ? { activePurpose: c.purpose, activeTarget: c.id } : {};
            },
            change: (state, pairing) => {
                for (const c of consumers.values()) {
                    try { c.change?.(state, pairing); } catch (err) { console.error(err); }
                }
            },
            error: message => {
                for (const c of consumers.values()) {
                    try { c.error?.(message); } catch (err) { console.error(err); }
                }
            }
        });
        return sharedSession;
    }

    function connect({ id, purpose = 'formula', engine = () => '', active = () => false, change, error }) {
        const entry = { id, purpose, engine, active, change, error };
        consumers.set(id, entry);
        const s = () => ensureSharedSession();
        return {
            get id() { return s().id; },
            get state() { return s().state; },
            get pairing() { return s().pairing; },
            get connection() { return s().connection; },
            get switching() { return s().switching; },
            async start(replace = false) {
                lastActiveConsumerId = id;
                const inst = s();
                if (!replace && inst.id) {
                    entry.change?.(inst.state, inst.pairing);
                    inst.refresh();
                    return;
                }
                return inst.start(replace);
            },
            schedule() { s().schedule(); },
            refresh() { lastActiveConsumerId = id; s().refresh(); },
            setConnection(conn, retry = false) {
                lastActiveConsumerId = id;
                try { localStorage.setItem('pdf_reader_phone_connection_' + purpose, conn); } catch (_) {}
                return s().setConnection(conn, retry);
            },
            action(act, extra = {}) {
                lastActiveConsumerId = id;
                const inst = s();
                if (act === 'recognize') {
                    return inst.action('recognize', { purpose, target: id, engine: engine(), ...extra });
                }
                return inst.action(act, { engine: engine(), ...extra });
            }
        };
    }
    function renderPairing(session, info, { qr, link, modes, hint, retry, placeholder }) {
        info ||= { connection: session.connection, status: 'starting', urls: [], qr: '', message: '正在生成配对码…' };
        qr.hidden = !info.qr;
        if (info.qr && qr.getAttribute('src') !== info.qr) qr.src = info.qr;
        if (info.urls?.[0]) link.href = info.urls[0];
        else link.removeAttribute('href');
        link.setAttribute('aria-disabled', String(!info.urls?.[0]));
        modes.querySelectorAll('[data-connection]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.connection === (info.connection || session.connection)));
            button.disabled = session.switching;
        });
        hint.textContent = info.message || '手机与电脑连接同一 Wi-Fi 后扫码';
        hint.dataset.status = info.status || 'ready';
        retry.hidden = info.status !== 'error'; retry.disabled = session.switching;
        if (placeholder) {
            placeholder.hidden = !!info.qr;
            const label = placeholder.querySelector('span');
            if (label) label.textContent = info.status === 'error' ? '连接未就绪' : '生成配对码…';
        }
    }
    function draw(canvas, board, whole = false, fitPadding = null) {
        board ||= { w: 900, h: 400, strokes: [] };
        let frame = { x: 0, y: 0, w: board.w, h: board.h };
        const tightFit = !whole && Number.isFinite(fitPadding);
        let padding = 0;
        if (!whole || board.infinite) {
            let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
            for (const st of board.strokes || []) {
                if (st.k === 'eraser') continue;
                const radius = (st.w || 3) / 2;
                for (const [x, y] of st.p || []) {
                    left = Math.min(left, x - radius); top = Math.min(top, y - radius);
                    right = Math.max(right, x + radius); bottom = Math.max(bottom, y + radius);
                }
            }
            if (Number.isFinite(left)) {
                const margin = tightFit ? 0 : Math.max(24, Math.max(right - left, bottom - top) * .12);
                const w = tightFit ? right - left : Math.max(120, right - left + margin * 2);
                const h = tightFit ? bottom - top : Math.max(80, bottom - top + margin * 2);
                frame = { x: (left + right - w) / 2, y: (top + bottom - h) / 2, w, h };
                if (tightFit) padding = Math.max(0, fitPadding);
                if (whole && board.infinite) {
                    const x = Math.min(0, frame.x), y = Math.min(0, frame.y);
                    frame = { x, y, w: Math.max(board.w, frame.x + frame.w) - x,
                        h: Math.max(board.h, frame.y + frame.h) - y };
                }
            }
        }
        const r = canvas.getBoundingClientRect(); if (!r.width || !r.height) return;
        // Tight-fit padding is measured in CSS pixels so it stays small at every zoom level.
        padding = Math.min(padding, Math.min(r.width, r.height) / 4);
        const dpr = devicePixelRatio || 1, scale = Math.min((r.width - padding * 2) / frame.w, (r.height - padding * 2) / frame.h);
        canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
        const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
        ctx.fillStyle = whole && !board.infinite ? '#f1f5f9' : 'white'; ctx.fillRect(0, 0, r.width, r.height);
        ctx.translate((r.width - frame.w * scale) / 2, (r.height - frame.h * scale) / 2);
        ctx.scale(scale, scale); ctx.translate(-frame.x, -frame.y);
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, board.w, board.h);
        if (!board.infinite) { ctx.beginPath(); ctx.rect(0, 0, board.w, board.h); ctx.clip(); }
        for (const st of board.strokes || []) {
            if (!st.p?.length) continue;
            ctx.strokeStyle = ctx.fillStyle = st.k === 'eraser' ? 'white' : (st.c || '#172033');
            ctx.lineWidth = st.w; ctx.lineCap = ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(...st.p[0]);
            for (let i = 1; i < st.p.length; i++) ctx.lineTo(...st.p[i]);
            ctx.stroke(); ctx.beginPath(); ctx.arc(...st.p[0], st.w / 2, 0, Math.PI * 2); ctx.fill();
        }
    }
    function getContentBounds(board) {
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        let hasContent = false;
        for (const st of board?.strokes || []) {
            if (st.k === 'eraser' || !st.p?.length) continue;
            const radius = (st.w || 3) / 2;
            for (const [x, y] of st.p) {
                left = Math.min(left, x - radius);
                top = Math.min(top, y - radius);
                right = Math.max(right, x + radius);
                bottom = Math.max(bottom, y + radius);
                hasContent = true;
            }
        }
        if (!hasContent || !Number.isFinite(left)) return null;
        return { left, top, right, bottom, width: right - left, height: bottom - top };
    }
    function renderCroppedCanvas(board, options = {}) {
        board ||= { w: 900, h: 400, strokes: [] };
        const bounds = getContentBounds(board);
        if (!bounds) return null;

        const contentW = bounds.width;
        const contentH = bounds.height;
        const padding = Number.isFinite(options.padding)
            ? Math.max(0, options.padding)
            : Math.max(16, Math.min(36, Math.max(contentW, contentH) * 0.04));

        const cropX = bounds.left - padding;
        const cropY = bounds.top - padding;
        const cropW = contentW + padding * 2;
        const cropH = contentH + padding * 2;

        const maxDim = Math.max(cropW, cropH);
        const minTargetDim = options.minTargetDim ?? 600;
        const maxTargetDim = options.maxTargetDim ?? 2400;
        let scale = options.scale ?? 2.0;

        if (maxDim * scale < minTargetDim) {
            scale = minTargetDim / maxDim;
        } else if (maxDim * scale > maxTargetDim) {
            scale = maxTargetDim / maxDim;
        }
        scale = Math.max(1.0, Math.min(6.0, scale));

        const outW = Math.max(1, Math.round(cropW * scale));
        const outH = Math.max(1, Math.round(cropH * scale));

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);

        ctx.save();
        ctx.scale(scale, scale);
        ctx.translate(-cropX, -cropY);

        for (const st of board.strokes || []) {
            if (!st.p?.length) continue;
            ctx.strokeStyle = ctx.fillStyle = st.k === 'eraser' ? '#ffffff' : (st.c || '#172033');
            ctx.lineWidth = st.w || 3;
            ctx.lineCap = ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(...st.p[0]);
            for (let i = 1; i < st.p.length; i++) ctx.lineTo(...st.p[i]);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(st.p[0][0], st.p[0][1], (st.w || 3) / 2, 0, Math.PI * 2);
            ctx.fill();
            if (st.p.length > 1) {
                const last = st.p[st.p.length - 1];
                ctx.beginPath();
                ctx.arc(last[0], last[1], (st.w || 3) / 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
        return canvas;
    }
    async function copyBoardImage(board, options = {}) {
        const canvas = renderCroppedCanvas(board, options);
        if (!canvas) return { ok: false, empty: true, error: '画板暂无手写笔迹可复制' };

        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob(b => (b ? resolve(b) : reject(new Error('生成图片数据失败'))), 'image/png');
        });

        if (!navigator.clipboard?.write || !window.ClipboardItem) {
            throw new Error('当前环境不支持直接写入图片到剪贴板');
        }

        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return { ok: true, width: canvas.width, height: canvas.height };
    }
    function drawMapped(canvas, board) {
        if (!canvas) return;
        const r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const dpr = devicePixelRatio || 1;
        const targetW = Math.round(r.width * dpr), targetH = Math.round(r.height * dpr);
        if (canvas.width !== targetW) canvas.width = targetW;
        if (canvas.height !== targetH) canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, targetW, targetH);
        if (!board?.strokes?.length) return;
        const bw = board.w || 1000, bh = board.h || 1414;
        const sx = r.width / bw, sy = r.height / bh;
        ctx.scale(dpr, dpr);
        for (const st of board.strokes) {
            if (!st.p?.length) continue;
            const isEraser = st.k === 'eraser';
            ctx.save();
            if (isEraser) ctx.globalCompositeOperation = 'destination-out';
            const color = isEraser ? '#000000' : (st.c || '#172033');
            ctx.strokeStyle = ctx.fillStyle = color;
            const lw = Math.max(0.75, (st.w || 3) * sx);
            ctx.lineWidth = lw;
            ctx.lineCap = ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(st.p[0][0] * sx, st.p[0][1] * sy);
            for (let i = 1; i < st.p.length; i++) {
                ctx.lineTo(st.p[i][0] * sx, st.p[i][1] * sy);
            }
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(st.p[0][0] * sx, st.p[0][1] * sy, lw / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }
    function stop() {
        for (const s of sessions) s.close();
    }
    window.PhoneHandwriting = { Session, connect, draw, drawMapped, renderPairing, getContentBounds, renderCroppedCanvas, copyBoardImage, stop };
})();
