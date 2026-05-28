#!/bin/bash
# Catalyst production daily backup
# Source of truth: scripts/catalyst-backup.sh in repo
# deploy.{sh,ps1} syncs it to /usr/local/bin/catalyst-backup.sh on VPS
# Invoked by cron: /etc/cron.d/catalyst-backup at 03:30 UTC daily

set -euo pipefail

# Bundle #6 — TG alert on backup failure. Load env (best-effort; secrets at
# /etc/catalyst.env or wherever deploy.sh writes them).
[ -f /etc/catalyst.env ] && set -o allexport && . /etc/catalyst.env && set +o allexport

notify_failure() {
  local exit_code=$?
  # Don't alert on successful exit.
  if [ "$exit_code" -eq 0 ]; then exit 0; fi
  if [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${SUPPORT_GROUP_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${SUPPORT_GROUP_ID}" \
      --data-urlencode "text=🚨 Catalyst backup FAILED (exit ${exit_code}) on $(hostname) at $(date -Is)" \
      > /dev/null 2>&1 || true
  fi
  exit "$exit_code"
}

trap notify_failure EXIT

BACKUP_DIR=/var/backups/catalyst
DATE=$(date +%Y-%m-%d_%H-%M)
mkdir -p "$BACKUP_DIR"

# Discover the catalyst-app /data volume mount path on host
VOLUME_NAME=$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Name }}{{ end }}{{ end }}' catalyst-app)
[ -n "$VOLUME_NAME" ] || { echo "$(date -Is) FATAL: could not find /data mount for catalyst-app container" >&2; exit 1; }

VOLUME_PATH=$(docker volume inspect -f '{{ .Mountpoint }}' "$VOLUME_NAME")
[ -n "$VOLUME_PATH" ] || { echo "$(date -Is) FATAL: could not resolve volume path for $VOLUME_NAME" >&2; exit 1; }

[ -f "${VOLUME_PATH}/catalyst.db" ] || { echo "$(date -Is) FATAL: DB file not found at ${VOLUME_PATH}/catalyst.db" >&2; exit 1; }

# Pre-backup integrity check on source DB.
# If source already corrupt — fail without overwriting yesterday's good backup.
INTEGRITY=$(sqlite3 "${VOLUME_PATH}/catalyst.db" "PRAGMA integrity_check;")
if [ "$INTEGRITY" != "ok" ]; then
  echo "$(date -Is) FATAL: source DB integrity_check failed: $INTEGRITY" >&2
  exit 1
fi

# Hot backup using sqlite3 on host (locking-aware; safe even while app writes)
sqlite3 "${VOLUME_PATH}/catalyst.db" ".backup '${BACKUP_DIR}/catalyst_${DATE}.db'"

# Sanity: .backup can silently exit 0 with empty/missing dest in some failure modes
BACKUP_SIZE=$(stat -c%s "${BACKUP_DIR}/catalyst_${DATE}.db" 2>/dev/null || echo 0)
if [ "$BACKUP_SIZE" -lt 4096 ]; then
  echo "$(date -Is) FATAL: backup file missing or suspiciously small ($BACKUP_SIZE bytes)" >&2
  rm -f "${BACKUP_DIR}/catalyst_${DATE}.db"
  exit 1
fi

# Compress + verify gzip integrity. Если архив битый — удалить и упасть.
gzip "${BACKUP_DIR}/catalyst_${DATE}.db"
gzip -t "${BACKUP_DIR}/catalyst_${DATE}.db.gz" || {
  echo "$(date -Is) FATAL: gzip integrity check failed for ${BACKUP_DIR}/catalyst_${DATE}.db.gz" >&2
  rm -f "${BACKUP_DIR}/catalyst_${DATE}.db.gz"
  exit 1
}

# Local retention: keep 14 days
find "$BACKUP_DIR" -name 'catalyst_*.db.gz' -mtime +14 -delete

# Off-site copy to Backblaze B2 (B2 lifecycle rule handles its own retention: 30d hide + 1d delete)
BACKUP_FILE="${BACKUP_DIR}/catalyst_${DATE}.db.gz"
rclone copy "$BACKUP_FILE" b2:catalyst-prod-backups/ --log-level INFO >> /var/log/catalyst-backup-rclone.log 2>&1

SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "$(date -Is) backup OK: catalyst_${DATE}.db.gz ($SIZE)"
