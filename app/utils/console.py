"""Win32 console hiding and system adaptation utilities."""
import os
import sys


def _console_ancestor_pids():
    """Restrict terminal fallback to the launcher process and its own hosts."""
    import ctypes
    from ctypes import wintypes

    class ProcessEntry(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                    ('pid', wintypes.DWORD), ('heap', ctypes.c_size_t),
                    ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                    ('parent', wintypes.DWORD), ('priority', wintypes.LONG),
                    ('flags', wintypes.DWORD), ('exe', wintypes.WCHAR * 260)]

    kernel32 = ctypes.windll.kernel32
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    kernel32.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ProcessEntry)]
    kernel32.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ProcessEntry)]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    snapshot = kernel32.CreateToolhelp32Snapshot(2, 0)
    pids = {os.getpid()}
    if not snapshot or snapshot == ctypes.c_void_p(-1).value:
        return pids
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        parents = {}
        more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            parents[entry.pid] = entry.parent
            more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
        pid = parents.get(os.getpid(), 0)
        while pid and pid not in pids:
            pids.add(pid)
            pid = parents.get(pid, 0)
    finally:
        kernel32.CloseHandle(snapshot)
    return pids


def hide_console_window():
    """🤫 让启动器（黑色控制台窗口）静默消失。

    关闭按钮按下后立刻调用：窗口直接隐去，而不是等所有标签页关完再退出，
    避免黑色终端在页面上方"停留几秒挡画面"。
    窗口只是隐藏，进程照常收尾（等 Ctrl+W 关完标签页后 os._exit）。
    排查启动问题时若要保留窗口，可在启动前设置环境变量 PDF_READER_SHOW_CONSOLE=1。
    """
    if os.environ.get('PDF_READER_SHOW_CONSOLE'):
        return
    try:
        import ctypes
        # ⚠️ GetConsoleWindow 由 kernel32 导出（user32 里取不到，会报
        #    "function 'GetConsoleWindow' not found" 而静默失效）；
        #    ShowWindow 才是 user32 的。两处分属不同 DLL，别写混。
        kernel32 = ctypes.windll.kernel32
        user32 = ctypes.windll.user32
        # ⚠️ 与下面同理：默认 restype 为 32 位 int，64 位句柄会被截断成无效值
        kernel32.GetConsoleWindow.restype = ctypes.c_void_p
        user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
        hwnd = kernel32.GetConsoleWindow()
        if hwnd:
            user32.ShowWindow(hwnd, 0)  # SW_HIDE
            try:
                user32.GetAncestor.argtypes = [ctypes.c_void_p, ctypes.c_uint]
                user32.GetAncestor.restype = ctypes.c_void_p
                root = user32.GetAncestor(hwnd, 2)  # GA_ROOT
                if root and root != hwnd:
                    user32.ShowWindow(root, 0)
            except Exception:
                pass

        # Windows Terminal 的伪控制台 HWND 不对应可见窗口；只匹配本启动器的宿主。
        try:
            owner_pids = _console_ancestor_pids()
            kernel32.GetConsoleTitleW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint]
            console_title = ctypes.create_unicode_buffer(512)
            kernel32.GetConsoleTitleW(console_title, 512)
            user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
            user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
            def _enum_cb(h, _):
                buf = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(h, buf, 512)
                pid = ctypes.c_ulong()
                user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
                if (console_title.value and buf.value == console_title.value
                        and 'PDF Reader Pro - Core Engine' in buf.value and pid.value in owner_pids):
                    user32.ShowWindow(h, 0)
                return True
            WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
            user32.EnumWindows.argtypes = [WNDENUMPROC, ctypes.c_void_p]
            user32.EnumWindows(WNDENUMPROC(_enum_cb), 0)
        except Exception:
            pass
    except Exception as e:
        print("隐藏启动器窗口失败（忽略）:", e)
        try:
            sys.stdout.flush()
        except Exception:
            pass

