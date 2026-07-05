import {
  app,
  BrowserWindow,
  Menu,
  desktopCapturer,
  ipcMain,
  session,
  shell,
} from "electron";
import windowStateKeeper from "electron-window-state";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? null;
const IS_DEV = !!DEV_SERVER_URL;
const PRELOAD = join(__dirname, "preload.cjs");
const APP_ICON = join(__dirname, "..", "dist", "logos", "sensorkit-logomark.png");

// macOS/Linux GUI-launched apps don't inherit the shell's PATH, so a packaged
// build may not find CLIs like `docker` (works under electron:dev because that's
// terminal-launched). Prepend the common install dirs once — no dependency, no
// config. Windows GUI apps inherit the system PATH, so skip it there.
(function ensureCliPath() {
  if (process.platform === "win32") return;
  const extra = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
  const cur = (process.env.PATH || "").split(":").filter(Boolean);
  for (const dir of extra) if (!cur.includes(dir)) cur.push(dir);
  process.env.PATH = cur.join(":");
})();

/** Children we spawn at app start and shut down at app quit. */
/** @type {import('child_process').ChildProcess[]} */
const childProcesses = [];

/** On-demand `docker logs -f` tails, keyed by container name. Each entry tracks
 *  its child, a pending reconnect timer, a stopped flag, the reconnect attempt
 *  count, and a `send` fn to the owning renderer. */
const dockerTails = new Map();

/** @type {number | null} */
let sidecarPort = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let popoutWindow = null;

// ---------- Resource path helpers ----------

function getHostTriple() {
  const triple = {
    linux:
      process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu",
    darwin: process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
    win32: "x86_64-pc-windows-msvc",
  }[process.platform];
  if (!triple) throw new Error(`unsupported platform: ${process.platform}`);
  return triple;
}

/** Resolve a file shipped under resources/ — packaged or dev tree. */
function resolveResource(name) {
  // electron-builder places extraResources under process.resourcesPath in a
  // packaged build; in dev we look under resources/ at the repo root.
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, name)]
    : [join(app.getAppPath(), "resources", name)];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`resource not found: ${name} (tried ${candidates.join(", ")})`);
}

function getSidecarBinaryPath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  return resolveResource(`sensorview-api-${getHostTriple()}${ext}`);
}

function getMediaMtxBinaryPath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  return resolveResource(`mediamtx-${getHostTriple()}${ext}`);
}

function getMediaMtxConfigPath() {
  return resolveResource("mediamtx.yml");
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("no free port"));
      }
    });
  });
}

// ---------- Spawn helpers ----------

/**
 * Start a long-running child process, plumb its output through console.log
 * with a name prefix, and register it for shutdown on app quit.
 * @param {string} name short identifier used in log prefix
 * @param {string} bin absolute path to the binary
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env] additional env vars merged with process.env
 */
function spawnSupervisedChild(name, bin, args, env) {
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(env ?? {}) },
  });
  // Children often emit several lines in a single chunk. Prefix each line
  // individually so logs stay readable when streams are interleaved.
  const prefixLines = (prefix) => (b) => {
    for (const line of b.toString().split(/\r?\n/)) {
      if (line.length > 0) console.log(`[${prefix}] ${line}`);
    }
  };
  child.stdout.on("data", prefixLines(name));
  child.stderr.on("data", prefixLines(`${name}:err`));
  child.on("exit", (code) => console.log(`[${name}] exited ${code}`));
  childProcesses.push(child);
  return child;
}

async function spawnSidecar() {
  const bin = getSidecarBinaryPath();
  const port = await pickFreePort();
  const cacheDir = app.getPath("userData");

  spawnSupervisedChild(
    "sidecar",
    bin,
    ["--port", String(port), "--host", "127.0.0.1", "--cache-dir", cacheDir],
    { TLE_CACHE_DB: join(cacheDir, "tle_cache.db") },
  );

  sidecarPort = port;
  return port;
}

function spawnMediaMtx() {
  const bin = getMediaMtxBinaryPath();
  const cfg = getMediaMtxConfigPath();
  spawnSupervisedChild("mediamtx", bin, [cfg]);
}

