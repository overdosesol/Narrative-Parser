param(
    [string]$Server = "root@<server-ip>",
    [string]$RemoteDir = "/opt/catalyst"
)

$ErrorActionPreference = "Stop"

$LOCAL_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$TEMP_ZIP  = Join-Path $env:TEMP "catalyst_deploy.zip"
$TEMP_DIR  = Join-Path $env:TEMP "catalyst_temp"

Write-Host ""
Write-Host "Catalyst Docker Deploy -> $Server" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: ssh not found." -ForegroundColor Red
    exit 1
}

Write-Host "[1/5] Validating SPA syntax..." -ForegroundColor Yellow
npm run check:spa
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: SPA validation failed. Fix syntax issues before deploying." -ForegroundColor Red
    exit 1
}
Write-Host "   SPA OK" -ForegroundColor Green
Write-Host ""
Write-Host "[2/5] Building archive..." -ForegroundColor Yellow

if (Test-Path $TEMP_DIR) { Remove-Item $TEMP_DIR -Recurse -Force }
New-Item -ItemType Directory -Path $TEMP_DIR | Out-Null

# EvilCatPack: source PNG frames for sprite-sheet building (R6/R7 cat-mascot).
# We build assets/cats/*.png from these locally via scripts/build-cat-poses.py,
# but the raw frames themselves are not used in production — keep them off the
# deploy archive (~1.1 MB) so the upload stays small.
$EXCLUDE = @("node_modules", "data", "logs", ".git", ".env", ".claude", "posts", "ai-context", "EvilCatPack")

foreach ($item in Get-ChildItem -Path $LOCAL_DIR) {
    if ($EXCLUDE -notcontains $item.Name) {
        if ($item.PSIsContainer) {
            Copy-Item $item.FullName -Destination (Join-Path $TEMP_DIR $item.Name) -Recurse
        } else {
            Copy-Item $item.FullName -Destination $TEMP_DIR
        }
    }
}

if (Test-Path $TEMP_ZIP) { Remove-Item $TEMP_ZIP -Force }
Compress-Archive -Path "$TEMP_DIR\*" -DestinationPath $TEMP_ZIP
Remove-Item $TEMP_DIR -Recurse -Force
Write-Host "   Archive OK" -ForegroundColor Green

Write-Host ""
Write-Host "[3/5] Uploading archive..." -ForegroundColor Yellow
# ServerAliveInterval/CountMax keep the SSH channel breathing during the upload
# so a slow link or NAT idle-timeout doesn't drop us mid-transfer.
scp -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 $TEMP_ZIP "${Server}:/tmp/catalyst.zip"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: scp failed." -ForegroundColor Red
    exit 1
}
Write-Host "   Upload OK" -ForegroundColor Green

$ENV_FILE = Join-Path $LOCAL_DIR ".env"
if (Test-Path $ENV_FILE) {
    Write-Host ""
    Write-Host "[4/5] Uploading .env..." -ForegroundColor Yellow
    scp -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 $ENV_FILE "${Server}:/tmp/catalyst.env"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: .env upload failed." -ForegroundColor Red
        exit 1
    }
    Write-Host "   .env OK" -ForegroundColor Green
} else {
    Write-Host "[4/5] .env not found locally, keeping server .env" -ForegroundColor Yellow
}

$SETUP_FILE = Join-Path $LOCAL_DIR "setup_remote.sh"
Write-Host ""
Write-Host "[5/5] Running remote Docker setup..." -ForegroundColor Yellow
scp -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 $SETUP_FILE "${Server}:/tmp/catalyst_setup.sh"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: setup script upload failed." -ForegroundColor Red
    exit 1
}

# === Sync production backup script (single source of truth: scripts/catalyst-backup.sh) ===
Write-Host "Syncing catalyst-backup.sh to VPS..."
$BACKUP_SCRIPT = Join-Path $LOCAL_DIR "scripts\catalyst-backup.sh"
scp -o StrictHostKeyChecking=no $BACKUP_SCRIPT "${Server}:/usr/local/bin/catalyst-backup.sh"
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: failed to scp catalyst-backup.sh" -ForegroundColor Red; exit 1 }
ssh -o StrictHostKeyChecking=no $Server "chmod +x /usr/local/bin/catalyst-backup.sh"
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: failed to chmod catalyst-backup.sh" -ForegroundColor Red; exit 1 }
Write-Host "Backup script synced." -ForegroundColor Green
# === End backup sync ===

# Single SSH session for mkdir + setup — avoids hitting SSH MaxSessions/
# MaxStartups when the previous deploy left lingering connections, and keeps
# the auth handshake count down on small VPS where re-auth is expensive.
$success = $false
$remoteCmd = "mkdir -p '$RemoteDir' && REMOTE_DIR='$RemoteDir' bash /tmp/catalyst_setup.sh 2>&1"
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 $Server $remoteCmd | Tee-Object -Variable lines | ForEach-Object {
    Write-Host $_
    if ($_ -match "DEPLOY_SUCCESS") { $success = $true }
}

Remove-Item $TEMP_ZIP -Force -ErrorAction SilentlyContinue

if ($success) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  OK - Catalyst deployed (Docker)!" -ForegroundColor Green
    Write-Host "  Dashboard: http://<server-ip>:8080" -ForegroundColor Cyan
    Write-Host "  Admin:     localhost-only on server (127.0.0.1:8081)" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "ERROR: Deploy failed. See output above." -ForegroundColor Red
}
