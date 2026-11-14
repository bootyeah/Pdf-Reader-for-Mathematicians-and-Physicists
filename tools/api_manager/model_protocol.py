"""Small, shared Chat Completions capability table and response checks.

Known models follow their official protocol (sources in docs/ai-review-2026-11-13.md).
Unrecognized gateway models retain the existing custom-parameter path.
"""
import re
from urllib.parse import urlsplit

ACTIVE_MODES = ('enabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
MODES = ('disabled',) + ACTIVE_MODES + ('omit',)


def model_id(model):
    return str(model or '').strip().lower().rsplit('/', 1)[-1]


def capabilities(model, base_url=''):
    m = model_id(model)
    result = dict(family='general', protocol='legacy', known=False, can_disable=True,
                  default_thinking=None, options=list(MODES), token_field='max_tokens',
                  retain_reasoning=False)

    def known(family, protocol, levels=(), can_disable=True, default=True, **extra):
        result.update(family=family, protocol=protocol, known=True, can_disable=can_disable,
                      default_thinking=default,
                      options=(['disabled'] if can_disable else []) + ['enabled'] + list(levels) + ['omit'],
                      **extra)

    if re.match(r'^kimi-k3(?:[.-]|$)', m):
        known('kimi', 'effort', ('low', 'high', 'max'), False,
              token_field='max_completion_tokens', retain_reasoning=True)
    elif re.match(r'^glm-5\.3-flash(?:x)?(?:-|$)', m):
        known('glm', 'thinking', ('low', 'high', 'max'), False)
    elif re.match(r'^glm-4\.[567](?:v)?(?:-|$)', m):
        known('glm', 'thinking')
    elif re.match(r'^deepseek-(?:(?:v4(?:\.\d+)?-)?(?:flash|pro)|v4(?:\.\d+)?)(?:-|$)', m):
        known('deepseek', 'thinking', ('low', 'high', 'max'))
    elif m in ('deepseek-chat', 'deepseek-reasoner') or re.match(r'^deepseek-v3\.2(?:-|$)', m):
        known('deepseek', 'thinking', ('low', 'high', 'max'), default=(m != 'deepseek-chat'))
    elif m.startswith('gemini-'):
        mandatory = bool(re.match(r'^gemini-[34](?:[.-]|$)', m) or m.startswith('gemini-2.5-pro'))
        levels = ('low', 'high') if re.match(r'^gemini-3(?:\.1)?-pro', m) else ('low', 'medium', 'high')
        known('gemini', 'effort', levels, not mandatory)
    elif re.match(r'^(?:o[134](?:-|$)|gpt-[56](?:[.-]|$))', m):
        levels = ['low', 'medium', 'high']
        can_disable = False
        if re.match(r'^gpt-5(?:-(?:mini|nano))?(?:-\d|$)', m):
            levels.insert(0, 'minimal')
        version = re.match(r'^gpt-5\.(\d+)(?:-|$)', m)
        if version:
            can_disable = True
            if int(version[1]) >= 2:
                levels.append('xhigh')
            if int(version[1]) >= 6:
                levels.append('max')
        if m.startswith('gpt-6'):
            levels += ['xhigh', 'max']
            can_disable = bool(re.match(r'^gpt-6(?:\.1)?-(?:terra|luna)(?:-|$)|^gpt-6-sol(?:-|$)', m))
        if re.match(r'^gpt-5\.[24]-pro(?:-|$)', m):
            levels = ['medium', 'high', 'xhigh']
            can_disable = False
        if re.match(r'^gpt-5(?:\.[123])?-codex(?:-|$)', m):
            levels = ['low', 'medium', 'high']
            if re.match(r'^gpt-5\.[23]-codex|^gpt-5\.1-codex-max', m):
                levels.append('xhigh')
            can_disable = False
        if m.startswith('gpt-5-pro'):
            levels = ['high']
            can_disable = False
        known('openai_reasoning', 'effort', levels, can_disable, token_field='max_completion_tokens')
        if version and int(version[1]) in (1, 2, 4) and can_disable:
            result['default_thinking'] = False
        if m.startswith(('o1-mini', 'o1-preview', 'gpt-5-chat')):
            result.update(protocol='omit', options=['omit'], can_disable=False)
        if m.startswith('gpt-5-chat'):
            result['default_thinking'] = False
    else:
        for family in ('kimi', 'glm', 'deepseek', 'qwen', 'minimax'):
            if family in m:
                result['family'] = family
                break
    return result


def _nearest_thinking_mode(desired, cap):
    """Map an incompatible thinking mode to the closest option supported by a fallback model."""
    options = cap['options']
    preferences = {
        'disabled': ('disabled', 'minimal', 'low', 'omit', 'enabled'),
        'minimal': ('minimal', 'low', 'enabled', 'medium', 'omit'),
        'low': ('low', 'minimal', 'enabled', 'medium', 'omit'),
        'medium': ('medium', 'high', 'low', 'enabled', 'omit'),
        'high': ('high', 'medium', 'max', 'enabled', 'omit'),
        'xhigh': ('xhigh', 'max', 'high', 'enabled', 'omit'),
        'max': ('max', 'xhigh', 'high', 'enabled', 'omit'),
        'enabled': ('enabled', 'medium', 'high', 'low', 'omit'),
        'omit': ('omit',),
    }.get(desired, ('enabled', 'omit'))
    for option in preferences:
        if option in options:
            return option
    return options[0]


def thinking_mode(cfg, model, override=None, allow_fallback=False):
    cap = capabilities(model, cfg.get('base_url', ''))
    mode = cfg.get('thinking', 'disabled')
    if mode not in cap['options']:
        if not allow_fallback:
            raise ValueError('%s 不支持思考参数 %s，请在 API Manager 中选择 %s。' %
                             (model, mode, ' / '.join(cap['options'])))
        mode = _nearest_thinking_mode(mode, cap)
    if mode != 'omit' and override is not None:
        candidate = (mode if mode in ACTIVE_MODES else 'enabled') if override else 'disabled'
        if candidate not in cap['options']:
            if not allow_fallback:
                raise ValueError('%s 不支持思考参数 %s，请在 API Manager 中选择 %s。' %
                                 (model, candidate, ' / '.join(cap['options'])))
            mode = _nearest_thinking_mode(candidate, cap)
        else:
            mode = candidate
    return mode, cap


def search_policy(model, base_url):
    url = urlsplit(str(base_url or ''))
    # Hosted search is performed by these providers; no client-side tool loop is needed.
    supported = ('glm' in model_id(model) and url.scheme == 'https' and (
        (url.hostname == 'open.bigmodel.cn' and url.path.rstrip('/') in ('/api/paas/v4', '/api/paas/v4/chat/completions')) or
        (url.hostname == 'api.z.ai' and url.path.rstrip('/') in ('/api/paas/v4', '/api/paas/v4/chat/completions'))))
    return {'supported': supported, 'note': '使用官方托管联网搜索。' if supported else
            '当前接口尚未接入联网搜索，请关闭此开关；不会自动改为离线回答。'}


def apply_search(payload, cfg, model=None):
    payload.pop('tools', None)
    if cfg.get('web_search'):
        policy = search_policy(model or payload.get('model') or cfg.get('model'), cfg.get('base_url', ''))
        if not policy['supported']:
            raise ValueError(policy['note'])
        payload['tools'] = [{'type': 'web_search', 'web_search': {'enable': True}}]
    return payload


def apply_token_limit(payload, cfg, model=None, limit=None):
    target = model or payload.get('model') or cfg.get('model')
    field = capabilities(target, cfg.get('base_url', ''))['token_field']
    payload.pop('max_tokens', None)
    payload.pop('max_completion_tokens', None)
    value = cfg.get('max_tokens', 0) if limit is None else limit
    if value and value > 0:
        payload[field] = int(value)
    return payload


def retryable_overload(status, code='', detail=''):
    code = str(code or '').lower()
    detail = str(detail or '').lower()
    if code in ('1308', '1113', 'insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'invalid_api_key'):
        return False
    if any(word in detail for word in ('insufficient_quota', 'insufficient balance', '额度不足', '余额不足', 'quota exhausted')):
        return False
    return status in (429, 500, 502, 503, 504)


def finish_error(reason, refusal=False, tool_calls=False):
    if reason in ('length', 'max_tokens'):
        return '输出达到 token 上限，回答未完成；请增加输出上限或降低思考档位后重试。'
    if refusal or reason in ('content_filter', 'safety'):
        return '模型拒绝回答或内容被过滤，未获得完整结果。'
    if tool_calls or reason in ('tool_calls', 'function_call'):
        return '模型返回了工具调用，但当前接口未完成工具执行；请检查联网设置。'
    if reason not in (None, '', 'stop'):
        return '模型未正常完成回答（%s），请重试。' % reason
    return ''


def text_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ''.join(p['text'] for p in content if isinstance(p, dict) and isinstance(p.get('text'), str))
    return ''


def completion_text(data, allow_empty=False):
    try:
        choice = data['choices'][0]
        message = choice['message']
        if not isinstance(message, dict):
            raise TypeError()
    except (KeyError, IndexError, TypeError):
        raise ValueError('模型响应格式异常：缺少回答正文。') from None
    error = finish_error(choice.get('finish_reason'), message.get('refusal'), message.get('tool_calls'))
    if error:
        raise ValueError(error)
    content = message.get('content')
    text = text_content(content)
    if content is None or (not text.strip() and not allow_empty):
        raise ValueError('模型未返回正文，可能只有思考内容；请检查输出上限后重试。')
    if not isinstance(content, (str, list)) or (isinstance(content, list) and not text.strip()):
        raise ValueError('模型响应格式异常：正文不是文本。')
    return text


def history_for_model(messages, model, base_url=''):
    retain = capabilities(model, base_url)['retain_reasoning']
    result = []
    for original in messages:
        message = {k: v for k, v in original.items() if k not in ('_reader_model', 'reasoning_content')}
        source = original.get('_reader_model')
        if retain and (not source or model_id(source) == model_id(model)) and isinstance(original.get('reasoning_content'), str):
            message['reasoning_content'] = original['reasoning_content']
        result.append(message)
    return result
