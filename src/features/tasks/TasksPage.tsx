import { useEffect, useState } from "react";
import { useSensorKitStore } from "../../stores/sensorkit";
import { useFrameIndex } from "../skyview/hooks/useFrameIndex";
import {
  disableProgram,
  enableProgram,
  excludeProgramFromScheduler,
  includeProgramInScheduler,
} from "../../lib/sensorkit-client/commands";
import type {
  AgentCapabilities,
  AgentState,
  Capabilities,
  EntityListing,
  ScheduleEntry,
} from "../../lib/sensorkit-client/types";
import { ScheduleStrip } from "./ScheduleStrip";

// === Controller / Program shapes ===

interface TaskFinishedRecord {
  timestamp: string;
  aborted?: boolean;
  error?: string | null;
}

// === Task payload shape (best-effort — SK types may vary) ===

interface CameraParams {
  integration_time_seconds?: number;
  frame_count?: number;
  binning_x?: number | null;
  binning_y?: number | null;
  gain?: number | null;
  frame_type?: string | null;
  filter_name?: string | null;
}

// The semantic task — the user-defined portion SK nests inside a TaskExecution.
interface TaskPayload {
  task_type?: string;
  end_time?: string;
  target?: Record<string, unknown>;
  camera_params?: CameraParams;
  sidereal_frames?: number[];
  [k: string]: unknown;
}

// SK's TaskExecution envelope: server-minted identity (`task_id`) wrapping the
// semantic `task`, plus execution params (`context`, `expiry_time`).
interface TaskExecution {
  task: TaskPayload | null;
  task_id?: string;
  controller_id?: string;
  context?: Record<string, unknown> | null;
  expiry_time?: string | null;
}

interface ControllerState {
  enable_state: { enabled: boolean };
  operating_state: { current: string; previous: string | null; target: string | null };
  execution_state: {
    executing: boolean;
    aborting: boolean;
    finished: TaskFinishedRecord | null;
    execution: TaskExecution | null;
    context: Record<string, unknown> | null;
  };
}

interface ProgramState {
  enable_state: { enabled: boolean; controller: string };
  active_state: {
    active: boolean;
    origin: string;
    stopping: boolean;
    contexts: Record<string, unknown>;
  };
  // Optional defensively: a partial/legacy ProgramState snapshot may lack it.
  tasking_state?: { executing_task: TaskExecution | null };
}

// === Page ===

