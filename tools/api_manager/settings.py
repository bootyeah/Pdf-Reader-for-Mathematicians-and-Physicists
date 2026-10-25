"""Shared, hot-reloaded API settings. No GUI, third-party imports or network on import."""
import ast
import copy
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
FEATURES = {
    'chat': ('内置对话', '阅读器顶部的对话窗口，支持文字和图片。', '对话'),
    # 对话窗口的第二供应商：本项的主要模型与额外模型会并入对话框的模型菜单，
    # 选中这些模型时整组改用本项的接口、Key、温度、超时、代理与备用模型；提示词留空则沿用「内置对话」。
    'chat_gemini': ('内置对话 · Gemini', '对话窗口模型菜单里的 Gemini 选项。这里的主要模型和额外模型会出现在对话框的模型菜单中，选中后改走本项的接口与 Key；提示词留空时沿用「内置对话」的提示词。', '对话'),
    'dictionary': ('单词 / 短语词典', '框选文字后查询词义、音标、用法与例句。', '翻译'),
    'translation': ('整句 / 段落翻译', '框选后的整句、整段翻译。', '翻译'),
    'formula_image': ('图片公式识别', '识图、粘贴图片与框选 PDF 公式的默认模型。', '视觉'),
    'formula_handwriting': ('手写 / 手机识别', '编辑框手写、手机识别及独立手写白板共用的默认接口、Key、模型与调用参数。白板使用独立段落提示词。', '视觉'),
    # 第二模型不是只换接口：formula_bridge._apply_engine 会把本项的整组配置覆盖到默认识别项上，
    # 温度、超时、输出上限、思考、代理、备用模型都跟着换，只有提示词留空时才保留默认项的提示词。
    'formula_alt': ('公式识别 · 第二模型', '按下编辑框公式面板或独立手写白板的「第二模型」后，接口、Key、模型与调用参数（温度、超时、输出上限、思考、代理、备用模型）整组改用此项。白板使用独立段落提示词。', '视觉'),
}
COMMON = dict(base_url='', api_key='', key_source='', model='', fallback_model='',
              models=[], temperature=0.2, timeout=60, max_tokens=0,
              thinking='disabled', proxy='', prompt='', web_search=False)
_LOCK = threading.RLock()

# Google AI Studio 的 OpenAI 兼容端点；Key 走 Authorization: Bearer，与 DeepSeek 调用方式一致。
# 思考参数默认不发送（DeepSeek 的 thinking 字段不属于 Gemini 协议）；代理默认跟随系统代理。
GEMINI_CHAT_DEFAULT = dict(COMMON, base_url='https://generativelanguage.googleapis.com/v1beta/openai',
                           model='gemini-3.8-flash', fallback_model='gemini-3.5-flash',
                           temperature=0.7, timeout=120, thinking='omit', proxy='system')
# 后来新增的功能：旧 settings.json 里没有时按默认值补齐，避免整份配置因缺项被判为损坏。
ADDED_FEATURES = {'chat_gemini': GEMINI_CHAT_DEFAULT}


class ConfigError(ValueError):
    pass


def config_path():
    return Path(os.environ.get('PDF_READER_API_CONFIG') or ROOT / '.api-manager' / 'settings.json')


def _read(path):
    try:
        return upgrade(json.loads(path.read_text(encoding='utf-8-sig')))
    except (OSError, ValueError) as exc:
        raise ConfigError('无法读取 API 配置，请在独立管理工具中检查或恢复备份。') from exc


def upgrade(doc):
    """Fill in features added after the file was written; leaves everything else untouched."""
    features = doc.get('features') if isinstance(doc, dict) else None
    if isinstance(features, dict):
        for fid, default in ADDED_FEATURES.items():
            features.setdefault(fid, copy.deepcopy(default))
    return doc


