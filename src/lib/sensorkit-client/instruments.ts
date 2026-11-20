import { useEffect, useMemo, useRef, useState } from "react";
import {
  entityTypeOf,
  shallowArrayEqual,
  useSensorKitSlice,
  useSensorKitStore,
  type StateMap,
  type TrackedMountTarget,
} from "../../stores/sensorkit";
import {
  mountCandidatesOf,
  normalizeCameraParams,
  progressCameraOf,
  useControllers,
  type ControllerRow,
} from "./entities";
import {
  isTLE,
  sameSatKey,
  satKeyOf,
  satLabel,
  useSatelliteStore,
  type CatalogRecord,
  type SatKey,
} from "../../stores/satellites";
import type { EntityListing } from "./types";

/**
 * Activity thresholds. The simulator reports `velocity: 0` even while tracking,
 * so we can't use the velocity field directly. Instead we track deltas in
 * `mechanical_position` between renders — any motion above the detection
 * threshold within the recent window counts as "active". Slewing vs tracking
 * is decided by target-distance error rather than raw speed, since a
 * fast-tracking LEO can look like a slew rate-wise.
 */
const SLEWING_ARCSEC_THRESHOLD = 60;
const MOTION_DETECTION_DELTA_DEG = 0.001; // ~3.6″, well above sampling noise
const MOTION_STALE_MS = 5000; // seen motion within this window = still active

const EARTH_R_KM = 6371;
const DEG2RAD = Math.PI / 180;

/** A controller's mount candidates and readiness for direct commands. */
export interface ControllerMount extends ControllerRow {
  mountCandidates: string[];
  mount: string | null;
  /** Reason the unique mount cannot accept a direct command. */
  mountBlocker: MountBlocker | null;
  /** Online controller whose unique mount is leased and ready. */
  mountUsable: boolean;
}

/** Reasons a unique mount can't take a direct FollowTarget command. */
export type MountBlocker = "mount_offline" | MountNotReadyKind;

/**
 * Live gate for direct mount commands: lease, then readiness. The published
 * "mount" archetype is trusted for FollowTarget support — SensorKit's
 * StandardMount requires the command and validates the declared archetype.
 */
function mountBlockerOf(
  mountId: string,
  mountState: Record<string, unknown> | undefined,
): MountBlocker | null {
  if (!mountState || !("EntityLease" in mountState)) return "mount_offline";
  return mountReadiness(mountId, mountState);
}

