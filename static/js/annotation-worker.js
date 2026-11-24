importScripts('../lib/pdf-lib.min.js');
importScripts('./document-identity.js' + self.location.search);

function encodeUtf8ToHex(str) {
    const bytes = new TextEncoder().encode(str);
    const hex = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        hex[i] = bytes[i].toString(16).padStart(2, '0');
    }
    return hex.join('');
}

self.onmessage = async event => {
    try {
        if (event.data && event.data.action === 'save') {
            const buffer = await event.data.file.arrayBuffer();
            const pdfDoc = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true });
            const { PDFName, PDFHexString } = PDFLib;
            const fp = event.data.fingerprint || '';
            if (!pdfDoc.context.trailerInfo.ID && /^[a-f0-9]{32}$/i.test(fp)) {
                pdfDoc.context.trailerInfo.ID = pdfDoc.context.obj([
                    PDFHexString.of(fp), PDFHexString.of(fp)
                ]);
            }
            const infoDict = pdfDoc.getInfoDict();
            infoDict.set(PDFName.of('ReaderProAnnos'), PDFHexString.of(encodeUtf8ToHex(event.data.annotations || '{}')));
            const pageGrids = event.data.pageGrids || '{}';
            if (pageGrids && pageGrids !== '{}') {
                infoDict.set(PDFName.of('ReaderProGrids'), PDFHexString.of(encodeUtf8ToHex(pageGrids)));
            } else {
                infoDict.delete(PDFName.of('ReaderProGrids'));
            }
            const pdfBytes = await pdfDoc.save();
            self.postMessage({ pdfBytes }, [pdfBytes.buffer]);
            return;
        }

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
