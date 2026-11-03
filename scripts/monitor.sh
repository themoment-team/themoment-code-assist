#!/usr/bin/env bash
# Health monitor for the review bot. Runs from the server's crontab as the
# deploy user (no sudo, no docker access needed).
#
# Checks the bot's /healthz, the LLM server's /models, and root disk usage, and
# posts to a Discord webhook only when a check changes state (down → recovered),
# so a long outage produces one alert, not one every run.
#
# Config is read from the repo's .env — grepped, never sourced, because it holds
# a multi-line PEM. The bot itself ignores the MONITOR_* keys.
#   MONITOR_DISCORD_WEBHOOK_URL  (required) Discord channel webhook URL
#   MONITOR_DISK_THRESHOLD       alert at this root-disk use % (default 90)
#   PORT, LLM_BASE_URL           reused from the bot's own config
#
# Usage: scripts/monitor.sh          run all checks (cron: every 5 minutes)
#        scripts/monitor.sh --test   send a test message to verify the webhook
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MONITOR_ENV_FILE:-$ROOT/.env}"
STATE_DIR="${MONITOR_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/review-bot-monitor}"
RETRY_DELAY="${MONITOR_RETRY_DELAY:-10}"
mkdir -p "$STATE_DIR"

# Read KEY's value from .env without executing it; strips surrounding quotes and CR.
env_get() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1)"
  v="${v#*=}"
  v="${v%$'\r'}"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

WEBHOOK="$(env_get MONITOR_DISCORD_WEBHOOK_URL)"
PORT="$(env_get PORT)"; PORT="${PORT:-3000}"
LLM_BASE_URL="$(env_get LLM_BASE_URL)"
DISK_THRESHOLD="$(env_get MONITOR_DISK_THRESHOLD)"; DISK_THRESHOLD="${DISK_THRESHOLD:-90}"
HOST_LABEL="$(hostname)"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$STATE_DIR/monitor.log"; }

# Post a message; prints the HTTP status (Discord answers 204 on success).
# Messages are our own fixed text, so only `"` needs escaping; `\n` is a JSON newline.
notify() {
  local msg="${1//\"/\\\"}"
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H 'Content-Type: application/json' \
    -d "{\"content\":\"$msg\"}" "$WEBHOOK"
}

if [ -z "$WEBHOOK" ]; then
  log "MONITOR_DISCORD_WEBHOOK_URL is not set in $ENV_FILE"
  echo "MONITOR_DISCORD_WEBHOOK_URL is not set in $ENV_FILE" >&2
  exit 1
fi

if [ "${1:-}" = "--test" ]; then
  status="$(notify "🔔 [리뷰봇 모니터] 테스트 알림입니다 ($HOST_LABEL). 이 메시지가 보이면 알림 설정이 정상입니다.")"
  echo "discord status: $status (204 = 정상)"
  [ "$status" = 204 ]
  exit
fi

# Pass if any of 3 attempts succeeds, so a deploy restart or a blip doesn't alert.
with_retry() {
  local i
  for i in 1 2 3; do
    "$@" && return 0
    [ "$i" -lt 3 ] && sleep "$RETRY_DELAY"
  done
  return 1
}

check_bot() {
  [ "$(curl -s --max-time 10 "http://127.0.0.1:$PORT/healthz")" = '{"status":"ok"}' ]
}

check_llm() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${LLM_BASE_URL%/}/models")" = 200 ]
}

DISK_USED="$(df -P / | awk 'NR==2 { gsub("%", "", $5); print $5 }')"
check_disk() { [ "$DISK_USED" -lt "$DISK_THRESHOLD" ]; }

# run_check NAME DOWN_MSG UP_MSG CMD... — alert on state transitions only. The
# state file is updated only after Discord accepts the message, so a failed send
# is retried on the next run instead of being lost.
run_check() {
  local name="$1" down="$2" up="$3" file status
  shift 3
  file="$STATE_DIR/$name.down"
  if "$@"; then
    if [ -f "$file" ]; then
      status="$(notify "✅ [리뷰봇 모니터] $up")"
      log "$name recovered (discord=$status)"
      [ "$status" = 204 ] && rm -f "$file"
    fi
  elif [ ! -f "$file" ]; then
    status="$(notify "🚨 [리뷰봇 모니터] $down")"
    log "$name down (discord=$status)"
    [ "$status" = 204 ] && date -u +%FT%TZ > "$file"
  fi
  return 0
}

run_check bot \
  "봇 서버가 응답하지 않습니다 ($HOST_LABEL). PR 리뷰가 달리지 않습니다.\n확인: sudo docker compose ps / sudo docker compose logs --tail=100" \
  "봇 서버가 다시 정상 응답합니다 ($HOST_LABEL)." \
  with_retry check_bot

if [ -n "$LLM_BASE_URL" ]; then
  run_check llm \
    "AI 모델 서버에 연결할 수 없습니다. 리뷰가 실패하고 있을 수 있습니다." \
    "AI 모델 서버가 다시 정상 응답합니다." \
    with_retry check_llm
fi

run_check disk \
  "서버 디스크 사용량이 ${DISK_USED}%입니다 (기준 ${DISK_THRESHOLD}%, $HOST_LABEL)." \
  "서버 디스크 사용량이 ${DISK_USED}%로 내려왔습니다 ($HOST_LABEL)." \
  check_disk
