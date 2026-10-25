"""Standalone loopback LaTeX Snippets Manager. Run directly; the reader need not be open."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from tools.snippet_manager import storage

_WEB_DIR = Path(__file__).resolve().parent / "web"
ASSETS = _WEB_DIR
MAX_BODY = 2 * 1024 * 1024  # 2MB for large snippet sets


class ManagerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address=("127.0.0.1", 0)):
        self.token = secrets.token_urlsafe(32)
        super().__init__(address, ManagerHandler)

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.server_port}"

    @property
    def url(self):
        return f"{self.origin}/#token={self.token}"


class ManagerHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_data(self, status, data, mime="application/json; charset=utf-8", close_conn=False):
        raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        if close_conn:
            self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; "
            "font-src 'self' data:; "
            "img-src 'self' data: blob:; "
            "style-src 'self' 'unsafe-inline'; "
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
            "frame-ancestors 'none';"
        )
        self.end_headers()
        self.wfile.write(raw)
        try:
            self.wfile.flush()
        except OSError:
            pass

    def authorized(self, api=True):
        host = self.headers.get("Host", "")
        if host != f"127.0.0.1:{self.server.server_port}":
            self.send_data(403, {"error": "仅允许本机访问。"})
            return False
        origin = self.headers.get("Origin")
        if origin and origin != self.server.origin:
            self.send_data(403, {"error": "不允许跨站请求。"})
            return False
        if api and not secrets.compare_digest(self.headers.get("X-Manager-Token", ""), self.server.token):
            self.send_data(403, {"error": "请通过 LaTeX 快捷键管理工具的启动入口打开本页面。"})
            return False
        return True

    def snapshot(self, doc=None):
        if doc is None:
            doc = storage.load_data()
        backup_path = storage.json_config_path().with_suffix(".previous.json")
        return {
            "document": doc,
            "config_path": str(storage.json_config_path()),
            "config_js_path": str(storage.CONFIG_JS_PATH),
            "has_backup": backup_path.exists(),
            "categories": storage.CATEGORY_NAMES
        }

    def serve_static(self, file_path: Path):
        if not file_path.is_file():
            self.send_data(404, {"error": "文件不存在。"})
            return
        mime, _ = mimetypes.guess_type(str(file_path))
        if not mime:
            if file_path.suffix == ".css":
                mime = "text/css"
            elif file_path.suffix in (".js", ".mjs"):
                mime = "text/javascript"
            elif file_path.suffix in (".woff", ".woff2"):
                mime = "font/" + file_path.suffix[1:]
            elif file_path.suffix == ".ttf":
                mime = "font/ttf"
            else:
                mime = "application/octet-stream"
        if mime.startswith("text/") or mime == "text/javascript":
            mime += "; charset=utf-8"
        try:
            raw = file_path.read_bytes()
            self.send_data(200, raw, mime=mime)
        except OSError:
            self.send_data(500, {"error": "读取静态文件失败。"})

    def do_GET(self):
        url_parts = urllib.parse.urlsplit(self.path)
        path = url_parts.path

        if path.startswith("/api/"):
            if not self.authorized(api=True):
                return
            if path == "/api/health":
                self.send_data(200, {
                    "app": "reader-snippet-manager",
                    "config_path": str(storage.json_config_path())
                })
            elif path == "/api/snippets":
                try:
                    self.send_data(200, self.snapshot())
                except Exception as exc:
                    self.send_data(400, {"error": str(exc)})
            else:
                self.send_data(404, {"error": "接口不存在。"})
            return

        # Static assets
        if path == "/":
            self.serve_static(ASSETS / "index.html")
        elif path in ("/manager.js", "/manager.css"):
            self.serve_static(ASSETS / path[1:])
        elif path.startswith("/static/lib/"):
            # Map /static/lib/... to PROJECT_ROOT/static/lib/...
            rel_path = path[len("/static/lib/"):]
            target = (PROJECT_ROOT / "static" / "lib" / rel_path).resolve()
            # Prevent path traversal
            if str(target).startswith(str((PROJECT_ROOT / "static" / "lib").resolve())):
                self.serve_static(target)
            else:
                self.send_data(403, {"error": "禁止访问该目录。"})
        elif path == "/favicon.ico":
            self.send_data(204, b"")
        else:
            self.send_data(404, {"error": "页面不存在。"})

    def do_POST(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except (ValueError, TypeError):
            size = 0

        raw_body = self.rfile.read(size) if 0 < size <= MAX_BODY else b""
        if size > MAX_BODY:
            try:
                self.rfile.read(size)
            except Exception:
                pass

        if not self.authorized(api=True):
            return

        try:
            if not 0 < size <= MAX_BODY or self.headers.get_content_type() != "application/json":
                raise storage.StorageError("请求必须是有效的 JSON，且小于 2 MB。")
            body = json.loads(raw_body)
            if not isinstance(body, dict):
                raise storage.StorageError("无效的请求。")

            if self.path == "/api/quit":
                self.send_data(200, {"ok": True}, close_conn=True)
                def shutdown_delayed(srv):
                    time.sleep(0.35)
                    srv.shutdown()
                threading.Thread(target=shutdown_delayed, args=(self.server,), daemon=True).start()
                return

            if self.path == "/api/save":
                snippets = body.get("snippets")
                if not isinstance(snippets, list):
                    raise storage.StorageError("保存数据中缺少 snippets 数组。")
                rev = body.get("revision")
                saved_doc = storage.save_data(snippets, current_revision=rev)
                self.send_data(200, self.snapshot(saved_doc))

            elif self.path == "/api/restore":
                restored_doc = storage.restore_backup()
                self.send_data(200, self.snapshot(restored_doc))

            elif self.path == "/api/import":
                data = body.get("data")
                mode = body.get("mode", "merge")
                imported_doc = storage.import_snippets(data, mode=mode)
                self.send_data(200, self.snapshot(imported_doc))

            else:
                self.send_data(404, {"error": "接口不存在。"})

        except storage.StorageError as exc:
            self.send_data(400, {"error": str(exc)})
        except (ValueError, KeyError, TypeError) as exc:
            self.send_data(400, {"error": f"请求格式不正确: {exc}"})
        except OSError:
            self.send_data(500, {"error": "无法读写本地配置文件，请检查文件权限或磁盘空间。"})


def main():
    parser = argparse.ArgumentParser(description="LaTeX 快捷键管理工具 · 全功能 PDF 阅读器")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    session_path = storage.storage_dir() / "manager-session.json"
    if session_path.exists():
        try:
            session = json.loads(session_path.read_text(encoding="utf-8"))
            port = int(session["port"])
            origin = f"http://127.0.0.1:{port}"
            req = urllib.request.Request(origin + "/api/health", headers={"X-Manager-Token": session["token"]})
            with urllib.request.urlopen(req, timeout=1.2) as resp:
                health = json.loads(resp.read().decode("utf-8"))
            if health.get("app") == "reader-snippet-manager":
                if not args.no_browser:
                    webbrowser.open(f"{origin}/#token={session['token']}")
                return
        except Exception:
            pass

    with ManagerServer() as server:
        storage._atomic_write(session_path, json.dumps({
            "port": server.server_port,
            "token": server.token
        }))
        if not args.no_browser:
            webbrowser.open(server.url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            try:
                if json.loads(session_path.read_text(encoding="utf-8")).get("token") == server.token:
                    session_path.unlink()
            except (OSError, ValueError):
                pass


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        try:
            from tkinter import Tk, messagebox
            root = Tk()
            root.withdraw()
            messagebox.showerror("LaTeX 快捷键管理工具启动失败", "请检查目录读写权限或使用 Python 3.10 及以上版本。\n" + str(exc))
            root.destroy()
        except Exception:
            print("LaTeX 快捷键管理工具启动失败:", exc, file=sys.stderr)
