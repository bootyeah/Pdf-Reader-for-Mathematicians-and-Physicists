// 两个 TikZ 集成测试共用的临时后端：随机回环端口，stdin 关闭后自行退出。
// 复用真实 server.py 处理器，不占用阅读器的 8080，也不需要 taskkill。
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const script = `
import sys, threading
from http.server import ThreadingHTTPServer
from server import PDFReaderHandler
with ThreadingHTTPServer(('127.0.0.1', 0), PDFReaderHandler) as httpd:
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print('TEST_ORIGIN=http://127.0.0.1:%d' % httpd.server_port, flush=True)
    sys.stdin.read()
    httpd.shutdown()
`;

async function startBackend() {
    const child = spawn(process.env.READER_TEST_PYTHON || 'python', ['-u', '-c', script], {
        cwd: path.resolve(__dirname, '..'), windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    const log = [];
    const record = text => { log.push(String(text)); if (log.length > 60) log.shift(); };
    const closed = new Promise(resolve => child.once('close', resolve));
    child.stderr.on('data', record);
    child.stdin.on('error', () => {}); // 启动失败或子进程先退出时 stdin 可能已经关闭。
    const lines = createInterface({ input: child.stdout });
    let timeout;
    try {
        const origin = await new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('测试后端启动超时')), 30000);
            child.once('error', reject);
            child.once('exit', code => reject(new Error('测试后端提前退出：' + code + '\n' + log.join(''))));
            lines.on('line', line => {
                if (line.startsWith('TEST_ORIGIN=')) resolve(line.slice('TEST_ORIGIN='.length));
                else record(line + '\n');
            });
        });
        return {
            origin, log,
            async stop() {
                child.stdin.end();
                const timer = setTimeout(() => child.kill(), 5000);
                try { await closed; } finally { clearTimeout(timer); lines.close(); }
            }
        };
    } catch (error) {
        child.stdin.end();
        child.kill();
        await closed;
        lines.close();
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { startBackend };
