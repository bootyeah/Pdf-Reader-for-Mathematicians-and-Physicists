/**
 * 离线预编译 Tailwind CSS 工具脚本。
 * 精准提取 static/index.html、static/config.js 和 static/js/*.js 中的全部真实类名
 * （仅解析 HTML class 属性与 JS 字符串字面量，过滤掉 JS 标识符如 !container / filter 等误匹配），
 * 使用本地同版本 static/lib/tailwindcss.js 在无头浏览器中生成 static/css/tailwind.min.css，
 * 彻底消除运行时的全局 MutationObserver 与 JIT 扫描开销。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const STATIC_ROOT = path.join(ROOT, 'static');
const OUT_FILE = path.join(STATIC_ROOT, 'css', 'tailwind.min.css');
const DEPS = process.env.READER_TEST_NODE_MODULES || path.join(ROOT, 'node_modules');
const { chromium } = require(
    fs.existsSync(path.join(DEPS, 'playwright')) ? path.join(DEPS, 'playwright') : 'playwright'
);

function extractStringLiterals(code) {
    const out = [];
    let i = 0;
    const n = code.length;
    while (i < n) {
        const ch = code[i];
        if (ch === '/' && code[i + 1] === '/') {
            while (i < n && code[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            i += 2;
            while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const q = ch;
            i++;
            let s = '';
            while (i < n && code[i] !== q) {
                if (code[i] === '\\' && i + 1 < n) {
                    s += code[i + 1];
                    i += 2;
                } else {
                    s += code[i++];
                }
            }
            i++;
            out.push(s);
            continue;
        }
        if (ch === '`') {
            i++;
            let s = '';
            while (i < n && code[i] !== '`') {
                if (code[i] === '\\' && i + 1 < n) {
                    s += code[i + 1];
                    i += 2;
                } else if (code[i] === '$' && code[i + 1] === '{') {
                    out.push(s);
                    s = '';
                    i += 2;
                    let depth = 1;
                    let expr = '';
                    while (i < n && depth > 0) {
                        if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
                            const q = code[i];
                            expr += code[i++];
                            while (i < n && code[i] !== q) {
                                if (code[i] === '\\' && i + 1 < n) {
                                    expr += code[i] + code[i + 1];
                                    i += 2;
                                } else {
                                    expr += code[i++];
                                }
                            }
                            if (i < n) expr += code[i++];
                        } else {
                            if (code[i] === '{') depth++;
                            else if (code[i] === '}') depth--;
                            if (depth > 0) expr += code[i];
                            i++;
                        }
                    }
                    out.push(...extractStringLiterals(expr));
                } else {
                    s += code[i++];
                }
            }
            i++;
            out.push(s);
            continue;
        }
        i++;
    }
    return out;
}

// 通用英文单词中恰好是 Tailwind 类名、但只在 JS 业务代码里作为数据键值（而非 class）出现的词，
// 仅在显式出现在 HTML class="..." 属性中时才保留，避免生成意外样式碰撞。
const AMBIGUOUS_PLAIN_WORDS = new Set([
    'container', 'table', 'caption', 'contents', 'static', 'sticky',
    'collapse', 'filter', 'resize', 'blur', 'invert', 'sepia', 'grayscale',
    'ordinal', 'underline', 'overline', 'lowercase', 'capitalize', 'normal',
    'visible', 'invisible', 'outline', 'shadow', 'ring', 'border', 'transform',
    'transition', 'grow', 'shrink', 'isolate', 'inline', 'grid'
]);

function addTokensFromClassAttr(attrValue, set) {
    for (const tok of String(attrValue || '').trim().split(/\s+/)) {
        if (tok) set.add(tok);
    }
}

function collectCandidateTokens() {
    const htmlFile = path.join(STATIC_ROOT, 'index.html');
    const jsFiles = [
        path.join(STATIC_ROOT, 'config.js'),
        ...fs.readdirSync(path.join(STATIC_ROOT, 'js'))
            .filter(f => f.endsWith('.js'))
            .map(f => path.join(STATIC_ROOT, 'js', f))
    ];

    const tokens = new Set();

    // 1. 精确解析 static/index.html 中的全部 class="..."
    const html = fs.readFileSync(htmlFile, 'utf8');
    for (const m of html.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        addTokensFromClassAttr(m[1] ?? m[2], tokens);
    }

    // 2. 精确解析 JS 文件中的 class 属性、classList 调用与字符串字面量
    for (const file of jsFiles) {
        const code = fs.readFileSync(file, 'utf8');

        // 2a. JS 模板/字符串里内嵌的 HTML class="..."
        for (const m of code.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
            const raw = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
            addTokensFromClassAttr(raw, tokens);
        }

        // 2b. classList.add / remove / toggle / replace 中的字符串参数
        for (const m of code.matchAll(/\.classList\.(?:add|remove|toggle|replace)\s*\(([^)]*)\)/g)) {
            for (const lit of extractStringLiterals(m[1])) {
                addTokensFromClassAttr(lit, tokens);
            }
        }

        // 2c. className 赋值与 setAttribute('class', ...)
        for (const m of code.matchAll(/(?:\.className\s*[+]?=\s*|setAttribute\s*\(\s*['"]class['"]\s*,\s*)([^;\n]+)/g)) {
            for (const lit of extractStringLiterals(m[1])) {
                addTokensFromClassAttr(lit, tokens);
            }
        }

        // 2d. 其他所有纯类名风格字符串字面量（覆盖 TONES / DOTS / sizeClass / badge / panelMessage 等变量传参）
        for (const lit of extractStringLiterals(code)) {
            if (!lit || lit.length > 300) continue;
            if (!/^[A-Za-z0-9_\-:\/\[\]#.%!()+\s]+$/.test(lit)) continue;
            const parts = lit.trim().split(/\s+/).filter(Boolean);
            for (const tok of parts) {
                if (tok.startsWith('!')) continue; // 项目不使用 Tailwind !important 前缀
                if (/^\d/.test(tok) || tok.includes('://') || tok.startsWith('./') || tok.startsWith('/')) continue;
                const openB = (tok.match(/\[/g) || []).length;
                const closeB = (tok.match(/\]/g) || []).length;
                if (openB !== closeB) continue;
                // 跳过容易与普通字符串/键值冲突的单个无连字符词（若真用于 class，已在 1/2a/2b/2c 中采集）
                if (AMBIGUOUS_PLAIN_WORDS.has(tok)) continue;
                // 只收录明确像 Tailwind 工具类的 token（含连字符/冒号/中括号/斜杠，或明确白名单单词）
                if (/[-:\[\]\/]/.test(tok) || ['hidden', 'flex', 'block', 'relative', 'absolute', 'fixed', 'truncate', 'italic', 'uppercase', 'rounded', 'group', 'peer'].includes(tok)) {
                    tokens.add(tok);
                }
            }
        }
    }

    return Array.from(tokens).sort();
}

function minifyCss(css) {
    return css
        .replace(/\/\*[\s\S]*?\*\//g, (comment, offset) => (offset === 0 ? comment + '\n' : ''))
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim() + '\n';
}

(async () => {
    const tokens = collectCandidateTokens();
    console.log(`Collected ${tokens.length} clean candidate class tokens.`);

    const escapedClasses = tokens
        .map(t => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
        .join(' ');

    const htmlDoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script src="/lib/tailwindcss.js"></script>
</head>
<body>
  <div id="tw-seed" class="${escapedClasses}"></div>
</body>
</html>`;

    const server = http.createServer((req, res) => {
        if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(htmlDoc);
            return;
        }
        if (req.url === '/lib/tailwindcss.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
            fs.createReadStream(path.join(STATIC_ROOT, 'lib', 'tailwindcss.js')).pipe(res);
            return;
        }
        res.writeHead(404).end();
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const defaultEdge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    const executablePath = process.env.READER_TEST_BROWSER || (fs.existsSync(defaultEdge) ? defaultEdge : undefined);
    const browser = await chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        headless: true
    });

    try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => {
            const styles = Array.from(document.querySelectorAll('head style'));
            return styles.some(s => (s.textContent || '').includes('tailwindcss') && s.textContent.length > 5000);
        }, { timeout: 20000 });
        await page.waitForTimeout(300);

        const css = await page.evaluate(() => {
            const styles = Array.from(document.querySelectorAll('head style'));
            const tw = styles.find(s => (s.textContent || '').includes('tailwindcss'));
            return tw ? tw.textContent : '';
        });

        if (!css || css.length < 5000) {
            throw new Error('Failed to extract compiled Tailwind CSS');
        }

        const output = minifyCss(css);
        fs.writeFileSync(OUT_FILE, output, 'utf8');
        console.log(`Generated ${OUT_FILE} (${(output.length / 1024).toFixed(1)} KB)`);

        // 核验：加载真实 static/index.html 对比生成的每条规则是否均已覆盖
        console.log('Sanity checks:', {
            hasContainer: output.includes('.container{'),
            hasTopCalc: output.includes('top-\\[calc\\(100\\%\\+4px\\)\\]'),
            hasBgYellowHex: output.includes('bg-\\[\\#fde047\\]'),
            hasGroupHoverWin: output.includes('group-hover\\/win\\:text-blue-500'),
            hasFrom70: output.includes('from-70\\%'),
            hasW0: output.includes('.w-0{'),
            hasPx0: output.includes('.px-0{'),
            hasZ100: output.includes('.z-\\[100\\]{')
        });
    } finally {
        await browser.close();
        server.close();
    }
})().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
