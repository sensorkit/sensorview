import type { HeaderCards } from "../../lib/sensorkit-client/fitsHeaders";

/**
 * Pick a calibration frame (dark or flat) to apply to the frame being viewed,
 * matching on the FITS header cards SensorKit writes.
 *
 * Shared hard gates (all required — a frame missing any can't be matched):
 *   width/height (NAXIS1/NAXIS2), binning (X/YBINNING), gain and/or readout
 *   mode (GAIN / READOUTM), and CCD temperature within TEMP_TOL_C degrees.
 * Darks additionally require matching exposure (EXPTIME); flats additionally
 * require matching filter (FILTER) and ignore exposure. Among the frames that
 * clear every gate, the most recent one wins.
 *
 * Candidates whose filename ends in "_processed" are excluded — those are
 * SENPAI pipeline outputs, not raw calibration frames.
 */

/** CCD-TEMP must match within this many degrees Celsius. */
export const TEMP_TOL_C = 5;
/** EXPTIME match tolerance (relative) — darks are shot at the light's exposure. */
export const EXP_REL_EPS = 1e-3;

export interface CalCandidate {
  controllerId: string;
  productId: string;
  /** ISO register time; used only to pick the most recent match. */
  registerTime?: string;
  cards: HeaderCards;
}

export interface CalMatch {
  controllerId: string;
  productId: string;
  registerTime?: string;
  /** The calibration frame's CCD temperature, for display/debug. */
  ccdTemp: number | null;
}

export type NoMatchReason = "missing-fields" | "no-candidate";

export interface MatchResult {
  match: CalMatch | null;
  reason?: NoMatchReason;
}

// FITS card aliases. SK writes the first of each, but spellings vary by rig, so
// accept the common synonyms rather than hardcoding one guess.
const K = {
  frame: ["IMAGETYP", "FRAMETYP", "IMGTYPE", "OBSTYPE", "FRAME"],
  width: ["NAXIS1"],
  height: ["NAXIS2"],
  exp: ["EXPTIME", "EXPOSURE"],
  xbin: ["XBINNING", "XBIN", "BINX"],
  ybin: ["YBINNING", "YBIN", "BINY"],
  gain: ["GAIN", "EGAIN"],
  readout: ["READOUTM", "READOUTMODE", "READOUT"],
  temp: ["CCD-TEMP", "CCDTEMP", "CCD_TEMP", "SENSTEMP"],
  filter: ["FILTER", "FILTNAM", "FILT"],
} as const;

/** Lowercase a card map's keys once so alias lookups are case-insensitive. */
function lower(cards: HeaderCards): HeaderCards {
  const out: HeaderCards = {};
  for (const k in cards) out[k.toLowerCase()] = cards[k]!;
  return out;
}

function get(lc: HeaderCards, aliases: readonly string[]): string | undefined {
  for (const a of aliases) {
    const v = lc[a.toLowerCase()];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function num(lc: HeaderCards, aliases: readonly string[]): number | null {
  const v = get(lc, aliases);
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Equality for a match key: numeric when both parse, else case-insensitive text. */
function eq(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function frameTypeIs(frameType: string | undefined, token: string): boolean {
  return frameType !== undefined && frameType.toLowerCase().includes(token);
}

/** SENPAI writes calibrated science outputs alongside the raw frames with a
 *  "_processed" suffix; those aren't usable as raw calibration frames. */
function isProcessed(productId: string): boolean {
  return /_processed(\.[^.]+)?$/i.test(productId);
}

interface CalKind {
  /** IMAGETYP token the candidate must carry, e.g. "dark" or "flat". */
  frameType: string;
  /** Require the candidate's EXPTIME to match the subject (darks). */
  matchExposure: boolean;
  /** Require the candidate's FILTER to match the subject (flats). */
  matchFilter: boolean;
}

/**
 * @param subjectCards header of the frame being viewed
 * @param subjectId    its productId, so the frame can't match itself
 * @param candidates   every indexed product (non-matching types are filtered out)
 */
function findCalibration(
  subjectCards: HeaderCards,
  subjectId: string,
  candidates: CalCandidate[],
  kind: CalKind,
): MatchResult {
  const s = lower(subjectCards);

  const w = num(s, K.width);
  const h = num(s, K.height);
  const xbin = num(s, K.xbin);
  const ybin = num(s, K.ybin);
  const temp = num(s, K.temp);
  const gain = get(s, K.gain);
  const readout = get(s, K.readout);
  const exp = num(s, K.exp);
  const filter = get(s, K.filter);

  if (
    w === null ||
    h === null ||
    xbin === null ||
    ybin === null ||
    temp === null ||
    (gain === undefined && readout === undefined) ||
    (kind.matchExposure && exp === null) ||
    (kind.matchFilter && filter === undefined)
  ) {
    return { match: null, reason: "missing-fields" };
  }

  let best: CalMatch | null = null;
  let bestTime = "";
  for (const c of candidates) {
    if (c.productId === subjectId) continue;
    if (isProcessed(c.productId)) continue;
    const d = lower(c.cards);
    if (!frameTypeIs(get(d, K.frame), kind.frameType)) continue;

    if (num(d, K.width) !== w || num(d, K.height) !== h) continue;
    if (num(d, K.xbin) !== xbin || num(d, K.ybin) !== ybin) continue;

    if (kind.matchExposure && exp !== null) {
      const de = num(d, K.exp);
      if (de === null || Math.abs(de - exp) > EXP_REL_EPS * Math.abs(exp)) continue;
    }
    if (kind.matchFilter && filter !== undefined) {
      const df = get(d, K.filter);
      if (df === undefined || !eq(df, filter)) continue;
    }
    // Match on whichever of gain / readout the subject carries.
    if (gain !== undefined) {
      const dg = get(d, K.gain);
      if (dg === undefined || !eq(dg, gain)) continue;
    }
    if (readout !== undefined) {
      const dr = get(d, K.readout);
      if (dr === undefined || !eq(dr, readout)) continue;
    }

    const dtemp = num(d, K.temp);
    if (dtemp === null || Math.abs(dtemp - temp) > TEMP_TOL_C) continue;

    // Most recent wins. Missing register time sorts oldest.
    const t = c.registerTime ?? "";
    if (best === null || t > bestTime) {
      best = {
        controllerId: c.controllerId,
        productId: c.productId,
        registerTime: c.registerTime,
        ccdTemp: dtemp,
      };
      bestTime = t;
    }
  }

  return best ? { match: best } : { match: null, reason: "no-candidate" };
}

/** Most recent dark matching size/exposure/binning/gain-or-readout/temp. */
export function findDark(
  subjectCards: HeaderCards,
  subjectId: string,
  candidates: CalCandidate[],
): MatchResult {
  return findCalibration(subjectCards, subjectId, candidates, {
    frameType: "dark",
    matchExposure: true,
    matchFilter: false,
  });
}

/** Most recent flat matching filter/size/binning/gain-or-readout/temp. */
export function findFlat(
  subjectCards: HeaderCards,
  subjectId: string,
  candidates: CalCandidate[],
): MatchResult {
  return findCalibration(subjectCards, subjectId, candidates, {
    frameType: "flat",
    matchExposure: false,
    matchFilter: true,
  });
}
