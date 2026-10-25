"""Cloud annotation sync service for GitHub and Gitee."""
import base64
import concurrent.futures
import datetime
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

CLOUD_SYNC = {
    'enabled': False,
    'provider': 'github',
    'owner': '',
    'repo': '',
    'token': '',
    'branch': '',
    'dir': 'annotations',
    'mirror_paths': False,
    'device': '',
    'proxy': 'system',
    'timeout': 20,
    'api_base': '',
}

_CLOUD_WRITE_LOCK = threading.Lock()
_CLOUD_CACHE_LOCK = threading.Lock()
_CLOUD_LIST_CACHE = {}
_CLOUD_LIST_TTL = 20
_CLOUD_BRANCH_CACHE = {}
_CLOUD_CONTENTS_LIMIT = 900 * 1024
_CLOUD_ILLEGAL_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_CLOUD_RESERVED = {
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
}


def _cloud_config():
    """读取云端配置：内置 CLOUD_SYNC，可被 cloud_config.json 逐项覆盖。"""
    # Allow test mocks patching server.CLOUD_SYNC
    server_mod = sys.modules.get('server')
    base_defaults = getattr(server_mod, 'CLOUD_SYNC', CLOUD_SYNC)
    cfg = dict(base_defaults)
    override = os.environ.get('PDF_READER_CLOUD_CONFIG') or os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'cloud_config.json')
    if not os.path.isfile(override):
        override_alt = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cloud_config.json')
        if os.path.isfile(override_alt):
            override = override_alt
    if os.path.isfile(override):
        try:
            with open(override, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                for key, value in data.items():
                    if key in cfg:
                        cfg[key] = value
        except Exception as e:
            print(f"[云端批注库] {os.path.basename(override)} 解析失败，继续使用内置配置：{e}")
    cfg['enabled'] = bool(cfg.get('enabled'))
    cfg['provider'] = str(cfg.get('provider') or 'github').strip().lower()
    if cfg['provider'] not in ('github', 'gitee'):
        print(f"[云端批注库] 未知 provider={cfg['provider']}，按 github 处理")
        cfg['provider'] = 'github'
    for key in ('owner', 'repo', 'token', 'branch', 'device', 'dir'):
        cfg[key] = str(cfg.get(key) or '').strip()
    cfg['dir'] = cfg['dir'].strip('/ ').replace('\\', '/')
    cfg['mirror_paths'] = bool(cfg.get('mirror_paths'))
    if not cfg['device']:
        cfg['device'] = os.environ.get('COMPUTERNAME') or os.environ.get('HOSTNAME') or 'unknown-device'
    try:
        cfg['timeout'] = max(5, min(120, int(cfg.get('timeout') or 20)))
    except Exception:
        cfg['timeout'] = 20
    return cfg


def _cloud_is_configured(cfg):
    return bool(cfg.get('enabled') and cfg.get('owner') and cfg.get('repo') and cfg.get('token'))


def _cloud_opener(cfg):
    """按配置建立连接方式：直连 / 跟随系统代理 / 指定代理。"""
    mode = str(cfg.get('proxy') or '').strip()
    lowered = mode.lower()
    if lowered in ('', 'none', 'off', 'direct'):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    if lowered in ('system', 'auto', 'env'):
        return urllib.request.build_opener()
    return urllib.request.build_opener(urllib.request.ProxyHandler({'http': mode, 'https': mode}))


def _cloud_message(data, fallback=''):
    """从上游错误体里取一句人能看懂的话。"""
    if isinstance(data, dict):
        error = data.get('error')
        if isinstance(error, dict) and error.get('message'):
            return str(error['message']).strip()
        for key in ('message', 'error_description', 'error'):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(data, str) and data.strip():
        return data.strip()[:300]
    return fallback


def _cloud_friendly(status, data):
    """把云端 HTTP 错误翻译成能直接照做的提示。"""
    message = _cloud_message(data)
    if status == 401:
        hint = '令牌无效或已过期'
    elif status == 403:
        hint = '权限不足（GitHub 需要 Contents: Read and write；Gitee 需要 projects 权限）'
    elif status == 404:
        hint = '仓库不存在或令牌没有该私有仓库的访问权限'
    elif status in (409, 422):
        hint = '云端文件已被其它设备改动，稍后重试即可'
    elif status == 451:
        hint = '该请求被网络策略拦截（GitHub 在国内常需在 cloud_config.json 里配置代理）'
    elif status >= 500:
        hint = '云端服务暂时不可用'
    else:
        hint = '云端请求失败'
    return '%s（HTTP %s）%s' % (hint, status, ('：' + message) if message else '')


def _repair_surrogates(text):
    """修掉字符串里落单的代理项，返回 (修好的字符串, 修掉几个字符)。"""
    if not any(0xD800 <= ord(ch) <= 0xDFFF for ch in text):
        return text, 0
    out = []
    repaired = 0
    index = 0
    while index < len(text):
        code = ord(text[index])
        if 0xD800 <= code <= 0xDBFF and index + 1 < len(text):
            low = ord(text[index + 1])
            if 0xDC00 <= low <= 0xDFFF:
                out.append(chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)))
                index += 2
                continue
        if 0xD800 <= code <= 0xDFFF:
            out.append('\ufffd')
            repaired += 1
        else:
            out.append(text[index])
        index += 1
    return ''.join(out), repaired