// ---------- Windows ----------

function createMainWindow() {
  const state = windowStateKeeper({
    defaultWidth: 1440,
    defaultHeight: 900,
    file: "main-window-state.json",
  });

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#06101c",
    title: "SensorView",
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  state.manage(mainWindow);

  // Route the renderer's getDisplayMedia() requests to the SensorView main
  // window automatically — no picker UI. This is what the in-app recorder
  // uses; without a handler set, getDisplayMedia would reject.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["window"] })
        .then((sources) => {
          const target =
            sources.find((s) => s.name === mainWindow?.getTitle()) ??
            sources[0];
          callback({ video: target });
        })
        .catch((err) => {
          console.error("getSources failed:", err);
          callback({});
        });
    },
    { useSystemPicker: false },
  );

  if (IS_DEV) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    if (sidecarPort && mainWindow) {
      mainWindow.webContents.send("sidecar-ready", { port: sidecarPort });
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function openSkyviewPopout() {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    return;
  }

  const state = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800,
    file: "popout-window-state.json",
  });

  popoutWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#06101c",
    title: "SensorView — SkyView",
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  state.manage(popoutWindow);

  const route = "#/popout/skyview"; // Works with BrowserRouter via initial path
  if (IS_DEV) {
    popoutWindow.loadURL(`${DEV_SERVER_URL}/popout/skyview`);
  } else {
    popoutWindow.loadFile(join(__dirname, "..", "dist", "index.html"), {
      hash: "/popout/skyview",
    });
  }

  popoutWindow.once("ready-to-show", () => {
    if (sidecarPort) {
      popoutWindow?.webContents.send("sidecar-ready", { port: sidecarPort });
    }
  });

  popoutWindow.on("closed", () => {
    popoutWindow = null;
  });
}

// ---------- Tab capture ----------

/**
 * Capture a PNG of the main window after navigating it to `route`. Renderer
 * acks `capture:ready` once react-router has settled and a couple of frames
 * have painted; we then take a webContents snapshot. Saved under
 * ~/Pictures/SensorView/<basename>-<timestamp>.png at native device-pixel
 * resolution (≈2× on Retina displays).
 */
async function captureTab(route, basename) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  // Ack handshake — renderer responds once layout has settled. Hard cap so a
  // wedged renderer can't hang the menu action indefinitely.
  const ready = new Promise((resolve) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener("capture:ready", onReady);
      resolve();
    }, 1500);
    ipcMain.once("capture:ready", onReady);
  });

  mainWindow.webContents.send("capture:goto", { route });
  await ready;
  // Extra settle for any async data fetches kicked off by the new route.
  await new Promise((r) => setTimeout(r, 250));

  const image = await mainWindow.webContents.capturePage();
  const buf = image.toPNG();

  const dir = join(app.getPath("pictures"), "SensorView");
  await mkdir(dir, { recursive: true });

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19)
    .replace("T", "_");
  const filepath = join(dir, `${basename}-${ts}.png`);
  await writeFile(filepath, buf);
  return filepath;
}

async function captureTabAndReveal(route, basename) {
  try {
    const filepath = await captureTab(route, basename);
    if (filepath) shell.showItemInFolder(filepath);
  } catch (err) {
    console.error("capture failed:", err);
  }
}

async function captureAllTabs() {
  const tabs = [
    { route: "/", basename: "skyview" },
    { route: "/devices", basename: "devices" },
    { route: "/tasks", basename: "tasks" },
    { route: "/images", basename: "images" },
    { route: "/status", basename: "status" },
    { route: "/streams", basename: "streams" },
    { route: "/settings", basename: "settings" },
  ];
  let last = null;
  for (const { route, basename } of tabs) {
    try {
      last = await captureTab(route, basename);
    } catch (err) {
      console.error(`capture failed for ${basename}:`, err);
    }
  }
  if (last) shell.showItemInFolder(last);
}

// ---------- Window recording ----------

/** @type {{ filepath: string, stream: import('node:fs').WriteStream } | null} */
let activeRecording = null;

