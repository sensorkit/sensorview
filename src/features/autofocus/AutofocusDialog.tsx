import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_AUTOFOCUS_DRAFT,
  useAutofocusStore,
  type AutofocusDraft,
} from "../../stores/autofocus";
import { useSensorKitSlice, useSensorKitStore } from "../../stores/sensorkit";
import { abortAutofocus, runAutofocus } from "./autofocusActions";
import {
  autofocusBlocker,
  buildAutofocusTask,
  controllerFocusDetails,
  draftForAutofocusTask,
  focusDialogState,
  focusDialogStateEqual,
  instrumentFocuser,
} from "./autofocusSetup";
import {
  focusExecution,
  focusProvider,
  latestFocusSweep,
  recordOf,
  sweepKey,
  sweepOutcome,
  type FocusSweep,
} from "./focusSweepData";
import { FocusSweepPlot } from "./FocusSweepPlot";

const inputClass =
  "w-full rounded border border-panel-border bg-black/30 px-2 py-2 text-sm text-text-bright disabled:opacity-50";
const buttonClass =
  "rounded border border-panel-border px-3 py-2 text-xs text-text-bright hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed";
const formatPosition = (position: number | null | undefined) =>
  position == null
    ? "—"
    : position.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function AutofocusDialog({
  controllerId,
  onClose,
}: {
  controllerId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const loadedTask = useRef<string | null>(null);
  const state = useSensorKitSlice(
    (s) => focusDialogState(s.state, controllerId),
    focusDialogStateEqual,
  );
  const connected = useSensorKitStore((s) => s.connection === "open");
  const sweeps = useAutofocusStore((s) => s.sweeps);
  const request = useAutofocusStore((s) => s.requests[controllerId]);
  const retainedProvider = useAutofocusStore((s) => s.providers[controllerId]);
  const [draft, setDraft] = useState<AutofocusDraft>(() =>
    request?.pending && request.task
      ? draftForAutofocusTask(request.task)
      : {
          ...DEFAULT_AUTOFOCUS_DRAFT,
          instrument: request?.pending ? request.instrument : "",
        },
  );
  const initialRequest = useRef(request);
  const requestError =
    request?.id !== initialRequest.current?.id ||
    initialRequest.current?.pending
      ? request?.error
      : null;
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [abortPending, setAbortPending] = useState(false);
  const details = controllerFocusDetails(state, controllerId);
  const instruments = details?.instruments ?? [];
  const provider =
    focusProvider(state, controllerId) ??
    (!connected ? (retainedProvider ?? null) : null);
  const controllerOnline =
    connected && "EntityLease" in (state[controllerId] ?? {});
  const executionState = focusExecution(
    recordOf(state[controllerId]?.["ControllerState"])?.execution_state,
  );
  const liveExecution = controllerOnline ? executionState : null;
  // Start each opening without historical results, while keeping a confirmed
  // running task inspectable. Telemetry and HTTP requests outlive this view.
  const [hiddenSweepIds, setHiddenSweepIds] = useState(() => {
    const ids = new Set(
      Object.values(sweeps)
        .filter((s) => s.controller === controllerId)
        .map((s) => s.id),
    );
    if (executionState) ids.add(executionState.execution.task_id);
    if (executionState?.executing) ids.delete(executionState.execution.task_id);
    if (request?.pending && request.taskId) ids.delete(request.taskId);
    return ids;
  });
  const activeTaskId = executionState?.executing
    ? executionState.execution.task_id
    : null;
  const pendingTaskId = request?.pending ? request.taskId : null;
  useEffect(() => {
    setHiddenSweepIds((ids) => {
      if (
        (!activeTaskId || !ids.has(activeTaskId)) &&
        (!pendingTaskId || !ids.has(pendingTaskId))
      )
        return ids;
      const next = new Set(ids);
      if (activeTaskId) next.delete(activeTaskId);
      if (pendingTaskId) next.delete(pendingTaskId);
      return next;
    });
  }, [activeTaskId, pendingTaskId]);
  const visibleSweeps = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(sweeps).filter(([, s]) => !hiddenSweepIds.has(s.id)),
      ),
    [sweeps, hiddenSweepIds],
  );
  const instrument = draft.instrument || instruments[0]?.name || "";
  const formDraft = useMemo(
    () => ({ ...draft, instrument }),
    [draft, instrument],
  );
  const focuser = instrumentFocuser(state, controllerId, instrument);
  const selectedId =
    request?.pending && request.instrument === instrument
      ? request.taskId
      : liveExecution?.execution.task.instrument === instrument &&
          !hiddenSweepIds.has(liveExecution.execution.task_id)
        ? liveExecution.execution.task_id
        : null;
  const sweep =
    selectedId && provider
      ? (visibleSweeps[
          sweepKey(provider, controllerId, instrument, selectedId)
        ] ?? null)
      : request?.pending && request.instrument === instrument
        ? null
        : latestFocusSweep(visibleSweeps, provider, controllerId, instrument);
  const running =
    liveExecution?.executing === true &&
    liveExecution.execution.task.instrument === instrument;
  const pending = request?.pending === true;
  const blocker = autofocusBlocker(state, controllerId, instrument, connected);
  let validation: string | null = null;
  try {
    buildAutofocusTask(formDraft);
  } catch (error) {
    validation = (error as Error).message;
  }
  const firstSample = sweep ? Object.values(sweep.samples)[0] : null;
  const taskCenter =
    liveExecution?.execution.task.center ??
    (firstSample && liveExecution
      ? firstSample.sweep.commanded_position +
        ((liveExecution.execution.task.count - 1) / 2 -
          firstSample.sweep.sample_index) *
          liveExecution.execution.task.step
      : null);
  const center = running
    ? taskCenter
    : draft.useReported
      ? focuser.position
      : draft.center.trim() !== ""
        ? Number(draft.center)
        : null;
  const step = Number(draft.step),
    count = Number(draft.count);
  const half = ((count - 1) * step) / 2;
  const range =
    center !== null &&
    Number.isFinite(center) &&
    step > 0 &&
    Number.isInteger(count) &&
    count >= 5
      ? `${formatPosition(center - half)} → ${formatPosition(center + half)}`
      : "Set a step and sample count";
  const locked = pending || running;
  const canAbort = running && !liveExecution.aborting && !abortPending;

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    return () => node.close();
  }, []);
  useEffect(() => {
    if (
      !liveExecution?.executing ||
      loadedTask.current === liveExecution.execution.task_id
    )
      return;
    loadedTask.current = liveExecution.execution.task_id;
    setDraft(draftForAutofocusTask(liveExecution.execution.task));
  }, [liveExecution]);

  const change = (patch: Partial<AutofocusDraft>) => {
    setConfirming(false);
    setDraft({ ...formDraft, ...patch });
  };
  const start = () => {
    setConfirming(false);
    setActionError(null);
    void runAutofocus(controllerId, formDraft).catch((error) =>
      setActionError(error instanceof Error ? error.message : String(error)),
    );
  };
  const abort = () => {
    if (!canAbort) return;
    setAbortPending(true);
    setActionError(null);
    void abortAutofocus(controllerId, liveExecution.execution.task_id)
      .catch((error) =>
        setActionError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setAbortPending(false));
  };

  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="autofocus-dialog-title"
      className="m-auto max-h-[90dvh] overflow-y-auto rounded-lg border border-panel-border bg-panel-bg p-0 text-text-bright shadow-xl backdrop:bg-black/60"
      style={{ width: "min(850px, calc(100vw - 2rem))" }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="flex items-start justify-between gap-4 border-b border-panel-border px-5 py-4">
        <div className="min-w-0">
          <h2 id="autofocus-dialog-title" className="text-base font-semibold">
            Autofocus
          </h2>
          <div className="break-all text-xs text-text-dim">{controllerId}</div>
        </div>
        <button type="button" className={buttonClass} onClick={onClose}>
          Close
        </button>
      </header>
      <div className="space-y-5 p-5">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocker && !validation && !pending) setConfirming(true);
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
            <label className="space-y-1 text-xs">
              Instrument
              <select
                className={inputClass}
                value={instrument}
                disabled={locked}
                onChange={(e) => change({ instrument: e.target.value })}
              >
                {!instruments.length && (
                  <option value="">No instruments published</option>
                )}
                {instruments.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-1 text-xs text-text-dim">
              Reported focus
              <div className="py-2 font-mono text-sm text-text-bright">
                {formatPosition(focuser.position)}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-3">
            <label className="space-y-1 text-xs">
              Step (position units)
              <input
                className={inputClass}
                type="number"
                value={draft.step}
                min="0"
                step="any"
                placeholder="Choose a step"
                required
                disabled={locked}
                onChange={(e) => change({ step: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-xs">
              Samples
              <input
                className={inputClass}
                type="number"
                value={draft.count}
                min="5"
                step="1"
                required
                disabled={locked}
                onChange={(e) => change({ count: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-xs">
              Exposure (s)
              <input
                className={inputClass}
                type="number"
                value={draft.exposure}
                min="0"
                step="any"
                required
                disabled={locked}
                onChange={(e) => change({ exposure: e.target.value })}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.useReported}
              disabled={locked}
              onChange={(e) => change({ useReported: e.target.checked })}
            />
            Center on reported focus
          </label>
          {!draft.useReported && (
            <label className="block max-w-xs space-y-1 text-xs">
              Center (position units)
              <input
                className={inputClass}
                type="number"
                step="any"
                value={draft.center}
                required
                disabled={locked}
                onChange={(e) => change({ center: e.target.value })}
              />
            </label>
          )}
          <div className="flex flex-wrap justify-between gap-2 text-xs">
            <span className="text-text-dim">Sweep range</span>
            <span className="font-mono">
              {running && taskCenter === null
                ? "Waiting for the first measured position"
                : range}
            </span>
          </div>
          <details className="space-y-3 text-xs">
            <summary className="cursor-pointer text-text-dim">
              Camera and filter settings
            </summary>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                Filter
                <input
                  className={inputClass}
                  value={draft.filter}
                  placeholder="Keep current"
                  disabled={locked}
                  onChange={(e) => change({ filter: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                Binning
                <select
                  className={inputClass}
                  value={draft.binning}
                  disabled={locked}
                  onChange={(e) => change({ binning: e.target.value })}
                >
                  <option value="">Keep current</option>
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n} × {n}
                    </option>
                  ))}
                  {!["", "1", "2", "3", "4"].includes(draft.binning) && (
                    <option value={draft.binning}>
                      {draft.binning.replace("x", " × ")}
                    </option>
                  )}
                </select>
              </label>
              <label className="space-y-1">
                Gain
                <input
                  className={inputClass}
                  type="number"
                  step="any"
                  value={draft.gain}
                  placeholder="Keep current"
                  disabled={locked}
                  onChange={(e) => change({ gain: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                Readout mode
                <input
                  className={inputClass}
                  type="number"
                  min="0"
                  step="1"
                  value={draft.readout}
                  placeholder="Keep current"
                  disabled={locked}
                  onChange={(e) => change({ readout: e.target.value })}
                />
              </label>
            </div>
            <p className="text-text-dim">
              Requested camera and filter settings remain applied after the
              sweep.
            </p>
          </details>
          <div className="text-xs text-text-dim">
            Analysis provider{" "}
            <span className="text-text-bright">
              {provider ?? "Not configured"}
            </span>
          </div>
          {running || pending ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={`${buttonClass} text-red-300`}
                  disabled={!canAbort}
                  onClick={abort}
                >
                  {abortPending || liveExecution?.aborting
                    ? "Aborting…"
                    : "Abort sweep"}
                </button>
                <span className="text-xs text-text-dim">
                  {running
                    ? "Sweep is running on the controller."
                    : "Waiting for controller execution confirmation."}
                </span>
              </div>
              <p className="text-xs text-text-dim">
                Abort cancels active work without a return move. Closing this
                dialog leaves the sweep running.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className={`${buttonClass} bg-blue-300/15 border-blue-300/40`}
                disabled={!!blocker || !!validation}
              >
                {sweep ? "Run another sweep" : "Run autofocus"}
              </button>
              <span className="text-xs text-text-dim">
                Pointing and tracking are preserved.
              </span>
            </div>
          )}
          {!running && !pending && (blocker || validation) && (
            <p className="text-xs text-text-dim">{blocker ?? validation}</p>
          )}
          {confirming && (
            <div
              className="space-y-3 rounded border border-panel-border p-3"
              role="alert"
            >
              <p className="text-sm">
                Run {draft.count} samples on <strong>{instrument}</strong>,{" "}
                {draft.step} position units apart, at {draft.exposure} s per
                frame?
              </p>
              <p className="text-xs text-text-dim">
                The focuser moves through the sweep and then to the analyzed
                focus position. Stand down agent control before manual
                operation.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={`${buttonClass} border-orange-300/50 bg-orange-300/15`}
                  disabled={!!blocker || !!validation || pending}
                  onClick={start}
                >
                  Start sweep
                </button>
              </div>
            </div>
          )}
          {(actionError || requestError) && (
            <p className="break-words text-xs text-red-300" role="alert">
              {actionError ?? requestError}
            </p>
          )}
        </form>
        {sweep && <SweepResult sweep={sweep} connected={connected} />}
      </div>
    </dialog>,
    document.body,
  );
}

function SweepResult({
  sweep,
  connected,
}: {
  sweep: FocusSweep;
  connected: boolean;
}) {
  const analysis = sweep.analysis;
  const samples = Object.values(sweep.samples).sort(
    (a, b) => a.sweep.sample_index - b.sweep.sample_index,
  );
  const expected =
    sweep.execution?.execution.task.count ?? samples[0]?.sweep.sample_count;
  const usable = samples.filter((s) => s.valid).length;
  const outcome = sweepOutcome(sweep);
  const error = sweep.execution?.finished?.error;
  const beyond =
    analysis?.disposition === "greater_than" ||
    analysis?.disposition === "less_than";
  const label =
    outcome === "Succeeded"
      ? "Autofocus complete"
      : outcome === "Aborted"
        ? "Sweep aborted"
        : beyond
          ? "Best focus beyond sweep"
          : outcome === "Failed"
            ? "Autofocus failed"
            : "Focus sweep";
  return (
    <section
      className="space-y-3 border-t border-panel-border pt-4"
      aria-label="Focus sweep results"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{label}</h3>
          <div className="whitespace-pre-wrap break-all text-xs text-text-dim">
            {sweep.instrument} · {samples.length} / {expected ?? "?"} samples
            measured · {usable} usable
          </div>
        </div>
        <span className="text-xs text-text-dim" role="status">
          {connected ? outcome : "Disconnected · retained measurements"}
        </span>
      </div>
      {sweep.execution?.executing && !sweep.analysis && expected && (
        <div
          className="h-1 overflow-hidden rounded bg-white/10"
          role="progressbar"
          aria-label="Samples measured"
          aria-valuenow={samples.length}
          aria-valuemin={0}
          aria-valuemax={expected}
        >
          <div
            className="h-full bg-cyan-300/70"
            style={{
              width: `${Math.min(100, (samples.length / expected) * 100)}%`,
            }}
          />
        </div>
      )}
      {analysis?.outcome === "failure" && (
        <p className="text-xs text-orange-300">
          Analysis failed: {analysis.reason ?? "No usable focus estimate."}
        </p>
      )}
      {beyond && (
        <p className="text-xs text-orange-300">
          Best focus lies{" "}
          {analysis.disposition === "greater_than" ? "above" : "below"} the
          sampled range. The analysis identifies a boundary, not an interior
          minimum. Check the task outcome and reported focus before another
          sweep.
        </p>
      )}
      {typeof error === "string" && (
        <p
          className="whitespace-pre-wrap break-words text-xs text-red-300"
          role="alert"
        >
          {error}
        </p>
      )}
      {error === true && (
        <p className="text-xs text-red-300">
          The controller reported a task failure.
        </p>
      )}
      {outcome === "Aborted" && (
        <p className="text-xs text-text-dim">
          Active work was cancelled without a return move.
        </p>
      )}
      <FocusSweepPlot sweep={sweep} />
      <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-text-dim">
            {beyond
              ? "Boundary position"
              : outcome === "Succeeded"
                ? "Confirmed focus"
                : "Estimated focus"}
          </dt>
          <dd className="mt-1 font-mono">
            {formatPosition(analysis?.position)}
          </dd>
        </div>
        <div>
          <dt className="text-text-dim">Fit RMS (pixels)</dt>
          <dd className="mt-1 font-mono">
            {analysis?.rms_residual_pixels?.toFixed(3) ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="text-text-dim">Task outcome</dt>
          <dd className="mt-1">
            {connected ? outcome : "Unconfirmed while disconnected"}
          </dd>
        </div>
      </dl>
      <details>
        <summary className="cursor-pointer text-xs text-text-dim">
          Sample measurements
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-text-dim">
              <tr>
                {[
                  "Sample",
                  "Commanded",
                  "Reported",
                  "FWHM (px)",
                  "Measurement",
                ].map((s) => (
                  <th key={s} className="p-2 font-medium">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {samples.map((s) => (
                <tr
                  key={s.sweep.sample_index}
                  className="border-t border-panel-border"
                >
                  <td className="p-2">{s.sweep.sample_index + 1}</td>
                  <td className="p-2 font-mono">
                    {formatPosition(s.sweep.commanded_position)}
                  </td>
                  <td className="p-2 font-mono">
                    {formatPosition(s.reported_position)}
                  </td>
                  <td className="p-2 font-mono">
                    {s.median_fwhm_pixels?.toFixed(2) ?? "—"}
                  </td>
                  <td className="p-2">
                    {s.valid ? "Valid" : (s.reason ?? "Invalid")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <div className="break-all text-xs text-text-dim">
        Sweep {sweep.id} · {sweep.provider}
      </div>
    </section>
  );
}
