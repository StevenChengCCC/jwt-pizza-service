#!/usr/bin/env bash
set -euo pipefail

# ====== CONFIG ======
HOST_DEFAULT="https://pizza-service.cs329stevenpizza.click"
HOST="${1:-$HOST_DEFAULT}"

HOMEPAGE="${HOST%/}/"
API="${HOST%/}/api"
AUTH="${API}/auth"
ORDER="${API}/order"
MENU="${ORDER}/menu"

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

# 明确声明数组
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

# 从菜单挑一个条目（menuId / description / price）
fetch_menu_item() {
  local resp
  resp="$(curl -sS -f "${MENU}")" || { echo "[error] 获取菜单失败 ${MENU}"; exit 1; }
  if [[ $have_jq -eq 1 ]]; then
    local count
    count="$(printf '%s' "$resp" | jq 'length')" || count=0
    if [[ "$count" -eq 0 ]]; then
      echo "[error] 菜单为空"; exit 1
    fi
    # 随机选一个
    local idx=$(( RANDOM % count ))
    MENU_ID="$(printf '%s' "$resp" | jq -r ".[$idx].id")"
    DESC="$(printf '%s' "$resp" | jq -r ".[$idx].description")"
    PRICE="$(printf '%s' "$resp" | jq -r ".[$idx].price")"
  else
    # 简易 fallback：取第一条
    MENU_ID="$(printf '%s' "$resp" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' | head -n1)"
    DESC="$(printf '%s' "$resp" | sed -n 's/.*"description"[[:space:]]*:[[:space:]]*"\([^"]\+\)".*/\1/p' | head -n1)"
    PRICE="$(printf '%s' "$resp" | sed -n 's/.*"price"[[:space:]]*:[[:space:]]*\([0-9.]\+\).*/\1/p' | head -n1)"
    : "${MENU_ID:=1}"
    : "${DESC:=Auto Pizza}"
    : "${PRICE:=0.05}"
  fi
  echo "[ok] 选中菜单项: id=${MENU_ID}, description=${DESC}, price=${PRICE}"
}

# 构造“成功下单” payload（1 份）
build_ok_order_payload() {
  # 你的后端示例：{ franchiseId, storeId, items:[{ menuId, description, price }] }
  cat <<EOF
{"franchiseId":1,"storeId":1,"items":[{"menuId":${MENU_ID},"description":"${DESC}","price":${PRICE}}]}
EOF
}

# 构造“失败/慢下单” payload（21 份）
build_fail_order_payload() {
  printf '{"franchiseId":1,"storeId":1,"items":['
  local i
  for ((i=1;i<=21;i++)); do
    printf '{"menuId":%s,"description":"%s","price":%s}' "$MENU_ID" "$DESC" "$PRICE"
    if [[ $i -lt 21 ]]; then printf ','; fi
  done
  printf ']}'
}

# ====== 健康检查 ======
echo "[info] 健康检查: ${HOMEPAGE}"
curl -sS -f "${HOMEPAGE}" >/dev/null && echo "[ok] 首页可访问"

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

# ====== 获取菜单，准备下单模板 ======
fetch_menu_item
OK_ORDER_PAYLOAD="$(json "$(build_ok_order_payload)")"
FAIL_ORDER_PAYLOAD="$(json "$(build_fail_order_payload)")"

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
      -d "$(json "${bad_login_payload}")" >/dev/null
    sleep 1
  done ) & last_pid=$!; pids+=("$last_pid"); echo "[run] 失败登录流量 PID=${last_pid}"

# ====== 循环 4：成功下单（1 份） ======
( while true; do
    curl -sS -X POST "${ORDER}" -H 'Content-Type: application/json' -H "${AUTHZ}" \
      -d "${OK_ORDER_PAYLOAD}" >/dev/null
    sleep 2
  done ) & last_pid=$!; pids+=("$last_pid"); echo "[run] 成功下单流量 PID=${last_pid}"

# ====== 循环 5：失败/慢下单（21 份） ======
( while true; do
    curl -sS -X POST "${ORDER}" -H 'Content-Type: application/json' -H "${AUTHZ}" \
      -d "${FAIL_ORDER_PAYLOAD}" >/dev/null
    sleep 5
  done ) & last_pid=$!; pids+=("$last_pid"); echo "[run] 失败/慢下单流量 PID=${last_pid}"

# ====== 可选：循环 6：查看订单列表 ======
( while true; do
    curl -sS -X GET "${ORDER}" -H "${AUTHZ}" >/dev/null
    sleep 3
  done ) & last_pid=$!; pids+=("$last_pid"); echo "[run] 查询订单流量 PID=${last_pid}"

echo
echo "[info] 已启动 6 个流量循环到 ${HOST}"
echo "[info] 按 Ctrl+C 停止脚本并清理所有循环。"

# 阻塞等待
wait
