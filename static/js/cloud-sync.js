        // =====================================================================
        // ☁️ 云端批注库 (CloudSync)
        // ---------------------------------------------------------------------
        // 只把「批注 JSON」覆盖同步到 GitHub / Gitee 的私有仓库，绝不保存 PDF 本身，
        // 因此一份教材的云端占用只有几十 KB。文件名由 PDF 名字派生：
        //     物理 必修一.pdf  →  物理 必修一_annotations.json
        // 与「导出批注」的格式完全一致，所以云端下回来的文件可以直接被
        // 「导入批注」按钮打开。
        //
        // 三条铁律（改动这里时请一起守住）：
        //   1. 只做加法：本地保存链路原样保留，云端失败只改状态提示，
        //      绝不弹窗、绝不阻断、绝不回滚本地保存。
        //   2. 令牌只存在于 server.py：浏览器只跟 127.0.0.1:8080 说话。
        //   3. 打开文档只「提示」云端有更新，绝不自动覆盖本地批注；
        //      合并/覆盖都要用户显式点一下。
        //
        // 界面只有两件东西（配色一律跟全站走：blue 主色，绿/琥珀/红只表示结果）：
        //   · 胶囊：检索行右端那枚小药丸，入口 + 云端份数 + 同步状态三合一。
        //     白底 = 眼下没你的事（灰图标 / 蓝色脉冲 = 正在同步）；
        //     带底色 = 有事找你（绿=已同步，琥珀=待传，红=失败，蓝=云端有更新）。
        //     右上角小圆点只在「需要你注意」时出现，完整句子在悬浮提示里。
        //   · 面板：点胶囊展开。标题行（份数 + 刷新 + 关闭）/ 动作条（只在需要点头时出现）
        //     / 搜索框 / 清单。清单行平时只有书名与来源，合并·覆盖按钮移到鼠标悬停时，
        //     因此一屏能安静地多看几本书。
        // =====================================================================
        const CloudSync = (() => {
            const QUEUE_STORE = 'pdf_cloud_queue_v1';   // localforage：离线待传队列（可能装着大批注）
            const SYNC_KEY = 'pdf_cloud_sync_v1';       // localStorage：{指纹: {timestamp, key, device}}
            const DISMISS_KEY = 'pdf_cloud_dismiss_v1'; // localStorage：{指纹: 已被忽略的云端时间戳}
            const MAX_QUEUE = 5;                        // 队列上限：只保留最新的几份，防止无限膨胀
            const OK_HIDE_MS = 6000;                    // 「已同步」提示自动淡出的时间
            // 本地服务最长等多久。只用来兜住「服务彻底卡死」这一种情况，
            // 不预判正常的上传耗时（server.py 自己的一次云端请求上限是 120 秒）。
            const API_TIMEOUT_MS = 120000;

            const dom = {
                // 检索行右端那枚小胶囊：入口 + 云端份数 + 同步状态三合一
                restoreBtn: document.getElementById('cloud-restore-btn'),
                chipIcon: document.getElementById('cloud-chip-icon'),
                chipDot: document.getElementById('cloud-chip-dot'),
                restoreCount: document.getElementById('cloud-restore-count'),
                syncBtn: document.getElementById('cloud-sync-btn'),
                panel: document.getElementById('cloud-panel'),
                panelHead: document.getElementById('cloud-panel-head'),
                panelSearchRow: document.getElementById('cloud-panel-search-row'),
                panelNote: document.getElementById('cloud-panel-note'),
                panelList: document.getElementById('cloud-panel-list'),
                panelRefresh: document.getElementById('cloud-panel-refresh'),
                panelClose: document.getElementById('cloud-panel-close'),
                panelHint: document.getElementById('cloud-panel-hint'),
                panelSearch: document.getElementById('cloud-panel-search'),
                panelSearchClear: document.getElementById('cloud-panel-search-clear'),
                panelCount: document.getElementById('cloud-panel-count'),
                panelAction: document.getElementById('cloud-panel-action'),
                panelActionIcon: document.getElementById('cloud-panel-action-icon'),
                panelActionText: document.getElementById('cloud-panel-action-text'),
                panelActionPrimary: document.getElementById('cloud-panel-action-primary'),
                panelActionClose: document.getElementById('cloud-panel-action-close'),
            };

            const info = { configured: null, reachable: null, provider: '', phase: 'idle', text: '', detail: '', total: null };
            // 云库清单的视图状态：文件很多时靠「搜索 + 只取看得见那几行的详情」保持秒开
            const panelState = { files: [], query: '', rows: new Map(), loaded: false, localTimes: {} };
            let remoteHint = null;          // 云端那份更新的批注（状态条上「合并」的目标）
            let retryRestore = null;        // 取回失败后，「重试」要重做的是取回而不是上传
            let queueOverflow = 0;          // 队列满时被挤掉的份数（只影响云端，本地批注不受影响）
            let transferTail = Promise.resolve();
            let queueTail = Promise.resolve();
            let transfersPending = 0;
            let hideTimer = null;

            // ---------- 小工具 ----------
            const readLocal = (key, fallback) => {
                try {
                    const raw = localStorage.getItem(key);
                    return raw ? JSON.parse(raw) : fallback;
                } catch (_) { return fallback; }
            };
            const writeLocal = (key, value) => {
                try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
            };
            const clockText = iso => {
                const date = new Date(iso);
                if (isNaN(date.getTime())) return '';
                const pad = n => String(n).padStart(2, '0');
                const today = new Date();
                const sameDay = date.toDateString() === today.toDateString();
                const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
                return sameDay ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
            };
            const sizeText = bytes => {
                const n = Math.max(0, Number(bytes) || 0);
                if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
                if (n <= 0) return '0 KB';
                return Math.max(1, Math.round(n / 1024)) + ' KB';
            };
            async function api(url, options) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
                try {
                    const response = await fetch(url, { ...(options || {}), signal: controller.signal });
                    if (!response.ok) throw new Error('本地服务未响应（HTTP ' + response.status + '）');
                    return await response.json();
                } catch (error) {
                    if (error && error.name === 'AbortError') throw new Error('本地服务响应超时');
                    throw error;
                } finally {
                    clearTimeout(timer);
                }
            }

            // ---------- 同步记录（用于判断「云端是否比本地新」）----------
            function syncRecord(fingerprint) {
                if (!fingerprint) return null;
                return readLocal(SYNC_KEY, {})[fingerprint] || null;
            }
            function rememberSync(fingerprint, patch) {
                if (!fingerprint) return;
                const all = readLocal(SYNC_KEY, {});
                all[fingerprint] = { ...(all[fingerprint] || {}), ...patch };
                writeLocal(SYNC_KEY, all);
            }

            // ---------- 离线待传队列 ----------
            async function queueRead() {
                const list = (await localforage.getItem(QUEUE_STORE)) || [];
                if (!Array.isArray(list)) throw new Error('离线队列格式损坏，未覆盖原有队列');
                return list;
            }
            function serialized(tailName, lockName, action) {
                const previous = tailName === 'queue' ? queueTail : transferTail;
                if (tailName === 'transfer') transfersPending++;
                const run = previous.catch(() => {}).then(() => navigator.locks
                    ? navigator.locks.request(lockName, action) : action()).finally(() => {
                        if (tailName === 'transfer') transfersPending--;
                    });
                if (tailName === 'queue') queueTail = run; else transferTail = run;
                return run;
            }
            async function queueWrite(list) {
                // 挤掉最旧的几份时记一笔，好让状态提示如实说明「云端少了几份」，
                // 而不是默默丢掉（本地 PDF 与批注始终不受影响）
                const kept = list.slice(-MAX_QUEUE);
                queueOverflow = Math.max(0, list.length - kept.length);
                await localforage.setItem(QUEUE_STORE, kept);
            }
            async function enqueue(payload) {
                return serialized('queue', QUEUE_STORE, async () => {
                    const list = await queueRead();
                    const rest = list.filter(item => item.fingerprint !== payload.fingerprint);
                    rest.push({ ...payload, queuedAt: new Date().toISOString() });
                    await queueWrite(rest);
                });
            }
            async function dequeue(payload) {
                return serialized('queue', QUEUE_STORE, async () => {
                    const list = await queueRead();
                    const rest = list.filter(item => item.fingerprint !== payload.fingerprint ||
                        JSON.stringify(item.annotations) !== JSON.stringify(payload.annotations));
                    if (rest.length !== list.length) await queueWrite(rest);
                });
            }

            // ---------- 同步状态的呈现（三合一：那枚小胶囊 + 面板顶部的动作条）----------
            // 胶囊只有 24×28 像素，说不下整句话，于是：颜色与图标表状态、右上角小圆点提示
            // 「有事要做」、完整文字进悬浮提示；真正需要用户点头的动作（合并云端更新 /
            // 重试同步）放到面板顶部的动作条里。
            const TONES = {
                idle: ['text-gray-500', 'bg-white', 'border-gray-200', 'ph-cloud', ''],
                syncing: ['text-blue-600', 'bg-white', 'border-gray-200', 'ph-cloud', 'animate-pulse'],
                ok: ['text-green-700', 'bg-green-50', 'border-green-200', 'ph-cloud-check', ''],
                pending: ['text-amber-700', 'bg-amber-50', 'border-amber-200', 'ph-cloud-slash', ''],
                error: ['text-red-700', 'bg-red-50', 'border-red-200', 'ph-cloud-warning', ''],
                remote: ['text-blue-700', 'bg-blue-50', 'border-blue-200', 'ph-cloud-arrow-down', ''],
                // 配置在、但眼下连不上云端（多半是代理没开）：这不是「没启用」，
                // 入口必须留着，点一下就能重试，代理打开后自动恢复
                offline: ['text-red-700', 'bg-red-50', 'border-red-200', 'ph-cloud-slash', ''],
            };
            const DOTS = {
                pending: 'bg-amber-500', error: 'bg-red-500', remote: 'bg-blue-500', offline: 'bg-red-500',
            };
            const OFFLINE_TEXT = '连不上云端（多半是代理没开）';
            // 未启用（含还没探测出结果）时，云端的一切入口都不该出现。
            // 单独成一个函数：render() 每帧都会重写 class，容易把 hidden 一起冲掉。
            // 两枚入口的显示条件不一样：
            //   · 胶囊 = 云端书库的入口，只要云端配好了就该在（不必先打开一本书也能翻仓库）；
            //   · 保存下拉里那颗「立即同步」管的是「当前这份文档的批注」，没开文档就没意义。
            function applyVisibility() {
                const configured = info.configured === true;
                dom.restoreBtn?.classList.toggle('hidden', !configured);
                dom.syncBtn?.classList.toggle('hidden', !(configured && state.fileName));
            }
            function setPhase(phase, text = '', detail = '') {
                info.phase = phase;
                info.text = text;
                info.detail = detail;
                // 镜像一份到全局 state：其它模块（侧栏、测试）想读同步状态时不必反向依赖本模块
                state.cloudSync = { phase, text, detail };
                render();
            }
            function hideLater() {
                clearTimeout(hideTimer);
                hideTimer = setTimeout(() => {
                    if (info.phase === 'ok') setPhase('idle');
                }, OK_HIDE_MS);
            }
            function render() {
                // 「连不上云端」是个连接状态，跟「正在同步/已排队/有更新」这些同步状态不在一个维度上：
                // 手上没有更要紧的事（空闲、或刚同步成功）时，就如实显示成红的、点一下能重试。
                const offline = info.reachable === false && (info.phase === 'idle' || info.phase === 'ok');
                const phase = offline ? 'offline' : info.phase;
                const shownText = offline ? OFFLINE_TEXT : info.text;
                const [textTone, bg, border, icon, motion] = TONES[phase] || TONES.idle;
                if (dom.restoreBtn) {
                    dom.restoreBtn.className = `shrink-0 relative flex items-center gap-1 pl-1.5 pr-2 py-1.5 rounded-md border text-[11px] transition-colors ${textTone} ${bg} ${border}`
                        + (phase === 'idle' ? ' hover:bg-blue-50 hover:border-blue-200' : '');
                    // 胶囊太小，完整句子进悬浮提示；空闲时补一句「上次同步」，好让你随时确认同步过没有
                    const last = syncRecord(state.fingerprint);
                    const lines = [];
                    if (shownText) lines.push(shownText);
                    else if (phase === 'idle' && last) lines.push(`上次同步 ${clockText(last.timestamp)}`);
                    if (info.detail) lines.push(info.detail);
                    lines.push(offline
                        ? '云端配置还在，只是这会儿连不上：打开代理后点这里重试'
                        : '点击查看云端批注库（可合并或覆盖到当前文档）');
                    dom.restoreBtn.title = lines.filter(Boolean).join('\n');
                }
                if (dom.chipIcon) dom.chipIcon.className = `ph ${icon} text-sm shrink-0${motion ? ' ' + motion : ''}`;
                if (dom.chipDot) {
                    const dot = DOTS[phase];
                    dom.chipDot.className = `absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${dot || 'hidden'}`;
                }
                // 面板顶部的动作条：只有「云端有更新」「上传失败/排队」「取回失败」「连不上」时才出现
                if (dom.panelAction) {
                    const actionable = phase === 'remote' || phase === 'pending' || phase === 'error' || phase === 'offline';
                    dom.panelAction.classList.toggle('hidden', !actionable);
                    dom.panelAction.classList.toggle('flex', actionable);
                    if (actionable) {
                        // 侧栏太窄：动作条只放一句短的，完整信息（时间/设备/条数）在悬浮提示里
                        const short = phase === 'remote' && remoteHint
                            ? `云端有更新 · ${remoteHint.device || '另一台设备'}`
                            : (shownText || '云端未同步');
                        dom.panelActionText.textContent = short;
                        dom.panelActionText.title = [shownText, info.detail].filter(Boolean).join('\n');
                        dom.panelActionIcon.className = `ph ${icon} shrink-0`;
                        dom.panelActionPrimary.textContent = phase === 'remote' ? '合并' : '重试';
                        // 忽略按钮任何时候都能用：卡在「待传 / 失败」时也要能把它收起来
                        dom.panelActionClose.classList.remove('hidden');
                    }
                }
                applyVisibility();
                // 动作条的出现/消失会改变面板的头部高度：面板开着时顺手把清单高度重算一次
                if (dom.panel && !dom.panel.classList.contains('hidden')) positionPanel();
            }

            // ---------- 与后端对话 ----------
            // 「配没配」和「通不通」分两次问，因为它们的答案会各自变化：
            //   · 配没配 = 本地读一次 cloud_config.json，毫秒级，决定入口在不在；
            //   · 通不通 = 真去碰一下 GitHub，可能要等 20 秒超时，只决定胶囊是什么颜色。
            // 代理没开时只有后者会失败。入口绝不能跟着后者一起消失——否则只能刷新页面
            // 重新打开 PDF 才能等到代理生效（这正是这条改动的由来）。
            let probe = null;           // 配置探测：同一时刻只发一次
            let reach = null;           // 连通性探测：同一时刻只发一次
            let reachAt = 0;            // 上次连通性探测的时刻（自动重试要限流）
            const REACH_RETRY_MS = 3000;
            async function ensureConfigured(force = false) {
                if (!force && info.configured !== null) { applyVisibility(); return info.configured; }
                if (!force && probe) return probe;
                probe = (async () => {
                    try {
                        const data = await api('/api/cloud-anno/status?local=1');
                        info.configured = !!data.configured;
                        info.provider = data.provider || '';
                        if (!data.configured && data.message) info.detail = data.message;
                    } catch (_) {
                        info.configured = false;   // 本地服务不可用：静默关闭云端功能
                    }
                    applyVisibility();
                    return info.configured;
                })();
                try { return await probe; } finally { probe = null; }
            }
            // 探一次连通性。force = 用户刚点了一下（重试/开面板/点刷新），立刻去试，不等限流。
            async function probeReachability(force = false) {
                if (!(await ensureConfigured())) return false;         // 没配置就没什么可探的
                if (reach) return reach;                               // 正在探：合并成一次
                if (!force && info.reachable !== null && Date.now() - reachAt < REACH_RETRY_MS) return info.reachable;
                reach = (async () => {
                    const wasOffline = info.reachable === false;
                    reachAt = Date.now();
                    try {
                        // 顺带把云端已有多少份带回来：入口上的数字因此开局就是准的
                        const data = await api('/api/cloud-anno/status');
                        if (data.ok === false) {
                            markReachable(false, data.error || '');
                            return false;
                        }
                        if (Number(data.total) >= 0) showCloudCount(data.total);
                        markReachable(true);
                        // 刚从「连不上」恢复：把离线期间排队的那几份顺手补传掉，不必等下次保存
                        if (wasOffline) flushQueue();
                        return true;
                    } catch (error) {
                        markReachable(false, String(error.message || error));
                        return false;
                    }
                })();
                try { return await reach; } finally { reach = null; }
            }
            // 连通性只影响「胶囊长什么样」，不影响入口在不在（那是 applyVisibility 的事，
            // 只看配置）。手上没有更要紧的同步状态时，显示成红色「点一下重试」。
            function markReachable(ok, errorText = '') {
                info.reachable = ok;
                if (ok) {
                    if (info.phase === 'offline') setPhase('idle');
                    else render();
                } else if (info.phase === 'idle' || info.phase === 'ok' || info.phase === 'offline') {
                    setPhase('offline', OFFLINE_TEXT, errorText || info.detail);
                } else {
                    render();      // 正在同步 / 已排队 / 有更新：那些状态更具体，留着
                }
            }
            function showCloudCount(total) {
                info.total = Number(total) || 0;
                if (dom.restoreCount) dom.restoreCount.textContent = info.total > 0 ? String(info.total) : '';
            }

            // 本机对这些云端文件「最后一次同步是什么时候」全都记在 localStorage 里，
            // 因此排序不必多打一次接口：刚批注过的书自然浮到最前面。
            function localSyncTimesByKey() {
                const times = {};
                const records = readLocal(SYNC_KEY, {});
                for (const record of Object.values(records || {})) {
                    if (record && record.key && record.timestamp) times[record.key] = record.timestamp;
                }
                return times;
            }
            function panelSortTime(entry, localTimes) {
                const iso = localTimes[entry.key] || entry.timestamp;
                const parsed = Date.parse(iso || '');
                return isNaN(parsed) ? 0 : parsed;
            }
            // 最近同步过的在前；时间未知的（别的电脑存的）按书名排在后面
            function sortPanelFiles(files, localTimes) {
                return [...files].sort((a, b) => {
                    const diff = panelSortTime(b, localTimes) - panelSortTime(a, localTimes);
                    if (diff) return diff;
                    return String(a.fileName || a.name || '').localeCompare(String(b.fileName || b.name || ''), 'zh-Hans-CN');
                });
            }
            function currentPayload() {
                if (!state.fileName) return null;
                return {
                    name: state.fileName,
                    fingerprint: state.fingerprint || '',
                    localPath: state.localFilePath || '',
                    annotations: JSON.parse(JSON.stringify(state.annotations)),
                };
            }

            // 上传一次（永远用「此刻」的批注快照；失败就排队，等下次保存/打开时补传）
            async function uploadOnce(payload, loadToken) {
                if (!payload) return;
                const isCurrent = () => state.loadToken === loadToken;
                // 已经探明连不上（代理没开）：别让这次保存干等一轮云端超时，直接入队，
                // 等代理回来时 probeReachability 会自动补传。批注本身早就存进本地了。
                if (info.reachable === false) {
                    await enqueue(payload);
                    if (!isCurrent()) return;
                    setPhase('pending', '云端待同步（已排队）',
                        [`${OFFLINE_TEXT}：打开代理后会自动补传（也可点胶囊手动重试）`,
                         queueOverflow ? `队列已满，最旧的 ${queueOverflow} 份未保留` : ''].filter(Boolean).join('\n'));
                    // 顺手在后台再探一次连接：上次探到「连不上」可能已经过时了，
                    // 网络真好的话这次就会把刚入队的这份立刻补传掉（有 3 秒限流，不会打爆）
                    probeReachability();
                    return;
                }
                try {
                    const data = await api('/api/cloud-anno', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'save', ...payload }),
                    });
                    if (!data.ok) throw new Error(data.error || '云端未同步');
                    rememberSync(payload.fingerprint, {
                        timestamp: data.timestamp, key: data.key, device: data.device, at: Date.now(),
                    });
                    await dequeue(payload);
                    if (!isCurrent()) return;
                    remoteHint = null;
                    retryRestore = null;
                    // 新建的文件顺手把入口那个「N 份」加上，免得要等下次打开面板才准
                    if (data.created) showCloudCount((info.total || 0) + 1);
                    setPhase('ok', `云端已同步 ${clockText(data.timestamp)}`,
                        data.renamed
                            ? `云端已有同名但不同内容的另一份文档，本次按指纹另存为：${data.key}`
                            : `已覆盖更新：${data.key}`);
                    hideLater();
                } catch (error) {
                    await enqueue(payload);
                    if (!isCurrent()) return;
                    setPhase('pending', '云端待同步（已排队）',
                        [`下次保存 / 打开文档 / 一键收工前会自动补传 · ${String(error.message || error)}`,
                         queueOverflow ? `队列已满，最旧的 ${queueOverflow} 份未保留` : ''].filter(Boolean).join('\n'));
                }
            }
            // 串行闸门：保存时连点两次 / 顺手改一笔，都不会把两次上传交错在一起
            async function upload() {
                if (!state.fileName || state.annotationsLoading) return;
                const payload = currentPayload(), loadToken = state.loadToken;
                if (!(await ensureConfigured())) return;
                try {
                    return await serialized('transfer', QUEUE_STORE + '-transfer', () => uploadOnce(payload, loadToken));
                } catch (error) {
                    if (state.loadToken === loadToken) setPhase('error', '云端排队失败', String(error.message || error));
                }
            }

            // 补传队列里的（离线期间攒下的）批注
            async function flushQueue() {
                try { return await serialized('transfer', QUEUE_STORE + '-transfer', flushQueueInner); }
                catch (error) { console.warn('云端队列读取失败:', error); return false; }
            }
            async function flushQueueInner() {
                const loadToken = state.loadToken;
                if (!(await ensureConfigured())) return false;
                // 已经探明连不上：队列留着，一份都别白试（每试一份都要等一轮云端超时）
                if (info.reachable === false) return false;
                const list = await queueRead();
                if (!list.length) return false;
                let flushed = 0;
                for (const item of list) {
                    try {
                        const data = await api('/api/cloud-anno', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                action: 'save', name: item.name, fingerprint: item.fingerprint,
                                localPath: item.localPath, annotations: item.annotations,
                            }),
                        });
                        if (!data.ok) throw new Error(data.error || '补传失败');
                        rememberSync(item.fingerprint, {
                            timestamp: data.timestamp, key: data.key, device: data.device, at: Date.now(),
                        });
                        await dequeue(item);
                        flushed += 1;
                    } catch (_) { /* 失败项与补传期间新入队的项均原样保留。 */ }
                }
                if ((await queueRead()).length) return false;
                queueOverflow = 0;
                if (state.loadToken !== loadToken) return true;
                // 队列清空了就把「待同步 / 连不上 / 同步中」收掉，换成「已补传 N 份」。
                // 不能只在「同步中」时收：代理恢复后的自动补传、以及补的正好是当前这份
                // 文档时，胶囊否则会一直亮着琥珀色的「已排队」——明明已经把队排完了。
                //（「云端有更新」这类更具体的提示不动它。）
                if (info.phase === 'syncing' || info.phase === 'pending' || info.phase === 'offline') {
                    setPhase('ok', `已补传 ${flushed} 份云端批注`);
                    hideLater();
                }
                return true;
            }

            // 打开文档后：先补传，再问一次云端有没有更新的批注（只提示，不自动改）
            async function checkRemote() {
                if (!state.fileName || !state.fingerprint) return;
                const loadToken = state.loadToken;
                if (!(await ensureConfigured())) return;
                if (state.loadToken !== loadToken) return;
                if (info.reachable === false) return;      // 已知连不上：别让打开文档白等一次云端超时
                try {
                    const query = new URLSearchParams({
                        name: state.fileName,
                        fingerprint: state.fingerprint,
                        path: state.localFilePath || '',
                    });
                    const data = await api('/api/cloud-anno/status?' + query.toString());
                    if (state.loadToken !== loadToken) return;
                    if (Number(data.total) >= 0 && data.configured) showCloudCount(data.total);
                    if (!data.ok || !data.exists || !data.remote) { remoteHint = null; return; }
                    if (data.matchesFingerprint === false) { remoteHint = null; return; }
                    const record = syncRecord(state.fingerprint);
                    const remoteTime = Date.parse(data.remote.timestamp || '') || 0;
                    const localTime = record ? (Date.parse(record.timestamp || '') || 0) : 0;
                    const dismissed = readLocal(DISMISS_KEY, {})[state.fingerprint];
                    if (remoteTime > localTime + 1000 && dismissed !== data.remote.timestamp) {
                        remoteHint = data.remote;
                        setPhase('remote', `云端有更新的批注（${clockText(data.remote.timestamp)}`
                            + ` · ${data.remote.device || '未知设备'} · ${data.remote.count || 0} 条）`);
                    } else {
                        remoteHint = null;
                    }
                } catch (_) { /* 提示失败不打扰用户 */ }
            }

            // 文档打开、批注恢复完后的统一入口（由 document.js 在尾流结束时调用）
            async function afterAnnotationsReady(loadToken) {
                const isStale = () => state.loadToken !== loadToken;
                if (!(await ensureConfigured()) || isStale()) return;
                // 面板万一正开着（刚打开文档的那一瞬间），把清单重建一次：行内「合并 / 覆盖」
                // 能不能点，是建行时按「当时有没有文档」定下来的
                if (dom.panel && !dom.panel.classList.contains('hidden')) renderPanelList();
                await flushQueue();
                if (isStale()) return;
                await checkRemote();
            }

            // 换文档时调用：上一份文档的「云端有更新」提示与状态一律清空
            //（配置与否的探测结果可以留着，省掉每换一份文档就多打一次接口）
            function resetForDocument() {
                remoteHint = null;
                retryRestore = null;
                clearTimeout(hideTimer);
                // 「连不上云端」跟开没开文档无关：别顺手把它刷回「一切正常」
                if (info.reachable === false) setPhase('offline', OFFLINE_TEXT, info.detail);
                else setPhase('idle');
            }

            // ---------- 取回：复用「导入批注」那一套（指纹校验 + 合并/覆盖）----------
            async function restore(key, mode = 'ask') {
                const loadToken = state.loadToken;
                setPhase('syncing', '正在从云端取回批注…');
                try {
                    const data = await api('/api/cloud-anno/get?key=' + encodeURIComponent(key));
                    if (state.loadToken !== loadToken) return;
                    if (!data.ok) throw new Error(data.error || '取回失败');
                    const applied = importAnnotationBundle(data.document, {
                        source: '云端 · ' + key.split('/').pop(),
                        mode,
                    });
                    if (applied) { retryRestore = null; setPhase('ok', '云端批注已取回'); hideLater(); }
                    else setPhase('idle');
                } catch (error) {
                    if (state.loadToken !== loadToken) return;
                    // 记下「这次失败的是取回」：动作条上的「重试」必须重做取回，
                    // 绝不能改成上传（那会拿本地批注覆盖掉云端那份更新的）
                    retryRestore = () => restore(key, mode);
                    setPhase('error', '云端取回失败', String(error.message || error));
                }
            }

            // ---------- 云库面板 ----------
            // 书多的时候（几十上百份批注）这里靠两件事保持好用：
            //   1) 搜索框：书名 / 云端文件名 / 来源设备 / 当初的本地路径，全部参与匹配；
            //   2) 懒取详情：清单接口只给文件名与体积，时间/设备/条数只对「当前显示出来的
            //      那几行」按批去补（每批最多 8 条），所以几百份也是点开即得。
            function panelMessage(text, tone = 'text-gray-400') {
                const div = document.createElement('div');
                div.className = `px-3 py-6 text-center text-xs ${tone}`;
                div.textContent = text;
                return div;
            }
            function matchQuery(file, query) {
                return [file.fileName, file.name, file.device, file.sourcePath]
                    .some(value => String(value || '').toLowerCase().includes(query));
            }
            function buildPanelRow(file) {
                const wrap = document.createElement('div');
                wrap.className = 'cloud-row group relative px-3 py-2 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors flex items-center gap-2';
                wrap.dataset.cloudKey = file.key;      // 懒取详情时用来认领这一行

                const left = document.createElement('div');
                left.className = 'flex-1 min-w-0';
                const titleRow = document.createElement('div');
                titleRow.className = 'flex items-center gap-1 min-w-0';
                const title = document.createElement('span');
                title.className = 'text-[12px] font-medium text-gray-700 truncate';
                const meta = document.createElement('div');
                meta.className = 'text-[11px] text-gray-400 truncate mt-0.5';
                left.append(titleRow, meta);

                // 行尾的条数：平时就是一行安静的灰字，鼠标移上来时让位给「合并 / 覆盖」
                const count = document.createElement('span');
                count.className = 'shrink-0 text-[10px] text-gray-300 tabular-nums transition-opacity group-hover:opacity-0';

                // 行内动作绝对定位压在条数上：平时隐形（和标题栏那颗「复制文件名」同一套做法），
                // 而且不占布局宽度——否则书名与设备名会被这两个按钮挤到提前截断。
                // 悬停时整行底色是 gray-50，所以动作条自带一段同色渐变，让底下的文字淡出而不是被硬切
                const actions = document.createElement('div');
                actions.className = 'absolute right-0 top-0 bottom-0 pl-10 pr-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity bg-gradient-to-l from-gray-50 from-70% to-transparent';
                const makeBtn = (label, mode, primary) => {
                    const button = document.createElement('button');
                    // 没有打开文档时，「取回」没有落点（importAnnotationBundle 会直接拒绝），
                    // 所以这里就把它置灰说明，而不是让人点下去才弹一个框
                    const ready = !!state.pdfDoc;
                    button.className = 'px-2 py-0.5 text-[11px] rounded transition ' + (primary
                        ? (ready ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-gray-200 text-gray-400 cursor-not-allowed')
                        : (ready ? 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-100' : 'border border-gray-100 text-gray-300 cursor-not-allowed'));
                    button.textContent = label;
                    if (ready) {
                        button.addEventListener('click', () => { closePanel(); restore(file.key, mode); });
                    } else {
                        button.disabled = true;
                        button.title = '打开一本书之后，才能把云端批注取回到当前文档';
                    }
                    return button;
                };
                actions.append(makeBtn('合并', 'merge', true), makeBtn('覆盖', 'overwrite', false));
                wrap.append(left, count, actions);

                const fill = entry => {
                    title.textContent = entry.fileName || entry.name;
                    title.title = entry.key || '';
                    titleRow.replaceChildren(title);
                    // 标签做成独立小徽章：侧栏很窄，标题一长就会把行尾的文字截掉
                    const badge = (text, tone) => {
                        const span = document.createElement('span');
                        span.className = `shrink-0 text-[10px] leading-tight px-1 py-[1px] rounded ${tone}`;
                        span.textContent = text;
                        titleRow.appendChild(span);
                    };
                    if (entry.fingerprint && state.fingerprint && entry.fingerprint === state.fingerprint) badge('当前文档', 'bg-blue-100 text-blue-700');
                    // 云端文件名与「<PDF名>_annotations.json」不一致 = 当初因同名不同文档被另行保存
                    const plain = (entry.fileName || '').replace(/\.[^.]*$/, '') + '_annotations.json';
                    if (entry.fileName && entry.name && entry.name !== plain) badge('同名另存', 'bg-amber-100 text-amber-700');
                    // 一行只放「谁的 · 什么时候」：条数在行尾，体积与云端路径属于排障信息，进悬浮提示
                    const localTime = panelState.localTimes[entry.key];
                    const known = entry.readable || localTime;
                    const line = known
                        ? [entry.device || '未知设备', clockText(localTime || entry.timestamp) || '时间未知'].join(' · ')
                        : `读取中… · ${sizeText(entry.size)}`;
                    meta.textContent = line;
                    meta.title = [line, entry.count ? `${entry.count} 条` : '', sizeText(entry.size), entry.key]
                        .filter(Boolean).join('\n');
                    count.textContent = known && entry.count ? `${entry.count} 条` : '';
                };
                fill(file);
                return { el: wrap, fill };
            }
            function renderPanelList() {
                if (!dom.panelList) return;
                const query = panelState.query.trim().toLowerCase();
                const filtered = query ? panelState.files.filter(f => matchQuery(f, query)) : panelState.files;
                if (dom.panelCount) {
                    dom.panelCount.textContent = panelState.files.length
                        ? (query ? `匹配 ${filtered.length} / 共 ${panelState.files.length} 份` : `共 ${panelState.files.length} 份`)
                        : '';
                }
                panelState.rows.clear();
                dom.panelList.replaceChildren();
                if (!panelState.files.length) {
                    dom.panelList.appendChild(panelMessage('云端还没有批注文件；按一次「保存」就会自动建立。'));
                    return;
                }
                if (!filtered.length) {
                    dom.panelList.appendChild(panelMessage(`没有匹配「${panelState.query.trim()}」的批注文件`));
                    return;
                }
                hydrateQueue.clear();
                const observer = ensureRowObserver();
                for (const file of filtered) {
                    const row = buildPanelRow(file);
                    panelState.rows.set(file.key, row);
                    dom.panelList.appendChild(row.el);
                }
                if (observer) {
                    // 只盯「还没有详情」的行：滚到眼前才补，补过立即取消观察
                    for (const file of filtered) if (!file.readable) observer.observe(panelState.rows.get(file.key).el);
                } else {
                    // 理论上走不到这里（Edge / Chrome 都有 IntersectionObserver）：
                    // 退化成「先补前两批」，至少首屏有详情可看
                    filtered.filter(f => !f.readable).slice(0, VIEW_BATCH * 2).forEach(f => hydrateQueue.add(f.key));
                    scheduleHydrate();
                }
            }

            // ---------- 详情懒取 ----------
            // 清单接口只给文件名与体积，时间 / 设备 / 条数都藏在文件内容里。几百份时绝不能一次全取：
            // 用 IntersectionObserver 只认「滚到眼前」的行（提前 120px 预取，滚到底不留白），再把同一
            // 小段时间里冒出来的几条并成一批（每批最多 8 条，服务端并发取）。于是打开面板的代价与你
            // **实际看了几行**成正比，而不是与你**存了多少份**成正比。
            const VIEW_BATCH = 8;
            const VIEW_MARGIN = '120px 0px';
            const HYDRATE_DEBOUNCE_MS = 60;
            const hydrateQueue = new Set();
            let hydrateTimer = null;
            let rowObserver = null;

            function ensureRowObserver() {
                if (rowObserver || !dom.panelList || typeof IntersectionObserver === 'undefined') return rowObserver;
                rowObserver = new IntersectionObserver(entries => {
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        rowObserver.unobserve(entry.target);          // 补过就不再盯它
                        const key = entry.target.dataset.cloudKey;
                        if (key) hydrateQueue.add(key);
                    }
                    if (hydrateQueue.size) scheduleHydrate();
                }, { root: dom.panelList, rootMargin: VIEW_MARGIN });
                return rowObserver;
            }
            function scheduleHydrate() {
                clearTimeout(hydrateTimer);
                hydrateTimer = setTimeout(flushHydrate, HYDRATE_DEBOUNCE_MS);
            }
            async function flushHydrate() {
                if (!hydrateQueue.size) return;
                const keys = [...hydrateQueue].slice(0, VIEW_BATCH);
                keys.forEach(key => hydrateQueue.delete(key));
                try {
                    const query = keys.map(key => 'keys=' + encodeURIComponent(key)).join('&');
                    const data = await api('/api/cloud-anno/meta?' + query);
                    if (data.ok) {
                        for (const entry of data.entries || []) {
                            const local = panelState.files.find(f => f.key === entry.key);
                            if (local) Object.assign(local, entry);
                            panelState.rows.get(entry.key)?.fill(entry);
                        }
                    }
                } catch (_) { /* 详情取不到不影响合并/覆盖：那两条路各自会取整份文件 */ }
                if (hydrateQueue.size) scheduleHydrate();             // 还有排队的就接着下一批
            }
            async function refreshPanel(force = false) {
                if (!dom.panelList) return;
                if (!panelState.loaded) dom.panelList.replaceChildren(panelMessage('正在读取云端批注库…'));
                try {
                    // 默认用服务端 20 秒缓存：反复开关面板不再打接口；↻ 按钮才强制刷新
                    const data = await api('/api/cloud-anno/list' + (force ? '?refresh=1' : ''));
                    if (!data.ok) throw new Error(data.error || '读取失败');
                    // 标题行只留「云端批注库」一句话：provider / 目录 / 本机名属于排障信息，进悬浮提示
                    if (dom.panelHint) {
                        dom.panelHint.title = [info.provider || data.provider, data.directory, `本机 ${data.device}`]
                            .filter(Boolean).join(' · ');
                    }
                    // 本机同步记录只读一次：既用来排序，也用来给「别的电脑存的」那几行补时间
                    panelState.localTimes = localSyncTimesByKey();
                    panelState.files = sortPanelFiles(data.files || [], panelState.localTimes);
                    panelState.loaded = true;
                    showCloudCount(panelState.files.length);
                    renderPanelList();
                    positionPanel();       // 清单重建后重新对一次高度（提示行可能刚随文档状态出现/消失）
                } catch (error) {
                    dom.panelList.replaceChildren(panelMessage('云端读取失败：' + String(error.message || error), 'text-red-500'));
                }
            }
            // 面板贴在侧栏头部（标题 + 批注列表标签行）正下方：位置实时量出来，
            // 这样改字号、换缩放、标题换成两行都不会压住标签行。
            // 清单高度同样按「侧栏底部还剩多少」实算——写死 52vh 是视口百分比，窗口一矮
            // 面板就会撑出侧栏、被 overflow-hidden 从底下裁掉，最后一行看不全也够不着。
            const PANEL_MIN_LIST = 120;     // 再挤也给清单留这么高，否则什么都看不见
            const PANEL_GAP = 8;            // 面板底边与侧栏底边的呼吸
            function positionPanel() {
                if (!dom.panel || !dom.restoreBtn || !dom.panelList) return;
                const host = dom.panel.offsetParent || dom.panel.parentElement;
                if (!host) return;
                // 没开文档时多出一行说明：先定它，再量高度，否则清单会被算高一点点
                dom.panelNote?.classList.toggle('hidden', !!state.pdfDoc);
                const hostRect = host.getBoundingClientRect();
                const top = Math.max(8, Math.round(dom.restoreBtn.getBoundingClientRect().bottom - hostRect.top + 6));
                dom.panel.style.top = top + 'px';
                // 头部 / 动作条 / 提示行 / 搜索框的实际高度：隐藏时 offsetHeight 为 0，天然只算露出来的
                const chrome = [dom.panelHead, dom.panelAction, dom.panelNote, dom.panelSearchRow]
                    .reduce((sum, el) => sum + (el ? el.offsetHeight : 0), 0);
                const room = Math.round(hostRect.height - top - chrome - PANEL_GAP);
                dom.panelList.style.maxHeight = Math.max(PANEL_MIN_LIST, room) + 'px';
            }
            async function openPanel() {
                if (!dom.panel) return;
                // 先亮出来再量：面板 display:none 时子元素的 offsetHeight 全是 0，量不出头部高度
                dom.panel.classList.remove('hidden');
                positionPanel();
                if (!(await ensureConfigured())) {
                    if (dom.panelList) {
                        dom.panelList.replaceChildren(panelMessage(
                            info.detail || '云端批注库未启用：请在 server.py 顶部的 CLOUD_SYNC 或 cloud_config.json 中配置。',
                            'text-amber-600'));
                    }
                    return;
                }
                if (dom.panelSearch) {
                    dom.panelSearch.value = panelState.query;      // 重开面板保留上次的搜索词
                    dom.panelSearchClear?.classList.toggle('hidden', !panelState.query);
                }
                refreshPanel();
                // 上次探到「连不上」：开面板时顺手再试一次——代理要是刚好打开了，
                // 这次重试就能把清单补上（先把可能失败的提示摆出来，不让面板空等 20 秒）
                if (info.reachable === false) probeReachability(true).then(ok => { if (ok) refreshPanel(true); });
            }
            function closePanel() {
                dom.panel?.classList.add('hidden');
            }

            // 面板顶部动作条的主按钮：云端更新 → 合并；取回失败 → 重做那次取回；
            // 其余（待传 / 上传失败）→ 先把离线队列补传掉，再补一次当前文档
            async function primaryAction() {
                // 连不上云端：这一下「重试」要重试的是「连上云端」，不是重新上传一次注定失败的请求
                if (info.reachable === false) {
                    setPhase('syncing', '正在重试连接云端…');
                    if (!(await probeReachability(true))) return;   // 还是不通：markReachable 已把原因写回胶囊
                    const ok = await flushQueue();
                    if (!ok) await upload();
                    return;
                }
                if (info.phase === 'remote' && remoteHint) {
                    const target = remoteHint;
                    remoteHint = null;
                    closePanel();          // 合并会改写当前批注，面板就地收起，免得看着过期清单
                    await restore(target.key, 'merge');
                    return;
                }
                if (info.phase === 'error' && retryRestore) {
                    const action = retryRestore;
                    retryRestore = null;
                    await action();
                    return;
                }
                setPhase('syncing', '正在重试云端同步…');
                const flushed = await flushQueue();
                if (!flushed) await upload();
            }
            // 动作条右侧的「忽略」：任何时候都能收起提示。
            // 云端有更新的那次要记进 DISMISS_KEY，否则下次打开文档又会冒出来；
            // 待传的那次只是收起提示，队列照旧，下一次保存 / 打开文档仍会自动补传。
            function dismissAction() {
                if (remoteHint && state.fingerprint) {
                    const all = readLocal(DISMISS_KEY, {});
                    all[state.fingerprint] = remoteHint.timestamp;
                    writeLocal(DISMISS_KEY, all);
                }
                const wasPending = info.phase === 'pending';
                const pendingNote = info.detail;
                remoteHint = null;
                retryRestore = null;
                setPhase('idle', '', wasPending ? pendingNote : '');
            }

            // ---------- 事件绑定 ----------
            // 面板顶部动作条：合并云端更新 / 重试同步 / 忽略
            dom.panelActionPrimary?.addEventListener('click', () => primaryAction());
            dom.panelActionClose?.addEventListener('click', () => dismissAction());
            dom.restoreBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (dom.panel?.classList.contains('hidden')) openPanel(); else closePanel();
            });
            dom.syncBtn?.addEventListener('click', async (e) => {
                e.stopPropagation();
                // 先问配置再改状态：未启用时点它不该留下一个永远脉冲的「正在同步」
                if (!(await ensureConfigured())) return;
                // 没开文档时 upload() 会直接返回，状态就会永远停在「正在同步」——这里先拦下来
                if (!state.fileName) { setPhase('idle', '', '先打开一本书，才有批注可以同步到云端'); return; }
                setPhase('syncing', '正在同步到云端…');
                await upload();
            });
            // ↻ 顺便重读一次 cloud_config.json：改完配置不必刷新整个页面
            dom.panelRefresh?.addEventListener('click', async () => {
                await ensureConfigured(true);
                await probeReachability(true);     // 代理刚打开时，这颗按钮就是「立刻再试一次」
                refreshPanel(true);
            });
            dom.panelClose?.addEventListener('click', () => closePanel());
            // 🔍 搜索：纯前端过滤已取回的清单，几百份也是即时出结果
            dom.panelSearch?.addEventListener('input', (e) => {
                panelState.query = e.target.value || '';
                dom.panelSearchClear?.classList.toggle('hidden', !panelState.query);
                renderPanelList();
            });
            dom.panelSearch?.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation();                 // Esc 用于清空搜索，不要顺手把面板也关了
                if (panelState.query) {
                    panelState.query = '';
                    dom.panelSearch.value = '';
                    dom.panelSearchClear?.classList.add('hidden');
                    renderPanelList();
                } else closePanel();
            });
            dom.panelSearchClear?.addEventListener('click', (e) => {
                e.stopPropagation();
                panelState.query = '';
                if (dom.panelSearch) dom.panelSearch.value = '';
                dom.panelSearchClear.classList.add('hidden');
                renderPanelList();
                dom.panelSearch?.focus();
            });
            document.addEventListener('click', (e) => {
                if (!dom.panel || dom.panel.classList.contains('hidden')) return;
                if (e.target.closest('#cloud-panel') || e.target.closest('#cloud-restore-btn')) return;
                closePanel();
            });
            // 窗口一矮，面板的可用高度就跟着缩，别让它撑出侧栏被裁掉
            window.addEventListener('resize', () => {
                if (!dom.panel || dom.panel.classList.contains('hidden')) return;
                positionPanel();
            });
            // 代理是「打开阅读器之后」才开的：切回窗口时顺手再探一次。
            // 通了就自动补传离线队列并让胶囊恢复，省掉「刷新页面重开 PDF」这一趟。
            // 只在上次探到连不上时才动，平时切窗口不会有任何额外请求。
            const retryWhenBack = () => {
                if (info.reachable !== false || transfersPending) return;
                probeReachability().then(ok => { if (ok) flushQueue(); });
            };
            window.addEventListener('focus', retryWhenBack);
            document.addEventListener('visibilitychange', () => { if (!document.hidden) retryWhenBack(); });

            // 首帧就把胶囊刷成「空闲」配色，别让它在第一次同步前是一副没上色的样子
            //（applyVisibility 会顺手保证：探测结果回来之前它是隐形的）
            render();
            // 一进页面先问「配没配」（纯本地，毫秒级）：配好了那枚胶囊立刻就在，不必先打开
            // 一本书才看得到云端书库入口；没配好则始终完全隐形，界面与旧版毫无差别。
            // 之后再探一次连通性——它失败也不会让入口消失，只会把胶囊变红提示「点一下重试」，
            // 所以代理没开时照样能在阅读器里等着代理起来。
            ensureConfigured().then(configured => { if (configured) probeReachability(); });

            // 对外只暴露「别人真正会调的那几个」：应用侧（document.js / extras.js）与自检脚本。
            // 其余（checkRemote / restore / openPanel / closePanel / render…）都在闭包里由内部事件驱动，
            // 想临时排查就用 state.cloudSync（phase/text/detail 的镜像）。
            return {
                upload,
                flushQueue,
                afterAnnotationsReady,
                resetForDocument,
                pendingCount: async () => (await queueRead()).length,
            };
        })();
        window.CloudSync = CloudSync;
