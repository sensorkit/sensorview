// Preload runs in a sandboxed context; use CJS and the limited IPC APIs
// whitelisted by Electron's sandbox. We expose a tiny surface via
// contextBridge so the renderer can never touch Node directly.
const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Set();
ipcRenderer.on("sidecar-ready", (_event, payload) => {
  for (const cb of listeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error("sidecar-ready listener threw:", err);
    }
  }
});

const captureGotoListeners = new Set();
ipcRenderer.on("capture:goto", (_event, payload) => {
  for (const cb of captureGotoListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error("capture:goto listener threw:", err);
    }
  }
});

const recordStartListeners = new Set();
ipcRenderer.on("record:start", () => {
  for (const cb of recordStartListeners) {
    try {
      cb();
    } catch (err) {
      console.error("record:start listener threw:", err);
    }
  }
});

const recordStopListeners = new Set();
ipcRenderer.on("record:stop", () => {
  for (const cb of recordStopListeners) {
    try {
      cb();
    } catch (err) {
      console.error("record:stop listener threw:", err);
    }
  }
});

const dockerLogListeners = new Set();
ipcRenderer.on("docker:log-chunk", (_event, payload) => {
  for (const cb of dockerLogListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error("docker:log-chunk listener threw:", err);
    }
  }
});

const tabClosedListeners = new Set();
ipcRenderer.on("tab:closed", (_event, tabId) => {
  for (const cb of tabClosedListeners) {
    try {
      cb(tabId);
    } catch (err) {
      console.error("tab:closed listener threw:", err);
    }
  }
});

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,

  getSidecarPort: () => ipcRenderer.invoke("sidecar:port"),
  openSkyviewPopout: () => ipcRenderer.invoke("popout:open"),
  openTabWindow: (tabId) => ipcRenderer.invoke("tab:open", tabId),
  listDetachedTabs: () => ipcRenderer.invoke("tab:list"),
  onTabWindowClosed: (cb) => {
    tabClosedListeners.add(cb);
    return () => tabClosedListeners.delete(cb);
  },
  closeTabWindow: (tabId) => ipcRenderer.invoke("tab:close", tabId),
  openExternal: (url) => ipcRenderer.send("shell:open-external", url),

  onSidecarReady: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  onCaptureGoto: (cb) => {
    captureGotoListeners.add(cb);
    return () => captureGotoListeners.delete(cb);
  },
  captureReady: () => ipcRenderer.send("capture:ready"),

  onRecordStart: (cb) => {
    recordStartListeners.add(cb);
    return () => recordStartListeners.delete(cb);
  },
  onRecordStop: (cb) => {
    recordStopListeners.add(cb);
    return () => recordStopListeners.delete(cb);
  },
  sendRecordChunk: (buf) => ipcRenderer.send("record:chunk", buf),
  sendRecordDone: () => ipcRenderer.send("record:done"),
  sendRecordError: (message) => ipcRenderer.send("record:error", message),

  listDockerServices: () => ipcRenderer.invoke("docker:list"),
  startDockerLog: (container) => ipcRenderer.invoke("docker:log-start", { container }),
  stopDockerLog: (container) => ipcRenderer.send("docker:log-stop", { container }),
  onDockerLogChunk: (cb) => {
    dockerLogListeners.add(cb);
    return () => dockerLogListeners.delete(cb);
  },
});
