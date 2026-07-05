import { create } from "zustand";

/**
 * Runtime-configurable base URLs for the two backends SensorView talks to.
 *
 * In the browser (`npm run dev`) the defaults are empty strings, so fetch
 * calls resolve to relative paths (`/sk/...`, `/api/...`) and go through the
 * Vite proxy. In Tauri the Rust side populates `sensorViewApi` with the
 * sidecar's dynamically-assigned port via the `sidecar-ready` event, and
 * `sensorKit` falls back to `http://localhost:8000` (user-configurable in
 * Settings).
 */
interface BackendsState {
  sensorViewApi: string;
  sensorKit: string;
  /**
   * Observation program label sent in the task `context` on every collect.
   * SensorKit's file-path template resolves `{program_name}` against the
   * task context; without it the data pipeline errors with NameError.
   * Not required to match a registered SensorKit program entity — it's
   * just a string substituted into the output directory path.
   */
  programName: string;
  setSensorViewApi: (base: string) => void;
  setSensorKit: (base: string) => void;
  setProgramName: (name: string) => void;
}

const isDesktop =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || !!(window as { electronAPI?: unknown }).electronAPI);

export const useBackends = create<BackendsState>((set) => ({
  sensorViewApi: "",
  sensorKit: isDesktop ? "http://127.0.0.1:8000" : "",
  programName: "sensorview",
  setSensorViewApi: (sensorViewApi) => set({ sensorViewApi }),
  setSensorKit: (sensorKit) => set({ sensorKit }),
  setProgramName: (programName) => set({ programName }),
}));

const stripTrailing = (s: string) => s.replace(/\/+$/, "");

export function apiUrl(path: string): string {
  const base = stripTrailing(useBackends.getState().sensorViewApi);
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function skUrl(path: string): string {
  const base = stripTrailing(useBackends.getState().sensorKit);
  // When the store holds an empty base, fall back to the Vite proxy prefix.
  const prefix = base === "" ? "/sk" : base;
  return `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
}
