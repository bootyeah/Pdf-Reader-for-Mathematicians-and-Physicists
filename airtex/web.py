# -*- coding: utf-8 -*-
"""airtex HTTP + WebSocket 服务：手机端网页、实时笔迹同步、识别接口。

设计要点：
* 只用标准库（http.server + socket 手写 WebSocket 帧），零第三方依赖；
* 所有可变状态集中在 AppCore，用锁保护，HTTP 线程与 GUI 线程共享；
* 识别在独立工作线程里跑，结果通过 WebSocket 实时推给手机，也可用
  /api/state 轮询（WebSocket 不可用时的兜底）；
* 静态文件从 web/ 目录读取，不把 HTML 塞进 Python 源码。
"""
import base64
import hashlib
import json
import os
import socket
import struct
import threading
import time
import urllib.parse
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:  # 阅读器以包导入，独立启动仍沿用原来的导入方式。
    from . import core
    from .core import APP_DIR, log
except ImportError:
    import core
    from core import APP_DIR, log

WEB_DIR = os.path.join(APP_DIR, "web")
PAGE_PATH = os.path.join(WEB_DIR, "index.html")

# WebSocket
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
WS_MAGIC = WS_GUID
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

MAX_BODY = 24 * 1024 * 1024       # 长篇草稿；容量超限明确报错，不能静默截断
PROTOCOL_VERSION = 7              # 无限画布；旧版有限画板仍兼容


# --------------------------------------------------------------------------
# 应用状态
# --------------------------------------------------------------------------

