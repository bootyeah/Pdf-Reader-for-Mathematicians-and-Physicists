/* Read-only model names shared by formula controls; refresh after settings changes. */
(() => {
    let models = {}, pending = null;
    function name(kind, alternate = false) {
        return models[alternate ? 'formula_alt' : kind === 'image' ? 'formula_image' : 'formula_handwriting']
            || (alternate ? '第二模型' : '默认模型');
    }
    function title(kind, alternate) {
        const current = name(kind, alternate), target = name(kind, !alternate);
        return `正在使用${alternate ? '第二模型' : '默认模型'}：${current} · 点击切换至${target}`;
    }
    function refresh() {
        if (pending) return pending;
        pending = (async () => {
            try {
                const response = await fetch('/api/ai-config', {cache: 'no-store'});
                if (!response.ok) throw new Error('Config unavailable');
                const data = await response.json();
                models = Object.fromEntries(Object.entries(data.formula_models || {})
                    .filter(([key, value]) => ['formula_image', 'formula_handwriting', 'formula_alt'].includes(key)
                        && typeof value === 'string' && value.trim()));
            } catch (_) {
                models = {}; // Do not claim an old model is still the active configuration.
            }
            window.dispatchEvent(new Event('reader-model-labels-changed'));
        })().finally(() => { pending = null; });
        return pending;
    }
    window.ReaderModelLabels = {name, title, refresh};
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    refresh();
})();
