"""Unified route dispatcher for PDF Reader Pro."""
import hashlib
import json
import math
import os
import sys
import tempfile
import urllib.parse
from app.services import cloud_sync, formula_service, video_service, online_video_service, bilibili_service
import api_settings


def handle_video(handler):
    video_service.serve(handler)


def handle_bilibili_media(handler):
    bilibili_service.serve(handler, head=handler.command == 'HEAD')


def handle_bilibili_manifest(handler):
    bilibili_service.serve_manifest(handler, head=handler.command == 'HEAD')


def _chat_providers(handler):
    """对话窗口的全部供应商：[(feature, cfg)]，「内置对话」在前，Gemini 在后。"""
    providers = [('chat', handler._api_config('chat'))]
    try:
        providers.append(('chat_gemini', handler._api_config('chat_gemini')))
    except KeyError:
        pass  # 旧版配置模块没有该功能项
    return providers


def _chat_config_for(handler, requested):
    """按对话框选中的模型挑选供应商配置；未知模型回落到「内置对话」的默认模型。"""
    providers = _chat_providers(handler)
    for fid, cfg in providers:
        if requested and requested in [cfg['model']] + cfg.get('models', []):
            if fid != 'chat':
                cfg = dict(cfg)
                cfg['prompt'] = cfg.get('prompt') or providers[0][1]['prompt']
            return cfg, requested
    return providers[0][1], providers[0][1]['model']


def handle_ai_config(handler):
    try:
        providers = _chat_providers(handler)
        cfg = providers[0][1]
        public = {k: cfg[k] for k in ('model', 'models', 'thinking')}
        # 其他供应商（Gemini）的模型并入菜单末尾；model_thinking / model_provider 供前端按模型切换思考按钮与说明。
        public['model_thinking'] = {}
        public['model_provider'] = {}
        for fid, item in providers:
            for mid in [item['model']] + item.get('models', []):
                if mid in public['model_thinking']:
                    continue
                public['model_thinking'][mid] = item['thinking']
                public['model_provider'][mid] = fid
                if fid != 'chat':
                    public['models'] = public['models'] + [mid]
        public['revision'] = hashlib.sha256(json.dumps(public, sort_keys=True).encode()).hexdigest()[:16]
        handler.send_response(200)
        handler.send_header('Content-Type', 'application/json; charset=utf-8')
        handler.send_header('Cache-Control', 'no-store')
        handler.end_headers()
        handler.wfile.write(json.dumps(public).encode('utf-8'))
    except api_settings.ConfigError as exc:
        handler._json_response(503, {'ok': False, 'error': str(exc)})


def handle_read_file(handler):
    query = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
    file_path = query.get('path', [''])[0]
    if not file_path:
        handler._json_response(400, {'ok': False, 'error': '未提供文件路径'})
        return
    file_path = os.path.normpath(file_path)
    if os.path.splitext(file_path)[1].lower() != '.pdf':
        handler._json_response(403, {'ok': False, 'error': '此接口只允许读取 PDF 文件'})
        return
    if not os.path.isfile(file_path):
        handler._json_response(404, {'ok': False, 'error': f'未找到文件: {file_path}'})
        return
    try:
        file_size = os.path.getsize(file_path)
        filename = os.path.basename(file_path)
        handler.send_response(200)
        handler.send_header('Content-Type', 'application/pdf')
        handler.send_header('Content-Length', str(file_size))
        handler.send_header('Content-Disposition', f'inline; filename="{urllib.parse.quote(filename)}"')
        handler.end_headers()
        with open(file_path, 'rb') as f:
            while chunk := f.read(64 * 1024):
                handler.wfile.write(chunk)
    except Exception as e:
        print("读取文件失败:", e)


def handle_shutdown(handler):
    # 标记随请求传递，后台只关闭本次明确要求退出的阅读器标签页。
    token = ''
    try:
        length = int(handler.headers.get('Content-Length', 0))
        if length < 0 or length > 1024:
            handler._json_response(400, {'ok': False, 'error': '无效的退出请求'})
            return
        data = json.loads(handler.rfile.read(length).decode('utf-8')) if length else {}
        token = data.get('token', '') if isinstance(data, dict) else ''
        if token != '' and (not isinstance(token, str) or len(token) != 32 or any(c not in '0123456789abcdef' for c in token)):
            handler._json_response(400, {'ok': False, 'error': '无效的退出标记'})
            return
    except (ValueError, UnicodeError):
        handler._json_response(400, {'ok': False, 'error': '无效的退出请求'})
        return
    try:
        handler._shutdown_server(token)
    except Exception as e:
        print("[关闭异常]", e)

    try:
        handler._json_response(200, {'ok': True, 'message': '正在退出核心引力引擎...'})
    except (ConnectionError, OSError):
        pass
    except Exception:
        pass


