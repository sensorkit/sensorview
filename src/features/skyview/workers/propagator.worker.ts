import {
  twoline2satrec,
  propagate,
  gstime,
  eciToEcf,
  eciToGeodetic,
} from "satellite.js";
import type { ElementSetKind, SatellitePosition } from "../../../stores/satellites";
import { propagateStateVector, type StateVectorKm } from "../propagation/kepler";

interface TLEInput {
  kind?: "tle";
  noradId: string;
  name: string;
  line1: string;
  line2: string;
}

interface SVInput {
  kind: "sv";
  noradId: string;
  name: string;
  epoch: string;
  frame: string;
  r: { x: number; y: number; z: number };
  v: { x: number; y: number; z: number };
}

type PropagatorInput = TLEInput | SVInput;

interface Observer {
  lat: number;
  lon: number;
  alt: number;
}

/** ECI position/velocity in km and km/s, whatever the underlying element set. */
interface EciState {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
}

/**
 * A catalog object reduced to "give me its ECI state at time t". TLEs go
 * through SGP4; state vectors through two-body propagation from their epoch.
 *
 * Frame caveat: SGP4 emits TEME, while uploaded state vectors are typically
 * GCRF. The two differ by precession/nutation — a few tenths of a degree at
 * present — and that offset is NOT corrected here, so an SV object's plotted
 * position carries it. It is far smaller than the error from propagating a
 * days-old state vector without perturbations, and it does not affect
 * pointing: SensorKit receives the state vector with its own frame tag and
 * does the rigorous transform itself.
 */
interface PropEntry {
  kind: ElementSetKind;
  noradId: string;
  name: string;
  at: (date: Date) => EciState | null;
}

function tleEntry(input: TLEInput): PropEntry | null {
  try {
    const satrec = twoline2satrec(input.line1, input.line2);
    return {
      kind: "tle",
      noradId: input.noradId,
      name: input.name,
      at: (date) => {
        const result = propagate(satrec, date);
        if (typeof result.position === "boolean" || typeof result.velocity === "boolean") {
          return null;
        }
        return { position: result.position, velocity: result.velocity };
      },
    };
  } catch {
    return null;
  }
}

function svEntry(input: SVInput): PropEntry | null {
  const epochMs = new Date(input.epoch).getTime();
  if (!Number.isFinite(epochMs)) return null;
  const state: StateVectorKm = { r: input.r, v: input.v };
  return {
    kind: "sv",
    noradId: input.noradId,
    name: input.name,
    at: (date) => {
      const next = propagateStateVector(state, (date.getTime() - epochMs) / 1000);
      return next && { position: next.r, velocity: next.v };
    },
  };
}

function toEntry(input: PropagatorInput): PropEntry | null {
  return input.kind === "sv" ? svEntry(input) : tleEntry(input as TLEInput);
}

/** Keyed by `${kind}:${noradId}` — a NORAD id alone is no longer unique. */
let satrecCache: Map<string, PropEntry> = new Map();

const cacheKey = (kind: ElementSetKind, noradId: string) => `${kind}:${noradId}`;

// Cached rise/set/maxAlt — persisted between ticks, ticked down each second
let riseSetCache: Map<string, { rise: number | null; set: number | null; maxAlt: number | null }> = new Map();
let lastRiseSetTime = 0;
let riseSetBatch = 0; // which 1/10th batch to compute this tick

// Precomputed observer constants
let sinLat = 0, cosLat = 0, sinLon = 0, cosLon = 0;
let obsEcfX = 0, obsEcfY = 0, obsEcfZ = 0;

function setupObserver(observer: Observer) {
  const latRad = (observer.lat * Math.PI) / 180;
  const lonRad = (observer.lon * Math.PI) / 180;
  sinLat = Math.sin(latRad);
  cosLat = Math.cos(latRad);
  sinLon = Math.sin(lonRad);
  cosLon = Math.cos(lonRad);
  const earthRadius = 6371;
  const obsR = earthRadius + observer.alt / 1000;
  obsEcfX = obsR * cosLat * cosLon;
  obsEcfY = obsR * cosLat * sinLon;
  obsEcfZ = obsR * sinLat;
}