function candidateListsEqual(a: string[][], b: string[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!shallowArrayEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

/** Subscribe to controller inventory, mount candidates, and mount readiness. */
export function useControllerMounts(): ControllerMount[] {
  const controllers = useControllers();
  const candidates = useSensorKitSlice(
    (s) => controllers.map((c) => mountCandidatesOf(c.details, s.state)),
    candidateListsEqual,
  );
  const blockers = useSensorKitSlice(
    (s) =>
      candidates.map((m) => (m.length === 1 ? mountBlockerOf(m[0]!, s.state[m[0]!]) : null)),
    shallowArrayEqual,
  );
  return useMemo(
    () =>
      controllers.map((c, i) => {
        const mountCandidates = candidates[i] ?? [];
        const mount = mountCandidates.length === 1 ? mountCandidates[0]! : null;
        const mountBlocker = mount ? (blockers[i] ?? null) : null;
        return {
          ...c,
          mountCandidates,
          mount,
          mountBlocker,
          mountUsable: c.online && !!mount && mountBlocker === null,
        };
      }),
    [controllers, candidates, blockers],
  );
}

/**
 * The controller SkyView acts on: an explicit selection when it still exists
 * (with or without a mount), otherwise prefer online with a usable mount,
 * then online, then any with a mount, then the first.
 */
export function resolveActiveController<
  T extends { id: string; online: boolean; mount: string | null; mountUsable: boolean },
>(controllers: T[], selectedId: string | null): T | null {
  if (selectedId) {
    const found = controllers.find((c) => c.id === selectedId);
    if (found) return found;
  }
  return (
    controllers.find((c) => c.mountUsable) ??
    controllers.find((c) => c.online) ??
    controllers.find((c) => c.mount) ??
    controllers[0] ??
    null
  );
}

export interface RADec {
  ra: number;
  dec: number;
}

export interface AltAz {
  alt: number;
  az: number;
}

/**
 * Coordinates measured by `mountId`, associated with `controllerId` for display.
 * SkyView emits a pointing when the controller has exactly one mount candidate
 * and that mount holds a lease.
 */
export interface MountPointing {
  controllerId: string;
  mountId: string;
  radec: RADec | null;
  altaz: AltAz | null;
  targetDistanceArcsec: number | null;
  /** What the mount is commanded to follow — used to anchor the cone's reticle. */
  target: { rangeKm: number; regime: string | undefined } | null;
}

/**
 * True iff the entity currently holds a broker-level EntityLease. This is
 * the canonical "is X alive right now" signal per SK's design — when an
 * entity's lease expires (process death, ctrl-c, broker timeout, etc.)
 * other KV state for that entity can linger as stale data, so consumers
 * must gate on the lease before trusting anything else they read.
 *
 * SK's webapi forwards lease delete events as records with `payload: null`,
 * and our applyOne reducer pops the key on null — so `in` here is honest.
 */
export function isEntityLive(
  state: Record<string, Record<string, unknown> | undefined>,
  entityName: string,
): boolean {
  const ent = state[entityName];
  return !!ent && "EntityLease" in ent;
}

/**
 * Reconstruct the entity listing from live `state` rather than the one-shot
 * `/entities` snapshot. Every entity publishes an EntityInfo keyword (type +
 * details) on attach and holds an EntityLease while alive, both over the
 * firehose — so an entity that registers *after* the SSE (re)connect shows up
 * here immediately, where the snapshot misses it until the next reconnect or a
 * manual page refresh.
 *
 * Carries name/entity_type/online/details — NOT archetype/traits, which only
 * the richer REST listing computes. Consumers needing those keep reading the
 * store's `entities` snapshot; this serves callers that key off type/online
 * (e.g. the Tasks tab's program + controller cards).
 */
function computeEntities(state: StateMap): EntityListing[] {
  const out: EntityListing[] = [];
  for (const [name, ent] of Object.entries(state)) {
    const entity_type = entityTypeOf(ent);
    if (!entity_type) continue; // no EntityInfo yet → not listable (matches /entities)
    const info = ent["EntityInfo"] as
      | { details?: Record<string, unknown> | null }
      | undefined;
    out.push({
      entity_type,
      name,
      // Same lease gate as useControllers — honest liveness, unlike the
      // snapshot's `online` which freezes at reconnect.
      online: isEntityLive(state, name),
      details: info?.details ?? null,
    });
  }
  // `state` has no inherent order; sort by name so the list stays stable
  // across re-renders and record arrivals.
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function entitiesEqual(a: EntityListing[], b: EntityListing[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.name !== y.name || x.entity_type !== y.entity_type || x.online !== y.online) {
      return false;
    }
  }
  return true;
}

/**
 * Live entity listing derived from the firehose — a self-healing replacement
 * for the store's `/entities` snapshot for consumers that only need
 * name/entity_type/online. Slice-cached like useControllers, so only
 * add/remove/lease-flips trigger a re-render, not every telemetry flush.
 */
export function useEntities(): EntityListing[] {
  return useSensorKitSlice((s) => computeEntities(s.state), entitiesEqual);
}

/**
 * Walk a straight ray of length `rangeKm` in 3D space from the observer in
 * direction (altDeg, azDeg). Returns the geodetic position of the endpoint.
 *
 * Uses ECEF math (spherical Earth) rather than a great-circle path, so all
 * points along a sight-line project to the same great-circle on the ground
 * regardless of range — which is what you want for visualizing a pointing
 * ray on the overhead/ground-track views.
 */
export function rayEndpoint(
  observer: { lat: number; lon: number; alt: number },
  altDeg: number,
  azDeg: number,
  rangeKm: number,
): { lat: number; lon: number; altKm: number } {
  const altR = altDeg * DEG2RAD;
  const azR = azDeg * DEG2RAD;
  const latR = observer.lat * DEG2RAD;
  const lonR = observer.lon * DEG2RAD;

  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const sinLon = Math.sin(lonR);
  const cosLon = Math.cos(lonR);

  // Observer ECEF position (spherical Earth)
  const obsR = EARTH_R_KM + observer.alt / 1000;
  const obsX = obsR * cosLat * cosLon;
  const obsY = obsR * cosLat * sinLon;
  const obsZ = obsR * sinLat;

  // Sight-line direction in local ENU (east, north, up)
  const e = Math.sin(azR) * Math.cos(altR);
  const n = Math.cos(azR) * Math.cos(altR);
  const u = Math.sin(altR);

  // ENU → ECEF rotation
  const dx = -sinLon * e - sinLat * cosLon * n + cosLat * cosLon * u;
  const dy = cosLon * e - sinLat * sinLon * n + cosLat * sinLon * u;
  const dz = cosLat * n + sinLat * u;

  // End point ECEF
  const endX = obsX + rangeKm * dx;
  const endY = obsY + rangeKm * dy;
  const endZ = obsZ + rangeKm * dz;

  // Back to geodetic (spherical Earth)
  const endR = Math.sqrt(endX * endX + endY * endY + endZ * endZ);
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, endZ / endR))) / DEG2RAD,
    lon: Math.atan2(endY, endX) / DEG2RAD,
    altKm: endR - EARTH_R_KM,
  };
}

