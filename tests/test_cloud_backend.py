"""云端批注库后端自检：拿一个「假 GitHub / 假 Gitee」验证真正发出去的请求。

不联网、不需要真账号、不碰用户的真实仓库，所以随时可以回归：

    python tests/test_cloud_backend.py

它盯的是「代码看着没问题、实际形状不对」的那类坑：
  · 文件名规则：按 PDF 名派生、非法字符净化、同名不同文档按指纹改名（绝不互相覆盖）
  · 新建走 PUT、覆盖必须带 sha（GitHub 少带 sha 会直接 422）
  · 超过 1MB 的批注自动改走 Git Data API（blob → tree → commit → 移动分支引用）
  · 令牌不对 / 仓库不存在时给出能照做的提示，而不是干巴巴一句 HTTP 401
  · Gitee 与 GitHub 的差异（新建用 POST、令牌放在 access_token 参数里）
"""

import json
import os
import shutil
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.dont_write_bytecode = True   # 自检不该在项目里留下 __pycache__
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402  （server.py 的启动逻辑在 __main__ 里，导入是安全的）

GOOD_TOKEN = 'good-token'
REQUESTS = []          # 记录收到过哪些请求，供断言使用


class FakeRepo:
    """最小可用的仓库：文件（path → {content, sha}）、blob、tree、commit、分支引用。"""

    def __init__(self):
        self.files = {}
        self.blobs = {}
        self.trees = {}
        self.commits = {}
        self.refs = {}
        self.seq = 0

    def sha(self, prefix='sha'):
        self.seq += 1
        return f'{prefix}-{self.seq:04d}'


