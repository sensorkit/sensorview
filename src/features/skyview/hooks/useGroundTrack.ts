import { useMemo } from "react";
import { twoline2satrec, propagate, gstime, eciToGeodetic } from "satellite.js";
import { useSatelliteStore } from "../../../stores/satellites";

export interface GroundTrackPoint {
  lat: number;
  lon: number;
  altitude: number;
  time: number; // offset from now in minutes
}

/**
 * Compute the ground track for a selected satellite as geodetic lat/lon points.
 */
export function useGroundTrack(selectedId: string | null): GroundTrackPoint[] {
  const tles = useSatelliteStore((s) => s.tles);

  return useMemo(() => {
    if (!selectedId) return [];

    const tle = tles.find((t) => t.noradId === selectedId);
    if (!tle) return [];

    try {
      const satrec = twoline2satrec(tle.line1, tle.line2);

      // Time span based on mean motion — show a full orbit
      const meanMotion = parseFloat(tle.line2.substring(52, 63).trim());
      const periodMin = 1440 / Math.max(0.1, meanMotion);
      const halfSpanMin = periodMin * 0.5; // full orbit
      const steps = 300;
      const stepMin = (halfSpanMin * 2) / steps;

      const now = Date.now();
      const points: GroundTrackPoint[] = [];

      for (let i = 0; i <= steps; i++) {
        const offsetMin = -halfSpanMin + i * stepMin;
        const t = new Date(now + offsetMin * 60000);

        const result = propagate(satrec, t);
        if (typeof result.position === "boolean") continue;

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
