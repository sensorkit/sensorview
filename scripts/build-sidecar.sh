#!/usr/bin/env bash
#
# Build the FastAPI sidecar into a single-file binary for the current host
# platform and place it under resources/ where electron-builder's
# extraResources picks it up for packaging.
#
# Usage:
#   bash scripts/build-sidecar.sh             # detects host triple
#   TARGET=x86_64-pc-windows-msvc bash scripts/build-sidecar.sh  # labels only
#
# Runs from $ROOT/api using relative paths throughout. Absolute paths break
# under Git Bash on Windows because MSYS auto-converts `/d/a/...` into
# `\d\a\...` (stripping the drive letter) when passing args to Python.

set -euo pipefail

# Prevent Git Bash from transforming bash-style paths in command-line args.
export MSYS2_ARG_CONV_EXCL="*"
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/api"

# --- Triple for the output filename ---
if [[ -n "${TARGET:-}" ]]; then
  TRIPLE="$TARGET"
else
  HOST_OS="$(uname -s)"
  HOST_ARCH="$(uname -m)"
  case "$HOST_OS" in
    Linux)
      TRIPLE="${HOST_ARCH}-unknown-linux-gnu"
      ;;
    Darwin)
      case "$HOST_ARCH" in
        arm64) TRIPLE="aarch64-apple-darwin" ;;
        x86_64) TRIPLE="x86_64-apple-darwin" ;;
        *) TRIPLE="${HOST_ARCH}-apple-darwin" ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*)
      TRIPLE="x86_64-pc-windows-msvc"
      ;;
    *)
      echo "error: unsupported host $HOST_OS"; exit 1 ;;
  esac
fi

OUT_DIR="$ROOT/resources"
mkdir -p "$OUT_DIR"

echo ">>> Building sidecar for $TRIPLE"

uv sync --dev

DATA_SEP=":"
if [[ "$TRIPLE" == *"windows"* ]]; then DATA_SEP=";"; fi

# Run from the api/ directory so all paths passed to PyInstaller are
# relative. PyInstaller handles relative paths cross-platform; absolute
# POSIX paths get mangled by MSYS on Windows (see header comment).
uv run pyinstaller \
  --clean --noconfirm --onefile \
  --name sensorview-api \
  --paths . \
  --add-data "routers${DATA_SEP}routers" \
  --add-data "services${DATA_SEP}services" \
  --add-data "data${DATA_SEP}data" \
  --collect-submodules uvicorn \
  --collect-submodules fastapi \
  --hidden-import aiosqlite \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.http.h11_impl \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  --distpath dist \
  --workpath build \
  main.py

EXT=""
if [[ "$TRIPLE" == *"windows"* ]]; then EXT=".exe"; fi
SRC="$ROOT/api/dist/sensorview-api${EXT}"
DEST="$OUT_DIR/sensorview-api-${TRIPLE}${EXT}"

cp "$SRC" "$DEST"
chmod +x "$DEST"

echo ">>> Sidecar: $DEST"

# --- MediaMTX (RTSP→HLS proxy) ---------------------------------------------
# Pre-built single binary fetched from upstream releases. Pinned by version +
# SHA256. Bump MEDIAMTX_VERSION and refresh the per-asset hashes below from
# https://github.com/bluenviron/mediamtx/releases/<tag>/checksums.sha256.

MEDIAMTX_VERSION="v1.18.1"

