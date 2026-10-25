"""Resolve Bilibili episodes for the reader's native video player."""
import json
import re
import urllib.error
import urllib.request
from urllib.parse import parse_qs, unquote, urlencode, urlsplit
from app.services import bilibili_service


_PAGE_HOSTS = {'www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'player.bilibili.com'}
_REMOTE_HOSTS = _PAGE_HOSTS | {'api.bilibili.com', 'b23.tv'}
_MAX_RESPONSE = 2 * 1024 * 1024


def _web_url(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise ValueError('请输入有效的视频网址')
    value = value.strip()
    parts = urlsplit(value)
    if (parts.scheme not in ('http', 'https') or not parts.hostname
            or parts.username is not None or parts.password is not None
            or any(ord(c) < 32 for c in value) or '\\' in value):
        raise ValueError('请输入完整的 http:// 或 https:// 视频网址')
    # Accessing port also validates malformed ports.
    parts.port
    return value, parts


def _remote_url(value):
    _, parts = _web_url(value)
    if parts.hostname not in _REMOTE_HOSTS or parts.port not in (None, 80, 443):
        raise ValueError('B 站链接跳转到了不支持的地址，请使用完整的视频页网址')


class _BilibiliRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _remote_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch(url, json_body=True):
    _remote_url(url)
    if json_body:
        return bilibili_service.fetch_api(url)
    request = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/',
        'Accept': 'application/json' if json_body else 'text/html',
    })
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), _BilibiliRedirects()).open(request, timeout=12) as response:
        _remote_url(response.url)
        if not json_body:
            return response.url
        body = response.read(_MAX_RESPONSE + 1)
        if len(body) > _MAX_RESPONSE:
            raise ValueError('视频列表过大，请打开具体视频页')
        return json.loads(body)


def _positive(value, default=1):
    try:
        number = int(value)
        return number if number > 0 else default
    except (TypeError, ValueError):
        return default


def _entry(bvid, aid, cid, page, title):
    identity = {'bvid': bvid} if re.fullmatch(r'BV[0-9A-Za-z]{10}', str(bvid or '')) else {'aid': _positive(aid, 0)}
    if not identity.get('bvid') and not identity.get('aid'):
        return None
    page = _positive(page)
    params = dict(identity, p=page, autoplay=1, danmaku=0)
    if _positive(cid, 0):
        params['cid'] = _positive(cid)
    video_id = identity.get('bvid') or 'av' + str(identity['aid'])
    return {
        'kind': 'bilibili', 'name': str(title or '第 %d 集' % page),
        **identity, 'cid': _positive(cid, 0), 'page': page,
        'url': 'https://player.bilibili.com/player.html?' + urlencode(params),
        'pageUrl': 'https://www.bilibili.com/video/' + video_id + '/?' + urlencode({'p': page}),
    }


def resolve(value):
    url, parts = _web_url(value)
    if parts.hostname == 'b23.tv':
        url = _fetch(url, json_body=False)
        url, parts = _web_url(url)
    if parts.hostname not in _PAGE_HOSTS:
        if re.search(r'\.(mp4|webm|m4v|mov|ogv)$', parts.path, re.I):
            return {'ok': True, 'videos': [{'name': unquote(parts.path.rsplit('/', 1)[-1]),
                                           'url': url, 'kind': 'direct'}], 'selected': url}
        raise ValueError('暂支持 B 站视频／分 P／合集，以及 MP4、WebM 等视频直链')
    query = parse_qs(parts.query)
    match = re.fullmatch(r'/video/(BV[0-9A-Za-z]{10}|av\d+)/?', parts.path)
    video_id = match[1] if match else ''
    if parts.hostname == 'player.bilibili.com' and parts.path == '/player.html':
        video_id = query.get('bvid', [''])[0] or 'av' + query.get('aid', [''])[0]
    if not re.fullmatch(r'BV[0-9A-Za-z]{10}|av\d+', video_id):
        raise ValueError('请粘贴 B 站具体视频页（含 BV 或 av 编号）的链接')
    requested_page = _positive(query.get('p', [1])[0])
    identity = {'bvid': video_id} if video_id.startswith('BV') else {'aid': video_id[2:]}
    doc = _fetch('https://api.bilibili.com/x/web-interface/view?' + urlencode(identity))
    if not isinstance(doc, dict) or doc.get('code') != 0 or not isinstance(doc.get('data'), dict):
        raise ValueError('无法读取 B 站视频：视频可能不可用，或网站暂时限制访问，请稍后重试')
    data = doc['data']
    pages = data.get('pages') or []
    if not isinstance(pages, list) or not pages or not all(isinstance(page, dict) for page in pages):
        raise ValueError('这个视频没有可播放的分集')
    if requested_page > len(pages):
        raise ValueError('网址指定的分 P 不存在（共 %d 集）' % len(pages))
    videos = []
    for page in pages:
        item = _entry(data.get('bvid'), data.get('aid'), page.get('cid'), page.get('page'),
                      page.get('part') if len(pages) > 1 else data.get('title'))
        if item:
            videos.append(item)
    if not videos:
        raise ValueError('无法识别视频编号')
    selected = videos[requested_page - 1]['url']
    # A multi-part course is already a complete series. Otherwise use its collection.
    if len(pages) == 1:
        collection = []
        seen = set()
        for section in (data.get('ugc_season') or {}).get('sections') or []:
            for episode in section.get('episodes') or []:
                page = episode.get('page') or {}
                item = _entry(episode.get('bvid'), episode.get('aid'),
                              episode.get('cid') or page.get('cid'), 1, episode.get('title'))
                if item and item['pageUrl'] not in seen:
                    seen.add(item['pageUrl'])
                    # Use the fully resolved current episode (including cid).
                    collection.append(videos[0] if item['pageUrl'] == videos[0]['pageUrl'] else item)
        if any(item['url'] == selected for item in collection):
            videos = collection
    return {'ok': True, 'videos': videos, 'selected': selected, 'title': data.get('title', '')}


def handle_resolve(handler):
    try:
        length = int(handler.headers.get('Content-Length', 0))
        if not 0 < length <= 8192:
            raise ValueError('请求为空或过长')
        data = json.loads(handler.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError('请求必须为 JSON 对象')
        result = resolve(data.get('url'))
    except (ValueError, TypeError) as exc:
        handler._json_response(400, {'ok': False, 'error': str(exc)})
        return
    except (urllib.error.URLError, OSError, TimeoutError):
        handler._json_response(502, {'ok': False, 'error': '暂时无法连接 B 站，请检查网络后重试'})
        return
    handler._json_response(200, result)