class AppCore:
    """手写文档 + 识别状态。GUI 与其通过回调/队列交互。

    两种输入模式（**两套完全独立的画布**，互不同步、互不覆盖）：
    * ``phone``（默认）：手机端网页手写，``self.doc`` 是唯一真相，
      手机写一笔就推一笔，电脑端只做显示（可以自动放大笔迹填满窗口）；
    * ``pc``：直接用鼠标在电脑浮窗上写，``self.pc_doc`` 是唯一真相，
      固定 1:1 画板显示、绝不自动缩放；此时手机端被「暂停」
      （它的写入会被拒绝，页面显示遮罩），两边不会互相抢同一块画布。

    切换模式只换「谁在写」，两套画布的内容都原地保留。

    手机端同步模型（v4 起，修正「写一笔又突然被清空」的问题）：
    * 手机端是手写内容的唯一来源，服务端只做存储 + 转发；
    * 服务端绝不把自己的文档回推给「刚写入的那个客户端」——回推会造成
      手机收到自己上一帧的旧内容（或空内容）而把画布清掉；
    * 跨客户端同步（手机刷新后重新拉、PC 端清空）通过 hello/poll 完成。
    """

    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.RLock()
        self.mode = core.normalize_mode(cfg.get("input_mode"))
        self.doc = {"w": 1000, "h": 700, "strokes": []}      # 手机手写画布
        self.page_id = ""                  # 只保存手机白板当前页的标识和内容
        self.page_generation = 0
        self.rev = 0                       # 手机画布版本号，每写一次 +1
        self.pc_doc = {"w": 1000, "h": 700, "strokes": []}   # 鼠标手写画板
        self.pc_rev = 0                    # 鼠标画板版本号，每写一笔 +1
        self.seq = 0                       # 状态广播序号（每次状态变化 +1）
        self.session = "%08x" % (int(time.time() * 1000) & 0xFFFFFFFF)
        self.device = ""                   # 手机 UA 猜出的名字
        self.client_ip = ""
        self.online_ts = 0.0               # 最近一次收到手机请求的时间
        self.result = None                 # 最近一次识别结果 dict（含 mode）
        self.recognizing = False
        self.error = ""
        self.error_mode = core.MODE_PHONE  # 上面这条 error 是哪种模式产生的
        self.auto_recognize_at = 0.0       # 自动识别预定时间
        self.cleared_seq = 0               # 服务端主动清空手机画布的次数
        self.client_updates = {}           # 丢弃超时请求迟到的旧写入，仍允许撤销/擦除
        self.ws_clients = {}               # wid -> (sock, client_id)
        self._ws_send_locks = {}           # wid -> threading.Lock
        self.ws_lock = threading.Lock()
        self._ws_id = 0
        self.on_change = None              # GUI 注册的回调（在 HTTP 线程里调用）
        self._recog_thread = None

    # ---------- 状态快照 ----------

    def snapshot(self, since_rev=None, since_seq=None):
        """状态快照。

        since_rev / since_seq 为 None 时一定带上完整文档（客户端首次询问）；
        传了版本号且没变化时省略 doc，省流量。

        注意：``doc`` 永远是**手机画布**；鼠标画板只报版本号/笔数/尺寸
        （手机端拿不到鼠标笔迹，这正是两种模式互相独立的一部分）。
        """
        with self.lock:
            data = {
                "protocol": PROTOCOL_VERSION,
                "session": self.session,
                "mode": self.mode,
                "rev": self.rev,
                "seq": self.seq,
                "size": [self.doc["w"], self.doc["h"]],
                "strokes": len(self.doc["strokes"]),
                "pcRev": self.pc_rev,
                "pcStrokes": len(self.pc_doc["strokes"]),
                "pcSize": [self.pc_doc["w"], self.pc_doc["h"]],
                "device": self.device,
                "clientIp": self.client_ip,
                "online": self.is_online(),
                "recognizing": self.recognizing,
                "result": self.result,
                "error": self.error,
                "errorMode": self.error_mode,
                "clearedSeq": self.cleared_seq,
                "pageId": self.page_id,
                "autoRecognize": bool(self.cfg.get("auto_recognize")),
            }
            if since_rev is None or since_rev != self.rev:
                data["doc"] = self.doc
            return data

    def is_online(self, timeout=6.0):
        return (time.time() - self.online_ts) < timeout

    def _notify(self):
        if self.on_change:
            try:
                self.on_change()
            except Exception as exc:
                log("on_change 回调异常：" + repr(exc))

    # ---------- WebSocket 广播 ----------

    def register_ws(self, sock, client_id=""):
        with self.ws_lock:
            self._ws_id += 1
            wid = self._ws_id
            self.ws_clients[wid] = (sock, client_id or "")
            self._ws_send_locks[wid] = threading.Lock()
        return wid

    def unregister_ws(self, wid):
        with self.ws_lock:
            self.ws_clients.pop(wid, None)
            self._ws_send_locks.pop(wid, None)

    def set_ws_client(self, wid, client_id):
        with self.ws_lock:
            if wid in self.ws_clients:
                sock, _old = self.ws_clients[wid]
                self.ws_clients[wid] = (sock, client_id)

    def send_frame(self, wid, frame):
        """线程安全地向指定 WebSocket 发送已编码帧。"""
        with self.ws_lock:
            item = self.ws_clients.get(wid)
            send_lock = self._ws_send_locks.get(wid)
        if not item:
            return False
        try:
            if send_lock:
                with send_lock:
                    item[0].sendall(frame)
            else:
                item[0].sendall(frame)
            return True
        except Exception:
            self.unregister_ws(wid)
            return False

    def send_to(self, wid, payload):
        """只发给某一条 WebSocket 连接。"""
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        return self.send_frame(wid, ws_encode(data, OP_TEXT))

    def broadcast(self, payload, exclude_wid=None, exclude_client=None):
        """给手机端 WebSocket 推消息；失败/被排除的连接跳过。

        exclude_client：不要把消息推给这个客户端（避免客户端收到自己的
        旧帧而覆盖本地内容）。exclude_wid 用于排除当前这条连接。
        """
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        frame = ws_encode(data.encode("utf-8"), OP_TEXT)
        with self.ws_lock:
            clients = [(wid, cid) for wid, (_sock, cid) in self.ws_clients.items()]
        for wid, cid in clients:
            if wid == exclude_wid:
                continue
            if exclude_client and cid and cid == exclude_client:
                continue
            self.send_frame(wid, frame)

    def push_state(self, extra=None, exclude_wid=None, exclude_client=None):
        with self.lock:
            self.seq += 1
        payload = {"type": "state"}
        payload.update(self.snapshot())
        if extra:
            payload.update(extra)
        if exclude_wid is not None or exclude_client:
            payload["excluded"] = True
        self.broadcast(payload, exclude_wid=exclude_wid,
                       exclude_client=exclude_client)

    # ---------- 输入模式：手机手写 / 电脑鼠标手写 ----------
    #
    # 两套画布是**分开**的，不是同一块画布的两个输入源：
    # 手机手写的电脑端画面会「把有笔迹的那块区域放大铺满浮窗」，
    # 鼠标书写必须 1:1（笔尖落在哪就写在哪），两者混在一起会互相打架，
    # 所以这里按模式各管一块画布，切模式谁也不搬谁的内容。

    def set_mode(self, mode, save=True):
        """切换输入模式，返回是否真的换了。"""
        mode = core.normalize_mode(mode)
        with self.lock:
            if mode == self.mode:
                return False
            self.mode = mode
            self.result = None          # 换模式后旧结果/报错都不再适用
            self.error = ""
            self.auto_recognize_at = 0.0
        self.cfg["input_mode"] = mode
        if save:
            core.save_config(self.cfg)
        log("输入模式切换为：" + core.mode_label(mode)
            + ("（手机端暂停书写）" if mode == core.MODE_PC else "（手机端恢复书写）"))
        self._notify()
        self.push_state({"modeChanged": True})
        return True

    def active_doc(self):
        """当前模式正在写的那块画布（拷贝，供识别/渲染使用）。"""
        with self.lock:
            src = self.pc_doc if self.mode == core.MODE_PC else self.doc
            # 保留 infinite 等文档属性，同时隔离笔迹坐标，避免渲染/识别改动原稿。
            return deepcopy(src)

    def pc_set_board(self, w, h, force=False):
        """设定鼠标画板的文档尺寸（画板为空时才生效，免得把写好的内容挪歪）。"""
        with self.lock:
            if self.pc_doc["strokes"] and not force:
                return [self.pc_doc["w"], self.pc_doc["h"]]
            try:
                w = max(80, min(6000, int(w)))
                h = max(80, min(6000, int(h)))
            except (TypeError, ValueError):
                return [self.pc_doc["w"], self.pc_doc["h"]]
            self.pc_doc = {"w": w, "h": h, "strokes": []}
            self.pc_rev += 1
            return [w, h]

    def pc_add_stroke(self, stroke):
        """电脑鼠标写完一笔（松开左键时调用）。只有鼠标手写模式才接受。"""
        with self.lock:
            if self.mode != core.MODE_PC:
                return False
            pts = core.sanitize_strokes(
                [stroke], bounds=(self.pc_doc["w"], self.pc_doc["h"]))
            if not pts:
                return False
            self.pc_doc["strokes"].append(pts[0])
            self.pc_rev += 1
            self.error = ""
            if self.cfg.get("auto_recognize"):
                self.auto_recognize_at = (
                    time.time() + float(
                        self.cfg.get("auto_recognize_delay", 1800)) / 1000.0)
        self._notify()
        self.push_state()
        return True

    def pc_undo(self):
        with self.lock:
            if self.mode != core.MODE_PC or not self.pc_doc["strokes"]:
                return False
            self.pc_doc["strokes"].pop()
            self.pc_rev += 1
            self.result = None
        self._notify()
        self.push_state()
        return True

    def pc_clear(self):
        with self.lock:
            if self.mode != core.MODE_PC:
                return False
            if not self.pc_doc["strokes"]:
                return False
            self.pc_doc["strokes"] = []
            self.pc_rev += 1
            self.result = None
            self.error = ""
            self.auto_recognize_at = 0.0
        self._notify()
        # 只告诉手机「电脑画板清空了」，不动它的画布（cleared_seq 不加）
        self.push_state({"pcCleared": True})
        return True

    # ---------- 文档更新 ----------

    def touch(self, device="", ip=""):
        with self.lock:
            self.online_ts = time.time()
            if device:
                self.device = device
            if ip:
                self.client_ip = ip

    def set_doc(self, doc, rev=None, client_id="", wid=None, cleared_seq=None, update_id=None, page_id=None):
        """客户端写入文档。

        手写客户端是权威：**永远接受它的写入**（包括「擦掉一笔」「变少」）。
        不能拿「笔迹数变少」当过期判据 —— 那会把正常的擦除/撤销当成旧帧丢掉。
        过期只按客户端自称的 rev 判断，而且只在 rev 明显落后时才丢。

        例外：鼠标手写模式下手机端已暂停，它的写入一律拒绝（返回 accepted=False），
        否则手机会把鼠标正在写的画板覆盖掉。
        """
        with self.lock:
            if self.mode == core.MODE_PC:
                return self.rev, False
        if self.cfg.get("output_kind") != "paragraph":
            page_id = None
        if page_id is not None and (not isinstance(page_id, str) or not page_id or len(page_id) > 100):
            raise ValueError("无效的白板页标识")
        doc = core.sanitize_doc(doc)
        with self.lock:
            if self.mode == core.MODE_PC or (cleared_seq is not None and cleared_seq != self.cleared_seq):
                return self.rev, False
            if client_id and isinstance(update_id, int):
                if update_id <= self.client_updates.get(client_id, -1):
                    return self.rev, True
                self.client_updates[client_id] = update_id
                if len(self.client_updates) > 32:
                    del self.client_updates[next(iter(self.client_updates))]
            # 只有「客户端自己说它基于的版本比服务端旧很多」才当作乱序旧帧。
            # 这里留 0 容差会误伤，所以直接不做丢弃：客户端本地才是唯一真相，
            # 服务端只是存储 + 转发（多客户端并发场景由客户端侧的采纳规则兜底）。
            if page_id is not None and page_id != self.page_id:
                self.page_id = page_id
                self.page_generation += 1
                self.result = None
                self.error = ""
            self.doc = doc
            self.rev += 1
            self.error = ""
            if self.cfg.get("auto_recognize") and core.ink_pixels(doc) > 0:
                self.auto_recognize_at = (
                    time.time() + float(
                        self.cfg.get("auto_recognize_delay", 1800)) / 1000.0)
            else:
                self.auto_recognize_at = 0.0
            cur_rev = self.rev
        self._notify()
        # 不回推给写入者本人（否则手机会被自己的旧帧覆盖），
        # 但要回一个「已收到 + 当前 rev」，让手机知道服务端版本号。
        if wid is not None:
            self.send_to(wid, {"type": "ack", "rev": cur_rev,
                               "n": len(doc.get("strokes", []))})
        self.push_state(exclude_wid=wid, exclude_client=client_id)
        return cur_rev, True

    def clear(self, from_pc=False, client_id="", wid=None):
        """清空当前模式的画布。

        鼠标手写模式下「清空」清的是鼠标画板，手机画布一根笔都不动
        （所以手机端切回来时自己的内容还在）。
        """
        if self.mode == core.MODE_PC:
            if from_pc:
                self.pc_clear()
            return
        with self.lock:
            self.doc = dict(self.doc, strokes=[])
            self.rev += 1
            self.result = None
            self.error = ""
            self.auto_recognize_at = 0.0
            if from_pc:
                # 电脑端主动清空要让手机也清空；手机自己清空则无需回推
                self.cleared_seq += 1
            cur_rev = self.rev
        self._notify()
        if wid is not None and not from_pc:
            self.send_to(wid, {"type": "ack", "rev": cur_rev, "n": 0})
        self.push_state({"cleared": True},
                        exclude_wid=None if from_pc else wid,
                        exclude_client=None if from_pc else client_id)

    def undo(self, client_id="", wid=None, remote=False):
        if self.mode == core.MODE_PC:
            # 鼠标手写模式下手机端已暂停：它不能替电脑撤销鼠标笔画
            if not remote:
                self.pc_undo()
            return
        with self.lock:
            if self.doc["strokes"]:
                self.doc["strokes"].pop()
                self.rev += 1
                self.result = None
            cur_rev = self.rev
            n = len(self.doc["strokes"])
        self._notify()
        if wid is not None:
            self.send_to(wid, {"type": "ack", "rev": cur_rev, "n": n})
        self.push_state(exclude_wid=wid, exclude_client=client_id)

    # ---------- 识别 ----------

    def start_recognize(self, payload_doc=None, client_id="", wid=None,
                        remote=False, page_id=None):
        """发起识别：识别**当前模式**正在写的那块画布。

        手机端点识别时会顺手把当前笔迹一起带上来（保证识别的是它自己
        画的那一版），这里先落盘再走识别流程。
        remote=True 表示请求来自手机端（HTTP/WebSocket）：
        鼠标手写模式下手机端已暂停，它既不能送笔迹、也不能代替电脑发起识别。
        """
        with self.lock:
            mode = self.mode
        if remote and mode == core.MODE_PC:
            return False
        if remote and page_id is not None:
            # 多页手机先确认当前页上传，再识别；迟到的旧页请求不能覆盖当前页。
            payload_doc = None
        if mode == core.MODE_PC:
            payload_doc = None          # 鼠标手写：只认电脑画板上的笔迹
        elif payload_doc is not None:
            self.set_doc(payload_doc, rev=payload_doc.get("rev"),
                         client_id=client_id, wid=wid)
        with self.lock:
            if remote and page_id is not None and page_id != self.page_id:
                return False
            if self.recognizing:
                return False
            src = self.pc_doc if mode == core.MODE_PC else self.doc
            # 无限画布必须保留 infinite，否则栅格化会把远处笔迹夹回初始画板边界。
            doc = deepcopy(src)
            page_generation = self.page_generation
            recognized_page = self.page_id
        if core.ink_pixels(doc) <= 0:
            with self.lock:
                self.error = ("画板是空的，先用鼠标写点内容吧"
                              if mode == core.MODE_PC
                              else "画布是空的，先写点内容吧")
                self.error_mode = mode
            self.push_state()
            return False
        with self.lock:
            self.recognizing = True
            self.error = ""
            self.auto_recognize_at = 0.0
        self._notify()
        self.push_state()
        self._recog_thread = threading.Thread(
            target=self._recognize_worker, args=(doc, mode, page_generation, recognized_page), daemon=True)
        self._recog_thread.start()
        return True

    def _recognize_worker(self, doc, mode=core.MODE_PHONE, page_generation=None, page_id=""):
        log("开始识别（%s，笔迹 %d 条）"
            % (core.mode_label(mode), len(doc.get("strokes", []))))
        t0 = time.time()
        try:
            provider = getattr(self, 'config_provider', None)
            cfg = provider() if provider else self.cfg
            res = core.recognize_doc(cfg, doc, mode)
        except Exception as exc:
            res = {"ok": False, "error": "识别异常：" + str(exc), "latex": "",
                   "model": "", "image": None, "empty": False}
        cost = time.time() - t0
        out = {
            "latex": res.get("latex", ""),
            "model": res.get("model", ""),
            "empty": bool(res.get("empty")),
            "cost": round(cost, 2),
            "mode": mode,               # 结果属于哪种模式，界面只显示本模式的
        }
        with self.lock:
            self.recognizing = False
            stale_page = mode == core.MODE_PHONE and page_generation is not None and page_generation != self.page_generation
            if stale_page:
                # 翻页后旧识别任务只结束忙碌状态，不能把旧结果显示到新页。
                res = dict(res, ok=False, error="")
            self.error_mode = mode
            if stale_page:
                err = self.error
            elif res.get("ok") and not res.get("empty"):
                if page_id:
                    out["pageId"] = page_id
                self.result = out
                self.error = ""
            elif res.get("ok") and res.get("empty"):
                self.result = None
                self.error = res.get("error") or "没看出公式"
            else:
                self.result = None
                self.error = res.get("error") or "识别失败"
            err = self.error
        if stale_page:
            self._notify()
            self.push_state()
            return None
        if res.get("ok") and not res.get("empty"):
            log("识别成功（%.1fs，模型 %s）：%s"
                % (cost, res.get("model", ""), out["latex"][:80]))
        else:
            log("识别失败/为空（%.1fs）：%s" % (cost, err))
        self._notify()
        self.push_state({"recognized": True, "error": err})
        return out

    def maybe_auto_recognize(self):
        """由 GUI 定时调用：到点则自动识别。"""
        with self.lock:
            due = self.auto_recognize_at
            if not due or self.recognizing or time.time() < due:
                return
            self.auto_recognize_at = 0.0
        self.start_recognize()


