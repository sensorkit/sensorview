import { useEffect, useMemo, useState } from "react";
import {
  type CollectPreset,
  type FrameType,
  useCollectPresetsStore,
} from "../../stores/collectPresets";
import { useSensorKitStore } from "../../stores/sensorkit";

const FRAME_TYPES: FrameType[] = ["light", "dark", "bias", "flat"];

export function CollectPresetsSettings({ focusNewOnMount = false }: { focusNewOnMount?: boolean }) {
  const presets = useCollectPresetsStore((s) => s.presets);
  const defaultPresetId = useCollectPresetsStore((s) => s.defaultPresetId);
  const addPreset = useCollectPresetsStore((s) => s.addPreset);
  const updatePreset = useCollectPresetsStore((s) => s.updatePreset);
  const deletePreset = useCollectPresetsStore((s) => s.deletePreset);
  const setDefault = useCollectPresetsStore((s) => s.setDefault);

  const [editingId, setEditingId] = useState<string | null>(null);

  // When the user navigates in from the "New…" dropdown option, drop them
  // straight into a new preset edit form.
  useEffect(() => {
    if (!focusNewOnMount) return;
    const id = addPreset({
      name: "New preset",
      integration_time_seconds: 1,
      frame_count: 5,
    });
    setEditingId(id);
    // Only once, even with StrictMode off — guard with a ref-like flag via state init
  }, [focusNewOnMount, addPreset]);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {presets.map((p) => (
          <PresetRow
            key={p.id}
            preset={p}
            isDefault={p.id === defaultPresetId}
            isEditing={editingId === p.id}
            onEdit={() => setEditingId(p.id)}
            onDoneEditing={() => setEditingId(null)}
            onSetDefault={() => setDefault(p.id)}
            onDelete={() => {
              if (editingId === p.id) setEditingId(null);
              deletePreset(p.id);
            }}
            onPatch={(patch) => updatePreset(p.id, patch)}
          />
        ))}
      </div>

      <button
        onClick={() => {
          const id = addPreset({
            name: `Preset ${presets.length + 1}`,
            integration_time_seconds: 1,
            frame_count: 5,
          });
          setEditingId(id);
        }}
        className="px-3 py-1.5 text-xs rounded border border-panel-border bg-white/5 hover:bg-white/10 text-text-bright"
      >
        + Add preset
      </button>
    </div>
  );
}

