"""Standalone loopback LaTeX manager; no reader or TeX process is required."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import secrets
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from tools.latex_manager import storage

ASSETS = Path(__file__).resolve().parent / 'web'
MAX_BODY = 512 * 1024


class ManagerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address=('127.0.0.1', 0)):
        self.token = secrets.token_urlsafe(32)
        super().__init__(address, ManagerHandler)

    @property
    def origin(self):
        return f'http://127.0.0.1:{self.server_port}'

    @property
    def url(self):
        return f'{self.origin}/#token={self.token}'


class ManagerHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_data(self, status, data, mime='application/json; charset=utf-8'):
        raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self, api=False):
        if (self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}' or
                self.headers.get('Origin', self.server.origin) != self.server.origin or
                self.headers.get('Sec-Fetch-Site') == 'cross-site'):
            self.send_data(403, {'error': '仅允许本机同源访问。'})
            return False
        if api and not secrets.compare_digest(self.headers.get('X-Manager-Token', ''), self.server.token):
            self.send_data(403, {'error': '请通过 LaTeX-Manager.bat 启动管理工具。'})
            return False
        return True

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if not self.authorized(api=path.startswith('/api/')):
            return
        if path == '/api/health':
            self.send_data(200, {'app': 'reader-latex-manager', 'config_path': str(storage.config_path())})
        elif path == '/api/config':
            try:
                self.send_data(200, storage.snapshot())
            except (OSError, ValueError) as exc:
                self.send_data(400, {'error': str(exc)})
        elif path in ('/', '/manager.js', '/manager.css'):
            root = ASSETS.resolve()
            file = root / ('index.html' if path == '/' else path[1:])
            if not file.is_relative_to(root) or not file.is_file():
                self.send_data(404, {'error': '文件不存在。'})
                return
            mime = mimetypes.guess_type(file)[0] or 'application/octet-stream'
            if file.suffix == '.js':
                mime = 'text/javascript'
            if mime.startswith('text/'):
                mime += '; charset=utf-8'
            self.send_data(200, file.read_bytes(), mime)
        elif path == '/favicon.ico':
            self.send_data(204, b'')
        else:
            self.send_data(404, {'error': '页面不存在。'})

    def do_POST(self):
        if not self.authorized(api=True):
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= MAX_BODY or self.headers.get_content_type() != 'application/json':
                raise storage.StorageError('请求必须是小于 512 KB 的 JSON。')
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise storage.StorageError('无效的请求。')
            if self.path == '/api/save':
                self.send_data(200, storage.save(body.get('config'), body.get('revision')))
            elif self.path == '/api/restore':
                self.send_data(200, storage.restore(body.get('revision')))
            elif self.path == '/api/quit':
                self.send_data(200, {'ok': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self.send_data(404, {'error': '接口不存在。'})
        except (ValueError, TypeError, RecursionError) as exc:
            self.send_data(400, {'error': str(exc)})
        except OSError:
            self.send_data(500, {'error': '无法读写本地配置，请检查文件权限。'})


def main():
    parser = argparse.ArgumentParser(description='LaTeX 宏包管理工具')
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    session_path = storage.storage_dir() / 'manager-session.json'
    try:
        session = json.loads(session_path.read_text(encoding='utf-8'))
        origin = f"http://127.0.0.1:{int(session['port'])}"
        request = urllib.request.Request(origin + '/api/health', headers={'X-Manager-Token': session['token']})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=1.2) as response:
            health = json.load(response)
        if health.get('app') == 'reader-latex-manager' and health.get('config_path') == str(storage.config_path()):
            if not args.no_browser:
                webbrowser.open(f"{origin}/#token={session['token']}")
            return
    except (OSError, ValueError, KeyError):
        pass
    with ManagerServer() as server:
        storage.atomic_write(session_path, json.dumps({'port': server.server_port, 'token': server.token}))
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
        try:
            from tkinter import Tk, messagebox
            root = Tk()
            root.withdraw()
            messagebox.showerror('LaTeX 宏包管理工具启动失败', str(exc))
            root.destroy()
        except Exception:
            print('LaTeX 宏包管理工具启动失败:', exc, file=sys.stderr)