class FakeAPI(BaseHTTPRequestHandler):
    repo = FakeRepo()
    provider = 'github'
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    # ---------- 工具 ----------
    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self, query):
        if self.provider == 'gitee':
            return query.get('access_token', [''])[0] == GOOD_TOKEN
        header = self.headers.get('Authorization', '')
        return header == 'Bearer ' + GOOD_TOKEN

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception:
            return {}

    def _record(self, method, path, extra=None):
        REQUESTS.append({'method': method, 'path': path, **(extra or {})})

    # ---------- 路由 ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        path = parsed.path
        self._record('GET', path)
        if not self._authorized(query):
            self._json(401, {'message': 'Bad credentials'})
            return
        repo = self.repo

        if path == '/repos/owner/repo':
            self._json(200, {'full_name': 'owner/repo', 'private': True, 'default_branch': 'main'})
            return
        if '/contents' in path:
            key = path.split('/contents', 1)[1].lstrip('/')
            key = urllib.parse.unquote(key)
            if not key:
                # ⚠️ 真实 GitHub 的目录接口只给 name/path/sha/size，**不返回 content**
                #    （这里刻意照抄这个「抠门」行为：早期版本正是因为假接口多给了内容，
                #      才让「目录里读不到指纹 → 打开文档的云端提示永远不出现」这种 bug 溜过去）
                files = [{'type': 'file', 'name': p.split('/')[-1], 'path': p, 'sha': v['sha'],
                          'size': len(v['content'])}
                         for p, v in sorted(repo.files.items()) if '/' not in p]
                self._json(200, files)
                return
            if key in repo.files:
                entry = repo.files[key]
                self._json(200, {
                    'type': 'file', 'name': key.split('/')[-1], 'path': key, 'sha': entry['sha'],
                    'size': len(entry['content']), 'encoding': 'base64', 'content': _b64(entry['content']),
                })
                return
            children = sorted({p for p in repo.files if p.startswith(key + '/')})
            if children:
                dirs = sorted({p[len(key) + 1:].split('/')[0] for p in children})
                listing = []
                for name in dirs:
                    child = key + '/' + name
                    if child in repo.files:
                        # 同上：目录条目不给 content
                        listing.append({'type': 'file', 'name': name, 'path': child,
                                        'sha': repo.files[child]['sha'],
                                        'size': len(repo.files[child]['content'])})
                    else:
                        listing.append({'type': 'dir', 'name': name, 'path': child})
                self._json(200, listing)
                return
            self._json(404, {'message': 'Not Found'})
            return
        if '/git/blobs/' in path:
            sha = path.rsplit('/', 1)[-1]
            if sha in repo.blobs:
                self._json(200, {'sha': sha, 'content': _b64(repo.blobs[sha]), 'encoding': 'base64'})
            else:
                self._json(404, {'message': 'Not Found'})
            return
        if '/git/commits/' in path:
            sha = path.rsplit('/', 1)[-1]
            if sha in repo.commits:
                self._json(200, repo.commits[sha])
            else:
                self._json(404, {'message': 'Not Found'})
            return
        if '/git/ref/heads/' in path:
            branch = urllib.parse.unquote(path.rsplit('/', 1)[-1])
            if branch in repo.refs:
                self._json(200, {'ref': 'refs/heads/' + branch, 'object': {'sha': repo.refs[branch]}})
            else:
                self._json(404, {'message': 'Not Found'})
            return
        self._json(404, {'message': 'Not Found'})

    def do_PUT(self):
        self._write('PUT')

    def do_POST(self):
        self._write('POST')

    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        path = parsed.path
        self._record('PATCH', path)
        if not self._authorized(query):
            self._json(401, {'message': 'Bad credentials'})
            return
        if '/git/refs/heads/' in path:
            body = self._body()
            branch = urllib.parse.unquote(path.split('/git/refs/heads/', 1)[1])
            self.repo.refs[branch] = body.get('sha')
            self._json(200, {'ref': 'refs/heads/' + branch, 'object': {'sha': body.get('sha')}})
            return
        self._json(404, {'message': 'Not Found'})

    def _write(self, method):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        path = parsed.path
        body = self._body()
        self._record(method, path, {'body': body, 'query': {k: v[0] for k, v in query.items()}})
        if not self._authorized(query):
            self._json(401, {'message': 'Bad credentials'})
            return
        repo = self.repo

        if path == '/repos/owner/repo/git/blobs':
            sha = repo.sha('blob')
            repo.blobs[sha] = _unb64(body.get('content') or '')
            self._json(201, {'sha': sha})
            return
        if path == '/repos/owner/repo/git/trees':
            tree_sha = repo.sha('tree')
            repo.trees[tree_sha] = body.get('tree') or []
            self._json(201, {'sha': tree_sha, 'tree': body.get('tree') or []})
            return
        if path == '/repos/owner/repo/git/commits':
            commit_sha = repo.sha('commit')
            repo.commits[commit_sha] = {'sha': commit_sha, 'tree': {'sha': body.get('tree')},
                                        'parents': [{'sha': p} for p in body.get('parents') or []]}
            # 把 tree 真正落到文件上，模拟一次提交
            for entry in repo.trees.get(body.get('tree'), []):
                repo.files[entry['path']] = {'content': repo.blobs.get(entry['sha'], b''), 'sha': repo.sha('file')}
            self._json(201, repo.commits[commit_sha])
            return
        if path == '/repos/owner/repo/git/refs':
            branch = (body.get('ref') or 'refs/heads/main').split('/')[-1]
            repo.refs[branch] = body.get('sha')
            self._json(201, {'ref': body.get('ref'), 'object': {'sha': body.get('sha')}})
            return
        if '/contents' in path:
            key = urllib.parse.unquote(path.split('/contents', 1)[1].lstrip('/'))
            if body.get('branch') != 'main':
                self._json(422, {'message': 'Branch not found'})
                return
            existing = repo.files.get(key)
            if method == 'POST' and existing:
                self._json(400, {'message': '文件已存在'})
                return
            if method == 'PUT' and existing and not body.get('sha'):
                self._json(422, {'message': "Invalid request.\n\n'sha' wasn't supplied."})
                return
            if body.get('sha') and existing and body['sha'] != existing['sha']:
                self._json(409, {'message': 'sha does not match'})
                return
            content = _unb64(body.get('content') or '')
            repo.files[key] = {'content': content, 'sha': repo.sha('file')}
            self._json(200 if existing else 201, {
                'content': {'path': key, 'sha': repo.files[key]['sha']},
                'commit': {'sha': repo.sha('commit')},
            })
            return
        self._json(404, {'message': 'Not Found'})


