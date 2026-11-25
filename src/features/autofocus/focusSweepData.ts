import type { SKRecord } from "../../lib/sensorkit-client/types";
import type { StateMap } from "../../stores/sensorkit";

export interface AutofocusTask {
  task_type: "autofocus";
  instrument: string;
  step: number;
  count: number;
  integration_time_seconds: number;
  center?: number | null;
  binning?: { x: number; y: number } | null;
  gain?: number | null;
  readout_mode?: number | null;
  filter_name?: string | null;
}

export interface FocusSample {
  controller_id: string;
  instrument: string;
  image_id: string;
  exposure: { start: string; duration: number };
  reported_position: number | null;
  sweep: {
    sweep_id: string;
    sample_index: number;
    sample_count: number;
    commanded_position: number;
  };
  median_fwhm_pixels: number | null;
  measurement_count: number;
  valid: boolean;
  reason: string | null;
}

export interface FocusSweepAnalysis {
  controller_id: string;
  instrument: string;
  sweep_id: string;
  outcome: "success" | "failure";
  position: number | null;
  disposition: "equals" | "greater_than" | "less_than" | null;
  rms_residual_pixels: number | null;
  reason: string | null;
  samples: FocusSample[];
}

export interface FocusExecution {
  task_id: string;
  task: AutofocusTask;
  context: Record<string, unknown>;
  submitted_context?: Record<string, unknown> | null;
}

export interface FocusExecutionState {
  execution: FocusExecution;
  executing: boolean;
  aborting: boolean;
  finished: {
    timestamp: string;
    aborted: boolean;
    error: boolean | string;
  } | null;
}

export interface FocusSweep {
  provider: string;
  controller: string;
  instrument: string;
  id: string;
  samples: Record<number, FocusSample>;
  analysis: FocusSweepAnalysis | null;
  execution: FocusExecutionState | null;
  updatedAt: number;
  executionTime: number;
}

export type FocusSweeps = Record<string, FocusSweep>;

export function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function focusProvider(
  state: StateMap,
  controller: string,
): string | null {
  const source = recordOf(state[controller]?.["FocusAnalysisSource"]);
  return typeof source?.entity === "string" && source.entity.length > 0
    ? source.entity
    : null;
}

export function focusExecution(value: unknown): FocusExecutionState | null {
  const state = recordOf(value);
  const execution = recordOf(state?.execution);
  const task = recordOf(execution?.task);
  if (
    task?.task_type !== "autofocus" ||
    typeof task.instrument !== "string" ||
    !finite(task.step) ||
    !Number.isInteger(task.count) ||
    !finite(task.integration_time_seconds) ||
    typeof execution?.task_id !== "string" ||
    typeof state?.executing !== "boolean"
  )
    return null;
  return state as unknown as FocusExecutionState;
}

export function focusSample(value: unknown): FocusSample | null {
  const sample = recordOf(value);
  const sweep = recordOf(sample?.sweep);
  const exposure = recordOf(sample?.exposure);
  if (
    typeof sample?.controller_id !== "string" ||
    typeof sample.instrument !== "string" ||
    typeof sample.image_id !== "string" ||
    typeof sample.valid !== "boolean" ||
    typeof sweep?.sweep_id !== "string" ||
    !Number.isInteger(sweep.sample_index) ||
    !Number.isInteger(sweep.sample_count) ||
    (sweep.sample_count as number) < 1 ||
    (sweep.sample_index as number) < 0 ||
    (sweep.sample_index as number) >= (sweep.sample_count as number) ||
    !finite(sweep.commanded_position) ||
    typeof exposure?.start !== "string" ||
    !finite(exposure.duration) ||
    !Number.isInteger(sample.measurement_count) ||
    (sample.reported_position != null && !finite(sample.reported_position)) ||
    (sample.median_fwhm_pixels != null &&
      (!finite(sample.median_fwhm_pixels) || sample.median_fwhm_pixels <= 0)) ||
    (sample.valid &&
      (!finite(sample.median_fwhm_pixels) ||
        (sample.measurement_count as number) < 1))
  )
    return null;
  return sample as unknown as FocusSample;
}

export function focusAnalysis(value: unknown): FocusSweepAnalysis | null {
  const analysis = recordOf(value);
  if (
    typeof analysis?.controller_id !== "string" ||
    typeof analysis.instrument !== "string" ||
    typeof analysis.sweep_id !== "string" ||
    !Array.isArray(analysis.samples) ||
    !["success", "failure"].includes(String(analysis.outcome)) ||
    (analysis.position != null && !finite(analysis.position)) ||
    (analysis.rms_residual_pixels != null &&
      !finite(analysis.rms_residual_pixels)) ||
    (analysis.outcome === "success" &&
      (!finite(analysis.position) ||
        !["equals", "greater_than", "less_than"].includes(
          String(analysis.disposition),
        )))
  )
    return null;
  const samples = analysis.samples.map(focusSample);
  if (
    samples.some(
      (sample) =>
        !sample ||
        sample.controller_id !== analysis.controller_id ||
        sample.instrument !== analysis.instrument ||
        sample.sweep.sweep_id !== analysis.sweep_id,
    )
  )
    return null;
  return analysis as unknown as FocusSweepAnalysis;
}

