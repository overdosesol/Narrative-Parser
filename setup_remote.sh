#!/bin/bash
set -e

REMOTE_DIR="${REMOTE_DIR:-/opt/trendscout}"

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
unzip -o /tmp/trendscout.zip -d "$REMOTE_DIR" >/dev/null
UNZIP_EXIT=$?
set -e
if [ "$UNZIP_EXIT" -gt 1 ]; then
  echo "ERROR: unzip failed with code $UNZIP_EXIT"
  exit "$UNZIP_EXIT"
fi
echo "Files extracted"

if [ -f /tmp/trendscout.env ]; then
  cp /tmp/trendscout.env "$REMOTE_DIR/.env"
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
  pm2 delete trendscout >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
fi

$DC down || true
$DC build
$DC up -d

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

rm -f /tmp/trendscout.zip /tmp/trendscout.env /tmp/trendscout_setup.sh

echo ""
echo "DEPLOY_SUCCESS"
