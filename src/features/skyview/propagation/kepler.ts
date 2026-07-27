/**
 * Two-body (Keplerian) orbit propagation from a state vector.
 *
 * SGP4 propagates TLEs and cannot take a state vector, so catalog objects
 * backed by an uploaded SV need their own propagator. This is the universal-
 * variable formulation (Stumpff functions + Lagrange f/g coefficients), which
 * is singularity-free across circular, elliptical and hyperbolic orbits —
 * unlike the classical eccentric-anomaly route, which divides by eccentricity
 * and blows up on the near-circular GEO objects these files mostly carry.
 *
 * What this deliberately does NOT model: drag, J2 and higher geopotential
 * terms, luni-solar perturbations, or SRP. A state vector is a snapshot, and
 * pure two-body propagation degrades from it — slowly for GEO, fast for LEO.
 * Callers should surface the epoch age rather than imply the result stays
 * accurate. See `stateVectorAgeHours`.
 */

/** Earth's standard gravitational parameter, km^3/s^2 (EGM-96). */
const MU_EARTH = 398600.4418;

const SQRT_MU = Math.sqrt(MU_EARTH);

/** Newton iteration bounds for the universal anomaly. */
const MAX_ITERATIONS = 60;
const TOLERANCE = 1e-9;

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface StateVectorKm {
  /** Position km. */
  r: Vector3;
  /** Velocity km/s. */
  v: Vector3;
}

const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a: Vector3) => Math.sqrt(dot(a, a));

/**
 * Stumpff C(psi). Series expansion near zero avoids catastrophic cancellation
 * in (1 - cos x) / x for small psi.
 */
function stumpffC(psi: number): number {
  if (psi > 1e-6) {
    return (1 - Math.cos(Math.sqrt(psi))) / psi;
  }
  if (psi < -1e-6) {
    const s = Math.sqrt(-psi);
    return (Math.cosh(s) - 1) / -psi;
  }
  // C(psi) = 1/2 - psi/24 + psi^2/720 - ...
  return 0.5 - psi / 24 + (psi * psi) / 720;
}

