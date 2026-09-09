#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
public_gateway.py —— 把内网智能体安全地暴露到公网的最小网关。

只用 Python 标准库，零依赖，单文件，可直接 `python3 public_gateway.py` 运行。

它解决四件事：

1. 路由白名单
   公网只允许 /api/health 与 /api/chat 两个路径。
   其余路径（工具开关、技能增删、定时任务、文件读写等管理接口）一律 404。
   这是最重要的一层：即使上游实例本身开着 Shell 工具，公网也碰不到开关接口。

2. 限流与并发控制
   按来源 IP 做「每分钟 / 每小时」双窗口限流，并限制同时占用的后端并发数。
   实验室 GPU 是共享资源，不能被陌生流量拖垮。

3. 请求体检
   限制请求体大小、消息条数、单条消息长度，并强制压低 max_tokens，
   防止有人用超长输入或超大输出把 8K 上下文的 vLLM 打爆。

4. SSE 透传
   逐块转发上游的 text/event-stream，不做任何缓冲，保证前端逐字显示的观感。

用法：
    python3 public_gateway.py --upstream http://127.0.0.1:8800 --port 8801
    python3 public_gateway.py --upstream http://127.0.0.1:8800 --port 8801 \
        --per-minute 6 --per-hour 40 --max-concurrent 3 --max-tokens 1024

配合内网穿透：
    ngrok http --domain=your-name.ngrok-free.app 8801
