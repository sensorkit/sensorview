# Installing SensorView

Pre-release builds are unsigned — your OS will warn on first launch. One-time
click-through on each platform, after which it's trusted.

Artifact names follow `SensorView-<version>-<os>-<arch>.<ext>`, e.g.
`SensorView-0.1.0-win-x64.exe`.

## Windows

1. Download `SensorView-<version>-win-x64.exe` from the GitHub Release page.
2. Double-click it. SmartScreen will show **"Windows protected your PC"**.
3. Click **More info** → **Run anyway**.
4. Follow the installer prompts; you can pick the install location.
5. Launch from the Start menu. SmartScreen will **not** prompt again.

## macOS

1. Download `SensorView-<version>-mac-arm64.dmg` (Apple Silicon) or the
   `-mac-x64.dmg` (Intel) from the Release page.
2. Open the DMG, drag **SensorView.app** to Applications.
3. **Right-click SensorView.app in Applications → Open**. Gatekeeper shows
   "cannot verify developer" — click **Open**.
4. After the first launch, double-click works normally.

If step 3 is blocked entirely, run once:

```bash
xattr -cr /Applications/SensorView.app
```

## Linux

### AppImage (any distro)

```bash
chmod +x SensorView-<version>-linux-x86_64.AppImage
./SensorView-<version>-linux-x86_64.AppImage
```

**Double-click won't work until you chmod** — Ubuntu's default file
handler shows *"Could Not Display … There is no application installed
for 'AppImage application bundle' files"*. That's because GNOME can't
run a non-executable file; it's not actually missing a handler.

From the Files GUI: right-click the `.AppImage` → **Properties** →
**Permissions** → check **"Allow executing as program"** → double-click.

**If running fails with a FUSE error** (common on fresh Ubuntu 22.04+),
install the missing userspace FS library:

```bash
sudo apt install libfuse2          # Ubuntu 22.04
sudo apt install libfuse2t64       # Ubuntu 24.04+
```

**Optional:** install [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher)
to auto-chmod and register a proper handler system-wide.

### `.deb` (Ubuntu/Debian)

```bash
sudo dpkg -i sensorview_<version>_amd64.deb
```

## SensorKit connection

On first run, open **Settings → SensorKit Connection** and set the SensorKit
base URL (default `http://localhost:8000`). The SensorView API runs as a
bundled sidecar — no separate install. Settings persist across launches.

## Uninstalling

- **Windows**: Settings → Apps → SensorView → Uninstall
- **macOS**: drag SensorView.app to Trash, remove `~/Library/Application Support/SensorView/`
- **Linux**: `sudo apt remove sensorview` (or delete the AppImage)
