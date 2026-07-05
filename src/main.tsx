import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initElectronBridge } from "./lib/electron-bridge";

// StrictMode disabled — it double-fires effects which clears canvases and causes blinking.
// Render immediately and wire up the Electron bridge in the background; components
// that need the sidecar port re-render when useBackends updates. Previously we
// awaited the bridge before first paint, which left users staring at the raw
// body-background color while the IPC roundtrip + any other startup work resolved.
createRoot(document.getElementById("root")!).render(<App />);
void initElectronBridge();

// Dev-only: React 19's development build emits a steady stream of
// `performance.mark` / `performance.measure` entries (component renders,
// commit phases, scheduler steps). They accumulate in the browser's user-
// timing buffer indefinitely and eventually OOM the renderer in long dev
// sessions — fast when a live <video> stream is also active. Production
// React doesn't emit them, so this cleanup is a no-op in packaged builds
// (the conditional is dead-code-eliminated by Vite).
if (import.meta.env.DEV) {
  setInterval(() => {
    performance.clearMarks();
    performance.clearMeasures();
  }, 30_000);
}

