"""Storage and synchronization layer for LaTeX snippets.

Responsible for reading, validating, atomic writing, backing up,
and synchronizing snippets with both .snippet-manager/snippets.json
and static/config.js.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid

ROOT = Path(__file__).resolve().parents[2]
_LOCK = threading.RLock()

CONFIG_JS_PATH = ROOT / "static" / "config.js"
DEFAULT_STORAGE_DIR = ROOT / ".snippet-manager"
DEFAULT_JSON_PATH = DEFAULT_STORAGE_DIR / "snippets.json"

CATEGORY_NAMES = {
    "all": "全部快捷键",
    "math_symbol": "数学符号",
    "greek": "希腊字母",
    "env": "环境与矩阵",
    "sub_sup": "上下标与修饰",
    "calculus": "微积分与求和",
    "logic_relation": "逻辑与关系符",
    "text_style": "文本与排版",
    "sets_symbols": "数集与特殊字体",
    "regex": "高级正则模式",
    "custom": "自定义规则",
    "general": "通用规则"
}

class StorageError(ValueError):
    """Configuration or storage validation error."""
    pass

def config_js_path() -> Path:
    custom = os.environ.get("PDF_READER_SNIPPET_CONFIG_JS")
    return Path(custom) if custom else CONFIG_JS_PATH

def storage_dir() -> Path:
    d = Path(os.environ.get("PDF_READER_SNIPPET_STORAGE") or DEFAULT_STORAGE_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d

def json_config_path() -> Path:
    return storage_dir() / "snippets.json"

def _atomic_write(path: Path, text_content: str):
    """Write text atomically using a temp file in the same directory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=str(path.parent), delete=False, encoding="utf-8") as tf:
        tf.write(text_content)
        tmp_name = tf.name
    os.replace(tmp_name, str(path))

def _prev_non_space(text: str, index: int) -> str:
    j = index - 1
    while j >= 0 and text[j] in (' ', '\t', '\r', '\n'):
        j -= 1
    return text[j] if j >= 0 else ''

def find_array_bounds(text: str, prefix: str = "const LATEX_SNIPPETS = ["):
    idx = text.find(prefix)
    if idx == -1:
        raise StorageError(f"在 static/config.js 中未找到前缀 '{prefix}'")
    start_bracket = idx + len(prefix) - 1
    depth = 0
    in_quote = None
    in_regex = False
    in_regex_charset = False
    escape = False
    end_bracket = -1

    i = start_bracket
    n = len(text)
    while i < n:
        ch = text[i]
        if escape:
            escape = False
            i += 1
            continue
        if in_quote:
            if ch == '\\':
                escape = True
            elif ch == in_quote:
                in_quote = None
            i += 1
            continue
        if in_regex:
            if ch == '\\':
                escape = True
            elif ch == '[' and not in_regex_charset:
                in_regex_charset = True
            elif ch == ']' and in_regex_charset:
                in_regex_charset = False
            elif ch == '/' and not in_regex_charset:
                in_regex = False
            i += 1
            continue
        if ch == '/' and i + 1 < n:
            if text[i + 1] == '/':
                nl = text.find('\n', i + 2)
                i = n if nl == -1 else nl + 1
                continue
            if text[i + 1] == '*':
                end_c = text.find('*/', i + 2)
                i = n if end_c == -1 else end_c + 2
                continue
        if ch in ('"', "'", '`'):
            in_quote = ch
            i += 1
            continue
        if ch == '/' and _prev_non_space(text, i) in (':', ',', '[', '(', '=', '!'):
            in_regex = True
            in_regex_charset = False
            i += 1
            continue
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                end_bracket = i
                break
        i += 1

    if end_bracket == -1:
        raise StorageError("在 static/config.js 中未找到 LATEX_SNIPPETS 数组的结束方括号 ']'")
    return start_bracket, end_bracket

def extract_raw_snippet_blocks(body: str) -> list[str]:
    items = []
    d = 0
    q = None
    in_regex = False
    in_regex_charset = False
    esc = False
    cur_start = -1

    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if esc:
            esc = False
            i += 1
            continue
        if q:
            if ch == '\\':
                esc = True
            elif ch == q:
                q = None
            i += 1
            continue
        if in_regex:
            if ch == '\\':
                esc = True
            elif ch == '[' and not in_regex_charset:
                in_regex_charset = True
            elif ch == ']' and in_regex_charset:
                in_regex_charset = False
            elif ch == '/' and not in_regex_charset:
                in_regex = False
            i += 1
            continue
        if ch == '/' and i + 1 < n:
            if body[i + 1] == '/':
                nl = body.find('\n', i + 2)
                i = n if nl == -1 else nl + 1
                continue
            if body[i + 1] == '*':
                end_c = body.find('*/', i + 2)
                i = n if end_c == -1 else end_c + 2
                continue
        if ch in ('"', "'", '`'):
            q = ch
            i += 1
            continue
        if ch == '/' and _prev_non_space(body, i) in (':', ',', '[', '(', '=', '!'):
            in_regex = True
            in_regex_charset = False
            i += 1
            continue
        if ch == '{':
            if d == 0:
                cur_start = i
            d += 1
        elif ch == '}':
            d -= 1
            if d == 0 and cur_start != -1:
                items.append(body[cur_start:i+1].strip())
                cur_start = -1
        i += 1
    return items