def _literals(path):
    """Read old Python constants without executing the reader or its Windows setup."""
    values = {}
    def evaluate(node):
        if isinstance(node, ast.Name):
            return values[node.id]
        if isinstance(node, ast.Dict):
            return {evaluate(k): evaluate(v) for k, v in zip(node.keys, node.values)}
        if isinstance(node, (ast.List, ast.Tuple)):
            return [evaluate(n) for n in node.elts]
        return ast.literal_eval(node)
    for statement in ast.parse(path.read_text(encoding='utf-8-sig')).body:
        if isinstance(statement, ast.Assign):
            try:
                value = evaluate(statement.value)
            except (ValueError, TypeError, KeyError):
                continue
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    values[target.id] = value
    return values


# 旧提示词里有一处与阅读器实际能力不符的说法：对话面板其实同时支持
# $...$ / $$...$$ / \(...\) / \[...\]（见 js/chat.js 的 tokenizeMath 与 KaTeX delimiters），
# 但旧文案写成「渲染器不支持 \( \) / \[ \]」。首次导入时改写这句，只保留「统一用 $ / $$」
# 的书写要求，避免管理中心显示过时信息；用户已自行改过的提示词不含这句，不受影响。
_LEGACY_PROMPT_FIXES = (
    ('不要使用 \\( \\) 或 \\[ \\] 这两种定界符（渲染器不支持）。',
     '为了让同一段回答里的定界符保持一致，请统一使用这两种写法，不要混用 \\( \\) 或 \\[ \\]。'),
)


def corrected_prompt(prompt):
    """把从旧常量导入的提示词里已过时的说法改成当前阅读器的实际情况。"""
    for outdated, current in _LEGACY_PROMPT_FIXES:
        prompt = prompt.replace(outdated, current)
    return prompt


def legacy_document():
    old = _literals(ROOT / 'server.py')
    image = _literals(ROOT / 'tex' / 'latex_ocr.py')['DEFAULT_CONFIG']
    hand = _literals(ROOT / 'airtex' / 'core.py')['DEFAULT_CONFIG']
    for kind, cfg in [('tex', image), ('airtex', hand)]:
        path = ROOT / kind / 'config.json'
        if path.exists():
            cfg.update(_read(path))
    base = dict(COMMON, base_url=old['DEEPSEEK_BASE_URL'], model=old['DEEPSEEK_MODEL'],
                fallback_model=old['DEEPSEEK_FALLBACK_MODEL'], proxy=old['PROXY'], timeout=120)
    dictionary = dict(base, api_key=old['DEEPSEEK_API_KEY'], temperature=0.3,
                      thinking='disabled' if old['DEEPSEEK_DISABLE_THINKING'] else 'omit',
                      prompt=old['ENTRY_PROMPT'], web_search=old['ENABLE_WEB_SEARCH'])
    chat = dict(base, api_key=old['CHAT_API_KEY'],
                key_source='' if old['CHAT_API_KEY'] else 'dictionary',
                temperature=0.7, prompt=corrected_prompt(old['CHAT_SYSTEM_PROMPT']), models=['deepseek-v4-pro'])
    def vision(cfg):
        return dict(COMMON, **{k: v for k, v in cfg.items() if k in COMMON})
    alt = dict(vision(image), **old['DEEPSEEK_VISION'])
    alt.update(api_key='', key_source='chat', prompt='')
    return {'version': 1, 'revision': 'legacy', 'updated_at': '', 'features': {
        'chat': chat, 'chat_gemini': copy.deepcopy(GEMINI_CHAT_DEFAULT), 'dictionary': dictionary,
        'translation': dict(dictionary, api_key='', key_source='dictionary', prompt=old['SENTENCE_PROMPT']),
        'formula_image': vision(image), 'formula_handwriting': vision(hand), 'formula_alt': alt,
    }}


def default_prompts():
    """返回各项功能的默认内置提示词，供管理页面一键重置使用。"""
    doc = legacy_document()
    return {fid: cfg.get('prompt', '') for fid, cfg in doc['features'].items()}


def completion_url(base):
    base = base.strip().rstrip('/')
    return base if base.endswith('/chat/completions') else base + '/chat/completions'