def handle_chrome_devtools(handler):
    handler.send_response(200)
    handler.send_header('Content-Type', 'application/json')
    handler.end_headers()
    handler.wfile.write(b'{}')


def handle_cloud_anno_get(handler):
    try:
        parsed = urllib.parse.urlparse(handler.path)
        action = parsed.path[len('/api/cloud-anno'):].strip('/')
        query = urllib.parse.parse_qs(parsed.query)

        cfg, pending = handler._cloud_cfg_or_error()
        if pending:
            handler._json_response(200, pending)
            return

        if action in ('', 'status'):
            result = cloud_sync.handle_cloud_status(cfg, query)
            handler._json_response(200, result)
            return
        if action == 'list':
            result = cloud_sync.handle_cloud_list(cfg, query)
            handler._json_response(200, result)
            return
        if action == 'meta':
            result = cloud_sync.handle_cloud_meta(cfg, query)
            status = result.pop('status', 200) if isinstance(result, dict) else 200
            handler._json_response(status, result)
            return
        if action == 'get':
            result = cloud_sync.handle_cloud_pull(cfg, query)
            status = result.pop('status', 200) if isinstance(result, dict) else 200
            handler._json_response(status, result)
            return

        handler._json_response(404, {'ok': False, 'error': f'未知的云端接口: {action}'})
    except Exception as e:
        print(f"[云端批注库] 查询失败: {e}")
        handler._json_response(200, {'ok': False, 'error': str(e)})


def handle_pick_video(handler):
    video_service.handle_picker(handler, handler._get_dialog_lock())


def handle_formula(handler):
    formula_service.handle(handler, deepseek=handler._deepseek_vision())


def handle_cloud_anno_post(handler):
    try:
        content_length = int(handler.headers.get('Content-Length') or 0)
        raw = handler.rfile.read(content_length) if content_length > 0 else b''
        try:
            payload = json.loads(raw.decode('utf-8')) if raw else {}
        except Exception:
            handler._json_response(400, {'ok': False, 'error': '请求体不是合法 JSON'})
            return
        if not isinstance(payload, dict):
            handler._json_response(400, {'ok': False, 'error': '请求体必须是 JSON 对象'})
            return

        action = str(payload.get('action') or 'save').strip().lower()
        cfg, pending = handler._cloud_cfg_or_error()
        if pending:
            pending['error'] = pending.get('message')
            handler._json_response(200, pending)
            return

        if action == 'test':
            info = cloud_sync.handle_cloud_test(cfg)
            handler._json_response(200, info)
            return

        if action != 'save':
            handler._json_response(400, {'ok': False, 'error': f'未知的 action: {action}'})
            return

        result = cloud_sync.handle_cloud_save(cfg, payload)
        status = result.pop('status', 200) if isinstance(result, dict) else 200
        handler._json_response(status, result)
    except Exception as e:
        print(f"[云端批注库] 上传失败: {e}")
        handler._json_response(200, {'ok': False, 'configured': True, 'error': str(e)})


def handle_render_tikz(handler):
    try:
        content_length = int(handler.headers.get('Content-Length') or 0)
    except Exception:
        content_length = 0
    post_data = handler.rfile.read(content_length) if content_length > 0 else b''
    tex_code = post_data.decode('utf-8', errors='replace')

    if not tex_code.strip():
        handler.send_response(400)
        handler.send_header('Content-type', 'text/plain; charset=utf-8')
        handler.end_headers()
        handler.wfile.write('空的渲染请求'.encode('utf-8'))
        return

    svg_base64, error = handler.render_tikz_cached(tex_code)
    if svg_base64:
        handler.send_response(200)
        handler.send_header('Content-type', 'text/plain')
        handler.end_headers()
        handler.wfile.write(svg_base64.encode('utf-8'))
    else:
        handler.send_response(500)
        handler.send_header('Content-type', 'text/plain; charset=utf-8')
        handler.end_headers()
        handler.wfile.write((error or 'LaTeX 编译失败').encode('utf-8'))


