"""阅读器的公式输入适配与服务层；按需复用 airtex / tex，不启动桌面浮窗。"""
import atexit
import base64
import io
import json
import secrets
import socket
import sys
import threading
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
import api_settings
from app.services.tunnel_service import QuickTunnel

MAX_BODY = 12 * 1024 * 1024
ENGINE_DEEPSEEK = 'deepseek'
WHITEBOARD_PROMPT = r'''输出这段内容在latex文档中相应段落的代码。
忠实识别手写草稿中的文字与公式，保留段落、换行和推导顺序，不补写、不解题。
普通文字作为 LaTeX 正文输出；行内公式用 $...$，独立或多行公式用 $$...$$。
不要使用 \(\)、\[\] 或 equation 环境包裹公式；不要把整段文字包进数学环境。
只输出可直接放入 LaTeX 文档正文的代码，不输出 Markdown 围栏、解释或导言区。
如果画面没有可识别内容，只输出：未检测到内容。'''

_sessions = {}
_lock = threading.RLock()
_ocr_slots = threading.BoundedSemaphore(2)
_reaper_started = False


def _modules():
    try:
        from airtex import core, web, qr
        from tex import latex_ocr
    except ImportError as exc:
        raise RuntimeError('公式识别需要 Pillow，请在启动阅读器的 Python 中运行：python -m pip install Pillow') from exc
    return core, web, qr, latex_ocr


def _engine(body):
    return ENGINE_DEEPSEEK if str(body.get('engine') or '').strip() == ENGINE_DEEPSEEK else ''


def _config(kind):
    bridge_mod = sys.modules.get('formula_bridge')
    if bridge_mod and hasattr(bridge_mod, '_config') and bridge_mod._config != _config:
        return bridge_mod._config(kind)
    core, _, _, tex = _modules()
    cfg = dict(tex.DEFAULT_CONFIG if kind == 'image' else core.DEFAULT_CONFIG)
    path = ROOT / ('tex' if kind == 'image' else 'airtex') / 'config.json'
    if path.exists():
        cfg.update(json.loads(path.read_text(encoding='utf-8-sig')))
    return api_settings.resolve('formula_image' if kind == 'image' else 'formula_handwriting', cfg)


def _apply_engine(cfg, engine, deepseek=None):
    if engine != ENGINE_DEEPSEEK:
        return dict(cfg)
    if not deepseek or not str(deepseek.get('api_key', '')).strip():
        raise RuntimeError('第二模型未配置 Key，请打开 API-Manager.bat 设置')
    merged = dict(cfg)
    merged.update({k: v for k, v in deepseek.items() if k != 'prompt' or v})
    return merged


def _engine_config(kind, engine, deepseek=None):
    cfg = _config(kind)
    if engine == ENGINE_DEEPSEEK:
        return _apply_engine(cfg, engine, deepseek)
    if not str(cfg.get('api_key', '')).strip():
        raise ValueError('请先在 %s/config.json 中填写 api_key'
                         % ('tex' if kind == 'image' else 'airtex'))
    return cfg


def _purpose_config(cfg, purpose):
    cfg = dict(cfg)
    if purpose == 'whiteboard':
        cfg.update(prompt=WHITEBOARD_PROMPT, output_kind='paragraph', enable_text=False)
    return cfg


def recognize(body, deepseek=None):
    core, _, _, tex = _modules()
    kind = body.get('kind')
    if kind not in ('image', 'handwriting'):
        raise ValueError('不支持的识别类型')
    cfg = _purpose_config(_engine_config(kind, _engine(body), deepseek), body.get('purpose'))
    if not _ocr_slots.acquire(blocking=False):
        raise RuntimeError('正在识别其他公式，请稍后重试')
    try:
        if kind == 'handwriting':
            doc = body.get('doc')
            if not isinstance(doc, dict):
                raise ValueError('手写画板数据无效')
            result = core.recognize_doc(cfg, core.sanitize_doc(doc), core.MODE_PC)
            return {k: result.get(k) for k in ('ok', 'latex', 'model', 'empty', 'error')}
        from PIL import Image, ImageOps
        value = body.get('image', '')
        if not isinstance(value, str) or not value.startswith('data:image/') or ';base64,' not in value:
            raise ValueError('请选择或粘贴一张图片')
        try:
            raw = base64.b64decode(value.split(';base64,', 1)[1], validate=True)
            with Image.open(io.BytesIO(raw)) as source:
                if source.width * source.height > 24_000_000:
                    raise ValueError('图片过大，请先裁剪到公式区域')
                img = ImageOps.exif_transpose(source).convert('RGBA')
                white = Image.new('RGBA', img.size, 'white')
                white.alpha_composite(img)
                img = white.convert('RGB')
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError('图片无法读取，请使用 PNG、JPEG 或 WebP 图片') from exc
        if min(img.size) < 2:
            raise ValueError('图片太小，请重新框选')
        text, model = tex.call_api(cfg, tex.prepare_image(cfg, img))
        raw = tex.clean_code(text)
        empty = not raw.strip('$ \n\t') or core.NOT_FOUND_TEXT in raw
        return {'ok': True, 'latex': '' if empty else tex.normalize_delimiters(raw),
                'model': model, 'empty': empty,
                'error': '未检测到公式，请缩小到公式区域后重试' if empty else ''}
    finally:
        _ocr_slots.release()


