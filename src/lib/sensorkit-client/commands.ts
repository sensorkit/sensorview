import type { TLERecord } from "../../stores/satellites";
import { skUrl } from "../../stores/backends";

// === Target builders ===

export interface ICRSTarget {
  target_type: "fixed";
  frame: "icrf";
  coords: { ra: number; dec: number };
  name?: string | null;
}

export interface AltAzTarget {
  target_type: "fixed";
  frame: "altaz";
  coords: { az: number; alt: number };
}

export interface TLETarget {
  target_type: "tle";
  frame: "teme";
  tle: { line0: string | null; line1: string; line2: string };
}

/**
 * A target moving along a precomputed ephemeris: parallel arrays of UTC Julian
 * Days and ICRF equatorial positions. SensorKit interpolates between samples to
 * track the object (e.g. an asteroid drifting across the frame during a
 * collect). Matches SK's `EphemerisTarget` (astro/target.py).
 */
export interface EphemerisTarget {
  target_type: "ephemeris";
  frame: "icrf";
  jds: number[];
  points: { ra: number; dec: number }[];
}

export type Target = ICRSTarget | AltAzTarget | TLETarget | EphemerisTarget;

export function icrsTarget(raDeg: number, decDeg: number, name?: string | null): ICRSTarget {
  return {
    target_type: "fixed",
    frame: "icrf",
    coords: { ra: raDeg, dec: decDeg },
    name: name ?? null,
  };
}

export function tleTargetFrom(tle: TLERecord): TLETarget {
  return {
    target_type: "tle",
    frame: "teme",
    tle: { line0: tle.name ?? null, line1: tle.line1, line2: tle.line2 },
  };
}

export function ephemerisTarget(
  jds: number[],
  points: { ra: number; dec: number }[],
): EphemerisTarget {
  return { target_type: "ephemeris", frame: "icrf", jds, points };
}

// === Command builders ===

export interface FollowTargetCommand {
  command_id: "FollowTarget";
  target: Target;
}

export function followTarget(target: Target): FollowTargetCommand {
  return { command_id: "FollowTarget", target };
}

export interface SimpleCommand<Id extends string> {
  command_id: Id;
}

export const homeMount = (): SimpleCommand<"Home"> => ({ command_id: "Home" });
export const parkMount = (): SimpleCommand<"MoveToPark"> => ({ command_id: "MoveToPark" });
export const stopMount = (): SimpleCommand<"Stop"> => ({ command_id: "Stop" });

// Generic device lifecycle commands. Applicable to mount, camera, dome, etc. —
// each device module interprets Init/Deinit/Stop/Abort in its own terms.
export const initDevice = (): SimpleCommand<"Init"> => ({ command_id: "Init" });
export const deinitDevice = (): SimpleCommand<"Deinit"> => ({ command_id: "Deinit" });
export const stopDevice = (): SimpleCommand<"Stop"> => ({ command_id: "Stop" });
export const abortDevice = (): SimpleCommand<"Abort"> => ({ command_id: "Abort" });

// Dome
export const openEnclosure = (): SimpleCommand<"OpenEnclosure"> => ({
  command_id: "OpenEnclosure",
});
export const closeEnclosure = (): SimpleCommand<"CloseEnclosure"> => ({
  command_id: "CloseEnclosure",
});

// Mirror cover
export const openMirrorCover = (): SimpleCommand<"OpenMirrorCover"> => ({
  command_id: "OpenMirrorCover",
});
export const closeMirrorCover = (): SimpleCommand<"CloseMirrorCover"> => ({
  command_id: "CloseMirrorCover",
});

// Filter changer — SensorKit's SetFilter accepts either the filter name or its position.
export interface SetFilterCommand {
  command_id: "SetFilter";
  filter: string | number;
}
export const setFilter = (filter: string | number): SetFilterCommand => ({
  command_id: "SetFilter",
  filter,
});

// Focuser — move to a specified position (units defined by the focuser).
export interface ChangeFocusPositionCommand {
  command_id: "ChangeFocusPosition";
  position: number;
}
export const changeFocusPosition = (position: number): ChangeFocusPositionCommand => ({
  command_id: "ChangeFocusPosition",
  position,
});

// Rotator — move to a specified angular position (degrees).
export interface ChangeRotatorPositionCommand {
  command_id: "ChangeRotatorPosition";
  position: number;
}
export const changeRotatorPosition = (position: number): ChangeRotatorPositionCommand => ({
  command_id: "ChangeRotatorPosition",
  position,
});

// === Task builders ===

export interface CameraParameterSet {
  integration_time_seconds: number;
  frame_count: number;
  binning_x?: number | null;
  binning_y?: number | null;
  gain?: number | null;
  frame_type?: "light" | "dark" | "bias" | "flat" | null;
  filter_name?: string | null;
}

// SK split `Task` into a semantic task + a server-minted `TaskExecution`
// envelope. The semantic task carries only domain fields; identity (`task_id`,
// `controller_id`) is assigned by the controller, and execution params
// (`context`, `expiry_time`) ride on the `TaskSubmission` envelope below.
export interface StandardCollectTask {
  task_type: "standard_collect";
  target: Target;
  camera_params: CameraParameterSet;
  /**
   * 0-based frame indices captured under sidereal tracking. Frames not listed
   * follow the target; the mount switches in both directions on transitions.
   * Empty for ordinary star/body collects (those track sidereally via the
   * target itself), and for moving targets you want fully rate-tracked.
   */
  sidereal_frames?: number[];
  // Optional SK domain field used only for program queue ordering. Not set for
  // direct execution — the dispatch deadline rides on the submission's
  // `expiry_time` instead.
  end_time?: string; // ISO datetime
}

