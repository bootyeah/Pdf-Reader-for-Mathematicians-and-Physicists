importScripts('../lib/pdf-lib.min.js');
importScripts('./document-identity.js' + self.location.search);
self.onmessage = async event => {
    try {
        const buffer = await event.data.file.arrayBuffer();
        const doc = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true });
        const fingerprint = await readerDocumentFingerprint(doc);
        const info = doc.getInfoDict();
        const obj = info.get(PDFLib.PDFName.of('ReaderProAnnos'));
        let annotations = {};
        let annotationError;
        try { if (obj?.value) {
            const bytes = new Uint8Array(obj.value.length / 2);
            for (let i = 0; i < obj.value.length; i += 2) bytes[i / 2] = parseInt(obj.value.substring(i, i + 2), 16);
            annotations = JSON.parse(new TextDecoder().decode(bytes));
        } } catch (error) { annotationError = String(error.message || error); }
        const gridObj = info.get(PDFLib.PDFName.of('ReaderProGrids'));
        let pageGrids = {};
        try { if (gridObj?.value) {
            const bytes = new Uint8Array(gridObj.value.length / 2);
            for (let i = 0; i < gridObj.value.length; i += 2) bytes[i / 2] = parseInt(gridObj.value.substring(i, i + 2), 16);
            pageGrids = JSON.parse(new TextDecoder().decode(bytes));
        } } catch (_) {}
        self.postMessage({ annotations, pageGrids, fingerprint, annotationError });
    } catch (error) {
        self.postMessage({ error: String(error.message || error) });
    }
};