# --------------------------------------------------------------------------
# WebSocket 帧编解码（RFC 6455）
# --------------------------------------------------------------------------

def ws_encode(data, opcode=OP_TEXT):
    """服务器 -> 客户端（不掩码）。"""
    header = bytearray([0x80 | opcode])
    n = len(data)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header += struct.pack("!H", n)
    else:
        header.append(127)
        header += struct.pack("!Q", n)
    return bytes(header) + data


def ws_read_frame(sock):
    """读一帧；返回 (opcode, payload) 或 None（连接结束）。"""
    head = _recv_exact(sock, 2)
    if not head:
        return None
    b1, b2 = head[0], head[1]
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack("!H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _recv_exact(sock, 8))[0]
    if length > MAX_BODY:
        raise ValueError("WebSocket 帧过大：%d" % length)
    mask = _recv_exact(sock, 4) if masked else b""
    payload = _recv_exact(sock, length) if length else b""
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None if not buf else buf
        buf += chunk
    return buf


# --------------------------------------------------------------------------
# HTTP 处理
# --------------------------------------------------------------------------

def _quiet_connection_errors(func):
    """包住请求处理：浏览器关标签/切后台导致的断连不该打印堆栈。"""
    def wrapper(self, *args, **kwargs):
        try:
            return func(self, *args, **kwargs)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True
        except OSError as exc:
            if getattr(exc, "winerror", None) in (10053, 10054, 10058):
                self.close_connection = True
            else:
                raise
    return wrapper


class Handler(BaseHTTPRequestHandler):
    server_version = "airtex/" + core.APP_NAME
    protocol_version = "HTTP/1.1"

    # 浏览器断开是常态（切后台、关标签），一律静默处理
    handle_one_request = _quiet_connection_errors(
        BaseHTTPRequestHandler.handle_one_request)

    def handle(self):
        try:
            BaseHTTPRequestHandler.handle(self)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError,
                OSError):
            self.close_connection = True

    def finish(self):
        try:
            BaseHTTPRequestHandler.finish(self)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError,
                OSError):
            self.close_connection = True

    # ---------- 工具 ----------

    def log_message(self, fmt, *args):
        pass  # 默认的每条请求日志太吵，需要时看 airtex.log

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8",
              extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False),
                   "application/json; charset=utf-8")

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return b""
        if n > MAX_BODY:
            raise ValueError("请求体过大")
        return self.rfile.read(n)

    def _json_body(self):
        raw = self._read_body()
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    @property
    def app(self):
        return self.server.app

    def _authed(self, query):
        token = str(self.app.cfg.get("token", "") or "").strip()
        if not token:
            return True
        given = ""
        if query:
            given = (query.get("t") or [""])[0]
        if not given:
            given = self.headers.get("X-Airtex-Token", "")
        return given == token

    def _client_ip(self):
        return self.client_address[0] if self.client_address else ""

    def _ua(self):
        return self.headers.get("User-Agent", "")

    # ---------- 路由 ----------

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/":
            if self.app.cfg.get("require_page_token") and not self._authed(query):
                return self._send(403, "请从阅读器重新扫码连接")
            return self.serve_page()
        if path == "/favicon.ico":
            return self._send(204)
        if not self._authed(query):
            return self._json(403, {"error": "token 不正确"})
        if path == "/api/state":
            since = query.get("rev", [None])[0]
            try:
                since = int(since) if since is not None else None
            except ValueError:
                since = None
            self.app.touch(device=core.guess_device_name(self._ua()),
                           ip=self._client_ip())
            return self._json(200, self.app.snapshot(since))
        if path == "/api/health":
            return self._json(200, {"ok": True, "app": core.APP_NAME,
                                    "protocol": PROTOCOL_VERSION,
                                    "session": self.app.session})
        if path == "/ws":
            return self.handle_ws(query)
        return self._json(404, {"error": "未知路径"})

    def do_HEAD(self):
        return self.do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        if not self._authed(query):
            return self._json(403, {"error": "token 不正确"})
        try:
            body = self._json_body()
        except Exception as exc:
            return self._json(400, {"error": "请求体解析失败：" + str(exc)})
        who = core.guess_device_name(self._ua())
        self.app.touch(device=who, ip=self._client_ip())
        cid = str(body.get("client") or self.headers.get("X-Airtex-Client", ""))

        if path == "/api/hello":
            self.app.touch(device=body.get("device") or who,
                           ip=self._client_ip())
            with self.app.lock:
                doc = self.app.doc
                rev = self.app.rev
                session = self.app.session
                mode = self.app.mode
            return self._json(200, {"ok": True, "protocol": PROTOCOL_VERSION,
                                    "session": session, "rev": rev, "doc": doc,
                                    "mode": mode, "state": self.app.snapshot()})
        if path == "/api/update":
            doc = body.get("doc") or {}
            try:
                rev, accepted = self.app.set_doc(doc, rev=body.get("rev"),
                                                 client_id=cid, cleared_seq=body.get('clearedSeq'),
                                                 update_id=body.get('updateId'), page_id=body.get('pageId'))
            except ValueError as exc:
                return self._json(400, {'ok': False, 'error': str(exc)})
            with self.app.lock:
                cur = self.app.rev
                mode = self.app.mode
            return self._json(200, {"ok": True, "rev": cur, "mode": mode,
                                    "accepted": accepted, 'clearedSeq': self.app.cleared_seq,
                                    'pageId': self.app.page_id})
        if path == "/api/recognize":
            doc = body.get("doc")
            try:
                started = self.app.start_recognize(doc, client_id=cid, remote=True, page_id=body.get('pageId'))
            except ValueError as exc:
                return self._json(400, {'ok': False, 'error': str(exc)})
            return self._json(200, {"ok": True, "started": started,
                                    "recognizing": self.app.recognizing})
        if path == "/api/clear":
            self.app.clear(from_pc=False, client_id=cid)
            with self.app.lock:
                cur = self.app.rev
            return self._json(200, {"ok": True, "rev": cur})
        if path == "/api/undo":
            self.app.undo(client_id=cid, remote=True)
            with self.app.lock:
                cur = self.app.rev
            return self._json(200, {"ok": True, "rev": cur})
        return self._json(404, {"error": "未知路径"})

    # ---------- 静态页面 ----------

    def serve_page(self):
        try:
            with open(PAGE_PATH, "rb") as f:
                html = f.read()
        except Exception as exc:
            log("读取手机页失败：" + repr(exc))
            return self._send(500, "无法读取 web/index.html")
        token = str(self.app.cfg.get("token", "") or "").strip()
        inject = ("<script>window.AIRTEX_TOKEN=%s;window.AIRTEX_PROTOCOL=%d;window.AIRTEX_PARAGRAPH=%s;"
                  "window.AIRTEX_NAME=%s;</script>"
                  % (json.dumps(token), PROTOCOL_VERSION, json.dumps(self.app.cfg.get('output_kind') == 'paragraph'),
                     json.dumps(core.APP_NAME)))
        html = html.replace(b"<!--AIRTEX_BOOT-->", inject.encode("utf-8"))
        self._send(200, html, "text/html; charset=utf-8")

    # ---------- WebSocket ----------

    def handle_ws(self, query):
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key or "websocket" not in self.headers.get("Upgrade", "").lower():
            return self._json(400, {"error": "不是有效的 WebSocket 请求"})
        accept = base64.b64encode(
            hashlib.sha1((key + WS_MAGIC).encode("ascii")).digest()).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

        sock = self.connection
        sock.settimeout(None)
        app = self.app
        app.touch(device=core.guess_device_name(self._ua()),
                  ip=self._client_ip())
        wid = app.register_ws(sock)
        log(f"WebSocket 已连接（#{wid} {self._client_ip()}）")
        client_id = ""
        try:
            # 首帧只给这个新连接自己的状态（不是群发），避免打扰其它客户端
            if not app.send_frame(wid, ws_encode(json.dumps(
                dict({"type": "state"}, **app.snapshot()),
                ensure_ascii=False).encode("utf-8"), OP_TEXT)):
                return
            while True:
                frame = ws_read_frame(sock)
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == OP_CLOSE:
                    break
                if opcode == OP_PING:
                    if not app.send_frame(wid, ws_encode(payload, OP_PONG)):
                        break
                    continue
                if opcode != OP_TEXT:
                    continue
                try:
                    msg = json.loads(payload.decode("utf-8"))
                except Exception:
                    continue
                if msg.get("client"):
                    client_id = str(msg["client"])
                    app.set_ws_client(wid, client_id)
                self.ws_dispatch(msg, wid=wid, client_id=client_id)
        except Exception as exc:
            log(f"WebSocket 异常（#{wid}）：{exc!r}")
        finally:
            app.unregister_ws(wid)
            log(f"WebSocket 断开（#{wid}）")
            try:
                sock.close()
            except Exception:
                pass
            self.close_connection = True

    def ws_dispatch(self, msg, wid=None, client_id=""):
        kind = msg.get("type")
        app = self.app
        if kind == "update":
            doc = msg.get("doc") or {}
            rev, accepted = app.set_doc(doc, rev=msg.get("rev"),
                                        client_id=client_id, wid=wid, page_id=msg.get('pageId'))
            if not accepted and wid is not None:
                # 鼠标手写模式下手机端已暂停：明确回一条「没收」，
                # 手机据此保留本地内容，切回手机手写时再补发
                app.send_to(wid, {"type": "ack", "rev": rev, "n": 0,
                                  "accepted": False})
        elif kind == "recognize":
            app.start_recognize(msg.get("doc"), client_id=client_id, wid=wid,
                                remote=True, page_id=msg.get('pageId'))
        elif kind == "clear":
            app.clear(client_id=client_id, wid=wid)
        elif kind == "undo":
            app.undo(client_id=client_id, wid=wid, remote=True)
        elif kind == "hello":
            # 手机页连上后自报身份；回一份最新状态给它
            app.touch(device=core.guess_device_name(self._ua()),
                      ip=self._client_ip())
            app.send_to(wid, dict({"type": "state", "hello": True},
                                  **app.snapshot()))
        elif kind == "ping":
            app.touch(device=core.guess_device_name(self._ua()),
                      ip=self._client_ip())
            app.send_to(wid, {"type": "pong", "t": msg.get("t")})