case "$TRIPLE" in
  x86_64-apple-darwin)
    MTX_ASSET="mediamtx_${MEDIAMTX_VERSION}_darwin_amd64.tar.gz"
    MTX_SHA="1061f53870faf4ad85207f062e3ec364f93e8cb2cfa699d8a31b1f7d515b71e4"
    ;;
  aarch64-apple-darwin)
    MTX_ASSET="mediamtx_${MEDIAMTX_VERSION}_darwin_arm64.tar.gz"
    MTX_SHA="0f228aa175cf921b0ab3925d350cef5cfd084b97dbbe6525c87be35f1fe1b7e3"
    ;;
  x86_64-unknown-linux-gnu)
    MTX_ASSET="mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz"
    MTX_SHA="b02cc1940885d4f383329a832b97372558e987205c8fd8276f6626ae84428c04"
    ;;
  aarch64-unknown-linux-gnu)
    MTX_ASSET="mediamtx_${MEDIAMTX_VERSION}_linux_arm64.tar.gz"
    MTX_SHA="35fe022ac3aab2c26a97472d715798617b56bdfef6ed3e063e52603896971cf1"
    ;;
  x86_64-pc-windows-msvc)
    MTX_ASSET="mediamtx_${MEDIAMTX_VERSION}_windows_amd64.zip"
    MTX_SHA="7f06a10fe43d0d1d698d1cc2655def6d4a66be6db2f3e7910c0b8c9c60052a36"
    ;;
  *)
    echo "error: no MediaMTX asset mapping for triple: $TRIPLE"; exit 1 ;;
esac

MTX_URL="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/${MTX_ASSET}"
MTX_TMP="$ROOT/api/build/mediamtx-download"
rm -rf "$MTX_TMP"
mkdir -p "$MTX_TMP"

echo ">>> Fetching MediaMTX $MEDIAMTX_VERSION ($MTX_ASSET)"
curl -fsSL --retry 3 -o "$MTX_TMP/$MTX_ASSET" "$MTX_URL"

# Verify the SHA256 against the pinned hash. Use whichever tool the host has.
if command -v sha256sum >/dev/null 2>&1; then
  echo "$MTX_SHA  $MTX_TMP/$MTX_ASSET" | sha256sum -c -
elif command -v shasum >/dev/null 2>&1; then
  echo "$MTX_SHA  $MTX_TMP/$MTX_ASSET" | shasum -a 256 -c -
else
  echo "error: neither sha256sum nor shasum available"; exit 1
fi

# Extract just the mediamtx[.exe] binary (the archive also includes a default
# mediamtx.yml + LICENSE which we ignore — we ship our own config).
if [[ "$MTX_ASSET" == *.tar.gz ]]; then
  tar -xzf "$MTX_TMP/$MTX_ASSET" -C "$MTX_TMP"
elif [[ "$MTX_ASSET" == *.zip ]]; then
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$MTX_TMP/$MTX_ASSET" -d "$MTX_TMP"
  elif command -v powershell.exe >/dev/null 2>&1; then
    # Git Bash on Windows often ships without unzip. Fall back to
    # PowerShell's Expand-Archive, which every supported Windows has.
    # Convert MSYS-style paths to Windows so PowerShell can parse them.
    MTX_TMP_WIN="$(cygpath -w "$MTX_TMP")"
    MTX_ASSET_WIN="$(cygpath -w "$MTX_TMP/$MTX_ASSET")"
    powershell.exe -NoProfile -Command \
      "Expand-Archive -Path '$MTX_ASSET_WIN' -DestinationPath '$MTX_TMP_WIN' -Force"
  else
    echo "error: need unzip or PowerShell to extract Windows MediaMTX asset"; exit 1
  fi
fi

# The Windows .zip places mediamtx.exe in a versioned subdirectory; the Linux
# / macOS .tar.gz drop it at the archive root. Normalize by finding it
# wherever it landed.
if [[ ! -f "$MTX_TMP/mediamtx${EXT}" ]]; then
  found="$(find "$MTX_TMP" -name "mediamtx${EXT}" -type f | head -1)"
  if [[ -n "$found" ]]; then
    cp "$found" "$MTX_TMP/mediamtx${EXT}"
  fi
fi

MTX_SRC="$MTX_TMP/mediamtx${EXT}"
MTX_DEST="$OUT_DIR/mediamtx-${TRIPLE}${EXT}"
cp "$MTX_SRC" "$MTX_DEST"
chmod +x "$MTX_DEST"

echo ">>> MediaMTX: $MTX_DEST"
