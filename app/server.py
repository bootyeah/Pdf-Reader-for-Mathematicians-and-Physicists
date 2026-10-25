"""Lightweight HTTP server core and routing hub for PDF Reader Pro."""
import http.server
import os
import sys
import re
import json
import time
import io
import html
import hashlib
import functools
import threading
import urllib.request
import urllib.error
import urllib.parse
from http.cookies import SimpleCookie, CookieError

# Add project root to sys.path
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

import api_settings
from app import routes
from app.services import cloud_sync, tikz_compiler, video_service, tunnel_service, formula_service
from app.utils import console, browser_close

# Windows Per-Monitor V2 High DPI awareness
try:
    import ctypes
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(-4)
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
except Exception:
    pass

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

PORT = 8080
_DIALOG_LOCK = threading.Lock()
_SHUTDOWN_LOCK = threading.Lock()

DEEPSEEK_API_KEY = ""
CHAT_API_KEY = ""
DEEPSEEK_MODEL = "deepseek-flash"
DEEPSEEK_FALLBACK_MODEL = "deepseek-v4-flash"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_VISION = {
    'base_url': DEEPSEEK_BASE_URL,
    'model': DEEPSEEK_MODEL,
    'fallback_model': DEEPSEEK_FALLBACK_MODEL,
}
DEEPSEEK_DISABLE_THINKING = True
ENABLE_WEB_SEARCH = False
PROXY = ""

CLOUD_SYNC = cloud_sync.CLOUD_SYNC
_CLOUD_WRITE_LOCK = cloud_sync._CLOUD_WRITE_LOCK
_CLOUD_LIST_CACHE = cloud_sync._CLOUD_LIST_CACHE
_CLOUD_LIST_TTL = cloud_sync._CLOUD_LIST_TTL
_CLOUD_BRANCH_CACHE = cloud_sync._CLOUD_BRANCH_CACHE
_CLOUD_CONTENTS_LIMIT = cloud_sync._CLOUD_CONTENTS_LIMIT
_CLOUD_ILLEGAL_RE = cloud_sync._CLOUD_ILLEGAL_RE
_CLOUD_RESERVED = cloud_sync._CLOUD_RESERVED

# Expose cloud sync functions for backward compatibility and tests
_cloud_config = cloud_sync._cloud_config
_cloud_is_configured = cloud_sync._cloud_is_configured
_cloud_opener = cloud_sync._cloud_opener
_cloud_message = cloud_sync._cloud_message
_cloud_friendly = cloud_sync._cloud_friendly
_repair_surrogates = cloud_sync._repair_surrogates
_utf8_safe = cloud_sync._utf8_safe
_cloud_request = cloud_sync._cloud_request
_cloud_branch = cloud_sync._cloud_branch
_cloud_api_path = cloud_sync._cloud_api_path
_cloud_quote = cloud_sync._cloud_quote
_cloud_sanitize = cloud_sync._cloud_sanitize
_cloud_base_filename = cloud_sync._cloud_base_filename
_cloud_rel_dir = cloud_sync._cloud_rel_dir
_cloud_key = cloud_sync._cloud_key
_cloud_get_file = cloud_sync._cloud_get_file
_cloud_entry_meta = cloud_sync._cloud_entry_meta
_cloud_hydrate_entry = cloud_sync._cloud_hydrate_entry
_cloud_hydrate_entries = cloud_sync._cloud_hydrate_entries
_cloud_list_files = cloud_sync._cloud_list_files
_cloud_put_file = cloud_sync._cloud_put_file
_cloud_put_file_large = cloud_sync._cloud_put_file_large
_cloud_now_iso = cloud_sync._cloud_now_iso
_cloud_count_annotations = cloud_sync._cloud_count_annotations
_cloud_save = cloud_sync._cloud_save
_cloud_status = cloud_sync._cloud_status
_cloud_test = cloud_sync._cloud_test