// === Mount activity ===

/**
 * Top-level activity classification. The non-collect "executing" task kinds
 * map to specific labels rather than collapsing into "collecting"; previously
 * any in-flight ControllerTask (Init/Shutdown/Standby/etc.) would read as
 * "collecting" which both mis-labeled the state and showed "?/?" frame
 * counters because non-collect tasks don't carry camera_params.
 */
export type MountActivityKind =
  | "idle"
  | "slewing"
  | "tracking"
  | "collecting"      // CollectTask family (e.g. standard_collect)
  | "initializing"    // InitTask
  | "shutting_down"   // ShutdownTask
  | "executing"       // Any other ControllerTask (standby, calibrate, recover, …)
  // Mount is present but can't act — see `mountReadiness`. Distinct from
  // "idle" (healthy mount sitting still) and "offline" (controller gone).
  | "mount_disconnected"
  | "mount_disabled"
  | "mount_uninitialized"
  // More than one controlled device publishes the "mount" archetype, so no
  // single mount's status or pointing represents this controller.
  | "mount_ambiguous"
  | "offline";

/** The `mountReadiness` kinds — mount present but not in a state to act. */
export type MountNotReadyKind = Extract<
  MountActivityKind,
  "mount_disconnected" | "mount_disabled" | "mount_uninitialized"
>;

const MOUNT_NOT_READY_KINDS = new Set<MountActivityKind>([
  "mount_disconnected",
  "mount_disabled",
  "mount_uninitialized",
]);

export function isMountNotReady(kind: MountActivityKind): boolean {
  return MOUNT_NOT_READY_KINDS.has(kind);
}

/**
 * Why the mount can't be trusted to report motion, or null when it can.
 *
 * An EntityLease alone isn't enough. The mount *process* can be up and
 * refreshing its lease while the hardware is disconnected, its command
 * handlers disabled, or its axes never Init'd. In every one of those cases
 * SK's `Slewing` / `Tracking` / `AxisRates` / `MountTargetDistance` keywords
 * still hold whatever the last live session left in KV — `applyOne` pops only
 * the single prop a null payload names, so an expired lease clears
 * `EntityLease` and nothing else. Reading motion keywords in these states
 * republishes a stale status, which is what this gate exists to prevent.
 */
export function mountReadiness(
  mountId: string | null,
  mountState: Record<string, unknown> | undefined,
): MountNotReadyKind | null {
  // Controller declares no mount at all — there's no mount status to report,
  // stale or otherwise. Callers fall back to plain "idle".
  if (!mountId) return null;
  // Configured but absent from `state`, or lease expired: it's gone.
  if (!mountState) return "mount_disconnected";

  // `Connected` (sensorkit/std/traits.py) — published by every MustConnect
  // device, including the pwi4 mount's slow-status loop.
  const connected = (
    mountState["Connected"] as { is_connected?: boolean } | undefined
  )?.is_connected;
  if (connected === false) return "mount_disconnected";

  // Two separate enable signals: `DeviceState.enable_state.enabled`
  // (sensorkit/core/device.py) is the command-handler gate every device
  // publishes; `Enabled.is_enabled` is the MustEnable trait keyword, present
  // only on devices declaring that trait. Either false → won't act on commands.
  const handlersEnabled = (
    mountState["DeviceState"] as
      | { enable_state?: { enabled?: boolean } }
      | undefined
  )?.enable_state?.enabled;
  const traitEnabled = (
    mountState["Enabled"] as { is_enabled?: boolean } | undefined
  )?.is_enabled;
  if (handlersEnabled === false || traitEnabled === false) {
    return "mount_disabled";
  }

  // No SK keyword reports "Init'd" directly — Init/Deinit are DeviceCommands,
  // not state. Axis enablement is the observable proxy: Init brings the axes
  // up, Deinit/Shutdown drops them. All-axes-disabled therefore reads as
  // un-Init'd, which is truer than the bare "idle" this used to return.
  const axEn = mountState["MountAxisEnabled"] as
    | { axis: { enabled: boolean; axis: string }[] }
    | undefined;
  if (axEn && !axEn.axis.some((a) => a.enabled)) return "mount_uninitialized";

  return null;
}