/** Compute topocentric Alt/Az and RA/Dec from ECI satellite position */
function topocentricFromEci(
  satEci: { x: number; y: number; z: number },
  gmst: number,
) {
  // Observer ECF → ECI (rotate by GMST)
  const cosGmst = Math.cos(gmst);
  const sinGmst = Math.sin(gmst);
  const obsEciX = obsEcfX * cosGmst - obsEcfY * sinGmst;
  const obsEciY = obsEcfX * sinGmst + obsEcfY * cosGmst;
  const obsEciZ = obsEcfZ;

  // Topocentric vector in ECI (observer → satellite)
  const topoEciX = satEci.x - obsEciX;
  const topoEciY = satEci.y - obsEciY;
  const topoEciZ = satEci.z - obsEciZ;
  const topoR = Math.sqrt(topoEciX ** 2 + topoEciY ** 2 + topoEciZ ** 2);

  // Topocentric RA/Dec (apparent position in the sky)
  const dec = Math.asin(topoEciZ / topoR) * (180 / Math.PI);
  let ra = Math.atan2(topoEciY, topoEciX) * (180 / Math.PI);
  if (ra < 0) ra += 360;

  // Alt/Az from ECF topocentric vector
  const ecf = eciToEcf(satEci, gmst);
  const dx = ecf.x - obsEcfX;
  const dy = ecf.y - obsEcfY;
  const dz = ecf.z - obsEcfZ;
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const topS = sinLat * cosLon * dx + sinLat * sinLon * dy - cosLat * dz;
  const topE = -sinLon * dx + cosLon * dy;
  const topZ = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;

  const alt = Math.asin(topZ / range) * (180 / Math.PI);
  let az = Math.atan2(-topE, topS) * (180 / Math.PI) + 180;
  if (az >= 360) az -= 360;

  return { ra, dec, alt, az, range };
}

function computeAltAt(entry: PropEntry, date: Date): number | null {
  const result = entry.at(date);
  if (!result) return null;
  const gmst = gstime(date);
  const { alt } = topocentricFromEci(result.position, gmst);
  return alt;
}

function computeRiseSetMax(
  entry: PropEntry,
  nowMs: number,
  currentAlt: number,
): { riseInMinutes: number | null; setInMinutes: number | null; maxAlt: number | null } {
  const stepMs = 30_000;
  const maxMs = 45 * 60_000;

  if (currentAlt > 0) {
    // Currently visible — scan forward for set time and max alt this pass
    let peakAlt = currentAlt;
    for (let dt = stepMs; dt <= maxMs; dt += stepMs) {
      const alt = computeAltAt(entry, new Date(nowMs + dt));
      if (alt === null || alt < 0) {
        return { riseInMinutes: null, setInMinutes: dt / 60_000, maxAlt: peakAlt };
      }
      if (alt > peakAlt) peakAlt = alt;
    }
    return { riseInMinutes: null, setInMinutes: null, maxAlt: peakAlt };
  } else if (currentAlt > -15) {
    // Near horizon — scan forward for rise, then continue for max alt and set
    let riseMin: number | null = null;
    let peakAlt = 0;
    for (let dt = stepMs; dt <= maxMs; dt += stepMs) {
      const alt = computeAltAt(entry, new Date(nowMs + dt));
      if (alt === null) return { riseInMinutes: null, setInMinutes: null, maxAlt: null };
      if (riseMin === null && alt > 0) {
        riseMin = dt / 60_000;
        peakAlt = alt;
      } else if (riseMin !== null) {
        if (alt > peakAlt) peakAlt = alt;
        if (alt < 0) {
          return { riseInMinutes: riseMin, setInMinutes: null, maxAlt: peakAlt };
        }
      }
    }
    return { riseInMinutes: riseMin, setInMinutes: null, maxAlt: riseMin !== null ? peakAlt : null };
  }

  return { riseInMinutes: null, setInMinutes: null, maxAlt: null };
}