/**
 * SK `TaskSubmission` envelope accepted by `POST /controller/{id}/execute`.
 * Bundles a semantic task with the execution params (`context`, `expiry_time`)
 * the controller records on the minted `TaskExecution`. A bare task is
 * equivalent to a submission with no params, so lifecycle tasks skip the envelope.
 */
export interface TaskSubmission<T = unknown> {
  task: T;
  context?: Record<string, unknown> | null;
  expiry_time?: string | null; // ISO datetime
}

export interface StandardCollectOpts {
  integrationSec?: number;
  frameCount?: number;
  endTime?: Date;
  camera?: Partial<CameraParameterSet>;
  /** 0-based frame indices to capture under sidereal tracking (empty = none). */
  siderealFrames?: number[];
  /**
   * Task context (commonly holds `program_name`, which SensorKit's file-path
   * template resolves into the output directory). Threaded onto the minted
   * `TaskExecution` via the `TaskSubmission` envelope, where the collect handler
   * reads it through `task.execution.get_context()`.
   */
  context?: Record<string, unknown> | null;
}

export function standardCollectTask(
  target: Target,
  opts: StandardCollectOpts = {},
): TaskSubmission<StandardCollectTask> {
  const integration = opts.integrationSec ?? 1;
  const frames = opts.frameCount ?? 5;
  // The collection deadline is the dispatch `expiry_time` on the envelope (SK
  // migrated the pre-split `end_time` deadline to `expiry_time`).
  const expiry = opts.endTime ?? new Date(Date.now() + 5 * 60_000);
  return {
    task: {
      task_type: "standard_collect",
      target,
      camera_params: {
        integration_time_seconds: integration,
        frame_count: frames,
        ...opts.camera,
      },
      sidereal_frames: opts.siderealFrames ?? [],
    },
    context: opts.context ?? null,
    expiry_time: expiry.toISOString(),
  };
}

// === HTTP actions ===

async function postJSON(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : res.text();
}

export function sendDeviceCommand(deviceId: string, command: unknown): Promise<unknown> {
  return postJSON(skUrl(`/device/${encodeURIComponent(deviceId)}/command`), command);
}

// `task` may be a bare semantic task (e.g. lifecycle tasks) or a
// `TaskSubmission` envelope carrying `context`/`expiry_time` (e.g. collect tasks).
export function executeControllerTask(controllerId: string, task: unknown): Promise<unknown> {
  return postJSON(skUrl(`/controller/${encodeURIComponent(controllerId)}/execute`), task);
}

// === Program lifecycle ===
//
// Enable/disable gates whether a program *can* source tasks; activate/
// deactivate controls whether it's currently tasking. Enable must precede
// activation. The webapi requires a controller_id either explicitly or
// remembered from a prior enable; pass one when the program has never been
// associated with a controller before.

export function enableProgram(
  programId: string,
  controllerId?: string,
): Promise<unknown> {
  const base = skUrl(`/program/${encodeURIComponent(programId)}/enable`);
  const url = controllerId
    ? `${base}?controller_id=${encodeURIComponent(controllerId)}`
    : base;
  return postJSON(url, {});
}

export function disableProgram(programId: string): Promise<unknown> {
  return postJSON(skUrl(`/program/${encodeURIComponent(programId)}/disable`), {});
}

export function activateProgram(programId: string): Promise<unknown> {
  return postJSON(skUrl(`/program/${encodeURIComponent(programId)}/activate`), {});
}

export function deactivateProgram(programId: string): Promise<unknown> {
  return postJSON(skUrl(`/program/${encodeURIComponent(programId)}/deactivate`), {});
}

// Agent scheduler include/exclude — toggles whether the agent's scheduler
// considers a program when building its windows.
export function includeProgramInScheduler(programId: string): Promise<unknown> {
  return postJSON(
    skUrl(`/agent/scheduler/include/${encodeURIComponent(programId)}`),
    {},
  );
}

export function excludeProgramFromScheduler(programId: string): Promise<unknown> {
  return postJSON(
    skUrl(`/agent/scheduler/exclude/${encodeURIComponent(programId)}`),
    {},
  );
}

/**
 * Globally enable / disable the agent. Maps to SK's `POST /agent/enable`
 * and `POST /agent/disable` endpoints, which flip `global_control_enabled`
 * via `agent_configure_request`. Affects every controller the agent
 * orchestrates.
 */
export function setAgentEnabled(enabled: boolean): Promise<unknown> {
  return postJSON(skUrl(enabled ? "/agent/enable" : "/agent/disable"), {});
}

// === Lifecycle tasks ===
//
// The Standard Controller moves through OFF → INIT → OPERATE → SHUTDOWN.
// Mount/camera commands only work in OPERATE. These builders produce the
// lifecycle tasks you send via executeControllerTask().

export interface LifecycleTask {
  task_type: "init" | "standby" | "shutdown" | "recover";
}

// Identity (`task_id`, `controller_id`) is minted by the controller on dispatch
// since the Task/TaskExecution split; the target controller is addressed by the
// URL path of `executeControllerTask`, so the body is just the semantic task.
function lifecycleTask(taskType: LifecycleTask["task_type"]): LifecycleTask {
  return { task_type: taskType };
}

export const initTask = () => lifecycleTask("init");
export const standbyTask = () => lifecycleTask("standby");
export const shutdownTask = () => lifecycleTask("shutdown");
export const recoverTask = () => lifecycleTask("recover");