def _close(sid):
    with _lock:
        entry = _sessions.pop(sid, None)
        if entry:
            entry['closed'] = True
    if entry:
        if entry.get('tunnel'):
            entry['tunnel'].stop()
        app = entry['server'].app
        app.set_mode('pc', save=False)
        with app.ws_lock:
            clients = list(app.ws_clients.values())
        for sock, _ in clients:
            try:
                sock.shutdown(socket.SHUT_RDWR)
                sock.close()
            except OSError:
                pass
        entry['server'].stop()


def close_all():
    with _lock:
        ids = list(_sessions)
    for sid in ids:
        _close(sid)


atexit.register(close_all)


def _connection(body):
    connection = body.get('connection', 'lan')
    if connection not in ('lan', 'internet'):
        raise ValueError('请选择同一 Wi-Fi 或互联网连接')
    return connection


def _set_connection(entry, connection, retry=False):
    old = None
    with _lock:
        if entry.get('closed'):
            raise ValueError('手机连接已结束，请重新扫码')
        entry['connection'] = connection
        tunnel = entry.get('tunnel')
        if connection == 'lan':
            old, entry['tunnel'] = tunnel, None
        elif not tunnel or retry:
            old = tunnel
            entry['tunnel'] = QuickTunnel(entry['server'].port)
            entry['tunnel'].start()
    if old:
        old.stop()


def _pairing(entry):
    with _lock:
        connection = entry['connection']
        tunnel = entry.get('tunnel')
        if connection == 'internet':
            state = tunnel.snapshot() if tunnel else {'status': 'starting', 'message': '正在建立互联网连接…', 'url': ''}
            urls = [state['url'] + '/?t=' + urllib.parse.quote(entry['base']['token'])] if state['url'] else []
        else:
            state = {'status': 'ready', 'message': '手机与电脑连接同一 Wi-Fi 后扫码'}
            urls = entry['lan_urls']
        key = (connection, state['status'], state['message'], tuple(urls))
        if entry.get('pairing_key') != key:
            qr_image = ''
            if urls:
                _, _, qr, _ = _modules()
                buf = io.BytesIO()
                qr.to_image(urls[0]).save(buf, format='PNG')
                qr_image = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
            entry['pairing_key'] = key
            entry['pairing'] = {'connection': connection, 'status': state['status'],
                'message': state['message'], 'urls': urls, 'qr': qr_image,
                'pairingRev': entry.get('pairing', {}).get('pairingRev', 0) + 1}
        return entry['pairing']


def _reap():
    while True:
        time.sleep(30)
        _reap_idle()


def _reap_idle():
    with _lock:
        stale = [sid for sid, entry in _sessions.items()
                 if time.monotonic() - entry['seen'] > 1800
                 and not entry['server'].app.is_online(timeout=1800)]
    for sid in stale:
        _close(sid)


def _set_engine(entry, engine, deepseek):
    base = _config('handwriting')
    base.update({k: entry['base'][k] for k in ('host', 'port', 'token', 'input_mode',
                 'auto_recognize', 'auto_copy', 'require_page_token')})
    cfg = _purpose_config(_apply_engine(base, engine, deepseek), entry.get('purpose'))
    entry['server'].app.cfg = entry['server'].cfg = cfg
    entry['engine'] = engine
    entry['deepseek'] = deepseek


def _phone_config(entry):
    deepseek = api_settings.resolve('formula_alt', entry.get('deepseek') or {})
    _set_engine(entry, entry['engine'], deepseek)
    return entry['server'].app.cfg


