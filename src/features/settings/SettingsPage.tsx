import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { TLESettings } from "./TLESettings";
import { CollectPresetsSettings } from "./CollectPresetsSettings";
import { SensorKitConnectionSettings } from "./SensorKitConnectionSettings";
import { ObservationProgramSettings } from "./ObservationProgramSettings";
import { DirectDeviceControlSettings } from "./DirectDeviceControlSettings";
import { ObserverLocationSettings } from "./ObserverLocationSettings";
import { InfoTooltip } from "./InfoTooltip";

export function SettingsPage() {
  const location = useLocation();
  const [newPresetFocus, setNewPresetFocus] = useState(false);

  // Scroll to the section referenced by the URL hash, and if the hash has a
  // "?new" tail, prompt CollectPresetsSettings to seed a fresh preset for edit.
  useEffect(() => {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return;
    const [id, query] = raw.split("?");
    if (id) {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (id === "collect" && query === "new") setNewPresetFocus(true);
  }, [location.hash]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-4 space-y-8">
        <SettingsSection id="observer" label="Observer Location">
          <ObserverLocationSettings />
        </SettingsSection>

        <SettingsSection
          id="tle"
          label="Satellite Ephemerides"
          tooltip={
            <>
              Enable any combination; the catalog merges them all. Drag rows to
              set priority — when a satellite appears in more than one enabled
              source, the one higher in this list wins.
            </>
          }
        >
          <TLESettings />
        </SettingsSection>

        <SettingsSection
          id="collect"
          label="Collect Presets"
          tooltip={
            <>
              Define reusable parameter sets for the Collect action. The default
              preset is used when you click Collect without picking from the
              dropdown.
            </>
          }
        >
          <CollectPresetsSettings focusNewOnMount={newPresetFocus} />
        </SettingsSection>

        <SettingsSection
          id="connection"
          label="SensorKit Connection"
          tooltip={
            <>
              SensorKit runs outside this app. Point to the SensorKit web API
              host (default <code>http://localhost:8000</code>).
            </>
          }
        >
          <SensorKitConnectionSettings />
        </SettingsSection>

        <SettingsSection
          id="program"
          label="Program Name"
          tooltip={
            <>
              Sent as <code>context.program_name</code> on every Collect task.
              SensorKit substitutes it into the data pipeline's file-path
              template (<code>{"{program_name}"}</code>). Use any label you want
              — it doesn't need to match a registered SensorKit program.
            </>
          }
        >
          <ObservationProgramSettings />
        </SettingsSection>

        <SettingsSection id="direct-control">
          <DirectDeviceControlSettings />
        </SettingsSection>
      </div>
    </div>
  );
}

function SettingsSection({
  id,
  label,
  tooltip,
  children,
}: {
  id: string;
  label?: string;
  tooltip?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="border border-panel-border rounded-lg p-4 bg-panel-bg/40">
      {label && (
        <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-bright">
          {label}
          {tooltip && <InfoTooltip label={`About ${label}`}>{tooltip}</InfoTooltip>}
        </h2>
      )}
      {children}
    </section>
  );
}
