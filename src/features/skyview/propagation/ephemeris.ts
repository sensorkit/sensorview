/**
 * Kind-agnostic propagation for catalog objects.
 *
 * TLE-backed objects go through SGP4; state-vector-backed objects through
 * two-body propagation from their epoch. Callers that just want "where is
 * this object at time t" should use this rather than branching on `kind`
 * themselves.
 *
 * The propagator worker deliberately keeps its own copy of this branching: it
 * builds one closure per object up front so the per-tick hot loop never
 * re-parses a TLE. This module is for the lower-frequency paths — orbit
 * tracks, ground tracks — where clarity matters more than the last allocation.
 */
import { twoline2satrec, propagate } from "satellite.js";
import { isSV, type CatalogRecord } from "../../../stores/satellites";
import { propagateStateVector } from "./kepler";

/** Earth's standard gravitational parameter, km^3/s^2. */
const MU_EARTH = 398600.4418;

export interface EciState {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
}

/**
 * ECI state at `date`, or null if the object can't be propagated there.
 *
 * Frame note: SGP4 yields TEME and state vectors are usually GCRF. The
 * difference (precession/nutation, a few tenths of a degree) is not corrected
 * — see the propagator worker for why that is acceptable for display and
 * irrelevant to pointing.
 */
export function eciStateAt(record: CatalogRecord, date: Date): EciState | null {
  if (isSV(record)) {
    const epochMs = new Date(record.epoch).getTime();
    if (!Number.isFinite(epochMs)) return null;
    const next = propagateStateVector(
      { r: record.r, v: record.v },
      (date.getTime() - epochMs) / 1000,
    );
    return next && { position: next.r, velocity: next.v };
  }
  try {
    const result = propagate(twoline2satrec(record.line1, record.line2), date);
    if (typeof result.position === "boolean" || typeof result.velocity === "boolean") {
      return null;
    }
    return { position: result.position, velocity: result.velocity };
  } catch {
    return null;
  }
}

/**
 * Orbital period in minutes — the natural span for drawing one full track.
 * Read from mean motion for a TLE, and from the vis-viva semi-major axis for
 * a state vector. Falls back to 90 minutes if the elements are unusable.
 */
export function orbitalPeriodMinutes(record: CatalogRecord): number {
  if (isSV(record)) {
    const r = Math.hypot(record.r.x, record.r.y, record.r.z);
    const vSq = record.v.x ** 2 + record.v.y ** 2 + record.v.z ** 2;
    const invA = 2 / r - vSq / MU_EARTH;
    if (!(invA > 0)) return 90; // escape trajectory — no period to draw
    const a = 1 / invA;
    return (2 * Math.PI * Math.sqrt(a ** 3 / MU_EARTH)) / 60;
  }
  const meanMotion = parseFloat(record.line2.substring(52, 63).trim());
  if (!Number.isFinite(meanMotion) || meanMotion <= 0) return 90;
  return 1440 / Math.max(0.1, meanMotion);
}