/**
 * Map SK's ControllerTask.task_type discriminator to one of our kinds.
 * Tasks SK defines today: init, shutdown, standby, calibrate, recover,
 * collect, standard_collect (+ any future subclasses).
 */
function kindForTaskType(taskType: string): Extract<
  MountActivityKind,
  "collecting" | "initializing" | "shutting_down" | "executing"
> {
  if (taskType === "init") return "initializing";
  if (taskType === "shutdown") return "shutting_down";
  if (taskType === "collect" || taskType === "standard_collect") return "collecting";
  return "executing";
}

export interface MountActivity {
  controllerId: string;
  /** The controller's unique mount, or null for zero or ambiguous candidates. */
  mountId: string | null;
  /** Number of nominal mount candidates the controller publishes. */
  mountCandidateCount: number;
  kind: MountActivityKind;
  /** Human label describing what the mount is doing (e.g., target name). */
  detail: string | null;
  /** Controller task id when executing. */
  taskId: string | null;
  /** SK semantic task_type of the in-flight controller task (e.g.
   * "standard_collect"), or null when idle. Survives the slew-to-target phase
   * of a collect, where `kind` reads "slewing" — so consumers can tell a
   * collect is running before the first frame lands. */
  taskType: string | null;
  /** Frame count total when collecting a single camera sequence. */
  frameTotal: number | null;
  /**
   * The live camera whose progress represents the running collect (see
   * progressCameraOf). Null when there is no single resolved camera.
   */
  cameraId: string | null;
  /** True when the mount is actively slewing or executing — action buttons should disable. */
  busy: boolean;
}

/** ControllerState fields read for activity, per the verified wire shape. */
type ControllerStateLike = {
  execution_state: {
    executing: boolean;
    execution: {
      task_id?: string;
      task?: {
        task_type?: string;
        target?: SkTarget;
        camera_params?: unknown;
      } | null;
    } | null;
    context?: { frame_num?: number } | null;
  };
};

/**
 * Compute activity per controller from live mount state. Sources, in priority:
 *   1. ControllerState.execution_state  → collecting
 *   2. MountAxisEnabled                  → idle if all axes disabled
 *   3. Position change + target error    → slewing vs tracking vs idle
 *   4. mountTargets (persisted, client)  → human label for what's being followed
 * Mount state is read only for a controller's unique mount candidate.
 */
