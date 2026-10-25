"""Edit only LATEX_CONFIG in config.js; preserve snippets and all other settings."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]
LOCK = threading.RLock()
LIST_FIELDS = ('packages', 'tikzLibraries', 'pgfplotsLibraries', 'environments')


class StorageError(ValueError):
    pass


def config_path():
    return Path(os.environ.get('PDF_READER_LATEX_CONFIG_JS') or ROOT / 'static/config.js')


def storage_dir():
    return Path(os.environ.get('PDF_READER_LATEX_STORAGE') or ROOT / '.latex-manager')


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', newline='', dir=path.parent, delete=False) as file:
            name = file.name
            file.write(text)
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


class LiteralParser:
    """Small JS literal reader; never execute config.js or its snippet functions."""
    def __init__(self, text, position):
        self.text, self.position = text, position

    def skip(self):
        match = re.compile(r'(?:\s+|//[^\n]*|/\*[\s\S]*?\*/)*').match(self.text, self.position)
        self.position = match.end()

    def take(self, char):
        self.skip()
        if self.text[self.position:self.position + 1] != char:
            return False
        self.position += 1
        return True

    def value(self):
        self.skip()
        char = self.text[self.position:self.position + 1]
        if char in ('"', "'"):
            match = re.compile(r'''"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*' ''', re.X).match(self.text, self.position)
            if not match:
                raise StorageError('配置字符串未正确闭合。')
            self.position = match.end()
            try:
                return json.loads(match[0]) if char == '"' else ast.literal_eval(match[0])
            except (ValueError, SyntaxError) as exc:
                raise StorageError('配置字符串转义不正确。') from exc
        if char in ('{', '['):
            self.position += 1
            is_object = char == '{'
            result = {} if is_object else []
            end = '}' if is_object else ']'
            while not self.take(end):
                if is_object:
                    self.skip()
                    key_match = re.compile(r'[A-Za-z_$][\w$]*').match(self.text, self.position)
                    if key_match:
                        key = key_match[0]
                        self.position = key_match.end()
                    else:
                        key = self.value()
                    if not isinstance(key, str) or key in result or not self.take(':'):
                        raise StorageError('配置中存在无效或重复的字段。')
                    result[key] = self.value()
                else:
                    result.append(self.value())
                if self.take(end):
                    return result
                if not self.take(','):
                    raise StorageError('LATEX_CONFIG 只支持对象、数组与普通字面量。')
            return result
        try:
            result, self.position = json.JSONDecoder().raw_decode(self.text, self.position)
            return result
        except ValueError as exc:
            raise StorageError('LATEX_CONFIG 包含无法读取的内容，请使用普通配置字面量。') from exc


def parse(text):
    match = re.search(r'\bconst\s+LATEX_CONFIG\s*=\s*', text)
    if not match:
        raise StorageError('未找到 const LATEX_CONFIG 配置。')
    parser = LiteralParser(text, match.end())
    config = parser.value()
    if not isinstance(config, dict):
        raise StorageError('LATEX_CONFIG 必须是配置对象。')
    return config, match.end(), parser.position


def validate(config):
    if not isinstance(config, dict):
        raise StorageError('缺少 LaTeX 配置对象。')
    result = {}
    for field in LIST_FIELDS:
        values = config.get(field)
        if not isinstance(values, list) or len(values) > 500:
            raise StorageError(f'{field} 必须是最多 500 项的列表。')
        cleaned = []
        for value in values:
            if not isinstance(value, str) or not value.strip() or len(value) > 4000 or '\n' in value or '\r' in value:
                raise StorageError(f'{field} 每项应为非空的单行文本。')
            value = value.strip()
            if field != 'packages' and not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.@*+-]*', value):
                raise StorageError(f'无效的库或环境名称：{value}')
            if value in cleaned:
                raise StorageError(f'配置存在重复项：{value}')
            cleaned.append(value)
        result[field] = cleaned
    return result


def snapshot():
    text = config_path().read_bytes().decode('utf-8')
    config, _, _ = parse(text)
    return {
        'config': config,
        'revision': hashlib.sha256(text.encode('utf-8')).hexdigest(),
        'config_path': str(config_path()),
        'has_backup': (storage_dir() / 'config.js.previous').is_file(),
    }


def save(config, revision):
    validated = validate(config)
    with LOCK:
        path = config_path()
        text = path.read_bytes().decode('utf-8')
        current, start, end = parse(text)
        if not revision or hashlib.sha256(text.encode('utf-8')).hexdigest() != revision:
            raise StorageError('配置已被其他操作修改，请重新加载后再保存。')
        current.update(validated)
        replacement = json.dumps(current, ensure_ascii=False, indent=4)
        atomic_write(storage_dir() / 'config.js.previous', text)
        atomic_write(path, text[:start] + replacement + text[end:])
        return snapshot()


def restore(revision):
    with LOCK:
        path = storage_dir() / 'config.js.previous'
        if not path.is_file():
            raise StorageError('没有可恢复的上一版配置。')
        config, _, _ = parse(path.read_bytes().decode('utf-8'))
        # 只恢复 LaTeX 配置；保存之后修改过的快捷键等内容仍保留。
        return save(config, revision)