self.onmessage = (event: MessageEvent) => {
  const { type } = event.data;

  if (type === "setTLEs") {
    const { tles } = event.data as { tles: PropagatorInput[] };
    satrecCache = new Map();
    riseSetCache = new Map();
    for (const input of tles) {
      const entry = toEntry(input);
      if (entry) satrecCache.set(cacheKey(entry.kind, entry.noradId), entry);
    }
    lastRiseSetTime = 0;
  }

  if (type === "addTLE") {
    const { tle } = event.data as { tle: PropagatorInput };
    const key = cacheKey(tle.kind === "sv" ? "sv" : "tle", tle.noradId);
    if (!satrecCache.has(key)) {
      const entry = toEntry(tle);
      if (entry) satrecCache.set(key, entry);
    }
  }

  if (type === "propagate") {
    const { observer, time, computeRiseSet, computeGeodetic } = event.data as {
      observer: Observer; time: number; computeRiseSet: boolean; computeGeodetic?: boolean;
    };
    const now = new Date(time);
    const gmst = gstime(now);
    setupObserver(observer);

    // Tick down cached rise/set times
    const elapsedMin = lastRiseSetTime > 0 ? (time - lastRiseSetTime) / 60_000 : 0;

    // Stagger: compute rise/set for 1/40th of satellites each tick (full cycle = 40s)
    const BATCHES = 40;
    const currentBatch = computeRiseSet ? riseSetBatch : -1;
    if (computeRiseSet) {
      riseSetBatch = (riseSetBatch + 1) % BATCHES;
      lastRiseSetTime = time;
    }

    const positions: SatellitePosition[] = [];
    let idx = 0;

    for (const [key, entry] of satrecCache) {
      const satBatch = idx % BATCHES;
      idx++;

      try {
        const result = entry.at(now);
        if (!result) continue;

        const { ra, dec, alt, az, range } = topocentricFromEci(result.position, gmst);
        const velocity = Math.sqrt(
          result.velocity.x ** 2 + result.velocity.y ** 2 + result.velocity.z ** 2,
        );

        let riseInMinutes: number | null = null;
        let setInMinutes: number | null = null;
        let maxAlt: number | null = null;

        if (computeRiseSet && satBatch === currentBatch && alt > -15) {
          const rs = computeRiseSetMax(entry, time, alt);
          riseInMinutes = rs.riseInMinutes;
          setInMinutes = rs.setInMinutes;
          maxAlt = rs.maxAlt;
          riseSetCache.set(key, { rise: riseInMinutes, set: setInMinutes, maxAlt });
        } else {
          const cached = riseSetCache.get(key);
          if (cached) {
            riseInMinutes = cached.rise !== null ? Math.max(0, cached.rise - elapsedMin) : null;
            setInMinutes = cached.set !== null ? Math.max(0, cached.set - elapsedMin) : null;
            if (riseInMinutes !== null && riseInMinutes <= 0) riseInMinutes = null;
            if (setInMinutes !== null && setInMinutes <= 0) setInMinutes = null;
            maxAlt = cached.maxAlt;
          }
        }

        // C: the sky view (no geodetic) only draws/lists satellites that are
        // above the horizon or rising soon. Ship just those so the main thread
        // transfers + scans ~200 objects/tick instead of the full ~2000. The
        // overhead/groundtrack views set computeGeodetic and still get everything.
        // (rise/set is already computed above and cached, so this stays correct as
        // sats approach the horizon.)
        if (!computeGeodetic && alt <= 0 && !(riseInMinutes !== null && riseInMinutes <= 15)) {
          continue;
        }

        const pos: SatellitePosition = {
          kind: entry.kind, noradId: entry.noradId, ra, dec, alt, az,
          isVisible: alt > 0,
          range, velocity,
          riseInMinutes, setInMinutes, maxAlt,
        };

        if (computeGeodetic) {
          const geo = eciToGeodetic(result.position, gmst);
          pos.lat = geo.latitude * (180 / Math.PI);
          pos.lon = geo.longitude * (180 / Math.PI);
          pos.satAlt = geo.height;
        }

        positions.push(pos);
      } catch { /* skip */ }
    }

    self.postMessage(positions);
  }
};
