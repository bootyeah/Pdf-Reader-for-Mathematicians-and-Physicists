// Neither a PDF's /ID nor its first 1KB uniquely identifies its contents.
// Hash the page graph (including fonts/images/content streams), independently
// of object numbers, xref layout, Info metadata and editable annotations.
// PDF-lib preserves this graph when saving ReaderProAnnos into the Info dict.
async function readerDocumentFingerprint(doc) {
    const seen = new Map();
    const visit = async value => {
        value = doc.context.lookup(value);
        if (value == null) return null;
        const composite = value.dict || typeof value.entries === 'function' || typeof value.asArray === 'function';
        if (!composite) {
            if (typeof value.asBytes === 'function') {
                return ['string', Array.from(value.asBytes(), b => b.toString(16).padStart(2, '0')).join('')];
            }
            return value.toString();
        }
        if (seen.has(value)) return ['ref', seen.get(value)];
        seen.set(value, seen.size);
        if (value.dict && typeof value.getContents === 'function') {
            return ['stream', await visit(value.dict), await readerContentHash(value.getContents())];
        }
        if (typeof value.entries === 'function') {
            const entries = value.entries().sort(([a], [b]) => a.toString() < b.toString() ? -1 : a.toString() > b.toString() ? 1 : 0);
            const type = entries.find(([key]) => key.toString() === '/Type')?.[1]?.toString();
            const result = [];
            for (const [key, item] of entries) {
                const name = key.toString();
                if ((type === '/Page' || type === '/Pages') && (name === '/Parent' || name === '/Annots')) continue;
                if (name === '/Length') continue; // Stream byte length is already covered by its digest.
                result.push([name, await visit(item)]);
            }
            return ['dict', result];
        }
        if (typeof value.asArray === 'function') {
            const result = [];
            for (const item of value.asArray()) result.push(await visit(item));
            return ['array', result];
        }
    };
    const pages = doc.catalog.get(PDFLib.PDFName.of('Pages'));
    const signature = new TextEncoder().encode(JSON.stringify(await visit(pages)));
    return (await readerContentHash(signature)).slice(0, 32);
}

const SHA256_CONSTANTS = (() => {
    const primes = [];
    for (let n = 2; primes.length < 64; n++) {
        if (primes.every(p => n % p !== 0)) primes.push(n);
    }
    const fraction = n => (n - Math.floor(n)) * 0x100000000 | 0;
    return {
        k: Int32Array.from(primes, p => fraction(Math.cbrt(p))),
        h0: primes.slice(0, 8).map(p => fraction(Math.sqrt(p))),
    };
})();

async function readerContentHash(buffer) {
    if (globalThis.crypto?.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }
    // Local-network HTTP has no SubtleCrypto. Same SHA-256, without a second
    // full-file copy; normally runs inside the annotation worker.
    const data = new Uint8Array(buffer);
    const constants = SHA256_CONSTANTS.k;
    const hash = SHA256_CONSTANTS.h0.slice();
    const words = new Int32Array(64);
    const rotate = (n, bits) => (n >>> bits) | (n << (32 - bits));
    const length = Math.ceil((data.length + 9) / 64) * 64;
    const bitLength = data.length * 8;
    for (let offset = 0; offset < length; offset += 64) {
        words.fill(0, 0, 16);
        for (let i = 0; i < 64; i++) {
            const pos = offset + i;
            let byte = pos < data.length ? data[pos] : pos === data.length ? 0x80 : 0;
            if (pos >= length - 8) byte = Math.floor(bitLength / 2 ** ((length - 1 - pos) * 8)) & 255;
            words[i >>> 2] |= byte << (24 - (i % 4) * 8);
        }
        for (let i = 16; i < 64; i++) {
            const x = words[i - 15], y = words[i - 2];
            words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
                words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let i = 0; i < 64; i++) {
            const t1 = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
                ((e & f) ^ (~e & g)) + constants[i] + words[i] | 0;
            const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
                ((a & b) ^ (a & c) ^ (b & c)) | 0;
            h = g; g = f; f = e; e = d + t1 | 0;
            d = c; c = b; b = a; a = t1 + t2 | 0;
        }
        [a, b, c, d, e, f, g, h].forEach((n, i) => { hash[i] = hash[i] + n | 0; });
    }
    return hash.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
}
