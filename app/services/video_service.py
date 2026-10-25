"""本地视频选择、同目录播放列表和支持 Range 的流式读取服务。"""
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
from collections import OrderedDict
from urllib.parse import parse_qs, urlsplit

EXTENSIONS = {'.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.ogv'}
_libraries = OrderedDict()
_lock = threading.Lock()


def pick_file(initial_dir):
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    try:
        root.withdraw()
        root.attributes('-topmost', True)
        return filedialog.askopenfilename(
            parent=root, title='选择视频（同时加载当前文件夹的视频）',
            initialdir=initial_dir if os.path.isdir(initial_dir) else None,
            filetypes=[('视频文件', ' '.join('*' + ext for ext in sorted(EXTENSIONS)))])
    finally:
        root.destroy()


def playlist(selected):
    selected = os.path.realpath(selected)
    if not os.path.isfile(selected) or os.path.splitext(selected)[1].lower() not in EXTENSIONS:
        raise ValueError('请选择支持的视频文件')
    folder = os.path.dirname(selected)
    with os.scandir(folder) as entries:
        files = [entry.path for entry in entries
                 if entry.is_file(follow_symlinks=False)
                 and os.path.splitext(entry.name)[1].lower() in EXTENSIONS]

    def _natural_key(path):
        return [int(part) if part.isdigit() else part.casefold()
                for part in re.split(r'(\d+)', os.path.basename(path))]
    files.sort(key=_natural_key)
    token = secrets.token_urlsafe(24)
    with _lock:
        _libraries[token] = files
        while len(_libraries) > 64:
            _libraries.popitem(last=False)
    videos = [{'name': os.path.basename(path), 'url': f'/api/video?token={token}&index={i}'}
              for i, path in enumerate(files)]
    index = next(i for i, path in enumerate(files) if os.path.normcase(path) == os.path.normcase(selected))
    return {'ok': True, 'folder': folder, 'videos': videos, 'selected': videos[index]['url']}


def serve(handler, head=False):
    query = parse_qs(urlsplit(handler.path).query)
    try:
        index = int(query.get('index', [''])[0])
        with _lock:
            files = _libraries.get(query.get('token', [''])[0], [])
            path = files[index] if 0 <= index < len(files) else None
        if not path or os.path.islink(path):
            handler.send_error(404, 'Video not found')
            return
        source = open(path, 'rb')
    except (ValueError, OSError):
        handler.send_error(404, 'Video not found')
        return
    with source:
        size = os.fstat(source.fileno()).st_size
        start, end, status = 0, size - 1, 200
        requested = handler.headers.get('Range')
        if requested:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested.strip())
            valid = bool(match and (match[1] or match[2]) and size)
            if valid:
                if match[1]:
                    start = int(match[1])
                    end = min(int(match[2]), size - 1) if match[2] else size - 1
                else:
                    start = max(0, size - int(match[2]))
                valid = 0 <= start <= end < size
            if not valid:
                handler.send_response(416)
                handler.send_header('Content-Range', f'bytes */{size}')
                handler.send_header('Content-Length', '0')
                handler.end_headers()
                return
            status = 206
        handler.send_response(status)
        handler.send_header('Content-Type', mimetypes.guess_type(path)[0] or 'application/octet-stream')
        handler.send_header('Accept-Ranges', 'bytes')
        handler.send_header('Content-Length', str(end - start + 1))
        handler.send_header('Cache-Control', 'no-store')
        if status == 206:
            handler.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        handler.end_headers()
        if head:
            return
        source.seek(start)
        remaining = end - start + 1
        try:
            while remaining > 0:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                handler.wfile.write(chunk)
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def handle_picker(handler, dialog_lock):
    try:
        length = int(handler.headers.get('Content-Length', 0))
        if not 0 <= length <= 8192:
            raise ValueError('请求过长')
        data = json.loads(handler.rfile.read(length) or b'{}')
        if not isinstance(data, dict):
            raise ValueError('请求必须为 JSON 对象')
    except (ValueError, TypeError) as exc:
        handler._json_response(400, {'ok': False, 'error': str(exc)})
        return
    origin = handler.headers.get('Origin')
    if origin and urlsplit(origin).netloc != handler.headers.get('Host'):
        handler._json_response(403, {'ok': False, 'error': '只允许阅读器页面选择视频'})
        return
    if not dialog_lock.acquire(blocking=False):
        handler._json_response(409, {'ok': False, 'error': '已有一个选择窗口正在打开，请先完成它'})
        return
    try:
        picker = sys.modules.get('video_library', sys.modules[__name__]).pick_file
        selected = picker(str(data.get('initial_dir') or ''))
        answer = playlist(selected) if selected else {'ok': False, 'cancelled': True}
        handler._json_response(200, answer)
    except Exception as exc:
        handler._json_response(500, {'ok': False, 'error': str(exc)})
    finally:
        dialog_lock.release()
