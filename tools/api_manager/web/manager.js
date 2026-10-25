'use strict';

const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || sessionStorage.getItem('manager-token') || '';

if (fragment.has('token')) {
    sessionStorage.setItem('manager-token', token);
    history.replaceState(null, '', location.pathname);
}

let doc, saved, metadata = {}, selected = 'chat', hasBackup = false, busy = false;
let defaultPrompts = {};
let keyVisible = true, closed = false;
const results = new Map();
const numeric = new Set(['temperature', 'timeout', 'max_tokens']);
const fields = ['base_url', 'key_source', 'model', 'fallback_model', 'models', 'temperature', 'timeout', 'max_tokens', 'thinking', 'proxy', 'prompt', 'web_search'];

// 功能显示顺序
const FEATURE_ORDER = ['chat', 'chat_gemini', 'dictionary', 'translation', 'formula_image', 'formula_handwriting', 'formula_alt'];

// 极简 SVG 图标
const FEATURE_ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
    chat_gemini: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z"></path></svg>',
    dictionary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path><line x1="9" y1="7" x2="15" y2="7"></line><line x1="9" y1="11" x2="13" y2="11"></line></svg>',
    translation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
    formula_image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
    formula_handwriting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>',
    formula_alt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>'
};

function dirty() {
    return !!doc && JSON.stringify(doc) !== saved;
}

function notice(message, error = false) {
    const el = $('notice');
    el.textContent = message;
    el.className = 'notice-bar' + (error ? ' error' : '');
    el.hidden = !message;
    if (message && !error) {
        setTimeout(() => {
            if (el.textContent === message) el.hidden = true;
        }, 3500);
    }
}

