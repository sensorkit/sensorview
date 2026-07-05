# Building SensorView from source

This builds the same artifacts the GitHub Actions release workflow does
(`.AppImage` + `.deb` on Linux, `.exe` on Windows, `.dmg` on macOS), on
whatever machine you run it on. PyInstaller can't cross-compile, so you
need one machine per target OS.

Output lands in `release/`.

`scripts/build-sidecar.sh` produces two binaries under `resources/`: the
PyInstaller-bundled FastAPI sidecar (`sensorview-api-<triple>`), and the
MediaMTX RTSP→HLS proxy (`mediamtx-<triple>`) which is downloaded from the
upstream GitHub release with a pinned SHA256. Both ride along with the
Electron app at packaging time and are spawned at app start.

## Prerequisites (all platforms)

- **Node.js 22** — [nodejs.org](https://nodejs.org/) or via nvm.
- **Python 3.11** — any distribution.
- **uv** (Python package manager) — `pip install uv`, or platform-native
  installer from [astral.sh/uv](https://docs.astral.sh/uv/).
- **git**.

Clone once:

```
git clone https://github.com/sensorkit/sensorview.git
cd sensorview
```

## Windows — `.exe`

PowerShell only. No Git Bash, no WSL.

1. Install Node 22, Python 3.11, and uv (above).
2. In PowerShell at the repo root, run:

   ```powershell
   # Drop the lockfile — it was generated on a different platform and npm
   # will skip the Windows-specific @rollup optional dep if you keep it.
   Remove-Item -ErrorAction SilentlyContinue package-lock.json
   npm install --no-audit --no-fund

   # Build the Python sidecar + fetch MediaMTX, both as Windows binaries
   # into resources/. Uses Invoke-WebRequest + Expand-Archive natively —
   # no Git Bash, no unzip, no curl.
   .\scripts\build-sidecar.ps1

   # Build the Electron app. --publish never keeps it local.
   npm run electron:build -- --win --publish never
   ```

3. Output: `release\SensorView-<version>-win-x64.exe`.

**Gotchas**

- The `.exe` is unsigned — SmartScreen will warn on first launch.
- `npm run electron:build` extracts `winCodeSign-2.6.0.7z`, which
  contains macOS `.dylib` symlinks. Symlink creation on Windows needs
  either an elevated PowerShell or Developer Mode (Settings → Privacy &
  security → For developers → Developer Mode). Without one of those,
  the build fails with "A required privilege is not held by the
  client". Developer Mode is the persistent fix.
- Windows Defender may flag the unsigned PyInstaller-bundled sidecar
  during the build's MediaMTX fetch (curl error 23). The PowerShell
  builder bypasses curl entirely and uses Invoke-WebRequest, which
  Defender treats less aggressively. If you still see AV interference,
  add a one-time Defender exclusion for the repo:
  `Add-MpPreference -ExclusionPath "C:\path\to\sensorview"`.

## macOS — `.dmg`

Apple Silicon (arm64) builds produce `-mac-arm64.dmg`; Intel produces
`-mac-x64.dmg`. PyInstaller only targets the host arch, so each arch
needs its own build.

```bash
npm install --no-audit --no-fund
cd api && uv sync --dev && cd ..
bash scripts/build-sidecar.sh
npm run electron:build -- --mac --publish never
```

Output: `release/SensorView-<version>-mac-<arch>.dmg`.

**Gotchas**

- The `.dmg` is unsigned and unnotarized — Gatekeeper will block double-
  click. First launch needs right-click → Open (see `INSTALL.md`).
- If electron-builder complains about missing `python3`, check that
  `which python3` points at 3.11.x in your current shell.

## Linux — `.AppImage` + `.deb`

Tested on Ubuntu 22.04; any modern distro with glibc 2.31+ should work.

```bash
# System deps for electron-builder's deb packager.
sudo apt-get update
sudo apt-get install -y libnotify-bin rpm

npm install --no-audit --no-fund
cd api && uv sync --dev && cd ..
bash scripts/build-sidecar.sh
npm run electron:build -- --linux --publish never
```

Output:
- `release/SensorView-<version>-linux-x86_64.AppImage`
- `release/SensorView-<version>-linux-amd64.deb`

**Gotchas**

- AppImage needs `chmod +x` before it will run — see `INSTALL.md`.

## Troubleshooting

**`npm install` fails with a semver error involving `cookie` or
`engine.io`.** The js9 dep pulls an older engine.io → cookie chain. Use
`npm install` (not `npm ci`), which tolerates the mismatch.

**`electron-builder` errors with `application icon is not set`.** Not
fatal — the default Electron icon is used. Ignore unless you're shipping
a branded release.

**Sidecar binary not found at packaging time.** The Electron app looks
for `resources/sensorview-api-<triple>[.exe]`. The triple must match the
host platform exactly:
- `x86_64-unknown-linux-gnu`
- `x86_64-pc-windows-msvc`
- `aarch64-apple-darwin` (or `x86_64-apple-darwin` for Intel Macs)

Re-run `scripts/build-sidecar.sh`; it writes the file and logs the path.

**CI storage quota errors.** The release workflow uses
`actions/upload-artifact` as a relay before publishing the Release, which
consumes GitHub's shared-storage quota (separate from Actions minutes).
If that's exhausted, build locally per this file — the artifacts are the
same either way.

## What the CI runs

See `.github/workflows/release.yml`. The build steps it runs for each
platform are a superset of what's above — identical npm/uv/PyInstaller
commands, with `actions/setup-node`, `actions/setup-python`, and
`astral-sh/setup-uv` replacing the local tool installation.
