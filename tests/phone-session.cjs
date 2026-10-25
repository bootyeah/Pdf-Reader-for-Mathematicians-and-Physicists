// Deterministic phone lifecycle checks: no model calls, files, or real timers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

(async () => {
    let now = 0, timerId = 0, active = true, fail = false, latex = '', held = null;
    const timers = new Map(), events = new Map(), calls = [], changes = [], errors = [];
    const document = { hidden: false, addEventListener: (name, fn) => events.set(name, fn) };
    const window = { addEventListener() {} };
    const storage = new Map();
    let serverPairing = { connection: 'lan', status: 'ready', urls: ['test'], qr: 'test', pairingRev: 1 };
    const context = vm.createContext({ document, window, AbortController, Blob, navigator: { sendBeacon() {} },
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        async fetch(url, options) {
            const body = JSON.parse(options.body); calls.push(body);
            const pairing = { ...serverPairing };
            if (body.action === 'state' && held) { const wait = held; held = null; await wait; }
            if (body.action === 'state' && fail) throw new Error('test offline');
            if (body.action === 'connection') {
                serverPairing = { ...serverPairing, connection: body.connection, pairingRev: serverPairing.pairingRev + 1,
                    urls: [body.connection === 'internet' ? 'https://synthetic-board.trycloudflare.com/?t=test' : 'test'] };
                return { ok: true, json: async () => ({ ok: true, pairing: serverPairing }) };
            }
            return { ok: true, json: async () => body.action === 'start'
                ? { ok: true, session: 'keep-pairing', ...serverPairing }
                : { ok: true, pairing, rev: calls.length, result: latex ? { latex } : null } };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/phone-handwriting.js'), 'utf8'), context);
    const session = new window.PhoneHandwriting.Session({ engine: () => '', active: () => active,
        change: state => changes.push(state), error: message => errors.push(message) });
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const advance = async ms => {
        const target = now + ms;
        while (true) {
            const next = [...timers].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
            if (!next) break;
            now = next[1].due; timers.delete(next[0]); next[1].fn(); await flush();
        }
        now = target; await flush();
    };
    const stateCalls = () => calls.filter(c => c.action === 'state').length;
    await session.start(); await flush();
    assert.equal(stateCalls(), 1);
    await advance(2100); assert.equal(stateCalls(), 4, 'Visible panel syncs promptly');
    active = false; session.schedule();
    const inactiveCount = stateCalls();
    await advance(29999); assert.equal(stateCalls(), inactiveCount, 'Collapsed panel does not poll rapidly');
    await advance(1); assert.equal(stateCalls(), inactiveCount + 1, 'Pairing receives a low-frequency heartbeat');
    active = true; document.hidden = true; events.get('visibilitychange')();
    const hiddenCount = stateCalls();
    await advance(29999); assert.equal(stateCalls(), hiddenCount);
    await advance(1); assert.equal(stateCalls(), hiddenCount + 1);
    document.hidden = false; latex = '$new$'; events.get('visibilitychange')(); await flush();
    assert.equal(changes.at(-1).result.latex, '$new$', 'Returning to the page immediately fetches current results');
    active = false; session.schedule(); latex = '$while-hidden$'; active = true;
    await session.start(); await flush();
    assert.equal(changes.at(-1).result.latex, '$while-hidden$');
    assert.equal(calls.filter(c => c.action === 'start').length, 1, 'Reopening preserves pairing');

    let release;
    held = new Promise(resolve => { release = resolve; });
    const beforeRace = stateCalls();
    session.refresh(); await flush(); session.refresh(); session.refresh();
    assert.equal(stateCalls(), beforeRace + 1, 'Overlapping refreshes share the in-flight poll');
    release(); await flush();
    assert.equal(stateCalls(), beforeRace + 2, 'At most one follow-up poll is queued');
    await advance(700); assert.equal(stateCalls(), beforeRace + 3, 'Only one polling loop survives');

    fail = true; session.refresh(); await flush();
    const failedCount = stateCalls();
    await advance(1399); assert.equal(stateCalls(), failedCount, 'Failed queries back off');
    await advance(1); assert.equal(stateCalls(), failedCount + 1);
    assert.equal(errors.length, 2);
    fail = false; session.refresh(); await flush();
    const recoveredCount = stateCalls(); await advance(700);
    assert.equal(stateCalls(), recoveredCount + 1, 'Recovery restores normal sync');
    held = new Promise(resolve => { release = resolve; });
    session.refresh(); await flush();
    await session.setConnection('internet');
    assert.match(session.pairing.urls[0], /^https:/);
    release(); await flush();
    assert.equal(session.pairing.connection, 'internet', 'Late LAN state cannot overwrite a newer remote pairing');
    assert.equal(calls.filter(c => c.action === 'start').length, 1, 'Switching network preserves the phone session');
    assert.equal(storage.get('pdf_reader_phone_connection_formula'), 'internet');
    assert.equal(changes.at(-1).result.latex, '$while-hidden$', 'Switching preserves recognition results');
    session.close(); await flush(); const closedCount = stateCalls(); await advance(60000);
    assert.equal(stateCalls(), closedCount, 'Closing stops future polls');
    console.log('PASS Phone sessions preserve pairing, slow inactive polling, resume immediately, merge refreshes, and back off failures');
    const reopened = new window.PhoneHandwriting.Session({ engine: () => '', change() {}, error() {} });
    assert.equal(reopened.connection, 'internet', 'Reopening restores the selected connection mode');
    await reopened.start(); assert.equal(calls.filter(c => c.action === 'start').at(-1).connection, 'internet');
    reopened.close(); await flush();
    console.log('PASS Internet mode preserves sessions/results, rejects stale pairing responses, and restores the saved preference');
})().catch(error => { console.error(error); process.exitCode = 1; });