async function startRecording() {
  if (activeRecording || !mainWindow || mainWindow.isDestroyed()) return;

  const dir = join(app.getPath("videos"), "SensorView");
  await mkdir(dir, { recursive: true });
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19)
    .replace("T", "_");
  const filepath = join(dir, `recording-${ts}.webm`);
  const stream = createWriteStream(filepath);
  activeRecording = { filepath, stream };

  // Tell the renderer to begin recording. The renderer calls getDisplayMedia,
  // wires up MediaRecorder, and streams chunks back via `record:chunk`.
  mainWindow.webContents.send("record:start");
  buildMenu();
}

function stopRecording() {
  if (!activeRecording || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("record:stop");
  // Don't tear down the write stream yet — wait for `record:done` so the
  // final chunks land first.
}

ipcMain.on("record:chunk", (_e, buf) => {
  if (!activeRecording) return;
  // `buf` arrives as a Node Buffer (structured-clone of ArrayBuffer).
  activeRecording.stream.write(Buffer.from(buf));
});

ipcMain.on("record:done", () => {
  if (!activeRecording) return;
  const { filepath, stream } = activeRecording;
  activeRecording = null;
  stream.end(() => {
    shell.showItemInFolder(filepath);
  });
  buildMenu();
});

ipcMain.on("record:error", async (_e, message) => {
  console.error("recording failed in renderer:", message);
  if (!activeRecording) return;
  const { filepath, stream } = activeRecording;
  activeRecording = null;
  stream.end();
  // Best-effort cleanup of the empty/partial file so we don't leave junk.
  try {
    await unlink(filepath);
  } catch {
    /* file may not exist yet */
  }
  buildMenu();
});

// ---------- Menu ----------

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Capture",
          submenu: [
            {
              label: "SkyView",
              accelerator: "CmdOrCtrl+Shift+1",
              click: () => captureTabAndReveal("/", "skyview"),
            },
            {
              label: "Devices",
              accelerator: "CmdOrCtrl+Shift+2",
              click: () => captureTabAndReveal("/devices", "devices"),
            },
            {
              label: "Tasks",
              accelerator: "CmdOrCtrl+Shift+3",
              click: () => captureTabAndReveal("/tasks", "tasks"),
            },
            {
              label: "Images",
              accelerator: "CmdOrCtrl+Shift+4",
              click: () => captureTabAndReveal("/images", "images"),
            },
            {
              label: "Status",
              accelerator: "CmdOrCtrl+Shift+5",
              click: () => captureTabAndReveal("/status", "status"),
            },
            {
              label: "Streams",
              accelerator: "CmdOrCtrl+Shift+6",
              click: () => captureTabAndReveal("/streams", "streams"),
            },
            {
              label: "Settings",
              accelerator: "CmdOrCtrl+Shift+7",
              click: () => captureTabAndReveal("/settings", "settings"),
            },
            { type: "separator" },
            {
              label: "All",
              accelerator: "CmdOrCtrl+Shift+0",
              click: () => captureAllTabs(),
            },
          ],
        },
        {
          label: activeRecording ? "Stop Recording" : "Start Recording",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => (activeRecording ? stopRecording() : startRecording()),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        {
          label: "Pop out SkyView",
          accelerator: "CmdOrCtrl+Shift+O",
          click: openSkyviewPopout,
        },
        { type: "separator" },
        { role: "minimize" },
        { role: "close" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Docker service logs ----------

/**
 * Run `docker ps` and parse the running containers. Resolves to
 * `{ services }` or `{ error }` — never rejects, so the renderer can show the
 * reason (docker missing, daemon down) inline.
 */
function listDockerServices() {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn("docker", ["ps", "--no-trunc", "--format", "{{json .}}"]);
    } catch (e) {
      resolve({ error: String(e?.message ?? e) });
      return;
    }
    child.on("error", (e) =>
      resolve({
        error: e.code === "ENOENT" ? "docker not found on PATH" : String(e.message ?? e),
      }),
    );
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ error: err.trim() || `docker ps exited ${code}` });
        return;
      }
      const services = [];
      for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          services.push({
            id: o.ID,
            name: o.Names,
            image: o.Image,
            state: o.State ?? o.Status ?? "",
          });
        } catch {
          // skip malformed line
        }
      }
      resolve({ services });
    });
  });
}

