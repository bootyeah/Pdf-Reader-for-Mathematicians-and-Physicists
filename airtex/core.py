# -*- coding: utf-8 -*-
"""airtex 核心模块：配置、笔迹栅格化、GLM 视觉识别、LaTeX 规范化、剪贴板。

本模块不依赖 tkinter 与网络服务，可被 selftest.py 单独导入测试。
识别与呈现方式沿用 tex/latex_ocr.py 的实现：
调用 OpenAI 兼容的 chat/completions 视觉接口（默认智谱 GLM-4.6V-Flash 免费模型），
主模型拥堵（HTTP 429 / 错误码 13xx）时自动降级到 fallback_model 重试。
"""
import base64
import io
import json
import math
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

from PIL import Image, ImageDraw, ImageOps

APP_DIR = os.path.dirname(os.path.abspath(__file__))
if os.path.dirname(APP_DIR) not in sys.path:
    sys.path.insert(0, os.path.dirname(APP_DIR))
import api_settings
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
LOG_PATH = os.path.join(APP_DIR, "airtex.log")

APP_NAME = "airtex"
APP_TITLE = "airtex · 手写公式识别"

# 两种输入模式：各自一块画布，互不同步（详见 README「两种书写模式」）
MODE_PHONE = "phone"     # 手机手写：手机写、电脑实时显示（电脑端会自动放大笔迹）
MODE_PC = "pc"           # 鼠标手写：直接用鼠标在电脑浮窗上写（固定 1:1，不缩放）
MODES = (MODE_PHONE, MODE_PC)


def normalize_mode(value):
    """把任意输入规范成合法模式名（非法/缺失一律当手机手写）。"""
    mode = str(value or "").strip().lower()
    return mode if mode in MODES else MODE_PHONE


def mode_label(mode):
    """模式的中文名（日志/界面提示用）。"""
    return "鼠标手写" if normalize_mode(mode) == MODE_PC else "手机手写"


DEFAULT_CONFIG = {
    # ---- 识别接口（与 tex 工具一致，默认智谱免费视觉模型）----
    "api_key": "",
    "base_url": "https://open.bigmodel.cn/api/paas/v4",
    "model": "glm-4.6v-flash",
    "fallback_model": "glm-4v-flash",
    "proxy": "",
    "temperature": 0.2,
    "timeout": 60,
    "max_side": 4096,
    # ---- 服务 ----
    "host": "0.0.0.0",
    "port": 8765,
    "token": "",              # 非空时手机端需要 ?t=<token> 才能连接
    # ---- 电脑浮窗 ----
    "window_pos": None,       # [x, y]；null = 自动（主屏右上角）
    "window_width": 560,      # 目标显示宽度（像素）
    "window_alpha": 0.88,     # 半透明度：1 = 不透明
    "topmost": True,
    "input_mode": MODE_PHONE,  # 输入模式：phone=手机手写；pc=电脑鼠标手写
                               # 两套画布完全独立，切换模式不会互相搬内容
    "canvas_view": "fill",    # 手机手写的取景：fill=填满窗口（=送 AI 的那块区域）；
                              #                board=整块画板（与手机画面一一对应）
                              # 注意：鼠标手写固定按 1:1 画板显示，与这一项无关
    "pc_pen_width": 4,        # 鼠标手写的笔粗（画板文档坐标单位）
    "auto_copy": True,        # 识别完成后自动复制到剪贴板
    "show_qr_on_start": False,  # 启动时是否显示扫码浮窗（默认只打日志）
    # ---- 识别行为 ----
    "auto_recognize": False,  # 停笔 N 毫秒后自动识别（默认关闭，手动点「识别」）
    "auto_recognize_delay": 1800,
    "crop_margin": 28,        # 裁剪四周留白（像素，栅格化坐标系）
    "min_side": 64,           # 裁剪后最小边长，太小则补白，避免模型看不清
    "debug_keep_png": False,  # 每次识别把上传的图另存到 debug/ 便于排查
}

