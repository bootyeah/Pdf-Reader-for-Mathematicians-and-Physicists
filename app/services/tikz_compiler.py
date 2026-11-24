"""TikZ / XeLaTeX vector compilation and caching service."""
import base64
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading

_TIKZ_CACHE = {}
_TIKZ_CACHE_LOCK = threading.Lock()
_TIKZ_INFLIGHT = {}
_TIKZ_CACHE_MAX = 120
_TIKZ_COMPILE_SLOTS = threading.Semaphore(2)
_TIKZ_DISK_CACHE_VERSION = 'v1'
_TIKZ_DISK_CACHE_MAX = 300
_TIKZ_DISK_CACHE_DIR = Path(__file__).resolve().parents[2] / '.latex-manager' / 'tikz_cache'

_ANCHOR_RE = re.compile(
    r'(?<![A-Za-z0-9_\\])\(\s*([A-Za-z][A-Za-z0-9_@-]*)(?:'
    r'\s+\.\s*([A-Za-z0-9_@ -]+?)'
    r'|\.\s*((?:north|south)(?:\s+(?:east|west))?|(?:mid|base)(?:\s+(?:east|west))?|east|west|center|text)'
    r')?\s*\)'
)
_PATH_CMD_RE = re.compile(r'\\(?:draw|path|fill|filldraw|clip|shade|shadedraw|node|coordinate|pic)\b')
_BEGIN_END_RE = re.compile(r'\\(?:begin|end)\s*$')


def _read_tikz_disk_cache(key):
    try:
        p = _TIKZ_DISK_CACHE_DIR / f'{key}.b64'
        if not p.is_file():
            return None
        data = p.read_text(encoding='ascii').strip()
        if not data:
            return None
        try:
            os.utime(p, None)
        except OSError:
            pass
        return (data, '')
    except Exception:
        return None


def _write_tikz_disk_cache(key, svg_b64):
    if not svg_b64:
        return
    try:
        _TIKZ_DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        target = _TIKZ_DISK_CACHE_DIR / f'{key}.b64'
        tmp = _TIKZ_DISK_CACHE_DIR / f'{key}.{os.getpid()}.{threading.get_ident()}.tmp'
        tmp.write_text(svg_b64, encoding='ascii')
        os.replace(tmp, target)
        entries = list(_TIKZ_DISK_CACHE_DIR.glob('*.b64'))
        if len(entries) > _TIKZ_DISK_CACHE_MAX:
            entries.sort(key=lambda item: item.stat().st_mtime_ns if item.exists() else 0)
            for stale in entries[:max(0, len(entries) - _TIKZ_DISK_CACHE_MAX)]:
                try:
                    stale.unlink(missing_ok=True)
                except OSError:
                    pass
    except Exception:
        pass


def _tikz_error_detail(log_path, limit=300):
    """从 xelatex 的 .log 里挑出真正的报错行，给前端一句能看懂的提示。"""
    try:
        with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
            text = f.read()
    except Exception:
        return ''
    picked = []
    for raw in text.splitlines():
        line = raw.strip()
        if (line.startswith('!')
                or 'Undefined control sequence' in line
                or ('Package' in line and 'Error' in line)):
            picked.append(line)
        if len(picked) >= 3:
            break
    if not picked:
        picked = [l.strip() for l in text.strip().splitlines()[-3:] if l.strip()]
    return ' '.join(' '.join(picked).split())[:limit]