def handle_translate(handler):
    try:
        content_length = int(handler.headers.get('Content-Length', 0))
        post_data = handler.rfile.read(content_length)
        req_data = json.loads(post_data.decode('utf-8'))
    except Exception:
        handler._json_response(400, {'ok': False, 'error': '请求体解析失败'})
        return

    text = (req_data.get('text') or '').strip()
    mode = req_data.get('mode') or 'word'
    if not text:
        handler._json_response(400, {'ok': False, 'error': '文本为空'})
        return
    if mode not in ('word', 'sentence'):
        mode = 'word'

    result = handler.translate(text, mode)
    if result.get('ok'):
        handler._json_response(200, {
            'ok': True,
            'content': result['content'],
            'kind': result.get('kind') or ('word' if mode == 'word' else 'sentence'),
        })
    else:
        print("[词典] 失败: %s" % result['error'])
        handler._json_response(502, {'ok': False, 'error': result['error']})


def handle_chat(handler):
    try:
        content_length = int(handler.headers.get('Content-Length', 0))
        if content_length <= 0:
            handler._json_response(400, {'ok': False, 'error': '请求体为空'})
            return
        req_data = json.loads(handler.rfile.read(content_length).decode('utf-8'))
    except Exception:
        handler._json_response(400, {'ok': False, 'error': '请求体解析失败'})
        return

    messages, err = handler._validate_chat_messages(req_data.get('messages'))
    if err:
        handler._json_response(400, {'ok': False, 'error': err})
        return

    cfg, model = _chat_config_for(handler, req_data.get('model'))
    handler._active_chat_config = cfg
    thinking = bool(req_data.get('thinking', cfg['thinking'] == 'enabled'))
    try:
        temperature = float(req_data.get('temperature', cfg['temperature']))
        if not math.isfinite(temperature):
            temperature = float(cfg['temperature'])
        temperature = max(0.0, min(2.0, temperature))
    except Exception:
        temperature = cfg['temperature']
    try:
        max_tokens = int(req_data.get('max_tokens', cfg['max_tokens']) or 0)
        max_tokens = max(0, min(65536, max_tokens))
    except Exception:
        max_tokens = cfg['max_tokens']

    full = [{'role': 'system', 'content': cfg['prompt']}] + messages
    last = messages[-1]
    image_count = 0
    if isinstance(last.get('content'), list):
        image_count = sum(1 for p in last['content']
                          if isinstance(p, dict) and p.get('type') == 'image_url')
    print("[对话] %s%s 历史 %d 条 → %s" % (
        model, ('，含 %d 张图' % image_count) if image_count else '',
        len(messages), messages[-1].get('content') if isinstance(messages[-1].get('content'), str)
        else '[多模态内容]'))

    if req_data.get('stream'):
        handler._chat_stream(full, model, thinking, temperature, max_tokens)
        return

    result = handler._chat_once(full, model, thinking, temperature, max_tokens)
    if result.get('ok'):
        handler._json_response(200, result)
    else:
        print("[对话] 失败: %s" % result['error'])
        handler._json_response(502, {'ok': False, 'error': result['error']})


def handle_open_folder(handler):
    try:
        content_length = int(handler.headers.get('Content-Length', 0))
        post_data = handler.rfile.read(content_length)
        req_data = json.loads(post_data.decode('utf-8'))
        folder_path = (req_data.get('path') or '').strip()
        if not folder_path:
            handler._json_response(400, {'ok': False, 'error': '未指定文件夹路径'})
            return
        folder_path = os.path.normpath(folder_path)
        if not os.path.isdir(folder_path):
            handler._json_response(400, {'ok': False, 'error': f'文件夹不存在: {folder_path}'})
            return
        os.startfile(folder_path)
        print(f"[快捷文件夹] 已在资源管理器中打开: {folder_path}")
        handler._json_response(200, {'ok': True, 'message': '已打开文件夹', 'path': folder_path})
    except Exception as e:
        print(f"[快捷文件夹] 打开失败: {e}")
        handler._json_response(500, {'ok': False, 'error': str(e)})