/** Stumpff S(psi), with the same small-argument treatment. */
function stumpffS(psi: number): number {
  if (psi > 1e-6) {
    const s = Math.sqrt(psi);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (psi < -1e-6) {
    const s = Math.sqrt(-psi);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  // S(psi) = 1/6 - psi/120 + psi^2/5040 - ...
  return 1 / 6 - psi / 120 + (psi * psi) / 5040;
}

/**
 * Propagate a state vector by `dtSeconds` (may be negative). Returns null if
 * the iteration fails to converge or the input isn't a usable orbit — callers
 * should drop the object rather than render a bogus position.
 */
export function propagateStateVector(
  state: StateVectorKm,
  dtSeconds: number,
): StateVectorKm | null {
  const { r: r0v, v: v0v } = state;
  const r0 = norm(r0v);
  const v0 = norm(v0v);

  if (!Number.isFinite(r0) || !Number.isFinite(v0) || r0 <= 0) return null;
  if (dtSeconds === 0) return { r: { ...r0v }, v: { ...v0v } };

  // alpha = 1/a. Positive for closed orbits, ~0 parabolic, negative hyperbolic.
  const alpha = 2 / r0 - (v0 * v0) / MU_EARTH;
  const rv0 = dot(r0v, v0v) / SQRT_MU;

  // Initial guess for the universal anomaly.
  let chi: number;
  if (alpha > 1e-9) {
    chi = SQRT_MU * dtSeconds * alpha;
  } else if (alpha < -1e-9) {
    const a = 1 / alpha;
    const sign = dtSeconds >= 0 ? 1 : -1;
    chi =
      sign *
      Math.sqrt(-a) *
      Math.log(
        (-2 * MU_EARTH * alpha * dtSeconds) /
          (rv0 + sign * Math.sqrt(-MU_EARTH * a) * (1 - r0 * alpha)),
      );
  } else {
    chi = (SQRT_MU * dtSeconds) / r0;
  }
  if (!Number.isFinite(chi)) return null;

  let r = r0;
  let psi = 0;
  let c2 = 0.5;
  let c3 = 1 / 6;
  let converged = false;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    psi = chi * chi * alpha;
    c2 = stumpffC(psi);
    c3 = stumpffS(psi);

    r = chi * chi * c2 + rv0 * chi * (1 - psi * c3) + r0 * (1 - psi * c2);
    if (!Number.isFinite(r) || r <= 0) return null;

    const residual =
      SQRT_MU * dtSeconds -
      chi * chi * chi * c3 -
      rv0 * chi * chi * c2 -
      r0 * chi * (1 - psi * c3);
    const step = residual / r;
    chi += step;
    if (!Number.isFinite(chi)) return null;
    if (Math.abs(step) < TOLERANCE) {
      converged = true;
      break;
    }
  }
  if (!converged) return null;

  // Recompute the closing quantities at the converged anomaly.
  psi = chi * chi * alpha;
  c2 = stumpffC(psi);
  c3 = stumpffS(psi);
  r = chi * chi * c2 + rv0 * chi * (1 - psi * c3) + r0 * (1 - psi * c2);
  if (!Number.isFinite(r) || r <= 0) return null;

  // Lagrange coefficients.
  const f = 1 - (chi * chi * c2) / r0;
  const g = dtSeconds - (chi * chi * chi * c3) / SQRT_MU;
  const gdot = 1 - (chi * chi * c2) / r;
  const fdot = (SQRT_MU / (r * r0)) * chi * (psi * c3 - 1);

  const out: StateVectorKm = {
    r: {
      x: f * r0v.x + g * v0v.x,
      y: f * r0v.y + g * v0v.y,
      z: f * r0v.z + g * v0v.z,
    },
    v: {
      x: fdot * r0v.x + gdot * v0v.x,
      y: fdot * r0v.y + gdot * v0v.y,
      z: fdot * r0v.z + gdot * v0v.z,
    },
  };

  if (
    !Number.isFinite(out.r.x) || !Number.isFinite(out.r.y) || !Number.isFinite(out.r.z) ||
    !Number.isFinite(out.v.x) || !Number.isFinite(out.v.y) || !Number.isFinite(out.v.z)
  ) {
    return null;
  }
  return out;
}

/** Hours between a state vector's epoch and `now`. Negative if epoch is ahead. */
export function stateVectorAgeHours(epochIso: string, now: number = Date.now()): number | null {
  const epochMs = new Date(epochIso).getTime();
  if (!Number.isFinite(epochMs)) return null;
  return (now - epochMs) / 3_600_000;
}

export type SVFreshness = "fresh" | "aging" | "stale";

/**
 * Age thresholds, in hours, at which a state vector is flagged in the UI.
 * Never a hard cutoff — the object still renders, because refusing to draw it
 * is a worse failure than drawing it with a warning.
 *
 * Regime-aware because the divergence rates differ by orders of magnitude.
 * Measured by sampling SGP4 to produce an exact state vector, propagating it
 * two-body, and comparing against SGP4 (which models drag and J2) later —
 * median geocentric error over ~25 real catalog objects per regime:
 *
 *            1h      6h     12h      1d      7d     30d
 *   LEO    0.24°   1.11°   2.32°   4.65°     32°     90°
 *   MEO    0.04°   0.25°   0.51°   1.19°   6.97°     30°
 *   GEO    0.00°   0.00°   0.01°   0.02°   0.14°   0.63°
 *   HEO    0.00°   0.00°   0.01°   0.02°   0.18°   0.74°
 *
 * LEO is dominated by drag, which two-body ignores entirely; GEO barely moves.
 * "aging" is set near 0.5° of expected error and "stale" near 2°.
 *
 * The high-altitude numbers are deliberately tightened well below what pure
 * propagation error would justify, because at those timescales the dominant
 * error is no longer the model: station-keeping manoeuvres are unpredictable
 * and typically recur every couple of weeks. An unflagged month-old GEO vector
 * would be misleading — see the 16.6° real-world case in the SV notes.
 */
const FRESHNESS_HOURS: Record<string, { aging: number; stale: number }> = {
  LEO: { aging: 3, stale: 12 },
  MEO: { aging: 12, stale: 72 },
  GEO: { aging: 168, stale: 504 },
  HEO: { aging: 168, stale: 504 },
};

/** Unknown regime falls back to the strictest bounds rather than the loosest. */
const FRESHNESS_FALLBACK = FRESHNESS_HOURS.LEO!;

/** Classify a state vector's age for display. */
export function svFreshness(
  ageHours: number | null,
  orbitRegime: string | undefined,
): SVFreshness {
  if (ageHours == null) return "fresh";
  const limits = FRESHNESS_HOURS[orbitRegime ?? ""] ?? FRESHNESS_FALLBACK;
  if (ageHours >= limits.stale) return "stale";
  if (ageHours >= limits.aging) return "aging";
  return "fresh";
}

/** Compact age for a row chip: "42m", "6h", "27d". */
export function formatAge(ageHours: number): string {
  if (ageHours < 1) return `${Math.max(0, Math.round(ageHours * 60))}m`;
  if (ageHours < 48) return `${Math.round(ageHours)}h`;
  return `${Math.round(ageHours / 24)}d`;
}