def phone(body, deepseek=None):
    global _reaper_started
    core, web, qr, _ = _modules()
    action = body.get('action')
    engine = _engine(body)
    if action == 'start':
        connection = _connection(body)
        base = _config('handwriting')
        if engine != ENGINE_DEEPSEEK and not str(base.get('api_key', '')).strip():
            raise ValueError('请先在 airtex/config.json 中填写 api_key')
        base.update(host='0.0.0.0', port=0, token=secrets.token_urlsafe(24),
                    input_mode='phone', auto_recognize=False, auto_copy=False,
                    require_page_token=True)
        purpose = 'whiteboard' if body.get('purpose') == 'whiteboard' else 'formula'
        cfg = _purpose_config(_apply_engine(base, engine, deepseek), purpose)
        with _lock:
            if len(_sessions) >= 4:
                raise ValueError('手机连接过多，请先关闭其他编辑框后重试')
            server = web.AirtexServer(cfg)
            server.start()
            sid = secrets.token_urlsafe(24)
            _sessions[sid] = {'server': server, 'seen': time.monotonic(),
                              'base': base, 'engine': engine, 'deepseek': deepseek, 'purpose': purpose,
                              'connection': 'lan', 'tunnel': None}
            entry = _sessions[sid]
            server.app.config_provider = lambda: _phone_config(entry)
            if not _reaper_started:
                threading.Thread(target=_reap, daemon=True).start()
                _reaper_started = True
        try:
            urls = [web.build_url(cfg, ip, server.port) for ip in core.get_lan_ips()]
            if not urls:
                urls = [web.build_url(cfg, core.primary_ip(), server.port)]
            entry['lan_urls'] = urls
            _set_connection(entry, connection)
            return {'ok': True, 'session': sid, **_pairing(entry)}
        except Exception:
            _close(sid)
            raise
    sid = body.get('session')
    if not isinstance(sid, str):
        raise ValueError('手机连接已结束，请重新扫码')
    if action == 'close':
        _close(sid)
        return {'ok': True}
    with _lock:
        entry = _sessions.get(sid)
        if not entry:
            raise ValueError('手机连接已结束，请重新扫码')
        entry['seen'] = time.monotonic()
        app = entry['server'].app
    if action != 'state' or entry.get('engine') != engine or entry.get('deepseek') != deepseek:
        _set_engine(entry, engine, deepseek)
    if action == 'connection':
        _set_connection(entry, _connection(body), retry=body.get('retry') is True)
        return {'ok': True, 'pairing': _pairing(entry)}
    if action == 'recognize':
        app.start_recognize()
    elif action == 'clear':
        app.clear(from_pc=True)
    elif action != 'state':
        raise ValueError('未知的手机操作')
    result = {'ok': True, **app.snapshot(since_rev=body.get('rev'))}
    pairing = _pairing(entry)
    if body.get('pairingRev') != pairing['pairingRev']:
        result['pairing'] = pairing
    return result


def _drain_request(handler, timeout=2.0):
    try:
        length = int(handler.headers.get('Content-Length', '0') or 0)
    except (TypeError, ValueError):
        return
    if length <= 0:
        return
    try:
        handler.connection.settimeout(timeout)
    except OSError:
        pass
    remaining = min(length, MAX_BODY)
    try:
        while remaining > 0:
            chunk = handler.rfile.read(min(65536, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
    except OSError:
        pass


def handle(handler, deepseek=None):
    try:
        origin = handler.headers.get('Origin')
        if origin and urllib.parse.urlsplit(origin).netloc != handler.headers.get('Host'):
            _drain_request(handler)
            handler._json_response(403, {'ok': False, 'error': '只允许本机阅读器页面调用此接口' if 'formula_bridge' not in sys.modules else '请在阅读器内使用公式输入'})
            return
        if handler.headers.get_content_type() != 'application/json':
            raise ValueError('需要 JSON 请求')
        length = int(handler.headers.get('Content-Length', '0'))
        if length <= 0 or length > MAX_BODY:
            raise ValueError('图片或笔迹过大，请缩小后重试')
        body = json.loads(handler.rfile.read(length))
        if not isinstance(body, dict):
            raise ValueError('请求格式无效')
        route = urllib.parse.urlsplit(handler.path).path
        if route == '/api/formula/recognize':
            result = recognize(body, deepseek)
        elif route == '/api/formula/phone':
            handler._formula_state_poll = body.get('action') == 'state'
            result = phone(body, deepseek)
        else:
            _drain_request(handler)
            handler._json_response(404, {'ok': False, 'error': '未知的公式接口'})
            return
        handler._json_response(200, result)
    except (ValueError, TypeError) as exc:
        handler._json_response(400, {'ok': False, 'error': str(exc)})
    except Exception as exc:
        handler._json_response(502, {'ok': False, 'error': str(exc)})