export function useMountActivities(): MountActivity[] {
  const controllers = useControllerMounts();
  const mountTargets = useSensorKitStore((s) => s.mountTargets);
  const tles = useSatelliteStore((s) => s.tles);

  // Reactive inputs: only the low-frequency keywords that should trigger an
  // immediate recompute (task starts/stops, axis enable, explicit slewing/
  // tracking flips, lease changes). The high-churn keywords — AxisRates and
  // MountTargetDistance tick at telemetry rate while tracking — are sampled
  // non-reactively via `getState()` on the 1s tick below instead, so this
  // hook's consumers (MountActivityIndicator, DetailSheet, DevicesPage)
  // re-render at ~1Hz rather than per telemetry flush. Consequences: the
  // motion-detection deltas and the maxErr slewing *fallback* update at 1Hz,
  // which is well within MOTION_STALE_MS and only matters on SK builds old
  // enough to lack the explicit Slewing/Tracking keywords.
  const activityInputs = useSensorKitSlice(
    (s) => {
      const out: unknown[] = [];
      for (const c of controllers) {
        const cs = s.state[c.id]?.["ControllerState"] as ControllerStateLike | undefined;
        out.push(cs);
        // The progress camera depends on device metadata and camera leases
        // outside ControllerState; resolving it here makes a reassignment or
        // camera lease flip recompute without subscribing to telemetry.
        const exec = cs?.execution_state;
        out.push(
          exec?.executing && exec.execution
            ? progressCameraOf(c.details, exec.execution.task?.camera_params, s.state)
            : null,
        );
        const m = c.mount ? s.state[c.mount] : undefined;
        out.push(
          m ? 1 : 0,
          m && "EntityLease" in m ? 1 : 0,
          // Readiness keywords — all low-frequency (published on change /
          // slow-status cadence), so subscribing to them costs nothing.
          m?.["Connected"],
          m?.["DeviceState"],
          m?.["Enabled"],
          m?.["MountAxisEnabled"],
          m?.["Slewing"],
          m?.["Tracking"],
        );
      }
      return out;
    },
    shallowArrayEqual,
  );

  // Per-controller motion history for its resolved mount: last observed
  // position + timestamp. Samples are discarded when the resolved mount
  // changes, so one mount's position never seeds another's motion delta.
  // Refs are safe to read/write inside useMemo and don't trigger reactivity.
  const motionRef = useRef<
    Record<string, { mountId: string; az: number; alt: number; lastMovedAt: number }>
  >({});

  // Tick every second: rolls the "seen motion within 5s" window over AND
  // drives the 1Hz sampling of the non-reactive high-churn keywords
  // (AxisRates / MountTargetDistance) read via getState() below.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const activities = useMemo(() => {
    // Non-reactive snapshot — recomputed when the reactive inputs change or
    // the 1s tick fires, NOT on every telemetry flush.
    const state = useSensorKitStore.getState().state;
    const now = Date.now();
    const motion = motionRef.current;
    for (const id of Object.keys(motion)) {
      const c = controllers.find((x) => x.id === id);
      if (!c || c.mount !== motion[id]!.mountId) delete motion[id];
    }
    return controllers.map<MountActivity>((c) => {
      const base = {
        controllerId: c.id,
        mountId: c.mount,
        mountCandidateCount: c.mountCandidates.length,
        cameraId: null as string | null,
        taskId: null as string | null,
        taskType: null as string | null,
        frameTotal: null as number | null,
      };

      if (!c.online) {
        return { ...base, kind: "offline", detail: null, busy: false };
      }

      // Pull task info up-front so we can attach it to whichever kind
      // ends up winning below (slewing-as-part-of-collect should still
      // carry the task id / frame total in the popup).
      // `execution_state.execution` is SK's `TaskExecution` envelope: the controller
      // mints `task_id` at the top level and nests the semantic task (carrying
      // `task_type` / `target` / `camera_params`) under `.task`.
      const ctrlState = state[c.id]?.["ControllerState"] as ControllerStateLike | undefined;
      const execution = ctrlState?.execution_state;
      const envelope = execution?.execution ?? null;
      const semantic = envelope?.task ?? null;
      // `camera_params` is one sequence or a list of concurrent ones. A frame
      // total (and camera progress) only describes a single sequence.
      const sequences = normalizeCameraParams(semantic?.camera_params);
      const frameCount = sequences?.length === 1 ? sequences[0]!.frame_count : undefined;
      const taskInfo =
        execution?.executing && envelope
          ? {
              taskId: envelope.task_id ?? null,
              frameTotal: typeof frameCount === "number" ? frameCount : null,
              taskType: semantic?.task_type ?? "task",
              target: semantic?.target ?? null,
              cameraId: progressCameraOf(c.details, semantic?.camera_params, state),
            }
          : null;
      const baseWithTask = {
        ...base,
        cameraId: taskInfo?.cameraId ?? null,
        taskId: taskInfo?.taskId ?? null,
        taskType: taskInfo?.taskType ?? null,
        frameTotal: taskInfo?.frameTotal ?? null,
      };

      // Mount state is only meaningful when the mount entity is alive AND in a
      // state where it can actually act. A stale Slewing/Tracking keyword left
      // in KV after the mount died — or left over from before it was
      // disconnected/disabled/de-Init'd — would otherwise poison this
      // controller's pill. Gate on the lease first, then on readiness.
      // Only a unique mount candidate is read; an ambiguous set has no
      // single mount whose status represents the controller.
      const ambiguous = c.mountCandidates.length > 1;
      const mountId = c.mount;
      const liveMountState =
        mountId && isEntityLive(state, mountId) ? state[mountId] : undefined;
      const readiness = mountReadiness(mountId, liveMountState);

      if (ambiguous || readiness || !liveMountState) {
        // An in-flight controller task outranks readiness: it's gated on the
        // *controller's* own lease, so it's live evidence rather than retained
        // KV. A running Init task is precisely when the mount is legitimately
        // still disconnected — "initializing" beats "mount disconnected" there.
        if (taskInfo) {
          const kind = kindForTaskType(taskInfo.taskType);
          return {
            ...baseWithTask,
            kind,
            detail: kind === "executing" ? taskInfo.taskType : null,
            busy: true,
          };
        }
        // `readiness` is null here only when the controller has no unique mount.
        return {
          ...base,
          kind: ambiguous ? "mount_ambiguous" : (readiness ?? "idle"),
          detail: null,
          busy: false,
        };
      }
      const mountState = liveMountState;

      // Distinguish slewing vs tracking vs idle using position deltas
      // (sim reports velocity=0 even while tracking, so we derive motion from
      // mechanical_position change over time) and target-distance error.
      const rates = mountState["AxisRates"] as
        | {
            azimuth?: { mechanical_position?: number | null };
            altitude?: { mechanical_position?: number | null };
          }
        | undefined;
      const az = rates?.azimuth?.mechanical_position ?? null;
      const alt = rates?.altitude?.mechanical_position ?? null;

      if (az !== null && alt !== null) {
        const prev = motion[c.id];
        if (prev && prev.mountId === mountId) {
          const delta = Math.max(Math.abs(az - prev.az), Math.abs(alt - prev.alt));
          if (delta > MOTION_DETECTION_DELTA_DEG) {
            motion[c.id] = { mountId, az, alt, lastMovedAt: now };
          } else {
            motion[c.id] = { ...prev, az, alt };
          }
        } else {
          // Seed on first observation of this mount — don't backdate
          // lastMovedAt so a post-refresh snapshot→live delta (or a switch
          // to a different mount) doesn't look like a slew.
          motion[c.id] = { mountId: mountId!, az, alt, lastMovedAt: 0 };
        }
      }

      const sample = motion[c.id];
      const movedRecently =
        sample && sample.mountId === mountId ? now - sample.lastMovedAt < MOTION_STALE_MS : false;

      const dist = mountState["MountTargetDistance"] as
        | { axis: { distance_arcseconds: number }[] }
        | undefined;
      const maxErr = dist
        ? Math.max(...dist.axis.map((a) => Math.abs(a.distance_arcseconds)), 0)
        : 0;

      // Prefer the target embedded in the controller's active task (so
      // Otto-driven flows have a target label too) over SV's own
      // mountTargets store, which only gets populated by the manual Track
      // buttons in the SkyView.
      const tracked = mountTargets[c.id];
      const targetLabel =
        targetLabelFromTask(taskInfo?.target, tles) ??
        describeTracked(tracked, tles);

      // Authoritative signals from SK's mount keywords (added on
      // `/opt/sensorkit/core/src/sensorkit/models/devices.py` — Slewing /
      // Tracking, with `is_slewing` / `is_tracking` boolean fields). Each
      // mount module is responsible for publishing them; when they're
      // missing (e.g. an older module hasn't been updated yet) we fall
      // back to the local heuristics so the indicator still reflects
      // *something* sensible.
      const explicitSlewing = (
        mountState["Slewing"] as { is_slewing?: boolean } | undefined
      )?.is_slewing;
      const explicitTracking = (
        mountState["Tracking"] as { is_tracking?: boolean } | undefined
      )?.is_tracking;

      const isSlewing =
        explicitSlewing !== undefined
          ? explicitSlewing
          : maxErr > SLEWING_ARCSEC_THRESHOLD;
      const isTracking =
        explicitTracking !== undefined ? explicitTracking : movedRecently;

      // Priority: slewing > running task > tracking > idle.
      // Slewing wins over the executing-task signal because std collect
      // tasks slew to target as their first phase; without this ordering
      // the dot would read "collecting" the whole time.
      if (isSlewing) {
        return { ...baseWithTask, kind: "slewing", detail: targetLabel, busy: true };
      }
      if (taskInfo) {
        // A running collect stays busy while its camera or frame is unresolved.
        const kind = kindForTaskType(taskInfo.taskType);
        const detail =
          kind === "collecting"
            ? targetLabel
            : kind === "executing"
              ? taskInfo.taskType
              : null;
        return { ...baseWithTask, kind, detail, busy: true };
      }
      if (isTracking) {
        return { ...base, kind: "tracking", detail: targetLabel, busy: false };
      }
      return { ...base, kind: "idle", detail: null, busy: false };
    });
    // `activityInputs` is the reactivity key for the store data read via
    // getState() above; `tick` re-samples the high-churn keywords at 1Hz.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controllers, activityInputs, mountTargets, tles, tick]);

  // `mountTargets` is client-side intent persisted to localStorage, so a label
  // set by a previous session outlives that session — and outlives the mount
  // that was following it. Drop it as soon as the mount can no longer hold a
  // target, otherwise the old name re-attaches to whatever the mount does next
  // with nothing on the wire backing it. Joined into a string so the effect
  // keys on content, not on the array identity `useMemo` mints each recompute.
  const staleTargetIds = activities
    // Clear intent for ambiguous mounts even during a controller task.
    .filter(
      (a) => a.kind === "offline" || isMountNotReady(a.kind) || a.mountCandidateCount > 1,
    )
    .map((a) => a.controllerId)
    .join(" ");
  useEffect(() => {
    if (!staleTargetIds) return;
    const store = useSensorKitStore.getState();
    for (const id of staleTargetIds.split(" ")) {
      if (store.mountTargets[id]) store.setMountTarget(id, null);
    }
  }, [staleTargetIds]);

  return activities;
}

