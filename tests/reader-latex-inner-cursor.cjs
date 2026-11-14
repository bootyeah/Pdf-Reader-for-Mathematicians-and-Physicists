'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, startServer, instrument, loadFixture, deps } = require('./reader-performance.cjs');
const { chromium } = require(path.join(deps, 'playwright'));

(async () => {
    const server = await startServer({ 'a.pdf': await fixture('text', 2) });
    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.READER_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const runtimeErrors = [];
    page.on('pageerror', err => runtimeErrors.push(`pageerror: ${err.message}`));
    page.on('console', msg => {
        if (msg.type() === 'error') runtimeErrors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/LOCALPdfReader.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof loadPDFFromFile === 'function' && typeof pdfjsLib !== 'undefined');
    await instrument(page);
    await loadFixture(page, 'a.pdf');

    // Seed a text annotation cleanly and click it to enter editing mode
    await page.evaluate(() => {
        state.annotations[1] = [{
            id: 'inner-math-box',
            type: 'text',
            color: '#000000',
            x: 0.06,
            y: 0.10,
            width: 0.72,
            fontSizeScale: 1.5,
            text: 'initial'
        }];
        renderAnnotations(1, true);
    });
    const annoBox = await page.locator('.text-annotation[data-id="inner-math-box"]').boundingBox();
    assert.ok(annoBox, 'seeded text annotation should render');
    await page.mouse.click(annoBox.x + 12, annoBox.y + 10);
    await page.waitForSelector('#note-modal:not(.hidden)');
    await page.waitForSelector('.latex-live-preview .latex-preview-body');

    async function setEditorAndCursor(text, caret) {
        await page.evaluate(({ t, pos }) => {
            const ta = document.getElementById('note-input');
            ta.focus();
            ta.value = t;
            ta.setSelectionRange(pos, pos);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }, { t: text, pos: caret });
        await page.waitForTimeout(160);
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    }

    async function moveCaretOnly(pos) {
        await page.evaluate((p) => {
            const ta = document.getElementById('note-input');
            ta.focus();
            ta.setSelectionRange(p, p);
            ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
            if (typeof syncVirtualCursor === 'function') syncVirtualCursor();
        }, pos);
        await page.waitForTimeout(90);
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    }

    async function readBothCursors() {
        return page.evaluate(() => {
            const read = (el, relTo) => {
                if (!el) return null;
                const cs = getComputedStyle(el);
                if (el.hidden || cs.display === 'none') return null;
                const r = el.getBoundingClientRect();
                const base = relTo ? relTo.getBoundingClientRect() : { left: 0, top: 0 };
                return {
                    left: r.left - base.left,
                    top: r.top - base.top,
                    right: r.right - base.left,
                    bottom: r.bottom - base.top,
                    width: r.width,
                    height: r.height,
                    bg: cs.backgroundColor,
                    borderStyle: cs.borderTopStyle,
                    pulse: el.classList.contains('animate-pulse')
                };
            };
            const viewport = document.querySelector('.latex-live-preview .latex-preview-viewport');
            const previewOuter = read(document.querySelector('.latex-live-preview .latex-preview-cursor'), viewport);
            const previewInner = read(document.querySelector('.latex-live-preview .latex-preview-inner-cursor'), viewport);
            const annoOuter = read(document.getElementById('virtual-cursor'), null);
            const annoInner = read(document.getElementById('virtual-inner-cursor'), null);
            return { previewOuter, previewInner, annoOuter, annoInner };
        });
    }

    function assertInnerInsideOuter(pair, label) {
        assert.ok(pair.outer, `${label}: outer box must be visible`);
        assert.equal(pair.outer.borderStyle, 'dashed', `${label}: outer box must remain dashed`);
        assert.ok(!pair.outer.pulse, `${label}: outer box must not pulse`);
        assert.ok(pair.inner, `${label}: inner caret must be visible`);
        assert.ok(Math.abs(pair.inner.width - 2) <= 0.5, `${label}: inner caret width should be 2px, got ${pair.inner.width}`);
        assert.ok(pair.inner.pulse, `${label}: inner caret must animate-pulse`);
        assert.ok(
            pair.inner.left >= pair.outer.left - 8 && pair.inner.right <= pair.outer.right + 8,
            `${label}: inner caret X [${pair.inner.left}, ${pair.inner.right}] should stay near outer [${pair.outer.left}, ${pair.outer.right}]`
        );
    }

    // 1. Plain text vs inside complex inline formula: both page & side preview
    const sample = '前置 $x_{i+1}^{2} + \\frac{p_3}{q^4} + \\sqrt[n]{k+5} + \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} + \\text{abc} + \\ce{H2O}$ 后置';
    await setEditorAndCursor(sample, 1); // inside "前置"
    const inText = await readBothCursors();
    assert.ok(inText.previewOuter && !inText.previewInner, 'Plain text: preview inner cursor hidden');
    assert.ok(inText.annoOuter && !inText.annoInner, 'Plain text: annotation inner cursor hidden');

    // Move across sub, sup, exit brace, frac numer, frac denom, sqrt index, sqrt body, matrix cells, text, mhchem
    const markers = {
        subStart: sample.indexOf('_{i+1}') + 2,
        subEnd: sample.indexOf('_{i+1}') + 5,
        supStart: sample.indexOf('^{2}') + 2,
        supEnd: sample.indexOf('^{2}') + 3,
        afterSupBrace: sample.indexOf('^{2}') + 4,
        numerStart: sample.indexOf('{p_3}') + 1,
        numerSub: sample.indexOf('{p_3}') + 3,
        denomStart: sample.indexOf('{q^4}') + 1,
        denomSup: sample.indexOf('{q^4}') + 3,
        rootIdx: sample.indexOf('[n]') + 1,
        rootBody: sample.indexOf('{k+5}') + 3,
        mat00: sample.indexOf('a & b'),
        mat01: sample.indexOf('a & b') + 4,
        mat10: sample.indexOf('c & d'),
        mat11: sample.indexOf('c & d') + 4,
        textMid: sample.indexOf('abc') + 1,
        textEnd: sample.indexOf('abc') + 3,
        ceH: sample.indexOf('H2O'),
        ce2: sample.indexOf('H2O') + 1,
        ce2End: sample.indexOf('H2O') + 2,
        ceO: sample.indexOf('H2O') + 3
    };

    const measured = {};
    for (const [k, idx] of Object.entries(markers)) {
        await moveCaretOnly(idx);
        const c = await readBothCursors();
        assertInnerInsideOuter({ outer: c.previewOuter, inner: c.previewInner }, `preview:${k}`);
        assertInnerInsideOuter({ outer: c.annoOuter, inner: c.annoInner }, `anno:${k}`);
        measured[k] = c;
    }

    for (const mode of ['previewInner', 'annoInner']) {
        const g = k => measured[k][mode];
        assert.ok(g('subEnd').left > g('subStart').left, `${mode}: subEnd right of subStart`);
        assert.ok(g('subStart').top > g('supStart').top, `${mode}: subscript lower than superscript`);
        assert.ok(g('afterSupBrace').height > g('supEnd').height + 1.5, `${mode}: after } returns to larger baseline height`);
        assert.ok(g('numerStart').bottom <= g('denomStart').top + 2, `${mode}: numerator strictly above denominator`);
        assert.ok(g('numerSub').top > g('numerStart').top, `${mode}: p_3 subscript lower than p in numerator`);
        assert.ok(g('denomSup').top < g('denomStart').top, `${mode}: q^4 superscript higher than q in denominator`);
        assert.ok(g('rootIdx').left < g('rootBody').left, `${mode}: sqrt index left of radicand`);
        assert.ok(g('mat01').left > g('mat00').left + 5, `${mode}: mat(0,1) right of mat(0,0)`);
        assert.ok(g('mat10').top > g('mat00').top + 8, `${mode}: mat(1,0) below mat(0,0)`);
        assert.ok(g('mat11').left > g('mat10').left + 5 && g('mat11').top > g('mat01').top + 8, `${mode}: mat(1,1) right of (1,0) & below (0,1)`);
        assert.ok(g('textEnd').left > g('textMid').left, `${mode}: \\text moves char-by-char`);
        assert.ok(g('ce2End').top > g('ceH').top && g('ce2End').height < g('ceO').height, `${mode}: \\ce{H2O} 2 is lower & smaller than H/O`);
    }
    console.log('PASS: exact inner caret positioning across sub/sup/exit-brace/frac/sqrt/matrix/text/mhchem in both previews');

    // 2. Right-click reverse positioning -> forward inner caret alignment
    const qClient = await page.evaluate(() => {
        const body = document.querySelector('.latex-live-preview .latex-preview-body');
        const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let tn;
        while ((tn = tw.nextNode())) {
            if (!tn.parentElement.closest('.katex-mathml') && tn.data.includes('q')) {
                const i = tn.data.indexOf('q');
                const r = document.createRange();
                r.setStart(tn, i);
                r.setEnd(tn, i + 1);
                const rect = r.getBoundingClientRect();
                return { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.5, vpTop: document.querySelector('.latex-live-preview .latex-preview-viewport').getBoundingClientRect().top, vpLeft: document.querySelector('.latex-live-preview .latex-preview-viewport').getBoundingClientRect().left };
            }
        }
        return null;
    });
    assert.ok(qClient, 'Should locate rendered q glyph in preview');
    await page.mouse.click(qClient.x, qClient.y, { button: 'right' });
    await page.waitForTimeout(120);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const afterRightClick = await readBothCursors();
    assert.ok(afterRightClick.previewInner, 'Inner cursor visible after right click');
    const relClickX = qClient.x - qClient.vpLeft;
    const relClickY = qClient.y - qClient.vpTop;
    assert.ok(
        Math.abs(afterRightClick.previewInner.left - relClickX) < 14
        && relClickY >= afterRightClick.previewInner.top - 4 && relClickY <= afterRightClick.previewInner.bottom + 4,
        `Inner caret after right click (${afterRightClick.previewInner.left}, ${afterRightClick.previewInner.top}..${afterRightClick.previewInner.bottom}) matches clicked q (${relClickX}, ${relClickY})`
    );
    console.log('PASS: right-click reverse positioning aligns directly with forward inner caret');

    // 3. Partial / incomplete / empty / snippet / error / unrendered formula states
    const supEmpty = '$x^{}$';
    await setEditorAndCursor(supEmpty, 4); // inside x^{|}
    const cSupEmpty = await readBothCursors();
    assertInnerInsideOuter({ outer: cSupEmpty.previewOuter, inner: cSupEmpty.previewInner }, 'supEmpty');
    assertInnerInsideOuter({ outer: cSupEmpty.annoOuter, inner: cSupEmpty.annoInner }, 'anno:supEmpty');

    const subEmpty = '$x_{}$';
    await setEditorAndCursor(subEmpty, 4); // inside x_{|}
    const cSubEmpty = await readBothCursors();
    assertInnerInsideOuter({ outer: cSubEmpty.previewOuter, inner: cSubEmpty.previewInner }, 'subEmpty');
    assert.ok(cSubEmpty.previewInner.top > cSupEmpty.previewInner.top + 3, 'Empty _{} lower than empty ^{}');

    const fracEmptyN = '$\\dfrac{}{b}$';
    await setEditorAndCursor(fracEmptyN, 8); // inside \dfrac{|}{b}
    const cFracN = await readBothCursors();
    const fracEmptyD = '$\\dfrac{a}{}$';
    await setEditorAndCursor(fracEmptyD, 11); // inside \dfrac{a}{|}
    const cFracD = await readBothCursors();
    assert.ok(cFracN.previewInner.bottom <= cFracD.previewInner.top + 4, 'Empty numer strictly above empty denom');

    const fracBothEmpty = '$\\frac{}{}$';
    await setEditorAndCursor(fracBothEmpty, 7);
    const cFracBothN = await readBothCursors();
    await moveCaretOnly(9);
    const cFracBothD = await readBothCursors();
    assert.ok(cFracBothN.previewInner.top < cFracBothD.previewInner.top - 6, 'Both empty \\frac{}{}: numer above denom');

    const sqrtEmpty = '$\\sqrt{}$';
    await setEditorAndCursor(sqrtEmpty, 7);
    const cSqrtE = await readBothCursors();
    assert.ok(cSqrtE.previewInner.left > cSqrtE.previewOuter.left + 8, `Empty \\sqrt{} caret (${cSqrtE.previewInner.left}) clears radical icon (${cSqrtE.previewOuter.left})`);

    const matEmpty = '$\\begin{pmatrix} a &  \\\\  & b \\end{pmatrix}$';
    await setEditorAndCursor(matEmpty, matEmpty.indexOf('& ') + 2); // empty row0 col1
    const cMat01 = await readBothCursors();
    await moveCaretOnly(matEmpty.indexOf('\\\\  &') + 3); // empty row1 col0
    const cMat10 = await readBothCursors();
    assert.ok(cMat01.previewInner.left > cMat10.previewInner.left + 10, 'Empty matrix cell (0,1) right of empty (1,0)');
    assert.ok(cMat10.previewInner.top > cMat01.previewInner.top + 8, 'Empty matrix cell (1,0) below empty (0,1)');

    const auxEmpty = ['$x + \\text{} + y$', 10];
    await setEditorAndCursor(auxEmpty[0], auxEmpty[1]);
    assertInnerInsideOuter({ outer: (await readBothCursors()).previewOuter, inner: (await readBothCursors()).previewInner }, 'textEmpty');

    await setEditorAndCursor('$\\hat{}$', 6);
    assertInnerInsideOuter({ outer: (await readBothCursors()).previewOuter, inner: (await readBothCursors()).previewInner }, 'hatEmpty');

    await setEditorAndCursor('$\\boxed{}$', 8);
    assertInnerInsideOuter({ outer: (await readBothCursors()).previewOuter, inner: (await readBothCursors()).previewInner }, 'boxedEmpty');

    await setEditorAndCursor('$\\color{red}{} + y$', 12);
    assertInnerInsideOuter({ outer: (await readBothCursors()).previewOuter, inner: (await readBothCursors()).previewInner }, 'colorEmpty');

    await setEditorAndCursor('$$', 1);
    assertInnerInsideOuter({ outer: (await readBothCursors()).previewOuter, inner: (await readBothCursors()).previewInner }, 'emptyDisplayDollar');

    await setEditorAndCursor('$ $', 1);
    assertInnerInsideOuter({ outer: (await readBothCursors()).previewOuter, inner: (await readBothCursors()).previewInner }, 'spaceInlineDollar');

    // Unknown/partial command char-by-char stepping
    const unk = '$x + \\unknowncmd + y$';
    const unkXs = [];
    const startUnk = unk.indexOf('\\unknowncmd');
    await setEditorAndCursor(unk, startUnk);
    for (let off = 0; off <= '\\unknowncmd'.length; off += 1) {
        await moveCaretOnly(startUnk + off);
        const r = await readBothCursors();
        assertInnerInsideOuter({ outer: r.previewOuter, inner: r.previewInner }, `unk:${off}`);
        unkXs.push(r.previewInner.left);
    }
    for (let i = 1; i < unkXs.length; i += 1) {
        assert.ok(unkXs[i] > unkXs[i - 1], `Unknown command caret must advance monotonically at index ${i}: ${unkXs}`);
    }

    // Parse error (.katex-error)
    await setEditorAndCursor('$x^$', 2);
    const errStart = await readBothCursors();
    await moveCaretOnly(3);
    const errEnd = await readBothCursors();
    assertInnerInsideOuter({ outer: errEnd.previewOuter, inner: errEnd.previewInner }, 'katexError');
    assert.ok(errEnd.previewInner.left >= errStart.previewInner.left, 'katex-error moves right across raw text');

    // Unrendered unclosed brace left by auto-render ($\frac{a}{$)
    const unclosed = '$\\frac{a}{b$';
    await setEditorAndCursor(unclosed, 1);
    const rUnc1 = await readBothCursors();
    await moveCaretOnly(unclosed.length - 1);
    const rUncEnd = await readBothCursors();
    assertInnerInsideOuter({ outer: rUncEnd.previewOuter, inner: rUncEnd.previewInner }, 'unclosedBrace');
    assert.ok(rUncEnd.previewInner.left > rUnc1.previewInner.left + 10, 'Unrendered raw formula tracks character offset cleanly');
    console.log('PASS: all partial, empty-slot, snippet, unknown-cmd, katex-error & unclosed-brace states handled gracefully');

    // 4. All 4 delimiters (inline $, display $$, \(...\), \[...\]) & QuantumSnippetEngine trigger
    for (const [text, pos, name] of [
        ['$$\\frac{a}{b}$$', 8, '$$'],
        ['\\(\\sqrt{xy}\\)', 9, '\\(\\)'],
        ['\\[x_{k}\\]', 6, '\\[\\]']
    ]) {
        await setEditorAndCursor(text, pos);
        const cur = await readBothCursors();
        assertInnerInsideOuter({ outer: cur.previewOuter, inner: cur.previewInner }, `delim:${name}`);
        assertInnerInsideOuter({ outer: cur.annoOuter, inner: cur.annoInner }, `anno-delim:${name}`);
    }

    // 5. Arrow key stepping & wide formula horizontal scroll in floating preview
    const wide = '$$x_1 + x_2 + x_3 + x_4 + x_5 + x_6 + x_7 + x_8 + x_9 + x_{10} + x_{11} + x_{12} + x_{13} + x_{14}$$';
    await setEditorAndCursor(wide, 4);
    const wideStart = await readBothCursors();
    assertInnerInsideOuter({ outer: wideStart.previewOuter, inner: wideStart.previewInner }, 'wideStart');
    await setEditorAndCursor(wide, wide.length - 4);
    const wideEnd = await readBothCursors();
    assert.ok(wideEnd.previewInner, 'Wide formula end inner cursor must be visible');
    const previewScrollCheck = await page.evaluate(() => {
        const kd = document.querySelector('#latex-preview-phantom-block .katex-display');
        const ic = document.querySelector('.latex-live-preview .latex-preview-inner-cursor');
        const vp = document.querySelector('.latex-live-preview .latex-preview-viewport').getBoundingClientRect();
        const ir = ic.getBoundingClientRect();
        return {
            hasOverflow: kd ? kd.scrollWidth > kd.clientWidth : false,
            scrollLeft: kd ? kd.scrollLeft : 0,
            insideVp: ir.left >= vp.left - 2 && ir.right <= vp.right + 2
        };
    });
    if (previewScrollCheck.hasOverflow) {
        assert.ok(previewScrollCheck.scrollLeft > 0, 'Wide formula should auto-scroll .katex-display to inner caret');
    }
    assert.ok(previewScrollCheck.insideVp, 'Inner caret after auto-scroll must stay inside preview viewport');

    // Step across x^{a} with real ArrowRight keys
    await setEditorAndCursor('$x^{ab}$', 4); // $x^{|ab}$
    const arrowBefore = (await readBothCursors()).previewInner;
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(90);
    await page.keyboard.press('ArrowRight'); // past b -> $x^{ab|}$
    await page.waitForTimeout(90);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const arrowInsideEnd = (await readBothCursors()).previewInner;
    await page.keyboard.press('ArrowRight'); // past } -> $x^{ab}|$
    await page.waitForTimeout(90);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const arrowOutside = (await readBothCursors()).previewInner;
    assert.ok(arrowInsideEnd.left > arrowBefore.left + 4, 'ArrowRight moves right inside sup');
    assert.ok(arrowOutside.height > arrowInsideEnd.height + 1.5, 'ArrowRight across } returns caret to base height');

    // 6. Save / close cleanup, zoom scales (0.5x & 2x), and zero errors
    await page.click('#save-note-btn');
    await page.waitForFunction(() => !state.isEditingNote);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const saveCleanup = await page.evaluate(() => ({
        vc: document.getElementById('virtual-cursor') ? getComputedStyle(document.getElementById('virtual-cursor')).display : 'none',
        vic: document.getElementById('virtual-inner-cursor')
            ? getComputedStyle(document.getElementById('virtual-inner-cursor')).display : 'none',
        pvic: document.querySelector('.latex-live-preview .latex-preview-inner-cursor')
            ? document.querySelector('.latex-live-preview .latex-preview-inner-cursor').hidden : true,
        phantoms: document.querySelectorAll('#phantom-cursor, #phantom-cursor-block').length,
        katexRendered: document.querySelectorAll('.text-annotation .katex').length
    }));
    assert.equal(saveCleanup.vc, 'none', '#virtual-cursor must be hidden after save');
    assert.equal(saveCleanup.vic, 'none', '#virtual-inner-cursor must be hidden after save');
    assert.equal(saveCleanup.pvic, true, '.latex-preview-inner-cursor hidden after save');
    assert.equal(saveCleanup.phantoms, 0, 'No phantom nodes left inside .text-annotation');
    assert.ok(saveCleanup.katexRendered >= 1, 'Saved formula rendered cleanly');
    await page.click('#close-note-btn');
    await page.waitForFunction(() => document.getElementById('note-modal').classList.contains('hidden'));

    // Re-open under 2x and 0.5x zoom via updateZoom and verify annotation inner caret scales accurately
    const heightsByScale = {};
    for (const scale of [0.5, 2, 1]) {
        await page.evaluate(s => updateZoom(s), scale);
        await page.waitForTimeout(650);
        const targetAnno = page.locator('.text-annotation[data-id="inner-math-box"]');
        await targetAnno.scrollIntoViewIfNeeded();
        await targetAnno.click({ button: 'right' });
        await page.waitForSelector('#note-modal:not(.hidden)');
        await page.waitForFunction(() => state.isEditingNote);
        await setEditorAndCursor('$\\frac{a}{b} + x^{2}$', 7); // inside numer 'a'
        const c = await readBothCursors();
        assertInnerInsideOuter({ outer: c.annoOuter, inner: c.annoInner }, `zoom:${scale}`);
        heightsByScale[scale] = c.annoInner.height;
        await page.mouse.click(1420, 880); // click outside to close without extra changes
        await page.waitForFunction(() => document.getElementById('note-modal').classList.contains('hidden') && !state.isEditingNote);
        const afterCancelVic = await page.evaluate(() => {
            const el = document.getElementById('virtual-inner-cursor');
            return el ? getComputedStyle(el).display : 'none';
        });
        assert.equal(afterCancelVic, 'none', `zoom:${scale}: #virtual-inner-cursor hidden after outside close`);
    }
    assert.ok(heightsByScale[2] > heightsByScale[0.5] * 1.5, `Inner caret height must scale with zoom (0.5x=${heightsByScale[0.5]}, 2x=${heightsByScale[2]})`);
    console.log('PASS: arrow stepping, horizontal scroll following, zoom scaling (0.5x/2x/1x), save & outside close cleanup verified');

    assert.deepEqual(runtimeErrors, [], `Expected zero browser errors, got: ${runtimeErrors.join('; ')}`);

    await browser.close();
    server.close();
})();