_PLACEHOLDER_PROMPT = """你是一个顶级的 LaTeX 排版专家。{source}请准确识别图片中的数学公式，并将其转换为 LaTeX 代码。
要求：
1. 如果是简单的、单行的公式，请使用 $ 包围（例如 $E=mc^2$）。
2. 如果是大型公式、矩阵、多行公式、积分、求和等复杂结构，请使用 $$ 包围（例如 $$\\int_0^1 x^2\\,dx$$）。
3. 严禁使用 \\[ \\] 、\\( \\) 或 equation 等环境包裹，只能使用 $ 或 $$ 两种形式。
4. 只输出完整的 LaTeX 代码本身，不要解释，不要任何多余的废话（例如"好的，公式如下："）。
5. 如果图片中没有数学公式，只输出：未检测到公式"""

# 提示词里对「笔迹来自哪种书写方式」的交代：手机手指写和鼠标写的手感差别很大，
# 说清楚能让模型对笔画形态有正确预期（尤其是鼠标笔画更细、更规整）。
_PROMPT_SOURCE = {
    MODE_PHONE: "我在手机上手写了下面的内容，",
    MODE_PC: "我在电脑上用鼠标手写了下面的内容，",
}

NOT_FOUND_TEXT = "未检测到公式"

_log_lock = threading.Lock()


# --------------------------------------------------------------------------
# 日志
# --------------------------------------------------------------------------

def log(msg):
    """写一行日志（多线程安全）。GUI 线程与 HTTP 线程都会调用。"""
    try:
        with _log_lock:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + str(msg) + "\n")
    except Exception:
        pass


def build_prompt(cfg, mode=MODE_PHONE):
    """生成提示词：用户自定义 prompt 优先，未配置时用内置模板（含小费设置）。

    mode 只影响内置模板里「用什么写的」这句交代；用户自定义 prompt 原样使用。
    """
    custom = str(cfg.get("prompt", "") or "").strip()
    text = custom or _PLACEHOLDER_PROMPT.format(
        source=_PROMPT_SOURCE[normalize_mode(mode)])
    if cfg.get("enable_text"):
        text += ("\n6. 图片中如果出现了非公式的文字（题干、单位、说明），请一并识别："
                 "中文用 \\text{...} 包在公式里，独立成句的纯文字原样输出。")
    return text


# --------------------------------------------------------------------------
# 配置
# --------------------------------------------------------------------------

def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                user = json.load(f)
            if isinstance(user, dict):
                cfg.update({k: v for k, v in user.items() if k in cfg})
        except Exception as exc:
            log("config.json 解析失败，已使用默认配置：" + str(exc))
    return cfg


def save_config(cfg):
    data = {k: v for k, v in cfg.items() if k in DEFAULT_CONFIG}
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as exc:
        log("保存配置失败：" + str(exc))
        return False


def ensure_config_file(cfg):
    if not os.path.exists(CONFIG_PATH):
        save_config(cfg)
        log("已生成默认 config.json")


# --------------------------------------------------------------------------
# 网络地址
# --------------------------------------------------------------------------

def _is_private(ip):
    try:
        parts = [int(p) for p in ip.split(".")]
    except Exception:
        return False
    if len(parts) != 4:
        return False
    a, b = parts[0], parts[1]
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    if a == 100 and 64 <= b <= 127:   # 运营商级 NAT / 手机热点常见
        return True
    return False


def _is_usable(ip):
    if ip.startswith("127.") or ip.startswith("169.254."):
        return False
    return True


def rank_ips(ips):
    """排序：私有地址优先，其次 192.168 > 10 > 172 > 100.64/10，最后其它。"""

    def score(ip):
        if ip.startswith("192.168."):
            return 0
        if ip.startswith("10."):
            return 1
        if ip.startswith("172."):
            return 2
        if ip.startswith("100."):
            return 3
        return 4 + (0 if _is_private(ip) else 1)

    out = []
    for ip in ips:
        if _is_usable(ip) and ip not in out:
            out.append(ip)
    out.sort(key=lambda ip: (score(ip), ip))
    return out


def get_lan_ips():
    """列出本机可用于手机访问的 IPv4 地址（不触发真实外网连接）。"""
    ips = []
    # 1) 路由表推导（连不上外网也能拿到默认网卡地址）
    for probe in (("8.8.8.8", 80), ("223.5.5.5", 80), ("1.1.1.1", 80)):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(0.3)
            s.connect(probe)
            ips.append(s.getsockname()[0])
        except Exception:
            pass
        finally:
            s.close()
        if ips:
            break
    # 2) 主机名解析（多网卡时补充）
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None,
                                       socket.AF_INET):
            ips.append(info[4][0])
    except Exception:
        pass
    return rank_ips(ips)


