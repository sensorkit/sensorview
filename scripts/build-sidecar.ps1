# Build the FastAPI sidecar into a single-file binary for Windows (x64) and
# place it under resources/ where electron-builder's extraResources picks it
# up for packaging. Also fetches and unpacks MediaMTX alongside.
#
# Usage (from PowerShell, normal or elevated — no Git Bash required):
#   .\scripts\build-sidecar.ps1
#
# Linux/macOS use scripts/build-sidecar.sh instead.

$ErrorActionPreference = "Stop"

$Root   = Resolve-Path (Join-Path $PSScriptRoot "..")
$ApiDir = Join-Path $Root "api"
$OutDir = Join-Path $Root "resources"
$Triple = "x86_64-pc-windows-msvc"
$Ext    = ".exe"

if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

Write-Host ">>> Building sidecar for $Triple" -ForegroundColor Cyan

Push-Location $ApiDir
try {
    # --- Python deps + PyInstaller bundle ---
    & uv sync --dev
    if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }

    & uv run pyinstaller `
        --clean --noconfirm --onefile `
        --name sensorview-api `
        --paths . `
        --add-data "routers;routers" `
        --add-data "services;services" `
        --add-data "data;data" `
        --collect-submodules uvicorn `
        --collect-submodules fastapi `
        --hidden-import aiosqlite `
        --hidden-import uvicorn.logging `
        --hidden-import uvicorn.loops.auto `
        --hidden-import uvicorn.protocols.http.auto `
        --hidden-import uvicorn.protocols.http.h11_impl `
        --hidden-import uvicorn.protocols.websockets.auto `
        --hidden-import uvicorn.lifespan.on `
        --distpath dist `
        --workpath build `
        main.py
    if ($LASTEXITCODE -ne 0) { throw "pyinstaller failed" }
}
finally {
    Pop-Location
}

$SidecarSrc  = Join-Path $ApiDir "dist\sensorview-api$Ext"
$SidecarDest = Join-Path $OutDir "sensorview-api-$Triple$Ext"
Copy-Item -Path $SidecarSrc -Destination $SidecarDest -Force
Write-Host ">>> Sidecar: $SidecarDest" -ForegroundColor Green


# --- MediaMTX (RTSP→HLS proxy) ----------------------------------------------
# Pre-built single binary fetched from upstream releases. Pinned by version +
# SHA256. Keep in sync with scripts/build-sidecar.sh.
$MediamtxVersion = "v1.18.1"
$MtxAsset        = "mediamtx_${MediamtxVersion}_windows_amd64.zip"
$MtxSha          = "7f06a10fe43d0d1d698d1cc2655def6d4a66be6db2f3e7910c0b8c9c60052a36"
$MtxUrl          = "https://github.com/bluenviron/mediamtx/releases/download/$MediamtxVersion/$MtxAsset"
$MtxTmp          = Join-Path $ApiDir "build\mediamtx-download"

if (Test-Path $MtxTmp) {
    Remove-Item -Recurse -Force $MtxTmp
}
New-Item -ItemType Directory -Force -Path $MtxTmp | Out-Null

$MtxArchive = Join-Path $MtxTmp $MtxAsset
Write-Host ">>> Fetching MediaMTX $MediamtxVersion ($MtxAsset)" -ForegroundColor Cyan

# Invoke-WebRequest sidesteps the Defender-vs-curl write-mid-download
# interference that hits this exact archive (curl error 23). PowerShell's
# transfer flows through .NET's HTTP stack which AV treats less aggressively.
$ProgressPreference = "SilentlyContinue"  # progress bar slows Invoke-WebRequest dramatically
Invoke-WebRequest -Uri $MtxUrl -OutFile $MtxArchive

# Verify SHA256 against the pinned hash.
$actualHash = (Get-FileHash -Path $MtxArchive -Algorithm SHA256).Hash.ToLower()
if ($actualHash -ne $MtxSha) {
    throw "MediaMTX SHA256 mismatch: expected $MtxSha, got $actualHash"
}

Expand-Archive -Path $MtxArchive -DestinationPath $MtxTmp -Force

# Windows .zip places mediamtx.exe in a versioned subdirectory. Find it
# wherever it landed so changes upstream don't break this.
$mtxExe = Get-ChildItem -Recurse -Path $MtxTmp -Filter "mediamtx.exe" | Select-Object -First 1
if (-not $mtxExe) {
    throw "mediamtx.exe not found after extraction under $MtxTmp"
}

$MtxDest = Join-Path $OutDir "mediamtx-$Triple$Ext"
Copy-Item -Path $mtxExe.FullName -Destination $MtxDest -Force
Write-Host ">>> MediaMTX: $MtxDest" -ForegroundColor Green
