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

export async function openSkyviewPopout(): Promise<void> {
  if (api) {
    await api.openSkyviewPopout();
    return;
  }
  // Browser fallback: plain window.open with the hash route.
  window.open("#/popout/skyview", "_blank", "width=1280,height=800");
}