def primary_ip():
    ips = get_lan_ips()
    return ips[0] if ips else "127.0.0.1"





# --------------------------------------------------------------------------
# 笔迹 -> 图片
# --------------------------------------------------------------------------

def _to_float(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    return f


def sanitize_strokes(strokes, max_strokes=50000, max_points=1000000, bounds=None):
    """清洗手机端传来的笔迹：规范坐标、颜色和数量，防止异常数据拖垮服务。

    旧版有限画板传 bounds=(w, h) 以夹住坐标；无限画布不传 bounds，
    保留负坐标和初始视野以外的笔迹，电脑预览与识别使用同一份数据。
    """
    out = []
    if not isinstance(strokes, list):
        return out
    if len(strokes) > max_strokes or sum(len(s.get('p', [])) for s in strokes
                                       if isinstance(s, dict) and isinstance(s.get('p'), list)) > max_points:
        raise ValueError('笔迹已达到单页容量，请先保存或识别，再清空继续书写')
    bw, bh = (bounds if bounds else (None, None))
    for st in strokes:
        if not isinstance(st, dict):
            continue
        pts_in = st.get("p")
        if not isinstance(pts_in, list):
            continue
        pts = []
        for pt in pts_in:
            if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                x = round(_to_float(pt[0]), 2)
                y = round(_to_float(pt[1]), 2)
                if bw is not None:
                    x = max(0.0, min(float(bw), x))
                    y = max(0.0, min(float(bh), y))
                pts.append([x, y])
        if not pts:
            continue
        kind = str(st.get("k", "pen") or "pen")
        if kind not in ("pen", "eraser"):
            kind = "pen"
        width = st.get("w", 3)
        try:
            width = max(0.5, min(80.0, float(width)))
        except (TypeError, ValueError):
            width = 3.0
        stroke = {"k": kind, "w": round(width, 2), "p": pts}
        color = st.get("c")
        if isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            stroke["c"] = color.lower()
        out.append(stroke)
    return out


def sanitize_doc(doc):
    """规范化手机端上传的文档结构。"""
    if not isinstance(doc, dict):
        return {}
    try:
        w = int(doc.get("w") or 1000)
        h = int(doc.get("h") or 700)
    except (TypeError, ValueError):
        w, h = 1000, 700
    w = max(80, min(6000, w))
    h = max(80, min(6000, h))
    infinite = doc.get("infinite") is True
    result = {
        "w": w,
        "h": h,
        "strokes": sanitize_strokes(doc.get("strokes"), bounds=None if infinite else (w, h)),
    }
    if infinite:
        result["infinite"] = True
    return result


def ink_pixels(doc):
    """统计有笔迹的采样点数量，用于判断画布是否为空。"""
    total = 0
    for st in doc.get("strokes", []):
        total += len(st.get("p", []))
    return total


def _draw_strokes(draw, strokes, sx, sy, sw, origin=(0, 0)):
    for st in strokes:
        pts = [((p[0] - origin[0]) * sx, (p[1] - origin[1]) * sy)
               for p in st.get("p", [])]
        if not pts:
            continue
        width = max(1, int(round(st.get("w", 3) * sw)))
        color = "#ffffff" if st.get("k") == "eraser" else st.get("c", "#111111")
        if len(pts) == 1:
            x, y = pts[0]
            r = width / 2.0
            draw.ellipse([x - r, y - r, x + r, y + r], fill=color)
        else:
            draw.line(pts, fill=color, width=width, joint="curve")
            # 手写连笔的圆头端点：line 的 joint 不覆盖首尾
            r = width / 2.0
            for x, y in (pts[0], pts[-1]):
                draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


def rasterize(doc, target_w=1500, margin=28, min_side=64, crop=True):
    """把笔迹文档渲染成 PNG（黑字白底）。

    crop=True （默认，识别用）：裁掉四周留白，只留有笔迹的区域 + margin，
        内容小的时候补白到 min_side，模型看得更清楚。
    crop=False（电脑端「整块画板」显示用）：有限画板保留原始尺寸/比例；
        无限画布取初始视野与全部笔迹的并集，不裁掉远处或负坐标的内容。

    返回 PIL.Image（RGB）；空画布返回 None。
    """
    doc = sanitize_doc(doc)
    if not doc or not doc.get("strokes"):
        return None
    cw, ch = doc["w"], doc["h"]
    origin = (0, 0)
    if doc.get("infinite"):
        # 只分配输出图片，绝不创建与无限画布坐标范围同样大的位图。
        pens = [st for st in doc["strokes"] if st.get("k") != "eraser"]
        if not pens:
            return None
        left = min(p[0] - st["w"] / 2 for st in pens for p in st["p"])
        top = min(p[1] - st["w"] / 2 for st in pens for p in st["p"])
        right = max(p[0] + st["w"] / 2 for st in pens for p in st["p"])
        bottom = max(p[1] + st["w"] / 2 for st in pens for p in st["p"])
        if not crop:
            left, top = min(0, left), min(0, top)
            right, bottom = max(cw, right), max(ch, bottom)
        # 圆头和边缘抗锯齿留出余量，负坐标与远处笔迹都纳入取景。
        pad = max(8, max(right - left, bottom - top) * .02)
        origin = (left - pad, top - pad)
        cw, ch = max(1, right - left + pad * 2), max(1, bottom - top + pad * 2)
    scale = max(1.0, float(target_w) / float(cw))
    scale = min(scale, 2400.0 / max(cw, ch))  # 两个方向都别超过 2400
    iw, ih = max(1, int(round(cw * scale))), max(1, int(round(ch * scale)))
    img = Image.new("RGB", (iw, ih), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    _draw_strokes(draw, doc["strokes"], scale, scale, scale, origin)

    bbox = ImageOps.invert(img.convert("L")).getbbox()
    if not bbox:
        return None
    if not crop:
        return img
    left = max(0, bbox[0] - margin)
    top = max(0, bbox[1] - margin)
    right = min(iw, bbox[2] + margin)
    bottom = min(ih, bbox[3] + margin)
    if right - left < min_side or bottom - top < min_side:
        # 内容太少（比如只点了一个点）：居中补白到最小边长
        pad_w = max(right - left, min_side)
        pad_h = max(bottom - top, min_side)
        canvas = Image.new("RGB", (pad_w, pad_h), (255, 255, 255))
        canvas.paste(img.crop((left, top, right, bottom)),
                     ((pad_w - (right - left)) // 2,
                      (pad_h - (bottom - top)) // 2))
        return canvas
    return img.crop((left, top, right, bottom))


def prepare_image(cfg, img):
    """PIL 图片转 base64 PNG 字符串；最长边超过 max_side 时先等比缩小。"""
    max_side = int(cfg.get("max_side", 4096) or 4096)
    w, h = img.size
    if max(w, h) > max_side:
        s = max_side / float(max(w, h))
        img = img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# --------------------------------------------------------------------------
# 视觉模型调用（沿用 tex/latex_ocr.py 的实现）
# --------------------------------------------------------------------------

class ApiError(RuntimeError):
    """带 HTTP 状态码与业务错误码的接口异常，便于判断是否该降级。"""

    def __init__(self, message, http_status=0, code=""):
        super().__init__(message)
        self.http_status = http_status
        self.code = code


def _post_chat(cfg, img_b64, model, prompt):
    url = api_settings.completion_url(str(cfg.get("base_url", "")))
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url",
                     "image_url": {"url": "data:image/png;base64," + img_b64}},
                ],
            }
        ],
        "temperature": cfg.get("temperature", 0.2),
        # GLM-4.6V 系列支持思考模式，识图不需要推理链：显式关闭，
        # 避免推理内容混进 LaTeX 结果，同时减少等待时间。
        "thinking": {"type": "disabled"},
    }
    api_settings.apply_parameters(payload, cfg)
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + str(cfg.get("api_key", "")).strip(),
        },
    )
    # Shared transport supports direct, system and explicitly configured proxies.
    try:
        with api_settings.open_request(req, cfg) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        code = ""
        try:
            body = json.loads(exc.read().decode("utf-8"))
            detail = body.get("error", {}).get("message", "") or str(body)
            code = str(body.get("error", {}).get("code", ""))
        except Exception:
            pass
        detail = api_settings.redact(detail or exc.reason, cfg)
        raise ApiError(f"HTTP {exc.code}: {detail}",
                       http_status=exc.code, code=code)
    except Exception as exc:
        raise RuntimeError(f"网络请求失败：{exc}")
    try:
        content = data["choices"][0]["message"]["content"]
        if isinstance(content, list):  # 少数兼容实现会返回分段内容
            content = "".join(str(part.get("text", "")) if isinstance(part, dict)
                              else str(part) for part in content)
        return str(content).strip(), data.get("model", "")
    except Exception:
        raise RuntimeError(
            "接口响应格式异常：" + json.dumps(data, ensure_ascii=False)[:500])


