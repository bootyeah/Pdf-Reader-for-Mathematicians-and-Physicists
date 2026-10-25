// Real browser, generated PDFs, mocked writes/translation/TikZ; no user files or paid APIs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, startServer, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));
const { PDFDocument, PDFName, PDFHexString } = require('../static/lib/pdf-lib.min.js');

(async () => {
    const doc = await PDFDocument.load(await fixture('text', 8));
    doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of('abcdef0123456789abcdef0123456789'), PDFHexString.of('abcdef0123456789abcdef0123456789')]);
    const a = Buffer.from(await doc.save());
    doc.getInfoDict().set(PDFName.of('ReaderProAnnos'), PDFHexString.of(Buffer.from(JSON.stringify({
        1: [{ id: 'saved-highlight', type: 'highlight', color: '#ef4444', rects: [] },
            { id: 'external', type: 'highlight', color: '#fde047', rects: [] }], settings: { lastPage: 1 }
    })).toString('hex')));
    const server = await startServer({ 'a.pdf': a, 'external.pdf': Buffer.from(await doc.save()),
        'b.pdf': await fixture('text', 3, 'B'), 'c.pdf': await fixture('text', 8, 'C') });
    const browser = await chromium.launch({ executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const errors = [];
    const context = await browser.newContext();
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    const setup = async () => page.evaluate(() => {
        window.testAlerts = [];
        window.alert = message => testAlerts.push(message);
        window.testFile = async name => new File([await (await fetch('/fixtures/' + name)).blob()], name, { type: 'application/pdf' });
        window.testOpen = async name => {
            await processSelectedFile(await testFile(name), null);
            await state.annotationsReady;
        };
        window.testAnno = id => ({ id, type: 'highlight', color: '#fde047', rects: [] });
    });
    try {
        await page.goto(origin + '/LOCALPdfReader.html');
        await setup();
        await page.evaluate(() => testOpen('a.pdf'));
        assert.deepEqual(await page.evaluate(() => {
            const length = state.history.length;
            performAction(() => {}, [1]);
            return { dirty: state.unsavedChanges, unchangedHistory: state.history.length === length };
        }), { dirty: false, unchangedHistory: true });
        console.log('PASS no-op actions do not mark the PDF dirty or add history');

        await page.evaluate(async () => {
            performAction(() => { state.annotations[1] = [testAnno('local-draft')]; }, [1]);
            await saveAnnotationsToStorage();
        });
        await page.reload();
        await setup();
        await page.evaluate(() => testOpen('a.pdf'));
        assert.deepEqual(await page.evaluate(() => ({ ids: state.annotations[1].map(a => a.id), dirty: state.unsavedChanges })),
            { ids: ['local-draft'], dirty: true });
        console.log('PASS reload restores unsaved local additions and deletions over old embedded annotations');

        await page.evaluate(() => testOpen('external.pdf'));
        assert.deepEqual(await page.evaluate(() => state.annotations[1].map(a => a.id).sort()), ['external', 'local-draft']);
        console.log('PASS external PDF changes and local draft changes merge from their common baseline');

        const saving = await page.evaluate(async () => {
            let reached, release;
            const entered = new Promise(resolve => { reached = resolve; });
            const gate = new Promise(resolve => { release = resolve; });
            let bytes;
            state.fileHandle = { queryPermission: async () => 'granted', createWritable: async () => ({
                write: async blob => { bytes = await blob.arrayBuffer(); reached(); await gate; }, close: async () => {}
            }) };
            const pending = performSave();
            await entered;
            performAction(() => { state.annotations[1].push(testAnno('during-save')); }, [1]);
            release(); await pending;
            const pdf = await PDFLib.PDFDocument.load(bytes);
            const saved = JSON.parse(new TextDecoder().decode(pdf.getInfoDict().get(PDFLib.PDFName.of('ReaderProAnnos')).asBytes()));
            await saveAnnotationsToStorage();
            return { saved: saved[1].map(a => a.id).sort(), dirty: state.unsavedChanges,
                rawIsBlob: state.rawFile instanceof File, hasPdfData: 'pdfData' in state,
                localMeta: (await localforage.getItem('pdf_annos_' + state.fingerprint)).__readerLocalState.unsaved };
        });
        assert.deepEqual(saving, { saved: ['external', 'local-draft'], dirty: true, rawIsBlob: true, hasPdfData: false, localMeta: true });
        console.log('PASS edits during saving stay dirty; saved bytes contain one consistent snapshot and no permanent PDF buffer');

        const switched = await page.evaluate(async () => {
            let reached, release;
            const entered = new Promise(resolve => { reached = resolve; });
            const gate = new Promise(resolve => { release = resolve; });
            const original = state.rawFile;
            state.rawFile = { arrayBuffer: async () => { reached(); await gate; return original.arrayBuffer(); } };
            let writes = 0;
            state.fileHandle = { queryPermission: async () => 'granted', createWritable: async () => {
                writes++; return { write: async () => {}, close: async () => {} };
            } };
            const pending = performSave();
            await entered;
            await testOpen('b.pdf');
            const file = state.rawFile;
            release(); await pending;
            return { writes, fileName: state.fileName, sameFile: state.rawFile === file, dirty: state.unsavedChanges, saving: state.isSaving };
        });
        assert.deepEqual(switched, { writes: 0, fileName: 'b.pdf', sameFile: true, dirty: false, saving: false });
        console.log('PASS switching PDFs during encoding cancels the old save without touching the new document');

        const writtenDuringSwitch = await page.evaluate(async () => {
            await testOpen('a.pdf');
            let reached, release;
            const entered = new Promise(resolve => { reached = resolve; });
            const gate = new Promise(resolve => { release = resolve; });
            let bytes;
            state.fileHandle = { queryPermission: async () => 'granted', createWritable: async () => ({
                write: async blob => { bytes = await blob.arrayBuffer(); reached(); await gate; }, close: async () => {}
            }) };
            const pending = performSave(); await entered;
            await testOpen('b.pdf'); const raw = state.rawFile;
            release(); await pending;
            const pdf = await PDFLib.PDFDocument.load(bytes);
            return { writtenPages: pdf.getPageCount(), fileName: state.fileName, unchanged: raw === state.rawFile,
                dirty: state.unsavedChanges, handle: state.fileHandle };
        });
        assert.deepEqual(writtenDuringSwitch, { writtenPages: 8, fileName: 'b.pdf', unchanged: true, dirty: false, handle: null });
        console.log('PASS an already dispatched write finishes only on its captured old file handle');

        const orderedWrites = await page.evaluate(async () => {
            await saveAnnotationsToStorage();
            const setItem = localforage.setItem.bind(localforage);
            const snapshots = [];
            let release, started;
            const entered = new Promise(resolve => { started = resolve; });
            const gate = new Promise(resolve => { release = resolve; });
            localforage.setItem = async (key, value) => {
                if (key.startsWith('pdf_annos_')) {
                    snapshots.push(JSON.parse(JSON.stringify(value)));
                    if (snapshots.length === 1) { started(); await gate; }
                }
                return setItem(key, value);
            };
            try {
                performAction(() => { state.annotations[1] = [testAnno('first')]; }, [1]);
                await entered;
                for (let i = 0; i < 20; i++) performAction(() => { state.annotations[1] = [testAnno('latest-' + i)]; }, [1]);
                const pending = saveAnnotationsToStorage();
                release(); await pending;
                const stored = await localforage.getItem('pdf_annos_' + state.fingerprint);
                return { count: snapshots.length, first: snapshots[0][1][0].id, last: stored[1][0].id };
            } finally { localforage.setItem = setItem; }
        });
        assert.deepEqual(orderedWrites, { count: 2, first: 'first', last: 'latest-19' });
        console.log('PASS rapid edits serialize and coalesce IndexedDB writes without mutating queued snapshots');

        const outline = await page.evaluate(async () => {
            const original = state.pdfDoc.getDestination;
            state.pdfDoc.getDestination = async name => {
                await new Promise(resolve => setTimeout(resolve, name === 'parent' ? 50 : 1));
                return [name === 'second' ? 1 : 0, { name: 'Fit' }];
            };
            try {
                await renderOutline([{ title: 'parent', dest: 'parent', items: [{ title: 'child', dest: 'child' }] },
                    { title: 'second', dest: 'second' }]);
                await new Promise(resolve => setTimeout(resolve, 120));
                state.currentPhysicalPage = 1; updateCurrentOutline();
                const active = document.querySelector('.active-outline').textContent;
                await navigateToDestination([1, { name: 'Fit' }]);
                return { active, order: state.outlineMap.map(item => item.element.textContent) };
            } finally { state.pdfDoc.getDestination = original; }
        });
        assert.deepEqual(outline, { active: 'child', order: ['parent', 'child', 'second'] });
        console.log('PASS delayed parent destinations cannot displace same-page children; numeric PDF destinations work');

        const tikz = await page.evaluate(async () => {
            const original = window.fetch;
            window.fetch = async (url, options) => url === '/api/render-tikz' ? new Response('syntax error', { status: 500 }) : original(url, options);
            const node = document.createElement('div'); document.body.appendChild(node);
            try {
                await renderTikzToImg('\\begin{tikzpicture}broken\\end{tikzpicture}', node);
                const result = await Promise.race([
                    renderTikzToImg('\\begin{tikzpicture}broken\\end{tikzpicture}', node).then(() => 'settled'),
                    new Promise(resolve => setTimeout(() => resolve('hung'), 500))
                ]);
                return { result, visibleError: node.textContent.includes('渲染失败') };
            } finally { window.fetch = original; node.remove(); }
        });
        assert.deepEqual(tikz, { result: 'settled', visibleError: true });
        console.log('PASS cached TikZ failures resolve immediately instead of hanging forever');

        const zoomSwitch = await page.evaluate(async () => {
            updateZoom(2);
            await testOpen('a.pdf');
            await new Promise(resolve => setTimeout(resolve, 400));
            return state.isZooming;
        });
        assert.equal(zoomSwitch, false);
        console.log('PASS switching during zoom clears the old zoom timer and state');

        const earlyHistory = await page.evaluate(async () => {
            const original = readEmbeddedAnnotations;
            readEmbeddedAnnotations = async (...args) => {
                await new Promise(resolve => setTimeout(resolve, 120));
                return original(...args);
            };
            try {
                await processSelectedFile(await testFile('c.pdf'), null);
                for (let i = 0; i < 70; i++) performAction(() => {
                    state.annotations[1] ||= [];
                    state.annotations[1].push(testAnno('early-' + i));
                }, [1]);
                await state.annotationsReady;
                const count = state.annotations[1].length;
                const saved = state.annotations[1].some(a => a.id === 'saved-highlight');
                undo(); const undoCount = state.annotations[1].length;
                redo();
                return { count, saved, undoCount, redoCount: state.annotations[1].length, history: state.history.length };
            } finally { readEmbeddedAnnotations = original; }
        });
        assert.deepEqual(earlyHistory, { count: 71, saved: true, undoCount: 70, redoCount: 71, history: 50 });
        console.log('PASS over 50 edits during recovery keep the original annotations and a valid bounded undo history');

        const emptyMime = await page.evaluate(async () => {
            const original = await testFile('b.pdf');
            await processSelectedFile(new File([original], 'valid.PDF', { type: '' }), null);
            await state.annotationsReady;
            return { name: state.fileName, pages: state.pdfDoc.numPages };
        });
        assert.deepEqual(emptyMime, { name: 'valid.PDF', pages: 3 });
        console.log('PASS PDF files with an empty browser MIME type still open');

        const brokenLoad = await page.evaluate(async () => {
            await processSelectedFile(new File(['not a PDF'], 'broken.pdf', { type: 'application/pdf' }), null);
            const result = { doc: state.pdfDoc, blob: state.blobUrl, disabled: els.saveStatusBtn.disabled, alerts: testAlerts.length };
            testAlerts.length = 0;
            await testOpen('b.pdf');
            return result;
        });
        assert.deepEqual(brokenLoad, { doc: null, blob: null, disabled: true, alerts: 1 });
        console.log('PASS failed PDF loads release resources and disable saving; the next valid file still opens');

        const importing = await page.evaluate(() => {
            const anno = { id: 'editing-import', type: 'text', text: 'before', x: .1, y: .1 };
            performAction(() => { state.annotations[1].push(anno); }, [1]);
            openNoteModal(anno, 1, 300, 200, true);
            els.noteInput.value = 'committed before importing';
            importAnnotationBundle({ app: 'PDFReaderPro', fingerprint: state.fingerprint,
                annotations: { 1: [testAnno('duplicate-import'), testAnno('duplicate-import')] } }, { mode: 'merge' });
            return { text: state.annotations[1].find(a => a.id === 'editing-import').text,
                count: state.annotations[1].filter(a => a.id === 'duplicate-import').length,
                closed: els.noteModal.classList.contains('hidden'), editing: state.isEditingNote };
        });
        assert.deepEqual(importing, { text: 'committed before importing', count: 1, closed: true, editing: false });
        console.log('PASS importing commits and closes the active editor and deduplicates IDs within a bundle');

        const lateImport = await page.evaluate(async () => {
            const original = window.FileReader;
            let reader;
            window.FileReader = class { constructor() { reader = this; } readAsText() {} };
            try {
                const transfer = new DataTransfer(); transfer.items.add(new File(['{}'], 'old-import.json'));
                importAnnoInput.files = transfer.files;
                importAnnoInput.dispatchEvent(new Event('change'));
                await testOpen('a.pdf');
                const before = JSON.stringify(state.annotations);
                reader.onload({ target: { result: JSON.stringify({ app: 'PDFReaderPro', fingerprint: state.fingerprint,
                    annotations: { 1: [testAnno('stale-import')] } }) } });
                return JSON.stringify(state.annotations) === before;
            } finally { window.FileReader = original; }
        });
        assert.equal(lateImport, true);
        console.log('PASS a delayed local import cannot apply to a newly opened PDF');

        const stableFingerprint = await page.evaluate(async () => {
            await testOpen('c.pdf');
            const before = state.fingerprint;
            let saved;
            state.fileHandle = { queryPermission: async () => 'granted', createWritable: async () => ({
                write: async blob => { saved = new File([blob], 'c.pdf', { type: 'application/pdf' }); }, close: async () => {}
            }) };
            await performSave();
            performAction(() => { state.annotations[1].push(testAnno('after-first-save')); }, [1]);
            await saveAnnotationsToStorage();
            await processSelectedFile(saved, null); await state.annotationsReady;
            return { same: state.fingerprint === before,
                draftRestored: state.annotations[1].some(a => a.id === 'after-first-save'), dirty: state.unsavedChanges };
        });
        assert.deepEqual(stableFingerprint, { same: true, draftRestored: true, dirty: true });
        console.log('PASS saving a PDF without an original document ID preserves its fingerprint and subsequent local drafts');

        await page.evaluate(async () => {
            scrollPdfPageIntoView(2); recordJumpPosition();
            await testOpen('a.pdf');
        });
        assert.equal(await page.evaluate(() => state.lastScrollPosition), null);
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => testAlerts), []);
        console.log('PASS switching documents clears return-position state; no uncaught browser errors');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