def handle_check_folder(handler):
    try:
        content_length = int(handler.headers.get('Content-Length', 0))
        post_data = handler.rfile.read(content_length) if content_length > 0 else b'{}'
        req_data = json.loads(post_data.decode('utf-8')) if post_data else {}
        target = (req_data.get('path') or '').strip()
        exists = bool(target) and os.path.isdir(os.path.normpath(target))
        handler._json_response(200, {'ok': True, 'exists': exists})
    except Exception as e:
        handler._json_response(500, {'ok': False, 'error': str(e)})


def handle_pick_folder(handler):
    dialog_lock = handler._get_dialog_lock()
    try:
        content_length = int(handler.headers.get('Content-Length', 0))
        post_data = handler.rfile.read(content_length) if content_length > 0 else b'{}'
        req_data = json.loads(post_data.decode('utf-8')) if post_data else {}
        initial_dir = (req_data.get('initial_dir') or '').strip()
        if not os.path.isdir(initial_dir):
            initial_dir = None

        if not dialog_lock.acquire(blocking=False):
            handler._json_response(409, {'ok': False, 'error': '已有一个选择窗口正在打开，请先完成它'})
            return

        def _pick():
            import tkinter as tk
            from tkinter import filedialog
            root = None
            try:
                root = tk.Tk()
                root.withdraw()
                root.attributes('-topmost', True)
                return filedialog.askdirectory(title='选择教材所在文件夹', initialdir=initial_dir)
            except Exception as err:
                print("弹出文件夹选择器异常:", err)
                return None
            finally:
                if root is not None:
                    try:
                        root.destroy()
                    except Exception:
                        pass

        try:
            chosen_dir = _pick()
        finally:
            dialog_lock.release()

        if chosen_dir:
            chosen_dir = os.path.normpath(chosen_dir)
            handler._json_response(200, {'ok': True, 'path': chosen_dir})
        else:
            handler._json_response(200, {'ok': False, 'cancelled': True})
    except Exception as e:
        handler._json_response(500, {'ok': False, 'error': str(e)})


def handle_pick_file(handler):
    dialog_lock = handler._get_dialog_lock()
    try:
        content_length = int(handler.headers.get('Content-Length', 0))
        post_data = handler.rfile.read(content_length) if content_length > 0 else b'{}'
        req_data = json.loads(post_data.decode('utf-8')) if post_data else {}
        folder = (req_data.get('folder') or '').strip()
        if folder and os.path.isfile(folder):
            folder = os.path.dirname(folder)
        if not folder or not os.path.isdir(folder):
            folder = os.getcwd()

        if not dialog_lock.acquire(blocking=False):
            handler._json_response(409, {'ok': False, 'error': '已有一个选择窗口正在打开，请先完成它'})
            return

        def _pick_file():
            import tkinter as tk
            from tkinter import filedialog
            root = None
            try:
                root = tk.Tk()
                root.withdraw()
                root.attributes('-topmost', True)
                return filedialog.askopenfilename(
                    parent=root,
                    title='选择要打开的 PDF 教材',
                    initialdir=folder,
                    filetypes=[('PDF 文档', '*.pdf'), ('所有文件', '*.*')]
                )
            except Exception as err:
                print("弹出文件选择器异常:", err)
                return None
            finally:
                if root is not None:
                    try:
                        root.destroy()
                    except Exception:
                        pass

        try:
            chosen_file = _pick_file()
        finally:
            dialog_lock.release()

        if chosen_file:
            chosen_file = os.path.normpath(chosen_file)
            print(f"[快捷打开] 用户选中文件: {chosen_file}")
            handler._json_response(200, {
                'ok': True,
                'path': chosen_file,
                'name': os.path.basename(chosen_file)
            })
        else:
            handler._json_response(200, {'ok': False, 'cancelled': True})
    except Exception as e:
        handler._json_response(500, {'ok': False, 'error': str(e)})