# --------------------------------------------------------------------------
# 启动 / 停止
# --------------------------------------------------------------------------

def _quiet_server_error(request, client_address):
    """socketserver 的默认错误处理会打印堆栈；断连类错误直接忽略。"""
    import sys
    exc = sys.exc_info()[1]
    if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                        BrokenPipeError)):
        return
    if isinstance(exc, OSError) and getattr(exc, "winerror", None) in (
            10053, 10054, 10058):
        return
    ThreadingHTTPServer.handle_error(request, client_address)


class AirtexServer:
    def __init__(self, cfg):
        self.cfg = cfg
        self.app = AppCore(cfg)
        host = str(cfg.get("host", "0.0.0.0"))
        port = int(cfg.get("port", 8765))
        self.httpd = ThreadingHTTPServer((host, port), Handler)
        self.httpd.daemon_threads = True
        # 关标签页/切后台导致的断连不打印堆栈（默认会刷一屏）
        self.httpd.handle_error = _quiet_server_error
        self.httpd.app = self.app
        self.httpd.allow_reuse_address = True
        self.port = self.httpd.server_address[1]
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       kwargs={"poll_interval": 0.3},
                                       daemon=True)
        self.thread.start()
        log(f"服务已启动：http://0.0.0.0:{self.port}/")
        return self.port

    def stop(self):
        try:
            self.httpd.shutdown()
        except Exception:
            pass
        try:
            self.httpd.server_close()
        except Exception:
            pass


def build_url(cfg, ip, port=None):
    """拼出手机可访问的地址（带 token）。"""
    port = port or int(cfg.get("port", 8765))
    url = f"http://{ip}:{port}/"
    token = str(cfg.get("token", "") or "").strip()
    if token:
        url += "?t=" + urllib.parse.quote(token)
    return url