def _utf8_safe(value):
    """递归清洗 JSON 结构里的落单代理项，返回 (清洗后的值, 一共修掉几个)。"""
    if isinstance(value, str):
        return _repair_surrogates(value)
    if isinstance(value, dict):
        clean = {}
        repaired = 0
        for key, item in value.items():
            if isinstance(key, str):
                key, key_repaired = _repair_surrogates(key)
                repaired += key_repaired
            item, item_repaired = _utf8_safe(item)
            clean[key] = item
            repaired += item_repaired
        return clean, repaired
    if isinstance(value, (list, tuple)):
        clean = []
        repaired = 0
        for item in value:
            item, item_repaired = _utf8_safe(item)
            clean.append(item)
            repaired += item_repaired
        return clean, repaired
    return value, 0


def _cloud_request(cfg, method, path, query=None, body=None):
    """向 GitHub / Gitee 发一次请求，返回 (status, 已解析的 JSON 或原始文本)。"""
    provider = cfg['provider']
    query = dict(query or {})
    if provider == 'gitee':
        base = (cfg.get('api_base') or 'https://gitee.com/api/v5').rstrip('/')
        headers = {'User-Agent': 'PDFReaderPro', 'Content-Type': 'application/json;charset=UTF-8'}
        if cfg.get('token'):
            query['access_token'] = cfg['token']
    else:
        base = (cfg.get('api_base') or 'https://api.github.com').rstrip('/')
        headers = {
            'User-Agent': 'PDFReaderPro',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json;charset=UTF-8',
        }
        if cfg.get('token'):
            headers['Authorization'] = 'Bearer ' + cfg['token']

    url = base + path
    if query:
        url += ('&' if '?' in url else '?') + urllib.parse.urlencode(query)
    if body is not None:
        safe_body, _ = _utf8_safe(body)
        payload = json.dumps(safe_body, ensure_ascii=False).encode('utf-8')
    else:
        payload = None
    request = urllib.request.Request(url, data=payload, headers=headers, method=method)
    opener = _cloud_opener(cfg)
    try:
        with opener.open(request, timeout=cfg.get('timeout', 20)) as response:
            status = response.status
            raw = response.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            raw = e.read().decode('utf-8', errors='replace')
        except Exception:
            raw = ''
    except Exception as e:
        raise RuntimeError(f'连不上云端（{e}）；GitHub 在国内通常需要在 cloud_config.json 里把 proxy 指到你的代理')
    parsed = None
    if raw:
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw
    return status, parsed