def _b64(data):
    import base64
    return base64.b64encode(data if isinstance(data, bytes) else data.encode('utf-8')).decode('ascii')


def _unb64(text):
    import base64
    return base64.b64decode(text)


# ---------- 断言小工具 ----------
RESULTS = []


def check(label, condition, detail=''):
    RESULTS.append((label, bool(condition), detail))
    mark = 'PASS' if condition else 'FAIL'
    print(f'  [{mark}] {label}' + (f'   ← {detail}' if detail and not condition else ''))
    return bool(condition)


def make_config(tmpdir, base_url, provider='github', mirror=False):
    """写一份临时 cloud_config.json，并让 server.py 从它读配置（顺带验证覆盖读取这条路径）。"""
    path = os.path.join(tmpdir, 'cloud_config.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({
            'enabled': True, 'provider': provider, 'owner': 'owner', 'repo': 'repo',
            'token': GOOD_TOKEN, 'branch': 'main', 'dir': 'annotations',
            'mirror_paths': mirror, 'device': 'TEST-PC', 'proxy': '', 'api_base': base_url,
        }, f, ensure_ascii=False)
    os.environ['PDF_READER_CLOUD_CONFIG'] = path
    return server._cloud_config()


def annotations_of(*texts):
    return {'1': [{'id': f'a{i}', 'type': 'highlight', 'note': t} for i, t in enumerate(texts)],
            'settings': {'lastPage': 3}}