def models_url(base):
    base = completion_url(base).removesuffix('/chat/completions')
    return base + '/models'


def _url(value, name, optional=False):
    if optional and not value:
        return
    try:
        url = urllib.parse.urlsplit(value)
        port = url.port
        valid = (url.scheme in ('http', 'https') and url.hostname and not url.username
                 and not url.password and not url.query and not url.fragment)
    except ValueError:
        valid = False
    if not valid or any(c.isspace() for c in value):
        raise ConfigError(name + '必须是 http(s) 地址，不能含用户名、密码、查询参数或片段。')


def validate(doc):
    if not isinstance(doc, dict) or doc.get('version') != 1:
        raise ConfigError('不支持的 API 配置版本。')
    if not isinstance(doc.get('revision'), str) or not isinstance(doc.get('updated_at'), str):
        raise ConfigError('API 配置缺少有效的版本信息。')
    features = doc.get('features')
    if not isinstance(features, dict) or set(features) != set(FEATURES):
        raise ConfigError('API 配置必须包含全部 %d 项功能。' % len(FEATURES))
    for fid, cfg in features.items():
        if not isinstance(cfg, dict) or set(cfg) != set(COMMON):
            raise ConfigError(FEATURES[fid][0] + '的配置字段不完整。')
        for field in ('base_url', 'api_key', 'key_source', 'model', 'fallback_model', 'proxy', 'prompt', 'thinking'):
            if not isinstance(cfg[field], str) or len(cfg[field]) > (40000 if field == 'prompt' else 4096):
                raise ConfigError('字段类型或长度不正确：' + field)
            if field != 'prompt' and any(ord(c) < 32 for c in cfg[field]):
                raise ConfigError('字段不能含控制字符：' + field)
        _url(cfg['base_url'], '接口地址')
        if cfg['proxy'] != 'system':
            _url(cfg['proxy'], '代理地址', optional=True)
        if not cfg['model'].strip():
            raise ConfigError(FEATURES[fid][0] + '的模型名称不能为空。')
        if cfg['thinking'] not in ('disabled', 'enabled', 'omit'):
            raise ConfigError('思考模式无效。')
        for field, low, high in [('temperature', 0, 2), ('timeout', 1, 600), ('max_tokens', 0, 1000000)]:
            value = cfg[field]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                raise ConfigError('%s 必须在 %s–%s 之间。' % (field, low, high))
        if int(cfg['max_tokens']) != cfg['max_tokens']:
            raise ConfigError('输出 token 上限必须为整数。')
        if not isinstance(cfg['web_search'], bool):
            raise ConfigError('联网工具开关必须为布尔值。')
        if not isinstance(cfg['models'], list) or len(cfg['models']) > 50 or any(
                not isinstance(m, str) or not m.strip() or len(m) > 200 or any(ord(c) < 32 for c in m) for m in cfg['models']):
            raise ConfigError('额外模型列表格式无效。')
        api_key_for(doc, fid)  # Validate references, including cycles.
    return doc


def api_key_for(doc, fid):
    seen = set()
    while True:
        if fid not in FEATURES or fid in seen:
            raise ConfigError('共用 Key 存在循环引用或引用了不存在的功能。')
        seen.add(fid)
        cfg = doc['features'][fid]
        if not isinstance(cfg, dict) or not isinstance(cfg.get('key_source'), str):
            raise ConfigError('Key 来源配置格式无效。')
        if not cfg.get('key_source'):
            return cfg.get('api_key', '')
        fid = cfg['key_source']


def load_document():
    path = config_path()
    return validate(_read(path)) if path.exists() else None


def recovery_document():
    """Expose a valid previous version for recovery, without masking a broken live file."""
    doc = validate(_read(config_path().with_suffix('.previous.json')))
    doc['revision'] = 'invalid:' + hashlib.sha256(config_path().read_bytes()).hexdigest()
    return doc


