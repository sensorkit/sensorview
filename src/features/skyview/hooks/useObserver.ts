import { useMemo } from "react";
import {
  isControllerState,
  useSensorKitSlice,
  type SensorKitStore,
} from "../../../stores/sensorkit";
import { useObserverStore } from "../../../stores/observer";
import type { SitePosition } from "../../../lib/sensorkit-client/types";

// Re-exported from its canonical home (the observer store) so the ~15 SkyView
// modules that `import type { ObserverLocation } from "../hooks/useObserver"`
// keep resolving without churn.
export type { ObserverLocation } from "../../../stores/observer";
import type { ObserverLocation } from "../../../stores/observer";

/** Which site SkyView is currently using. Drives the Settings readout. */
export type ObserverSource = "live" | "manual";

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
 * Derive the live SensorKit observing site, or `null` when none is available.
 *
 * `SitePosition` is read exclusively from the **controller** entity. Some
 * mount modules (e.g. alpaca) also republish their underlying driver's site
 * coords, but those reflect whatever the vendor driver was configured with
 * — which is often wrong (units, stale values). The controller is the
 * operator-configured source of truth and is mount-agnostic, so we ignore
 * device-level SitePosition entirely.
 *
 * Gated on a live transport (`connection === "open"`) AND the controller's
 * `EntityLease` — SK forwards a lease delete as `payload: null` and our
 * reducer pops the key, so `"EntityLease" in state[entity]` is the canonical
 * "alive right now" signal. Without this gate a controller that died mid-
 * session would keep imposing its last-known SitePosition on SkyView even
 * though the site is really just whatever the operator wants offline.
 */
function selectLiveSite(state: SensorKitStore): ObserverLocation | null {
  if (state.connection !== "open") return null;
  for (const [entityKey, entityState] of Object.entries(state.state)) {
    if (!isControllerState(entityState)) continue;
    if (!("EntityLease" in entityState)) continue; // liveness gate
    const sp = entityState["SitePosition"] as SitePosition | undefined;
    if (sp) {
      return {
        lat: sp.latitude_degrees,
        lon: sp.longitude_degrees,
        alt: sp.altitude_km * 1000,
        name: entityKey,
      };
    }
  }
  return null;
}

/**
 * Hook that provides the observer location, current zenith, and which source
 * that location came from.
 *
 * Precedence:
 *   1. Operator override on → the manually-configured site (Settings).
 *   2. Otherwise a live controller `SitePosition` if one is available.
 *   3. Otherwise the manual site — the offline fallback that lets SkyView run
 *      with no live SensorKit connection at all.
 *
 * Performance: this hook is mounted by AppLayout and AtlasContainer (the whole
 * SkyView tree hangs off it). The live-site subscription goes through
 * `useSensorKitSlice`, whose equality compare keeps the derived value's
 * identity stable so a per-telemetry-record `state` mutation doesn't re-render
 * the tree. Both `manual` and `overrideSensorKit` come straight from the
 * observer store, whose references only change on an operator edit. The final
 * `useMemo` therefore returns a stable `observer` identity that never changes
 * while streaming — which downstream `useMemo([…, observer])` consumers rely
 * on, most importantly `useStarAltitudes` (alt/az for ≈118k HIP rows, mounted
 * in three places).
 */
export function useObserver(): {
  observer: ObserverLocation;
  zenith: { ra: number; dec: number };
  source: ObserverSource;
} {
  const manual = useObserverStore((s) => s.manual);
  const overrideSensorKit = useObserverStore((s) => s.overrideSensorKit);

  const liveSite = useSensorKitSlice<ObserverLocation | null>(
    selectLiveSite,
    // `a === b` catches the both-null case. Object.is (not ===) on the fields:
    // a NaN in a malformed SitePosition must still compare equal to itself, or
    // an equality fn that never says "equal" turns this into an infinite
    // render loop that hard-pegs the main thread.
    (a, b) =>
      a === b ||
      (!!a &&
        !!b &&
        Object.is(a.lat, b.lat) &&
        Object.is(a.lon, b.lon) &&
        Object.is(a.alt, b.alt) &&
        a.name === b.name),
  );

  const useLive = !overrideSensorKit && liveSite !== null;
  const observer = useMemo(
    () => (useLive ? (liveSite as ObserverLocation) : manual),
    [useLive, liveSite, manual],
  );

  const zenith = useMemo(() => zenithRADec(new Date(), observer), [observer]);

  return { observer, zenith, source: useLive ? "live" : "manual" };
}
