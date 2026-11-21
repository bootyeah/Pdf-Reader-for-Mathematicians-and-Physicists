"""Win32 desktop window enumeration, summoning, and Always-on-Top pinning service."""
import json
import os
import threading

_LOCK = threading.Lock()
_PINNED_HWNDS = set()

GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_DISABLED = 0x08000000
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
WS_EX_NOACTIVATE = 0x08000000
GW_OWNER = 4
DWMWA_CLOAKED = 14

HWND_TOP = 0
HWND_BOTTOM = 1
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2

SW_SHOW = 5
SW_RESTORE = 9

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

_EXCLUDED_CLASSES = frozenset({
    'Progman',
    'WorkerW',
    'Shell_TrayWnd',
    'Shell_SecondaryTrayWnd',
    'Windows.UI.Core.CoreWindow',
    'XamlExplorerHostIslandWindow',
    'ForegroundStaging',
    'MultitaskingViewFrame',
    'EdgeUiInputTopWndClass',
    'EdgeUiInputWndClass',
    'MSCTFIME UI',
    'IME',
    'PseudoConsoleWindow',
})

_READER_TITLE_MARKERS = (
    '全功能 PDF 阅读器',
    'PDF Reader Pro',
    'PDF 阅读器 - 已退出',
)

_TRAY_IM_CLASSES = frozenset({
    'WeChatMainWndForPC',
    'WeixinMainWndForPC',
})

_TRAY_IM_APPS = frozenset({
    'wechat',
    'weixin',
    'qq',
    'tim',
    'dingtalk',
    'feishu',
    'lark',
})

_TRAY_IM_TITLES = frozenset({
    '微信',
    'WeChat',
    'Weixin',
    'QQ',
    'TIM',
    '钉钉',
    'DingTalk',
    '飞书',
    'Feishu',
    'Lark',
})


