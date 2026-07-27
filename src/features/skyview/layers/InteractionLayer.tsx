import { useMemo } from "react";
import type { GeoProjection } from "d3-geo";
import type { SatellitePosition } from "../../../stores/satellites";
import { type StarCatalog, getStarLabel } from "../catalog/stars";
import { useSkyViewStore } from "../../../stores/skyview";
import {
  sameSatKey,
  satKeyOf,
  satLabel,
  useSatelliteStore,
} from "../../../stores/satellites";
import { celestialToScreen } from "../projection";

interface Props {
  positions: SatellitePosition[];
  projection: GeoProjection;
  catalog: StarCatalog | null;
  width: number;
  height: number;
  onMouseMove: (event: React.MouseEvent) => void;
}

export function InteractionLayer({
  positions,
  projection,
  catalog,
  width,
  height,
  onMouseMove,
}: Props) {
  const selectedSatId = useSkyViewStore((s) => s.selectedSatellite);
  const selectedStarIdx = useSkyViewStore((s) => s.selectedStarIndex);
  const tles = useSatelliteStore((s) => s.tles);

  // Selected satellite screen position
  const satScreen = useMemo(() => {
    if (!selectedSatId) return null;
    const sat = positions.find((p) => sameSatKey(p, selectedSatId));
    if (!sat) return null;
    const pos = celestialToScreen(projection, sat.ra, sat.dec);
    if (!pos) return null;
    const tle = tles.find((t) => sameSatKey(satKeyOf(t), selectedSatId));
    const name = satLabel(tle, selectedSatId.noradId).text;
    return { x: pos[0], y: pos[1], name, sat };
  }, [positions, selectedSatId, projection, tles]);

  // Selected star screen position
  const starScreen = useMemo(() => {
    if (selectedStarIdx === null || !catalog) return null;
    const star = catalog.stars[selectedStarIdx];
    if (!star) return null;
    // StarRecord = [id, ra_deg, dec_deg, mag, spectral_class | null]
    const [, ra, dec] = star;
    const pos = celestialToScreen(projection, ra, dec);
    if (!pos) return null;
    return { x: pos[0], y: pos[1], name: getStarLabel(catalog, selectedStarIdx) };
  }, [selectedStarIdx, catalog, projection]);

  const selected = satScreen ?? starScreen;
  const isSat = !!satScreen;

  return (
    <div
      className="absolute inset-0"
      style={{ width, height }}
      onMouseMove={onMouseMove}
    >
      {selected && (
        <>
          {/* CSS-animated color pulse */}
          <svg
            className="absolute pointer-events-none"
            width="30"
            height="30"
            style={{
              left: selected.x - 15,
              top: selected.y - 15,
              animation: "sat-pulse 2s ease-in-out infinite",
              overflow: "visible",
            }}
          >
            {isSat ? (
              <>
                <polygon points="15,4 26,15 15,26 4,15" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <polygon points="15,8 22,15 15,22 8,15" fill="currentColor" />
              </>
            ) : (
              <>
                <circle cx="15" cy="15" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="15" cy="15" r="5" fill="currentColor" />
              </>
            )}
          </svg>

          {/* Label — flips to the marker's left when there's no room on the
              right (narrow viewports), so it can't clip under the edge. */}
          <div
            className="absolute pointer-events-none"
            style={
              selected.x + 18 > width - 160
                ? {
                    right: width - selected.x + 18,
                    top: selected.y - 10,
                    transform: "translateY(-50%)",
                  }
                : {
                    left: selected.x + 18,
                    top: selected.y - 10,
                    transform: "translateY(-50%)",
                  }
            }
          >
            <div className="text-xs bg-panel-bg/90 backdrop-blur-sm px-2 py-1 rounded border border-panel-border whitespace-nowrap shadow-lg">
              <div className="font-medium text-star-warm">{selected.name}</div>
              {satScreen && (
                <div className="text-text-dim">
                  Alt {satScreen.sat.alt.toFixed(1)}&deg; Az {satScreen.sat.az.toFixed(1)}&deg;
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <style>{`
        @keyframes sat-pulse {
          0%, 100% { color: #ff9900; }
          50% { color: #ffffff; }
        }
      `}</style>
    </div>
  );
}
