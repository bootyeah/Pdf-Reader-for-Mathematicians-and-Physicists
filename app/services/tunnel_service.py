"""One temporary Cloudflare tunnel per phone board; never forwards the reader API."""
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_CACHE_BASE = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.cache')))
TOOL_DIR = _CACHE_BASE / 'PDFReader' / 'phone-tunnel'
VERSION = '2026.10.0'
DOWNLOAD = f'https://github.com/cloudflare/cloudflared/releases/download/{VERSION}/cloudflared-windows-amd64.exe'
SHA256 = '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c'
URL_RE = re.compile(r'https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b')
_install_lock = threading.Lock()


def _current_tool_dir():
    mod = sys.modules.get('phone_tunnel')
    if mod and hasattr(mod, 'TOOL_DIR'):
        return Path(mod.TOOL_DIR)
    return TOOL_DIR


def _digest(path):
    with open(path, 'rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else _digest_stream(source)


def _digest_stream(source):
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
    return digest.hexdigest()


def executable(cancel, progress):
    """Use an explicit installation, or download a pinned and verified Windows tool."""
    tool_dir = _current_tool_dir()
    configured = os.environ.get('PDF_READER_CLOUDFLARED', '').strip()
    if configured:
        if not Path(configured).is_file():
            raise RuntimeError('PDF_READER_CLOUDFLARED 指定的隧道工具不存在')
        return configured
    if os.name != 'nt':
        installed = shutil.which('cloudflared')
        if not installed:
            raise RuntimeError('请安装 cloudflared 后重试互联网连接')
        return installed
    target = tool_dir / 'cloudflared.exe'
    while not _install_lock.acquire(timeout=.2):
        if cancel.is_set():
            return None
    try:
        if cancel.is_set():
            return None
        if target.is_file():
            if _digest(target) != SHA256:
                raise RuntimeError(f'隧道工具校验失败，请删除 {target} 后重试')
            return str(target)
        tool_dir.mkdir(parents=True, exist_ok=True)
        progress('downloading', '首次使用：正在下载互联网连接工具…')
        request = urllib.request.Request(DOWNLOAD, headers={'User-Agent': 'PDFReader-PhoneTunnel'})
        temporary = None
        try:
            with urllib.request.urlopen(request, timeout=30) as response, \
                    tempfile.NamedTemporaryFile(dir=tool_dir, suffix='.download', delete=False) as out:
                temporary = Path(out.name)
                size = int(response.headers.get('Content-Length', '0'))
                received = 0
                deadline = time.monotonic() + 180
                while True:
                    if cancel.is_set():
                        return None
                    if time.monotonic() > deadline:
                        raise RuntimeError('下载超时，请检查电脑网络后重试')
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    received += len(chunk)
                    if received > 100 * 1024 * 1024:
                        raise RuntimeError('隧道工具下载大小异常')
                    percent = f' {min(100, received * 100 // size)}%' if size else ''
                    progress('downloading', '首次使用：正在下载互联网连接工具' + percent + '…')
            if _digest(temporary) != SHA256:
                raise RuntimeError('隧道工具下载校验失败，请重试')
            if cancel.is_set():
                return None
            temporary.replace(target)
            return str(target)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()
    finally:
        _install_lock.release()


class QuickTunnel:
    def __init__(self, port):
        if not isinstance(port, int) or not 1 <= port <= 65535 or port == 8080:
            raise ValueError('只能转发独立的手机手写服务')
        self.port = port
        self.cancel = threading.Event()
        self.connected = threading.Event()
        self.lock = threading.RLock()
        self.process = None
        self.thread = None
        self.status = 'starting'
        self.message = '正在建立互联网连接…'
        self.url = ''

    def snapshot(self):
        with self.lock:
            return {'status': self.status, 'message': self.message,
                    'url': self.url if self.status == 'ready' else ''}

    def _progress(self, status, message):
        with self.lock:
            if not self.cancel.is_set() and self.status != 'error':
                self.status, self.message = status, message

    def start(self):
        with self.lock:
            if self.thread or self.cancel.is_set():
                return
            self.thread = threading.Thread(target=self._run, daemon=True, name='phone-tunnel')
            self.thread.start()

    def _timeout(self):
        if not self.connected.wait(90) and not self.cancel.is_set():
            self._fail('互联网连接超时，请检查电脑网络后点击“重试连接”')

    def _fail(self, message):
        with self.lock:
            if self.cancel.is_set() or self.status == 'error':
                return
            self.status, self.message = 'error', message
            process = self.process
        self._terminate(process)

    @staticmethod
    def _terminate(process):
        if process and process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            except OSError:
                pass

    def _run(self):
        tool_dir = _current_tool_dir()
        try:
            tool = executable(self.cancel, self._progress)
            if not tool or self.cancel.is_set():
                return
            tool_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='session-', dir=tool_dir) as cwd:
                config = Path(cwd) / 'config.yml'
                config.write_text('{}\n', encoding='utf-8')
                command = [tool, 'tunnel', '--config', str(config), '--no-autoupdate',
                           '--protocol', 'http2', '--url', f'http://127.0.0.1:{self.port}',
                           '--metrics', '127.0.0.1:0']
                self._progress('connecting', '正在生成远程二维码…')
                with self.lock:
                    if self.cancel.is_set():
                        return
                    self.process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                        encoding='utf-8', errors='replace',
                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    process = self.process
                threading.Thread(target=self._timeout, daemon=True).start()
                active_connections = set()
                with process.stdout:
                    for line in process.stdout:
                        if self.cancel.is_set():
                            break
                        match = URL_RE.search(line)
                        with self.lock:
                            if self.status == 'error':
                                continue
                            if match:
                                self.url = match.group(0)
                            index = re.search(r'connIndex=(\d+)', line)
                            index = index.group(1) if index else '0'
                            if 'Registered tunnel connection' in line and self.url:
                                active_connections.add(index)
                                self.status = 'ready'
                                self.message = '手机可使用移动数据或任意 Wi-Fi 扫码'
                                self.connected.set()
                            elif 'Retrying connection' in line or 'Unregistered tunnel connection' in line:
                                active_connections.discard(index)
                                if not active_connections:
                                    self.status = 'connecting'
                                    self.message = '互联网连接暂时中断，正在自动恢复…'
                process.wait()
                self._fail('互联网连接已断开，请点击“重试连接”生成新二维码')
        except Exception as exc:
            message = str(exc) if isinstance(exc, RuntimeError) else '无法启动互联网连接，请检查电脑网络后重试'
            self._fail(message)

    def stop(self):
        with self.lock:
            self.cancel.set()
            self.connected.set()
            self.status, self.message = 'closed', '互联网连接已关闭'
            process = self.process
        self._terminate(process)
