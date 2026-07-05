import { useEffect, useState } from "react";
import { useBackends } from "../../stores/backends";
import { persistSensorKitBase, isRunningInElectron } from "../../lib/electron-bridge";

export function SensorKitConnectionSettings() {
  const sensorKit = useBackends((s) => s.sensorKit);
  const sensorViewApi = useBackends((s) => s.sensorViewApi);
  const setSensorKit = useBackends((s) => s.setSensorKit);

  const [draft, setDraft] = useState(sensorKit);
  useEffect(() => setDraft(sensorKit), [sensorKit]);

  const commit = () => {
    const trimmed = draft.trim().replace(/\/+$/, "");
    setSensorKit(trimmed);
    persistSensorKitBase(trimmed);
  };

  const electron = isRunningInElectron();

  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="text-text-dim">SensorKit base URL</span>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder={electron ? "http://localhost:8000" : "(dev: uses Vite proxy)"}
          className="mt-1 w-full rounded border border-panel-border bg-black/30 px-2 py-1 font-mono text-xs text-text-bright focus:outline-none focus:border-accent"
        />
      </label>

      <div className="text-xs text-text-dim">
        <div className="flex gap-2">
          <span className="w-28 shrink-0">Local API:</span>
          <span className="font-mono text-text-bright">
            {sensorViewApi || "(vite proxy)"}
          </span>
        </div>
        <p className="mt-2">
          SensorKit runs outside this app. Point to the SensorKit web API host
          (default <code>http://localhost:8000</code>). The local API port is
          managed automatically by the bundled service.
        </p>
      </div>
    </div>
  );
}
