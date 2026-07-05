import { useSkyViewStore, type ViewMode } from "../../../stores/skyview";
import { useSatelliteStore } from "../../../stores/satellites";
import { REGIME_COLORS } from "../layers/regimeColors";

const VIEW_MODES: { mode: ViewMode; glyph: string; label: string; title: string }[] = [
  { mode: "sky", glyph: "◉", label: "Sky", title: "Sky view" },
  { mode: "overhead", glyph: "◎", label: "Over", title: "Overhead view" },
  { mode: "groundtrack", glyph: "≈", label: "Track", title: "Ground track" },
];

const REGIMES: ("LEO" | "MEO" | "GEO" | "HEO")[] = ["LEO", "MEO", "GEO", "HEO"];

/**
 * V4 "Atlas Observatory" left rail. 68 px wide column with view-mode icons
 * at the top and orbit-regime chips below. Reads and writes the same stores
 * as FilterControls, so the two stay in sync during phased migration.
 */
export function LeftRail() {
  const viewMode = useSkyViewStore((s) => s.viewMode);
  const setViewMode = useSkyViewStore((s) => s.setViewMode);

  const filter = useSatelliteStore((s) => s.filter);
  const updateFilter = useSatelliteStore((s) => s.updateFilter);

  return (
    <div className="h-full w-full flex flex-col items-center pt-3.5 gap-1.5">
      {VIEW_MODES.map((v) => {
        const active = viewMode === v.mode;
        return (
          <button
            key={v.mode}
            type="button"
            onClick={() => setViewMode(v.mode)}
            title={v.title}
            aria-pressed={active}
            className="flex flex-col items-center justify-center rounded-sm transition-colors"
            style={{
              width: 48,
              height: 48,
              color: active ? "var(--color-brass)" : "var(--color-paper-dim)",
              background: active ? "rgba(184,138,63,0.13)" : "transparent",
              border: active
                ? "1px solid rgba(184,138,63,0.4)"
                : "1px solid transparent",
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>{v.glyph}</span>
            <span style={{ fontSize: 9, letterSpacing: 0.5, marginTop: 3 }}>
              {v.label}
            </span>
          </button>
        );
      })}

      <div
        style={{
          width: 34,
          height: 1,
          background: "rgba(184,138,63,0.28)",
          margin: "8px 0",
        }}
      />

      <div
        className="font-semibold uppercase text-brass"
        style={{ fontSize: 9, letterSpacing: 1.5, marginBottom: 2 }}
      >
        Orbits
      </div>

      {REGIMES.map((regime) => {
        const active = filter.orbitRegimes.has(regime);
        const color = REGIME_COLORS[regime];
        return (
          <button
            key={regime}
            type="button"
            onClick={() => {
              const next = new Set(filter.orbitRegimes);
              if (next.has(regime)) next.delete(regime);
              else next.add(regime);
              updateFilter({ orbitRegimes: next });
            }}
            title={`Toggle ${regime} satellites`}
            aria-pressed={active}
            className="flex items-center justify-center gap-1.5 rounded-[3px]"
            style={{
              width: 48,
              height: 30,
              color: active ? color : "var(--color-paper-dim)",
              background: active ? `${color}18` : "transparent",
              border: active
                ? `1px solid ${color}55`
                : "1px solid rgba(184,138,63,0.18)",
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: 0.6,
              opacity: active ? 1 : 0.55,
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 99,
                background: active ? color : "var(--color-paper-dim)",
              }}
            />
            {regime}
          </button>
        );
      })}
    </div>
  );
}
