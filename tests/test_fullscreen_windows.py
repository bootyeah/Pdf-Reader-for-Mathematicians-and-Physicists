"""Tests for fullscreen desktop window switcher and Always-on-Top pinning service."""
import functools
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server
from app.services import window_service


class QuietReader(server.PDFReaderHandler):
    def log_message(self, *_):
        pass


class FakeWin32Env:
    """In-memory mock of Win32 window state for deterministic unit testing."""

    def __init__(self):
        self.console_hwnd = 9001
        self.foreground_hwnd = 1000
        self.calls = []
        # hwnd -> dict of properties
        self.windows = {
            1000: {
                'title': '全功能 PDF 阅读器（离线版） - Microsoft Edge',
                'class': 'Chrome_WidgetWin_1',
                'visible': True,
                'iconic': False,
                'cloaked': 0,
                'style': 0x14CF0000,
                'ex_style': 0x00000100,
                'owner': 0,
                'app': 'msedge',
                'rect': (0, 0, 1920, 1080),
            },
            2001: {
                'title': '微信',
                'class': 'WeChatMainWndForPC',
                'visible': True,
                'iconic': True,
                'cloaked': 0,
                'style': 0x14CF0000,
                'ex_style': 0x00000100,
                'owner': 0,
                'app': 'WeChat',
                'rect': (200, 150, 1100, 800),
            },
            2002: {
                'title': '无标题 - 记事本',
                'class': 'Notepad',
                'visible': True,
                'iconic': False,
                'cloaked': 0,
                'style': 0x14CF0000,
                'ex_style': 0x00000100,
                'owner': 0,
                'app': 'notepad',
                'rect': (300, 200, 1000, 700),
            },
            2003: {
                'title': 'Program Manager',
                'class': 'Progman',
                'visible': True,
                'iconic': False,
                'cloaked': 0,
                'style': 0x14000000,
                'ex_style': 0x00000080,
                'owner': 0,
                'app': 'explorer',
                'rect': (0, 0, 1920, 1080),
            },
            2004: {
                'title': '设置',
                'class': 'ApplicationFrameWindow',
                'visible': True,
                'iconic': False,
                'cloaked': 2,
                'style': 0x14CF0000,
                'ex_style': 0x00000100,
                'owner': 0,
                'app': 'ApplicationFrameHost',
                'rect': (0, 0, 800, 600),
            },
            2005: {
                'title': '浮动工具条',
                'class': 'CustomToolBar',
                'visible': True,
                'iconic': False,
                'cloaked': 0,
                'style': 0x14000000,
                'ex_style': window_service.WS_EX_TOOLWINDOW,
                'owner': 0,
                'app': 'helper',
                'rect': (0, 0, 200, 40),
            },
            2006: {
                'title': '钉钉',
                'class': 'StandardFrame_DingTalk',
                'visible': False,
                'iconic': False,
                'cloaked': 0,
                'style': 0x14CF0000,
                'ex_style': 0x00000100,
                'owner': 0,
                'app': 'DingTalk',
                'rect': (100, 100, 1060, 760),
            },
        }


