import { useMemo } from "react";
import { type StarCatalog, getStarLabel } from "../catalog/stars";
import { lstDegrees } from "./useObserver";
import type { ObserverLocation } from "./useObserver";

export interface StarWithAlt {
  /** Index into catalog.stars (NOT the catalog id; see `id`). */
  index: number;
  /** Catalog id — HR number for BSC5, HIP number for Hipparcos. */
  id: number;
  /** Proper name when available, else the bare catalog id formatted. */
  label: string;
  /** Same as `label` today; kept separate so callers can diverge later. */
  name: string | null;
  ra: number;
  dec: number;
  mag: number;
  spec: string | null;
  alt: number;
  az: number;
}

/**
 * Compute altitude/azimuth for all catalog stars from the observer's location.
 */
export function useStarAltitudes(
  catalog: StarCatalog | null,
  observer: ObserverLocation,
): StarWithAlt[] {
  return useMemo(() => {
    if (!catalog) return [];

    const now = new Date();
    const lst = lstDegrees(now, observer.lon);
    const latRad = (observer.lat * Math.PI) / 180;
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);

    const result: StarWithAlt[] = [];

    for (let i = 0; i < catalog.stars.length; i++) {
      const [id, ra, dec, mag, spec] = catalog.stars[i]!;

      // Hour angle
      const ha = ((lst - ra + 360) % 360) * (Math.PI / 180);
      const decRad = (dec * Math.PI) / 180;

      // Altitude
      const sinAlt = sinLat * Math.sin(decRad) + cosLat * Math.cos(decRad) * Math.cos(ha);
      const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * (180 / Math.PI);

      // Azimuth
      const cosAz = (Math.sin(decRad) - sinLat * sinAlt) / (cosLat * Math.cos(Math.asin(sinAlt)));
      let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) * (180 / Math.PI);
      if (Math.sin(ha) > 0) az = 360 - az;

      result.push({
        index: i,
        id,
        label: getStarLabel(catalog, i),
        name: getStarLabel(catalog, i),
        ra, dec, mag, spec, alt, az,
      });
    }

    return result;
  }, [catalog, observer]);
}
