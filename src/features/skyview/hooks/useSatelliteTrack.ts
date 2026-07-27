import { useMemo } from "react";
import { gstime, eciToEcf } from "satellite.js";
import {
  sameSatKey,
  satKeyOf,
  useSatelliteStore,
  type SatKey,
} from "../../../stores/satellites";
import { eciStateAt, orbitalPeriodMinutes } from "../propagation/ephemeris";
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
  selectedId: SatKey | null,
  observer: ObserverLocation,
): TrackPoint[] {
  const tles = useSatelliteStore((s) => s.tles);

  return useMemo(() => {
    if (!selectedId) return [];

    const tle = tles.find((t) => sameSatKey(satKeyOf(t), selectedId));
    if (!tle) return [];

    try {
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

      // Time span is one full orbit, however the period is derived.
      const periodMin = orbitalPeriodMinutes(tle);
      const halfSpanMin = periodMin * 0.5;
      const steps = 300;
      const stepMin = (halfSpanMin * 2) / steps;

      const now = Date.now();
      const points: TrackPoint[] = [];

      for (let i = 0; i <= steps; i++) {
        const offsetMin = -halfSpanMin + i * stepMin;
        const t = new Date(now + offsetMin * 60000);

        const result = eciStateAt(tle, t);
        if (!result) continue;

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