ENTRY_PROMPT = (
    "你是一名专业的英汉双语词典。用户会从 PDF 里框选一个词条来查询：可能是一个单词，"
    "也可能是词组、固定搭配或习语。\n"
    "⚠️ PDF 框选经常夹带首尾空白、换行或词间多余空格（例如想查 account 却框成了 "
    "\"accou nt\"），请先还原出用户真正想查的词条，再判断它是单词还是短语。\n\n"
    "严格只输出一个 JSON 对象，不要输出任何 JSON 之外的文字，不要用 ``` 代码块包裹。\n\n"
    "若还原后是一个单词（含 well-known 这类连字符合成词，以及 accou nt 这类被空格拆断的拼写）→ "
    "type 填 \"word\"，输出：\n"
    '{"type":"word","word":"单词原形","phonetic":"音标","pos":"词性","definition_en":"英文释义",'
    '"definition_zh":"中文释义","examples":[{"en":"英文例句","zh":"例句中文翻译"}]}\n\n'
    "若还原后是两个及以上单词构成的词组、固定搭配或习语（如 take into account、as far as I know）→ "
    "type 填 \"phrase\"，输出：\n"
    '{"type":"phrase","phrase":"短语原形","meaning_zh":"中文意思","meaning_en":"英文释义",'
    '"usage":"用法说明（英文）","examples":[{"en":"英文例句","zh":"例句中文翻译"}]}\n\n'
    "要求：\n"
    "1. word / phrase 字段填还原后的规范形式；固定搭配里的人或物用 sb / sth 占位（如 take sth into account）。\n"
    "2. 单词条目 examples 给 1~2 个；短语条目 examples 给 2~3 个完整例句，要能体现该词条的典型用法。\n"
    "3. definition_zh / meaning_zh 用简体中文给出最贴切的意思，多个义项用「；」分隔、最多 3 个；"
    "definition_en / meaning_en 用一句英文解释。\n"
    "4. 短语条目的 usage 一律用英文书写：用英文句子解释，不要写中文句子，也不要用「成语」「术语」"
    "这类中文标签（写 a Chinese idiom / a technical term）。只有引用该词条本身的中文搭配时才可出现汉字。"
    "内容涵盖适用语境、语体色彩、常见搭配、句法特点（如能否拆分、后接动词用什么形式），2~3 句，不要照抄例句。\n"
    "5. 例句一律「英文原句 + 中文翻译」成对给出。\n"
    "6. 输入是中文时（如「模型」「据为己有」「深度学习模型」）：按它在汉语里的实际情况判断是词、"
    "术语还是成语，词组/成语按 phrase 结构输出；单词条目里的 phonetic 填拼音；"
    "usage 同样用纯英文，meaning_zh 仍用中文。\n"
    "7. 只输出一种结构，不要同时给出 word 和 phrase 两套字段。"
)

SENTENCE_PROMPT = (
    "你是一名专业翻译。将用户给出的内容翻译成自然流畅的译文。\n"
    "规则：英文翻译成简体中文；中文翻译成英文；其他语言一律翻译成简体中文。\n"
    "只输出译文本身，不要任何解释、注释或前缀，不要用引号包裹。"
)

CHAT_SYSTEM_PROMPT = (
    "你是一名嵌入在本地 PDF 阅读器里的 AI 学习助手，用户多为理工科学生与研究者。\n"
    "要求：\n"
    "1. 回答准确、简洁、结构清晰；能用公式说清的就不用冗长文字，重点内容用 Markdown 标题、"
    "列表或表格组织。\n"
    "2. 所有数学公式一律用 LaTeX 表示：行内用 $...$，独立成行用 $$...$$，"
    "不要使用 \\( \\) 或 \\[ \\] 这两种定界符（渲染器不支持）。\n"
    "3. 用户可能直接粘贴教材截图、题目照片或 PDF 页面截图，请先读图再回答；"
    "图中看不清或不确定的地方要明确说明，不要编造。\n"
    "4. 除非用户要求，不要复述题目，直接给解答与结论。\n"
    "5. 需要图形时（函数图像、几何/受力示意、流程图与框图、电路、树/自动机/状态机等）"
    "直接画 TikZ：阅读器会把回答里的 TikZ 交给本地 LaTeX 引擎编译成矢量图显示出来。写法要求：\n"
    "   · 用 ```tikz 围栏包住完整代码，只写 \\begin{tikzpicture} ... \\end{tikzpicture}"
    "（或 tikzcd / circuitikz / forest / axis 等环境本身），"
    "绝不要写 \\documentclass、\\usepackage、\\begin{document} 等导言区内容；\n"
    "   · tikz、tikz-cd、pgfplots、circuitikz、forest、chemfig、physics 以及 calc、positioning、"
    "arrows.meta、shapes.geometric、decorations.pathmorphing、patterns、matrix、fit、chains、"
    "automata、mindmap 等常用库都已预装，直接用即可；不要用 \\includegraphics 或任何外部图片；\n"
    "   · 图里可以写中文（有中文时引擎会自动加载 ctex），公式照常用 $...$；\n"
    "   · 代码必须能独立编译成功：括号配对、坐标合法、只用上面这些宏包里的命令；"
    "宁可画得简单，也不要写出编译不过的代码；\n"
    "   · 用户要求改图时，重新给出完整的 TikZ 代码，不要只给片段或差异；\n"
    "   · 只在真的有助于理解时才画图，不要为了凑数而画。"
)

