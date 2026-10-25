"""Real child-process lifecycle and verified-download tests; no external network."""
import hashlib
import io
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import phone_tunnel as module


class TunnelTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.patch = patch.object(module, 'TOOL_DIR', Path(self.directory.name))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.directory.cleanup()

    def wait_status(self, tunnel, status):
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if tunnel.snapshot()['status'] == status:
                return tunnel.snapshot()
            time.sleep(.02)
        self.fail(f'Expected {status}, got {tunnel.snapshot()}')

    def launch(self, script):
        original = subprocess.Popen
        def spawn(command, **kwargs):
            self.assertIn('http://127.0.0.1:34567', command)
            self.assertNotIn('8080', ' '.join(command))
            self.assertEqual(command[command.index('--protocol') + 1], 'http2')
            self.assertEqual(Path(command[command.index('--config') + 1]).read_text(), '{}\n')
            return original([sys.executable, '-u', '-c', script], **kwargs)
        return patch.object(module.subprocess, 'Popen', side_effect=spawn)

    def test_ready_stop_terminates_child_and_removes_temporary_config(self):
        script = "import time; print('https://synthetic-board.trycloudflare.com'); print('Registered tunnel connection connIndex=0'); time.sleep(30)"
        tunnel = module.QuickTunnel(34567)
        with patch.object(module, 'executable', return_value=sys.executable), self.launch(script):
            try:
                tunnel.start()
                self.assertEqual(self.wait_status(tunnel, 'ready')['url'], 'https://synthetic-board.trycloudflare.com')
                tunnel.start()
            finally:
                tunnel.stop()
                tunnel.thread.join(5)
            self.assertIsNotNone(tunnel.process.poll())
            self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_process_exit_and_timeout_invalidate_public_address(self):
        tunnel = module.QuickTunnel(34567)
        with patch.object(module, 'executable', return_value=sys.executable), self.launch("print('https://synthetic-board.trycloudflare.com')"):
            tunnel.start()
            state = self.wait_status(tunnel, 'error')
            self.assertEqual(state['url'], '')
            tunnel.stop(); tunnel.thread.join(5)
        tunnel = module.QuickTunnel(34567)
        with patch.object(module, 'executable', return_value=sys.executable), self.launch('import time; time.sleep(30)'):
            try:
                tunnel.start()
                while tunnel.process is None:
                    time.sleep(.01)
                # Invoke the watchdog deterministically without waiting 90 seconds.
                tunnel.connected = Mock(wait=Mock(return_value=False))
                tunnel._timeout()
                self.assertIn('超时', self.wait_status(tunnel, 'error')['message'])
            finally:
                tunnel.stop(); tunnel.thread.join(5)

    def test_close_during_install_cannot_spawn_late_process(self):
        entered, release = threading.Event(), threading.Event()
        def install(cancel, progress):
            entered.set(); release.wait(3)
            return sys.executable
        tunnel = module.QuickTunnel(34567)
        with patch.object(module, 'executable', side_effect=install), patch.object(module.subprocess, 'Popen') as spawn:
            tunnel.start(); self.assertTrue(entered.wait(2))
            tunnel.stop(); release.set(); tunnel.thread.join(5)
            spawn.assert_not_called()

    def test_reader_port_is_never_an_origin(self):
        for port in (8080, 0, -1, 65536, '34567'):
            with self.assertRaises(ValueError):
                module.QuickTunnel(port)

    @unittest.skipUnless(os.name == 'nt', 'Windows bundled tool')
    def test_download_checksum_and_cancellation(self):
        payload = b'synthetic executable, never run'
        class Response(io.BytesIO):
            headers = {'Content-Length': str(len(payload))}
        with patch.dict(os.environ, {'PDF_READER_CLOUDFLARED': ''}), \
                patch.object(module, 'SHA256', hashlib.sha256(payload).hexdigest()), \
                patch.object(module.urllib.request, 'urlopen', side_effect=lambda *a, **k: Response(payload)) as download:
            tool = module.executable(threading.Event(), Mock())
            self.assertEqual(Path(tool).read_bytes(), payload)
            self.assertEqual(module.executable(threading.Event(), Mock()), tool)
            self.assertEqual(download.call_count, 1)
            Path(tool).unlink()
            with patch.object(module, 'SHA256', '0' * 64), self.assertRaisesRegex(RuntimeError, '校验失败'):
                module.executable(threading.Event(), Mock())
            self.assertEqual(list(Path(self.directory.name).iterdir()), [])
            cancel = threading.Event()
            def progress(*args):
                cancel.set()
            self.assertIsNone(module.executable(cancel, progress))
            self.assertEqual(list(Path(self.directory.name).iterdir()), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
