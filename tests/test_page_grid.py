"""End-to-end verification for pure-image PDF Auto-Grid (Scheme A), local PDF embedding, and cloud isolation."""
import functools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import api_settings as settings  # noqa: E402
import server  # noqa: E402


class FakeVisionUpstream(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *_):
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length).decode('utf-8'))
        self.calls.append({
            'path': self.path,
            'auth': self.headers.get('Authorization'),
            'body': body,
        })
        reply = (
            '[1] Theorem 1.1 Continuity\n'
            '[2] Let f(x) ≥ 0 on [a, b]\n'
            '[3] Proof follows directly'
        )
        payload = {
            'model': body.get('model', 'glm-test'),
            'choices': [{'message': {'content': reply}, 'finish_reason': 'stop'}],
        }
        raw = json.dumps(payload).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class QuietReader(server.PDFReaderHandler):
    def log_message(self, *_):
        pass


class PageGridTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reader-page-grid-')
        self.temp_root = Path(self.temp.name)
        self.config_file = self.temp_root / 'settings.json'
        self.env = patch.dict(os.environ, {'PDF_READER_API_CONFIG': str(self.config_file)})
        self.env.start()

        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), FakeVisionUpstream)
        self.up_thread = threading.Thread(target=self.upstream.serve_forever, daemon=True)
        self.up_thread.start()
        self.up_url = f'http://127.0.0.1:{self.upstream.server_port}/v1'

        doc = settings.legacy_document()
        doc['features']['formula_image'].update(
            base_url=self.up_url,
            api_key='glm-shared-secret-key',
            key_source='',
            model='GLM-5.3-Flash',
            fallback_model='GLM-5.3-Flash',
            thinking='max',
        )
        doc['features']['page_grid'].update(
            base_url=self.up_url,
            api_key='',
            key_source='formula_image',
            model='GLM-5.3-Flash',
            fallback_model='GLM-5.3-Flash',
            thinking='max',
        )
        settings.save_document(doc, 'legacy')

        self.httpd = ThreadingHTTPServer(
            ('127.0.0.1', 0),
            functools.partial(QuietReader, directory=str(ROOT)),
        )
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.httpd.server_port}'
        FakeVisionUpstream.calls.clear()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.up_thread.join()
        self.env.stop()
        self.temp.cleanup()

    def test_upgrade_seeds_page_grid_from_formula_image(self):
        old_doc = settings.legacy_document()
        del old_doc['features']['page_grid']
        old_doc['features']['formula_image'].update(
            base_url='https://open.bigmodel.cn/api/paas/v4',
            model='GLM-5.3-Flash',
            fallback_model='GLM-5.3-Flash',
            thinking='max',
            timeout=180,
        )
        upgraded = settings.upgrade(old_doc)
        grid_cfg = upgraded['features']['page_grid']
        self.assertEqual(grid_cfg['base_url'], 'https://open.bigmodel.cn/api/paas/v4')
        self.assertEqual(grid_cfg['model'], 'GLM-5.3-Flash')
        self.assertEqual(grid_cfg['key_source'], 'formula_image')
        self.assertEqual(grid_cfg['thinking'], 'max')
        self.assertIn('[编号]', grid_cfg['prompt'])

    def _find_browser_runtime(self):
        node_bin = os.environ.get('READER_TEST_NODE') or shutil.which('node')
        node_modules = Path(os.environ.get('READER_TEST_NODE_MODULES') or (ROOT / 'node_modules'))
        playwright_dir = node_modules / 'playwright'
        env_browser = os.environ.get('READER_TEST_BROWSER')
        edge_candidates = [
            Path(env_browser) if env_browser else None,
            Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'),
            Path(r'C:\Program Files\Microsoft\Edge\Application\msedge.exe'),
            Path(shutil.which('msedge') or '') if shutil.which('msedge') else None,
        ]
        edge = next((c for c in edge_candidates if c and c.exists()), None)
        if not (node_bin and playwright_dir.exists() and edge):
            self.skipTest('Node / Playwright / Edge runtime not available')
        return node_bin, playwright_dir, edge

    def test_pure_image_pdf_auto_grid_selection_search_local_save_and_cloud_isolation(self):
        node, playwright_dir, edge = self._find_browser_runtime()

        script = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require(process.env.PW_PATH);
const { PDFDocument, PDFName } = require(path.join(process.env.ROOT_DIR, 'static/lib/pdf-lib.min.js'));