def render_latex_to_svg(tex_code):
    """编译一段完整 LaTeX 文档并转成 SVG。
    返回 (svg_base64, error_text)：成功时 error_text 为空字符串。"""
    def _clean_segment(seg):
        return _ANCHOR_RE.sub(
            lambda m: f"({m.group(1)}.{(m.group(2) or m.group(3)).strip()})"
            if (m.group(2) or m.group(3)) else f"({m.group(1)})",
            seg,
        )

    def _walk_tikz(src):
        out, buf, i, n = [], [], 0, len(src)
        while i < n:
            ch = src[i]
            if ch == '\\' and i + 1 < n and src[i + 1] in '{}$\\':
                buf.append(src[i:i + 2]); i += 2; continue
            if ch == '$':
                out.append(_clean_segment(''.join(buf))); buf.clear()
                delim = '$$' if src.startswith('$$', i) else '$'
                j = i + len(delim)
                while j < n:
                    if src[j] == '\\' and j + 1 < n:
                        j += 2; continue
                    if src.startswith(delim, j):
                        j += len(delim); break
                    j += 1
                out.append(src[i:j]); i = j; continue
            if ch == '{':
                prev = ''.join(buf)
                is_env = bool(_BEGIN_END_RE.search(prev))
                depth, j = 1, i + 1
                while j < n and depth > 0:
                    if src[j] == '\\' and j + 1 < n:
                        j += 2; continue
                    if src[j] == '{':
                        depth += 1
                    elif src[j] == '}':
                        depth -= 1
                    j += 1
                inner = src[i + 1:j - 1] if depth == 0 else src[i + 1:j]
                end_ch = '}' if depth == 0 else ''
                out.append(_clean_segment(prev)); buf.clear()
                if not is_env and _PATH_CMD_RE.search(inner):
                    out.append('{' + _walk_tikz(inner) + end_ch)
                else:
                    out.append('{' + inner + end_ch)
                i = j; continue
            buf.append(ch); i += 1
        if buf:
            out.append(_clean_segment(''.join(buf)))
        return ''.join(out)

    tex_code = _walk_tikz(tex_code)
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tempdir:
        tex_path = os.path.join(tempdir, 'temp.tex')
        svg_path = os.path.join(tempdir, 'temp.svg')
        log_path = os.path.join(tempdir, 'temp.log')

        with open(tex_path, 'w', encoding='utf-8') as f:
            f.write(tex_code)

        try:
            # 1. 调用 xelatex
            subprocess.run(
                ['xelatex', '-no-shell-escape', '-halt-on-error', '-interaction=nonstopmode', 'temp.tex'],
                cwd=tempdir,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=20,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            )

            # 2. 调用 dvisvgm
            subprocess.run(
                ['dvisvgm', '--pdf', 'temp.pdf', '--no-fonts', '-o', 'temp.svg'],
                cwd=tempdir,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=20,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            )

            # 3. 读取 SVG 并转为 Base64 发给前端
            with open(svg_path, 'rb') as f:
                svg_data = f.read()
                return base64.b64encode(svg_data).decode('ascii'), ''

        except subprocess.CalledProcessError:
            detail = _tikz_error_detail(log_path)
            print("❌ LaTeX 编译失败：%s" % (detail or '请检查语法'))
            return None, detail or 'LaTeX 编译失败（请检查 TikZ 语法）'
        except subprocess.TimeoutExpired:
            print("⏳ LaTeX 编译超时，已强行熔断")
            return None, '编译超时（图形过于复杂，或引擎被占用）'
        except Exception as e:
            print("❌ LaTeX 渲染异常：%s" % e)
            return None, '渲染异常：%s' % e


def render_tikz_cached(tex_code, compiler=None):
    """带内存与磁盘二级缓存的 TikZ 编译：同一段源码跨进程重启也只编译一次。"""
    use_disk_cache = (compiler is None or compiler is render_latex_to_svg)
    if compiler is None:
        compiler = render_latex_to_svg
    key_material = f'{_TIKZ_DISK_CACHE_VERSION}:{tex_code}' if use_disk_cache else tex_code
    key = hashlib.sha256(key_material.encode('utf-8')).hexdigest()
    with _TIKZ_CACHE_LOCK:
        hit = _TIKZ_CACHE.get(key)
        if hit is not None:
            return hit
        pending = _TIKZ_INFLIGHT.get(key)
        owner = pending is None
        if owner:
            pending = {'event': threading.Event()}
            _TIKZ_INFLIGHT[key] = pending
    if not owner:
        pending['event'].wait()
        return pending['result']
    result = (None, 'LaTeX 编译未完成')
    from_disk = False
    try:
        if use_disk_cache:
            disk_hit = _read_tikz_disk_cache(key)
            if disk_hit is not None:
                result = disk_hit
                from_disk = True
                return result
        with _TIKZ_COMPILE_SLOTS:
            result = compiler(tex_code)
        return result
    finally:
        if use_disk_cache and result[0] and not from_disk:
            _write_tikz_disk_cache(key, result[0])
        with _TIKZ_CACHE_LOCK:
            if result[0]:
                if len(_TIKZ_CACHE) >= _TIKZ_CACHE_MAX:
                    _TIKZ_CACHE.pop(next(iter(_TIKZ_CACHE)))
                _TIKZ_CACHE[key] = result
            pending['result'] = result
            _TIKZ_INFLIGHT.pop(key, None)
            pending['event'].set()