def handle_save_file(handler):
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
        query_path = query.get('path', [''])[0]
        header_path = handler.headers.get('X-File-Path', '') or handler.headers.get('x-file-path', '')
        target_path = query_path or urllib.parse.unquote(header_path)
        if not target_path:
            handler._json_response(400, {'ok': False, 'error': '未指定保存路径'})
            return
        target_path = os.path.abspath(os.path.normpath(target_path))
        if os.path.splitext(target_path)[1].lower() != '.pdf':
            from app.services.formula_service import _drain_request
            _drain_request(handler)
            handler._json_response(403, {'ok': False, 'error': '此接口只允许保存 PDF 文件'})
            return
        content_length = int(handler.headers.get('Content-Length', 0))
        if content_length <= 0:
            handler._json_response(400, {'ok': False, 'error': '文件数据为空'})
            return

        fd, temp_target = tempfile.mkstemp(prefix='.reader-save-', suffix='.tmp',
                                           dir=os.path.dirname(target_path))
        try:
            remaining = content_length
            signature = b''
            with os.fdopen(fd, 'wb') as f:
                while remaining:
                    chunk = handler.rfile.read(min(64 * 1024, remaining))
                    if not chunk:
                        raise ValueError('文件上传不完整，原文件未修改')
                    if len(signature) < 5:
                        signature += chunk[:5 - len(signature)]
                    f.write(chunk)
                    remaining -= len(chunk)
                if signature != b'%PDF-':
                    raise ValueError('上传内容不是 PDF，原文件未修改')
                f.flush()
            # Allow mock on os.replace
            os_replace = getattr(sys.modules.get('server'), 'os', os).replace
            os_replace(temp_target, target_path)
        finally:
            if os.path.exists(temp_target):
                os.unlink(temp_target)

        print(f"[本地保存] 原位覆盖保存成功: {target_path} ({content_length} bytes)")
        handler._json_response(200, {'ok': True, 'message': '已成功原位保存', 'path': target_path})
    except Exception as e:
        print(f"[本地保存] 保存异常: {e}")
        handler._json_response(500, {'ok': False, 'error': str(e)})


GET_ROUTES = {
    '/api/bilibili/manifest': handle_bilibili_manifest,
    '/api/bilibili/media': handle_bilibili_media,
    '/api/video': handle_video,
    '/api/ai-config': handle_ai_config,
    '/api/shutdown': handle_shutdown,
    '/.well-known/appspecific/com.chrome.devtools.json': handle_chrome_devtools,
}

POST_ROUTES = {
    '/api/bilibili': bilibili_service.handle_api,
    '/api/online-video': online_video_service.handle_resolve,
    '/api/pick-video': handle_pick_video,
    '/api/render-tikz': handle_render_tikz,
    '/api/translate': handle_translate,
    '/api/chat': handle_chat,
    '/api/open-folder': handle_open_folder,
    '/api/check-folder': handle_check_folder,
    '/api/pick-folder': handle_pick_folder,
    '/api/pick-file': handle_pick_file,
    '/api/shutdown': handle_shutdown,
}


def dispatch_get(handler):
    if not handler._allow_local_api():
        return True

    path = urllib.parse.urlsplit(handler.path).path
    parts = urllib.parse.unquote(path).replace('\\', '/').split('/')
    if any(p.lower() in ('airtex', 'tex', '.api-manager') for p in parts):
        handler.send_error(403)
        return True

    if path in GET_ROUTES:
        GET_ROUTES[path](handler)
        return True

    if path == '/api/read-file' or handler.path.startswith('/api/read-file?'):
        handle_read_file(handler)
        return True

    if path == '/api/cloud-anno' or path.startswith('/api/cloud-anno/'):
        handle_cloud_anno_get(handler)
        return True

    return False


def dispatch_post(handler):
    if not handler._allow_local_api():
        return True

    path = urllib.parse.urlsplit(handler.path).path
    if path in ('/api/chat', '/api/translate') or path.startswith('/api/formula/'):
        try:
            api_settings.load_document()
        except api_settings.ConfigError as exc:
            handler._json_response(503, {'ok': False, 'error': str(exc)})
            return True

    if path in POST_ROUTES:
        POST_ROUTES[path](handler)
        return True

    if path.startswith('/api/formula/'):
        handle_formula(handler)
        return True

    if path == '/api/cloud-anno' or path.startswith('/api/cloud-anno?'):
        handle_cloud_anno_post(handler)
        return True

    if path == '/api/save-file' or handler.path.startswith('/api/save-file?'):
        handle_save_file(handler)
        return True

    handler.send_response(404)
    handler.end_headers()
    return True
