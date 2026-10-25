"""Close only browser tabs explicitly marked by the reader's shutdown request."""
import os
import time


def closing_title(token):
    return 'PDF Reader Pro - Closing ' + token


def close_marked_reader_tabs(token, timeout=1.8):
    if os.name != 'nt' or not token:
        return
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetAncestor.restype = wintypes.HWND
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
    user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
    user32.GetAsyncKeyState.restype = wintypes.SHORT
    user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_size_t]
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    title = closing_title(token)

    def marked(hwnd):
        if not user32.IsWindowVisible(hwnd):
            return False
        text = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, text, len(text))
        if title not in text.value:
            return False
        name = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, name, len(name))
        return name.value in ('Chrome_WidgetWin_1', 'MozillaWindowClass', 'IEFrame')

    def find_windows():
        windows = []
        @callback_type
        def visit(hwnd, _):
            if marked(hwnd):
                windows.append(hwnd)
            return True
        user32.EnumWindows(visit, 0)
        return windows

    def activate(hwnd):
        # This worker thread needs a message queue before AttachThreadInput.
        message = wintypes.MSG()
        user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
        own_thread = kernel32.GetCurrentThreadId()
        foreground = user32.GetForegroundWindow()
        foreground_thread = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
        attached = bool(foreground_thread and foreground_thread != own_thread
                        and user32.AttachThreadInput(own_thread, foreground_thread, True))
        try:
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(own_thread, foreground_thread, False)
        active = user32.GetForegroundWindow()
        return active == hwnd or (active and user32.GetAncestor(active, 2) == hwnd)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        windows = find_windows()
        for hwnd in windows:
            # Never send a global shortcut while another application has focus,
            # or while the user is holding a modifier key.
            if any(user32.GetAsyncKeyState(key) & 0x8000 for key in (0x10, 0x11, 0x12, 0x5B, 0x5C)):
                continue
            if not marked(hwnd) or not activate(hwnd) or not marked(hwnd):
                continue
            try:
                user32.keybd_event(0x11, 0, 0, 0)
                user32.keybd_event(0x57, 0, 0, 0)
                time.sleep(0.02)
            finally:
                user32.keybd_event(0x57, 0, 2, 0)
                user32.keybd_event(0x11, 0, 2, 0)
        time.sleep(0.1)
