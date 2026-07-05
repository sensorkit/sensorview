import { useEffect, useState } from "react";
import {
  type CollectPreset,
  type FrameType,
  useCollectPresetsStore,
} from "../../stores/collectPresets";

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
      <p className="text-xs text-text-dim">
        Define reusable parameter sets for the Collect action. The default preset is used
        when you click Collect without picking from the dropdown.
      </p>

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
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm text-text-bright font-semibold">{preset.name}</span>
        {isDefault && (
          <span className="px-1.5 py-0.5 text-[9px] uppercase tracking-wide rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
            default
          </span>
        )}
        <div className="ml-auto flex gap-1">
          {!isDefault && (
            <button
              onClick={onSetDefault}
              className="px-2 py-0.5 text-[10px] rounded border border-panel-border bg-white/5 hover:bg-white/10 text-text-dim"
            >
              Set default
            </button>
          )}
          <button
            onClick={isEditing ? onDoneEditing : onEdit}
            className="px-2 py-0.5 text-[10px] rounded border border-panel-border bg-white/5 hover:bg-white/10 text-text-bright"
          >
            {isEditing ? "Done" : "Edit"}
          </button>
          <button
            onClick={onDelete}
            className="px-2 py-0.5 text-[10px] rounded border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-300"
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
          value={preset.frame_type ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            onPatch({ frame_type: v ? (v as FrameType) : null });
          }}
          className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
        >
          <option value="">(default)</option>
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
      <Field label="Filter name">
        <input
          type="text"
          value={preset.filter_name ?? ""}
          placeholder="(none)"
          onChange={(e) =>
            onPatch({ filter_name: e.target.value ? e.target.value : null })
          }
          className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
        />
      </Field>
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
