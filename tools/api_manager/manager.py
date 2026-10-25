"""Standalone loopback API manager. Run directly; the reader need not be open."""
import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zlib

PROJECT_ROOT = Path(__file__).resolve().parents[2]
import sys
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
try:
    from tools.api_manager import settings
except ImportError:
    import api_settings as settings

_WEB_DIR = Path(__file__).resolve().parent / 'web'
ASSETS = _WEB_DIR if _WEB_DIR.is_dir() else (PROJECT_ROOT / 'api-manager')
MAX_BODY = 512 * 1024
TEST_SLOTS = threading.BoundedSemaphore(2)


def test_image():
    """A local 128x64 PNG saying 1+1, without Pillow or user document access."""
    pattern = ['0100000000010', '1100001000110', '0100001000010',
               '0100111110010', '0100001000010', '0100001000010', '1110000000111']
    rows = []
    for y in range(64):
        row = bytearray()
        for x in range(128):
            px, py = (x - 25) // 6, (y - 11) // 6
            dark = 0 <= py < 7 and 0 <= px < 13 and pattern[py][px] == '1'
            row.extend((20, 30, 45) if dark else (255, 255, 255))
        rows.append(b'\x00' + row)
    def chunk(tag, data):
        return struct.pack('!I', len(data)) + tag + data + struct.pack('!I', zlib.crc32(tag + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 128, 64, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b'')
    return 'data:image/png;base64,' + base64.b64encode(png).decode()


def probe(doc, fid, list_models=False):
    cfg = settings.resolve(fid, {}, doc)
    started = time.monotonic()
    url = settings.models_url(cfg['base_url']) if list_models else settings.completion_url(cfg['base_url'])
    headers = {
        'Authorization': 'Bearer ' + cfg['api_key'],
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
    payload = None
    if not list_models:
        content = '这是一条连接测试。请只回复：连接成功。'
        if fid.startswith('formula_'):
            content = [{'type': 'text', 'text': '请用 LaTeX 写出图片中的算式，只输出算式。'},
                       {'type': 'image_url', 'image_url': {'url': test_image()}}]
        payload = settings.apply_parameters({'model': cfg['model'], 'stream': False,
                                            'messages': [{'role': 'user', 'content': content}]}, cfg)
        payload['max_tokens'] = min(int(cfg['max_tokens'] or 256), 256)
        if cfg['web_search']:
            payload['tools'] = [{'type': 'web_search'}]
    req = urllib.request.Request(url, data=json.dumps(payload).encode() if payload else None, headers=headers)
    result = {'ok': False, 'model': cfg['model'], 'endpoint': url, 'status': 0}
    try:
        with settings.open_request(req, cfg) as resp:
            result['status'] = resp.status
            raw = resp.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('响应过大，请检查接口地址。')
        data = json.loads(raw)
        if list_models:
            models = sorted({m['id'] for m in data.get('data', []) if isinstance(m, dict) and isinstance(m.get('id'), str)})
            if not models:
                raise ValueError('接口未返回模型列表；仍可手动填写模型名称。')
            result.update(ok=True, models=models[:300])
        else:
            text = data['choices'][0]['message'].get('content')
            if not text:
                raise ValueError('接口已响应，但未返回正文。可尝试关闭思考后重测（测试上限为 256 tokens）。')
            result.update(ok=True, reply=settings.redact(str(text)[:1500], cfg),
                          model=data.get('model', cfg['model']), usage=data.get('usage', {}))
    except urllib.error.HTTPError as exc:
        hints = {
            401: 'Key 无效或已过期',
            403: '权限不足或上游网关拦截',
            404: '该端点不支持查询模型列表（如 DeepSeek 官方暂不开放 /models 接口），可直接手动填写模型名称' if list_models else '地址或模型不存在',
            429: '限流或额度不足',
            400: '模型或调用参数不兼容'
        }
        detail = exc.read(3000).decode('utf-8', errors='replace')
        result.update(status=exc.code, error='HTTP %s · %s\n%s' % (
            exc.code, hints.get(exc.code, '上游接口错误'), settings.redact(detail, cfg)))
    except Exception as exc:
        result['error'] = settings.redact(str(exc), cfg)
    result['elapsed_ms'] = round((time.monotonic() - started) * 1000)
    return result


class ManagerServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address=('127.0.0.1', 0)):
        self.token = secrets.token_urlsafe(32)
        super().__init__(address, ManagerHandler)

    @property
    def origin(self):
        return 'http://127.0.0.1:%s' % self.server_port

    @property
    def url(self):
        return self.origin + '/#token=' + self.token


class ManagerHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_data(self, status, data, mime='application/json; charset=utf-8', close_conn=False):
        raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        if close_conn:
            self.send_header('Connection', 'close')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(raw)
        try:
            self.wfile.flush()
        except OSError:
            pass

    def authorized(self, api=True):
        if self.headers.get('Host') != '127.0.0.1:%s' % self.server.server_port:
            self.send_data(403, {'error': '仅允许本机访问。'})
            return False
        origin = self.headers.get('Origin')
        if origin and origin != self.server.origin:
            self.send_data(403, {'error': '不允许跨站请求。'})
            return False
        if api and not secrets.compare_digest(self.headers.get('X-Manager-Token', ''), self.server.token):
            self.send_data(403, {'error': '请通过 API 管理工具的启动文件打开本页面。'})
            return False
        return True

    def snapshot(self, doc):
        return {'document': settings.public_document(doc), 'features': settings.FEATURES,
                'config_path': str(settings.config_path()),
                'has_backup': settings.config_path().with_suffix('.previous.json').exists(),
                'default_prompts': settings.default_prompts()}

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if not self.authorized(api=path.startswith('/api/')):
            return
        if path == '/api/health':
            self.send_data(200, {'app': 'reader-api-manager', 'config_path': str(settings.config_path())})
        elif path == '/api/config':
            try:
                self.send_data(200, self.snapshot(settings.initialize()))
            except settings.ConfigError:
                try:
                    snapshot = self.snapshot(settings.recovery_document())
                    snapshot['recovery'] = '当前配置文件损坏。下方显示上一版备份，请点击“恢复上一次保存”修复。'
                    self.send_data(200, snapshot)
                except Exception:
                    self.send_data(400, {'error': '配置无法读取且没有有效备份，请检查本地 settings.json 文件。'})
            except Exception as exc:
                self.send_data(400, {'error': str(exc)})
        elif path in ('/', '/manager.js', '/manager.css'):
            name = 'index.html' if path == '/' else path[1:]
            mime = {'index.html': 'text/html', 'manager.js': 'text/javascript', 'manager.css': 'text/css'}[name]
            self.send_data(200, (ASSETS / name).read_bytes(), mime + '; charset=utf-8')
        elif path == '/favicon.ico':
            self.send_data(204, b'')
        else:
            self.send_data(404, {'error': '页面不存在。'})

    def do_POST(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except (ValueError, TypeError):
            size = 0
        raw_body = self.rfile.read(size) if 0 < size <= MAX_BODY else b''
        if size > MAX_BODY:
            try:
                self.rfile.read(size)
            except Exception:
                pass
        if not self.authorized():
            return
        try:
            if not 0 < size <= MAX_BODY or self.headers.get_content_type() != 'application/json':
                raise settings.ConfigError('请求必须是有效的 JSON，且小于 512 KB。')
            body = json.loads(raw_body)
            if not isinstance(body, dict):
                raise settings.ConfigError('无效的请求。')
            if self.path == '/api/restore':
                self.send_data(200, self.snapshot(settings.restore(body['revision'])))
                return
            if self.path == '/api/quit':
                self.send_data(200, {'ok': True}, close_conn=True)
                def shutdown_delayed(srv):
                    time.sleep(0.35)
                    srv.shutdown()
                threading.Thread(target=shutdown_delayed, args=(self.server,), daemon=True).start()
                return
            current = settings.initialize()
            if self.path == '/api/save':
                doc = settings.merge_public(body['document'], current)
                saved = settings.save_document(doc, body['document']['revision'])
                self.send_data(200, self.snapshot(saved))
            elif self.path in ('/api/test', '/api/models'):
                fid = body.get('feature')
                if fid not in settings.FEATURES:
                    raise settings.ConfigError('请选择有效的功能。')
                doc = settings.merge_public(body['document'], current)
                if body['document']['revision'] != current['revision']:
                    raise settings.ConfigError('配置已变化，请重新加载后再测试。')
                if not TEST_SLOTS.acquire(blocking=False):
                    raise settings.ConfigError('已有测试正在运行，请稍后重试。')
                try:
                    self.send_data(200, probe(doc, fid, self.path == '/api/models'))
                finally:
                    TEST_SLOTS.release()
            else:
                self.send_data(404, {'error': '接口不存在。'})
        except (settings.ConfigError, ValueError, KeyError, TypeError) as exc:
            message = str(exc) if isinstance(exc, settings.ConfigError) else '请求格式不正确，请重新加载后重试。'
            self.send_data(400, {'error': message})
        except OSError:
            self.send_data(500, {'error': '无法读写本地配置，请检查文件权限或磁盘空间。'})


def main():
    parser = argparse.ArgumentParser(description='阅读器 API 管理工具')
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    session_path = settings.config_path().parent / 'manager-session.json'
    if session_path.exists():
        try:
            session = json.loads(session_path.read_text(encoding='utf-8'))
            port = int(session['port'])
            origin = 'http://127.0.0.1:%s' % port
            req = urllib.request.Request(origin + '/api/health', headers={'X-Manager-Token': session['token']})
            with settings.open_request(req, {'timeout': 1}) as resp:
                health = json.loads(resp.read())
            if health.get('app') == 'reader-api-manager' and health.get('config_path') == str(settings.config_path()):
                if not args.no_browser:
                    webbrowser.open(origin + '/#token=' + session['token'])
                return
        except (OSError, ValueError, KeyError):
            pass
    with ManagerServer() as server:
        settings._atomic_write(session_path, {'port': server.server_port, 'token': server.token})
        if not args.no_browser:
            webbrowser.open(server.url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            try:
                if json.loads(session_path.read_text(encoding='utf-8')).get('token') == server.token:
                    session_path.unlink()
            except (OSError, ValueError):
                pass


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # pythonw has no console: show an actionable launch failure instead of vanishing.
        from tkinter import Tk, messagebox
        root = Tk()
        root.withdraw()
        messagebox.showerror('API 管理工具启动失败', '请检查目录读写权限或使用 Python 3.10 及以上版本。\n' + str(exc))
        root.destroy()
