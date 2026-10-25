(() => {
    const $ = id => document.getElementById(id);
    const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    const sections = {
        packages: ['TikZ 宏包与导言', '仅用于本机 TeX Live 编译的图形。每项填写一条导言命令，例如 \\usepackage{siunitx} 或 \\usepackage[version=4]{mhchem}。\n需要的宏包应已安装在 TeX Live 中；自行填写了完整文档的图形仍使用其自己的导言区。'],
        tikzLibraries: ['TikZ 库', '每项填写一个库名称，例如 calc、positioning、arrows.meta。编译图形时统一加载。'],
        pgfplotsLibraries: ['PGFPlots 库', '每项填写一个库名称，例如 fillbetween、colormaps、polar。需要在宏包中保留 pgfplots。'],
        environments: ['绘图环境', '这些环境会作为图形交给 TeX Live 编译，例如 tikzpicture、tikzcd、forest。请同时配置所需宏包。']
    };
    const labels = { packages: 'TikZ 宏包', tikzLibraries: 'TikZ 库', pgfplotsLibraries: 'PGFPlots 库', environments: '绘图环境' };
    let snapshot, draft, saved, selected = 'packages', busy = false, exiting = false;

    async function api(path, body) {
        const response = await fetch(path, {
            method: body ? 'POST' : 'GET',
            headers: { 'X-Manager-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '请求失败，请重新打开管理工具。');
        return data;
    }
    function notice(message, error = false) {
        $('notice').hidden = !message;
        $('notice').textContent = message;
        $('notice').classList.toggle('error', error);
    }
    function isDirty() { return !!draft && JSON.stringify(draft) !== saved; }
    function status() {
        if (exiting) {
            document.querySelectorAll('button, input, textarea').forEach(el => { el.disabled = true; });
            $('save-status').textContent = '已退出';
            return;
        }
        const dirty = isDirty();
        $('save-status').textContent = busy ? '正在处理…' : dirty ? '有未保存的更改' : snapshot ? '所有更改已保存' : '尚未载入配置';
        $('save-status').classList.toggle('dirty', dirty);
        $('save').disabled = busy || !snapshot || !dirty;
        $('restore').disabled = busy || !snapshot?.has_backup;
        $('reload').disabled = busy;
        $('add').disabled = busy || !snapshot;
        $('quit').disabled = busy;
        document.querySelectorAll('#rows input, #rows textarea, #rows button').forEach(el => { el.disabled = busy; });
    }
    function refreshNav() {
        const nav = $('navigation');
        nav.replaceChildren();
        for (const field of Object.keys(sections)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = field === selected ? 'active' : '';
            button.setAttribute('aria-current', field === selected ? 'page' : 'false');
            button.append(document.createTextNode(labels[field]));
            const count = document.createElement('span');
            count.textContent = draft?.[field]?.length || 0;
            button.append(count);
            button.onclick = () => { selected = field; render(); };
            nav.append(button);
        }
    }
    function changed() {
        status();
        refreshNav();
    }
    function render() {
        refreshNav();
        $('section-title').textContent = sections[selected][0];
        $('section-help').textContent = sections[selected][1];
        const rows = $('rows');
        rows.replaceChildren();
        const entries = draft?.[selected] || [];
        $('empty').hidden = !!entries.length;
        entries.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'config-row';
            const input = document.createElement('input');
            input.value = item;
            input.spellcheck = false;
            input.setAttribute('aria-label', labels[selected] + '配置项');
            input.oninput = () => { entries[index] = input.value; changed(); };
            row.append(input);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'remove';
            remove.textContent = '删除';
            remove.setAttribute('aria-label', '删除第 ' + (index + 1) + ' 项');
            remove.onclick = () => { entries.splice(index, 1); render(); changed(); };
            row.append(remove);
            rows.append(row);
        });
        status();
    }
    function accept(data) {
        snapshot = data;
        draft = Object.fromEntries(Object.keys(sections).map(field => [field, [...(data.config[field] || [])]]));
        saved = JSON.stringify(draft);
        $('config-path').textContent = data.config_path;
        render();
    }
    async function run(task) {
        if (busy) return;
        busy = true;
        status();
        try { await task(); }
        catch (error) { notice(error.message, true); }
        finally { busy = false; status(); }
    }
    $('add').onclick = () => {
        draft[selected].push('');
        render(); changed();
        $('rows').lastElementChild?.querySelector('input')?.focus();
    };
    $('reload').onclick = () => {
        if (isDirty() && !confirm('放弃未保存的更改并重新加载？')) return;
        run(async () => { accept(await api('/api/config')); notice('已重新加载配置。'); });
    };
    $('save').onclick = () => run(async () => {
        accept(await api('/api/save', { config: draft, revision: snapshot.revision }));
        notice('已保存。刷新阅读器后生效。');
    });
    $('restore').onclick = () => {
        if (!confirm('恢复上一版 LaTeX 配置？当前草稿将被替换。')) return;
        run(async () => { accept(await api('/api/restore', { revision: snapshot.revision })); notice('已恢复上一版。刷新阅读器后生效。'); });
    };
    $('quit').onclick = () => {
        if (isDirty() && !confirm('有未保存的更改，仍要退出？')) return;
        run(async () => {
            await api('/api/quit', {});
            exiting = true;
            notice('管理工具已退出，可以关闭此页面。');
            document.querySelectorAll('button, input, textarea').forEach(el => { el.disabled = true; });
            snapshot = null;
        });
    };
    window.addEventListener('beforeunload', e => { if (!exiting && isDirty()) { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!$('save').disabled) $('save').click(); }
    });
    run(async () => { accept(await api('/api/config')); });
})();