const RECONNECT_DELAY_MS = 2000;
const RECONNECT_MAX = 30; // ~1 min of retries (covers a container recreate) before giving up

/**
 * Spawn `docker logs -f` for a tail entry, and auto-reconnect if it dies while
 * still wanted. Containers get recreated (e.g. compose restart) and the stream
 * we attached to ends — without this the panel silently freezes on the last
 * pre-restart line. A live stream resets the reconnect budget.
 */
function spawnTail(entry, container, tailN) {
  let child;
  try {
    child = spawn("docker", ["logs", "-f", "--tail", String(tailN), container]);
  } catch (e) {
    entry.send(`[docker logs error] ${e.message ?? e}\n`);
    return;
  }
  entry.child = child;
  const onData = (d) => {
    entry.attempts = 0;
    entry.send(d.toString());
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => entry.send(`[docker logs error] ${e.message ?? e}\n`));
  child.on("close", () => {
    if (entry.stopped) return; // stopped by the user
    if (entry.attempts >= RECONNECT_MAX) {
      entry.send(`\u001b[33m[stopped tailing ${container} — reselect to retry]\u001b[0m\n`);
      dockerTails.delete(container);
      return;
    }
    entry.attempts += 1;
    entry.send(`\u001b[33m[reconnecting to ${container}…]\u001b[0m\n`);
    entry.timer = setTimeout(() => {
      if (!entry.stopped) spawnTail(entry, container, 20);
    }, RECONNECT_DELAY_MS);
  });
}

function stopDockerTail(container) {
  const entry = dockerTails.get(container);
  if (!entry) return;
  dockerTails.delete(container);
  entry.stopped = true;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.child && !entry.child.killed) entry.child.kill("SIGTERM");
}

// ---------- IPC ----------

ipcMain.handle("sidecar:port", () => sidecarPort);
ipcMain.handle("popout:open", () => openSkyviewPopout());
ipcMain.on("shell:open-external", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle("docker:list", () => listDockerServices());

ipcMain.handle("docker:log-start", async (event, payload) => {
  const container = payload?.container;
  if (typeof container !== "string" || !container) return { error: "no container specified" };

  // Validate against the live list before spawning. We already avoid the shell
  // (args array), but only tailing a container docker itself reports keeps this
  // from being a way to run arbitrary `docker logs` arguments.
  const list = await listDockerServices();
  if (list.error) return { error: list.error };
  if (!list.services.some((s) => s.name === container || s.id === container)) {
    return { error: `unknown container: ${container}` };
  }

  stopDockerTail(container); // restart if already tailing
  // No --timestamps: services (SensorKit et al.) already log their own timestamp.
  const sender = event.sender;
  const entry = {
    child: null,
    timer: null,
    stopped: false,
    attempts: 0,
    // `docker logs` splits container stdout/stderr across both pipes; both flow here.
    send: (text) => {
      if (sender && !sender.isDestroyed()) sender.send("docker:log-chunk", { container, text });
    },
  };
  dockerTails.set(container, entry);
  spawnTail(entry, container, 300);
  return { ok: true };
});

ipcMain.on("docker:log-stop", (_e, payload) => {
  if (payload?.container) stopDockerTail(payload.container);
});

// ---------- Lifecycle ----------

app.whenReady().then(async () => {
  try {
    await spawnSidecar();
  } catch (err) {
    console.error("failed to spawn sidecar:", err);
  }
  try {
    spawnMediaMtx();
  } catch (err) {
    console.error("failed to spawn mediamtx:", err);
  }
  buildMenu();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  for (const child of childProcesses) {
    if (!child.killed) child.kill("SIGTERM");
  }
  for (const entry of dockerTails.values()) {
    entry.stopped = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.child && !entry.child.killed) entry.child.kill("SIGTERM");
  }
  dockerTails.clear();
});
