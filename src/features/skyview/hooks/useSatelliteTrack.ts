import { useMemo } from "react";
import { twoline2satrec, propagate, gstime, eciToEcf } from "satellite.js";
import { useSatelliteStore } from "../../../stores/satellites";
import type { ObserverLocation } from "./useObserver";

export interface TrackPoint {
  ra: number;
  dec: number;
  alt: number;
  time: number; // offset from now in minutes
}

/**
 * Compute the orbital track for a selected satellite using topocentric RA/Dec.
 */
export function useSatelliteTrack(
  selectedId: string | null,
  observer: ObserverLocation,
): TrackPoint[] {
  const tles = useSatelliteStore((s) => s.tles);

  return useMemo(() => {
    if (!selectedId) return [];

    const tle = tles.find((t) => t.noradId === selectedId);
    if (!tle) return [];

    try {
      const satrec = twoline2satrec(tle.line1, tle.line2);

      // Precompute observer constants
      const latRad = (observer.lat * Math.PI) / 180;
      const lonRad = (observer.lon * Math.PI) / 180;
      const sinLat = Math.sin(latRad);
      const cosLat = Math.cos(latRad);
      const sinLon = Math.sin(lonRad);
      const cosLon = Math.cos(lonRad);
      const earthRadius = 6371;
      const obsR = earthRadius + observer.alt / 1000;
      const obsEcfX = obsR * cosLat * cosLon;
      const obsEcfY = obsR * cosLat * sinLon;
      const obsEcfZ = obsR * sinLat;

      // Time span based on mean motion
      const meanMotion = parseFloat(tle.line2.substring(52, 63).trim());
      const periodMin = 1440 / Math.max(0.1, meanMotion);
      const halfSpanMin = periodMin * 0.5; // full orbit
      const steps = 300;
      const stepMin = (halfSpanMin * 2) / steps;

      const now = Date.now();
      const points: TrackPoint[] = [];

      for (let i = 0; i <= steps; i++) {
        const offsetMin = -halfSpanMin + i * stepMin;
        const t = new Date(now + offsetMin * 60000);

        const result = propagate(satrec, t);
        if (typeof result.position === "boolean") continue;

        const posEci = result.position;
        const gmst = gstime(t);

        // Topocentric: observer ECI from ECF rotated by GMST
        const cosGmst = Math.cos(gmst);
        const sinGmst = Math.sin(gmst);
        const obsEciX = obsEcfX * cosGmst - obsEcfY * sinGmst;
        const obsEciY = obsEcfX * sinGmst + obsEcfY * cosGmst;
        const obsEciZ = obsEcfZ;

        // Topocentric vector (observer → satellite) in ECI
        const topoX = posEci.x - obsEciX;
        const topoY = posEci.y - obsEciY;
        const topoZ = posEci.z - obsEciZ;
        const topoR = Math.sqrt(topoX ** 2 + topoY ** 2 + topoZ ** 2);

        // Topocentric RA/Dec
        const dec = Math.asin(topoZ / topoR) * (180 / Math.PI);
        let ra = Math.atan2(topoY, topoX) * (180 / Math.PI);
        if (ra < 0) ra += 360;

        // Alt from ECF
        const ecf = eciToEcf(posEci, gmst);
        const dx = ecf.x - obsEcfX;
        const dy = ecf.y - obsEcfY;
        const dz = ecf.z - obsEcfZ;
        const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const topZ = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
        const alt = Math.asin(topZ / range) * (180 / Math.PI);

        points.push({ ra, dec, alt, time: offsetMin });
      }

      return points;
    } catch {
      return [];
    }
  }, [selectedId, tles, observer]);
}
