"""TikZ / XeLaTeX vector compilation and caching service."""
import base64
import hashlib
import os
import subprocess
import tempfile
import threading

_TIKZ_CACHE = {}
_TIKZ_CACHE_LOCK = threading.Lock()
_TIKZ_INFLIGHT = {}
_TIKZ_CACHE_MAX = 120
_TIKZ_COMPILE_SLOTS = threading.Semaphore(2)


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
    import re
    tex_code = re.sub(
        r'\(\s*([A-Za-z][A-Za-z0-9_@-]*)\s*(?:\.\s*([A-Za-z0-9_@ -]+?)\s*)?\)',
        lambda m: f"({m.group(1)}.{m.group(2).strip()})" if m.group(2) else f"({m.group(1)})",
        tex_code,
    )
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
    """带缓存的 TikZ 编译：同一段源码只编译一次。"""
    if compiler is None:
        compiler = render_latex_to_svg
    key = hashlib.sha256(tex_code.encode('utf-8')).hexdigest()
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
    try:
        with _TIKZ_COMPILE_SLOTS:
            result = compiler(tex_code)
        return result
    finally:
        with _TIKZ_CACHE_LOCK:
            if result[0]:
                if len(_TIKZ_CACHE) >= _TIKZ_CACHE_MAX:
                    _TIKZ_CACHE.pop(next(iter(_TIKZ_CACHE)))
                _TIKZ_CACHE[key] = result
            pending['result'] = result
            _TIKZ_INFLIGHT.pop(key, None)
            pending['event'].set()