def categorize_snippet(trigger: str, replacement: str, options: str) -> str:
    if "r" in options:
        return "regex"
    if "\\begin" in replacement or any(k in trigger for k in ("matrix", "cases", "align", "array", "pmat", "bmat", "vmat")):
        return "env"
    if any(k in trigger for k in ("@a", "@b", "@g", "@d", "@e", "@z", "@t", "@i", "@k", "@l", "@s", "@o", "ome", ":e", ":t", "@G", "@D", "@T", "@L", "@S", "@U", "@O", "Ome")):
        return "greek"
    if any(k in replacement for k in ("\\alpha", "\\beta", "\\gamma", "\\delta", "\\epsilon", "\\varepsilon", "\\zeta", "\\theta", "\\vartheta", "\\lambda", "\\omega", "\\sigma")):
        return "greek"
    if any(k in trigger for k in ("sr", "cb", "rd", "_", "sts", "hat", "bar", "dot", "ddot", "vec", "tilde", "und", "dag", "conj", "^-")):
        return "sub_sup"
    if any(k in trigger for k in ("fr", "sq", "lim", "sum", "prod", "int", "dint", "oint", "iint", "iiint", "par", "ddt", "dd")):
        return "calculus"
    if any(k in trigger for k in ("+=", "-+", "+-", "!=", ">=", "<=", ">>", "<<", "->", "=>", "=<", "<->", "<-->", "!>", "and", "orr", "inn", "ni", "sub=", "sup=")):
        return "logic_relation"
    if any(k in trigger for k in ("text", "red", "mathc", "box", "bf", "rm")):
        return "text_style"
    if any(k in replacement for k in ("\\mathbb", "\\mathcal")):
        return "sets_symbols"
    if "m" in options:
        return "math_symbol"
    return "general"

def parse_snippet_object(raw: str, index: int) -> dict:
    trig_m = re.search(r'trigger:\s*(/(?:\\.|[^/\\])+/[a-z]*|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\')', raw)
    if not trig_m:
        trig_m = re.search(r'trigger:\s*([^,]+)', raw)
        raw_trig = trig_m.group(1).strip() if trig_m else ""
    else:
        raw_trig = trig_m.group(1).strip()

    is_regex = False
    trigger_val = ""
    if raw_trig.startswith("/") and len(raw_trig) > 1:
        is_regex = True
        last_slash = raw_trig.rfind("/")
        trigger_val = raw_trig[1:last_slash]
    elif (raw_trig.startswith('"') and raw_trig.endswith('"')) or (raw_trig.startswith("'") and raw_trig.endswith("'")):
        try:
            trigger_val = json.loads(f'"{raw_trig[1:-1]}"')
        except Exception:
            trigger_val = raw_trig[1:-1].encode().decode('unicode-escape', errors='replace')
    else:
        trigger_val = raw_trig

    opt_m = re.search(r'options:\s*(?:"((?:\\.|[^"\\])*)"|\'((?:\\.|[^\'\\])*)\')', raw)
    options = (opt_m.group(1) if opt_m.group(1) is not None else opt_m.group(2)) if opt_m else ""
    if "r" in options:
        is_regex = True

    desc_m = re.search(r'description:\s*(?:"((?:\\.|[^"\\])*)"|\'((?:\\.|[^\'\\])*)\')', raw)
    description = (desc_m.group(1) if desc_m.group(1) is not None else desc_m.group(2)) if desc_m else ""

    prio_m = re.search(r'priority:\s*(-?\d+)', raw)
    priority = int(prio_m.group(1)) if prio_m else 0

    is_function = False
    rep_idx = raw.find("replacement:")
    if rep_idx != -1:
        sub = raw[rep_idx + len("replacement:"):].strip()
        if sub.startswith("(") or sub.startswith("function"):
            is_function = True
            b_idx = sub.find("{")
            if b_idx != -1:
                depth = 0
                end_func = -1
                in_q = None
                esc = False
                for k in range(b_idx, len(sub)):
                    ch = sub[k]
                    if esc:
                        esc = False
                        continue
                    if in_q:
                        if ch == '\\':
                            esc = True
                        elif ch == in_q:
                            in_q = None
                        continue
                    if ch in ('"', "'", '`'):
                        in_q = ch
                        continue
                    if ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            end_func = k
                            break
                replacement = sub[:end_func + 1].strip() if end_func != -1 else sub
            else:
                replacement = sub
        else:
            rep_m = re.search(r'replacement:\s*(?:"((?:\\.|[^"\\])*)"|\'((?:\\.|[^\'\\])*)\')', raw)
            if rep_m:
                raw_rep = rep_m.group(1) if rep_m.group(1) is not None else rep_m.group(2)
                try:
                    replacement = json.loads(f'"{raw_rep}"')
                except Exception:
                    replacement = raw_rep
            else:
                replacement = ""
    else:
        replacement = ""

    category = categorize_snippet(trigger_val, replacement, options)

    return {
        "id": f"snip_{index + 1}",
        "trigger": trigger_val,
        "is_regex": is_regex,
        "replacement": replacement,
        "is_function": is_function,
        "options": options,
        "description": description,
        "priority": priority,
        "enabled": True,
        "category": category
    }