function PresetRow({
  preset,
  isDefault,
  isEditing,
  onEdit,
  onDoneEditing,
  onSetDefault,
  onDelete,
  onPatch,
}: {
  preset: CollectPreset;
  isDefault: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onDoneEditing: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
  onPatch: (p: Partial<Omit<CollectPreset, "id">>) => void;
}) {
  return (
    <div
      className={`border rounded-lg p-3 ${
        isDefault ? "border-blue-500/40 bg-blue-500/5" : "border-panel-border bg-black/30"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="min-w-0 truncate text-sm text-text-bright font-semibold">{preset.name}</span>
        {isDefault && (
          <span className="px-1.5 py-0.5 text-[9px] uppercase tracking-wide rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
            default
          </span>
        )}
        <div className="ml-auto flex gap-1 pointer-coarse:gap-2">
          {!isDefault && (
            <button
              onClick={onSetDefault}
              className="px-2 py-0.5 pointer-coarse:px-2.5 pointer-coarse:py-1.5 text-[10px] rounded border border-panel-border bg-white/5 hover:bg-white/10 text-text-dim"
            >
              Set default
            </button>
          )}
          <button
            onClick={isEditing ? onDoneEditing : onEdit}
            className="px-2 py-0.5 pointer-coarse:px-2.5 pointer-coarse:py-1.5 text-[10px] rounded border border-panel-border bg-white/5 hover:bg-white/10 text-text-bright"
          >
            {isEditing ? "Done" : "Edit"}
          </button>
          <button
            onClick={onDelete}
            className="px-2 py-0.5 pointer-coarse:px-2.5 pointer-coarse:py-1.5 text-[10px] rounded border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-300"
          >
            Delete
          </button>
        </div>
      </div>

      {isEditing ? (
        <PresetEditor preset={preset} onPatch={onPatch} />
      ) : (
        <PresetSummary preset={preset} />
      )}
    </div>
  );
}

function PresetSummary({ preset }: { preset: CollectPreset }) {
  const parts: string[] = [];
  parts.push(`${preset.integration_time_seconds}s`);
  parts.push(`${preset.frame_count} frames`);
  if (preset.binning_x || preset.binning_y) {
    parts.push(`bin ${preset.binning_x ?? 1}×${preset.binning_y ?? 1}`);
  }
  if (preset.gain != null) parts.push(`gain ${preset.gain}`);
  if (preset.readout_mode != null) parts.push(`readout ${preset.readout_mode}`);
  if (preset.frame_type) parts.push(preset.frame_type);
  if (preset.filter_name) parts.push(`filter ${preset.filter_name}`);
  if (preset.sidereal_frames?.length) {
    parts.push(`sidereal frames [${preset.sidereal_frames.join(", ")}]`);
  }
  return (
    <div className="text-xs text-text-dim font-mono">{parts.join(" · ")}</div>
  );
}

function PresetEditor({
  preset,
  onPatch,
}: {
  preset: CollectPreset;
  onPatch: (p: Partial<Omit<CollectPreset, "id">>) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
      <Field label="Name">
        <input
          type="text"
          value={preset.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
        />
      </Field>
      <Field label="Integration (s)">
        <input
          type="number"
          step="0.001"
          min="0"
          value={preset.integration_time_seconds}
          onChange={(e) =>
            onPatch({ integration_time_seconds: parseFloat(e.target.value) || 0 })
          }
          className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
        />
      </Field>
      <Field label="Frame count">
        <input
          type="number"
          min="1"
          step="1"
          value={preset.frame_count}
          onChange={(e) =>
            onPatch({ frame_count: Math.max(1, parseInt(e.target.value, 10) || 1) })
          }
          className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
        />
      </Field>
      <Field label="Frame type">
        <select
          value={preset.frame_type ?? "light"}
          onChange={(e) => onPatch({ frame_type: e.target.value as FrameType })}
          className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
        >
          {FRAME_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Binning X">
        <input
          type="number"
          min="1"
          max="16"
          step="1"
          value={preset.binning_x ?? ""}
          placeholder="default"
          onChange={(e) => onPatch({ binning_x: nullableInt(e.target.value) })}
          className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
        />
      </Field>
      <Field label="Binning Y">
        <input
          type="number"
          min="1"
          max="16"
          step="1"
          value={preset.binning_y ?? ""}
          placeholder="default"
          onChange={(e) => onPatch({ binning_y: nullableInt(e.target.value) })}
          className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
        />
      </Field>
      <Field label="Readout mode">
        <input
          type="number"
          min="0"
          step="1"
          value={preset.readout_mode ?? ""}
          placeholder="default"
          onChange={(e) => onPatch({ readout_mode: nullableInt(e.target.value) })}
          className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
        />
      </Field>
      <Field label="Gain">
        <input
          type="number"
          step="0.1"
          value={preset.gain ?? ""}
          placeholder="default"
          onChange={(e) => onPatch({ gain: nullableFloat(e.target.value) })}
          className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
        />
      </Field>
      <FilterField preset={preset} onPatch={onPatch} />
      <Field label="Sidereal frames">
        <div className="flex items-center gap-1">
          <input
            type="text"
            inputMode="numeric"
            value={formatFrames(preset.sidereal_frames)}
            placeholder="off (0-based, e.g. 0, 4, 9)"
            onChange={(e) => onPatch({ sidereal_frames: parseFrames(e.target.value) })}
            className="flex-1 min-w-0 bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
          />
          <button
            type="button"
            title="Sidereal on the last frame only"
            onClick={() => onPatch({ sidereal_frames: [Math.max(0, preset.frame_count - 1)] })}
            className="shrink-0 px-2 py-1 text-[10px] uppercase tracking-wide rounded border border-panel-border text-text-dim hover:text-text-bright"
          >
            last
          </button>
        </div>
      </Field>
    </div>
  );
}

const INPUT_CLS =
  "bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono";

/**
 * Filter wheels currently reporting filters, read live from the firehose store
 * (`state[wheelId].Filters.filters`) — the same source the Devices tab uses.
 * Keyed by device id; only wheels that actually publish a non-empty filter list
 * appear, so the dropdowns never offer an empty wheel.
 */
function useFilterWheels(): { deviceId: string; names: string[] }[] {
  const state = useSensorKitStore((s) => s.state);
  return useMemo(() => {
    const wheels: { deviceId: string; names: string[] }[] = [];
    for (const [deviceId, ds] of Object.entries(state)) {
      const f = (ds as Record<string, unknown>)["Filters"] as
        | { filters?: { name: string }[] }
        | undefined;
      const names = f?.filters?.map((x) => x.name).filter(Boolean) ?? [];
      if (names.length) wheels.push({ deviceId, names });
    }
    return wheels.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }, [state]);
}

/**
 * Filter picker: a wheel dropdown that drives a filter dropdown. The preset only
 * stores the filter *name* (all the collect sends — the wheel is decided by
 * whichever instrument runs the collect), so the wheel select is transient UI to
 * choose which list of names to browse. Falls back to a free-text input when no
 * wheel is online, so a name can still be set or kept while instruments are down.
 */
function FilterField({
  preset,
  onPatch,
}: {
  preset: CollectPreset;
  onPatch: (p: Partial<Omit<CollectPreset, "id">>) => void;
}) {
  const wheels = useFilterWheels();

  // No wheel reporting filters (Settings open with no instrument online, or none
  // configured) — free text so a name can still be set/kept.
  if (wheels.length === 0) {
    return (
      <Field label="Filter">
        <input
          type="text"
          value={preset.filter_name ?? ""}
          placeholder="default"
          onChange={(e) => onPatch({ filter_name: e.target.value || null })}
          className={INPUT_CLS}
        />
      </Field>
    );
  }

  // A stored name no online wheel lists (preset built against another wheel) is
  // kept as a standalone option so editing never silently drops it.
  const orphan =
    preset.filter_name && !wheels.some((w) => w.names.includes(preset.filter_name!))
      ? preset.filter_name
      : null;

  // One dropdown, always. With multiple wheels the filters are grouped under
  // their wheel via <optgroup>, so the wheel is visible right where you pick the
  // filter — no separate select to overlook. With a single wheel the grouping is
  // redundant, so the list is flat and the wheel shows as a caption underneath.
  const single = wheels.length === 1;
  return (
    <Field label="Filter">
      <select
        value={preset.filter_name ?? ""}
        onChange={(e) => onPatch({ filter_name: e.target.value || null })}
        className={INPUT_CLS}
      >
        <option value="">default</option>
        {orphan && <option value={orphan}>{orphan}</option>}
        {single
          ? wheels[0]!.names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))
          : wheels.map((w) => (
              <optgroup key={w.deviceId} label={w.deviceId}>
                {w.names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </optgroup>
            ))}
      </select>
      {single && (
        <span className="text-[10px] text-text-dim font-mono">{wheels[0]!.deviceId}</span>
      )}
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-text-dim uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

function nullableInt(v: string): number | null {
  if (v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function formatFrames(frames?: number[]): string {
  return frames?.length ? frames.join(", ") : "";
}

// Parse a free-form "0, 4 9" list into a sorted, deduped set of 0-based indices.
function parseFrames(raw: string): number[] {
  const set = new Set<number>();
  for (const tok of raw.split(/[\s,]+/)) {
    if (!tok) continue;
    const n = parseInt(tok, 10);
    if (Number.isFinite(n) && n >= 0) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

function nullableFloat(v: string): number | null {
  if (v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
