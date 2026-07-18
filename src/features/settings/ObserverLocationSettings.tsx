import { useEffect, useState } from "react";
import { useObserverStore } from "../../stores/observer";
import { useObserver } from "../skyview/hooks/useObserver";
import { parseCoordinate, isInRange, formatDMS, type Axis } from "../../lib/coords";
import { MapPickerModal } from "./MapPickerModal";
import { Toggle } from "./Toggle";

/**
 * Observer Location settings. Lets the operator set a site manually (decimal
 * degrees or D M S) or by picking on a map, and choose whether that manual
 * site overrides a live SensorKit controller. Together these make SkyView
 * usable with no live SensorKit connection at all.
 */
export function ObserverLocationSettings() {
  const manual = useObserverStore((s) => s.manual);
  const overrideSensorKit = useObserverStore((s) => s.overrideSensorKit);
  const setManual = useObserverStore((s) => s.setManual);
  const setOverride = useObserverStore((s) => s.setOverride);

  // What SkyView is actually using right now (drives the banner).
  const { observer, source } = useObserver();

  const [showMap, setShowMap] = useState(false);

  return (
    <div className="space-y-4 text-sm">
      <SourceBanner source={source} name={observer.name} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CoordField
          label="Latitude"
          hint="(DD.dddd or DD MM SS, negative = South)"
          axis="lat"
          value={manual.lat}
          onCommit={(v) => setManual({ lat: v })}
        />
        <CoordField
          label="Longitude"
          hint="(DD.dddd or DD MM SS, negative = West)"
          axis="lon"
          value={manual.lon}
          onCommit={(v) => setManual({ lon: v })}
        />
        <AltitudeField value={manual.alt} onCommit={(v) => setManual({ alt: v })} />
        <label className="block">
          <span className="text-xs text-text-dim">Site name</span>
          <input
            type="text"
            value={manual.name}
            onChange={(e) => setManual({ name: e.target.value })}
            placeholder="e.g. Haleakalā, Maui"
            className="mt-1 w-full rounded border border-panel-border bg-black/30 px-2 py-1 text-sm text-text-bright outline-none focus:border-orange-300/60"
          />
        </label>
      </div>

      <div>
        <button
          onClick={() => setShowMap(true)}
          className="rounded border border-panel-border bg-white/5 px-3 py-1 text-xs text-text-bright hover:bg-white/10"
        >
          Choose from map…
        </button>
      </div>

      <div className="border-t border-panel-border pt-3">
        <div className="group relative flex w-fit items-center gap-2">
          <Toggle
            checked={overrideSensorKit}
            onChange={setOverride}
            label="Override SensorKit"
          />
          <span className="text-text-dim" aria-hidden>
            ⓘ
          </span>
          <span
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden w-80 rounded border border-panel-border bg-panel-bg px-3 py-2 text-xs font-normal text-text-dim shadow-lg group-hover:block"
          >
            When on, SkyView always uses the site above. When off, a live SensorKit controller's
            reported site is used if available — and the site above is the fallback whenever no live
            connection is present, so SkyView still works offline.
          </span>
        </div>
      </div>

      {showMap && (
        <MapPickerModal
          initial={{ lat: manual.lat, lon: manual.lon, alt: manual.alt }}
          onCancel={() => setShowMap(false)}
          onConfirm={(loc) => {
            setManual({ lat: loc.lat, lon: loc.lon, alt: loc.alt });
            setShowMap(false);
          }}
        />
      )}
    </div>
  );
}

function SourceBanner({ source, name }: { source: "live" | "manual"; name: string }) {
  const live = source === "live";
  return (
    <div className="flex items-center gap-2 rounded border border-panel-border bg-black/20 px-3 py-2 text-xs">
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
          live ? "bg-emerald-400" : "bg-orange-300"
        }`}
      />
      <span className="text-text-bright">
        {name || (live ? "SensorKit" : "Manual location")}
      </span>
    </div>
  );
}

/**
 * A latitude/longitude field accepting decimal or D M S. Keeps local text while
 * editing; commits the parsed decimal degrees on blur/Enter only when valid,
 * then reflects the canonical D M S back. Shows the live parsed value or an
 * inline error.
 */
function CoordField({
  label,
  hint,
  axis,
  value,
  onCommit,
}: {
  label: string;
  hint?: string;
  axis: Axis;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(() => formatDMS(value));

  // Re-sync when the stored value changes from elsewhere (map pick, or the
  // canonical reformat after our own commit).
  useEffect(() => setText(formatDMS(value)), [value]);

  const parsed = parseCoordinate(text);
  const valid = parsed !== null && isInRange(parsed, axis);

  const commit = () => {
    if (valid) onCommit(parsed);
    else setText(formatDMS(value)); // revert bad input to last good value
  };

  return (
    <label className="block">
      <span className="text-xs text-text-dim">
        {label}
        {hint && <span className="opacity-70"> {hint}</span>}
      </span>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={`mt-1 w-full rounded border bg-black/30 px-2 py-1 font-mono text-sm text-text-bright outline-none focus:border-orange-300/60 ${
          valid ? "border-panel-border" : "border-red-400/60"
        }`}
      />
      <span className={`mt-0.5 block text-[11px] ${valid ? "text-text-dim" : "text-red-300"}`}>
        {valid ? `= ${parsed.toFixed(6)}°` : "Enter decimal degrees or D M S"}
      </span>
    </label>
  );
}

function AltitudeField({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(() => String(Math.round(value)));
  useEffect(() => setText(String(Math.round(value))), [value]);

  const parsed = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(parsed);

  const commit = () => {
    if (valid) onCommit(Math.round(parsed));
    else setText(String(Math.round(value)));
  };

  return (
    <label className="block">
      <span className="text-xs text-text-dim">Altitude (m)</span>
      <input
        type="number"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={`mt-1 w-full rounded border bg-black/30 px-2 py-1 font-mono text-sm text-text-bright outline-none focus:border-orange-300/60 ${
          valid ? "border-panel-border" : "border-red-400/60"
        }`}
      />
      <span className="mt-0.5 block text-[11px] text-text-dim">Meters above sea level.</span>
    </label>
  );
}
