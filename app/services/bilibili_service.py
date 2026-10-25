"""Bilibili QR authentication and same-origin MP4 / DASH playback."""
import base64
import ctypes
import http.cookiejar
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections import OrderedDict
from urllib.parse import parse_qs, urlencode, urlsplit

SESSION_FILE = Path(__file__).resolve().parents[2] / '.api-manager' / 'bilibili-session.json'
_lock = threading.RLock()
_jar = None
_qr = {}
_streams = OrderedDict()
_revision = 0
_HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/'}
_LABELS = {80: '1080P', 64: '720P', 32: '480P', 16: '360P'}


def _protect(data, decrypt=False):
    """Windows login cookies are encrypted for the current OS account."""
    if os.name != 'nt':
        return data
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_byte))]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    target = Blob()
    method = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not method(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise OSError('无法读取或保存本机 B 站登录状态')
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.windll.kernel32.LocalFree(ctypes.cast(target.data, ctypes.c_void_p))


def _cookies():
    global _jar
    with _lock:
        if _jar is None:
            _jar = http.cookiejar.CookieJar()
            try:
                payload = json.loads(SESSION_FILE.read_text(encoding='utf-8'))
                rows = json.loads(_protect(base64.b64decode(payload['data']), decrypt=True))
                for row in rows:
                    if row.get('domain', '').lstrip('.') != 'bilibili.com':
                        continue
                    cookie = http.cookiejar.Cookie(**row)
                    if not cookie.is_expired():
                        _jar.set_cookie(cookie)
            except (OSError, ValueError, KeyError, TypeError):
                pass
        return _jar


def _save_cookies():
    fields = ('version', 'name', 'value', 'port', 'port_specified', 'domain', 'domain_specified',
              'domain_initial_dot', 'path', 'path_specified', 'secure', 'expires', 'discard', 'comment', 'comment_url')
    rows = []
    for cookie in _cookies():
        if cookie.domain.lstrip('.') == 'bilibili.com' and not cookie.is_expired():
            row = {key: getattr(cookie, key) for key in fields}
            row['rest'] = {}
            rows.append(row)
    data = _protect(json.dumps(rows).encode())
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = SESSION_FILE.with_suffix('.tmp')
    try:
        with open(temporary, 'w', encoding='utf-8') as output:
            if os.name != 'nt':
                os.chmod(temporary, 0o600)
            json.dump({'data': base64.b64encode(data).decode()}, output)
        os.replace(temporary, SESSION_FILE)
    finally:
        temporary.unlink(missing_ok=True)


def _api_url(url):
    parts = urlsplit(url)
    if (parts.scheme != 'https' or parts.hostname not in ('api.bilibili.com', 'passport.bilibili.com')
            or parts.port not in (None, 443) or parts.username or parts.password):
        raise ValueError('无效的 B 站接口地址')


class _ApiRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _api_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_api(url):
    _api_url(url)
    with _lock:
        # Bilibili is reachable directly; do not inherit a stopped Clash/system proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _ApiRedirects(),
                                            urllib.request.HTTPCookieProcessor(_cookies()))
        with opener.open(urllib.request.Request(url, headers=_HEADERS), timeout=15) as response:
            body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError('B 站响应过大')
        doc = json.loads(body)
        if not isinstance(doc, dict):
            raise ValueError('B 站返回了无效数据')
        return doc


def account_status():
    doc = fetch_api('https://api.bilibili.com/x/web-interface/nav')
    data = doc.get('data') or {}
    return {'ok': True, 'loggedIn': bool(data.get('isLogin')), 'name': data.get('uname', '')}