def _cloud_branch(cfg):
    """取仓库默认分支。"""
    branch = str(cfg.get('branch') or '').strip()
    if branch:
        return branch
    cache_key = (cfg['provider'], cfg['owner'], cfg['repo'])
    with _CLOUD_CACHE_LOCK:
        cached = _CLOUD_BRANCH_CACHE.get(cache_key)
    if cached:
        return cached
    status, data = _cloud_request(cfg, 'GET', f"/repos/{cfg['owner']}/{cfg['repo']}")
    if status != 200 or not isinstance(data, dict):
        raise RuntimeError(_cloud_friendly(status, data))
    branch = str(data.get('default_branch') or '').strip()
    if not branch:
        branch = 'master' if cfg['provider'] == 'gitee' else 'main'
    with _CLOUD_CACHE_LOCK:
        _CLOUD_BRANCH_CACHE[cache_key] = branch
    return branch


def _cloud_api_path(cfg, suffix):
    return f"/repos/{cfg['owner']}/{cfg['repo']}{suffix}"


def _cloud_quote(path):
    return urllib.parse.quote(path)


def _cloud_sanitize(text, limit=120):
    """清洗文件名/文件夹名。"""
    name = _CLOUD_ILLEGAL_RE.sub('_', str(text or ''))
    name = re.sub(r'\s+', ' ', name).strip().strip('.')
    if len(name) > limit:
        name = name[:limit].rstrip()
    if name.split('.')[0].lower() in _CLOUD_RESERVED:
        name = '_' + name
    return name or 'document'


def _cloud_base_filename(name, suffix=''):
    """按 PDF 名字派生批注文件名。"""
    stem = re.sub(r'\.[^.]*$', '', str(name or ''))
    stem = _cloud_sanitize(stem)
    if suffix:
        stem = f'{stem}__{suffix}'
    return stem + '_annotations.json'


def _cloud_rel_dir(cfg, local_path):
    """mirror_paths 打开时，按 PDF 所在的上一级文件夹名归档。"""
    if not cfg.get('mirror_paths') or not local_path:
        return ''
    folder = os.path.basename(os.path.dirname(os.path.normpath(str(local_path))))
    folder = _cloud_sanitize(folder, 60)
    return '' if folder in ('', '.', '..') else folder


def _cloud_key(cfg, name, local_path=None, suffix=''):
    """云端文件路径。"""
    parts = [p for p in (cfg.get('dir') or '', _cloud_rel_dir(cfg, local_path)) if p]
    parts.append(_cloud_base_filename(name, suffix))
    return '/'.join(parts)


def _cloud_get_file(cfg, file_path):
    """读取一个云端文件；不存在返回 None。"""
    api = _cloud_api_path(cfg, '/contents/' + _cloud_quote(file_path))
    status, data = _cloud_request(cfg, 'GET', api, query={'ref': _cloud_branch(cfg)})
    if status == 404:
        return None
    if status != 200:
        raise RuntimeError(_cloud_friendly(status, data))
    if isinstance(data, list):
        raise RuntimeError(f'云端已存在同名目录，无法作为文件写入：{file_path}')
    content = ''
    if isinstance(data, dict) and data.get('content'):
        try:
            content = base64.b64decode(re.sub(r'\s+', '', data['content']))
        except Exception:
            content = b''
    document = None
    if content:
        try:
            document = json.loads(content.decode('utf-8'))
        except Exception:
            document = None
    return {
        'sha': (data or {}).get('sha'),
        'bytes': content,
        'json': document,
        'size': (data or {}).get('size') or len(content or b''),
    }


def _cloud_entry_meta(item):
    """把目录列表里的一个条目变成前端要用的元信息。"""
    document = None
    if isinstance(item, dict) and item.get('content'):
        try:
            raw = base64.b64decode(re.sub(r'\s+', '', item['content']))
            document = json.loads(raw.decode('utf-8'))
        except Exception:
            document = None
    document = document if isinstance(document, dict) else {}
    return {
        'key': item.get('path'),
        'name': item.get('name'),
        'size': item.get('size'),
        'sha': item.get('sha'),
        'timestamp': document.get('timestamp'),
        'device': document.get('device'),
        'fileName': document.get('fileName'),
        'fingerprint': document.get('fingerprint'),
        'sourcePath': document.get('sourcePath'),
        'count': _cloud_count_annotations(document.get('annotations')),
        'readable': bool(document),
    }


