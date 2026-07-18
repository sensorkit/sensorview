import { create } from "zustand";
import { persist } from "zustand/middleware";

export type FrameType = "light" | "dark" | "bias" | "flat";

export interface CollectPreset {
  id: string;
  name: string;
  integration_time_seconds: number;
  frame_count: number;
  binning_x?: number | null;
  binning_y?: number | null;
  gain?: number | null;
  frame_type?: FrameType | null;
  filter_name?: string | null;
  /** 0-based frame indices captured under sidereal tracking (empty = none). */
  sidereal_frames?: number[];
}

interface CollectPresetsStore {
  presets: CollectPreset[];
  defaultPresetId: string | null;

  getDefault: () => CollectPreset | null;
  addPreset: (preset: Omit<CollectPreset, "id">) => string;
  updatePreset: (id: string, patch: Partial<Omit<CollectPreset, "id">>) => void;
  deletePreset: (id: string) => void;
  setDefault: (id: string) => void;
}

function seedPresets(): CollectPreset[] {
  return [
    {
      id: crypto.randomUUID(),
      name: "Snapshot",
      integration_time_seconds: 1,
      frame_count: 1,
    },
    {
      id: crypto.randomUUID(),
      name: "Burst",
      integration_time_seconds: 1,
      frame_count: 5,
    },
  ];
}

export const useCollectPresetsStore = create<CollectPresetsStore>()(
  persist(
    (set, get) => {
      const seeded = seedPresets();
      return {
        presets: seeded,
        defaultPresetId: seeded[0]!.id,

        getDefault: () => {
          const { presets, defaultPresetId } = get();
          return (
            presets.find((p) => p.id === defaultPresetId) ?? presets[0] ?? null
          );
        },

        addPreset: (preset) => {
          const id = crypto.randomUUID();
          set((s) => ({
            presets: [...s.presets, { ...preset, id }],
            defaultPresetId: s.defaultPresetId ?? id,
          }));
          return id;
        },

        updatePreset: (id, patch) =>
          set((s) => ({
            presets: s.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)),
          })),

        deletePreset: (id) =>
          set((s) => {
            const remaining = s.presets.filter((p) => p.id !== id);
            const nextDefault =
              s.defaultPresetId === id
                ? remaining[0]?.id ?? null
                : s.defaultPresetId;
            return { presets: remaining, defaultPresetId: nextDefault };
          }),

        setDefault: (id) => set({ defaultPresetId: id }),
      };
    },
    {
      name: "sensorview.collectPresets",
      version: 6,
      migrate: (persistedState, fromVersion) => {
        const s = persistedState as {
          presets?: CollectPreset[];
          defaultPresetId?: string | null;
        };
        let presets = s.presets ?? [];

        // v1→v2: backfill the built-in "Single 1s" preset for users who already
        // had a persisted v1 store (which only seeded "Quick").
        if (fromVersion < 2) {
          const hasSingle = presets.some(
            (p) => p.name === "Single 1s" && p.frame_count === 1,
          );
          if (!hasSingle) {
            presets = [
              {
                id: crypto.randomUUID(),
                name: "Single 1s",
                integration_time_seconds: 1,
                frame_count: 1,
              },
              ...presets,
            ];
          }
        }

        // v2→v3: `sidereal_from_frame` (switch to sidereal from N onward) became
        // an explicit `sidereal_frames` list. Expand the old trailing range
        // [N .. frame_count-1] to preserve identical behavior.
        if (fromVersion < 3) {
          presets = presets.map((p) => {
            const legacy = (p as { sidereal_from_frame?: number | null })
              .sidereal_from_frame;
            const next = { ...p } as CollectPreset & {
              sidereal_from_frame?: number | null;
            };
            delete next.sidereal_from_frame;
            if (legacy != null && next.sidereal_frames == null) {
              const last = (p.frame_count ?? legacy + 1) - 1;
              const frames: number[] = [];
              for (let i = legacy; i <= last; i++) frames.push(i);
              next.sidereal_frames = frames;
            }
            return next;
          });
        }

        // v3/v4 → v5: the two built-in presets got clearer, parameter-encoded
        // names. Guarded at `< 5` rather than `< 4` on purpose — a hot-reload
        // during development can bump a persisted store to v4 without this
        // rename taking effect, stranding it on the old names; re-running for
        // any store below v5 heals those. Idempotent: only the original
        // built-in name+shape matches, so a preset the user renamed is untouched.
        if (fromVersion < 5) {
          presets = presets.map((p) => {
            if (
              p.name === "Single 1s" &&
              p.integration_time_seconds === 1 &&
              p.frame_count === 1
            ) {
              return { ...p, name: "Snapshot: t=1, n=1" };
            }
            if (
              p.name === "Quick" &&
              p.integration_time_seconds === 1 &&
              p.frame_count === 5
            ) {
              return { ...p, name: "Burst: t=1, n=5" };
            }
            return p;
          });
        }

        // v5→v6: shortened the built-in names to just "Snapshot" and "Burst"
        // (the parameters already show on the row below). Matches the
        // intermediate name + shape, so a preset the user renamed stays put;
        // chains off the block above for stores arriving from v3/v4.
        if (fromVersion < 6) {
          presets = presets.map((p) => {
            if (
              p.name === "Snapshot: t=1, n=1" &&
              p.integration_time_seconds === 1 &&
              p.frame_count === 1
            ) {
              return { ...p, name: "Snapshot" };
            }
            if (
              p.name === "Burst: t=1, n=5" &&
              p.integration_time_seconds === 1 &&
              p.frame_count === 5
            ) {
              return { ...p, name: "Burst" };
            }
            return p;
          });
        }

        return { ...s, presets };
      },
    },
  ),
);
