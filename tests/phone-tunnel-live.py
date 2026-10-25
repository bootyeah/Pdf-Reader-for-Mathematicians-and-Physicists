"""Explicit live smoke test: exposes only a synthetic board, never user PDFs or keys."""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import formula_bridge as bridge
from airtex import core, web


def request(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    try:
        response = urllib.request.urlopen(req, timeout=12)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        return response.status, json.loads(raw) if 'application/json' in response.headers.get('Content-Type', '') else raw


def run():
    cfg = dict(core.DEFAULT_CONFIG, api_key='synthetic-test-key', debug_keep_png=False)
    with patch.object(bridge, '_config', return_value=cfg), patch.object(core, 'log'), patch.object(web, 'log'), \
            patch.object(core, 'recognize_doc', return_value={'ok': True, 'latex': 'Synthetic $x=1$', 'model': 'mock'}):
        start = bridge.phone({'action': 'start', 'connection': 'internet', 'purpose': 'whiteboard'})
        sid = start['session']
        try:
            deadline, previous = time.monotonic() + 100, None
            while time.monotonic() < deadline:
                state = bridge.phone({'action': 'state', 'session': sid})
                pairing = state['pairing']
                if pairing['status'] != previous:
                    print('Tunnel:', pairing['status'], flush=True)
                    previous = pairing['status']
                if pairing['status'] == 'error':
                    raise RuntimeError(pairing['message'])
                if pairing['status'] == 'ready':
                    break
                time.sleep(.5)
            else:
                raise RuntimeError('Live tunnel did not become ready')
            url = pairing['urls'][0]
            parsed = urllib.parse.urlsplit(url)
            origin = f'{parsed.scheme}://{parsed.netloc}'
            token = urllib.parse.parse_qs(parsed.query)['t'][0]
            # DNS/edge propagation can lag the local registration log briefly.
            status = 0
            for attempt in range(8):
                try:
                    status, page = request(url)
                    if status == 200:
                        break
                except urllib.error.URLError:
                    pass
                time.sleep(2)
            assert status == 200 and b'AIRTEX_TOKEN' in page, 'Phone page must load over public HTTPS'
            assert request(origin + '/')[0] == 403
            assert request(origin + '/api/state?t=wrong')[0] == 403
            assert request(origin + '/api/read-file?t=' + token)[0] == 404
            assert request(origin + '/server.py?t=' + token)[0] == 404
            print('PASS Public HTTPS page, token protection, and reader/file API isolation', flush=True)
            doc = {'w': 400, 'h': 200, 'strokes': [{'k': 'pen', 'w': 4, 'c': '#2563eb', 'p': [[10, 10], [100, 100]]}]}
            status, ack = request(origin + '/api/update?t=' + token, {'doc': doc, 'pageId': 'live-page'})
            assert status == 200 and ack['accepted']
            state = bridge.phone({'action': 'state', 'session': sid})
            assert state['doc']['strokes'] == doc['strokes']
            status, answer = request(origin + '/api/recognize?t=' + token, {'pageId': 'live-page'})
            assert status == 200
            for _ in range(30):
                state = bridge.phone({'action': 'state', 'session': sid})
                if state.get('result'):
                    break
                time.sleep(.2)
            assert state['result']['latex'] == 'Synthetic $x=1$'
            print('PASS Handwriting travels through the live tunnel; simulated recognition returns to the PC', flush=True)
            if '--browser' in sys.argv:
                result = subprocess.run(['node', str(Path(__file__).with_name('phone-tunnel-live-browser.cjs'))],
                    input=json.dumps({'url': url}), text=True, encoding='utf-8', timeout=90,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                if result.returncode:
                    raise RuntimeError('Live mobile browser test failed')
                state = bridge.phone({'action': 'state', 'session': sid})
                assert state['strokes'] >= 2, 'Browser-drawn strokes must reach the PC'
        finally:
            tunnel = bridge._sessions[sid].get('tunnel')
            bridge._close(sid)
            if tunnel.thread:
                tunnel.thread.join(5)
            assert not tunnel.process or tunnel.process.poll() is not None
            print('PASS Closing pairing terminates the tunnel', flush=True)


if __name__ == '__main__':
    if '--live' not in sys.argv:
        raise SystemExit('Use --live to authorize the external synthetic-board smoke test.')
    run()