def _cloud_hydrate_entry(cfg, entry):
    """给缺元信息的条目补一次单文件请求。"""
    if not isinstance(entry, dict) or entry.get('readable') or not entry.get('key'):
        return entry
    try:
        existing = _cloud_get_file(cfg, entry['key'])
    except Exception:
        return entry
    document = (existing or {}).get('json')
    if not isinstance(document, dict):
        return entry
    return {
        **entry,
        'timestamp': document.get('timestamp'),
        'device': document.get('device'),
        'fileName': document.get('fileName'),
        'fingerprint': document.get('fingerprint'),
        'sourcePath': document.get('sourcePath'),
        'count': _cloud_count_annotations(document.get('annotations')),
        'size': entry.get('size') or (existing or {}).get('size'),
        'readable': True,
    }


def _cloud_hydrate_entries(cfg, entries, limit=8, workers=4):
    """并发补全若干条目的元信息。"""
    todo = [e for e in entries if isinstance(e, dict) and not e.get('readable') and e.get('key')]
    todo = todo[:max(0, limit)]
    if not todo:
        return []
    workers = max(1, min(workers, len(todo)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for entry, hydrated in zip(todo, pool.map(lambda item: _cloud_hydrate_entry(cfg, item), todo)):
            entry.update(hydrated)
    return todo


def _cloud_list_files(cfg, refresh=False, directory=None, depth=1):
    """列出批注目录下的 .json 文件。"""
    if directory is None:
        directory = cfg.get('dir') or ''
    now = time.time()
    cache_key = (cfg['provider'], cfg['owner'], cfg['repo'], directory)
    if not refresh:
        with _CLOUD_CACHE_LOCK:
            cached = _CLOUD_LIST_CACHE.get(cache_key)
            if cached and now - cached[0] < _CLOUD_LIST_TTL:
                return [dict(item) for item in cached[1]]
    api = _cloud_api_path(cfg, '/contents' + ('/' + _cloud_quote(directory) if directory else ''))
    status, data = _cloud_request(cfg, 'GET', api, query={'ref': _cloud_branch(cfg)})
    if status == 404:
        items = []
    elif status != 200:
        raise RuntimeError(_cloud_friendly(status, data))
    elif isinstance(data, dict):
        items = [data]
    else:
        items = [i for i in (data or []) if isinstance(i, dict)]

    files, dirs = [], []
    for item in items:
        if item.get('type') == 'file' and str(item.get('name') or '').lower().endswith('.json'):
            files.append(_cloud_entry_meta(item))
        elif item.get('type') == 'dir':
            dirs.append(str(item.get('path') or item.get('name') or ''))
    if depth > 0:
        for sub in dirs[:10]:
            try:
                files.extend(_cloud_list_files(cfg, refresh=refresh, directory=sub, depth=depth - 1))
            except Exception:
                continue
    timed = sorted([f for f in files if f.get('timestamp')], key=lambda f: str(f['timestamp']), reverse=True)
    untimed = sorted([f for f in files if not f.get('timestamp')], key=lambda f: str(f.get('name') or '').lower())
    files = timed + untimed
    with _CLOUD_CACHE_LOCK:
        _CLOUD_LIST_CACHE[cache_key] = (now, [dict(item) for item in files])
    return [dict(item) for item in files]


def _cloud_put_file(cfg, file_path, content_bytes, message, sha=None):
    """Contents API 覆盖写入。"""
    if len(content_bytes) > _CLOUD_CONTENTS_LIMIT and cfg['provider'] == 'github':
        return _cloud_put_file_large(cfg, file_path, content_bytes, message)
    api = _cloud_api_path(cfg, '/contents/' + _cloud_quote(file_path))
    body = {
        'message': message,
        'content': base64.b64encode(content_bytes).decode('ascii'),
        'branch': _cloud_branch(cfg),
    }
    if sha:
        body['sha'] = sha
    method = 'POST' if (not sha and cfg['provider'] == 'gitee') else 'PUT'
    status, data = _cloud_request(cfg, method, api, body=body)
    if status not in (200, 201):
        existing = None
        try:
            existing = _cloud_get_file(cfg, file_path)
        except Exception:
            existing = None
        if existing and existing.get('sha') and existing.get('sha') != sha:
            body['sha'] = existing['sha']
            status, data = _cloud_request(cfg, 'PUT', api, body=body)
    if status not in (200, 201):
        raise RuntimeError(_cloud_friendly(status, data))
    return data


def _cloud_put_file_large(cfg, file_path, content_bytes, message):
    """大文件走 Git Data API。"""
    status, blob = _cloud_request(cfg, 'POST', _cloud_api_path(cfg, '/git/blobs'), body={
        'content': base64.b64encode(content_bytes).decode('ascii'),
        'encoding': 'base64',
    })
    if status not in (200, 201) or not isinstance(blob, dict) or not blob.get('sha'):
        raise RuntimeError(_cloud_friendly(status, blob))

    branch = _cloud_branch(cfg)
    status, ref = _cloud_request(cfg, 'GET', _cloud_api_path(cfg, '/git/ref/heads/' + _cloud_quote(branch)))
    parent_sha, base_tree = None, None
    if status == 200 and isinstance(ref, dict):
        parent_sha = (ref.get('object') or {}).get('sha')
    elif status not in (404, 409):
        raise RuntimeError(_cloud_friendly(status, ref))
    if parent_sha:
        status, commit = _cloud_request(cfg, 'GET', _cloud_api_path(cfg, '/git/commits/' + parent_sha))
        if status == 200 and isinstance(commit, dict):
            base_tree = (commit.get('tree') or {}).get('sha')
        if not base_tree:
            raise RuntimeError('拿不到云端目录树（base_tree），为避免覆盖仓库里的其它文件，本次大文件写入已放弃；稍后重试即可')

    tree_body = {'tree': [{'path': file_path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']}]}
    if base_tree:
        tree_body['base_tree'] = base_tree
    status, tree = _cloud_request(cfg, 'POST', _cloud_api_path(cfg, '/git/trees'), body=tree_body)
    if status not in (200, 201) or not isinstance(tree, dict) or not tree.get('sha'):
        raise RuntimeError(_cloud_friendly(status, tree))

    commit_body = {'message': message, 'tree': tree['sha'], 'parents': [parent_sha] if parent_sha else []}
    status, new_commit = _cloud_request(cfg, 'POST', _cloud_api_path(cfg, '/git/commits'), body=commit_body)
    if status not in (200, 201) or not isinstance(new_commit, dict) or not new_commit.get('sha'):
        raise RuntimeError(_cloud_friendly(status, new_commit))

    if parent_sha:
        status, updated = _cloud_request(cfg, 'PATCH', _cloud_api_path(cfg, '/git/refs/heads/' + _cloud_quote(branch)),
                                         body={'sha': new_commit['sha'], 'force': False})
    else:
        status, updated = _cloud_request(cfg, 'POST', _cloud_api_path(cfg, '/git/refs'),
                                         body={'ref': 'refs/heads/' + branch, 'sha': new_commit['sha']})
    if status not in (200, 201):
        raise RuntimeError(_cloud_friendly(status, updated))
    return {'content': {'path': file_path, 'sha': blob['sha']}, 'commit': {'sha': new_commit['sha']}}


def _cloud_now_iso():
    now = datetime.datetime.now(datetime.timezone.utc)
    return now.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (now.microsecond // 1000)


def _cloud_count_annotations(annotations):
    total = 0
    if isinstance(annotations, dict):
        for key, value in annotations.items():
            if str(key).isdigit() and isinstance(value, list):
                total += len(value)
    return total


def _cloud_save(cfg, name, fingerprint, local_path, annotations):
    """覆盖更新云端批注文件。"""
    if not _cloud_is_configured(cfg):
        raise RuntimeError('云端批注库尚未配置（见 server.py 顶部的 CLOUD_SYNC）')
    if not name:
        raise RuntimeError('缺少 PDF 文件名，无法派生云端文件名')

    document = {
        'app': 'PDFReaderPro',
        'version': '5.0.0',
        'fingerprint': fingerprint or '',
        'fileName': name,
        'sourcePath': local_path or '',
        'device': cfg['device'],
        'timestamp': _cloud_now_iso(),
        'annotations': annotations if isinstance(annotations, dict) else {},
    }
    safe_document, repaired = _utf8_safe(document)
    if repaired:
        print(f"[云端批注库] 批注里有 {repaired} 个被截断的半个字符，已替换为  后继续上传")
    payload = json.dumps(safe_document, ensure_ascii=False, indent=2).encode('utf-8')
    count = _cloud_count_annotations(document['annotations'])
    message = f"批注更新：{name}（{count} 条 · {cfg['device']}）"

    with _CLOUD_WRITE_LOCK:
        key = _cloud_key(cfg, name, local_path)
        suffix = ''
        existing = _cloud_get_file(cfg, key)
        remote_fingerprint = ''
        if existing and isinstance(existing.get('json'), dict):
            remote_fingerprint = str(existing['json'].get('fingerprint') or '')
        if existing and remote_fingerprint and fingerprint and remote_fingerprint != fingerprint:
            suffix = _cloud_sanitize(str(fingerprint)[:8], 8) or 'other'
            key = _cloud_key(cfg, name, local_path, suffix=suffix)
            existing = _cloud_get_file(cfg, key)
        created = existing is None
        result = _cloud_put_file(cfg, key, payload, message, sha=existing.get('sha') if existing else None)
    with _CLOUD_CACHE_LOCK:
        _CLOUD_LIST_CACHE.pop((cfg['provider'], cfg['owner'], cfg['repo'], cfg.get('dir') or ''), None)
    return {
        'key': key,
        'renamed': bool(suffix),
        'created': created,
        'commit': ((result or {}).get('commit') or {}).get('sha'),
        'size': len(payload),
        'count': count,
        'timestamp': document['timestamp'],
    }


def _cloud_status(cfg, name, fingerprint, local_path):
    """查询云端是否有这份文档的批注、是否比本地新。"""
    expected = _cloud_key(cfg, name, local_path)
    files = _cloud_list_files(cfg)

    exact = None
    for item in files:
        if item.get('key') == expected:
            exact = _cloud_hydrate_entry(cfg, item)
            break

    match = None
    if exact is not None:
        if not fingerprint or exact.get('fingerprint') == fingerprint:
            match = exact
        elif any(item.get('fingerprint') == fingerprint for item in files):
            match = next(item for item in files if item.get('fingerprint') == fingerprint)

    if match is None:
        stem = _cloud_base_filename(name)[:-len('_annotations.json')]
        for item in files:
            key = str(item.get('key') or '')
            if key == expected or not key.rsplit('/', 1)[-1].startswith(stem + '__'):
                continue
            if not key.endswith('_annotations.json'):
                continue
            item = _cloud_hydrate_entry(cfg, item)
            if not fingerprint or item.get('fingerprint') == fingerprint:
                match = item
                break

    if match is None and exact is not None:
        match = exact
    return {
        'expectedKey': expected,
        'exists': bool(match),
        'key': (match or {}).get('key') or expected,
        'matchesFingerprint': bool(match) and (not fingerprint or match.get('fingerprint') == fingerprint),
        'remote': match,
        'total': len(files),
    }


def _cloud_test(cfg):
    """连通性自检。"""
    if not _cloud_is_configured(cfg):
        raise RuntimeError('尚未配置：请填写 owner / repo / token 并把 enabled 改成 True')
    status, repo = _cloud_request(cfg, 'GET', _cloud_api_path(cfg, ''))
    if status != 200 or not isinstance(repo, dict):
        raise RuntimeError(_cloud_friendly(status, repo))
    files = _cloud_list_files(cfg, refresh=True)
    return {
        'provider': cfg['provider'],
        'repo': repo.get('full_name') or f"{cfg['owner']}/{cfg['repo']}",
        'private': bool(repo.get('private')),
        'branch': _cloud_branch(cfg),
        'dir': cfg.get('dir') or '(仓库根目录)',
        'device': cfg['device'],
        'count': len(files),
    }


# High-level route handlers
def handle_cloud_status(cfg, query):
    first = lambda key, default='': (query.get(key) or [default])[0]
    base = {
        'ok': True,
        'configured': True,
        'provider': cfg.get('provider'),
        'device': cfg.get('device'),
        'directory': cfg.get('dir'),
    }
    if first('local') in ('1', 'true', 'yes'):
        return {**base, 'local': True, 'reachable': None}
    name = first('name')
    fingerprint = first('fingerprint')
    local_path = first('path')
    try:
        info = _cloud_status(cfg, name, fingerprint, local_path)
    except Exception as e:
        print(f"[云端批注库] 连不上云端: {e}")
        return {**base, 'ok': False, 'reachable': False, 'error': str(e)}
    info.update(base)
    info['reachable'] = True
    return info


def handle_cloud_list(cfg, query):
    first = lambda key, default='': (query.get(key) or [default])[0]
    refresh = first('refresh') in ('1', 'true', 'yes')
    files = _cloud_list_files(cfg, refresh=refresh)
    return {
        'ok': True,
        'configured': True,
        'provider': cfg.get('provider'),
        'device': cfg.get('device'),
        'directory': cfg.get('dir') or '(仓库根目录)',
        'files': files,
    }


def handle_cloud_meta(cfg, query):
    wanted = []
    for chunk in (query.get('keys') or []):
        wanted.extend(part for part in chunk.split(',') if part)
    wanted = [k for k in wanted if k.lower().endswith('.json') and '..' not in k][:8]
    if not wanted:
        return {'status': 400, 'ok': False, 'error': '缺少 keys（云端文件路径）'}
    index = {f.get('key'): f for f in _cloud_list_files(cfg)}
    entries = []
    for key in wanted:
        entry = index.get(key)
        if entry is None:
            entry = {'key': key, 'name': key.rsplit('/', 1)[-1], 'size': 0,
                     'sha': None, 'timestamp': None, 'device': None, 'fileName': None,
                     'fingerprint': None, 'sourcePath': None, 'count': 0, 'readable': False}
        entries.append(entry)
    _cloud_hydrate_entries(cfg, entries, limit=8, workers=4)
    return {'ok': True, 'entries': entries}


def handle_cloud_pull(cfg, query):
    first = lambda key, default='': (query.get(key) or [default])[0]
    key = first('key')
    if not key:
        return {'status': 400, 'ok': False, 'error': '缺少 key（云端文件路径）'}
    if not key.lower().endswith('.json') or '..' in key:
        return {'status': 400, 'ok': False, 'error': '非法的云端文件路径'}
    existing = _cloud_get_file(cfg, key)
    if not existing or not isinstance(existing.get('json'), dict):
        return {'status': 404, 'ok': False, 'error': '云端没有这个批注文件，或内容不是合法 JSON'}
    return {'ok': True, 'key': key, 'document': existing['json']}


def handle_cloud_save(cfg, payload):
    name = str(payload.get('name') or '').strip()
    annotations = payload.get('annotations')
    if not name or not isinstance(annotations, dict):
        return {'status': 400, 'ok': False, 'error': '缺少 name 或 annotations'}
    result = _cloud_save(
        cfg,
        name=name,
        fingerprint=str(payload.get('fingerprint') or ''),
        local_path=str(payload.get('localPath') or ''),
        annotations=annotations,
    )
    print(f"[云端批注库] {cfg['provider']} ← {result['key']}（{result['count']} 条 · {result['size']} bytes）")
    return {
        'ok': True,
        'configured': True,
        'provider': cfg.get('provider'),
        'device': cfg.get('device'),
        **result,
    }


def handle_cloud_test(cfg):
    info = _cloud_test(cfg)
    return {'ok': True, 'configured': True, **info}
