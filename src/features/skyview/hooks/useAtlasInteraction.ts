import { useCallback, useMemo } from "react";
import { quadtree, type Quadtree } from "d3-quadtree";
import type { GeoProjection } from "d3-geo";
import {
  parseSatKeyId,
  satKeyId,
  type SatellitePosition,
} from "../../../stores/satellites";
import type { StarCatalog } from "../catalog/stars";
import { celestialToScreen } from "../projection";
import { useSkyViewStore } from "../../../stores/skyview";
import type { SolarBody } from "./useSolarSystemBodies";

const TAP_RADIUS_DESKTOP = 14;
const TAP_RADIUS_MOBILE = 24;

interface ScreenItem {
  x: number;
  y: number;
  /** "tle:NORAD"/"sv:NORAD" for catalog objects, "star:INDEX", "body:NAME". */
  id: string;
}

export function useAtlasInteraction(
  positions: SatellitePosition[],
  projection: GeoProjection,
  catalog: StarCatalog | null,
  bodies: SolarBody[],
  /**
   * Magnitude cap for clickable stars. Limits how deep into the catalog
   * the quadtree indexes — keeps `tree.find()` cheap and avoids stealing
   * clicks with super-faint stars the user can barely see anyway. Caller
   * scales this with current FOV: wider FOV → brighter cap; narrower FOV
   * → fainter cap (more stars become tappable as you zoom in).
   */
  starMagLimit: number,
) {
  const { selectSatellite, selectStar, selectBody, clearManualTarget } = useSkyViewStore();

  const tree: Quadtree<ScreenItem> = useMemo(() => {
    const items: ScreenItem[] = [];

    // Solar-system bodies — always clickable when visible
    for (const body of bodies) {
      const pos = celestialToScreen(projection, body.ra, body.dec);
      if (!pos) continue;
      items.push({ x: pos[0], y: pos[1], id: `body:${body.name}` });
    }

    // Satellites
    for (const sat of positions) {
      const pos = celestialToScreen(projection, sat.ra, sat.dec);
      if (!pos) continue;
      items.push({ x: pos[0], y: pos[1], id: satKeyId(sat) });
    }

    // Stars: always clickable, capped by magnitude. Catalog is sorted
    // brightest-first so we can `break` as soon as we cross the cap.
    // StarRecord = [id, ra_deg, dec_deg, mag, spectral_class | null]
    if (catalog) {
      for (let i = 0; i < catalog.stars.length; i++) {
        const [, ra, dec, mag] = catalog.stars[i]!;
        if (mag > starMagLimit) break;
        const pos = celestialToScreen(projection, ra, dec);
        if (!pos) continue;
        items.push({ x: pos[0], y: pos[1], id: `star:${i}` });
      }
    }

    return quadtree<ScreenItem>()
      .x((d) => d.x)
      .y((d) => d.y)
      .addAll(items);
  }, [positions, projection, catalog, bodies, starMagLimit]);

  const findNearest = useCallback(
    (clientX: number, clientY: number, rect: DOMRect) => {
      const isTouchDevice = "ontouchstart" in window;
      const tapRadius = isTouchDevice ? TAP_RADIUS_MOBILE : TAP_RADIUS_DESKTOP;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      return tree.find(x, y, tapRadius) ?? null;
    },
    [tree],
  );

  /** Call this with screen coordinates (relative to container) to select the nearest item */
  const handleClickAt = useCallback(
    (x: number, y: number, _rect: DOMRect) => {
      const isTouchDevice = "ontouchstart" in window;
      const tapRadius = isTouchDevice ? TAP_RADIUS_MOBILE : TAP_RADIUS_DESKTOP;
      const nearest = tree.find(x, y, tapRadius) ?? null;

      if (!nearest) {
        selectSatellite(null);
        selectStar(null);
        selectBody(null);
        clearManualTarget();
      } else if (nearest.id.startsWith("star:")) {
        selectStar(parseInt(nearest.id.slice(5)));
      } else if (nearest.id.startsWith("body:")) {
        selectBody(nearest.id.slice(5));
      } else {
        selectSatellite(parseSatKeyId(nearest.id));
      }
    },
    [findNearest, selectSatellite, selectStar, selectBody, clearManualTarget],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const nearest = findNearest(event.clientX, event.clientY, rect);
      const el = event.currentTarget as HTMLElement;
      el.style.cursor = nearest ? "crosshair" : "grab";
    },
    [findNearest],
  );

  return { handleClickAt, handleMouseMove };
}