CHAT_MAX_MESSAGES = 60
CHAT_MAX_IMAGE_CHARS = 14 * 1024 * 1024
CHAT_MAX_IMAGES = 8

_JSON_OBJ_RE = re.compile(r'\{[\s\S]*\}')

# TikZ symbols re-export
_TIKZ_CACHE = tikz_compiler._TIKZ_CACHE
_TIKZ_CACHE_LOCK = tikz_compiler._TIKZ_CACHE_LOCK
_TIKZ_INFLIGHT = tikz_compiler._TIKZ_INFLIGHT
_TIKZ_CACHE_MAX = tikz_compiler._TIKZ_CACHE_MAX
_TIKZ_COMPILE_SLOTS = tikz_compiler._TIKZ_COMPILE_SLOTS
_tikz_error_detail = tikz_compiler._tikz_error_detail
render_latex_to_svg = tikz_compiler.render_latex_to_svg
render_tikz_cached = tikz_compiler.render_tikz_cached

hide_console_window = console.hide_console_window


def _api_config(feature):
    defaults = dict(api_settings.COMMON, base_url=DEEPSEEK_BASE_URL,
                    model=DEEPSEEK_MODEL, fallback_model=DEEPSEEK_FALLBACK_MODEL,
                    api_key=DEEPSEEK_API_KEY, proxy=PROXY, timeout=120,
                    temperature=0.3, thinking='disabled' if DEEPSEEK_DISABLE_THINKING else 'omit',
                    web_search=ENABLE_WEB_SEARCH, prompt=ENTRY_PROMPT)
    if feature == 'chat':
        defaults.update(api_key=CHAT_API_KEY or DEEPSEEK_API_KEY, temperature=0.7,
                        thinking='disabled', web_search=False, prompt=CHAT_SYSTEM_PROMPT,
                        models=['deepseek-v4-pro'])
    elif feature == 'translation':
        defaults['prompt'] = SENTENCE_PROMPT
    elif feature == 'formula_alt':
        defaults = dict(DEEPSEEK_VISION, api_key=CHAT_API_KEY or DEEPSEEK_API_KEY)
    elif feature == 'chat_gemini':
        defaults = dict(api_settings.GEMINI_CHAT_DEFAULT)
    return api_settings.resolve(feature, defaults)


def _detect_entry_kind(content):
    text = (content or '').strip()
    if not text:
        return None
    data = None
    try:
        data = json.loads(text)
    except Exception:
        m = _JSON_OBJ_RE.search(text)
        if m:
            try:
                data = json.loads(m.group(0))
            except Exception:
                data = None
    if not isinstance(data, dict):
        return None
    kind = str(data.get('type') or '').strip().lower()
    if kind in ('word', 'phrase'):
        return kind
    if data.get('usage') or data.get('phrase') or data.get('meaning_zh'):
        return 'phrase'
    if data.get('word') or data.get('definition_zh') or data.get('phonetic'):
        return 'word'
    return None


def _friendly_api_error(status, detail):
    text = (detail or '').strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
            parsed = parsed[0]  # Gemini 的 OpenAI 兼容端点把错误包在数组里
        if isinstance(parsed, dict):
            text = str((parsed.get('error') or {}).get('message') or parsed.get('message') or text)
    except Exception:
        pass
    if status == 401:
        hint = 'API 密钥无效或已过期，请打开 API-Manager.bat 检查此功能的 Key'
    elif status == 402:
        hint = '账户余额不足'
    elif status == 429:
        hint = '请求过于频繁，请稍后重试'
    elif status in (400, 422):
        hint = '请求被拒绝（多为图片格式不支持：仅接受 PNG / JPEG / WebP / GIF）'
    elif status >= 500:
        hint = '模型服务端错误或繁忙，请稍后重试'
    else:
        hint = '请求失败'
    return '%s（HTTP %s）%s' % (hint, status, ('：' + text[:300]) if text else '')


if sys.platform == 'win32':
    # On Windows, SO_REUSEADDR allows multiple sockets to bind to the same port simultaneously,
    # causing socket hijacking where one process swallows all requests and the other is silent.
    http.server.ThreadingHTTPServer.allow_reuse_address = False


