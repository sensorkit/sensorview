import { useEffect, useState } from "react";
import { useBackends } from "../../stores/backends";
import { persistSensorViewApi, isRunningInElectron } from "../../lib/electron-bridge";

/**
 * Base URL for the bundled SensorView API (the FastAPI sidecar: TLE cache,
 * image thumbnails, stream registration). In the desktop app the sidecar's
 * dynamic port is injected at startup, so there's nothing to set — we just
 * show it. In a plain browser this is empty by default (same-origin `/api`
 * via the dev proxy or the serving host); set it only to point a
 * statically-hosted UI at a sidecar running on another host.
 */
export function SensorViewApiSettings() {
  const sensorViewApi = useBackends((s) => s.sensorViewApi);
  const setSensorViewApi = useBackends((s) => s.setSensorViewApi);

  const [draft, setDraft] = useState(sensorViewApi);
  useEffect(() => setDraft(sensorViewApi), [sensorViewApi]);

  const commit = () => {
    const trimmed = draft.trim().replace(/\/+$/, "");
    setSensorViewApi(trimmed);
    persistSensorViewApi(trimmed);
  };

  // Desktop app: the sidecar port is managed automatically — show, don't edit.
  if (isRunningInElectron()) {
    return (
      <p className="text-xs text-text-dim">
        Managed automatically by the desktop app
        {sensorViewApi ? (
          <>
            {" "}
            (<code className="font-mono text-text-bright">{sensorViewApi}</code>)
          </>
        ) : null}
        .
      </p>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <input
        type="text"
        aria-label="SensorView API base URL"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        placeholder="(same origin — leave blank unless the API is on another host)"
        className="w-full rounded border border-panel-border bg-black/30 px-2 py-1 pointer-coarse:py-2 font-mono text-xs text-text-bright focus:outline-none focus:border-accent"
      />
    </div>
  );
}