def _win32_apis():
    if os.name != 'nt':
        return None
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    dwmapi = getattr(ctypes.windll, 'dwmapi', None)

    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
    user32.IsWindow.argtypes = [ctypes.c_ssize_t]
    user32.IsWindow.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [ctypes.c_ssize_t]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [ctypes.c_ssize_t]
    user32.IsIconic.restype = wintypes.BOOL
    user32.GetWindowTextLengthW.argtypes = [ctypes.c_ssize_t]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [ctypes.c_ssize_t, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.GetClassNameW.argtypes = [ctypes.c_ssize_t, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetWindowLongW.argtypes = [ctypes.c_ssize_t, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.GetWindow.argtypes = [ctypes.c_ssize_t, wintypes.UINT]
    user32.GetWindow.restype = wintypes.HWND
    user32.GetWindowRect.argtypes = [ctypes.c_ssize_t, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [ctypes.c_ssize_t, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.SetWindowPos.argtypes = [
        ctypes.c_ssize_t, ctypes.c_ssize_t,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.UINT,
    ]
    user32.SetWindowPos.restype = wintypes.BOOL
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.SetForegroundWindow.argtypes = [ctypes.c_ssize_t]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.BringWindowToTop.argtypes = [ctypes.c_ssize_t]
    user32.BringWindowToTop.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [ctypes.c_ssize_t, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.AttachThreadInput.restype = wintypes.BOOL
    user32.PeekMessageW.argtypes = [
        ctypes.POINTER(wintypes.MSG), wintypes.HWND,
        wintypes.UINT, wintypes.UINT, wintypes.UINT,
    ]
    user32.PeekMessageW.restype = wintypes.BOOL

    kernel32.GetConsoleWindow.restype = wintypes.HWND
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    if dwmapi is not None:
        dwmapi.DwmGetWindowAttribute.argtypes = [
            ctypes.c_ssize_t, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
        ]
        dwmapi.DwmGetWindowAttribute.restype = ctypes.c_long

    return ctypes, wintypes, user32, kernel32, dwmapi, WNDENUMPROC


def _process_app_name(ctypes, wintypes, user32, kernel32, hwnd):
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return ''
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not handle:
        return ''
    try:
        buf_len = wintypes.DWORD(512)
        buf = ctypes.create_unicode_buffer(512)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(buf_len)):
            base = os.path.basename(buf.value)
            name, ext = os.path.splitext(base)
            return name if ext.lower() == '.exe' else base
    except Exception:
        pass
    finally:
        kernel32.CloseHandle(handle)
    return ''


def _is_cloaked(ctypes, dwmapi, hwnd):
    if dwmapi is None:
        return False
    try:
        cloaked = ctypes.c_int(0)
        hr = dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        return hr == 0 and cloaked.value != 0
    except Exception:
        return False


def _window_dimensions(ctypes, wintypes, user32, hwnd):
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return 0, 0
    return max(0, rect.right - rect.left), max(0, rect.bottom - rect.top)


def list_windows():
    """Return a list of user-facing desktop windows available to summon and pin."""
    apis = _win32_apis()
    if apis is None:
        return []
    ctypes, wintypes, user32, kernel32, dwmapi, WNDENUMPROC = apis
    console_hwnd = int(kernel32.GetConsoleWindow() or 0)

    with _LOCK:
        pinned_snapshot = set(_PINNED_HWNDS)

    unpinned_now = set()
    for h in list(pinned_snapshot):
        if not user32.IsWindow(h):
            unpinned_now.add(h)
            continue
        if not user32.IsWindowVisible(h) or user32.IsIconic(h) or _is_cloaked(ctypes, dwmapi, h):
            user32.SetWindowPos(
                h, HWND_NOTOPMOST, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
            unpinned_now.add(h)

    if unpinned_now:
        with _LOCK:
            for h in unpinned_now:
                _PINNED_HWNDS.discard(h)
        pinned_snapshot.difference_update(unpinned_now)

    visible_items = []
    tray_candidates = []

    def _visit(raw_hwnd, _):
        hwnd = int(raw_hwnd or 0)
        if not hwnd or hwnd == console_hwnd:
            return True

        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True

        title_buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title_buf, length + 1)
        title = (title_buf.value or '').strip()
        if not title or any(marker in title for marker in _READER_TITLE_MARKERS):
            return True

        cls_buf = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, cls_buf, 128)
        class_name = cls_buf.value or ''
        if class_name in _EXCLUDED_CLASSES:
            return True

        if _is_cloaked(ctypes, dwmapi, hwnd):
            return True

        style = user32.GetWindowLongW(hwnd, GWL_STYLE)
        if style & WS_DISABLED:
            return True

        ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        is_app_window = bool(ex_style & WS_EX_APPWINDOW)
        if (ex_style & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) and not is_app_window:
            return True
        if user32.GetWindow(hwnd, GW_OWNER) and not is_app_window:
            return True

        visible = bool(user32.IsWindowVisible(hwnd))
        minimized = bool(user32.IsIconic(hwnd))
        if hwnd in unpinned_now:
            ex_style &= ~WS_EX_TOPMOST
        if hwnd in pinned_snapshot and (not visible or minimized):
            user32.SetWindowPos(
                hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
            ex_style &= ~WS_EX_TOPMOST
            with _LOCK:
                _PINNED_HWNDS.discard(hwnd)
            pinned_snapshot.discard(hwnd)

        app_name = _process_app_name(ctypes, wintypes, user32, kernel32, hwnd)

        if not visible:
            w, h = _window_dimensions(ctypes, wintypes, user32, hwnd)
            is_tray_im = (
                class_name in _TRAY_IM_CLASSES
                or (app_name.lower() in _TRAY_IM_APPS and title in _TRAY_IM_TITLES and w >= 200 and h >= 200)
            )
            if not is_tray_im:
                return True
            tray_candidates.append({
                'hwnd': hwnd,
                'title': title,
                'app': app_name,
                'pinned': False,
                'topmost': bool(ex_style & WS_EX_TOPMOST),
                'minimized': True,
                'pinned_by_reader': hwnd in pinned_snapshot,
            })
            return True

        topmost = bool(ex_style & WS_EX_TOPMOST)
        pinned = bool(topmost and not minimized)
        visible_items.append({
            'hwnd': hwnd,
            'title': title,
            'app': app_name,
            'pinned': pinned,
            'topmost': topmost,
            'minimized': minimized,
            'pinned_by_reader': hwnd in pinned_snapshot,
        })
        return True

    user32.EnumWindows(WNDENUMPROC(_visit), 0)

    seen_apps = {(item['app'].lower(), item['title']) for item in visible_items}
    for cand in tray_candidates:
        key = (cand['app'].lower(), cand['title'])
        if key not in seen_apps:
            seen_apps.add(key)
            visible_items.append(cand)

    pinned_list = [w for w in visible_items if w['pinned']]
    normal_list = [w for w in visible_items if not w['pinned']]
    return pinned_list + normal_list


def _activate_window(ctypes, wintypes, user32, kernel32, hwnd):
    message = wintypes.MSG()
    user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
    own_thread = kernel32.GetCurrentThreadId()
    foreground = user32.GetForegroundWindow()
    fg_thread = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
    target_thread = user32.GetWindowThreadProcessId(hwnd, None)

    attached_fg = bool(
        fg_thread and fg_thread != own_thread
        and user32.AttachThreadInput(own_thread, fg_thread, True)
    )
    attached_target = bool(
        target_thread and target_thread != own_thread and target_thread != fg_thread
        and user32.AttachThreadInput(own_thread, target_thread, True)
    )
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached_target:
            user32.AttachThreadInput(own_thread, target_thread, False)
        if attached_fg:
            user32.AttachThreadInput(own_thread, fg_thread, False)


def pin_window(hwnd):
    """Restore/show a desktop window, pin it Always-on-Top, and bring it to foreground."""
    try:
        hwnd = int(hwnd)
    except (TypeError, ValueError):
        return {'ok': False, 'error': '无效的窗口句柄'}

    apis = _win32_apis()
    if apis is None:
        return {'ok': False, 'error': '当前系统不支持桌面窗口控制'}
    ctypes, wintypes, user32, kernel32, _, _ = apis

    if not user32.IsWindow(hwnd):
        with _LOCK:
            _PINNED_HWNDS.discard(hwnd)
        return {'ok': False, 'error': '目标窗口已关闭'}

    if not user32.IsWindowVisible(hwnd):
        user32.ShowWindow(hwnd, SW_SHOW)
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)

    user32.SetWindowPos(
        hwnd, HWND_TOPMOST, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
    )
    _activate_window(ctypes, wintypes, user32, kernel32, hwnd)

    ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    is_topmost = bool(ex_style & WS_EX_TOPMOST)
    with _LOCK:
        _PINNED_HWNDS.add(hwnd)

    return {
        'ok': True,
        'action': 'pin',
        'hwnd': hwnd,
        'pinned': is_topmost or True,
    }


def unpin_window(hwnd, sink=True):
    """Cancel Always-on-Top for a desktop window and optionally drop it behind the reader."""
    try:
        hwnd = int(hwnd)
    except (TypeError, ValueError):
        return {'ok': False, 'error': '无效的窗口句柄'}

    apis = _win32_apis()
    if apis is None:
        return {'ok': False, 'error': '当前系统不支持桌面窗口控制'}
    _, _, user32, _, _, _ = apis

    with _LOCK:
        _PINNED_HWNDS.discard(hwnd)

    if not user32.IsWindow(hwnd):
        return {'ok': True, 'action': 'unpin', 'hwnd': hwnd, 'pinned': False}

    user32.SetWindowPos(
        hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    )
    if sink:
        user32.SetWindowPos(
            hwnd, HWND_BOTTOM, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )

    return {
        'ok': True,
        'action': 'unpin',
        'hwnd': hwnd,
        'pinned': False,
    }


def toggle_window(hwnd):
    """Toggle a desktop window between active Always-on-Top and unpinned background."""
    try:
        hwnd = int(hwnd)
    except (TypeError, ValueError):
        return {'ok': False, 'error': '无效的窗口句柄'}

    apis = _win32_apis()
    if apis is None:
        return {'ok': False, 'error': '当前系统不支持桌面窗口控制'}
    _, _, user32, _, _, _ = apis

    if not user32.IsWindow(hwnd):
        with _LOCK:
            _PINNED_HWNDS.discard(hwnd)
        return {'ok': False, 'error': '目标窗口已关闭'}

    ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    is_active_pinned = bool(
        (ex_style & WS_EX_TOPMOST)
        and user32.IsWindowVisible(hwnd)
        and not user32.IsIconic(hwnd)
    )
    if is_active_pinned:
        return unpin_window(hwnd, sink=True)
    return pin_window(hwnd)


def unpin_all():
    """Unpin all windows that were pinned by the PDF reader during this session."""
    with _LOCK:
        targets = list(_PINNED_HWNDS)
        _PINNED_HWNDS.clear()

    apis = _win32_apis()
    count = 0
    if apis is not None:
        _, _, user32, _, _, _ = apis
        for hwnd in targets:
            try:
                if user32.IsWindow(int(hwnd)):
                    user32.SetWindowPos(
                        int(hwnd), HWND_NOTOPMOST, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    )
                    count += 1
            except Exception:
                pass
    return {'ok': True, 'action': 'unpin_all', 'unpinned': count}


def handle_get(handler):
    handler._json_response(200, {'ok': True, 'windows': list_windows()})


def handle_post(handler):
    try:
        content_length = int(handler.headers.get('Content-Length') or 0)
        if content_length < 0 or content_length > 65536:
            handler._json_response(400, {'ok': False, 'error': '请求体大小不合法'})
            return
        raw = handler.rfile.read(content_length) if content_length > 0 else b'{}'
        payload = json.loads(raw.decode('utf-8')) if raw else {}
    except Exception:
        handler._json_response(400, {'ok': False, 'error': '请求体解析失败'})
        return

    if not isinstance(payload, dict):
        handler._json_response(400, {'ok': False, 'error': '请求体必须是 JSON 对象'})
        return

    action = str(payload.get('action') or 'toggle').strip().lower()
    if action == 'unpin_all':
        result = unpin_all()
        result['windows'] = list_windows()
        handler._json_response(200, result)
        return

    hwnd = payload.get('hwnd')
    if action == 'pin':
        result = pin_window(hwnd)
    elif action == 'unpin':
        result = unpin_window(hwnd, sink=bool(payload.get('sink', True)))
    elif action == 'toggle':
        result = toggle_window(hwnd)
    else:
        handler._json_response(400, {'ok': False, 'error': f'未知的操作: {action}'})
        return

    result['windows'] = list_windows()
    status = 200 if result.get('ok') else 400
    handler._json_response(status, result)
