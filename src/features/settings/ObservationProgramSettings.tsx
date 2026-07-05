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
      <label className="block">
        <span className="text-text-dim">Program name</span>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="sensorview"
          className="mt-1 w-full rounded border border-panel-border bg-black/30 px-2 py-1 font-mono text-xs text-text-bright focus:outline-none focus:border-accent"
        />
      </label>

      <p className="text-xs text-text-dim">
        Sent as <code>context.program_name</code> on every Collect task.
        SensorKit substitutes it into the data pipeline's file-path template
        (<code>{"{program_name}"}</code>). Use any label you want —
        it doesn't need to match a registered SensorKit program.
      </p>
    </div>
  );
}