def _is_overload(exc):
    """只有「模型拥堵/限流」才值得降级重试。

    智谱平台把限流类错误统一放在 HTTP 429 下，业务错误码 13xx
    （1302 账户速率限制、1305 平台过载、1308 用量上限等）；
    401/400 等参数或鉴权错误不降级，避免掩盖真正的配置问题。
    """
    if exc.http_status != 429:
        return False
    code = str(exc.code or "")
    return code.startswith("13") and code.isdigit()


def call_api(cfg, img_b64, mode=MODE_PHONE):
    """调用 OpenAI 兼容的 chat/completions 视觉接口，返回 (文本, 实际模型名)。"""
    prompt = build_prompt(cfg, mode)
    model = cfg.get("model", "")
    try:
        return _post_chat(cfg, img_b64, model, prompt)
    except ApiError as exc:
        fallback = str(cfg.get("fallback_model", "") or "").strip()
        if not fallback or fallback == model or not _is_overload(exc):
            raise
        log(f"主模型 {model} 拥堵（{exc}），自动降级到 {fallback} 重试")
        time.sleep(0.4)  # 官方建议增加重试间隔，避免立即高频重试
        return _post_chat(cfg, img_b64, fallback, prompt)


# --------------------------------------------------------------------------
# 结果清理（与 tex 工具保持一致）
# --------------------------------------------------------------------------

