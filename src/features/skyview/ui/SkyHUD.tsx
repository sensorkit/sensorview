import { useSkyViewStore } from "../../../stores/skyview";
import { useSatelliteStore } from "../../../stores/satellites";
import { computeFovDegrees } from "../projection";
import { useObserver } from "../hooks/useObserver";
import { useStarAltitudes } from "../hooks/useStarAltitudes";
import type { StarCatalog } from "../catalog/stars";

const RISE_SOON_MINUTES = 15;

/**
 * V4 sky-scene overlays — a single right-aligned stack of stat chips at the
 * top-right of the canvas: FOV, then a set of counts that reflects whichever
 * Catalog tab is currently selected (satellites / stars / solar), then the
 * constellations / solar-system toggles. Switching tabs in the right-hand
 * Catalog column reshapes this stack so the user always sees the stats
 * that match the list they're looking at.
 */
export function SkyHUD({
  canvasWidth,
  canvasHeight,
  catalog,
}: {
  canvasWidth: number;
  canvasHeight: number;
  catalog: StarCatalog | null;
}) {
  const viewMode = useSkyViewStore((s) => s.viewMode);
  const zoom = useSkyViewStore((s) => s.zoom);
  const overheadZoom = useSkyViewStore((s) => s.overheadZoom);
  const groundTrackZoom = useSkyViewStore((s) => s.groundTrackZoom);
  const showConstellations = useSkyViewStore((s) => s.showConstellations);
  const showSolarSystem = useSkyViewStore((s) => s.showSolarSystem);
  const toggleConstellations = useSkyViewStore((s) => s.toggleConstellations);
  const toggleSolarSystem = useSkyViewStore((s) => s.toggleSolarSystem);
  const catalogTab = useSkyViewStore((s) => s.catalogTab);

  const positions = useSatelliteStore((s) => s.positions);
  const tles = useSatelliteStore((s) => s.tles);

  const { observer } = useObserver();
  // These hooks short-circuit cheaply when their inputs haven't changed
  // (memoized), so it's fine to call them even when the corresponding tab
  // isn't active — same shape as CatalogColumn does today.
  const starAlts = useStarAltitudes(catalog, observer);
  const selectedHorizonsTarget = useSkyViewStore((s) => s.selectedHorizonsTarget);

  const activeZoom =
    viewMode === "sky" ? zoom : viewMode === "overhead" ? overheadZoom : groundTrackZoom;
  const fovDeg = computeFovDegrees(viewMode, activeZoom, canvasWidth, canvasHeight);

  return (
    <div
      className="absolute z-10 flex flex-col items-end"
      style={{ top: 16, right: 14, gap: 28 }}
    >
      <StatChip value={formatFov(fovDeg)} label="FOV" tone="var(--color-ink)" />

      {/* The FOV chip stands on its own; the per-tab count chips and the
          render-toggle chips cluster below with the normal 6 px spacing. */}
      <div className="flex flex-col items-end" style={{ gap: 6 }}>
        {catalogTab === "satellites" && (
          <>
            <StatChip
              value={positions.filter((p) => p.alt > 0).length}
              label="above horizon"
              tone="var(--color-sage)"
            />
            <StatChip
              value={
                positions.filter(
                  (p) =>
                    p.alt <= 0 &&
                    p.riseInMinutes !== null &&
                    p.riseInMinutes <= RISE_SOON_MINUTES,
                ).length
              }
              label={`rising < ${RISE_SOON_MINUTES}m`}
              tone="var(--color-terracotta)"
            />
            <StatChip
              value={tles.length}
              label="tracked"
              tone="var(--color-brass)"
            />
          </>
        )}
        {catalogTab === "stars" && (
          <>
            <StatChip
              value={starAlts.filter((s) => s.alt > 0).length}
              label="above horizon"
              tone="var(--color-sage)"
            />
            <StatChip
              value={catalog?.stars.length ?? 0}
              label="in catalog"
              tone="var(--color-brass)"
            />
          </>
        )}
        {catalogTab === "horizons" && selectedHorizonsTarget && (
          <StatChip value={selectedHorizonsTarget.name} label="" tone="var(--color-sage)" />
        )}

        {viewMode === "sky" && (
          <div className="flex gap-1 mt-1">
            <ToggleChip
              label="Constellations"
              glyph="✧"
              active={showConstellations}
              onClick={toggleConstellations}
            />
            <ToggleChip
              label="Solar system"
              glyph="☉"
              active={showSolarSystem}
              onClick={toggleSolarSystem}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function StatChip({
  value,
  label,
  tone,
}: {
  value: number | string;
  label: string;
  tone: string;
}) {
  return (
    <div
      className="flex items-baseline"
      style={{
        gap: 9,
        padding: "4px 11px",
        background: "rgba(244,234,212,0.96)",
        color: "var(--color-ink)",
        border: "1px solid rgba(184,138,63,0.4)",
        borderRadius: 2,
        boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
      }}
    >
      <span
        className="mono"
        style={{ color: tone, fontSize: 15, fontWeight: 600 }}
      >
        {value}
      </span>
      {label && (
        <span style={{ fontSize: 10.5, color: "var(--color-paper-dim)" }}>
          {label}
        </span>
      )}
    </div>
  );
}

/**
 * Render an FOV in degrees with a precision that matches its magnitude:
 * whole degrees when the visible sky is wide, finer resolution as the user
 * zooms in. ≥360° is reported as "≥360°" since the projection clips there.
 */
function formatFov(deg: number): string {
  if (deg >= 360) return "≥360°";
  if (deg >= 10) return `${Math.round(deg)}°`;
  if (deg >= 1) return `${deg.toFixed(1)}°`;
  if (deg >= 0.1) return `${deg.toFixed(2)}°`;
  return `${deg.toFixed(3)}°`;
}

function ToggleChip({
  label,
  glyph,
  active,
  onClick,
}: {
  label: string;
  glyph: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} · ${active ? "on" : "off"}`}
      aria-pressed={active}
      style={{
        width: 24,
        height: 24,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        lineHeight: 1,
        background: active ? "rgba(184,138,63,0.16)" : "rgba(244,234,212,0.96)",
        color: active ? "var(--color-brass)" : "var(--color-paper-dim)",
        border: `1px solid ${active ? "var(--color-brass)" : "rgba(184,138,63,0.4)"}`,
        borderRadius: 2,
        boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
        cursor: "pointer",
      }}
    >
      {glyph}
    </button>
  );
}
