"""Console hiding is limited to the reader's own launcher/terminal hosts."""
import ctypes
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.utils import console


@unittest.skipUnless(sys.platform == 'win32', 'Win32 console APIs')
class ConsoleScopeTests(unittest.TestCase):
    def test_fallback_does_not_hide_another_core_engine_window(self):
        title = 'PDF Reader Pro - Core Engine'
        kernel32 = MagicMock()
        user32 = MagicMock()
        console_hwnd = 0x100000002
        owned_hwnd = 0x200000003
        unrelated_hwnd = 0x300000004
        kernel32.GetConsoleWindow.return_value = console_hwnd
        kernel32.GetConsoleTitleW.side_effect = lambda buffer, size: setattr(buffer, 'value', title)
        user32.GetAncestor.return_value = console_hwnd
        user32.GetWindowTextW.side_effect = lambda hwnd, buffer, size: setattr(buffer, 'value', title)
        user32.GetWindowThreadProcessId.side_effect = lambda hwnd, pid: setattr(pid._obj, 'value', 200 if hwnd == owned_hwnd else 900)

        def enumerate_windows(callback, _):
            callback(owned_hwnd, None)
            callback(unrelated_hwnd, None)
            return True

        user32.EnumWindows.side_effect = enumerate_windows
        with patch.dict(os.environ, {}, clear=True), \
             patch.object(ctypes.windll, 'kernel32', kernel32), \
             patch.object(ctypes.windll, 'user32', user32), \
             patch.object(console, '_console_ancestor_pids', return_value={100, 200}):
            console.hide_console_window()
        hidden = [call.args[0] for call in user32.ShowWindow.call_args_list]
        self.assertIn(console_hwnd, hidden, '64-bit console HWND must not be truncated')
        self.assertIn(owned_hwnd, hidden)
        self.assertNotIn(unrelated_hwnd, hidden, 'A matching title alone is insufficient')

    def test_show_console_override_skips_all_hiding(self):
        with patch.dict(os.environ, {'PDF_READER_SHOW_CONSOLE': '1'}), \
             patch.object(console, '_console_ancestor_pids') as probe:
            console.hide_console_window()
            probe.assert_not_called()

    def test_process_snapshot_includes_the_current_process(self):
        self.assertIn(os.getpid(), console._console_ancestor_pids())


if __name__ == '__main__':
    unittest.main()
