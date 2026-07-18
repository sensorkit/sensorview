import { useEffect, useState } from "react";
import { useBackends } from "../../stores/backends";
import { persistProgramName } from "../../lib/electron-bridge";

export function ObservationProgramSettings() {
  const programName = useBackends((s) => s.programName);
  const setProgramName = useBackends((s) => s.setProgramName);

  const [draft, setDraft] = useState(programName);
  useEffect(() => setDraft(programName), [programName]);

  const commit = () => {
    const trimmed = draft.trim();
    setProgramName(trimmed);
    persistProgramName(trimmed);
  };

  return (
    <div className="space-y-3 text-sm">
      <input
        type="text"
        aria-label="Program name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        placeholder="sensorview"
        className="w-full rounded border border-panel-border bg-black/30 px-2 py-1 font-mono text-xs text-text-bright focus:outline-none focus:border-accent"
      />
    </div>
  );
}