async function api(path, body) {
    const response = await fetch('/api/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
            'X-Manager-Token': token,
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

function lock(on) {
    busy = on;
    document.body.classList.toggle('busy', on);
    document.querySelectorAll('button,input,textarea,select').forEach(el => {
        el.disabled = on;
    });
    if (!on) {
        $('restore').disabled = !hasBackup;
        updateStatus();
    }
}

async function action(fn) {
    if (busy) return;
    notice('');
    lock(true);
    try {
        await fn();
    } catch (error) {
        notice(error.message, true);
    } finally {
        lock(false);
    }
}

function accept(data) {
    doc = data.document;
    saved = JSON.stringify(doc);
    metadata = data.features || {};
    hasBackup = data.has_backup;
    defaultPrompts = data.default_prompts || {};
    results.clear();

    $('config-path').textContent = data.config_path;
    $('config-path').title = data.config_path;

    renderNav();
    renderEditor();
    updateStatus();

    if (data.recovery) notice(data.recovery, true);
}

function renderNav() {
    const totalCount = Object.keys(metadata).length;
    $('feature-count').textContent = String(totalCount).padStart(2, '0');

    const nav = $('navigation');
    nav.replaceChildren();

    FEATURE_ORDER.forEach(fid => {
        if (!metadata[fid] || !doc.features[fid]) return;
        const [title] = metadata[fid];
        const cfg = doc.features[fid];
        const ready = hasKey(fid);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nav-item' + (selected === fid ? ' active' : '');
        btn.setAttribute('aria-current', selected === fid ? 'page' : 'false');
        btn.dataset.feature = fid;

        const iconWrap = document.createElement('div');
        iconWrap.className = 'nav-item-icon';
        iconWrap.innerHTML = FEATURE_ICONS[fid] || FEATURE_ICONS.chat;

        const textWrap = document.createElement('div');
        textWrap.className = 'nav-item-text';

        const nameEl = document.createElement('div');
        nameEl.className = 'nav-item-name';
        nameEl.textContent = title;

        const modelEl = document.createElement('div');
        modelEl.className = 'nav-item-model';
        modelEl.textContent = cfg.model || '未指定模型';

        textWrap.append(nameEl, modelEl);

        const badge = document.createElement('span');
        badge.className = 'nav-item-badge' + (ready ? '' : ' missing');
        badge.title = ready ? 'Key 已配置' : 'Key 未配置';

        btn.append(iconWrap, textWrap, badge);
        btn.onclick = () => {
            selected = fid;
            renderNav();
            renderEditor();
        };

        nav.appendChild(btn);
    });
}

function hasKey(fid, seen = new Set()) {
    return !!currentKey(fid, seen);
}

// Resolve from the current draft, including chained sharing and unsaved edits.
function currentKey(fid, seen = new Set()) {
    if (!doc || seen.has(fid) || !doc.features[fid]) return '';
    seen.add(fid);
    const cfg = doc.features[fid];
    return cfg.key_source ? currentKey(cfg.key_source, seen) : (cfg.api_key || '');
}

function updateStatus() {
    if (!doc) return;
    const changed = dirty();

    $('save-status').textContent = changed ? '有未保存更改 (Ctrl+S)' : '所有更改已保存';
    $('dirty-dot').classList.toggle('dirty', changed);
    $('save').disabled = busy || !changed || doc.revision.startsWith('invalid:');

    const ready = hasKey(selected);
    document.querySelectorAll('nav button[data-feature]').forEach(btn => {
        const configured = hasKey(btn.dataset.feature);
        const badge = btn.querySelector('.nav-item-badge');
        badge.classList.toggle('missing', !configured);
        badge.title = configured ? 'Key 已配置' : 'Key 未配置';
    });
    $('key-status').textContent = ready ? 'Key 已配置' : 'Key 未配置';
    $('key-status').className = 'tag tag-status' + (ready ? '' : ' missing');

    const isVision = selected.startsWith('formula_');
    const keyWarn = $('key-warning');
    if (!ready && isVision) {
        keyWarn.hidden = false;
        keyWarn.textContent = '提示：当前未填写或关联 API Key，识别时会报错。请在上方填入密钥，或选择共用已配置好的 Key。';
    } else {
        keyWarn.hidden = true;
    }
}

function renderEditor() {
    if (!doc || !metadata[selected]) return;
    const cfg = doc.features[selected];
    const [title, description, category] = metadata[selected];

    $('feature-title').textContent = title;
    $('feature-description').textContent = description;

    const catEl = $('feature-category');
    catEl.textContent = category;
    catEl.className = 'tag tag-provider ' + (selected === 'chat_gemini' ? 'gemini'
        : selected.startsWith('formula_') && selected !== 'formula_alt' ? 'glm' : 'deepseek');

    // 密钥来源下拉菜单
    const keySource = $('key_source');
    keySource.replaceChildren();
    keySource.append(new Option('使用独立 API Key', ''));
    Object.entries(metadata).forEach(([fid, [name]]) => {
        if (fid !== selected) {
            keySource.append(new Option('共用「' + name + '」的 Key', fid));
        }
    });

    // 填入常规字段
    fields.forEach(key => {
        const el = $(key);
        if (!el) return;
        if (key === 'web_search') {
            el.checked = !!cfg[key];
        } else if (key === 'models') {
            el.value = Array.isArray(cfg[key]) ? cfg[key].join('\n') : '';
        } else {
            el.value = cfg[key] ?? '';
        }
    });

    // 需求 1 重点：默认直接明文显示当前使用的 API Key！
    // 无论当前是独立 Key 还是共用 Key，输入窗口都直接呈现当前生效的真实 Key
    const isShared = !!cfg.key_source;
    const resolvedKey = currentKey(selected);
    const ownKey = cfg.api_key || '';

    const keyInput = $('api_key');
    const keyHint = $('key-hint');
    const clearBtn = $('clear-key');
    const showBtn = $('show-key');
    const sharedPill = $('shared-key-hint');

    // 默认直接明文显示！
    keyInput.type = keyVisible ? 'text' : 'password';
    showBtn.textContent = keyVisible ? '隐藏' : '显示';
    showBtn.setAttribute('aria-pressed', String(keyVisible));

    if (isShared) {
        const sourceName = metadata[cfg.key_source]?.[0] || cfg.key_source;
        keyHint.textContent = `共用自「${sourceName}」`;
        keyInput.value = resolvedKey;
        keyInput.placeholder = resolvedKey ? '' : '来源尚未配置 API Key';
        keyInput.readOnly = true;
        keyInput.classList.add('is-shared');
        keyInput.title = `当前共用自「${sourceName}」`;
        clearBtn.hidden = true;

        sharedPill.hidden = false;
        $('shared-key-text').textContent = resolvedKey
            ? `当前共用「${sourceName}」的 Key`
            : `当前共用「${sourceName}」的 Key（来源尚未配置）`;
    } else {
        keyHint.textContent = '独立密钥';
        keyInput.value = ownKey;
        keyInput.readOnly = false;
        keyInput.classList.remove('is-shared');
        keyInput.placeholder = ownKey ? '' : '填入 API Key';
        keyInput.title = '';
        clearBtn.hidden = false;

        sharedPill.hidden = true;
    }

    // 专属字段显示/隐藏
    $('chat-models').hidden = selected !== 'chat' && selected !== 'chat_gemini';
    $('search-field').hidden = selected.startsWith('formula_');

    // 备用模型提示微调
    $('fallback-hint').textContent = selected.startsWith('formula_')
        ? '主模型限流或拥堵时自动尝试备用模型（如智谱 1305 拥堵报错时降级重试）。'
        : '主模型不可用时尝试备用模型；鉴权失败（401）不重试。';

    $('remote-models').replaceChildren();
    syncConnection();
    renderResult();
    updateStatus();
}

function syncConnection() {
    if (!doc) return;
    const cfg = doc.features[selected];
    const base = (cfg.base_url || '').trim().replace(/\/+$/, '');
    const endpoint = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
    $('endpoint').textContent = '请求端点 → ' + (base ? endpoint : '未填写地址');
}

// 表单字段输入监听
fields.forEach(key => {
    const el = $(key);
    if (!el) return;
    el.addEventListener('input', () => {
        if (!doc) return;
        const cfg = doc.features[selected];
        if (numeric.has(key)) {
            cfg[key] = el.value === '' ? null : Number(el.value);
        } else if (key === 'models') {
            cfg[key] = [...new Set(el.value.split(/\n|,/).map(x => x.trim()).filter(Boolean))];
        } else if (key === 'web_search') {
            cfg[key] = el.checked;
        } else {
            cfg[key] = el.value;
        }

        if (key === 'base_url') {
            syncConnection();
        }
        if (key === 'key_source') {
            renderEditor();
        }
        if (key === 'model') renderNav();
        updateStatus();
    });
});

// API Key 输入框监听
$('api_key').addEventListener('input', () => {
    if (!doc) return;
    const value = $('api_key').value.trim();
    doc.features[selected].api_key = value;
    updateStatus();
});

// 点击“切换为独立 Key”快捷按钮
$('switch-to-own-btn').onclick = () => {
    if (!doc) return;
    const cfg = doc.features[selected];
    const previousResolved = currentKey(selected);
    cfg.key_source = '';
    // 若原先没有独立 Key，贴心地填充当前共用的 Key 供继续使用
    if (!cfg.api_key && previousResolved) {
        cfg.api_key = previousResolved;
    }
    renderEditor();
    $('api_key').focus();
    notice('已切换为独立 API Key 模式，可直接编辑或保存。');
};

// 复制当前 Key（无论独立还是共用，一键复制当前使用的密钥）
$('copy-key').onclick = () => {
    const key = $('api_key').value.trim();
    if (!key) {
        notice('当前没有配置可复制的 Key。', true);
        return;
    }
    navigator.clipboard.writeText(key).then(() => {
        notice('已复制当前使用的 API Key 至剪贴板。');
    }).catch(() => {
        notice('复制失败，请手动选择复制。', true);
    });
};

// 清空当前 Key
$('clear-key').onclick = () => {
    if (!doc) return;
    doc.features[selected].api_key = '';
    $('api_key').value = '';
    $('api_key').placeholder = '未配置 API Key';
    updateStatus();
    notice('当前草稿已清空此功能的独立 Key，点击“保存设置”后生效。');
};

// 切换显示/隐藏 Key
$('show-key').onclick = () => {
    const isText = $('api_key').type === 'text';
    keyVisible = !isText;
    $('api_key').type = isText ? 'password' : 'text';
    $('show-key').textContent = isText ? '显示' : '隐藏';
    $('show-key').setAttribute('aria-pressed', String(!isText));
};

// 一键恢复默认提示词
$('reset-prompt').onclick = () => {
    if (!doc) return;
    const defPrompt = defaultPrompts[selected] ?? '';
    doc.features[selected].prompt = defPrompt;
    $('prompt').value = defPrompt;
    updateStatus();
    notice('已恢复为该功能的内置默认提示词，保存后生效。');
};

// 复制配置文件路径
const copyPathHandler = () => {
    const path = $('config-path').textContent;
    if (path && path !== '—') {
        navigator.clipboard.writeText(path).then(() => {
            notice('已复制配置文件绝对路径至剪贴板。');
        }).catch(() => {
            notice('复制失败，请手动选择路径复制。', true);
        });
    }
};
$('copy-path-wrap').onclick = copyPathHandler;

// 渲染测试结果
function renderResult() {
    const box = $('test-result');
    const result = results.get(selected);
    box.replaceChildren();

    if (!result) {
        box.hidden = true;
        box.className = 'test-result-box';
        return;
    }

    box.hidden = false;
    box.className = 'test-result-box ' + (result.ok ? 'success' : 'failed');

    const header = document.createElement('div');
    header.className = 'result-header';

    const badge = document.createElement('span');
    badge.className = 'result-badge ' + (result.ok ? 'ok' : 'err');
    badge.textContent = result.ok ? '✓ 连接成功' : '✕ 连接失败';

    const latency = document.createElement('span');
    latency.className = 'result-latency';
    latency.textContent = `HTTP ${result.status} · ${result.elapsed_ms} ms · ${result.at || ''}`;

    header.append(badge, latency);

    const modelTag = document.createElement('div');
    modelTag.className = 'result-model-tag';
    modelTag.textContent = '模型：' + (result.model || '未知');

    const output = document.createElement('pre');
    output.className = 'result-output';
    output.textContent = result.ok ? (result.reply || '接口已正常响应（空返回）') : (result.error || '请求遇到未知错误');

    box.append(header, modelTag, output);

    if (result.usage && Object.keys(result.usage).length) {
        const usage = document.createElement('div');
        usage.className = 'result-usage';
        usage.textContent = `Tokens：输入 ${result.usage.prompt_tokens ?? '-'} / 输出 ${result.usage.completion_tokens ?? '-'} / 总计 ${result.usage.total_tokens ?? '-'}`;
        box.append(usage);
    }
}

// 点击测试连接
$('test').onclick = () => {
    if (!$('editor').reportValidity()) return;
    action(async () => {
        const testBtn = $('test');
        testBtn.textContent = '正在测试…';
        const fid = selected;
        try {
            const result = await api('test', { feature: fid, document: doc });
            result.at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            results.set(fid, result);
            renderResult();
            if (result.ok) {
                notice('测试成功！耗时 ' + result.elapsed_ms + ' ms');
            } else {
                notice('测试失败，请查看下方响应详情。', true);
            }
        } finally {
            testBtn.innerHTML = `
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                <span>测试当前连接</span>
            `;
        }
    });
};

// 拉取远端可用模型列表
$('fetch-models').onclick = () => {
    if (!$('editor').reportValidity()) return;
    action(async () => {
        const result = await api('models', { feature: selected, document: doc });
        if (!result.ok) throw new Error(result.error);
        $('remote-models').replaceChildren(...result.models.map(id => new Option(id, id)));
        notice(`成功读取到 ${result.models.length} 个模型！可在“主要模型”输入框中直接选择。`);
    });
};

// 保存配置
function save() {
    if (closed || !doc || doc.revision.startsWith('invalid:') || !dirty() || !$('editor').reportValidity()) return;
    action(async () => {
        accept(await api('save', { document: doc }));
        notice('设置已保存！阅读器后续请求自动生效。');
    });
}

$('save').onclick = save;
$('editor').onsubmit = e => {
    e.preventDefault();
    save();
};

// 重新加载
$('reload').onclick = () => {
    if (dirty() && !confirm('重新加载会放弃当前未保存的所有草稿。确定继续吗？')) return;
    action(async () => {
        const data = await api('config');
        accept(data);
        if (!data.recovery) notice('已重新加载配置文件。');
    });
};

// 恢复上一版备份
$('restore').onclick = () => {
    if (!confirm('确定使用上一版本（.previous.json）的完整配置覆盖当前设置（包含 Key）并立即保存吗？')) return;
    action(async () => {
        accept(await api('restore', { revision: doc.revision }));
        notice('已成功恢复为上一版保存的配置。');
    });
};

// 退出管理工具
$('quit').onclick = async () => {
    if (busy || closed) return;
    if (dirty() && !confirm('退出将放弃所有未保存的草稿。确定继续退出吗？')) return;

    lock(true);
    try {
        await api('quit', {});
    } catch (error) {
        lock(false);
        notice('退出失败：' + error.message + '。请重试。', true);
        return;
    }
    closed = true;

    // 界面进入已退出状态
    $('quit').disabled = true;
    $('quit').innerHTML = '<span>已退出</span>';
    $('save-status').textContent = '服务已关闭';
    $('dirty-dot').className = 'status-dot';
    $('dirty-dot').style.background = '#9ca3af';

    // 禁用所有修改与操作按钮，防止服务关闭后误操作
    document.querySelectorAll('button:not(#quit),input,textarea,select').forEach(el => {
        el.disabled = true;
    });

    // 优先尝试直接关闭当前页面
    window.close();

    // 如果浏览器安全策略阻止了自动关闭，顶部显示清晰绿条提示
    notice('✓ API 管理后台服务已安全关闭。您可以直接关闭此标签页（或按快捷键 Ctrl+W）。');
};

// 快捷键与窗口关闭防误丢
window.addEventListener('beforeunload', e => {
    if (!closed && dirty()) {
        e.preventDefault();
        e.returnValue = '';
    }
});

document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
    }
});

// 初始化启动
action(async () => accept(await api('config')));
