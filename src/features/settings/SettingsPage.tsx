import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { TLESettings } from "./TLESettings";
import { CollectPresetsSettings } from "./CollectPresetsSettings";
import { SensorKitConnectionSettings } from "./SensorKitConnectionSettings";
import { ObservationProgramSettings } from "./ObservationProgramSettings";
import { DirectDeviceControlSettings } from "./DirectDeviceControlSettings";

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
        <SettingsSection id="tle" label="TLE Sources">
          <TLESettings />
        </SettingsSection>

        <SettingsSection id="collect" label="Collect Presets">
          <CollectPresetsSettings focusNewOnMount={newPresetFocus} />
        </SettingsSection>

        <SettingsSection id="observer" label="Observer Location">
          <p className="text-sm text-text-dim">
            Observer latitude, longitude, and altitude configuration.
          </p>
          <p className="text-xs text-text-dim mt-1">Coming soon.</p>
        </SettingsSection>

        <SettingsSection id="connection" label="SensorKit Connection">
          <SensorKitConnectionSettings />
        </SettingsSection>

        <SettingsSection id="program" label="Observation Program">
          <ObservationProgramSettings />
        </SettingsSection>

        <SettingsSection id="direct-control" label="Direct Device Control">
          <DirectDeviceControlSettings />
        </SettingsSection>

        <SettingsSection id="display" label="Display">
          <p className="text-sm text-text-dim">
            Limiting magnitude, constellation overlays, and rendering preferences.
          </p>
          <p className="text-xs text-text-dim mt-1">Coming soon.</p>
        </SettingsSection>
      </div>
    </div>
  );
}

function SettingsSection({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="border border-panel-border rounded-lg p-4 bg-panel-bg/40">
      <h2 className="text-sm font-semibold text-text-bright mb-3">{label}</h2>
      {children}
    </section>
  );
}
