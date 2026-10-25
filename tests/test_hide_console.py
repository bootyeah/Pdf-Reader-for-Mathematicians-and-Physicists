"""启动器「静默退出」自检：确认 hide_console_window() 真能把控制台窗口藏起来。

为什么单独测：GetConsoleWindow 由 kernel32 导出，若误写到 user32，
ctypes 会抛 "function 'GetConsoleWindow' not found" 并被 except 吞掉，
表现就是「黑框依然明晃晃留在屏幕上」—— 正是要修掉的挡画面问题。
所以这里实测「调用后窗口是否真的不可见」，而不是只看有没有抛异常。

用法：
    python tests/test_hide_console.py             # 断言模式，返回码 0=通过
    python tests/test_hide_console.py --restore   # 测完恢复窗口，方便肉眼确认
    PDF_READER_HIDE_SELFTEST=<log> python ...     # 把过程写进日志（供外部驱动查看）
"""
import ctypes
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import hide_console_window  # noqa: E402

kernel32 = ctypes.windll.kernel32
user32 = ctypes.windll.user32
kernel32.GetConsoleWindow.restype = ctypes.c_void_p
user32.IsWindowVisible.argtypes = [ctypes.c_void_p]

_log_path = os.environ.get('PDF_READER_HIDE_SELFTEST', '')


def say(line):
    print(line)
    if _log_path:
        with open(_log_path, 'a', encoding='utf-8') as f:
            f.write(line + '\n')


def console_state():
    hwnd = kernel32.GetConsoleWindow()
    if not hwnd:
        return None, None  # 没有控制台（例如 pythonw 启动）
    return hwnd, bool(user32.IsWindowVisible(hwnd))


def main():
    hwnd_before, visible_before = console_state()
    say(f"[1] 隐藏前: hwnd={hwnd_before} visible={visible_before}")

    hide_console_window()

    _, visible_after = console_state()
    say(f"[2] 隐藏后: visible={visible_after}")

    if visible_before is None:
        say("[结果] SKIP 当前进程没有控制台窗口（如 pythonw 启动），无法验证")
        return 2

    if visible_before is False:
        say("[结果] SKIP 当前控制台本来就是隐藏的（IDE/服务/沙箱环境），"
            "无法构成「可见 -> 隐藏」的有效对照；请在双击的批处理窗口里重跑")
        return 2

    if os.environ.get('PDF_READER_SHOW_CONSOLE'):
        say(f"[结果] 设置了 PDF_READER_SHOW_CONSOLE=1，按设计不隐藏 (visible={visible_after})")
        return 0 if visible_after else 1

    if not visible_after:
        say("[结果] PASS 启动器窗口已静默隐藏")
        code = 0
    else:
        say(f"[结果] FAIL 隐藏逻辑未生效 (before={visible_before} after={visible_after})")
        code = 1

    if '--restore' in sys.argv and hwnd_before:
        user32.ShowWindow(hwnd_before, 5)  # SW_SHOW
        say(f"[恢复] visible={console_state()[1]}")

    return code


if __name__ == '__main__':
    sys.exit(main())