"""

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- 常量

ALLOW_GET = {"/api/health"}
ALLOW_POST = {"/api/chat"}

MAX_BODY_BYTES = 256 * 1024     # 请求体上限
MAX_MESSAGES = 20               # 上下文消息条数上限
MAX_INPUT_CHARS = 4000          # 单条消息字符数上限
UPSTREAM_TIMEOUT = 900          # 上游超时（秒），与长推理保持一致

# 本地开发机上常配了 HTTP_PROXY，会把 127.0.0.1 / 内网地址也代理走导致 502，
# 这里统一用一个不走代理的 opener。
NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ---------------------------------------------------------------- 限流

class Limiter:
    """按 IP 的双窗口滑动计数 + 全局并发闸门。"""

    def __init__(self, per_minute, per_hour, max_concurrent):
        self.per_minute = per_minute
        self.per_hour = per_hour
        self.sem = threading.Semaphore(max_concurrent)
        self.hits = defaultdict(deque)      # ip -> deque[timestamp]
        self.lock = threading.Lock()

    def _prune(self, q, now):
        while q and now - q[0] > 3600:
            q.popleft()

    def check(self, ip):
        """返回 (是否放行, 提示语)。"""
        now = time.time()
        with self.lock:
            q = self.hits[ip]
            self._prune(q, now)
            minute = sum(1 for t in q if now - t <= 60)
            hour = len(q)
            if minute >= self.per_minute:
                return False, f"请求过于频繁（每分钟上限 {self.per_minute} 次），请稍后再试。"
            if hour >= self.per_hour:
                return False, f"已达到每小时 {self.per_hour} 次的体验额度，请稍后再来。"
            q.append(now)
        return True, ""

    def stats(self):
        with self.lock:
            return {"ips": len(self.hits)}


# ---------------------------------------------------------------- 审计日志

class AuditLog:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        if path:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    def write(self, **kw):
        if not self.path:
            return
        kw["ts"] = time.strftime("%Y-%m-%d %H:%M:%S")
        line = json.dumps(kw, ensure_ascii=False)
        with self.lock:
            try:
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception as e:  # 日志失败绝不能影响主流程
                print(f"[audit] {e}", file=sys.stderr)


# ---------------------------------------------------------------- 请求体校验

def sanitize_chat_body(body, max_tokens_cap):
    """裁剪并校验 /api/chat 的请求体，返回 (body, 错误信息)。"""
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None, "messages 必须是非空数组"

    msgs = msgs[-MAX_MESSAGES:]
    cleaned = []
    for m in msgs:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role not in ("user", "assistant", "system"):
            continue
        content = m.get("content")
        if isinstance(content, list):          # 多模态：只保留文本片段
            content = " ".join(
                x.get("text", "") for x in content if isinstance(x, dict)
            )
        if not isinstance(content, str):
            continue
        if len(content) > MAX_INPUT_CHARS:
            content = content[:MAX_INPUT_CHARS]
        cleaned.append({"role": role, "content": content})
    if not cleaned:
        return None, "没有有效的消息内容"

    body["messages"] = cleaned
    # 强制压低生成长度：保护共享 GPU，也避免超长输出撑爆上下文
    try:
        mt = int(body.get("max_tokens", max_tokens_cap))
    except (TypeError, ValueError):
        mt = max_tokens_cap
    body["max_tokens"] = max(64, min(mt, max_tokens_cap))
    # 温度钳到合法区间
    try:
        t = float(body.get("temperature", 0.7))
    except (TypeError, ValueError):
        t = 0.7
    body["temperature"] = max(0.0, min(t, 1.0))
    # 公网不开放自主执行模式
    body.pop("mode", None)
    # 不允许客户端自定义模型
    body.pop("model", None)
    return body, ""


# ---------------------------------------------------------------- Handler

class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "public-gateway/1.0"

    # 注入的属性（由 make_server 设置）
    upstream = ""
    limiter = None
    audit = None
    max_tokens_cap = 1024

    def log_message(self, fmt, *args):
        if self.audit:
            self.audit.write(event="access", msg=fmt % args)

    # ---------- 基础工具 ----------

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # 直接回显浏览器请求的头。ngrok 免费版会给浏览器请求插一张拦截页，
        # 前端必须带 ngrok-skip-browser-warning 才能绕过；一旦带了这个自定义头，
        # 浏览器就会先发 OPTIONS 预检，这里不回显就会被 CORS 拦下。
        req = self.headers.get("Access-Control-Request-Headers")
        self.send_header(
            "Access-Control-Allow-Headers",
            req or "Content-Type, Authorization, ngrok-skip-browser-warning",
        )

    def _json(self, obj, status=200):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _client_ip(self):
        # 走 ngrok 时真实 IP 在 X-Forwarded-For 的最左侧
        xff = self.headers.get("X-Forwarded-For", "")
        if xff:
            return xff.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "unknown"

    # ---------- 路由 ----------

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path not in ALLOW_GET:
            return self._json({"error": "not found"}, 404)
        self._proxy(path, None)

    def do_POST(self):
        ip = self._client_ip()
        path = self.path.split("?", 1)[0]

        if path not in ALLOW_POST:
            self.audit and self.audit.write(event="blocked_path", ip=ip, path=path)
            return self._json({"error": "not found"}, 404)

        ok, why = self.limiter.check(ip)
        if not ok:
            self.audit and self.audit.write(event="rate_limited", ip=ip, path=path)
            return self._json({"error": why}, 429)

        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except (TypeError, ValueError):
            length = 0
        if length > MAX_BODY_BYTES:
            return self._json({"error": "请求体过大"}, 413)
        raw = self.rfile.read(length) if length else b"{}"

        try:
            body = json.loads(raw.decode("utf-8", "ignore") or "{}")
        except Exception:
            return self._json({"error": "请求体不是合法 JSON"}, 400)
        if not isinstance(body, dict):
            return self._json({"error": "请求体必须是 JSON 对象"}, 400)

        body, err = sanitize_chat_body(body, self.max_tokens_cap)
        if err:
            return self._json({"error": err}, 400)

        user_text = ""
        for m in reversed(body["messages"]):
            if m["role"] == "user":
                user_text = m["content"]
                break

        self.audit and self.audit.write(
            event="chat", ip=ip, chars=len(user_text),
            ua=(self.headers.get("User-Agent", "") or "")[:120],
        )

        if not self.limiter.sem.acquire(timeout=120):
            return self._json({"error": "服务繁忙，请稍后重试。"}, 503)
        try:
            self._proxy(path, body)
        finally:
            self.limiter.sem.release()

    # ---------- 上游转发（SSE 透传） ----------

    def _chunk(self, data):
        try:
            self.wfile.write(b"%X\r\n" % len(data) + data + b"\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise

    def _proxy(self, path, body):
        url = self.upstream.rstrip("/") + path
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url, data=data, method="POST" if data is not None else "GET",
            headers={"Content-Type": "application/json"},
        )
        try:
            up = NO_PROXY_OPENER.open(req, timeout=UPSTREAM_TIMEOUT)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "ignore")[:300]
            except Exception:
                pass
            return self._json({"error": f"上游错误 {e.code}", "detail": detail}, 502)
        except Exception as e:
            return self._json({"error": f"上游不可达：{type(e).__name__}: {e}"}, 502)

        is_sse = (up.headers.get("Content-Type") or "").startswith("text/event-stream")

        if not is_sse:
            payload = up.read()
            self.send_response(up.status)
            ct = up.headers.get("Content-Type", "application/json")
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(payload)))
            self._cors()
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        # SSE：用分块编码逐块转发，绝不缓冲
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self._cors()
        self.end_headers()
        try:
            while True:
                buf = up.read(4096)
                if not buf:
                    break
                self._chunk(buf)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.close_connection = True
            try:
                up.close()
            except Exception:
                pass


# ---------------------------------------------------------------- 启动

def make_server(args):
    limiter = Limiter(args.per_minute, args.per_hour, args.max_concurrent)
    audit = AuditLog(args.audit_log)

    class H(GatewayHandler):
        pass
    H.upstream = args.upstream
    H.limiter = limiter
    H.audit = audit
    H.max_tokens_cap = args.max_tokens

    srv = ThreadingHTTPServer((args.host, args.port), H)
    srv.daemon_threads = True
    return srv


def main():
    p = argparse.ArgumentParser(description="智能体公网网关（标准库实现）")
    p.add_argument("--upstream", default="http://127.0.0.1:8800", help="上游智能体服务地址")
    p.add_argument("--host", default="127.0.0.1", help="监听地址，默认只听本机（配合 ngrok）")
    p.add_argument("--port", type=int, default=8801)
    p.add_argument("--per-minute", type=int, default=6, help="每 IP 每分钟请求上限")
    p.add_argument("--per-hour", type=int, default=40, help="每 IP 每小时请求上限")
    p.add_argument("--max-concurrent", type=int, default=3, help="后端并发上限")
    p.add_argument("--max-tokens", type=int, default=1024, help="强制的生成长度上限")
    p.add_argument("--audit-log", default="", help="审计日志路径（JSONL），留空则不记录")
    args = p.parse_args()

    srv = make_server(args)
    print("=" * 58, flush=True)
    print("  智能体公网网关已启动", flush=True)
    print(f"  监听      : http://{args.host}:{args.port}", flush=True)
    print(f"  上游      : {args.upstream}", flush=True)
    print(f"  限流      : 每 IP {args.per_minute}/分钟，{args.per_hour}/小时", flush=True)
    print(f"  并发上限  : {args.max_concurrent}", flush=True)
    print(f"  生成上限  : {args.max_tokens} tokens", flush=True)
    print(f"  白名单    : GET {sorted(ALLOW_GET)}  POST {sorted(ALLOW_POST)}", flush=True)
    print("=" * 58, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
