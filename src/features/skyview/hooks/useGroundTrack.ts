import { useMemo } from "react";
import { gstime, eciToGeodetic } from "satellite.js";
import {
  sameSatKey,
  satKeyOf,
  useSatelliteStore,
  type SatKey,
} from "../../../stores/satellites";
import { eciStateAt, orbitalPeriodMinutes } from "../propagation/ephemeris";

export interface GroundTrackPoint {
  lat: number;
  lon: number;
  altitude: number;
  time: number; // offset from now in minutes
}

/**
 * Compute the ground track for a selected satellite as geodetic lat/lon points.
 */
export function useGroundTrack(selectedId: SatKey | null): GroundTrackPoint[] {
  const tles = useSatelliteStore((s) => s.tles);

  return useMemo(() => {
    if (!selectedId) return [];

    const tle = tles.find((t) => sameSatKey(satKeyOf(t), selectedId));
    if (!tle) return [];

    try {
      // Time span is one full orbit, however the period is derived.
      const periodMin = orbitalPeriodMinutes(tle);
      const halfSpanMin = periodMin * 0.5;
      const steps = 300;
      const stepMin = (halfSpanMin * 2) / steps;

      const now = Date.now();
      const points: GroundTrackPoint[] = [];

      for (let i = 0; i <= steps; i++) {
        const offsetMin = -halfSpanMin + i * stepMin;
        const t = new Date(now + offsetMin * 60000);

        const result = eciStateAt(tle, t);
        if (!result) continue;

        const gmst = gstime(t);
        const geo = eciToGeodetic(result.position, gmst);

        points.push({
          lat: geo.latitude * (180 / Math.PI),
          lon: geo.longitude * (180 / Math.PI),
          altitude: geo.height,
          time: offsetMin,
        });
      }

      return points;
    } catch {
      return [];
    }
  }, [selectedId, tles]);
}