def clean_code(text):
    """去掉模型偶尔附带的 ```latex 代码块围栏等多余内容。"""
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        first_line = text.split("\n", 1)[0].strip().lower()
        if first_line in ("latex", "tex", "katex", "math"):
            text = text.split("\n", 1)[1].strip()
    return text


def normalize_delimiters(code):
    """确保公式被 $...$ 或 $$...$$ 包裹。

    - 已是 $...$ / $$...$$ 则原样保留
    - \\[...\\] 转成 $$...$$，\\(...\\) 转成 $...$
    - 其它情况（无包裹、包裹不完整）统一包成 $$...$$
    """
    code = (code or "").strip()
    if not code:
        return code
    if code.startswith("$$") and code.endswith("$$") and len(code) >= 4:
        return code
    if code.startswith("$") and code.endswith("$") and len(code) >= 2:
        return code
    if code.startswith("\\[") and code.endswith("\\]"):
        return "$$" + code[2:-2].strip() + "$$"
    if code.startswith("\\(") and code.endswith("\\)"):
        return "$" + code[2:-2].strip() + "$"
    core = code.strip("$").strip()
    return "$$" + core + "$$"


def latex_inner(code):
    """取出公式本体（去掉 $ / $$ / \\[ \\] 包裹），供渲染使用。"""
    c = (code or "").strip()
    if c.startswith("\\[") and c.endswith("\\]"):
        return c[2:-2].strip()
    if c.startswith("\\(") and c.endswith("\\)"):
        return c[2:-2].strip()
    return c.strip("$").strip()


