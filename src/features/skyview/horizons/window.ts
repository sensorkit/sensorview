/**
 * Time-window math for Horizons ephemeris requests.
 *
 * The ephemeris span is derived from the actual collect parameters (integration
 * time × frame count, plus padding) rather than a fixed duration, and the sample
 * cadence adapts to the object's sky-motion rate so a fast NEO is sampled finely
 * enough for SensorKit to interpolate accurately while a slow asteroid is not
 * over-sampled.
 */

// Rough per-frame readout/settle overhead beyond the pure integration time.
const PER_FRAME_OVERHEAD_S = 2;
// Fixed slew/settle allowance before the first frame.
const SETTLE_PAD_S = 30;
// Pads on each end of the window to absorb queue/slew delay between the
// Collect click and the actual start, so the ephemeris always covers execution.
const START_PAD_S = 60;
const END_PAD_S = 60;

// Target on-sky motion between samples; smaller → denser sampling.
const MAX_ARCSEC_PER_STEP = 5;
const MIN_INTERVALS = 4;
const MAX_INTERVALS = 240; // keep Horizons output (and the request) modest

export interface HorizonsWindow {
  start: string; // "YYYY-MM-DD HH:MM:SS" UTC
  stop: string;
  intervals: number; // samples = intervals + 1
  startDate: Date;
  stopDate: Date;
}

/** Format a Date as Horizons' expected "YYYY-MM-DD HH:MM:SS" in UTC. */
export function fmtHorizonsTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** Choose an interval count so motion-per-step stays under MAX_ARCSEC_PER_STEP. */
export function adaptiveIntervals(
  windowSec: number,
  rateArcsecPerHr?: number | null,
): number {
  const rateArcsecPerSec = Math.abs(rateArcsecPerHr ?? 0) / 3600;
  const desiredStepSec =
    rateArcsecPerSec > 0
      ? MAX_ARCSEC_PER_STEP / rateArcsecPerSec
      : windowSec / MIN_INTERVALS;
  const n = Math.ceil(windowSec / Math.max(1, desiredStepSec));
  return Math.max(MIN_INTERVALS, Math.min(MAX_INTERVALS, n));
}

function buildWindow(
  startDate: Date,
  durationSec: number,
  rateArcsecPerHr?: number | null,
): HorizonsWindow {
  const stopDate = new Date(startDate.getTime() + durationSec * 1000);
  return {
    start: fmtHorizonsTime(startDate),
    stop: fmtHorizonsTime(stopDate),
    intervals: adaptiveIntervals(durationSec, rateArcsecPerHr),
    startDate,
    stopDate,
  };
}

/** Estimated wall-clock duration of a collect, in seconds. */
export function estimateCollectSeconds(
  integrationSec: number,
  frameCount: number,
): number {
  return frameCount * integrationSec + PER_FRAME_OVERHEAD_S * frameCount + SETTLE_PAD_S;
}

/** Window that brackets the estimated collect, used when building the task. */
export function collectWindow(opts: {
  integrationSec: number;
  frameCount: number;
  rateArcsecPerHr?: number | null;
  now?: Date;
}): HorizonsWindow {
  const now = opts.now ?? new Date();
  const estCollectSec = estimateCollectSeconds(opts.integrationSec, opts.frameCount);
  const startDate = new Date(now.getTime() - START_PAD_S * 1000);
  const durationSec = START_PAD_S + estCollectSec + END_PAD_S;
  return buildWindow(startDate, durationSec, opts.rateArcsecPerHr);
}

/** Short window for the on-selection readout + canvas motion track. */
export function previewWindow(opts: {
  rateArcsecPerHr?: number | null;
  spanSec?: number;
  intervals?: number; // explicit sample count (overrides the adaptive choice)
  now?: Date;
}): HorizonsWindow {
  const now = opts.now ?? new Date();
  const win = buildWindow(now, opts.spanSec ?? 900, opts.rateArcsecPerHr);
  return opts.intervals != null ? { ...win, intervals: opts.intervals } : win;
}