def main():
    FakeAPI.repo = FakeRepo()
    FakeAPI.provider = 'github'
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), FakeAPI)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d' % httpd.server_port

    tmpdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.tmp-cloud-test')
    shutil.rmtree(tmpdir, ignore_errors=True)
    os.makedirs(tmpdir, exist_ok=True)
    try:
        cfg = make_config(tmpdir, base)
        print('\n== 1. 文件名规则 ==')
        check('按 PDF 名派生文件名', server._cloud_base_filename('物理 必修一.pdf') == '物理 必修一_annotations.json',
              server._cloud_base_filename('物理 必修一.pdf'))
        messy = server._cloud_base_filename('a/b:c*d?e"f<g>h|i.pdf')
        check('非法字符被净化', not any(ch in messy for ch in '\\/:*?"<>|'), messy)
        check('Windows 保留名被改写', server._cloud_base_filename('CON.pdf').startswith('_CON'),
              server._cloud_base_filename('CON.pdf'))
        check('默认扁平归档', server._cloud_key(cfg, 'x.pdf', r'D:\教材\物理\x.pdf') == 'annotations/x_annotations.json',
              server._cloud_key(cfg, 'x.pdf', r'D:\教材\物理\x.pdf'))
        mirrored = make_config(tmpdir, base, mirror=True)
        check('镜像归档带上一级文件夹',
              server._cloud_key(mirrored, 'x.pdf', r'D:\教材\物理\x.pdf') == 'annotations/物理/x_annotations.json',
              server._cloud_key(mirrored, 'x.pdf', r'D:\教材\物理\x.pdf'))
        cfg = make_config(tmpdir, base)

        print('\n== 2. 连通性自检 ==')
        info = server._cloud_test(cfg)
        check('读到仓库信息', info['repo'] == 'owner/repo' and info['branch'] == 'main', json.dumps(info))
        check('识别为私有仓库', info['private'] is True)
        check('空仓库时文件数为 0', info['count'] == 0, str(info['count']))

        print('\n== 3. 首次保存：新建 ==')
        annos = annotations_of('第一条批注', '第二条批注')
        result = server._cloud_save(cfg, '物理 必修一.pdf', 'fp-aaa', r'D:\教材\物理 必修一.pdf', annos)
        check('返回云端路径', result['key'] == 'annotations/物理 必修一_annotations.json', result['key'])
        check('没有改名', result['renamed'] is False)
        check('批注条数正确', result['count'] == 2, str(result['count']))
        stored = json.loads(FakeAPI.repo.files[result['key']]['content'].decode('utf-8'))
        check('写入的是标准导出格式', stored['app'] == 'PDFReaderPro' and 'annotations' in stored)
        check('带上指纹', stored['fingerprint'] == 'fp-aaa', stored.get('fingerprint'))
        check('带上设备名', stored['device'] == 'TEST-PC', stored.get('device'))
        check('带上本地来源路径', stored['sourcePath'].endswith('物理 必修一.pdf'), stored.get('sourcePath'))
        check('时间戳是 ISO-Z 格式', str(stored['timestamp']).endswith('Z'), str(stored['timestamp']))
        check('第一次是新建（不带 sha）',
              REQUESTS[-1]['method'] == 'PUT' and not REQUESTS[-1]['body'].get('sha'),
              json.dumps(REQUESTS[-1]['body'], ensure_ascii=False)[:120])

        print('\n== 4. 再次保存：覆盖更新 ==')
        REQUESTS.clear()
        second = server._cloud_save(cfg, '物理 必修一.pdf', 'fp-aaa', r'D:\教材\物理 必修一.pdf',
                                    annotations_of('第一条批注', '第二条批注', '第三条批注'))
        put = [r for r in REQUESTS if r['method'] == 'PUT']
        check('覆盖时带上了 sha', bool(put) and bool(put[-1]['body'].get('sha')), json.dumps(put[-1:] , ensure_ascii=False)[:200])
        stored = json.loads(FakeAPI.repo.files[second['key']]['content'].decode('utf-8'))
        check('内容是覆盖而不是追加', second['count'] == 3 and len(stored['annotations']['1']) == 3)
        check('云端只有一个文件', len(FakeAPI.repo.files) == 1, str(list(FakeAPI.repo.files)))

        print('\n== 5. 同名但不同文档：自动按指纹改名 ==')
        other = server._cloud_save(cfg, '物理 必修一.pdf', 'fp-bbb', r'D:\备份\物理 必修一.pdf',
                                   annotations_of('另一份文档的批注'))
        check('自动改名并保留了原文件', other['renamed'] is True and other['key'].endswith('__fp-bbb_annotations.json'),
              other['key'])
        check('两份文件同时存在', len(FakeAPI.repo.files) == 2, str(sorted(FakeAPI.repo.files)))
        first_doc = json.loads(FakeAPI.repo.files[second['key']]['content'].decode('utf-8'))
        check('原先那份没被动过', len(first_doc['annotations']['1']) == 3)

        print('\n== 6. 状态查询（打开文档时的提示来源）==')
        status = server._cloud_status(cfg, '物理 必修一.pdf', 'fp-aaa', r'D:\教材\物理 必修一.pdf')
        check('找得到云端那份', status['exists'] is True and status['matchesFingerprint'] is True, json.dumps(status, ensure_ascii=False)[:160])
        check('带回元信息', status['remote']['count'] == 3 and status['remote']['device'] == 'TEST-PC',
              json.dumps(status['remote'], ensure_ascii=False)[:200])
        check('目录接口不给内容时也能补全时间',
              bool(status['remote']['timestamp']) and status['remote']['readable'] is True,
              json.dumps(status['remote'], ensure_ascii=False)[:200])
        miss = server._cloud_status(cfg, '从没存过的书.pdf', 'fp-zzz', r'D:\教材\从没存过的书.pdf')
        check('没存过的书 = 不存在', miss['exists'] is False and miss['matchesFingerprint'] is False)
        renamed_hit = server._cloud_status(cfg, '物理 必修一.pdf', 'fp-bbb', r'D:\备份\物理 必修一.pdf')
        check('按指纹认领改名后的文件', renamed_hit['exists'] is True and renamed_hit['matchesFingerprint'] is True,
              json.dumps(renamed_hit, ensure_ascii=False)[:200])

        print('\n== 7. 云库清单与状态接口（走真实 HTTP 路由）==')
        # 这一步刻意起一次真实的 PDFReaderHandler：目录接口不返回内容时，补元信息这件事
        # 是在 HTTP 层做的（面板要的时间/设备/条数），只测函数会漏掉它。
        api_server = ThreadingHTTPServer(('127.0.0.1', 0), server.PDFReaderHandler)
        threading.Thread(target=api_server.serve_forever, daemon=True).start()
        try:
            origin = 'http://127.0.0.1:%d' % api_server.server_port
            with urllib.request.urlopen(origin + '/api/cloud-anno/list?refresh=1', timeout=30) as response:
                payload = json.loads(response.read().decode('utf-8'))
            files = payload.get('files') or []
            check('列出两份批注', len(files) == 2, str([f['key'] for f in files]))
            check('清单只给文件名与体积（不再一口气拉全部详情）',
                  all(not f['readable'] and f['size'] for f in files),
                  json.dumps(files, ensure_ascii=False)[:200])
            check('顺序确定：按名字排序', [f['name'] for f in files] == sorted(f['name'] for f in files),
                  str([f['name'] for f in files]))
            keys_query = '&'.join('keys=' + urllib.parse.quote(f['key']) for f in files)
            with urllib.request.urlopen(origin + '/api/cloud-anno/meta?' + keys_query, timeout=30) as response:
                meta = json.loads(response.read().decode('utf-8'))
            entries = meta.get('entries') or []
            check('按需补详情：这两条现在有设备/条数/时间了',
                  len(entries) == 2 and all(e['readable'] and e['device'] == 'TEST-PC' and e['count'] and e['timestamp'] for e in entries),
                  json.dumps(entries, ensure_ascii=False)[:240])
            with urllib.request.urlopen(origin + '/api/cloud-anno/list', timeout=30) as response:
                cached = json.loads(response.read().decode('utf-8'))
            check('补过的详情留在清单缓存里（不重复取）',
                  all(f['readable'] for f in cached['files']), json.dumps(cached['files'], ensure_ascii=False)[:200])
            query = urllib.parse.urlencode({'name': '物理 必修一.pdf', 'fingerprint': 'fp-aaa', 'path': r'D:\教材\物理 必修一.pdf'})
            with urllib.request.urlopen(origin + '/api/cloud-anno/status?' + query, timeout=30) as response:
                status_payload = json.loads(response.read().decode('utf-8'))
            check('状态接口报「同一份文档」',
                  status_payload.get('ok') and status_payload.get('exists') and status_payload.get('matchesFingerprint') is True,
                  json.dumps(status_payload, ensure_ascii=False)[:200])
            check('状态接口带回条数（前端提示里的「N 条」）', status_payload['remote']['count'] == 3,
                  json.dumps(status_payload.get('remote'), ensure_ascii=False)[:200])
            with urllib.request.urlopen(origin + '/api/cloud-anno/get?key=' + urllib.parse.quote(files[0]['key']), timeout=30) as response:
                got = json.loads(response.read().decode('utf-8'))
            check('取回接口给出完整批注文档', got.get('ok') and got['document']['app'] == 'PDFReaderPro')
            # action=test 是配好之后「一句话验证配置」用的，也在这里走一遍
            test_request = urllib.request.Request(
                origin + '/api/cloud-anno',
                data=json.dumps({'action': 'test'}).encode('utf-8'),
                headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(test_request, timeout=30) as response:
                tested = json.loads(response.read().decode('utf-8'))
            check('连通性自检接口可用（含分支与仓库信息）',
                  tested.get('ok') and tested.get('repo') == 'owner/repo' and tested.get('branch') == 'main',
                  json.dumps(tested, ensure_ascii=False)[:200])
            bad = urllib.request.Request(origin + '/api/cloud-anno/meta?keys=' + urllib.parse.quote('../../etc/passwd'),
                                         method='GET')
            try:
                with urllib.request.urlopen(bad, timeout=30) as response:
                    rejected = json.loads(response.read().decode('utf-8'))
            except urllib.error.HTTPError as error:
                rejected = json.loads(error.read().decode('utf-8'))
            check('非法 key 被拒（只允许 .json、不许 ..）', rejected.get('ok') is False, json.dumps(rejected, ensure_ascii=False)[:160])
        finally:
            api_server.shutdown()

        print('\n== 8. 超过 1MB 的批注改走 Git Data API ==')
        REQUESTS.clear()
        huge = b'{"app":"PDFReaderPro","annotations":{}}' + b' ' * (1024 * 1024)
        server._cloud_put_file(cfg, 'annotations/huge_annotations.json', huge, '大文件')
        methods = [(r['method'], r['path'].rsplit('/', 1)[-1]) for r in REQUESTS]
        check('走了 blob → tree → commit → 移动引用',
              any(p.endswith('blobs') for _, p in methods) and any(p.endswith('trees') for _, p in methods)
              and any(p.endswith('commits') for _, p in methods) and any('refs' in p or 'ref' in p for _, p in methods),
              str(methods))
        check('大文件真的落库', FakeAPI.repo.files.get('annotations/huge_annotations.json', {}).get('content') == huge)
        check('分支引用被推进', bool(FakeAPI.repo.refs.get('main')), str(FakeAPI.repo.refs))

        print('\n== 9. 出错时说人话 ==')
        bad = make_config(tmpdir, base)
        bad['token'] = 'wrong-token'
        try:
            server._cloud_save(bad, 'x.pdf', 'fp', '', annotations_of('x'))
            check('错误令牌应当报错', False, '没有抛出异常')
        except RuntimeError as error:
            check('错误令牌给出可照做的提示', '令牌无效' in str(error), str(error))
        bad2 = make_config(tmpdir, base)
        bad2['repo'] = 'no-such-repo'
        try:
            server._cloud_test(bad2)
            check('仓库不存在应当报错', False, '没有抛出异常')
        except RuntimeError as error:
            check('仓库不存在给出可照做的提示', '仓库不存在' in str(error), str(error))

        print('\n== 10. Gitee 差异（新建 POST、令牌走参数）==')
        FakeAPI.repo = FakeRepo()
        FakeAPI.provider = 'gitee'
        REQUESTS.clear()
        cfg_gitee = make_config(tmpdir, base, provider='gitee')
        info = server._cloud_test(cfg_gitee)
        check('Gitee 也能自检', info['provider'] == 'gitee' and info['count'] == 0, json.dumps(info, ensure_ascii=False))
        REQUESTS.clear()
        saved = server._cloud_save(cfg_gitee, '力学.pdf', 'fp-g1', r'D:\教材\力学.pdf', annotations_of('gitee 批注'))
        create = [r for r in REQUESTS if '/contents' in r['path'] and r['method'] in ('POST', 'PUT')]
        check('新建用 POST', bool(create) and create[0]['method'] == 'POST', str([r['method'] for r in create]))
        check('Gitee 令牌走 access_token 参数', bool(create) and create[0]['query'].get('access_token') == GOOD_TOKEN,
              json.dumps(create[0]['query'] if create else {}, ensure_ascii=False))
        REQUESTS.clear()
        server._cloud_save(cfg_gitee, '力学.pdf', 'fp-g1', r'D:\教材\力学.pdf', annotations_of('gitee 批注2'))
        update = [r for r in REQUESTS if '/contents' in r['path'] and r['method'] in ('POST', 'PUT')]
        check('更新用 PUT 且带 sha', bool(update) and update[0]['method'] == 'PUT' and bool(update[0]['body'].get('sha')),
              str([(r['method'], bool(r['body'].get('sha'))) for r in update]))
        check('Gitee 数据落库', saved['key'] in FakeAPI.repo.files, str(sorted(FakeAPI.repo.files)))

        print('\n== 11. 星形平面字符（代理对）不能毁掉整次上传 ==')
        # 真实来源：js/annotate.js 的 selection.substring(0, 30) 会把 𝑢(U+1D462) 劈成两半，
        # 浏览器 JSON.stringify 把落单的高代理项转义成 \ud835 原样送上来；Python 这边 str
        # 收得下、却永远 encode 不成 UTF-8 —— 于是整本书的批注全卡在「已排队」。
        # （实测《Partial differential equations in action》文本层 6.12% 是这类字符）
        FakeAPI.repo = FakeRepo()
        FakeAPI.provider = 'github'
        cfg = make_config(tmpdir, base)
        half = json.loads('"half \\ud835"')                     # 服务端拿到手的就是这半个字符
        math_note = '\U0001d462 \U0001d715 \U0001f642 原样保留'   # 完整数学符号 + emoji
        annos = {'1': [{'id': 'a1', 'type': 'highlight', 'text': half, 'note': math_note}]}
        result = server._cloud_save(cfg, 'PDE in action.pdf', 'fp-salsa', r'D:\教材\PDE in action.pdf', annos)
        stored = json.loads(FakeAPI.repo.files[result['key']]['content'].decode('utf-8'))
        item = stored['annotations']['1'][0]
        check('落单代理项不再让上传失败', result['count'] == 1, json.dumps(result, ensure_ascii=False))
        check('半个字符被换成 U+FFFD 后照常入库', item['text'].endswith('\ufffd'), repr(item['text']))
        check('完整数学符号与 emoji 原样保留', item['note'] == math_note, repr(item['note']))
        check('成对的代理项还原成真正的字符',
              server._repair_surrogates('a\ud835\udc62b') == ('a\U0001d462b', 0),
              repr(server._repair_surrogates('a\ud835\udc62b')))
        check('普通文本不被动过',
              server._repair_surrogates('物理 必修一 emoji 🙂') == ('物理 必修一 emoji 🙂', 0))

        print('\n== 12. 「配好了但连不上」不能混同于「没配置」==')
        # 代理没开时 GitHub 连不上。这时云端入口必须留着（点一下就能重试），
        # 而不是像「没配置」那样彻底隐形——否则只能刷新页面重开 PDF 才能等到代理生效。
        api_server = ThreadingHTTPServer(('127.0.0.1', 0), server.PDFReaderHandler)
        threading.Thread(target=api_server.serve_forever, daemon=True).start()
        try:
            origin = 'http://127.0.0.1:%d' % api_server.server_port
            make_config(tmpdir, 'http://127.0.0.1:1')      # 没人监听的端口 = 连不上云端
            with urllib.request.urlopen(origin + '/api/cloud-anno/status', timeout=60) as response:
                down = json.loads(response.read().decode('utf-8'))
            check('连不上时仍如实回报「已配置」', down.get('configured') is True,
                  json.dumps(down, ensure_ascii=False)[:200])
            check('连不上用 ok:false + reachable:false 单独表达',
                  down.get('ok') is False and down.get('reachable') is False,
                  json.dumps(down, ensure_ascii=False)[:200])
            check('连不上时给一句能照做的人话', '连不上云端' in str(down.get('error')),
                  str(down.get('error'))[:160])
            with urllib.request.urlopen(origin + '/api/cloud-anno/status?local=1', timeout=60) as response:
                local = json.loads(response.read().decode('utf-8'))
            check('?local=1 只读配置、不碰网络（离线也秒回，入口据此立刻出现）',
                  local.get('ok') is True and local.get('configured') is True,
                  json.dumps(local, ensure_ascii=False)[:200])
            config_path = os.path.join(tmpdir, 'cloud_config.json')
            with open(config_path, 'r', encoding='utf-8') as f:
                stored = json.load(f)
            stored['enabled'] = False
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(stored, f, ensure_ascii=False)
            with urllib.request.urlopen(origin + '/api/cloud-anno/status?local=1', timeout=30) as response:
                disabled = json.loads(response.read().decode('utf-8'))
            check('没启用时才是真的「没配置」（前端据此彻底隐形）',
                  disabled.get('configured') is False and bool(disabled.get('message')),
                  json.dumps(disabled, ensure_ascii=False)[:200])
        finally:
            api_server.shutdown()
    finally:
        httpd.shutdown()
        os.environ.pop('PDF_READER_CLOUD_CONFIG', None)
        shutil.rmtree(tmpdir, ignore_errors=True)

    failed = [label for label, ok, _ in RESULTS if not ok]
    print('\n' + '=' * 60)
    print(f'云端批注库后端自检：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过')
    if failed:
        print('未通过：\n  - ' + '\n  - '.join(failed))
        return 1
    print('全部通过 ✅')
    return 0


if __name__ == '__main__':
    sys.exit(main())