/**
 * SatKey for a commanded satellite target. Entries persisted before
 * state-vector support carry no `elementSet` and were necessarily TLEs.
 */
function trackedSatKey(tracked: {
  noradId: string;
  elementSet?: SatKey["kind"];
}): SatKey {
  return { kind: tracked.elementSet ?? "tle", noradId: tracked.noradId };
}

function describeTracked(
  tracked: TrackedMountTarget | undefined,
  tles: CatalogRecord[],
): string | null {
  if (!tracked) return null;
  if (tracked.kind === "satellite") {
    // Matched on element set as well as id: picking whichever record happens
    // to sort first would label a tracked TLE "SV · X" (or the reverse).
    const key = trackedSatKey(tracked);
    const record = tles.find((t) => sameSatKey(satKeyOf(t), key));
    return satLabel(record, tracked.noradId).text;
  }
  return `${tracked.ra.toFixed(2)}\u00b0, ${tracked.dec.toFixed(2)}\u00b0`;
}

/**
 * Shape of SK's serialized `Target` union, discriminated on `target_type`.
 * Only the cases we render are typed \u2014 anything else falls through and the
 * label-builder returns null (caller substitutes another source).
 */
type SkTarget =
  | {
      target_type: "tle";
      tle: { line0?: string; line1?: string; line2?: string };
    }
  | {
      target_type: "icrs";
      coords?: { ra?: number; dec?: number };
    }
  | {
      target_type: "altaz";
      coords?: { alt?: number; az?: number };
    }
  | {
      target_type: "fixed";
      coords?: { ra?: number; dec?: number; alt?: number; az?: number };
    };