class PDFReaderHandler(http.server.SimpleHTTPRequestHandler):
    _READER_ASSET_EXTENSIONS = frozenset(('.html', '.htm', '.js', '.css', '.woff', '.woff2', '.ttf', '.otf', '.bcmap', '.svg'))

    def _get_dialog_lock(self):
        return getattr(sys.modules.get('server'), '_DIALOG_LOCK', _DIALOG_LOCK)

    def _api_config(self, feature):
        return _api_config(feature)

    def _reader_file_bytes(self, path):
        with open(path, 'rb') as source:
            return source.read()

    def translate_path(self, path):
        try:
            url = urllib.parse.urlsplit(path)
            decoded = urllib.parse.unquote(url.path, errors='strict').replace('\\', '/')
        except (ValueError, UnicodeError) as exc:
            raise PermissionError('Invalid resource path') from exc
        parts = [part for part in decoded.split('/') if part not in ('', '.')]
        if (url.scheme or url.netloc or decoded.startswith('//') or '\x00' in decoded
                or any(part == '..' or ':' in part for part in parts)):
            raise PermissionError('Invalid resource path')

        explicit_static = bool(parts and parts[0].lower() == 'static')
        if explicit_static:
            parts = parts[1:]
        relative = '/'.join(parts)
        if relative.lower() in ('', 'index.html', 'localpdfreader.html'):
            relative = 'index.html'
        elif relative.lower() == 'style.css':
            relative = 'css/style.css'

        # All UI URLs, including legacy aliases, share one authoritative copy.
        # Preserve direct project-relative PDF URLs without exposing other root files.
        root = os.path.realpath(self.directory)
        base = root if not explicit_static and relative.lower().endswith('.pdf') else os.path.join(root, 'static')
        base = os.path.realpath(base)
        target = os.path.realpath(os.path.join(base, *relative.split('/')))
        try:
            contained = os.path.normcase(os.path.commonpath((base, target))) == os.path.normcase(base)
        except ValueError:
            contained = False
        if not contained:
            raise PermissionError('Resource is outside its allowed directory')
        return target

    def _reader_asset_url(self, relative):
        url = urllib.parse.urlsplit(relative)
        path = urllib.parse.urljoin(self.path, url.path)
        try:
            digest = hashlib.sha256(self._reader_file_bytes(self.translate_path(path))).hexdigest()
        except OSError:
            return relative
        query = [(key, value) for key, value in urllib.parse.parse_qsl(url.query, keep_blank_values=True) if key != '_readerAsset']
        query.append(('_readerAsset', digest))
        return urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(query)))

    def _send_reader_asset(self, path):
        try:
            body = self._reader_file_bytes(path)
        except OSError:
            self.send_error(404, 'File not found')
            return None
        digest = hashlib.sha256(body).hexdigest()
        etag = '"' + digest + '"'
        version = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('_readerAsset', [''])[0]
        policy = 'public, max-age=31536000, immutable' if version == digest else 'no-cache'
        validators = [value.strip().removeprefix('W/') for value in self.headers.get('If-None-Match', '').split(',')]
        unchanged = etag in validators or '*' in validators
        self.send_response(304 if unchanged else 200)
        self.send_header('Cache-Control', policy)
        self.send_header('ETag', etag)
        if unchanged:
            self.end_headers()
            return None
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        return io.BytesIO(body)

    def _send_reader_html(self, path):
        try:
            with open(path, 'rb') as source:
                body = source.read().decode('utf-8')
                modified = os.fstat(source.fileno()).st_mtime
        except OSError:
            self.send_error(404, 'File not found')
            return None

        def version_asset(match):
            url = urllib.parse.urlsplit(html.unescape(match.group('url')))
            if url.scheme or url.netloc or os.path.splitext(url.path)[1].lower() not in ('.js', '.css'):
                return match.group(0)
            fresh = self._reader_asset_url(html.unescape(match.group('url')))
            return match.group('prefix') + html.escape(fresh, quote=True) + match.group('suffix')

        body = re.sub(r'''(?P<prefix>\b(?:src|href)\s*=\s*["'])(?P<url>[^"'<>]*)(?P<suffix>["'])''', version_asset, body)
        workers = {relative: self._reader_asset_url(relative) for relative in ('./lib/pdf.worker.min.js', './js/annotation-worker.js')}
        manifest = '<script>window.__readerWorkerAssets=' + json.dumps(workers).replace('<', '\\u003c') + ';</script>'
        body = (manifest + body).encode('utf-8') if '</head>' not in body else body.replace('</head>', manifest + '</head>', 1).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Last-Modified', self.date_time_string(modified))
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('X-Reader-Root', hashlib.sha256(os.path.normcase(os.path.realpath(self.directory)).encode('utf-8')).hexdigest())
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
        except CookieError:
            pass
        if cookies.get('readerCachePolicy') is None or cookies['readerCachePolicy'].value != 'content-v1':
            self.send_header('Clear-Site-Data', '"cache"')
            self.send_header('Set-Cookie', 'readerCachePolicy=content-v1; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly')
        self.end_headers()
        return io.BytesIO(body)

    def do_HEAD(self):
        if not self._allow_local_api():
            return
        if urllib.parse.urlsplit(self.path).path == '/api/video':
            video_service.serve(self, head=True)
            return
        if urllib.parse.urlsplit(self.path).path == '/api/bilibili/media':
            routes.handle_bilibili_media(self)
            return
        if urllib.parse.urlsplit(self.path).path == '/api/bilibili/manifest':
            routes.handle_bilibili_manifest(self)
            return
        super().do_HEAD()

    def send_head(self):
        try:
            path = self.translate_path(self.path)
        except PermissionError:
            self.send_error(403)
            return None
        parts = os.path.normpath(path).replace('\\', '/').lower().split('/')
        if (any(p in ('airtex', 'tex', '.api-manager', '__pycache__') for p in parts)
                or any(p.startswith('.') for p in parts)
                or os.path.splitext(path)[1].lower() in ('.py', '.pyw', '.pyc', '.json', '.bak', '.log', '.tmp')):
            self.send_error(403)
            return None
        if os.path.basename(path).lower() in ('localpdfreader.html', 'index.html'):
            return self._send_reader_html(path)
        if os.path.splitext(path)[1].lower() in self._READER_ASSET_EXTENSIONS:
            return self._send_reader_asset(path)
        return super().send_head()

    def list_directory(self, path):
        self.send_error(403)
        return None

    def _shutdown_server(self, token=''):
        with _SHUTDOWN_LOCK:
            if getattr(PDFReaderHandler, '_shutting_down', False):
                return
            PDFReaderHandler._shutting_down = True
        hide_console_window()

        def finish():
            try:
                formula_service.close_all()
            except Exception:
                pass
            try:
                sys.stdout.flush()
                sys.stderr.flush()
            except Exception:
                pass
            os._exit(0)

        # Frontend retains its unique title until native tab closing has finished.
        # A watchdog still guarantees engine exit if a browser API stalls.
        def watchdog():
            time.sleep(2.8)
            finish()

        def close_tabs():
            time.sleep(0.2)
            try:
                browser_close.close_marked_reader_tabs(token)
            except Exception as error:
                print('[退出] 自动关闭标签页失败:', error)
            finally:
                finish()

        threading.Thread(target=watchdog, daemon=True).start()
        threading.Thread(target=close_tabs, daemon=True).start()


    def _allow_local_api(self):
        is_api = urllib.parse.urlsplit(self.path).path.startswith('/api/')
        host = self.headers.get('Host', '')
        try:
            authority = urllib.parse.urlsplit('http://' + host)
            valid_host = (authority.hostname in ('127.0.0.1', 'localhost')
                          and authority.port == self.server.server_port
                          and authority.username is None and not authority.path
                          and not authority.query and not authority.fragment)
            origin = self.headers.get('Origin')
            valid_origin = not origin or origin.rstrip('/').lower() == ('http://' + host).lower()
        except ValueError:
            valid_host = valid_origin = False
        if not is_api:
            if not valid_host:
                self.send_error(403)
            return valid_host
        if valid_host and valid_origin and self.headers.get('Sec-Fetch-Site') != 'cross-site':
            return True
        if self.command == 'POST':
            formula_service._drain_request(self)
        self._json_response(403, {'ok': False, 'error': '只允许本机阅读器页面调用此接口'})
        return False

    def _json_response(self, status, obj):
        try:
            safe_obj, _ = _utf8_safe(obj)
            body = json.dumps(safe_obj, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, OSError):
            pass

    def _cloud_cfg_or_error(self):
        cfg_fn = getattr(sys.modules.get('server'), '_cloud_config', _cloud_config)
        cfg = cfg_fn()
        if not _cloud_is_configured(cfg):
            return cfg, {
                'ok': True,
                'configured': False,
                'enabled': bool(cfg.get('enabled')),
                'provider': cfg.get('provider'),
                'message': '云端批注库未启用（在 server.py 顶部的 CLOUD_SYNC 或 cloud_config.json 中配置）',
            }
        return cfg, None

    def _deepseek_vision(self):
        return _api_config('formula_alt')

    def _validate_chat_messages(self, messages):
        if not isinstance(messages, list) or not messages:
            return None, '对话内容为空'
        cleaned = []
        for m in messages[-CHAT_MAX_MESSAGES:]:
            if not isinstance(m, dict):
                continue
            role = m.get('role')
            if role not in ('user', 'assistant'):
                continue
            content = m.get('content')
            if isinstance(content, str):
                text = content.strip()
                if text:
                    cleaned.append({'role': role, 'content': text})
                continue
            if not isinstance(content, list):
                continue
            parts = []
            images = 0
            for part in content:
                if not isinstance(part, dict):
                    continue
                ptype = part.get('type')
                if ptype == 'text':
                    text = str(part.get('text') or '').strip()
                    if text:
                        parts.append({'type': 'text', 'text': text})
                elif ptype == 'image_url' and role == 'user':
                    url = ((part.get('image_url') or {}).get('url') or '').strip()
                    if not url:
                        continue
                    if len(url) > CHAT_MAX_IMAGE_CHARS:
                        return None, '图片过大（单张上限约 10 MB），请压缩后再发送'
                    if images >= CHAT_MAX_IMAGES:
                        return None, '单条消息最多携带 %d 张图片' % CHAT_MAX_IMAGES
                    images += 1
                    parts.append({'type': 'image_url', 'image_url': {'url': url}})
            if parts:
                cleaned.append({'role': role, 'content': parts})
        if not cleaned:
            return None, '对话内容为空'
        if cleaned[-1].get('role') != 'user':
            return None, '最后一轮必须是用户消息'
        return cleaned, None

    def _call_deepseek_stream(self, messages, model, stream,
                              enable_thinking=False, temperature=0.7, max_tokens=0):
        cfg = getattr(self, '_active_chat_config', None) or _api_config('chat')
        body = {
            'model': model or cfg['model'],
            'messages': messages,
            'stream': bool(stream),
            'temperature': temperature,
        }
        if cfg.get('thinking') != 'omit':
            body['thinking'] = {'type': 'enabled' if enable_thinking else 'disabled'}
        if max_tokens > 0:
            body['max_tokens'] = max_tokens
        if cfg.get('web_search'):
            body['tools'] = [{'type': 'web_search'}]

        def request(payload):
            req = urllib.request.Request(
                api_settings.completion_url(cfg['base_url']),
                data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg['api_key']},
                method='POST')
            return api_settings.open_request(req, cfg)
        try:
            return request(body)
        except urllib.error.HTTPError as exc:
            fallback = cfg.get('fallback_model', '')
            if exc.code not in (400, 404, 429, 503) or not fallback or fallback == body['model']:
                raise
            exc.close()
            return request(dict(body, model=fallback))

    def _chat_stream(self, messages, model, enable_thinking, temperature, max_tokens):
        try:
            resp = self._call_deepseek_stream(messages, model, True, enable_thinking, temperature, max_tokens)
        except urllib.error.HTTPError as e:
            detail = self._safe_read(e)
            self._json_response(e.code if 400 <= e.code < 600 else 502,
                                {'ok': False, 'error': _friendly_api_error(e.code, detail)})
            return
        except urllib.error.URLError as e:
            self._json_response(502, {'ok': False, 'error': '无法连接模型 API（Gemini 需可用的系统代理）：%s' % e.reason})
            return
        except Exception as e:
            self._json_response(502, {'ok': False, 'error': '请求异常：%s' % e})
            return

        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()

        done_sent = False
        try:
            for raw_line in resp:
                line = raw_line.decode('utf-8', errors='replace').strip()
                if not line or not line.startswith('data:'):
                    continue
                payload = line[5:].strip()
                if payload == '[DONE]':
                    break
                try:
                    chunk = json.loads(payload)
                except Exception:
                    continue

                if chunk.get('error'):
                    self._sse({'error': api_settings.redact(str(chunk['error'])[:400], self._active_chat_config)})
                    done_sent = True
                    break
                choices = chunk.get('choices') or []
                if not choices:
                    continue
                delta = choices[0].get('delta') or {}
                frame = {}
                if delta.get('content'):
                    frame['delta'] = delta['content']
                if delta.get('reasoning_content'):
                    frame['reasoning'] = delta['reasoning_content']
                if frame:
                    self._sse(frame)
                if chunk.get('usage'):
                    self._sse({'usage': chunk['usage']})
        except Exception as e:
            try:
                self._sse({'error': '连接中断：%s' % e})
                done_sent = True
            except Exception:
                pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

        if not done_sent:
            try:
                self._sse({'done': True})
            except Exception:
                pass

    def _sse(self, obj):
        self.wfile.write(('data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n').encode('utf-8'))
        self.wfile.flush()

    def _chat_once(self, messages, model, enable_thinking, temperature, max_tokens):
        try:
            with self._call_deepseek_stream(messages, model, False, enable_thinking, temperature, max_tokens) as resp:
                payload = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            detail = self._safe_read(e)
            return {'ok': False, 'error': _friendly_api_error(e.code, detail)}
        except urllib.error.URLError as e:
            return {'ok': False, 'error': '无法连接模型 API（Gemini 需可用的系统代理）：%s' % e.reason}
        except Exception as e:
            return {'ok': False, 'error': '请求异常：%s' % e}

        try:
            message = payload['choices'][0]['message']
        except Exception:
            return {'ok': False, 'error': '模型返回了空结果'}
        content = message.get('content') or ''
        if not content.strip():
            return {'ok': False, 'error': '模型返回了空结果'}
        return {'ok': True, 'content': content,
                'reasoning': message.get('reasoning_content') or '',
                'usage': payload.get('usage') or {}}

    def _safe_read(self, http_error):
        try:
            return api_settings.redact(http_error.read().decode('utf-8', errors='replace'),
                                       getattr(self, '_active_chat_config', None) or _api_config('chat'))
        except Exception:
            return ''

    def _build_translate_prompt(self, mode):
        cfg = getattr(self, '_active_translate_config', None) or _api_config('dictionary' if mode == 'word' else 'translation')
        return cfg['prompt'], None if mode == 'word' else 'sentence'

    def _call_deepseek(self, messages, use_search=False, model=None, disable_thinking=None):
        cfg = getattr(self, '_active_translate_config', None) or _api_config('dictionary')
        if disable_thinking is None:
            disable_thinking = cfg['thinking'] != 'omit'
        body = {
            "model": model or cfg['model'],
            "messages": messages,
            "temperature": cfg['temperature'],
            "stream": False,
        }
        if disable_thinking:
            body["thinking"] = {"type": cfg['thinking']}
        if cfg.get('max_tokens', 0):
            body['max_tokens'] = int(cfg['max_tokens'])
        if use_search:
            body["tools"] = [{"type": "web_search"}]

        url = api_settings.completion_url(cfg['base_url'])
        req = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + cfg['api_key'],
            },
            method='POST',
        )

        try:
            with api_settings.open_request(req, cfg) as resp:
                payload = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode('utf-8', errors='replace')
            except Exception:
                detail = ''
            return {'ok': False, 'error': '模型 API 错误 %s: %s' % (e.code, api_settings.redact(detail[:400], cfg)), 'status': e.code}
        except urllib.error.URLError as e:
            return {'ok': False, 'error': '无法连接 DeepSeek API：%s' % e.reason, 'status': 0}
        except Exception as e:
            return {'ok': False, 'error': '请求异常：%s' % e, 'status': 0}

        try:
            content = payload['choices'][0]['message']['content']
        except Exception:
            content = ''
        if not (content or '').strip():
            return {'ok': False, 'error': '模型返回了空结果', 'status': 0, 'empty': True}
        return {'ok': True, 'content': content}

    def translate(self, text, mode):
        cfg = self._active_translate_config = _api_config('dictionary' if mode == 'word' else 'translation')
        system, kind = self._build_translate_prompt(mode)
        messages = [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': text},
        ]
        attempts = []
        has_thinking = cfg['thinking'] != 'omit'
        if cfg['web_search']:
            attempts.append((cfg['model'], True, has_thinking))
        attempts.append((cfg['model'], False, has_thinking))
        if has_thinking:
            attempts.append((cfg['model'], False, False))
        if cfg['fallback_model'] and cfg['fallback_model'] != cfg['model']:
            attempts.append((cfg['fallback_model'], False, has_thinking))

        last = {'ok': False, 'error': '未知错误', 'status': 0}
        unavailable = set()
        for model, use_search, disable_thinking in attempts:
            if model in unavailable:
                continue
            result = self._call_deepseek(messages, use_search=use_search,
                                         model=model, disable_thinking=disable_thinking)
            if result.get('ok'):
                result['kind'] = kind or _detect_entry_kind(result.get('content'))
                print("[词典] %s(%s) → %s" % (mode, result.get('kind') or '未定', text[:60]))
                return result
            last = result
            if result.get('status') in (429, 503):
                unavailable.add(model)
            if not result.get('empty') and result.get('status') not in (400, 404, 429, 503):
                return result
        return last

    def render_tikz_cached(self, tex_code):
        return tikz_compiler.render_tikz_cached(tex_code, compiler=getattr(self, 'render_latex_to_svg', None))

    def render_latex_to_svg(self, tex_code):
        return tikz_compiler.render_latex_to_svg(tex_code)

    def do_GET(self):
        try:
            if not routes.dispatch_get(self):
                super().do_GET()
        except (ConnectionError, OSError) as exc:
            if getattr(exc, 'winerror', None) == 10053 or isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
                return
            raise

    def do_POST(self):
        try:
            routes.dispatch_post(self)
        except (ConnectionError, OSError) as exc:
            if getattr(exc, 'winerror', None) == 10053 or isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
                return
            raise

    def log_message(self, format, *args):
        if self.path.startswith('/.well-known/appspecific/'):
            return
        super().log_message(format, *args)

    def log_request(self, code='-', size='-'):
        if (self.command == 'POST' and urllib.parse.urlsplit(self.path).path == '/api/formula/phone'
                and getattr(self, '_formula_state_poll', False) and str(code) == '200'):
            return
        super().log_request(code, size)


