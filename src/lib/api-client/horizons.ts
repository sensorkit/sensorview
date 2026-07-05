/**
 * Client for the supplemental API's JPL Horizons proxy endpoints.
 *
 * The proxy (api/routers/horizons.py) resolves an object and returns a parsed
 * Observer-Table ephemeris (astrometric RA/Dec in the ICRF, sky-motion rates,
 * magnitude, range). We never call ssd.jpl.nasa.gov directly because it sends
 * no CORS headers.
 */
import { apiUrl } from "../../stores/backends";
import { fetchWithRetry } from "./http";

export interface HorizonsCandidate {
  command: string;
  name: string;
  kind?: string;
}

export interface HorizonsLookup {
  resolved: boolean;
  name?: string;
  command?: string;
  kind?: string;
  isSun?: boolean;
  candidates?: HorizonsCandidate[];
  raw?: string | null;
}

export interface HorizonsSample {
  jd: number;
  utc: string;
  ra: number;
  dec: number;
  raRateArcsecHr: number | null;
  decRateArcsecHr: number | null;
  magnitude: number | null;
  rangeAu: number | null;
}

export interface HorizonsEphemeris {
  name: string | null;
  command: string;
  samples: HorizonsSample[];
}

export interface EphemerisParams {
  command: string;
  lon: number; // observer East longitude, degrees
  lat: number; // observer latitude, degrees
  altKm: number; // observer altitude, kilometers
  start: string; // "YYYY-MM-DD HH:MM:SS" UTC
  stop: string;
  intervals: number; // number of equal sub-intervals (samples = intervals + 1)
}

/** Resolve an object by name/designation/id. Returns a single match or candidates. */
export async function lookupHorizons(q: string): Promise<HorizonsLookup> {
  const res = await fetchWithRetry(
    apiUrl(`/api/horizons/lookup?q=${encodeURIComponent(q)}`),
  );
  if (!res.ok) throw new Error(`Horizons lookup failed: ${res.status}`);
  return res.json();
}

/** Fetch a sampled Observer-Table ephemeris for a resolved object. */
export async function fetchHorizonsEphemeris(
  p: EphemerisParams,
): Promise<HorizonsEphemeris> {
  const params = new URLSearchParams({
    command: p.command,
    lon: String(p.lon),
    lat: String(p.lat),
    alt_km: String(p.altKm),
    start: p.start,
    stop: p.stop,
    intervals: String(p.intervals),
  });
  const res = await fetchWithRetry(apiUrl(`/api/horizons/ephemeris?${params}`));
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Horizons ephemeris failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }
  return res.json();
}

/** Total apparent sky-motion rate (arcsec/hr) from a sample's component rates. */
export function totalRateArcsecHr(s: HorizonsSample): number {
  const dr = s.raRateArcsecHr ?? 0; // already dRA*cosD
  const dd = s.decRateArcsecHr ?? 0;
  return Math.hypot(dr, dd);
}