def login_start():
    from airtex import qr
    doc = fetch_api('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
    data = doc.get('data') or {}
    url = data.get('url', '')
    if doc.get('code') != 0 or not data.get('qrcode_key') or not url.startswith('https://'):
        raise ValueError('无法生成 B 站登录二维码，请稍后重试')
    image = qr.to_image(url, box=4)
    output = io.BytesIO()
    image.save(output, format='PNG')
    token = secrets.token_urlsafe(24)
    with _lock:
        now = time.monotonic()
        for old in list(_qr):
            if _qr[old][1] < now:
                _qr.pop(old, None)
        while len(_qr) >= 8:
            _qr.pop(next(iter(_qr)))
        _qr[token] = (str(data['qrcode_key']), now + 180)
    return {'ok': True, 'token': token, 'image': 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode()}


def login_poll(token):
    global _revision
    with _lock:
        pending = _qr.get(token)
        if not pending or pending[1] < time.monotonic():
            _qr.pop(token, None)
            return {'ok': True, 'state': 'expired'}
        doc = fetch_api('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?' + urlencode({'qrcode_key': pending[0]}))
        if doc.get('code') != 0:
            raise ValueError('登录状态查询失败，请重试')
        code = (doc.get('data') or {}).get('code')
        state = {0: 'success', 86038: 'expired', 86090: 'confirm', 86101: 'waiting'}.get(code)
        if state is None:
            raise ValueError('登录状态异常，请重新扫码')
        if state in ('success', 'expired'):
            _qr.pop(token, None)
        if state == 'success':
            if not any(c.name == 'SESSDATA' and not c.is_expired() for c in _cookies()):
                raise ValueError('未收到登录状态，请重新扫码')
            _save_cookies()
            _revision += 1
        return {'ok': True, 'state': state}


def logout():
    global _revision
    with _lock:
        _cookies().clear()
        _qr.clear()
        _revision += 1
        SESSION_FILE.unlink(missing_ok=True)
    return {'ok': True, 'loggedIn': False}


def _cdn_url(url):
    parts = urlsplit(url)
    host = (parts.hostname or '').lower()
    if (parts.scheme != 'https' or not any(host == d or host.endswith('.' + d) for d in ('bilivideo.com', 'bilivideo.cn', 'akamaized.net'))
            or parts.port not in (None, 443) or parts.username or parts.password):
        raise ValueError('B 站返回了不支持的视频源')


class _MediaRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _cdn_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _mp4_info(identity):
    params = dict(identity, fnval=1, fnver=0, fourk=1, high_quality=1)
    doc = fetch_api('https://api.bilibili.com/x/player/playurl?' + urlencode(params))
    data = doc.get('data') or {}
    durl = data.get('durl') or []
    if doc.get('code') != 0 or not durl:
        raise ValueError('无法播放这个视频，请确认账号有观看权限，或稍后重试')
    if len(durl) != 1 or not str(data.get('format', '')).startswith('mp4'):
        raise ValueError('这个视频暂未提供浏览器可播放的 MP4 格式')
    url = durl[0].get('url', '')
    # Some Bilibili responses still advertise HTTP CDN URLs.
    if url.startswith('http://'):
        url = 'https://' + url[7:]
    _cdn_url(url)
    return url, data


def _dash_track(raw, kind):
    url = str(raw.get('baseUrl') or raw.get('base_url') or '')
    if url.startswith('http://'):
        url = 'https://' + url[7:]
    _cdn_url(url)
    segments = raw.get('SegmentBase') or raw.get('segment_base') or {}
    initialization = str(segments.get('Initialization') or segments.get('initialization') or '')
    index = str(segments.get('indexRange') or segments.get('index_range') or '')
    for byte_range in (initialization, index):
        match = re.fullmatch(r'(\d+)-(\d+)', byte_range)
        if not match or not 0 <= int(match[1]) <= int(match[2]) < 10**8:
            raise ValueError('B 站高清流缺少有效的分段信息')
    return {'url': url, 'id': int(raw.get('id') or 0), 'codecs': str(raw['codecs']),
            'mime': kind + '/mp4', 'bandwidth': max(1, int(raw.get('bandwidth') or 1)),
            'width': int(raw.get('width') or 0), 'height': int(raw.get('height') or 0),
            'initialization': initialization, 'index': index}


def _dash_info(identity):
    params = dict(identity, fnval=16, fnver=0, fourk=1)
    doc = fetch_api('https://api.bilibili.com/x/player/playurl?' + urlencode(params))
    data = doc.get('data') or {}
    dash = data.get('dash') or {}
    videos = [v for v in dash.get('video') or [] if str(v.get('codecs', '')).startswith('avc1.')]
    if doc.get('code') != 0 or not videos:
        raise ValueError('这个视频暂未提供浏览器可用的高清流')
    candidates = [v for v in videos if int(v.get('id') or 0) <= identity['qn']]
    if not candidates:
        raise ValueError('这个视频未提供所选清晰度')
    chosen = max(candidates, key=lambda v: (int(v.get('id') or 0), int(v.get('bandwidth') or 0)))
    audios = [a for a in dash.get('audio') or [] if str(a.get('codecs', '')).startswith('mp4a.')]
    if dash.get('audio') and not audios:
        raise ValueError('这个视频暂未提供浏览器可用的音频')
    tracks = {'video': _dash_track(chosen, 'video')}
    if audios:
        audio = max(audios, key=lambda a: (a.get('codecs') == 'mp4a.40.2', int(a.get('bandwidth') or 0)))
        tracks['audio'] = _dash_track(audio, 'audio')
    duration = float(data.get('timelength') or 0) / 1000 or float(dash.get('duration') or 0)
    if not math.isfinite(duration) or not 0 < duration <= 7 * 86400:
        raise ValueError('B 站高清流时长无效')
    info = {'quality': tracks['video']['id'], 'transport': 'dash', 'tracks': tracks, 'duration': duration}
    return tracks['video']['url'], info


def _play_info(identity, transport=None):
    if transport == 'dash':
        return _dash_info(identity)
    if transport == 'mp4' or identity['qn'] < 80:
        return _mp4_info(identity)
    # The merged MP4 endpoint can cap a logged-in 1080P request at 720P.
    # Select from actual DASH representations, not the API's top-level quality field.
    dash_result = None
    try:
        dash_result = _dash_info(identity)
        if dash_result[1]['quality'] >= identity['qn']:
            return dash_result
    except (ValueError, OSError):
        pass
    try:
        mp4_result = _mp4_info(identity)
    except (ValueError, OSError):
        if dash_result:
            return dash_result
        raise
    if dash_result and dash_result[1]['quality'] > int(mp4_result[1].get('quality') or 0):
        return dash_result
    return mp4_result


def prepare(data):
    identity = {}
    bvid = str(data.get('bvid') or '')
    if re.fullmatch(r'BV[0-9A-Za-z]{10}', bvid):
        identity['bvid'] = bvid
    elif re.fullmatch(r'[1-9]\d{0,19}', str(data.get('aid') or '')):
        identity['aid'] = int(data['aid'])
    else:
        raise ValueError('无效的视频编号')
    try:
        cid, qn = int(data.get('cid', 0)), int(data.get('quality', 80))
    except (TypeError, ValueError):
        raise ValueError('无效的分 P 或清晰度')
    if cid == 0:
        doc = fetch_api('https://api.bilibili.com/x/web-interface/view?' + urlencode(identity))
        pages = (doc.get('data') or {}).get('pages') or []
        try:
            page = int(data.get('page') or 1)
            if page < 1:
                raise ValueError()
            cid = int(pages[page - 1]['cid'])
        except (IndexError, KeyError, TypeError, ValueError):
            raise ValueError('无法读取这个分 P 的视频编号')
    if cid <= 0 or cid > 10**20 or qn not in _LABELS:
        raise ValueError('无效的分 P 或清晰度')
    identity.update(cid=cid, qn=qn)
    url, info = _play_info(identity)
    quality = int(info.get('quality') or 16)
    token = secrets.token_urlsafe(24)
    with _lock:
        _streams[token] = {'url': url, 'info': info, 'identity': identity, 'time': time.monotonic(),
                           'revision': _revision, 'refresh_lock': threading.Lock()}
        while len(_streams) > 128:
            _streams.popitem(last=False)
        logged_in = any(c.name == 'SESSDATA' and not c.is_expired() for c in _cookies())
    transport = info.get('transport', 'mp4')
    endpoint = 'manifest' if transport == 'dash' else 'media'
    return {'ok': True, 'url': '/api/bilibili/' + endpoint + '?token=' + token, 'transport': transport,
            'quality': quality, 'qualityLabel': _LABELS.get(quality, str(quality)), 'loggedIn': logged_in}


def serve_manifest(handler, head=False):
    token = parse_qs(urlsplit(handler.path).query).get('token', [''])[0]
    with _lock:
        item = _streams.get(token)
    if not item or item['info'].get('transport') != 'dash':
        handler.send_error(404, 'Video session not found')
        return
    info = item['info']
    ns = 'urn:mpeg:dash:schema:mpd:2011'
    ET.register_namespace('', ns)

    def element(parent, name, attrs=None):
        return ET.SubElement(parent, '{' + ns + '}' + name, attrs or {})

    duration = 'PT%gS' % info['duration']
    root = ET.Element('{' + ns + '}MPD', {'type': 'static', 'minBufferTime': 'PT1.5S',
        'profiles': 'urn:mpeg:dash:profile:isoff-on-demand:2011', 'mediaPresentationDuration': duration})
    period = element(root, 'Period', {'id': '0', 'start': 'PT0S', 'duration': duration})
    for index, (kind, track) in enumerate(info['tracks'].items()):
        adaptation = element(period, 'AdaptationSet', {'id': str(index), 'contentType': kind,
            'mimeType': track['mime'], 'segmentAlignment': 'true', 'startWithSAP': '1'})
        attributes = {'id': kind + str(track['id']), 'bandwidth': str(track['bandwidth']), 'codecs': track['codecs']}
        if kind == 'video':
            attributes.update(width=str(track['width']), height=str(track['height']))
        representation = element(adaptation, 'Representation', attributes)
        element(representation, 'BaseURL').text = '/api/bilibili/media?' + urlencode({'token': token, 'track': kind})
        segment = element(representation, 'SegmentBase', {'indexRange': track['index'], 'indexRangeExact': 'true'})
        element(segment, 'Initialization', {'range': track['initialization']})
    body = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    handler.send_response(200)
    handler.send_header('Content-Type', 'application/dash+xml')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    if not head:
        handler.wfile.write(body)


def _refresh_stream(item):
    transport = item['info'].get('transport', 'mp4')
    url, info = _play_info(item['identity'], transport=transport)
    if transport == 'dash':
        for kind, old_track in item['info']['tracks'].items():
            track = (info.get('tracks') or {}).get(kind)
            if not track or (track['id'], track['codecs']) != (old_track['id'], old_track['codecs']):
                raise ValueError('高清播放权限已变化，请重新打开视频')
        item['info'] = info
    item.update(url=url, time=time.monotonic(), revision=_revision)


def handle_api(handler):
    try:
        length = int(handler.headers.get('Content-Length', 0))
        if not 0 < length <= 8192:
            raise ValueError('请求为空或过长')
        data = json.loads(handler.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError('请求必须为 JSON 对象')
        action = data.get('action')
        if action == 'status':
            result = account_status()
        elif action == 'login':
            result = login_start()
        elif action == 'poll':
            result = login_poll(str(data.get('token') or ''))
        elif action == 'logout':
            result = logout()
        elif action == 'play':
            result = prepare(data)
        else:
            raise ValueError('未知的播放操作')
        handler._json_response(200, result)
    except (ValueError, TypeError) as exc:
        handler._json_response(400, {'ok': False, 'error': str(exc)})
    except (OSError, urllib.error.URLError):
        handler._json_response(502, {'ok': False, 'error': '暂时无法连接 B 站或保存登录，请检查网络后重试'})


def serve(handler, head=False):
    headers_sent = False
    query = parse_qs(urlsplit(handler.path).query)
    token = query.get('token', [''])[0]
    with _lock:
        item = _streams.get(token)
    if not item:
        handler.send_error(404, 'Video session not found')
        return
    track_kind = query.get('track', [''])[0]
    is_dash = item['info'].get('transport') == 'dash'
    if is_dash and track_kind not in item['info']['tracks']:
        handler.send_error(404, 'Video track not found')
        return
    requested = handler.headers.get('Range')
    if requested and not re.fullmatch(r'bytes=\d*-\d*', requested):
        handler.send_error(416)
        return
    headers = dict(_HEADERS, **({'Range': requested} if requested else {}))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _MediaRedirects())
    try:
        if time.monotonic() - item['time'] > 1800 or item['revision'] != _revision:
            with item['refresh_lock']:
                if time.monotonic() - item['time'] > 1800 or item['revision'] != _revision:
                    _refresh_stream(item)
        for attempt in range(2):
            try:
                media_url = item['info']['tracks'][track_kind]['url'] if is_dash else item['url']
                _cdn_url(media_url)
                response = opener.open(urllib.request.Request(media_url, headers=headers,
                                                             method='HEAD' if head else 'GET'), timeout=20)
                break
            except urllib.error.HTTPError as error:
                if error.code in (401, 403, 410) and attempt == 0:
                    error.close()
                    with item['refresh_lock']:
                        _refresh_stream(item)
                    continue
                raise
        with response:
            if response.status not in (200, 206):
                handler.send_error(502)
                return
            handler.send_response(response.status)
            handler.send_header('Content-Type', 'audio/mp4' if track_kind == 'audio' and is_dash else 'video/mp4')
            handler.send_header('Cache-Control', 'no-store')
            handler.send_header('Accept-Ranges', 'bytes')
            for name in ('Content-Length', 'Content-Range'):
                if response.headers.get(name):
                    handler.send_header(name, response.headers[name])
            handler.end_headers()
            headers_sent = True
            if not head:
                while chunk := response.read(128 * 1024):
                    handler.wfile.write(chunk)
    except urllib.error.HTTPError as error:
        if error.code == 416:
            handler.send_response(416)
            if error.headers.get('Content-Range'):
                handler.send_header('Content-Range', error.headers['Content-Range'])
            handler.send_header('Content-Length', '0')
            handler.end_headers()
        else:
            handler.send_error(502, 'Bilibili media unavailable')
        error.close()
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        pass
    except (OSError, ValueError, urllib.error.URLError):
        if not headers_sent:
            handler.send_error(502, 'Bilibili media unavailable')
