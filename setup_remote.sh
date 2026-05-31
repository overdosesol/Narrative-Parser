#!/bin/bash
set -e

REMOTE_DIR="${REMOTE_DIR:-/opt/catalyst}"

echo ""
echo "=== Docker ==="
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  apt-get update -qq
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
else
  echo "Docker $(docker --version) already installed"
fi

echo ""
echo "=== Docker Compose ==="
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
  echo "Using docker compose plugin"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
  echo "Using docker-compose standalone"
else
  echo "Installing docker compose plugin..."
  apt-get update -qq
  apt-get install -y docker-compose-plugin
  DC="docker compose"
fi

echo ""
echo "=== Extracting project ==="
mkdir -p "$REMOTE_DIR"
set +e
unzip -o /tmp/catalyst.zip -d "$REMOTE_DIR" >/dev/null
UNZIP_EXIT=$?
set -e
if [ "$UNZIP_EXIT" -gt 1 ]; then
  echo "ERROR: unzip failed with code $UNZIP_EXIT"
  exit "$UNZIP_EXIT"
fi
echo "Files extracted"

if [ -f /tmp/catalyst.env ]; then
  cp /tmp/catalyst.env "$REMOTE_DIR/.env"
  chmod 600 "$REMOTE_DIR/.env"
  echo ".env copied"
fi

if [ ! -f "$REMOTE_DIR/.env" ]; then
  cp "$REMOTE_DIR/.env.example" "$REMOTE_DIR/.env"
  chmod 600 "$REMOTE_DIR/.env"
  echo ""
  echo "ERROR: .env was missing. Created from .env.example, please edit before deploy."
  echo ""
  exit 1
fi

echo ""
echo "=== Starting containers ==="
cd "$REMOTE_DIR"

if command -v pm2 >/dev/null 2>&1; then
  pm2 delete catalyst >/dev/null 2>&1 || true
  pm2 delete trendscout >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
fi

# Stop & remove any legacy containers that may still hold ports
echo "Stopping legacy containers..."
for c in trendscout-app trendscout catalyst-app catalyst; do
  docker stop "$c" 2>/dev/null || true
  docker rm   "$c" 2>/dev/null || true
done

# Stop current compose stack (handles catalyst-app and any other services)
$DC down || true
$DC build

# ── Grok CLI session ownership ────────────────────────────────────────────────
# The grokcli Stage-1 provider mounts the host's /root/.grok session into the
# container at /home/node/.grok. The container runs as uid 1000 (node) and the
# CLI needs READ+WRITE there (auth.json + locks/cache it rewrites). A fresh
# `grok login` or token-refresh leaves files owned by root → container loses
# access and grokcli silently falls back to the API. Re-assert uid 1000 on every
# deploy so the session survives rebuilds and DR restores. No-op if absent (the
# feature just stays unavailable, scoring uses an HTTP provider). An hourly cron
# (/etc/cron.d/grok-auth-perms) covers refreshes between deploys.
if [ -d /root/.grok ]; then
  chown -R 1000:1000 /root/.grok && echo "grok session chowned to uid 1000"
fi

$DC up -d

# ── Auto-cleanup: prune stale Docker build cache ──────────────────────────────
# Build cache piles up at ~70-100MB per deploy; left unchecked it filled the
# disk to 85% (we hit this 2026-04-27 — needed manual `buildx prune`). We only
# touch cache OLDER than 7 days, so recent layers stay around for incremental
# rebuilds. The active image (`catalyst-catalyst:latest`) and the live
# container are NEVER touched by this — buildx prune only operates on the
# build cache namespace. Failure is non-fatal (deploy already succeeded by now).
echo ""
echo "=== Pruning build cache older than 7d ==="
docker buildx prune -af --filter "until=168h" 2>&1 | tail -3 || true
# Hard guard: if disk is still >80% after prune, run aggressive cleanup that
# also removes dangling images. Active resources still safe.
DISK_USE=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
if [ -n "$DISK_USE" ] && [ "$DISK_USE" -gt 80 ]; then
  echo "Disk still ${DISK_USE}% used — running aggressive prune"
  docker system prune -af 2>&1 | tail -3 || true
fi

echo ""
echo "=== Status ==="
$DC ps

DASHBOARD_PORT=$(grep '^DASHBOARD_PORT=' "$REMOTE_DIR/.env" | tail -1 | cut -d '=' -f2)
if [ -z "$DASHBOARD_PORT" ]; then DASHBOARD_PORT=8080; fi

echo ""
echo "=== Health check ==="
if curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/api/health" >/dev/null; then
  echo "Health check passed"
else
  echo "Health check not ready yet (container may still be starting)"
fi

rm -f /tmp/catalyst.zip /tmp/catalyst.env /tmp/catalyst_setup.sh

echo ""
echo "DEPLOY_SUCCESS"
