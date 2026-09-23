import { useSensorKitStore } from "../../stores/sensorkit";
import type { VCurveFit } from "./VCurvePlot";

/**
 * Reads the autofocus analyzer's published V-curve state for the program card.
 *
 * Everything here comes off the wire as-is: SK publishes `VCurveResult` with
 * the fit AND the samples behind it, so there is nothing to reconstruct.
 */

/** `VCurveResult` — the last completed sweep, retained by the analyzer. */
interface VCurveResult {
  timestamp: string;
  session: string;
  best_position: number;
  best_fwhm_pixels: number;
  slope: number;
  r_squared: number;
  pixel_scale_arcsec?: number | null;
  /** `[focuser position (steps), FWHM (pixels)]`, sorted by position. */
  samples?: [number, number][];
}

/** `AutofocusState` — persisted calibration; `enabled` is the analyzer master switch. */
interface AutofocusState {
  enabled?: boolean;
}

/** `AutofocusConfig` — the sweep parameters the program runs with. */
interface AutofocusConfig {
  controller?: string;
  vcurve?: {
    num_steps?: number;
    step_size?: number | null;
    filter_name?: string | null;
    binning?: number;
  };
}

export interface VCurveSample {
  position: number;
  fwhmArcsec: number;
}

export interface VCurveData {
  /** Sweep parameters, for the annotation block. */
  filter: string;
  binning: number | null;
  stepSize: number | null;
  numSteps: number | null;
  /** Fit summary, in arcsec. */
  bestPosition: number | null;
  bestFwhmArcsec: number | null;
  timestamp: Date | null;
  samples: VCurveSample[];
  fit: VCurveFit | null;
  /** Focuser range the sweep covers, for the plot's x extent. */
  span: { lo: number; hi: number } | null;
  /** Analyzer master switch — passive corrections on/off. */
  correctionEnabled: boolean;
  /** Identifies the displayed sweep, so a caller can tell when a new one lands. */
  session: string | null;
}

/** `EntityLease` — present only while an entity is alive; names the owning service. */
interface EntityLease {
  record?: { name?: string };
}

/** The service an entity belongs to, or null when it has no live lease. */
function serviceNameOf(props: Record<string, unknown> | undefined): string | null {
  const lease = props?.["EntityLease"] as EntityLease | undefined;
  return lease?.record?.name ?? null;
}

/**
 * Resolve the autofocus entity backing a program card, or null when the
 * program is not an autofocus program (which is what gates the V-curve UI —
 * only the card that has a curve behind it grows the controls).
 *
 * The analyzer and the program are two entities of one service: the analyzer
 * holds every autofocus keyword, the program only does the tasking, and
 * nothing on the program side names its analyzer. What they do share is the
 * service that leased them both, so `EntityLease.record.name` links the two
 * without hard-coding either entity's name.
 *
 * The program's own lease gates this: SK deletes the lease when an entity dies
 * but leaves its last ProgramState behind, so a renamed-away program (there is
 * a dead `autofocus_program` next to the live `V-Curve` on OmniSim) would
 * otherwise keep a card — and a V-curve toggle — forever.
 */
export function findAutofocusEntity(
  state: Record<string, Record<string, unknown>>,
  programName: string,
  programController: string | undefined,
): string | null {
  const programService = serviceNameOf(state[programName]);
  if (!programService) return null; // no lease -> the program is gone

  const candidates = Object.entries(state)
    .filter(([, props]) => props["AutofocusConfig"] !== undefined)
    .map(([name, props]) => ({
      name,
      service: serviceNameOf(props),
      config: props["AutofocusConfig"] as AutofocusConfig,
    }));

  const sibling = candidates.find((c) => c.service === programService);
  if (sibling) return sibling.name;

  // The analyzer's own lease can lapse while the program lives on (a restart
  // in progress); its last curve is still worth showing, so fall back to the
  // controller the two share.
  return candidates.find((c) => c.config.controller === programController)?.name ?? null;
}

export function useVCurveData(autofocusEntity: string | null): VCurveData | null {
  const state = useSensorKitStore((s) => s.state);

  if (!autofocusEntity) return null;
  const props = state[autofocusEntity];
  if (!props) return null;

  const result = props["VCurveResult"] as VCurveResult | undefined;
  const afState = props["AutofocusState"] as AutofocusState | undefined;
  const vc = (props["AutofocusConfig"] as AutofocusConfig | undefined)?.vcurve;

  // SENPAI reports FWHM in pixels; without a plate scale there is nothing to
  // label an arcsec axis with, so fall back to 1 and the plot reads in pixels.
  const scale = result?.pixel_scale_arcsec || 1;
  const samples = (result?.samples ?? []).map(([position, fwhmPixels]) => ({
    position,
    fwhmArcsec: fwhmPixels * scale,
  }));

  const bestPosition = result?.best_position ?? null;
  const bestFwhmArcsec = result ? result.best_fwhm_pixels * scale : null;

  return {
    // SK models "no filter" as null; the operator's word for that is Open.
    filter: vc?.filter_name ?? "Open",
    binning: vc?.binning ?? null,
    stepSize: vc?.step_size ?? null,
    numSteps: vc?.num_steps ?? null,
    bestPosition,
    bestFwhmArcsec,
    timestamp: result ? new Date(result.timestamp) : null,
    samples,
    // The analyzer fits FWHM² = slope·(p − best)² + best² in PIXELS; scaling
    // both terms by the plate scale re-expresses the same parabola in arcsec.
    fit:
      result && bestPosition != null && bestFwhmArcsec != null
        ? { a: result.slope * scale ** 2, pOpt: bestPosition, bestFwhm: bestFwhmArcsec }
        : null,
    span: sweepSpan(vc, bestPosition),
    correctionEnabled: afState?.enabled ?? false,
    session: result?.session ?? null,
  };
}

/**
 * The focuser range a sweep covers: `num_steps` samples spaced by `step_size`,
 * centred on best focus — the same geometry the program uses to lay the sweep
 * out. Null when the sweep spans the focuser's whole range instead (no
 * `step_size` configured), where the samples themselves set the extent.
 */
function sweepSpan(
  vc: AutofocusConfig["vcurve"],
  center: number | null,
): { lo: number; hi: number } | null {
  const step = vc?.step_size;
  const n = vc?.num_steps;
  if (!step || !n || n < 2 || center == null) return null;
  const half = ((n - 1) / 2) * step;
  return { lo: center - half, hi: center + half };
}
