/**
 * Thin bridge between the React app and the Electron main process. When
 * running in a plain browser (`npm run dev`) every function is a no-op or
 * graceful fallback, so feature code can import this unconditionally.
 */
import { useBackends } from "../stores/backends";

const api = typeof window !== "undefined" ? window.electronAPI : undefined;

export function isRunningInElectron(): boolean {
  return !!api;
}

const STORAGE_KEY = "sensorview.sensorKitBase";
const PROGRAM_STORAGE_KEY = "sensorview.programName";
const API_STORAGE_KEY = "sensorview.sensorViewApi";

/**
 * Initialise Electron integration:
 *  - Register a listener for the `sidecar-ready` IPC event, updating the
 *    backends store with the sidecar port.
 *  - Pull the sidecar port synchronously in case the event already fired
 *    before we subscribed.
 *  - Restore the user's SensorKit base URL from localStorage (shared across
 *    browser and Electron so dev + packaged use the same persistence).
 * Returns an unsubscribe function.
 */
export async function initElectronBridge(): Promise<() => void> {
  // Always restore settings — works in browser and Electron.
  try {
    const persisted = localStorage.getItem(STORAGE_KEY);
    if (persisted) useBackends.getState().setSensorKit(persisted);
    const persistedProgram = localStorage.getItem(PROGRAM_STORAGE_KEY);
    if (persistedProgram) useBackends.getState().setProgramName(persistedProgram);
    // The SensorView API base is only user-settable in a plain browser (to
    // point a statically-hosted UI at a remote sidecar). In Electron the
    // sidecar-ready IPC below is authoritative — its dynamic port must never be
    // shadowed by a stale persisted value — so we deliberately don't restore it.
    if (!api) {
      const persistedApi = localStorage.getItem(API_STORAGE_KEY);
      if (persistedApi) useBackends.getState().setSensorViewApi(persistedApi);
    }
  } catch {
    /* localStorage unavailable (private window etc.) — ignore */
  }

  if (!api) return () => {};

  const unlisten = api.onSidecarReady(({ port }) => {
    useBackends.getState().setSensorViewApi(`http://127.0.0.1:${port}`);
  });

  const port = await api.getSidecarPort();
  if (typeof port === "number") {
    useBackends.getState().setSensorViewApi(`http://127.0.0.1:${port}`);
  }

  return unlisten;
}

export function persistSensorKitBase(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
}

export function persistProgramName(value: string): void {
  try {
    localStorage.setItem(PROGRAM_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
}

/**
 * Persist the SensorView API base. Only meaningful in a plain browser — see
 * `initElectronBridge` for why Electron doesn't restore it.
 */
export function persistSensorViewApi(value: string): void {
  try {
    localStorage.setItem(API_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
}

export async function openSkyviewPopout(): Promise<void> {
  if (api) {
    await api.openSkyviewPopout();
    return;
  }
  // Browser fallback: plain window.open with the hash route.
  window.open("#/popout/skyview", "_blank", "width=1280,height=800");
}

/**
 * Pop a main tab out into its own window. In Electron this creates a real,
 * movable/resizable BrowserWindow and returns `true` (the caller should mark
 * the tab detached). In a plain browser there's no true detach, so we fall back
 * to a `window.open` and return `false` — the tab stays a normal in-app tab.
 */
export async function openTabWindow(tabId: string): Promise<boolean> {
  if (api?.openTabWindow) {
    await api.openTabWindow(tabId);
    return true;
  }
  window.open(`#/window/${tabId}`, "_blank", "width=1200,height=820");
  return false;
}

/**
 * Subscribe to detached-tab-window close events (Electron). The callback fires
 * with the tab id when its window is closed, so the main window can re-dock it.
 * No-op in the browser.
 */
export function onTabWindowClosed(cb: (tabId: string) => void): () => void {
  if (!api?.onTabWindowClosed) return () => {};
  return api.onTabWindowClosed(cb);
}

/** Ask the main process which tabs currently have an open window. Browser → []. */
export async function listDetachedTabs(): Promise<string[]> {
  if (!api?.listDetachedTabs) return [];
  return api.listDetachedTabs();
}

/** Close a detached tab window (re-dock it). No-op in the browser. */
export async function closeTabWindow(tabId: string): Promise<void> {
  if (api?.closeTabWindow) await api.closeTabWindow(tabId);
}
