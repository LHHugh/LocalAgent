#!/usr/bin/env bash
# 公开演示链路的一键启停：只读智能体实例 -> 公网网关 -> ngrok
#
# 用法：
#   bash start_public.sh [start|stop|status|restart]
#
# 使用前先把下面的路径改成你自己的：
#   PY          运行只读实例的 Python（需要有 qwen-agent 等依赖）
#   ROOT        只读实例与网关所在目录
#   NGROK       ngrok 可执行文件路径
#   NGROK_DOMAIN 固定域名，留空则用随机域名
set -uo pipefail

PY=/data1/lihenghao/envs/qwen-agent/bin/python
ROOT=/data1/lihenghao/qwen-agent-public
NGROK="${NGROK_BIN:-/home/boot/bin/ngrok}"
NGROK_DOMAIN="${NGROK_DOMAIN:-}"

AGENT_PORT="${AGENT_PORT:-8800}"
GW_PORT="${GW_PORT:-8801}"
PER_MINUTE="${PER_MINUTE:-6}"
PER_HOUR="${PER_HOUR:-40}"
MAX_CONCURRENT="${MAX_CONCURRENT:-3}"
MAX_TOKENS="${MAX_TOKENS:-1024}"

mkdir -p "$ROOT/logs" "$ROOT/run"
alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

do_stop() {
  for n in ngrok gateway agent; do
    f="$ROOT/run/$n.pid"
    if alive "$f"; then
      kill "$(cat "$f")" 2>/dev/null && echo "已停止 $n (PID $(cat "$f"))"
    fi
    rm -f "$f"
  done
  pkill -f 'ngrok http' 2>/dev/null
}

do_status() {
  for n in agent gateway ngrok; do
    f="$ROOT/run/$n.pid"
    if alive "$f"; then echo "$n: 运行中 (PID $(cat "$f"))"; else echo "$n: 未运行"; fi
  done
  echo "---"
  echo "实例 $AGENT_PORT: $(curl -s --max-time 4 "http://127.0.0.1:$AGENT_PORT/api/health" | head -c 120)"
  echo "网关 $GW_PORT: $(curl -s --max-time 4 "http://127.0.0.1:$GW_PORT/api/health" | head -c 120)"
  echo "---"
  curl -s --max-time 4 http://127.0.0.1:4040/api/tunnels \
    | grep -o 'https://[a-zA-Z0-9.-]*\.ngrok[^"]*' | sort -u
}

do_start() {
  AGENT_PID="$ROOT/run/agent.pid"
  if alive "$AGENT_PID"; then
    echo "只读实例已在运行 (PID $(cat "$AGENT_PID"))"
  else
    nohup setsid "$PY" "$ROOT/public_agent_server.py" --port "$AGENT_PORT" \
        >"$ROOT/logs/agent.log" 2>&1 &
    echo $! > "$AGENT_PID"
    echo "已启动 只读实例 (PID $(cat "$AGENT_PID"))"
  fi

  GW_PID="$ROOT/run/gateway.pid"
  if alive "$GW_PID"; then
    echo "网关已在运行 (PID $(cat "$GW_PID"))"
  else
    nohup setsid "$PY" "$ROOT/public_gateway.py" \
        --upstream "http://127.0.0.1:$AGENT_PORT" --port "$GW_PORT" \
        --per-minute "$PER_MINUTE" --per-hour "$PER_HOUR" \
        --max-concurrent "$MAX_CONCURRENT" --max-tokens "$MAX_TOKENS" \
        --audit-log "$ROOT/logs/audit.jsonl" \
        >"$ROOT/logs/gateway.log" 2>&1 &
    echo $! > "$GW_PID"
    echo "已启动 网关 (PID $(cat "$GW_PID"))"
  fi

  NG_PID="$ROOT/run/ngrok.pid"
  if alive "$NG_PID"; then
    echo "ngrok 已在运行 (PID $(cat "$NG_PID"))"
  else
    if [[ -n "$NGROK_DOMAIN" ]]; then
      nohup setsid "$NGROK" http --url="$NGROK_DOMAIN" "$GW_PORT" \
          --log "$ROOT/logs/ngrok.log" >/dev/null 2>&1 &
    else
      nohup setsid "$NGROK" http "$GW_PORT" \
          --log "$ROOT/logs/ngrok.log" >/dev/null 2>&1 &
    fi
    echo $! > "$NG_PID"
    echo "已启动 ngrok (PID $(cat "$NG_PID"))"
  fi

  for i in $(seq 1 25); do
    URL=$(curl -s --max-time 3 http://127.0.0.1:4040/api/tunnels \
          | grep -o 'https://[a-zA-Z0-9.-]*\.ngrok[^"]*' | head -1)
    [[ -n "$URL" ]] && { echo; echo "公网地址: $URL"; echo "记得同步到 docs/assets/config.js"; exit 0; }
    sleep 1
  done
  echo "未能取得公网地址，请查看 $ROOT/logs/ngrok.log"
}

case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  status)  do_status ;;
  restart) do_stop; sleep 2; do_start ;;
  *) echo "用法: $0 [start|stop|status|restart]" ;;
esac
