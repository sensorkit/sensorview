import { useMemo } from "react";
import { useSensorKitSlice } from "../../../stores/sensorkit";

export interface ObserverLocation {
  lat: number;
  lon: number;
  alt: number;
  name: string;
}

// Fallback observer until SensorKit reports SitePosition
const DEFAULT_OBSERVER: ObserverLocation = {
  lat: 20.7084,
  lon: -156.2568,
  alt: 3055,
  name: "Haleakala, Maui",
};

/**
 * SK reports the entity kind via `EntityInfo.entity_type` (current shape).
 * Older SK builds put it at top-level `type` — accept either so the same
 * SensorView build works across SK versions during the rollout window.
 */
function isController(entityState: Record<string, unknown>): boolean {
  const info = entityState["EntityInfo"] as
    | { entity_type?: string }
    | undefined;
  if (info?.entity_type === "controller") return true;
  if ((entityState as { type?: string }).type === "controller") return true;
  return false;
}

/**
 * Compute Greenwich Mean Sidereal Time in degrees for a given Date.
 */
export function gmstDegrees(date: Date): number {
  const jd =
    date.getTime() / 86400000 + 2440587.5; // Julian Date from Unix epoch
  const T = (jd - 2451545.0) / 36525.0; // Julian centuries since J2000
  // GMST in degrees (IAU formula)
  let gmst =
    280.46061837 +
    360.98564736629 * (jd - 2451545.0) +
    0.000387933 * T * T -
    (T * T * T) / 38710000;
  gmst = ((gmst % 360) + 360) % 360;
  return gmst;
}

/**
 * Compute Local Sidereal Time in degrees for an observer.
 */
export function lstDegrees(date: Date, lonDeg: number): number {
  const gmst = gmstDegrees(date);
  return ((gmst + lonDeg) % 360 + 360) % 360;
}

/**
 * Get the RA/Dec of the zenith for an observer at a given time.
 * Zenith RA = LST, Zenith Dec = observer latitude.
 */
export function zenithRADec(
  date: Date,
  observer: ObserverLocation,
): { ra: number; dec: number } {
  const ra = lstDegrees(date, observer.lon);
  return { ra, dec: observer.lat };
}

/**
 * Convert RA/Dec (degrees, ICRF) to topocentric alt/az (degrees) for an observer.
 * Az measured from North through East (0=N, 90=E, 180=S, 270=W).
 */
export function radecToAltAz(
  date: Date,
  observer: ObserverLocation,
  ra: number,
  dec: number,
): { alt: number; az: number } {
  const lst = lstDegrees(date, observer.lon);
  const ha = ((lst - ra + 360) % 360) * (Math.PI / 180);
  const latRad = (observer.lat * Math.PI) / 180;
  const decRad = (dec * Math.PI) / 180;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);

  const sinAlt = sinLat * Math.sin(decRad) + cosLat * Math.cos(decRad) * Math.cos(ha);
  const altRad = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAz = (Math.sin(decRad) - sinLat * sinAlt) / (cosLat * Math.cos(altRad));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) * (180 / Math.PI);
  if (Math.sin(ha) > 0) az = 360 - az;
  return { alt: altRad * (180 / Math.PI), az };
}

/**
 * Hook that provides the observer location and current zenith.
 *
 * `SitePosition` is read exclusively from the **controller** entity. Some
 * mount modules (e.g. alpaca) also republish their underlying driver's site
 * coords, but those reflect whatever the vendor driver was configured with
 * — which is often wrong (units, stale values). The controller is the
 * operator-configured source of truth and is mount-agnostic, so we ignore
 * device-level SitePosition entirely.
 *
 * Falls back to the hardcoded default when no controller has published yet.
 */
export function useObserver() {
  // Subscribe to the derived observer location — NOT the whole `state` map.
  // This hook is mounted by AppLayout and AtlasContainer (i.e. the entire
  // SkyView tree hangs off it): a whole-state subscription re-rendered all
  // of it on every telemetry record, which was the dominant share of the
  // renderer-pegging reconciliation storm. The slice's equality compare also
  // keeps the returned identity stable, which downstream `useMemo([…,
  // observer])` consumers rely on — most importantly `useStarAltitudes`,
  // which recomputes alt/az for every catalog star (≈118k rows on HIP) and
  // is mounted in three places. The site essentially never moves during a
  // session, so this hook now re-renders ~never while streaming.
  const observer = useSensorKitSlice<ObserverLocation>(
    (s) => {
      for (const [entityKey, entityState] of Object.entries(s.state)) {
        if (!isController(entityState)) continue;
        const sp = entityState["SitePosition"] as
          | { latitude_degrees: number; longitude_degrees: number; altitude_km: number }
          | undefined;
        if (sp) {
          return {
            lat: sp.latitude_degrees,
            lon: sp.longitude_degrees,
            alt: sp.altitude_km * 1000,
            name: entityKey,
          };
        }
      }
      return DEFAULT_OBSERVER;
    },
    // Object.is, not ===: a NaN field (e.g. malformed SitePosition) would
    // make === report "changed" on every compare, and an equality fn that
    // never says "equal" turns this subscription into an infinite render
    // loop that hard-pegs the main thread.
    (a, b) =>
      Object.is(a.lat, b.lat) &&
      Object.is(a.lon, b.lon) &&
      Object.is(a.alt, b.alt) &&
      a.name === b.name,
  );

  const zenith = useMemo(() => zenithRADec(new Date(), observer), [observer]);

  return { observer, zenith };
}
