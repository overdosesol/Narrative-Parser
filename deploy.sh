#!/bin/bash
set -e

SERVER="${1:-root@<server-ip>}"
REMOTE_DIR="${2:-/opt/catalyst}"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_ARCHIVE="/tmp/catalyst_deploy_$$.zip"

echo "🚀 Catalyst Docker Deploy → $SERVER"
echo "📁 Источник: $LOCAL_DIR"
echo ""

echo "[1/5] Validating SPA syntax..."
npm run check:spa
echo "   SPA OK"
echo ""

echo "[2/5] Архивация проекта..."
rm -f "$TMP_ARCHIVE"
cd "$LOCAL_DIR"
zip -qr "$TMP_ARCHIVE" . \
  -x "node_modules/*" "data/*" "logs/*" ".git/*" ".env" \
     ".claude/*" "posts/*" "ai-context/*" "EvilCatPack/*"
echo "✅ Архив готов: $TMP_ARCHIVE"

echo ""
echo "[3/5] Загрузка архива на сервер..."
scp -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$TMP_ARCHIVE" "$SERVER:/tmp/catalyst.zip"

if [ -f "$LOCAL_DIR/.env" ]; then
  echo "[4/5] Загрузка .env..."
  scp -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$LOCAL_DIR/.env" "$SERVER:/tmp/catalyst.env"
else
  echo "[4/5] .env локально не найден, оставляю серверный .env"
fi

echo ""
echo "[5/5] Запуск remote setup..."
scp -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$LOCAL_DIR/setup_remote.sh" "$SERVER:/tmp/catalyst_setup.sh"
# === Sync production backup script (single source of truth: scripts/catalyst-backup.sh) ===
echo "Syncing catalyst-backup.sh to VPS..."
BACKUP_SCRIPT="$LOCAL_DIR/scripts/catalyst-backup.sh"
scp -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$BACKUP_SCRIPT" "$SERVER:/usr/local/bin/catalyst-backup.sh"
ssh -o StrictHostKeyChecking=no "$SERVER" "chmod +x /usr/local/bin/catalyst-backup.sh"
echo "Backup script synced."
# === End backup sync ===

ssh -o StrictHostKeyChecking=no "$SERVER" "REMOTE_DIR='$REMOTE_DIR' bash /tmp/catalyst_setup.sh"

rm -f "$TMP_ARCHIVE"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ Catalyst задеплоен (Docker)"
echo "🌐 Dashboard: http://<server-ip>:8080"
echo "🔒 Admin: localhost-only (127.0.0.1:8081 на сервере)"
echo "═══════════════════════════════════════════════════════"
