#!/bin/bash
set -e

SERVER="${1:-root@<server-ip>}"
REMOTE_DIR="${2:-/opt/trendscout}"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_ARCHIVE="/tmp/trendscout_deploy_$$.zip"

echo "🚀 TrendScout Docker Deploy → $SERVER"
echo "📁 Источник: $LOCAL_DIR"
echo ""

echo "[1/4] Архивация проекта..."
rm -f "$TMP_ARCHIVE"
cd "$LOCAL_DIR"
zip -qr "$TMP_ARCHIVE" . \
  -x "node_modules/*" "data/*" "logs/*" ".git/*" ".env"
echo "✅ Архив готов: $TMP_ARCHIVE"

echo ""
echo "[2/4] Загрузка архива на сервер..."
scp -o StrictHostKeyChecking=no "$TMP_ARCHIVE" "$SERVER:/tmp/trendscout.zip"

if [ -f "$LOCAL_DIR/.env" ]; then
  echo "[3/4] Загрузка .env..."
  scp -o StrictHostKeyChecking=no "$LOCAL_DIR/.env" "$SERVER:/tmp/trendscout.env"
else
  echo "[3/4] .env локально не найден, оставляю серверный .env"
fi

echo ""
echo "[4/4] Запуск remote setup..."
scp -o StrictHostKeyChecking=no "$LOCAL_DIR/setup_remote.sh" "$SERVER:/tmp/trendscout_setup.sh"
ssh -o StrictHostKeyChecking=no "$SERVER" "REMOTE_DIR='$REMOTE_DIR' bash /tmp/trendscout_setup.sh"

rm -f "$TMP_ARCHIVE"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ TrendScout задеплоен (Docker)"
echo "🌐 Dashboard: http://<server-ip>:8080"
echo "🔒 Admin: localhost-only (127.0.0.1:8081 на сервере)"
echo "═══════════════════════════════════════════════════════"
