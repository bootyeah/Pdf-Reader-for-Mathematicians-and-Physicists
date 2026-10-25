// Real PDFs with identical first 1KB, different page content, and no trailer /ID.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { startServer, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

function pdf(marker, id = '') {
    let body = '%PDF-1.7\n%' + 'shared header '.repeat(120) + '\n';
    const content = `BT /F1 20 Tf 50 700 Td (Document ${marker}) Tj ET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
    ];
    const offsets = [0];
    objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = body.length;
    body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
    body += `trailer\n<< /Size 6 /Root 1 0 R ${id ? `/ID [<${id}> <${id}>]` : ''} >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(body);
}

(async () => {
    const fallback = vm.createContext({ crypto: {} });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/document-identity.js'), 'utf8'), fallback);
    for (const size of [0, 1, 55, 56, 63, 64, 65, 1024, 4097]) {
        const input = Uint8Array.from({ length: size }, (_, i) => i % 251);
        fallback.input = input.buffer;
        assert.equal(await vm.runInContext('readerContentHash(input)', fallback), createHash('sha256').update(input).digest('hex'));
    }
    console.log('PASS HTTP fallback SHA-256 matches native hashing at padding and block boundaries');
    const a = pdf('A'), b = pdf('B');
    assert(a.subarray(0, 1024).equals(b.subarray(0, 1024)));
    assert.equal(a.length, b.length);
    const sharedId = '68f12588b6fc799f3b53d61396c24f00';
    const server = await startServer({ 'a.pdf': a, 'b.pdf': b,
        'c.pdf': pdf('C', sharedId), 'd.pdf': pdf('D', sharedId) });
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`);
        await page.evaluate(() => {
            window.openFixture = async name => {
                const blob = await (await fetch('/fixtures/' + name)).blob();
                // Same display name and size: neither is a reliable document identity.
                await loadPDFFromFile(new File([blob], 'same-name.pdf', { type: 'application/pdf' }));
                await state.annotationsReady;
            };
            window.addDraft = async id => {
                performAction(() => { state.annotations[1] = [{ id, type: 'highlight', rects: [], color: '#fde047' }]; }, [1]);
                await saveAnnotationsToStorage();
            };
        });
        await page.evaluate(async () => { await openFixture('a.pdf'); await addDraft('only-A'); });
        const fpA = await page.evaluate(() => state.fingerprint);
        const oldKey = await page.evaluate(async () => {
            const key = 'pdf_annos_' + state.pdfDoc.fingerprints[0];
            await localforage.setItem(key, { 1: [{ id: 'ambiguous-old-cache', type: 'highlight', rects: [] }] });
            return key;
        });
        await page.evaluate(() => openFixture('b.pdf'));
        assert.deepEqual(await page.evaluate(() => state.annotations[1] || []), [], 'B must never restore A annotations');
        assert.notEqual(await page.evaluate(() => state.fingerprint), fpA);
        await page.evaluate(() => addDraft('only-B'));
        await page.evaluate(() => openFixture('a.pdf'));
        assert.deepEqual(await page.evaluate(() => state.annotations[1].map(a => a.id)), ['only-A']);
        console.log('PASS identical prefixes, sizes and names do not share annotations; each PDF restores its own draft');
        assert.equal(await page.evaluate(async key => (await localforage.getItem(key))[1][0].id, oldKey), 'ambiguous-old-cache');
        console.log('PASS ambiguous legacy cache is preserved without automatically importing it');
        await page.evaluate(async () => {
            const original = window.Worker;
            window.Worker = undefined;
            try { await openFixture('b.pdf'); }
            finally { window.Worker = original; }
        });
        assert.deepEqual(await page.evaluate(() => state.annotations[1].map(a => a.id)), ['only-B']);
        console.log('PASS worker-unavailable fallback uses the same identity and restores only B');
        await page.evaluate(async () => {
            const original = readEmbeddedAnnotations;
            let entered, release;
            const started = new Promise(resolve => { entered = resolve; });
            const gate = new Promise(resolve => { release = resolve; });
            readEmbeddedAnnotations = async (...args) => {
                const result = await original(...args);
                entered(); await gate;
                return result;
            };
            const pending = openFixture('a.pdf');
            await started;
            readEmbeddedAnnotations = original;
            await openFixture('b.pdf');
            release(); await pending;
        });
        assert.deepEqual(await page.evaluate(() => state.annotations[1].map(a => a.id)), ['only-B']);
        console.log('PASS delayed identity/annotations from A cannot overwrite B after a switch');
        await page.evaluate(async () => { await openFixture('d.pdf'); await addDraft('only-D'); });
        const identityD = await page.evaluate(() => ({ fingerprint: state.fingerprint, legacy: state.pdfDoc.fingerprints[0] }));
        await page.evaluate(() => openFixture('c.pdf'));
        assert.equal(await page.evaluate(() => state.pdfDoc.fingerprints[0]), identityD.legacy);
        assert.notEqual(await page.evaluate(() => state.fingerprint), identityD.fingerprint);
        assert.deepEqual(await page.evaluate(() => state.annotations[1] || []), []);
        await page.evaluate(async () => { await addDraft('only-C'); await openFixture('d.pdf'); });
        assert.deepEqual(await page.evaluate(() => state.annotations[1].map(a => a.id)), ['only-D']);
        const stable = await page.evaluate(async () => {
            const doc = await PDFLib.PDFDocument.load(await state.rawFile.arrayBuffer());
            doc.getInfoDict().set(PDFLib.PDFName.of('ReaderProAnnos'), PDFLib.PDFHexString.of('7b7d'));
            // Changing metadata and xref/object-stream layout must not change identity.
            doc.setTitle('Updated metadata');
            const saved = new File([await doc.save()], 'renamed.pdf', { type: 'application/pdf' });
            await loadPDFFromFile(saved); await state.annotationsReady;
            return { fingerprint: state.fingerprint, ids: state.annotations[1].map(a => a.id) };
        });
        assert.deepEqual(stable, { fingerprint: identityD.fingerprint, ids: ['only-D'] });
        console.log('PASS different PDFs sharing a trailer ID keep separate drafts; annotation saves, renames and metadata updates retain identity');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