// Generate a pure-image PNG with 3 distinct lines of dark text-like word clusters on white background
function makeSyntheticScannedPagePng(w = 600, h = 840) {
    const lines = [
        // Line 1 (y: 120..144): 3 word clusters ("Theorem", "1.1", "Continuity")
        { y0: 120, y1: 144, clusters: [[72, 165], [182, 220], [238, 360]] },
        // Line 2 (y: 180..204): 6 word clusters ("Let", "f(x)", "≥", "0", "on", "[a, b]")
        { y0: 180, y1: 204, clusters: [[72, 112], [128, 178], [194, 214], [230, 248], [264, 294], [310, 380]] },
        // Line 3 (y: 240..264): 3 word clusters ("Proof", "follows", "directly")
        { y0: 240, y1: 264, clusters: [[72, 140], [158, 246], [264, 368]] },
    ];
    const rows = [];
    for (let y = 0; y < h; y++) {
        const row = Buffer.alloc(1 + w * 3, 255);
        row[0] = 0;
        for (const ln of lines) {
            if (y >= ln.y0 && y < ln.y1) {
                for (const [x0, x1] of ln.clusters) {
                    for (let x = x0; x < x1; x++) {
                        // Draw character-like vertical stroke pattern inside each word cluster
                        if ((x - x0) % 5 !== 4 || (y - ln.y0) % 4 === 0) {
                            const off = 1 + x * 3;
                            row[off] = 20;
                            row[off + 1] = 24;
                            row[off + 2] = 30;
                        }
                    }
                }
            }
        }
        rows.push(row);
    }
    function chunk(tag, data) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const tagBuf = Buffer.from(tag, 'ascii');
        const crcVal = zlib.crc32(Buffer.concat([tagBuf, data])) >>> 0;
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crcVal, 0);
        return Buffer.concat([len, tagBuf, data, crc]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

(async () => {
    const pdfPath = path.join(process.env.TEMP_DIR, 'scanned-textbook.pdf');
    const doc = await PDFDocument.create();
    const pngBytes = makeSyntheticScannedPagePng(600, 840);
    const pngImage = await doc.embedPng(pngBytes);
    const pdfPage = doc.addPage([600, 840]);
    pdfPage.drawImage(pngImage, { x: 0, y: 0, width: 600, height: 840 });
    fs.writeFileSync(pdfPath, Buffer.from(await doc.save()));

    const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH, headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
        const cloudPayloads = [];

        await context.route('**/api/pick-file', async route => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, path: pdfPath, name: 'scanned-textbook.pdf' }),
            });
        });

        await context.route(url => url.pathname.startsWith('/api/cloud-anno'), async route => {
            const req = route.request();
            if (req.method() === 'POST') {
                const body = req.postDataJSON();
                cloudPayloads.push(body);
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        ok: true,
                        configured: true,
                        timestamp: new Date().toISOString(),
                        key: 'scanned-textbook_annotations.json',
                        device: 'test-pc',
                    }),
                });
            } else {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ ok: true, configured: true, enabled: true, total: 1 }),
                });
            }
        });

        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', err => pageErrors.push(err.message));

        await page.goto(process.env.ORIGIN + '/index.html');
        await page.click('#open-btn');
        await page.waitForFunction(() => state.pdfDoc?.numPages === 1 && state.pagesRendered.has(1));
        await page.evaluate(async () => { await state.annotationsReady; });

        // 1. Before Auto-Grid: pure image page has 0 spans in #text-layer-1
        const beforeSpans = await page.locator('#text-layer-1 span').count();
        assert.equal(beforeSpans, 0, 'Pure image PDF must start with 0 selectable text spans');

        // 2. Click #auto-grid-btn in #page-hud
        await page.click('#auto-grid-btn');
        await page.waitForFunction(() => window.PageAutoGrid?.hasGrid(1) && document.querySelectorAll('#text-layer-1 span').length > 0);

        // 3. Verify segmented text layer items and precision coordinates
        const gridCheck = await page.evaluate(() => {
            const spans = [...document.querySelectorAll('#text-layer-1 span')];
            const fullText = spans.map(s => s.textContent).join('');
            const theoremSpan = spans.find(s => s.textContent.includes('Theorem'));
            const wrapper = document.getElementById('page-wrapper-1');
            const wr = wrapper.getBoundingClientRect();
            const sr = theoremSpan.getBoundingClientRect();
            const relX = (sr.left - wr.left) / wr.width;
            const relY = (sr.top - wr.top) / wr.height;
            return {
                spanCount: spans.length,
                fullText,
                relX,
                relY,
                gridItemsCount: state.pageGrids[1].items.length,
                unsaved: state.unsavedChanges,
                btnTitle: document.getElementById('auto-grid-btn').title,
            };
        });

        assert.ok(gridCheck.spanCount >= 8, 'Expected word/token spans in #text-layer-1, got ' + gridCheck.spanCount);
        assert.match(gridCheck.fullText, /Theorem 1\.1 Continuity/);
        assert.match(gridCheck.fullText, /Let f\(x\) ≥ 0 on \[a, b\]/);
        assert.match(gridCheck.fullText, /Proof follows directly/);
        // Line 1 cluster 1 in image is at x=72/600=0.12, y=120/840=0.1428
        assert.ok(Math.abs(gridCheck.relX - 0.12) < 0.015, `Expected relX ~ 0.12, got ${gridCheck.relX}`);
        assert.ok(Math.abs(gridCheck.relY - (120 / 840)) < 0.02, `Expected relY ~ 0.1428, got ${gridCheck.relY}`);
        assert.equal(gridCheck.unsaved, true);
        assert.match(gridCheck.btnTitle, /已完成自动分格/);

        // 4. Verify Ctrl+F search finds text on the auto-gridded image page
        await page.click('#toggle-search-btn');
        await page.fill('#search-input', 'Continuity');
        await page.evaluate(() => executeSearch());
        await page.waitForFunction(() => state.searchMatches.length === 1);
        const matchPage = await page.evaluate(() => state.searchMatches[0].pageNum);
        assert.equal(matchPage, 1);

        // 5. Add a regular highlight annotation on page 1 and save (Ctrl+S)
        await page.evaluate(() => {
            performAction(() => {
                state.annotations[1] = [{
                    id: 'anno-on-gridded-page',
                    type: 'highlight',
                    color: '#fde047',
                    rects: [{ x: 0.12, y: 0.14, w: 0.48, h: 0.028 }],
                    text: 'Theorem 1.1 Continuity...',
                }];
            }, [1]);
        });

        await page.click('#save-status-btn');
        await page.waitForFunction(() => !state.unsavedChanges && !state.isSaving);
        await page.waitForFunction(() => state.cloudSync?.phase === 'ok');

        // 6. Verify CloudSync uploaded regular annotations but NEVER uploaded pageGrids
        assert.equal(cloudPayloads.length, 1, 'CloudSync should have received 1 save payload');
        const cloudBodyStr = JSON.stringify(cloudPayloads[0]);
        assert.ok(cloudBodyStr.includes('anno-on-gridded-page'), 'CloudSync payload must include regular annotations');
        assert.ok(!cloudBodyStr.includes('Continuity\n') && !('pageGrids' in cloudPayloads[0]), 'CloudSync payload must NOT include pageGrids');
        assert.ok(!('pageGrids' in (cloudPayloads[0].annotations || {})), 'annotations object in CloudSync must NOT contain pageGrids');

        // 7. Verify local PDF file on disk has both ReaderProAnnos and ReaderProGrids in InfoDict
        const savedPdfBytes = fs.readFileSync(pdfPath);
        const savedDoc = await PDFDocument.load(savedPdfBytes);
        const infoDict = savedDoc.getInfoDict();
        const annosHex = infoDict.get(PDFName.of('ReaderProAnnos'));
        const gridsHex = infoDict.get(PDFName.of('ReaderProGrids'));
        assert.ok(annosHex, 'Local PDF must contain ReaderProAnnos');
        assert.ok(gridsHex, 'Local PDF must contain ReaderProGrids');
        const decodedGrids = JSON.parse(new TextDecoder().decode(gridsHex.asBytes()));
        assert.ok(Array.isArray(decodedGrids['1']?.items) && decodedGrids['1'].items.length > 0);

        // 8. Clear IndexedDB and reload from disk PDF -> verify ReaderProGrids restores selectable text layer
        await page.evaluate(async () => { await localforage.clear(); });
        await page.reload();
        await page.click('#open-btn');
        await page.waitForFunction(() => state.pdfDoc?.numPages === 1 && state.pagesRendered.has(1));
        await page.evaluate(async () => { await state.annotationsReady; });
        await page.waitForFunction(() => document.querySelectorAll('#text-layer-1 span').length >= 8);

        const restoredText = await page.evaluate(() =>
            [...document.querySelectorAll('#text-layer-1 span')].map(s => s.textContent).join('')
        );
        assert.match(restoredText, /Theorem 1\.1 Continuity/);
        assert.deepEqual(pageErrors, []);
    } finally {
        await browser.close();
    }
})();
"""
        with tempfile.NamedTemporaryFile('w', suffix='.cjs', dir=str(ROOT / 'tests'), delete=False, encoding='utf-8') as f:
            f.write(script)
            script_path = Path(f.name)
        try:
            env = {
                **os.environ,
                'PW_PATH': str(playwright_dir),
                'EDGE_PATH': str(edge),
                'ROOT_DIR': str(ROOT),
                'TEMP_DIR': str(self.temp_root),
                'ORIGIN': self.origin,
            }
            proc = subprocess.run(
                [str(node), str(script_path)],
                cwd=str(ROOT),
                env=env,
                capture_output=True,
                text=True,
                encoding='utf-8',
                timeout=60,
            )
            self.assertEqual(proc.returncode, 0, f'Playwright test failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}')
            self.assertEqual(len(FakeVisionUpstream.calls), 1)
            upstream_call = FakeVisionUpstream.calls[0]
            self.assertEqual(upstream_call['auth'], 'Bearer glm-shared-secret-key')
            self.assertEqual(upstream_call['body']['model'], 'GLM-5.3-Flash')
            self.assertIn('3 个待识别文字行框', upstream_call['body']['messages'][0]['content'][0]['text'])
        finally:
            if script_path.exists():
                script_path.unlink()


if __name__ == '__main__':
    unittest.main()