def format_snippet_to_js(item: dict) -> str:
    """Format single snippet item to JavaScript object literal."""
    parts = []

    # 1. Trigger
    trig = item.get("trigger", "")
    is_regex = item.get("is_regex", False) or "r" in item.get("options", "")
    has_template_var = "${" in trig
    if is_regex and trig and not has_template_var and not trig.startswith("/") and "/" not in trig:
        parts.append(f"trigger: /{trig}/")
    else:
        parts.append(f"trigger: {json.dumps(trig, ensure_ascii=False)}")

    # 2. Replacement
    if item.get("is_function"):
        parts.append(f"replacement: {item['replacement']}")
    else:
        parts.append(f"replacement: {json.dumps(item.get('replacement', ''), ensure_ascii=False)}")

    # 3. Options
    parts.append(f"options: {json.dumps(item.get('options', ''), ensure_ascii=False)}")

    # 4. Description
    if item.get("description"):
        parts.append(f"description: {json.dumps(item['description'], ensure_ascii=False)}")

    # 5. Priority
    if item.get("priority", 0) != 0:
        parts.append(f"priority: {item['priority']}")

    return "{" + ", ".join(parts) + "}"

def generate_snippets_js(snippets: list[dict]) -> str:
    """Generate the full const LATEX_SNIPPETS = [...] block."""
    active_snippets = [s for s in snippets if s.get("enabled", True)]
    lines = []
    for item in active_snippets:
        lines.append("    " + format_snippet_to_js(item))
    return "const LATEX_SNIPPETS = [\n" + ",\n".join(lines) + "\n];"

def read_from_config_js() -> list[dict]:
    """Parse snippets directly from static/config.js."""
    cfg_path = config_js_path()
    if not cfg_path.exists():
        raise StorageError(f"未找到配置文件: {cfg_path}")
    text = cfg_path.read_text(encoding="utf-8")
    s, e = find_array_bounds(text)
    body = text[s + 1:e]
    raw_blocks = extract_raw_snippet_blocks(body)
    return [parse_snippet_object(block, i) for i, block in enumerate(raw_blocks)]

