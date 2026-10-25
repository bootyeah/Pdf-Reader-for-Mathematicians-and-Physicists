# -*- coding: utf-8 -*-
"""LaTeX 公式识图后端核心逻辑（供阅读器 formula_bridge 桥接调用）。"""
import base64
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

from PIL import Image

APP_DIR = os.path.dirname(os.path.abspath(__file__))
if os.path.dirname(APP_DIR) not in sys.path:
    sys.path.insert(0, os.path.dirname(APP_DIR))
import api_settings
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
LOG_PATH = os.path.join(APP_DIR, "latex_ocr.log")

DEFAULT_CONFIG = {
    "api_key": "",
    # 智谱开放平台 OpenAI 兼容接口；换成其它兼容服务只需改 base_url 和 model
    "base_url": "https://open.bigmodel.cn/api/paas/v4",
    "model": "glm-4.6v-flash",
    # 降级备用模型：主模型遇到 429 拥堵（如错误码 1305 平台过载）时自动改用它。
    # 留空 = 关闭自动降级。
    "fallback_model": "glm-4v-flash",
    # 全局热键，支持 ctrl / alt / shift / win + 字母数字或 F1-F12
    "hotkey": "ctrl+alt+z",
    "exit_hotkey": "ctrl+alt+x",
    "pill_pos": None,  # 悬浮球位置 [x, y]；null = 自动（主屏右下角）；拖动后自动记忆
    "prompt": (
        "你是一个顶级的 LaTeX 排版专家。请准确识别图片中的数学公式，并将其转换为 LaTeX 代码。\n"
        "要求：\n"
        "1. 如果是简单的、单行的公式，请使用 $ 包围（例如 $E=mc^2$）。\n"
        "2. 如果是大型公式、矩阵、多行公式、积分、求和等复杂结构，请使用 $$ 包围"
        "（例如 $$\\int_0^1 x^2\\,dx$$）。\n"
        "3. 严禁使用 \\[ \\] 、\\( \\) 或 equation 等环境包裹，只能使用 $ 或 $$ 两种形式。\n"
        "4. 只输出完整的 LaTeX 代码本身，不要解释，不要任何多余的废话（例如“好的，公式如下：”）。\n"
        "5. 如果图片中没有数学公式，只输出：未检测到公式"
    ),
    "proxy": "",
    "temperature": 0.2,
    "timeout": 60,
    "max_side": 4096,  # 图片最长边超过该像素值时等比缩小后再上传
}


def log(msg):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except Exception:
        pass


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
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        log("保存配置失败：" + str(exc))


def prepare_image(cfg, img):
    """把 PIL 图片转成接口需要的 base64 PNG 字符串，超长边先等比缩小。"""
    max_side = int(cfg.get("max_side", 4096))
    w, h = img.size
    if max(w, h) > max_side:
        scale = max_side / max(w, h)
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))),
                         Image.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class ApiError(RuntimeError):
    """带 HTTP 状态码与业务错误码的接口异常，便于判断是否该降级。"""

    def __init__(self, message, http_status=0, code=""):
        super().__init__(message)
        self.http_status = http_status
        self.code = code


def _post_chat(cfg, img_b64, model):
    """按指定模型发一次 chat/completions 请求。"""
    url = api_settings.completion_url(str(cfg.get("base_url", "")))
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": cfg.get("prompt", "")},
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
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
        content = str(content).strip()
        return content, data.get("model", "")
    except Exception:
        raise RuntimeError(
            "接口响应格式异常：" + json.dumps(data, ensure_ascii=False)[:500])


def call_api(cfg, img_b64):
    """调用 OpenAI 兼容的 chat/completions 视觉接口。

    主模型遇到拥堵（HTTP 429，例如错误码 1305「该模型当前访问量过大」、
    1302 账户速率限制）时，自动改用 cfg["fallback_model"] 重试一次，
    使识别不因平台过载而失败。fallback_model 留空则关闭自动降级。
    """
    model = cfg.get("model", "")
    try:
        return _post_chat(cfg, img_b64, model)
    except ApiError as exc:
        fallback = str(cfg.get("fallback_model", "") or "").strip()
        if not fallback or fallback == model or not _is_overload(exc):
            raise
        log(f"主模型 {model} 拥堵（{exc}），自动降级到 {fallback} 重试")
        time.sleep(0.4)  # 官方建议增加重试间隔，避免立即高频重试
        retry_cfg = dict(cfg, model=fallback)
        return _post_chat(retry_cfg, img_b64, fallback)


def _is_overload(exc):
    """判断异常是否属于「模型拥堵/限流」，只有这类才值得降级重试。

    智谱平台把限流类错误统一放在 HTTP 429 下，业务错误码 13xx
    （1302 账户速率限制、1305 平台过载、1308 用量上限等）；
    401/400 等参数或鉴权错误不降级，避免掩盖真正的配置问题。
    """
    if exc.http_status != 429:
        return False
    code = str(exc.code or "")  # 服务端可能返回数字型 code，统一转字符串
    return code.startswith("13") and code.isdigit()


def clean_code(text):
    """去掉模型偶尔附带的 ```latex 代码块围栏等多余内容。"""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        first_line = text.split("\n", 1)[0].strip().lower()
        if first_line in ("latex", "tex", "katex", "math"):
            text = text.split("\n", 1)[1].strip()
    return text


def normalize_delimiters(code):
    """确保公式被 $...$ 或 $$...$$ 包裹：
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

