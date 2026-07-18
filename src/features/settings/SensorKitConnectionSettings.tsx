import { useEffect, useState } from "react";
import { useBackends } from "../../stores/backends";
import { persistSensorKitBase, isRunningInElectron } from "../../lib/electron-bridge";

export function SensorKitConnectionSettings() {
  const sensorKit = useBackends((s) => s.sensorKit);
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
      <input
        type="text"
        aria-label="SensorKit base URL"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        placeholder={electron ? "http://localhost:8000" : "(dev: uses Vite proxy)"}
        className="w-full rounded border border-panel-border bg-black/30 px-2 py-1 font-mono text-xs text-text-bright focus:outline-none focus:border-accent"
      />
    </div>
  );
}