def compute_revision(doc: dict) -> str:
    raw = json.dumps(doc.get("snippets", []), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

def load_data() -> dict:
    """Load snippets data, preferring .snippet-manager/snippets.json.
    If snippets.json does not exist, initialize from static/config.js."""
    with _LOCK:
        json_path = json_config_path()
        if json_path.exists():
            try:
                data = json.loads(json_path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and "snippets" in data:
                    data["revision"] = compute_revision(data)
                    return data
            except Exception:
                pass

        # Fallback to config.js
        snippets = read_from_config_js()
        doc = {
            "version": 1,
            "snippets": snippets,
            "custom_categories": []
        }
        doc["revision"] = compute_revision(doc)
        # Initialize snippets.json
        try:
            _atomic_write(json_path, json.dumps(doc, indent=2, ensure_ascii=False))
        except Exception:
            pass
        return doc

def save_data(snippets: list[dict], current_revision: str | None = None) -> dict:
    """Save snippets to both .snippet-manager/snippets.json and static/config.js.
    Creates .previous backups for rollback."""
    with _LOCK:
        current = load_data()
        if current_revision and current.get("revision") != current_revision:
            raise StorageError("快捷键配置已被其他操作修改，请重新加载后再保存。")

        # Validate snippets
        validated = []
        for i, snip in enumerate(snippets):
            if not isinstance(snip, dict):
                continue
            trigger = str(snip.get("trigger", ""))
            if not trigger.strip() and not snip.get("is_regex"):
                continue
            validated.append({
                "id": snip.get("id") or f"snip_{uuid.uuid4().hex[:8]}",
                "trigger": trigger,
                "is_regex": bool(snip.get("is_regex")),
                "replacement": str(snip.get("replacement", "")),
                "is_function": bool(snip.get("is_function")),
                "options": str(snip.get("options", "")),
                "description": str(snip.get("description", "")),
                "priority": int(snip.get("priority", 0)),
                "enabled": bool(snip.get("enabled", True)),
                "category": str(snip.get("category") or categorize_snippet(trigger, snip.get("replacement", ""), snip.get("options", "")))
            })

        new_doc = {
            "version": 1,
            "snippets": validated,
            "custom_categories": current.get("custom_categories", [])
        }
        new_doc["revision"] = compute_revision(new_doc)

        # 1. Backup snippets.json
        json_path = json_config_path()
        backup_json_path = json_path.with_suffix(".previous.json")
        if json_path.exists():
            try:
                _atomic_write(backup_json_path, json_path.read_text(encoding="utf-8"))
            except Exception:
                pass

        # 2. Save new snippets.json
        _atomic_write(json_path, json.dumps(new_doc, indent=2, ensure_ascii=False))

        # 3. Synchronize with static/config.js
        cfg_path = config_js_path()
        if cfg_path.exists():
            cfg_text = cfg_path.read_text(encoding="utf-8")
            s, e = find_array_bounds(cfg_text)

            # Backup config.js to .snippet-manager/config.js.previous
            backup_js_path = storage_dir() / "config.js.previous"
            try:
                _atomic_write(backup_js_path, cfg_text)
            except Exception:
                pass

            new_js_block = generate_snippets_js(validated)
            prefix = "const LATEX_SNIPPETS = ["
            prefix_idx = cfg_text.find(prefix)
            
            # Replace from prefix_idx to e + 1 (the closing bracket)
            # Find the following semicolon if present
            end_pos = e + 1
            if end_pos < len(cfg_text) and cfg_text[end_pos] == ';':
                end_pos += 1

            new_cfg_text = cfg_text[:prefix_idx] + new_js_block + cfg_text[end_pos:]
            _atomic_write(cfg_path, new_cfg_text)

        return new_doc

def restore_backup() -> dict:
    """Restore from previous backup if available."""
    with _LOCK:
        json_path = json_config_path()
        backup_json_path = json_path.with_suffix(".previous.json")
        if not backup_json_path.exists():
            raise StorageError("没有可恢复的备份文件。")

        raw = backup_json_path.read_text(encoding="utf-8")
        backup_doc = json.loads(raw)
        snippets = backup_doc.get("snippets", [])
        return save_data(snippets)

def import_snippets(data: list | dict, mode: str = "merge") -> dict:
    """Import snippets from external JSON/Obsidian format.
    mode: 'merge' (append new/update) or 'replace' (overwrite all)"""
    with _LOCK:
        if isinstance(data, dict) and "snippets" in data:
            incoming = data["snippets"]
        elif isinstance(data, list):
            incoming = data
        else:
            raise StorageError("导入的数据格式不正确，应为 Snippets 数组或包含 snippets 字段的对象。")

        current = load_data()
        current_list = current.get("snippets", [])

        normalized_incoming = []
        for item in incoming:
            if not isinstance(item, dict):
                continue
            trig = str(item.get("trigger", ""))
            rep = str(item.get("replacement", ""))
            opts = str(item.get("options", ""))
            if not trig.strip():
                continue
            normalized_incoming.append({
                "id": item.get("id") or f"snip_{uuid.uuid4().hex[:8]}",
                "trigger": trig,
                "is_regex": bool(item.get("is_regex") or "r" in opts),
                "replacement": rep,
                "is_function": bool(item.get("is_function")),
                "options": opts,
                "description": str(item.get("description", "")),
                "priority": int(item.get("priority", 0)),
                "enabled": bool(item.get("enabled", True)),
                "category": str(item.get("category") or categorize_snippet(trig, rep, opts))
            })

        if mode == "replace":
            final_list = normalized_incoming
        else:
            # Merge: update existing by trigger + options, append new
            existing_map = {(s["trigger"], s["options"]): i for i, s in enumerate(current_list)}
            final_list = list(current_list)
            for item in normalized_incoming:
                key = (item["trigger"], item["options"])
                if key in existing_map:
                    idx = existing_map[key]
                    item["id"] = final_list[idx]["id"]
                    final_list[idx] = item
                else:
                    final_list.append(item)
                    existing_map[key] = len(final_list) - 1

        return save_data(final_list)