export function TasksPage() {
  const entities = useSensorKitStore((s) => s.entities);
  const state = useSensorKitStore((s) => s.state);
  const connection = useSensorKitStore((s) => s.connection);

  const controllers = entities.filter((e) => e.entity_type === "controller");
  const programs = entities.filter((e) => e.entity_type === "program");

  const agentState = useSensorKitStore((s) => s.getAgentState)() ?? undefined;
  const agentCapabilities =
    useSensorKitStore((s) => s.getAgentCapabilities)() ?? null;

  // When SensorKit isn't reachable, collapse the page to a single line —
  // matches DevicesPage / StatusPage. SK LIVE pill in the top nav covers
  // the connection state itself.
  if (connection !== "open") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-6xl mx-auto p-4 text-text-dim text-sm">
          Waiting for SensorKit connection…
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-4 space-y-6">
        <Section title="Agent">
          {agentState ? <AgentCard state={agentState} /> : <Empty>Waiting for agent state…</Empty>}
        </Section>

        <Section title={`Programs (${programs.length})`}>
          {programs.length === 0 ? (
            <Empty>No programs.</Empty>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {programs.map((p) => (
                <ProgramCard
                  key={p.name}
                  entity={p}
                  programState={state[p.name]?.["ProgramState"] as ProgramState | undefined}
                  excluded={agentState?.scheduler_state.excluded_programs.includes(p.name) ?? false}
                  controllers={controllers}
                />
              ))}
            </div>
          )}
        </Section>

        <Section title={`Controllers (${controllers.length})`}>
          {controllers.length === 0 ? (
            <Empty>No controllers.</Empty>
          ) : (
            <div className="space-y-3">
              {controllers.map((c) => {
                const caps = state[c.name]?.["Capabilities"] as Capabilities | undefined;
                const cameraId = caps?.devices?.["camera"];
                const cameraTel =
                  cameraId
                    ? (state[cameraId]?.["CameraTelemetry"] as CameraTelemetry | undefined)
                    : undefined;
                return (
                  <ControllerCard
                    key={c.name}
                    entity={c}
                    controllerState={state[c.name]?.["ControllerState"] as ControllerState | undefined}
                    scheduleWindows={agentState?.scheduler_state.schedule?.[c.name] ?? []}
                    agentCapabilities={agentCapabilities}
                    cameraTelemetry={cameraTel}
                  />
                );
              })}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// === Sections ===

export function AgentCard({ state }: { state: AgentState }) {
  const ctrlEntries = Object.entries(state.operating_state.controllers);
  return (
    <div className="bg-panel-bg/60 border border-panel-border rounded-lg p-3 space-y-2 text-xs">
      <div className="flex flex-wrap gap-2">
        <Pill
          label={state.operating_state.global_control_enabled ? "global on" : "global off"}
          tone={state.operating_state.global_control_enabled ? "good" : "off"}
        />
        <Pill
          label={state.scheduler_state.scheduling_enabled ? "scheduler on" : "scheduler off"}
          tone={state.scheduler_state.scheduling_enabled ? "good" : "off"}
        />
        {state.scheduler_state.excluded_programs.length > 0 && (
          <Pill
            label={`${state.scheduler_state.excluded_programs.length} excluded`}
            tone="bad"
          />
        )}
      </div>
      {ctrlEntries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          {ctrlEntries.map(([id, cs]) => (
            <div key={id} className="flex items-center gap-2 font-mono">
              <span className="text-text-bright">{id}</span>
              <span className="text-text-dim">
                {cs.control_enabled ? "enabled" : "disabled"} · elected{" "}
                {cs.elected_state ? "yes" : "no"}
                {cs.demand_override ? ` · override ${cs.demand_override}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface CameraTelemetry {
  percent_completed: number | null;
  last_exposure_duration: number | null;
  last_exposure_start_time: string | null;
}

function ControllerCard({
  entity,
  controllerState,
  scheduleWindows,
  agentCapabilities,
  cameraTelemetry,
}: {
  entity: EntityListing;
  controllerState: ControllerState | undefined;
  scheduleWindows: ScheduleEntry[];
  agentCapabilities: AgentCapabilities | null;
  cameraTelemetry: CameraTelemetry | undefined;
}) {
  const now = useNow();
  const opCurrent = controllerState?.operating_state.current ?? "—";
  const opTarget = controllerState?.operating_state.target;
  const ex = controllerState?.execution_state;
  // Unwrap the TaskExecution envelope: identity is on the envelope, the
  // semantic fields (task_type/target/camera_params/end_time) are nested.
  const execution = ex?.execution ?? null;
  const task = execution?.task ?? null;

  const currentTaskId = execution?.task_id ?? null;
  const currentTaskType = task?.task_type ?? null;

  return (
    <div className="bg-panel-bg/60 border border-panel-border rounded-lg p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-text-bright font-semibold truncate">{entity.name}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Pill label={entity.online ? "online" : "offline"} tone={entity.online ? "good" : "off"} />
          {controllerState && (
            <Pill
              label={controllerState.enable_state.enabled ? "enabled" : "disabled"}
              tone={controllerState.enable_state.enabled ? "good" : "off"}
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div className="space-y-1">
          <div className="text-[10px] text-text-dim uppercase tracking-wide">Operating</div>
          <div className="font-mono text-text-bright">
            {opCurrent}
            {opTarget && opTarget !== opCurrent && (
              <span className="text-text-dim"> → {opTarget}</span>
            )}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-[10px] text-text-dim uppercase tracking-wide">Execution</div>
          {ex?.executing ? (
            <div className="font-mono text-orange-300">
              {ex.aborting ? "aborting" : "running"}
              {currentTaskType && <span className="text-text-dim"> · {currentTaskType}</span>}
              {currentTaskId && (
                <div className="text-[10px] text-text-dim truncate" title={currentTaskId}>
                  {currentTaskId.slice(0, 8)}…
                </div>
              )}
            </div>
          ) : (
            <div className="font-mono text-text-dim">
              idle
              {ex?.finished && (
                <span className="ml-1 text-[10px]">
                  · last {fmtFinished(ex.finished)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {ex?.executing && task && (
        <TaskDetails
          task={task}
          taskId={currentTaskId}
          context={ex.context}
          now={now}
          cameraTel={cameraTelemetry}
        />
      )}

      <div className="space-y-2">
        <div className="text-[10px] text-text-dim uppercase tracking-wide">
          Schedule
        </div>
        {scheduleWindows.length === 0 ? (
          <div className="text-xs text-text-dim">No scheduled windows.</div>
        ) : (
          <ScheduleStrip
            controllerName={entity.name}
            schedule={scheduleWindows}
            agentCapabilities={agentCapabilities}
          />
        )}
      </div>
    </div>
  );
}

function ProgramCard({
  entity,
  programState,
  excluded,
  controllers,
}: {
  entity: EntityListing;
  programState: ProgramState | undefined;
  excluded: boolean;
  controllers: EntityListing[];
}) {
  const active = programState?.active_state.active ?? false;
  const enabled = programState?.enable_state.enabled ?? false;
  const controller = programState?.enable_state.controller;
  const taskId = programState?.tasking_state?.executing_task?.task_id ?? null;

  const [busy, setBusy] = useState<"enable" | "include" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // For first-time enable, fall back to the only controller if there's
  // exactly one. Otherwise leave the choice to the server (which 422s if
  // none was previously associated).
  const fallbackController =
    controllers.length === 1 ? controllers[0]?.name : undefined;

  const onToggleEnable = async () => {
    setBusy("enable");
    setError(null);
    try {
      if (enabled) await disableProgram(entity.name);
      else await enableProgram(entity.name, controller || fallbackController);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const onToggleInclude = async () => {
    setBusy("include");
    setError(null);
    try {
      if (excluded) await includeProgramInScheduler(entity.name);
      else await excludeProgramFromScheduler(entity.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-panel-bg/60 border border-panel-border rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-text-bright font-semibold truncate">{entity.name}</div>
          <div className="text-[10px] text-text-dim uppercase tracking-wide">
            {controller ?? ""}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <TogglePill
            label={enabled ? "enabled" : "disabled"}
            tone={enabled ? "good" : "off"}
            busy={busy === "enable"}
            disabled={busy !== null}
            onClick={onToggleEnable}
            tooltip={enabled ? "Disable program" : "Enable program"}
          />
          <TogglePill
            label={excluded ? "excluded" : "included"}
            tone={excluded ? "bad" : "good"}
            busy={busy === "include"}
            disabled={busy !== null}
            onClick={onToggleInclude}
            tooltip={
              excluded
                ? "Include program in agent scheduling"
                : "Exclude program from agent scheduling"
            }
          />
          <Pill label={active ? "active" : "inactive"} tone={active ? "good" : "off"} />
        </div>
      </div>

      {error && <div className="text-[10px] text-red-300">{error}</div>}

      <div className="text-xs space-y-1">
        {taskId && (
          <div className="flex gap-2">
            <span className="text-text-dim">Executing</span>
            <span className="font-mono text-text-bright truncate">{taskId}</span>
          </div>
        )}
        {programState?.active_state.stopping && (
          <div className="text-orange-300">Stopping…</div>
        )}
      </div>
    </div>
  );
}

function TaskDetails({
  task,
  taskId,
  context,
  now,
  cameraTel,
}: {
  task: TaskPayload;
  taskId: string | null;
  context: Record<string, unknown> | null;
  now: Date;
  cameraTel: CameraTelemetry | undefined;
}) {
  const target = describeTarget(task.target, context);
  const cp = task.camera_params ?? {};
  const endTime = task.end_time ? new Date(task.end_time) : null;
  const remaining = endTime ? endTime.getTime() - now.getTime() : null;

  // Prefer SK's authoritative frame_num from the task context; useFrameIndex
  // falls back to telemetry-edge counting only when context is absent.
  const frameIndex = useFrameIndex(
    taskId,
    cameraTel,
    context as { frame_num?: number | null } | null,
  );
  const totalFrames = cp.frame_count ?? null;
  const framePct =
    totalFrames && frameIndex !== null
      ? (frameIndex / totalFrames) * 100
      : null;
  const exposurePct = cameraTel?.percent_completed ?? null;

  const trackMode = describeTrackMode(task, frameIndex);

  const ctxRows = context
    ? Object.entries(context)
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
        .slice(0, 8)
    : [];

  return (
    <div className="rounded border border-panel-border bg-black/30 p-2 text-xs space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {target && <DetailRow label="Target" value={target} />}
        {trackMode && <DetailRow label="Tracking" value={trackMode} />}
        {cp.integration_time_seconds != null && (
          <DetailRow label="Integration" value={`${cp.integration_time_seconds}s`} />
        )}
        {cp.frame_count != null && (
          <DetailRow
            label="Frames"
            value={
              frameIndex !== null
                ? `${frameIndex + 1} / ${cp.frame_count}`
                : `${cp.frame_count}`
            }
          />
        )}
        {(cp.binning_x != null || cp.binning_y != null) && (
          <DetailRow label="Binning" value={`${cp.binning_x ?? 1}×${cp.binning_y ?? 1}`} />
        )}
        {cp.gain != null && <DetailRow label="Gain" value={`${cp.gain}`} />}
        {cp.frame_type && <DetailRow label="Frame type" value={cp.frame_type} />}
        {cp.filter_name && <DetailRow label="Filter" value={cp.filter_name} />}
        {endTime && (
          <DetailRow
            label="Deadline"
            value={
              remaining == null
                ? fmtShort(endTime)
                : remaining > 0
                  ? `in ${humanDelta(remaining)} (${fmtShort(endTime)})`
                  : `passed ${humanDelta(-remaining)} ago`
            }
          />
        )}
      </div>

      {framePct !== null && (
        <ProgressBar
          label={`Frame ${frameIndex! + 1} of ${totalFrames}`}
          pct={framePct}
          color="bg-blue-400"
        />
      )}
      {exposurePct !== null && (
        <ProgressBar label="Exposure" pct={exposurePct} color="bg-orange-400" />
      )}

      {ctxRows.length > 0 && (
        <details className="text-[10px]">
          <summary className="text-text-dim cursor-pointer">Runtime context</summary>
          <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-4">
            {ctxRows.map(([k, v]) => (
              <DetailRow key={k} label={k} value={String(v)} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ProgressBar({
  label,
  pct,
  color,
}: {
  label: string;
  pct: number;
  color: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2 text-[10px] text-text-dim">
      <span className="w-32 shrink-0">{label}</span>
      <div className="flex-1 h-1 bg-white/10 rounded overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="font-mono w-8 text-right">{clamped.toFixed(0)}%</span>
    </div>
  );
}


function describeTrackMode(task: TaskPayload, frameIndex: number | null): string | null {
  const targetType = (task.target?.target_type as string | undefined) ?? null;
  const baseLabel = labelFromTargetType(targetType);

  const frames = Array.isArray(task.sidereal_frames) ? task.sidereal_frames : [];
  if (frames.length === 0) return baseLabel;

  // SK encodes frame indices 0-based; display 1-based.
  const human = (i: number) => i + 1;
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  const total = task.camera_params?.frame_count ?? null;

  // A trailing contiguous block (N..last) reads as a one-way switch to sidereal,
  // matching the pre-`sidereal_frames` "switched at frame N" wording. The common
  // last-frame-only case (single index == last frame) flows through here too.
  const from = sorted[0]!;
  const isTrailingBlock =
    total != null &&
    sorted[sorted.length - 1] === total - 1 &&
    sorted.every((f, i) => f === from + i);

  if (isTrailingBlock) {
    if (frameIndex !== null && frameIndex >= from) {
      return `sidereal (switched at frame ${human(from)})`;
    }
    return `${baseLabel} → sidereal at frame ${human(from)}`;
  }

  // Arbitrary set: list the sidereal frames; note when the live frame is one.
  const list = sorted.map(human).join(", ");
  const mode =
    frameIndex !== null && sorted.includes(frameIndex) ? "sidereal" : baseLabel;
  return `${mode} · sidereal on frames ${list}`;
}

function labelFromTargetType(t: string | null): string {
  switch (t) {
    case "tle":
      return "TLE · rate";
    case "fixed":
      return "ICRS (sidereal)";
    case "ephemeris":
      return "ephemeris";
    case "rate":
      return "rate";
    case "state_vector":
      return "state vector";
    case "catalog":
      return "catalog";
    default:
      return t ?? "—";
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 min-w-0">
      <span className="text-text-dim shrink-0">{label}</span>
      <span className="text-text-bright font-mono truncate">{value}</span>
    </div>
  );
}

function describeTarget(
  target: Record<string, unknown> | undefined,
  context: Record<string, unknown> | null,
): string | null {
  // Prefer the `target_id` published in execution context. SK fills it with a
  // useful identifier for TLE (NORAD id) and catalog (object name) targets;
  // for typed-but-unidentified targets it's a generic placeholder like
  // "ICRSTarget" / "RateTarget" that we ignore in favor of the structural data.
  const ctxId =
    typeof context?.target_id === "string" ? context.target_id : null;
  const usefulCtxId = ctxId && !ctxId.endsWith("Target") ? ctxId : null;

  if (!target) return null;
  const type = target.target_type as string | undefined;
  const frame = target.frame as string | undefined;
  switch (type) {
    case "fixed": {
      const coords = target.coords as Record<string, number> | undefined;
      if (frame === "icrf" && coords) {
        return `ICRF ${coords.ra?.toFixed(3)}\u00b0, ${coords.dec?.toFixed(3)}\u00b0`;
      }
      if (frame === "altaz" && coords) {
        return `AltAz ${coords.alt?.toFixed(2)}\u00b0 / ${coords.az?.toFixed(2)}\u00b0`;
      }
      return `fixed (${frame ?? "?"})`;
    }
    case "tle": {
      // Track type ("TLE") is already shown in the Tracking row, so the Target
      // cell shows only the id.
      if (usefulCtxId) return usefulCtxId;
      const tle = target.tle as { line0?: string | null } | undefined;
      return tle?.line0 ? tle.line0.replace(/^0\s+/, "") : "TLE";
    }
    case "catalog": {
      return `catalog: ${usefulCtxId ?? target.object ?? "?"}`;
    }
    case "ephemeris":
      return "ephemeris";
    case "state_vector":
      return "state vector";
    case "rate":
      return "rate";
    default:
      return type ?? null;
  }
}

// === Helpers ===

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs text-text-dim uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-text-dim">{children}</div>;
}

function Pill({
  label,
  tone,
}: {
  label: string;
  tone: "good" | "bad" | "off";
}) {
  const cls =
    tone === "good"
      ? "bg-green-500/15 text-green-300 border-green-500/30"
      : tone === "bad"
        ? "bg-red-500/15 text-red-300 border-red-500/30"
        : "bg-white/5 text-text-dim border-panel-border";
  return (
    <span className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wide rounded border ${cls}`}>
      {label}
    </span>
  );
}

function TogglePill({
  label,
  tone,
  busy,
  disabled,
  onClick,
  tooltip,
}: {
  label: string;
  tone: "good" | "bad" | "off";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  tooltip?: string;
}) {
  const cls =
    tone === "good"
      ? "bg-green-500/15 text-green-300 border-green-500/30 hover:bg-green-500/25"
      : tone === "bad"
        ? "bg-red-500/15 text-red-300 border-red-500/30 hover:bg-red-500/25"
        : "bg-white/5 text-text-dim border-panel-border hover:bg-white/10 hover:text-text-bright";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={tooltip}
      className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wide rounded border transition-colors ${cls} ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      }`}
    >
      {busy ? "…" : label}
    </button>
  );
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function fmtShort(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${h}:${m}`;
}

function humanDelta(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 6) / 10;
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 2.4) / 10;
  return `${d}d`;
}

function fmtFinished(f: TaskFinishedRecord): string {
  const when = f.timestamp ? fmtShort(new Date(f.timestamp)) : "—";
  const status = f.aborted ? "aborted" : f.error ? "failed" : "ok";
  return `${when} (${status})`;
}

