#!/usr/bin/env bash
set -euo pipefail

# ====== CONFIG ======
HOST_DEFAULT="https://pizza-service.cs329stevenpizza.click"
HOST="${1:-$HOST_DEFAULT}"
HOMEPAGE="${HOST%/}/"
API="${HOST%/}/api"
AUTH="${API}/auth"
ORDER="${API}/order"

NAME="pizza diner"
EMAIL_BASE="diner"
PASSWORD="diner"
TS="$(date +%s)"
EMAIL="${EMAIL_BASE}${TS}@jwt.com"

# jq 可选
have_jq=1
if ! command -v jq >/dev/null 2>&1; then
  echo "[info] jq 未安装，将使用简易解析（建议安装 jq）"
  have_jq=0
fi

# 明确声明数组，兼容老 bash
declare -a pids=()

cleanup() {
  echo
  echo "[info] 停止流量生成..."
  if [[ ${#pids[@]} -gt 0 ]]; then
    for p in "${pids[@]}"; do
      kill "$p" 2>/dev/null || true
    done
    wait 2>/dev/null || true
  fi
  echo "[info] 已全部停止。"
}
trap cleanup INT TERM

json() { printf '%s' "$1" | tr -d '\n' | tr -d '\r'; }

extract_token() {
  local body="$1"
  if [[ $have_jq -eq 1 ]]; then
    printf '%s' "$body" | jq -r '.token // empty'
  else
    printf '%s' "$body" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]\+\)".*/\1/p'
  fi
}

# ====== 健康检查 ======
echo "[info] 健康检查: ${HOMEPAGE}"
curl -sS "${HOMEPAGE}" >/dev/null && echo "[ok] 首页可访问"

# ====== 注册 ======
echo "[info] 注册用户: ${EMAIL}"
register_payload="$(json "{\"name\":\"${NAME}\",\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
curl -sS -X POST "${AUTH}" -H 'Content-Type: application/json' -d "${register_payload}" >/dev/null || true

# ====== 登录取 token ======
echo "[info] 登录以获取 token"
login_payload="$(json "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
login_resp="$(curl -sS -X PUT "${AUTH}" -H 'Content-Type: application/json' -d "${login_payload}")"
TOKEN="$(extract_token "${login_resp}")"
if [[ -z "${TOKEN}" ]]; then
  echo "[error] 未能从登录响应中解析到 token：${login_resp}"
  exit 1
fi
AUTHZ="Authorization: Bearer ${TOKEN}"
echo "[ok] 已获取 token"

# ====== 循环 1：首页 ======
( while true; do
    curl -sS "${HOMEPAGE}" >/dev/null
    sleep 0.2
  done ) & last_pid=$!; pids+=("$last_pid"); echo "[run] 首页流量 PID=${last_pid}"

# ====== 循环 2：成功登录 ======
( while true; do
    curl -sS -X PUT "${AUTH}" -H 'Content-Type: application/json' -d "${login_payload}" >/dev/null
    sleep 1
  done ) & last_pid=$!; pids+=("$last_pid"); echo "[run] 成功登录流量 PID=${last_pid}"

# ====== 循环 3：失败登录 ======
bad_login_payload='{"email":"bad@jwt.com","password":"wrong"}'
( while true; do
    curl -sS -X PUT "${AUTH}" -H 'Content-Type: application/json' \
      -d "$(json "${bad_login_payload}")" -o /dev/null >/dev/null
    sleep 1
  done ) & last_pid=$!; pids+=("$last_pid"); echo "[run] 失败登录流量 PID=${last_pid}"

# ====== 循环 4：成功下单 ======
ok_order_payload='{"items":[{"id":1,"qty":1}]}'
( while true; do
    curl -sS -X POST "${ORDER}" -H 'Content-Type: application/json' -H "${AUTHZ}" \
      -d "$(json "${ok_order_payload}")" >/dev/null
    sleep 2
  done ) & last_pid=$!; pids+=("$last_pid"); echo "[run] 成功下单流量 PID=${last_pid}"

# ====== 循环 5：失败/慢下单（qty=21） ======
fail_order_payload='{"items":[{"id":1,"qty":21}]}'
( while true; do
    curl -sS -X POST "${ORDER}" -H 'Content-Type: application/json' -H "${AUTHZ}" \
      -d "$(json "${fail_order_payload}")" >/dev/null
    sleep 5
  done ) & last_pid=$!; pids+=("$last_pid"); echo "[run] 失败/慢下单流量 PID=${last_pid}"

echo
echo "[info] 已启动 5 个流量循环到 ${HOST}"
echo "[info] 按 Ctrl+C 停止脚本并清理所有循环。"

# 阻塞等待
wait