def resolve(fid, defaults, document=None):
    doc = document if document is not None else load_document()
    if doc is None:
        return dict(defaults)
    cfg = dict(defaults, **doc['features'][fid])
    cfg['api_key'] = api_key_for(doc, fid)
    # Empty vision prompts preserve tex / airtex's mode-aware prompt.
    if fid.startswith('formula_') and not cfg['prompt']:
        cfg['prompt'] = defaults.get('prompt', '')
    return cfg


def _atomic_write(path, doc):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(doc, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    fd, temp = tempfile.mkstemp(prefix='.settings-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def save_document(doc, expected_revision, backup=True):
    with _LOCK:
        current = load_document()
        revision = current['revision'] if current else 'legacy'
        if expected_revision != revision:
            raise ConfigError('配置已在另一个窗口中修改，请先重新加载再保存。')
        result = copy.deepcopy(validate(doc))
        result['revision'] = uuid.uuid4().hex
        result['updated_at'] = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
        if backup and current:
            _atomic_write(config_path().with_suffix('.previous.json'), current)
        _atomic_write(config_path(), result)
        return result


def initialize():
    with _LOCK:
        doc = load_document()
        return doc if doc else save_document(legacy_document(), 'legacy', backup=False)


def public_document(doc):
    result = copy.deepcopy(doc)
    for fid, cfg in result['features'].items():
        own = cfg.get('api_key', '')
        cfg['has_own_key'] = bool(own)
        cfg['has_key'] = bool(api_key_for(doc, fid))
        cfg['resolved_key'] = api_key_for(doc, fid)
    return result


def merge_public(incoming, current):
    if not isinstance(incoming, dict) or not isinstance(incoming.get('features'), dict):
        raise ConfigError('无效的配置。')
    doc = upgrade(copy.deepcopy(incoming))
    for fid, cfg in doc['features'].items():
        if fid not in FEATURES or not isinstance(cfg, dict):
            raise ConfigError('无效的功能配置。')
        cfg.pop('has_key', None)
        cfg.pop('has_own_key', None)
        cfg.pop('resolved_key', None)
        # Omitted keys mean keep; an explicit empty string clears the stored key.
        cfg.setdefault('api_key', current['features'][fid]['api_key'])
        for key in ('base_url', 'api_key', 'key_source', 'model', 'fallback_model', 'proxy'):
            if isinstance(cfg.get(key), str):
                cfg[key] = cfg[key].strip()
    return validate(doc)


def restore(expected_revision):
    with _LOCK:
        try:
            load_document()
        except ConfigError:
            recovered = recovery_document()
            if recovered['revision'] != expected_revision:
                raise ConfigError('配置文件已变化，请重新加载后再恢复。')
            recovered['revision'] = uuid.uuid4().hex
            recovered['updated_at'] = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
            _atomic_write(config_path(), recovered)
            return recovered
        previous = validate(_read(config_path().with_suffix('.previous.json')))
        return save_document(previous, expected_revision)


def apply_parameters(payload, cfg):
    payload['temperature'] = cfg.get('temperature', payload.get('temperature', 0.2))
    thinking = cfg.get('thinking', 'disabled')
    payload.pop('thinking', None)
    if thinking != 'omit':
        payload['thinking'] = {'type': thinking}
    if cfg.get('max_tokens', 0) > 0:
        payload['max_tokens'] = int(cfg['max_tokens'])
    return payload


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Bearer credentials must never follow an upstream redirect to another host.
        return None


def open_request(req, cfg):
    proxy = cfg.get('proxy', '').strip()
    handler = (urllib.request.ProxyHandler() if proxy == 'system' else
               urllib.request.ProxyHandler({'http': proxy, 'https': proxy} if proxy else {}))
    return urllib.request.build_opener(handler, _NoRedirect()).open(req, timeout=cfg.get('timeout', 120))


def redact(text, cfg):
    text = str(text)
    key = cfg.get('api_key', '')
    if key:
        text = text.replace(key, '[密钥已隐藏]')
    return re.sub(r'(?i)Bearer\s+[^\s"<>]+', 'Bearer [已隐藏]', text)
