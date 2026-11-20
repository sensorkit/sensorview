import { useEffect, useMemo, useRef, useState } from "react";
import {
  isMountNotReady,
  resolveActiveController,
  useControllerMounts,
  useMountActivities,
  useMountPointings,
  type MountActivity,
  type MountPointing,
} from "../../../lib/sensorkit-client/instruments";
import { useSensorKitStore, type StateMap } from "../../../stores/sensorkit";
import { useFrameIndex } from "../hooks/useFrameIndex";

const EMPTY_STATE: StateMap = {};

/**
 * Compact activity indicator for the status bar with a rich popup on click.
 * Shows the current mount state for the active controller ("idle", "slewing X",
 * "tracking Y", "collecting 2/7"). Clicking opens a panel with per-controller
 * details and a controller selector when more than one is present.
 */
export function MountActivityIndicator() {
  const controllers = useControllerMounts();
  const activities = useMountActivities();
  const pointings = useMountPointings();
  const selectedControllerId = useSensorKitStore((s) => s.selectedControllerId);
  const setSelectedControllerId = useSensorKitStore((s) => s.setSelectedControllerId);

  // Same resolution (and live mount usability) as SkyView's action controls,
  // so both show one selection.
  const active = useMemo<MountActivity | null>(() => {
    const id = resolveActiveController(controllers, selectedControllerId)?.id;
    return activities.find((a) => a.controllerId === id) ?? null;
  }, [controllers, activities, selectedControllerId]);

  // Targeted subscriptions — never the whole `state` map (fresh identity per
  // telemetry flush). These payload references only change when the specific
  // keyword updates, so this component re-renders on real progress only.
  const cameraTel = useSensorKitStore((s) =>
    active?.cameraId && active.kind === "collecting"
      ? (s.state[active.cameraId]?.["CameraTelemetry"] as
          | { percent_completed: number | null }
          | undefined)
      : undefined,
  );
  const controllerState = useSensorKitStore((s) =>
    active
      ? (s.state[active.controllerId]?.["ControllerState"] as
          | { execution_state?: { context?: { frame_num?: number } | null } }
          | undefined)
      : undefined,
  );
  const activeContext = active
    ? controllerState?.execution_state?.context ?? null
    : null;
  const frameIndex = useFrameIndex(
    active?.taskId ?? null,
    cameraTel,
    activeContext,
    active?.cameraId ?? null,
  );

  const [open, setOpen] = useState(false);
  // The rich per-controller popup wants live camera/task detail across ALL
  // controllers. Subscribing to the whole `state` map permanently would
  // re-render this component on every telemetry flush, so only do it while
  // the popup is actually open (a transient, user-initiated window); closed,
  // the selector returns a constant and never re-renders.
  const state = useSensorKitStore((s) => (open ? s.state : EMPTY_STATE));
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!active) return null;

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-panel-border text-[11px] hover:bg-white/5"
        title="Click for details"
      >
        <StatusDot kind={active.kind} />
        <span className="text-text-bright font-mono truncate max-w-[45vw] lg:max-w-[16rem]">
          {describeActivity(active, frameIndex)}
        </span>
        <span className="text-text-dim">▾</span>
      </button>

      {open && (
        <div className="fixed inset-x-2 bottom-12 lg:absolute lg:inset-x-auto lg:bottom-full lg:right-0 lg:mb-1 lg:w-80 z-30 rounded-lg border border-panel-border bg-panel-bg/95 backdrop-blur-md shadow-xl p-2 text-xs space-y-1">
          {activities.map((a) => (
            <ControllerPanel
              key={a.controllerId}
              activity={a}
              pointing={pointings.find((p) => p.controllerId === a.controllerId) ?? null}
              cameraTel={
                a.cameraId
                  ? (state[a.cameraId]?.["CameraTelemetry"] as
                      | { percent_completed: number | null }
                      | undefined)
                  : undefined
              }
              taskContext={
                (state[a.controllerId]?.["ControllerState"] as
                  | { execution_state?: { context?: { frame_num?: number } | null } }
                  | undefined)?.execution_state?.context ?? null
              }
              isActive={a.controllerId === active.controllerId}
              onPick={() => {
                setSelectedControllerId(a.controllerId);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ControllerPanel({
  activity,
  pointing,
  cameraTel,
  taskContext,
  isActive,
  onPick,
}: {
  activity: MountActivity;
  pointing: MountPointing | null;
  cameraTel: { percent_completed: number | null } | undefined;
  taskContext: { frame_num?: number | null } | null;
  isActive: boolean;
  onPick: () => void;
}) {
  const frameIndex = useFrameIndex(
    activity.taskId,
    cameraTel,
    taskContext,
    activity.cameraId,
  );

  // Pull axis-error info for slewing state
  const targetErr = null as number | null; // reserved for future enrichment

  return (
    <button
      onClick={onPick}
      className={`w-full text-left rounded px-2 py-1.5 border ${
        isActive
          ? "border-blue-500/40 bg-blue-500/5"
          : "border-transparent hover:bg-white/5"
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusDot kind={activity.kind} />
        <span className="font-mono text-text-bright truncate">
          {activity.controllerId}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-text-dim">
          {activity.kind.replace(/_/g, " ")}
        </span>
      </div>

      <div className="mt-1 pl-4 space-y-0.5 text-[11px]">
        {activity.detail && (
          <Row label="Target" value={activity.detail} />
        )}
        {activity.mountCandidateCount > 1 && (
          <Row
            label="Mount"
            value={`${activity.mountCandidateCount} candidates (ambiguous)`}
          />
        )}
        {pointing?.radec && (
          <Row
            label="RA/Dec"
            value={`${pointing.radec.ra.toFixed(3)}\u00b0, ${pointing.radec.dec.toFixed(3)}\u00b0`}
          />
        )}
        {pointing?.altaz && (
          <Row
            label="Alt/Az"
            value={`${pointing.altaz.alt.toFixed(2)}\u00b0 / ${pointing.altaz.az.toFixed(2)}\u00b0`}
          />
        )}
        {pointing?.targetDistanceArcsec != null && (
          <Row
            label="Target err"
            value={`${pointing.targetDistanceArcsec.toFixed(2)}″`}
          />
        )}
        {activity.kind === "collecting" && (
          <div className="mt-1 space-y-0.5">
            {/* Counters only for a resolved camera sequence with a known frame. */}
            {frameIndex != null && activity.frameTotal != null && (
              <>
                <Row label="Frame" value={`${frameIndex + 1} / ${activity.frameTotal}`} />
                {activity.frameTotal > 0 && (
                  <Bar
                    pct={(frameIndex / activity.frameTotal) * 100}
                    color="bg-blue-400"
                  />
                )}
              </>
            )}
            {/* Measured exposure from the resolved live camera only. */}
            {activity.cameraId && cameraTel?.percent_completed != null && (
              <>
                <Row
                  label="Exposure"
                  value={`${Math.round(cameraTel.percent_completed)}%`}
                />
                <Bar pct={cameraTel.percent_completed} color="bg-orange-400" />
              </>
            )}
            {activity.taskId && (
              <div className="text-[10px] text-text-dim font-mono truncate" title={activity.taskId}>
                task {activity.taskId.slice(0, 8)}…
              </div>
            )}
          </div>
        )}
        {targetErr != null && <Row label="Error" value={`${targetErr.toFixed(2)}″`} />}
      </div>
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 min-w-0">
      <span className="text-text-dim shrink-0">{label}</span>
      <span className="text-text-bright font-mono truncate">{value}</span>
    </div>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1 bg-white/10 rounded overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

function StatusDot({ kind }: { kind: MountActivity["kind"] }) {
  // Color map: slewing = orange, tracking = blue, collecting = green; all
  // three pulse to indicate live activity. Init/Shutdown/generic-executing
  // pulse amber so they're visually distinct from a real collect but still
  // read as "doing something." Idle = solid gray; offline = solid red.
  // The mount-not-ready kinds are solid amber — the *absence* of a pulse is
  // what separates them from the amber busy states: nothing is happening and
  // nothing will until the mount is connected/enabled/Init'd.
  const cls =
    kind === "idle"
      ? "bg-gray-500"
      : kind === "slewing"
        ? "bg-orange-400 animate-pulse"
        : kind === "tracking"
          ? "bg-blue-400 animate-pulse"
          : kind === "collecting"
            ? "bg-green-400 animate-pulse"
            : kind === "initializing" ||
                kind === "shutting_down" ||
                kind === "executing"
              ? "bg-amber-400 animate-pulse"
              : isMountNotReady(kind) || kind === "mount_ambiguous"
                ? "bg-amber-400"
                : "bg-red-400";
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls}`} />;
}

function describeActivity(a: MountActivity, frameIndex: number | null): string {
  const label = a.detail ? ` ${a.detail}` : "";
  const id = a.controllerId;
  switch (a.kind) {
    case "idle":
      return `${id} · idle`;
    case "offline":
      return `${id} · offline`;
    case "slewing":
      return `${id} · slewing${a.detail ? ` → ${a.detail}` : ""}`;
    case "tracking":
      return `${id} · tracking${label}`;
    case "initializing":
      return `${id} · initializing`;
    case "shutting_down":
      return `${id} · shutting down`;
    case "executing":
      // `detail` carries the SK task_type (e.g. "standby", "calibrate",
      // "recover"). For unknown / null types fall back to a bare verb so
      // we don't render a trailing space.
      return `${id} · ${a.detail ?? "executing"}`;
    case "collecting":
      // Counter only when task, camera, and frame are all resolved.
      return frameIndex != null && a.frameTotal != null
        ? `${id} · collecting ${frameIndex + 1}/${a.frameTotal}`
        : `${id} · collecting`;
    // Mount present but unable to act. Each maps to a specific SK signal
    // (Connected / DeviceState.enable_state / MountAxisEnabled) rather than
    // collapsing into "idle", which would imply a healthy mount sitting still.
    case "mount_disconnected":
      return `${id} · mount disconnected`;
    case "mount_disabled":
      return `${id} · mount disabled`;
    case "mount_uninitialized":
      return `${id} · mount uninitialized`;
    case "mount_ambiguous":
      return `${id} · ${a.mountCandidateCount} mounts`;
  }
}