def is_empty_result(code):
    """模型表示「没看到公式」时视为空结果。

    除了显式的「未检测到公式」，也要识别模型对潦草笔迹给出的空壳/噪声输出：
      $$\\begin{array}{c}\\end{array}$$、$ $、$\\triangle$ 这类没有实际内容的
    片段都算「没看出公式」，避免把垃圾塞进剪贴板。
    """
    c = (code or "").strip()
    if not c:
        return True
    if NOT_FOUND_TEXT in c:
        return True
    inner = latex_inner(c)
    compact = re.sub(r"\s+", "", inner)
    if not compact:
        return True
    # 去掉环境、命令、括号、上下标等纯排版符号
    body = re.sub(r"\\begin\{[^}]*\}(?:\{[^}]*\})?", "", compact)
    body = re.sub(r"\\end\{[^}]*\}", "", body)
    body = re.sub(r"\\[a-zA-Z]+", "", body)          # 命令名
    body = re.sub(r"[\\{}&_^~$]", "", body)          # 排版符号
    if not body:
        return True                                      # 只剩命令/环境
    if not re.search(r"[0-9A-Za-z\u4e00-\u9fff]", body):
        return True                                      # 只剩符号（+-=等）
    # 单个字符（例如只认出一个字母）也基本是噪声
    if len(re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", body)) < 2:
        return True
    return False


# --------------------------------------------------------------------------
# 一次完整的识别流程
# --------------------------------------------------------------------------

def recognize_doc(cfg, doc, mode=MODE_PHONE):
    """把笔迹文档送去识别，返回 dict：
    {ok, latex, model, error, image, image_b64, empty}

    mode 只用来挑选提示词（手机手写 / 鼠标手写）；两种模式的笔迹走的
    是同一套栅格化与识别流程，裁剪、最小边长等行为完全一致。
    """
    img = rasterize(doc, target_w=int(cfg.get("raster_width", 1500) or 1500),
                    margin=int(cfg.get("crop_margin", 28) or 28),
                    min_side=int(cfg.get("min_side", 64) or 64))
    if img is None:
        return {"ok": False, "error": "画布是空的，先写点内容吧", "empty": True,
                "latex": "", "model": "", "image": None, "image_b64": ""}
    if cfg.get("debug_keep_png"):
        try:
            out_dir = os.path.join(APP_DIR, "debug")
            os.makedirs(out_dir, exist_ok=True)
            img.save(os.path.join(out_dir,
                                  time.strftime("shot_%Y%m%d_%H%M%S.png")))
        except Exception:
            pass
    b64 = prepare_image(cfg, img)
    try:
        text, model = call_api(cfg, b64, mode)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "latex": "", "model": "",
                "image": img, "image_b64": b64, "empty": False}
    raw = clean_code(text)
    paragraph = cfg.get('output_kind') == 'paragraph'
    if paragraph:
        # 正文保留在数学环境外，只规范公式定界符。
        final = re.sub(r'\\\[(.*?)\\\]', lambda m: '$$' + m[1].strip() + '$$', raw, flags=re.S)
        final = re.sub(r'\\\((.*?)\\\)', lambda m: '$' + m[1].strip() + '$', final, flags=re.S)
    else:
        final = normalize_delimiters(raw)
    if final != raw:
        log("分隔符已自动修正：" + raw[:80])
    if paragraph:
        empty = not raw or re.fullmatch(r'未检测到(?:内容|公式)[\s。.!！]*', raw) is not None
    else:
        empty = is_empty_result(raw)
    if empty:
        return {"ok": True, "empty": True, "latex": "", "model": model,
                "error": ("未检测到可识别内容，请重试或切换识别模型" if paragraph
                          else "没看出公式，试试写清楚一点或只框住公式本身"),
                "image": img, "image_b64": b64}
    return {"ok": True, "empty": False, "latex": final, "model": model,
            "error": "", "image": img, "image_b64": b64}





# --------------------------------------------------------------------------
# 手机型号显示
# --------------------------------------------------------------------------

def guess_device_name(user_agent):
    """从 UA 里猜一个好看点的设备名，用于电脑浮窗标题。"""
    ua = str(user_agent or "")
    patterns = [
        (r"(iPhone)", "iPhone"),
        (r"(iPad)", "iPad"),
        (r"(Macintosh)", "Mac"),
        (r"Android[^;]*;\s*([^;)]+?)(?:\s+Build|\))", "Android"),
        (r"(Windows NT 10\.0)", "Windows"),
    ]
    for pat, fallback in patterns:
        m = re.search(pat, ua)
        if m:
            name = m.group(1).strip()
            name = re.sub(r"\s*(Build/.*|wv|Mobile)$", "", name).strip()
            if name:
                return name
            return fallback
    return "手机"