/**
 * Derive a human label for a controller task's target. Falls back to null
 * for target types we don't know how to render \u2014 caller can substitute
 * SV's own mountTargets store in that case.
 */
function targetLabelFromTask(
  target: SkTarget | null | undefined,
  tles: CatalogRecord[],
): string | null {
  if (!target) return null;
  if (target.target_type === "tle" && target.tle?.line1) {
    // TLE line 1 starts with `1 NNNNNU YY...`, so the 2nd whitespace
    // token is the NORAD ID with a one-letter classification suffix.
    const parts = target.tle.line1.split(/\s+/);
    const norad = parts[1]?.replace(/[A-Za-z]$/, "");
    if (norad) {
      // Not `match.name` \u2014 sources without a line0 store a synthesized
      // "SAT 12545" placeholder, which would leak into the pill.
      // Restricted to TLE records: the task's own target_type says a TLE was
      // commanded, so a same-id state vector must not supply the label.
      return satLabel(
        tles.find((t) => isTLE(t) && t.noradId === norad),
        norad,
      ).text;
    }
    // Last resort \u2014 line0 sometimes carries the satellite name with a "0 "
    // prefix per TheSky's TLE conventions.
    const line0 = target.tle.line0?.replace(/^0\s+/, "").trim();
    return line0 || null;
  }
  if (
    (target.target_type === "icrs" || target.target_type === "fixed") &&
    "coords" in target &&
    target.coords?.ra != null &&
    target.coords?.dec != null
  ) {
    return `${target.coords.ra.toFixed(2)}\u00b0, ${target.coords.dec.toFixed(2)}\u00b0`;
  }
  if (
    target.target_type === "altaz" &&
    "coords" in target &&
    target.coords?.alt != null &&
    target.coords?.az != null
  ) {
    return `Az ${target.coords.az.toFixed(1)}\u00b0 Alt ${target.coords.alt.toFixed(1)}\u00b0`;
  }
  return null;
}