export function sweepKey(
  provider: string,
  controller: string,
  instrument: string,
  id: string,
): string {
  return JSON.stringify([provider, controller, instrument, id]);
}

/** Keep every sample in a batch, including those sharing one stream subject. */
export function ingestFocusRecords(
  previous: FocusSweeps,
  records: SKRecord[],
  state: StateMap,
): FocusSweeps {
  let next = previous;
  const put = (sweep: FocusSweep) => {
    if (next === previous) next = { ...previous };
    next[
      sweepKey(sweep.provider, sweep.controller, sweep.instrument, sweep.id)
    ] = sweep;
  };
  const get = (
    provider: string,
    controller: string,
    instrument: string,
    id: string,
    time: number,
  ): FocusSweep =>
    next[sweepKey(provider, controller, instrument, id)] ?? {
      provider,
      controller,
      instrument,
      id,
      samples: {},
      analysis: null,
      execution: null,
      updatedAt: time,
      executionTime: 0,
    };
  const result = (
    provider: string,
    analysis: FocusSweepAnalysis,
    time: number,
  ) => {
    if (focusProvider(state, analysis.controller_id) !== provider) return;
    const sweep = get(
      provider,
      analysis.controller_id,
      analysis.instrument,
      analysis.sweep_id,
      time,
    );
    if (sweep.analysis) return;
    put({
      ...sweep,
      analysis,
      samples: Object.fromEntries(
        analysis.samples.map((s) => [s.sweep.sample_index, s]),
      ),
      updatedAt: Math.max(sweep.updatedAt, time),
    });
  };

  for (const [kind, timestamp, subject, payload] of records) {
    if (kind === "product" || payload === null) continue;
    const entity = subject.path.join("/");
    const time = Date.parse(timestamp) || 0;
    if (subject.prop === "FocusAnalysis") {
      const sample = focusSample(payload);
      if (!sample || focusProvider(state, sample.controller_id) !== entity)
        continue;
      const sweep = get(
        entity,
        sample.controller_id,
        sample.instrument,
        sample.sweep.sweep_id,
        time,
      );
      if (sweep.analysis || sweep.samples[sample.sweep.sample_index]) continue;
      const existing = Object.values(sweep.samples)[0];
      if (existing && existing.sweep.sample_count !== sample.sweep.sample_count)
        continue;
      put({
        ...sweep,
        samples: { ...sweep.samples, [sample.sweep.sample_index]: sample },
        updatedAt: Math.max(sweep.updatedAt, time),
      });
    } else if (subject.prop === "FocusSweepAnalysis") {
      const analysis = focusAnalysis(payload);
      if (analysis) result(entity, analysis, time);
    } else {
      const raw = recordOf(payload);
      const executionState = focusExecution(
        subject.prop === "ControllerState"
          ? raw?.execution_state
          : raw?.event_model === "TaskExecutionState"
            ? raw
            : null,
      );
      const provider = focusProvider(state, entity);
      if (!executionState || !provider) continue;
      const execution = executionState.execution;
      const sweep = get(
        provider,
        entity,
        execution.task.instrument,
        execution.task_id,
        time,
      );
      // A replayed running state cannot undo a recorded completion.
      if (
        (sweep.execution?.finished && !executionState.finished) ||
        time < sweep.executionTime
      )
        continue;
      put({
        ...sweep,
        execution: executionState,
        executionTime: time,
        updatedAt: Math.max(sweep.updatedAt, time),
      });
      const analysis = focusAnalysis(
        recordOf(execution.context)?.["FocusSweepAnalysis"],
      );
      if (
        analysis &&
        analysis.controller_id === entity &&
        analysis.instrument === execution.task.instrument &&
        analysis.sweep_id === execution.task_id
      )
        result(provider, analysis, time);
    }
  }
  if (next !== previous && Object.keys(next).length > 32) {
    const recent = Object.entries(next)
      .sort(
        (a, b) =>
          Number(!!b[1].execution?.executing) -
            Number(!!a[1].execution?.executing) ||
          b[1].updatedAt - a[1].updatedAt,
      )
      .slice(0, 32);
    return Object.fromEntries(recent);
  }
  return next;
}

export function latestFocusSweep(
  sweeps: FocusSweeps,
  provider: string | null,
  controller: string,
  instrument: string,
): FocusSweep | null {
  return (
    Object.values(sweeps)
      .filter(
        (s) =>
          s.provider === provider &&
          s.controller === controller &&
          s.instrument === instrument,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  );
}

export function sweepOutcome(sweep: FocusSweep): string {
  const execution = sweep.execution;
  if (execution?.aborting) return "Aborting";
  if (execution?.executing)
    return sweep.analysis?.outcome === "failure"
      ? "Handling analysis failure"
      : sweep.analysis
        ? "Applying focus"
        : "Running";
  if (execution?.finished?.aborted) return "Aborted";
  if (execution?.finished?.error) return "Failed";
  if (execution?.finished) return "Succeeded";
  return "Task outcome unavailable";
}
