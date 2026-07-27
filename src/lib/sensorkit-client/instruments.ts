import { useEffect, useMemo, useRef, useState } from "react";
import {
  isControllerState,
  shallowArrayEqual,
  useSensorKitSlice,
  useSensorKitStore,
  type StateMap,
} from "../../stores/sensorkit";
import { satLabel, useSatelliteStore, type CatalogRecord } from "../../stores/satellites";
import type { Capabilities } from "./types";

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

/**
 * An Instrument is the (controller + its devices) pair the user actually
 * commands. A SensorKit deployment may have multiple.
 */
export interface Instrument {
  id: string;
  online: boolean;
  mount: string | null;
  camera: string | null;
  focuser: string | null;
  rotator: string | null;
  filter_wheel: string | null;
  dome: string | null;
  mirror_cover: string | null;
}

export interface RADec {
  ra: number;
  dec: number;
}

export interface AltAz {
  alt: number;
  az: number;
}

export interface InstrumentPointing {
  instrumentId: string;
  mountId: string;
  radec: RADec | null;
  altaz: AltAz | null;
  targetDistanceArcsec: number | null;
  /** What the mount is commanded to follow — used to anchor the cone's reticle. */
  target: { rangeKm: number; regime: string | undefined } | null;
}

function pickDevice(caps: Capabilities | undefined, type: string): string | null {
  if (!caps?.devices) return null;
  return caps.devices[type] ?? null;
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

function computeInstruments(state: StateMap): Instrument[] {
  // Enumerate controllers from live `state`, not the `entities` snapshot.
  // `entities` is only refetched on SSE (re)connect, so a controller that
  // registers afterward (shut down for maintenance, then brought back up)
  // wouldn't appear until the app reconnected. Its EntityInfo/EntityLease/
  // Capabilities records stream in live, so `state` always has the controller
  // the moment it's back — no reload required.
  return Object.entries(state)
    .filter(([, ent]) => isControllerState(ent))
    .map(([name, ent]) => {
      const caps = ent["Capabilities"] as Capabilities | undefined;
      return {
        id: name,
        // Trust live EntityLease presence — the same lease gate used
        // everywhere else (device pills, mount-state classification).
        online: isEntityLive(state, name),
        mount: pickDevice(caps, "mount"),
        camera: pickDevice(caps, "camera"),
        focuser: pickDevice(caps, "focuser"),
        rotator: pickDevice(caps, "rotator"),
        filter_wheel: pickDevice(caps, "filter_wheel"),
        dome: pickDevice(caps, "dome"),
        mirror_cover: pickDevice(caps, "mirror_cover"),
      };
    })
    // `state` has no inherent order; sort by id so the dropdown stays stable
    // across re-renders and record arrivals.
    .sort((a, b) => a.id.localeCompare(b.id));
}

function instrumentsEqual(a: Instrument[], b: Instrument[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.online !== y.online ||
      x.mount !== y.mount ||
      x.camera !== y.camera ||
      x.focuser !== y.focuser ||
      x.rotator !== y.rotator ||
      x.filter_wheel !== y.filter_wheel ||
      x.dome !== y.dome ||
      x.mirror_cover !== y.mirror_cover
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Derive Instrument list from the sensorkit store.
 *
 * Deliberately does NOT subscribe to the whole `state` map — that identity
 * changes on every telemetry flush, and this hook sits under every SkyView
 * canvas. Instead the instrument list is computed inside the selector and
 * only a *changed* list (controller added/removed, lease flip, capability
 * change) triggers a re-render — i.e. almost never during steady streaming.
 */
export function useInstruments(): Instrument[] {
  return useSensorKitSlice((s) => computeInstruments(s.state), instrumentsEqual);
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
  instrumentId: string;
  kind: MountActivityKind;
  /** Human label describing what the mount is doing (e.g., target name). */
  detail: string | null;
  /** Controller task id when executing. */
  taskId: string | null;
  /** Frame count total when collecting. */
  frameTotal: number | null;
  /** The camera attached to this controller, for frame-progress derivation. */
  cameraId: string | null;
  /** True when the mount is actively slewing or executing — action buttons should disable. */
  busy: boolean;
}

/**
 * Compute activity per instrument from live mount state. Sources, in priority:
 *   1. ControllerState.execution_state  → collecting
 *   2. MountAxisEnabled                  → idle if all axes disabled
 *   3. Position change + target error    → slewing vs tracking vs idle
 *   4. mountTargets (persisted, client)  → human label for what's being followed
 */
export function useMountActivities(): MountActivity[] {
  const instruments = useInstruments();
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
      for (const inst of instruments) {
        out.push(s.state[inst.id]?.["ControllerState"]);
        const m = inst.mount ? s.state[inst.mount] : undefined;
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

  // Per-mount motion history: last observed position + timestamp. Refs are safe
  // to read/write inside useMemo and don't trigger reactivity on their own.
  const motionRef = useRef<
    Record<string, { az: number; alt: number; lastMovedAt: number }>
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
    return instruments.map<MountActivity>((inst) => {
      const base = {
        instrumentId: inst.id,
        cameraId: inst.camera,
        taskId: null as string | null,
        frameTotal: null as number | null,
      };

      if (!inst.online) {
        return { ...base, kind: "offline", detail: null, busy: false };
      }

      // Pull task info up-front so we can attach it to whichever kind
      // ends up winning below (slewing-as-part-of-collect should still
      // carry the task id / frame total in the popup).
      // `execution_state.execution` is SK's `TaskExecution` envelope: the controller
      // mints `task_id` at the top level and nests the semantic task (carrying
      // `task_type` / `target` / `camera_params`) under `.task`.
      const ctrlState = state[inst.id]?.["ControllerState"] as
        | {
            execution_state: {
              executing: boolean;
              execution: {
                task_id?: string;
                task?: {
                  task_type?: string;
                  target?: SkTarget;
                  camera_params?: { frame_count?: number };
                } | null;
              } | null;
              context?: { frame_num?: number } | null;
            };
          }
        | undefined;
      const execution = ctrlState?.execution_state;
      const envelope = execution?.execution ?? null;
      const semantic = envelope?.task ?? null;
      const taskInfo =
        execution?.executing && envelope
          ? {
              taskId: envelope.task_id ?? null,
              frameTotal: semantic?.camera_params?.frame_count ?? null,
              taskType: semantic?.task_type ?? "task",
              target: semantic?.target ?? null,
            }
          : null;
      const baseWithTask = {
        ...base,
        taskId: taskInfo?.taskId ?? null,
        frameTotal: taskInfo?.frameTotal ?? null,
      };

      // "Collecting" should mean a frame is actually in flight. SK's std
      // collect loop publishes `frame_num` into execution_state.context
      // once per frame; until that lands, the mount is just tracking/
      // slewing/idle and labeling the controller "collecting ?/3" is
      // misleading. Detect the liminal-pre-first-frame state here so the
      // task branch can defer to mount-state classification.
      const ctxFrameNum = execution?.context?.frame_num;
      const collectFrameKnown =
        typeof ctxFrameNum === "number" && Number.isFinite(ctxFrameNum);

      // Mount state is only meaningful when the mount entity is alive AND in a
      // state where it can actually act. A stale Slewing/Tracking keyword left
      // in KV after the mount died — or left over from before it was
      // disconnected/disabled/de-Init'd — would otherwise poison this
      // controller's pill. Gate on the lease first, then on readiness.
      const mountLive = !!inst.mount && isEntityLive(state, inst.mount);
      const liveMountState = mountLive ? state[inst.mount!] : undefined;
      const readiness = mountReadiness(inst.mount, liveMountState);

      if (readiness || !liveMountState) {
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
        // `readiness` is null here only when the controller declares no mount.
        return { ...base, kind: readiness ?? "idle", detail: null, busy: false };
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
        const prev = motionRef.current[inst.id];
        if (prev) {
          const delta = Math.max(Math.abs(az - prev.az), Math.abs(alt - prev.alt));
          if (delta > MOTION_DETECTION_DELTA_DEG) {
            motionRef.current[inst.id] = { az, alt, lastMovedAt: now };
          } else {
            motionRef.current[inst.id] = { ...prev, az, alt };
          }
        } else {
          // Seed on first observation — don't backdate lastMovedAt so a
          // post-refresh snapshot→live delta doesn't look like a slew.
          motionRef.current[inst.id] = { az, alt, lastMovedAt: 0 };
        }
      }

      const motion = motionRef.current[inst.id];
      const movedRecently = motion ? now - motion.lastMovedAt < MOTION_STALE_MS : false;

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
      const tracked = mountTargets[inst.id];
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

      // Priority: slewing > collecting > tracking > idle.
      // Slewing wins over the executing-task signal because std collect
      // tasks slew to target as their first phase; without this ordering
      // the dot would read "collecting" the whole time.
      if (isSlewing) {
        return { ...baseWithTask, kind: "slewing", detail: targetLabel, busy: true };
      }
      if (taskInfo) {
        const kind = kindForTaskType(taskInfo.taskType);
        // For collect tasks specifically: defer to mount-state classification
        // while no frame is in flight (task just started, between frames,
        // or non-context-publishing SK). Better to read "tracking" / "idle"
        // than "collecting ?/3" — the latter implies we know less than we do.
        // Init/shutdown/executing don't carry counters, so they always render
        // their kind directly.
        const showAsTask = kind !== "collecting" || collectFrameKnown;
        if (showAsTask) {
          // detail carries the target for collecting (so the popup shows
          // what we're imaging) and the raw task_type for "executing" (so
          // the unknown-task fallback label has something to display);
          // init / shutdown have no useful detail.
          const detail =
            kind === "collecting"
              ? targetLabel
              : kind === "executing"
                ? taskInfo.taskType
                : null;
          return { ...baseWithTask, kind, detail, busy: true };
        }
        // else: fall through to tracking / idle. Keep baseWithTask's taskId
        // and frameTotal so the popup still shows what task is queued.
      }
      // baseWithTask carries the task id / frame total when a task is
      // queued but not actively imaging a frame — popup details should
      // still show "task in flight" info even though the dot reads as
      // tracking/idle for the moment.
      if (isTracking) {
        return {
          ...baseWithTask,
          kind: "tracking",
          detail: targetLabel,
          busy: false,
        };
      }
      return { ...baseWithTask, kind: "idle", detail: null, busy: false };
    });
    // `activityInputs` is the reactivity key for the store data read via
    // getState() above; `tick` re-samples the high-churn keywords at 1Hz.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instruments, activityInputs, mountTargets, tles, tick]);

  // `mountTargets` is client-side intent persisted to localStorage, so a label
  // set by a previous session outlives that session — and outlives the mount
  // that was following it. Drop it as soon as the mount can no longer hold a
  // target, otherwise the old name re-attaches to whatever the mount does next
  // with nothing on the wire backing it. Joined into a string so the effect
  // keys on content, not on the array identity `useMemo` mints each recompute.
  const staleTargetIds = activities
    .filter((a) => a.kind === "offline" || isMountNotReady(a.kind))
    .map((a) => a.instrumentId)
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

function describeTracked(
  tracked:
    | { kind: "satellite"; noradId: string }
    | { kind: "icrs"; ra: number; dec: number }
    | undefined,
  tles: CatalogRecord[],
): string | null {
  if (!tracked) return null;
  if (tracked.kind === "satellite") {
    const tle = tles.find((t) => t.noradId === tracked.noradId);
    return satLabel(tle, tracked.noradId).text;
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
      return satLabel(tles.find((t) => t.noradId === norad), norad).text;
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
 * Mount pointings for every instrument that has a mount and live data.
 *
 * Subscribes only to the three pointing keywords per mount (via a flat,
 * shallow-compared slice) — NOT the whole `state` map — so consumers
 * (SkyCanvas / OverheadCanvas / GroundTrackCanvas reticle layers) re-render
 * when a pointing actually changed, at most once per telemetry flush
 * (~10Hz), instead of on every record of every entity.
 */
export function useMountPointings(): InstrumentPointing[] {
  const instruments = useInstruments();
  const mountTargets = useSensorKitStore((s) => s.mountTargets);
  const positions = useSatelliteStore((s) => s.positions);
  const tles = useSatelliteStore((s) => s.tles);

  // Flat tuple: 4 slots per mounted instrument, aligned with the walk below.
  const pointingSlices = useSensorKitSlice(
    (s) => {
      const out: unknown[] = [];
      for (const inst of instruments) {
        if (!inst.mount) continue;
        const m = s.state[inst.mount];
        out.push(
          m ? 1 : 0,
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
    const out: InstrumentPointing[] = [];
    let i = 0;
    for (const inst of instruments) {
      if (!inst.mount) continue;
      const mountExists = pointingSlices[i] as number;
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
      if (!mountExists) continue;

      // Resolve the commanded target → (range, regime) for the cone reticle.
      const tracked = mountTargets[inst.id];
      let target: InstrumentPointing["target"] = null;
      if (tracked?.kind === "satellite") {
        const sat = positions.find((p) => p.noradId === tracked.noradId);
        const tle = tles.find((t) => t.noradId === tracked.noradId);
        if (sat) target = { rangeKm: sat.range, regime: tle?.orbitRegime };
      }

      out.push({
        instrumentId: inst.id,
        mountId: inst.mount,
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
  }, [instruments, pointingSlices, mountTargets, positions, tles]);
}