/**
 * Mount pointings for every controller with a unique, leased mount.
 * Controllers with ambiguous mount candidates get no single-mount overlay, and
 * a mount without an EntityLease is skipped so retained KV pointings never
 * render as current.
 *
 * Subscribes only to the three pointing keywords per mount (via a flat,
 * shallow-compared slice) — NOT the whole `state` map — so consumers
 * (SkyCanvas / OverheadCanvas / GroundTrackCanvas reticle layers) re-render
 * when a pointing actually changed, at most once per telemetry flush
 * (~10Hz), instead of on every record of every entity.
 */
export function useMountPointings(): MountPointing[] {
  const controllers = useControllerMounts();
  const mountTargets = useSensorKitStore((s) => s.mountTargets);
  const positions = useSatelliteStore((s) => s.positions);
  const tles = useSatelliteStore((s) => s.tles);

  // Flat tuple: 4 slots per uniquely mounted controller, aligned with the walk below.
  const pointingSlices = useSensorKitSlice(
    (s) => {
      const out: unknown[] = [];
      for (const c of controllers) {
        if (!c.mount) continue;
        const m = s.state[c.mount];
        out.push(
          m && "EntityLease" in m ? 1 : 0,
          m?.["RADecPointing"],
          m?.["AltAzPointing"],
          m?.["MountTargetDistance"],
        );
      }
      return out;
    },
    shallowArrayEqual,
  );

  return useMemo(() => {
    const out: MountPointing[] = [];
    let i = 0;
    for (const c of controllers) {
      if (!c.mount) continue;
      const mountLive = pointingSlices[i] as number;
      // Axes are nullable on the wire: SensorKit publishes an unknown axis as
      // NaN, which arrives as JSON null. A half-known pointing is not a usable
      // pointing — the reticle math and the readout both need both axes — so a
      // null in either slot collapses the whole pair to null below.
      const raw = pointingSlices[i + 1] as
        | { right_ascension_hours: number | null; declination_degrees: number | null }
        | undefined;
      const alt = pointingSlices[i + 2] as
        | { altitude_degrees: number | null; azimuth_degrees: number | null }
        | undefined;
      const dist = pointingSlices[i + 3] as
        | { distance_arcseconds: number | null }
        | undefined;
      i += 4;
      if (!mountLive) continue;

      // Resolve the commanded target → (range, regime) for the cone reticle.
      const tracked = mountTargets[c.id];
      let target: MountPointing["target"] = null;
      if (tracked?.kind === "satellite") {
        // Element-set-matched: a TLE and a state vector for the same object
        // give different ranges, so the cone must read the one commanded.
        const key = trackedSatKey(tracked);
        const sat = positions.find((p) => sameSatKey(p, key));
        const record = tles.find((t) => sameSatKey(satKeyOf(t), key));
        if (sat) target = { rangeKm: sat.range, regime: record?.orbitRegime };
      }

      out.push({
        controllerId: c.id,
        mountId: c.mount,
        radec:
          raw?.right_ascension_hours != null && raw.declination_degrees != null
            ? { ra: raw.right_ascension_hours * 15, dec: raw.declination_degrees }
            : null,
        altaz:
          alt?.altitude_degrees != null && alt.azimuth_degrees != null
            ? { alt: alt.altitude_degrees, az: alt.azimuth_degrees }
            : null,
        targetDistanceArcsec: dist?.distance_arcseconds ?? null,
        target,
      });
    }
    return out;
  }, [controllers, pointingSlices, mountTargets, positions, tles]);
}
