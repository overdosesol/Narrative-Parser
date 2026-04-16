param(
    [string]$Server = "root@<server-ip>",
    [string]$RemoteDir = "/opt/trendscout"
)

$ErrorActionPreference = "Stop"

$LOCAL_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$TEMP_ZIP  = Join-Path $env:TEMP "trendscout_deploy.zip"
$TEMP_DIR  = Join-Path $env:TEMP "trendscout_temp"

Write-Host ""
Write-Host "TrendScout Docker Deploy -> $Server" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: ssh not found." -ForegroundColor Red
    exit 1
}

Write-Host "[1/4] Building archive..." -ForegroundColor Yellow

if (Test-Path $TEMP_DIR) { Remove-Item $TEMP_DIR -Recurse -Force }
New-Item -ItemType Directory -Path $TEMP_DIR | Out-Null

$EXCLUDE = @("node_modules", "data", "logs", ".git", ".env")

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
Write-Host "[2/4] Uploading archive..." -ForegroundColor Yellow
scp -o StrictHostKeyChecking=no $TEMP_ZIP "${Server}:/tmp/trendscout.zip"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: scp failed." -ForegroundColor Red
    exit 1
}
Write-Host "   Upload OK" -ForegroundColor Green

$ENV_FILE = Join-Path $LOCAL_DIR ".env"
if (Test-Path $ENV_FILE) {
    Write-Host ""
    Write-Host "[3/4] Uploading .env..." -ForegroundColor Yellow
    scp -o StrictHostKeyChecking=no $ENV_FILE "${Server}:/tmp/trendscout.env"
    Write-Host "   .env OK" -ForegroundColor Green
} else {
    Write-Host "[3/4] .env not found locally, keeping server .env" -ForegroundColor Yellow
}

$SETUP_FILE = Join-Path $LOCAL_DIR "setup_remote.sh"
Write-Host ""
Write-Host "[4/4] Running remote Docker setup..." -ForegroundColor Yellow
scp -o StrictHostKeyChecking=no $SETUP_FILE "${Server}:/tmp/trendscout_setup.sh"

ssh -o StrictHostKeyChecking=no $Server "mkdir -p '$RemoteDir'"

$success = $false
ssh -o StrictHostKeyChecking=no $Server "REMOTE_DIR='$RemoteDir' bash /tmp/trendscout_setup.sh 2>&1" | Tee-Object -Variable lines | ForEach-Object {
    Write-Host $_
    if ($_ -match "DEPLOY_SUCCESS") { $success = $true }
}

Remove-Item $TEMP_ZIP -Force -ErrorAction SilentlyContinue

if ($success) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  OK - TrendScout deployed (Docker)!" -ForegroundColor Green
    Write-Host "  Dashboard: http://<server-ip>:8080" -ForegroundColor Cyan
    Write-Host "  Admin:     localhost-only on server (127.0.0.1:8081)" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "ERROR: Deploy failed. See output above." -ForegroundColor Red
}
