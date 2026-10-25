"""Shutdown window matching and shortcut scope; no real windows are closed."""
import ctypes
import functools
import json
import os
from pathlib import Path
import sys
import unittest
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.utils import browser_close
from app.server import PDFReaderHandler


class ShutdownRequestTests(unittest.TestCase):
    def test_valid_legacy_and_invalid_exit_requests(self):
        calls = []
        class Handler(PDFReaderHandler):
            def log_message(self, *_): pass
            def _shutdown_server(self, token=''): calls.append(token)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(Path(__file__).resolve().parents[1]))) as httpd:
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                origin = 'http://127.0.0.1:%s' % httpd.server_port
                for payload, expected in [(b'', 200), (json.dumps({'token': 'a' * 32}).encode(), 200),
                                          (b'{broken', 400), (b'{"token": 0}', 400), (b'{"token": "bad"}', 400)]:
                    request = urllib.request.Request(origin + '/api/shutdown', data=payload, headers={'Content-Type': 'application/json'})
                    try:
                        response = opener.open(request, timeout=5)
                    except urllib.error.HTTPError as error:
                        response = error
                    with response:
                        self.assertEqual(response.status, expected)
                self.assertEqual(calls, ['', 'a' * 32])
            finally:
                httpd.shutdown()
                thread.join()


@unittest.skipUnless(os.name == 'nt', 'Win32 browser closing')
class ShutdownScopeTests(unittest.TestCase):
    def close_windows(self, activate):
        token = 'a' * 32
        owned = 0x100000002
        unrelated = 0x200000003
        user32, kernel32 = MagicMock(), MagicMock()
        user32.GetWindowTextW.side_effect = lambda hwnd, buffer, size: setattr(buffer, 'value', browser_close.closing_title(token) + ' - Microsoft Edge' if hwnd == owned else 'PDF Reader Pro - Closing ' + 'b' * 32)
        user32.GetClassNameW.side_effect = lambda hwnd, buffer, size: setattr(buffer, 'value', 'Chrome_WidgetWin_1')
        user32.IsWindowVisible.return_value = True
        user32.GetAsyncKeyState.return_value = 0
        user32.GetForegroundWindow.return_value = owned if activate else unrelated
        user32.GetAncestor.side_effect = lambda hwnd, flags: hwnd
        user32.GetWindowThreadProcessId.return_value = 200
        kernel32.GetCurrentThreadId.return_value = 100
        user32.EnumWindows.side_effect = lambda callback, _: (callback(owned, 0), callback(unrelated, 0))
        with patch.object(ctypes.windll, 'user32', user32), \
             patch.object(ctypes.windll, 'kernel32', kernel32), \
             patch.object(browser_close.time, 'monotonic', side_effect=[0, 0, 1]), \
             patch.object(browser_close.time, 'sleep'):
            browser_close.close_marked_reader_tabs(token, timeout=0.1)
        return user32, owned

    def test_only_the_marked_foreground_tab_receives_ctrl_w(self):
        user32, owned = self.close_windows(True)
        user32.SetForegroundWindow.assert_called_once_with(owned)
        self.assertEqual([call.args[:3] for call in user32.keybd_event.call_args_list], [(0x11, 0, 0), (0x57, 0, 0), (0x57, 0, 2), (0x11, 0, 2)])
        user32.PostMessageW.assert_not_called()

    def test_failed_focus_does_not_send_a_shortcut_to_another_window(self):
        user32, _ = self.close_windows(False)
        user32.keybd_event.assert_not_called()


if __name__ == '__main__':
    unittest.main()
