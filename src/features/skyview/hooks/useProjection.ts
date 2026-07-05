import { useMemo } from "react";
import type { GeoProjection } from "d3-geo";
import { createCelestialProjection } from "../projection";
import { useSkyViewStore } from "../../../stores/skyview";

/**
 * Hook that creates a d3 stereographic projection from the current sky view state.
 * Zoom and pan are handled directly in SkyView.tsx via pointer events + d3-zoom.
 */
export function useProjection(
  width: number,
  height: number,
): GeoProjection {
  const { centerRA, centerDec, zoom } = useSkyViewStore();

  return useMemo(
    () => createCelestialProjection(width, height, centerRA, centerDec, zoom),
    [width, height, centerRA, centerDec, zoom],
  );
}