class WindowServiceBackendTests(unittest.TestCase):
    def setUp(self):
        window_service._PINNED_HWNDS.clear()
        self.env = FakeWin32Env()
        self.temp = tempfile.TemporaryDirectory(prefix='reader-win-test-')
        self.httpd = ThreadingHTTPServer(
            ('127.0.0.1', 0),
            functools.partial(QuietReader, directory=self.temp.name),
        )
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.httpd.server_port}'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        window_service._PINNED_HWNDS.clear()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.temp.cleanup()

    def _build_mock_apis(self):
        import ctypes
        from ctypes import wintypes

        env = self.env
        user32 = MagicMock()
        kernel32 = MagicMock()
        dwmapi = MagicMock()

        kernel32.GetConsoleWindow.return_value = env.console_hwnd
        kernel32.GetCurrentThreadId.return_value = 101

        user32.IsWindow.side_effect = lambda h: int(h) in env.windows
        user32.IsWindowVisible.side_effect = lambda h: bool(env.windows.get(int(h), {}).get('visible'))
        user32.IsIconic.side_effect = lambda h: bool(env.windows.get(int(h), {}).get('iconic'))
        user32.GetWindowTextLengthW.side_effect = lambda h: len(env.windows.get(int(h), {}).get('title', ''))

        def _get_text(h, buf, _size):
            buf.value = env.windows.get(int(h), {}).get('title', '')
            return len(buf.value)

        def _get_class(h, buf, _size):
            buf.value = env.windows.get(int(h), {}).get('class', '')
            return len(buf.value)

        user32.GetWindowTextW.side_effect = _get_text
        user32.GetClassNameW.side_effect = _get_class
        user32.GetWindowLongW.side_effect = lambda h, idx: (
            env.windows[int(h)]['style'] if idx == window_service.GWL_STYLE
            else env.windows[int(h)]['ex_style']
        )
        user32.GetWindow.side_effect = lambda h, _cmd: env.windows.get(int(h), {}).get('owner', 0)

        def _get_rect(h, rect_ptr):
            w = env.windows.get(int(h))
            if not w:
                return False
            l, t, r, b = w['rect']
            rect_obj = ctypes.cast(rect_ptr, ctypes.POINTER(wintypes.RECT)).contents
            rect_obj.left, rect_obj.top, rect_obj.right, rect_obj.bottom = l, t, r, b
            return True

        user32.GetWindowRect.side_effect = _get_rect

        def _enum_windows(cb, lparam):
            for hwnd in list(env.windows.keys()):
                cb(hwnd, lparam)
            return True

        user32.EnumWindows.side_effect = _enum_windows

        def _show_window(h, cmd):
            w = env.windows.get(int(h))
            if not w:
                return False
            env.calls.append(('ShowWindow', int(h), cmd))
            if cmd == window_service.SW_SHOW:
                w['visible'] = True
            elif cmd == window_service.SW_RESTORE:
                w['visible'] = True
                w['iconic'] = False
            return True

        user32.ShowWindow.side_effect = _show_window

        def _set_window_pos(h, insert_after, x, y, cx, cy, flags):
            w = env.windows.get(int(h))
            if not w:
                return False
            env.calls.append(('SetWindowPos', int(h), insert_after, flags))
            if insert_after == window_service.HWND_TOPMOST:
                w['ex_style'] |= window_service.WS_EX_TOPMOST
                w['visible'] = True
            elif insert_after == window_service.HWND_NOTOPMOST:
                w['ex_style'] &= ~window_service.WS_EX_TOPMOST
            return True

        user32.SetWindowPos.side_effect = _set_window_pos
        user32.GetForegroundWindow.side_effect = lambda: env.foreground_hwnd
        user32.SetForegroundWindow.side_effect = lambda h: (
            env.calls.append(('SetForegroundWindow', int(h))),
            setattr(env, 'foreground_hwnd', int(h)),
            True,
        )[-1]
        user32.BringWindowToTop.side_effect = lambda h: (
            env.calls.append(('BringWindowToTop', int(h))),
            True,
        )[-1]
        user32.GetWindowThreadProcessId.side_effect = lambda h, _pid_ptr: int(h) + 10
        user32.AttachThreadInput.return_value = True
        user32.PeekMessageW.return_value = True

        def _WNDENUMPROC(fn):
            return fn

        return ctypes, wintypes, user32, kernel32, dwmapi, _WNDENUMPROC

    def test_list_windows_filters_and_orders_correctly(self):
        apis = self._build_mock_apis()
        with patch.object(window_service, '_win32_apis', return_value=apis), \
             patch.object(window_service, '_process_app_name', side_effect=lambda *args: self.env.windows[int(args[-1])]['app']), \
             patch.object(window_service, '_is_cloaked', side_effect=lambda _c, _d, h: bool(self.env.windows[int(h)]['cloaked'])):
            items = window_service.list_windows()
            titles = [w['title'] for w in items]
            # Should include WeChat (2001), Notepad (2002), and tray-hidden DingTalk (2006)
            # Should exclude PDF Reader itself (1000), Program Manager (2003), cloaked Settings (2004), and tool window (2005)
            self.assertEqual(titles, ['微信', '无标题 - 记事本', '钉钉'])
            self.assertFalse(items[0]['pinned'])
            self.assertTrue(items[0]['minimized'])

    def test_toggle_pin_unpin_and_unpin_all_via_http_api(self):
        apis = self._build_mock_apis()
        with patch.object(window_service, '_win32_apis', return_value=apis), \
             patch.object(window_service, '_process_app_name', side_effect=lambda *args: self.env.windows[int(args[-1])]['app']), \
             patch.object(window_service, '_is_cloaked', side_effect=lambda _c, _d, h: bool(self.env.windows[int(h)]['cloaked'])):

            # 1. GET /api/windows
            with self.opener.open(self.origin + '/api/windows', timeout=5) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(data['ok'])
            self.assertEqual([w['hwnd'] for w in data['windows']], [2001, 2002, 2006])

            # 2. POST /api/windows toggle on minimized WeChat (2001) -> restores, pins TopMost, focuses
            req = urllib.request.Request(
                self.origin + '/api/windows',
                data=json.dumps({'action': 'toggle', 'hwnd': 2001}).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            with self.opener.open(req, timeout=5) as resp:
                res1 = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(res1['ok'])
            self.assertEqual(res1['action'], 'pin')
            self.assertTrue(res1['pinned'])
            self.assertIn(2001, window_service._PINNED_HWNDS)
            self.assertFalse(self.env.windows[2001]['iconic'])
            self.assertTrue(bool(self.env.windows[2001]['ex_style'] & window_service.WS_EX_TOPMOST))
            self.assertEqual(self.env.foreground_hwnd, 2001)

            # 3. POST /api/windows toggle on Notepad (2002) -> pins TopMost and moves pinned items to top of list
            req2 = urllib.request.Request(
                self.origin + '/api/windows',
                data=json.dumps({'action': 'toggle', 'hwnd': 2002}).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            with self.opener.open(req2, timeout=5) as resp:
                res2 = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(res2['ok'])
            self.assertTrue(res2['pinned'])
            pinned_hwnds = [w['hwnd'] for w in res2['windows'] if w['pinned']]
            self.assertEqual(pinned_hwnds, [2001, 2002])

            # 4. POST /api/windows toggle on already-pinned WeChat (2001) -> unpins and sinks behind reader
            req3 = urllib.request.Request(
                self.origin + '/api/windows',
                data=json.dumps({'action': 'toggle', 'hwnd': 2001}).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            with self.opener.open(req3, timeout=5) as resp:
                res3 = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(res3['ok'])
            self.assertEqual(res3['action'], 'unpin')
            self.assertFalse(res3['pinned'])
            self.assertNotIn(2001, window_service._PINNED_HWNDS)
            self.assertFalse(bool(self.env.windows[2001]['ex_style'] & window_service.WS_EX_TOPMOST))

            # 5. POST /api/windows unpin_all -> unpins remaining pinned Notepad (2002)
            req4 = urllib.request.Request(
                self.origin + '/api/windows',
                data=json.dumps({'action': 'unpin_all'}).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            with self.opener.open(req4, timeout=5) as resp:
                res4 = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(res4['ok'])
            self.assertEqual(res4['unpinned'], 1)
            self.assertEqual(len(window_service._PINNED_HWNDS), 0)
            self.assertFalse(bool(self.env.windows[2002]['ex_style'] & window_service.WS_EX_TOPMOST))

    def test_cross_site_requests_are_rejected(self):
        req = urllib.request.Request(
            self.origin + '/api/windows',
            data=json.dumps({'action': 'toggle', 'hwnd': 2001}).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'Origin': 'https://evil.invalid'},
            method='POST',
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.opener.open(req, timeout=5)
        self.assertEqual(ctx.exception.code, 403)
        ctx.exception.close()


class FullscreenWindowFrontendTests(unittest.TestCase):
    def _find_edge(self) -> Path:
        for candidate in (
            Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        ):
            if candidate.exists():
                return candidate
        self.skipTest("Microsoft Edge not found for headless browser verification")

    def test_fullscreen_hover_dropdown_ui_and_interactions(self):
        edge_path = self._find_edge()
        index_html = (ROOT / "static/index.html").read_text(encoding="utf-8")
        base_tag = f'<base href="{(ROOT / "static").as_uri()}/">'

        test_script = r"""
<script>
window.addEventListener('load', () => {
    setTimeout(async () => {
        try {
            function assert(cond, msg) {
                if (!cond) throw new Error(msg);
            }

            const wrapper = document.getElementById('fullscreen-dropdown-wrapper');
            const fsBtn = document.getElementById('fullscreen-btn');
            const dropdown = document.getElementById('fullscreen-window-dropdown');
            const card = document.getElementById('fullscreen-window-card');
            const list = document.getElementById('fullscreen-window-list');
            const videoBtn = document.getElementById('video-btn');
            assert(wrapper && fsBtn && dropdown && card && list && videoBtn, 'Fullscreen dropdown elements must exist');
            const fsRect = fsBtn.getBoundingClientRect();
            const vidRect = videoBtn.getBoundingClientRect();
            assert(Math.abs(fsRect.width - vidRect.width) <= 0.5 && Math.abs(fsRect.height - vidRect.height) <= 0.5,
                `Fullscreen button dimensions (${fsRect.width}x${fsRect.height}) must match sibling view button (${vidRect.width}x${vidRect.height})`);

            // Mock /api/windows endpoints in frontend context
            let mockWindows = [
                { hwnd: 101, title: '微信', app: 'WeChat', pinned: false, minimized: true, pinned_by_reader: false },
                { hwnd: 102, title: '无标题 - 记事本', app: 'notepad', pinned: false, minimized: false, pinned_by_reader: false }
            ];
            let lastPostPayload = null;
            const origFetch = window.fetch.bind(window);
            window.fetch = async (url, opts = {}) => {
                if (String(url).startsWith('/api/windows')) {
                    if (!opts.method || opts.method === 'GET') {
                        return new Response(JSON.stringify({ ok: true, windows: mockWindows }), {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    const body = JSON.parse(opts.body || '{}');
                    lastPostPayload = body;
                    if (body.action === 'unpin_all') {
                        mockWindows.forEach(w => { w.pinned = false; w.pinned_by_reader = false; });
                        return new Response(JSON.stringify({ ok: true, action: 'unpin_all', windows: mockWindows }), {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    const target = mockWindows.find(w => w.hwnd === Number(body.hwnd));
                    if (target) {
                        target.pinned = !target.pinned;
                        target.pinned_by_reader = target.pinned;
                        target.minimized = false;
                    }
                    return new Response(JSON.stringify({ ok: true, action: target?.pinned ? 'pin' : 'unpin', pinned: !!target?.pinned, windows: mockWindows }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return origFetch(url, opts);
            };

            // 1. Hovering #fullscreen-dropdown-wrapper loads window list
            wrapper.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            await new Promise(r => setTimeout(r, 40));

            const items = list.querySelectorAll('.fullscreen-window-item');
            assert(items.length === 2, 'Should render 2 desktop window items, got ' + items.length);
            assert(items[0].textContent.trim() === '微信', '1st window should be 微信');
            assert(items[1].textContent.trim() === '无标题 - 记事本', '2nd window should be 无标题 - 记事本');
            assert(items[0].dataset.pinned === 'false', '微信 should start unpinned');

            // 2. Clicking "微信" pins it and updates UI + fullscreen button highlight
            items[0].click();
            await new Promise(r => setTimeout(r, 40));
            assert(lastPostPayload && lastPostPayload.action === 'toggle' && Number(lastPostPayload.hwnd) === 101,
                'Clicking window item must POST toggle for hwnd 101');
            const updatedItems = list.querySelectorAll('.fullscreen-window-item');
            assert(updatedItems[0].dataset.pinned === 'true' && updatedItems[0].classList.contains('is-pinned'),
                '微信 row must become is-pinned');
            assert(fsBtn.classList.contains('text-blue-600'),
                'Fullscreen button should show subtle blue active state while a window is pinned');

            // 3. Eye-protection mode keeps card background warm and opaque (not transparent)
            document.body.classList.add('eye-protection-mode');
            const cardBg = getComputedStyle(card).backgroundColor;
            assert(cardBg === 'rgb(250, 247, 242)', 'Eye protection card background must be #FAF7F2, got ' + cardBg);
            document.body.classList.remove('eye-protection-mode');

            // 4. Exiting fullscreen automatically triggers unpin_all
            document.dispatchEvent(new Event('fullscreenchange'));
            await new Promise(r => setTimeout(r, 40));
            assert(lastPostPayload && lastPostPayload.action === 'unpin_all',
                'Exiting fullscreen must automatically unpin all reader-pinned windows');
            assert(!fsBtn.classList.contains('text-blue-600'),
                'Fullscreen button blue indicator must clear after unpin_all');

            document.title = 'FULLSCREEN_WINDOWS_TEST_OK';
        } catch (err) {
            document.title = 'FULLSCREEN_WINDOWS_TEST_ERR: ' + (err && err.stack ? err.stack : err);
        }
    }, 100);
});
</script>
"""
        patched_html = index_html.replace("<head>", "<head>" + base_tag, 1).replace("</body>", test_script + "</body>", 1)
        with tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w", encoding="utf-8") as f:
            f.write(patched_html)
            temp_path = f.name

        try:
            cmd = [
                str(edge_path),
                "--headless=new",
                "--disable-gpu",
                "--window-size=1440,920",
                "--virtual-time-budget=3000",
                "--dump-dom",
                temp_path,
            ]
            res = subprocess.run(cmd, capture_output=True, timeout=25)
            stdout = res.stdout.decode("utf-8", errors="replace")
            m = re.search(r"<title>(.*?)</title>", stdout, re.S)
            self.assertIsNotNone(m, "Headless browser did not produce a <title>")
            self.assertEqual(m.group(1), "FULLSCREEN_WINDOWS_TEST_OK")
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


if __name__ == "__main__":
    unittest.main()