def _launch_browser(url):
    """在服务端口就绪后唤起系统默认浏览器，避免在服务启动完成前打开网页导致短暂报错。"""
    try:
        import webbrowser
        if not webbrowser.open(url):
            import subprocess
            subprocess.Popen(['cmd', '/c', 'start', '', url], shell=False)
    except Exception:
        try:
            import subprocess
            subprocess.Popen(['cmd', '/c', 'start', '', url], shell=False)
        except Exception:
            pass


def main():
    root_dir = _PROJECT_ROOT
    no_browser = ('--no-browser' in sys.argv) or (os.environ.get('PDF_READER_NO_BROWSER') == '1')
    launch_id = os.environ.get('READER_LAUNCH_ID')
    if not launch_id:
        import uuid
        launch_id = uuid.uuid4().hex
    entry_url = os.environ.get('READER_ENTRY_URL') or f"http://127.0.0.1:{PORT}/index.html?_readerLoad={launch_id}"

    handler_class = functools.partial(PDFReaderHandler, directory=root_dir)
    httpd = None
    for attempt in range(5):
        try:
            httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler_class)
            break
        except OSError as exc:
            is_port_in_use = (getattr(exc, 'winerror', None) == 10048) or (getattr(exc, 'errno', None) in (48, 98, 10048))
            if not is_port_in_use:
                raise
            # 只复用本目录的阅读器，其他目录或其他应用占用端口时明确报错。
            if attempt == 0:
                try:
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    with opener.open(f"http://127.0.0.1:{PORT}/index.html", timeout=0.6) as probe:
                        expected_root = hashlib.sha256(os.path.normcase(os.path.realpath(root_dir)).encode('utf-8')).hexdigest()
                        if probe.status == 200 and probe.headers.get('X-Reader-Root') == expected_root:
                            print(f"📁 启动器所在文件夹: {root_dir}")
                            print(f"💡 PDF Reader Pro 核心引擎已在运行中: http://127.0.0.1:{PORT}/")
                            if not no_browser:
                                _launch_browser(entry_url)
                            return 0
                except Exception:
                    pass
            # 等待正在退出的实例释放端口。
            time.sleep(0.35)

    if not httpd:
        print(f"📁 启动器所在文件夹: {root_dir}")
        print(f"❌ 端口 {PORT} 被其他服务或旧版阅读器占用。请先关闭原服务，再启动此目录的阅读器。")
        return 1

    with httpd:
        print(f"📁 启动器所在文件夹: {root_dir}")
        print(f"🚀 PDF Reader Pro 核心引擎已启动: http://127.0.0.1:{PORT}/")
        print(f"🔒 已限制为本机回环访问 (仅 127.0.0.1 可连接)")
        print(f"⚡ 成功接驳本地 TeX Live 2022 矢量绘图系统")
        if not no_browser:
            threading.Thread(target=_launch_browser, args=(entry_url,), daemon=True).start()
        try:
            httpd.serve_forever()
        finally:
            formula_service.close_all()


if __name__ == '__main__':
    sys.exit(main())
