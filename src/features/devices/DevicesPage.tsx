import { useMemo, useState } from "react";
import {
  entityTypeOf,
  useSensorKitSlice,
  useSensorKitStore,
  type StateMap,
} from "../../stores/sensorkit";
import { useFeatureFlags } from "../../stores/featureFlags";
import {
  deviceDetailsOf,
  useControllers,
  type ControllerDevice,
  type ControllerRow,
} from "../../lib/sensorkit-client/entities";
import {
  abortDevice,
  closeEnclosure,
  closeMirrorCover,
  deinitDevice,
  executeControllerTask,
  homeMount,
  initDevice,
  initTask,
  openEnclosure,
  openMirrorCover,
  parkMount,
  sendDeviceCommand,
  changeFocusPosition,
  changeRotatorPosition,
  setFilter,
  shutdownTask,
  standbyTask,
  stopDevice,
} from "../../lib/sensorkit-client/commands";
import type { DeviceDetails } from "../../lib/sensorkit-client/types";

// Display labels for standard archetypes. A Map accepts any published name.
const ARCHETYPE_LABELS = new Map<string, string>([
  ["filter_changer", "filter changer"],
  ["mirror_cover", "mirror cover"],
]);

// Order standard devices by optical path. Sort other archetypes by name.
const ARCHETYPE_ORDER = new Map<string, number>([
  ["weather", 0],
  ["enclosure", 1],
  ["mirror_cover", 2],
  ["mount", 3],
  ["rotator", 4],
  ["focuser", 5],
  ["filter_changer", 6],
  ["camera", 7],
  ["safety", 8],
  ["switch", 9],
]);

function archetypeLabel(archetype: string | null): string {
  if (archetype === null) return "device";
  return ARCHETYPE_LABELS.get(archetype) ?? archetype;
}

/** Small-caps styling for known names; custom names keep their published case. */
function archetypeLabelClass(archetype: string | null): string {
  return archetype === null || ARCHETYPE_ORDER.has(archetype)
    ? "uppercase tracking-wide"
    : "font-mono";
}

/** Sort by archetype (light-travel order, then name; none last), then by ID. */
function compareByArchetype(
  a: { id: string; archetype: string | null },
  b: { id: string; archetype: string | null },
): number {
  const rank = (x: string | null) =>
    x === null ? 100 : (ARCHETYPE_ORDER.get(x) ?? 99);
  const d = rank(a.archetype) - rank(b.archetype);
  if (d !== 0) return d;
  if (a.archetype !== b.archetype) {
    return (a.archetype ?? "").localeCompare(b.archetype ?? "");
  }
  return a.id.localeCompare(b.id);
}

// === Live device entities ===

/** A device entity from live state. Liveness and archetype are separate. */
interface DeviceRow {
  id: string;
  /** Holds an EntityLease right now. */
  online: boolean;
  /** Validated EntityInfo.details; null when unpublished or malformed. */
  details: DeviceDetails | null;
}

function archetypeOf(row: DeviceRow | undefined): string | null {
  return row?.details?.archetype ?? null;
}

function computeDeviceRows(state: StateMap): DeviceRow[] {
  const rows: DeviceRow[] = [];
  for (const [id, ent] of Object.entries(state)) {
    if (entityTypeOf(ent) !== "device") continue;
    rows.push({ id, online: "EntityLease" in ent, details: deviceDetailsOf(ent) });
  }
  return rows.sort((a, b) =>
    compareByArchetype(
      { id: a.id, archetype: archetypeOf(a) },
      { id: b.id, archetype: archetypeOf(b) },
    ),
  );
}

function deviceRowsEqual(a: DeviceRow[], b: DeviceRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    // `details` is cached by payload identity, so `!==` means republished.
    if (x.id !== y.id || x.online !== y.online || x.details !== y.details) return false;
  }
  return true;
}

/** Re-renders on device add/remove, lease flips, and republished details only. */
function useDeviceRows(): DeviceRow[] {
  return useSensorKitSlice((s) => computeDeviceRows(s.state), deviceRowsEqual);
}

export function DevicesPage() {
  const connection = useSensorKitStore((s) => s.connection);
  const controllers = useControllers();
  const devices = useDeviceRows();
  const deviceIndex = useMemo(
    () => new Map(devices.map((d) => [d.id, d])),
    [devices],
  );

  // When SensorKit isn't reachable, collapse the page to a single line —
  // there's nothing real to show, and the SK LIVE pill in the top nav
  // already signals the connection state.
  if (connection !== "open") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-6xl mx-auto p-4">
          <div className="text-sm text-text-dim">
            Waiting for SensorKit connection…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-4 space-y-6">
          {/* Controllers and lifecycle actions */}
        {controllers.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-[11px] text-text-dim uppercase tracking-wider">
              Controllers
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {controllers.map((c) => (
                <ControllerCard key={c.id} controller={c} deviceIndex={deviceIndex} />
              ))}
            </div>
          </section>
        )}

        {/* Devices */}
        <section className="space-y-2">
          <h2 className="text-[11px] text-text-dim uppercase tracking-wider">
            Devices
          </h2>
          {devices.length === 0 ? (
            <div className="text-sm text-text-dim">No devices reported.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {devices.map((d) => (
                <DeviceCard key={d.id} row={d} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// === Controller card ===

type ActionStatus =
  | { phase: "idle" }
  | { phase: "pending"; label: string }
  | { phase: "ok"; label: string }
  | { phase: "err"; label: string; message: string };

/**
 * Controller lifecycle tasks this page can send, keyed by the task class name
 * the controller publishes in `supported_tasks`. A button is shown only when
 * the controller lists that exact class name. Init asks for confirmation.
 */
const LIFECYCLE_TASKS = [
  { taskClass: "InitTask", label: "Init", build: initTask },
  { taskClass: "StandbyTask", label: "Standby", build: standbyTask },
  { taskClass: "ShutdownTask", label: "Shutdown", build: shutdownTask },
] as const;

type LifecycleTask = (typeof LIFECYCLE_TASKS)[number];

function ControllerCard({
  controller,
  deviceIndex,
}: {
  controller: ControllerRow;
  deviceIndex: Map<string, DeviceRow>;
}) {
  const [status, setStatus] = useState<ActionStatus>({ phase: "idle" });
  const [confirmInitOpen, setConfirmInitOpen] = useState(false);
  // Primitive selector result: re-renders only when the state string changes.
  const operatingState = useSensorKitStore(
    (s) =>
      (s.state[controller.id]?.["OperatingState"] as { current?: string } | undefined)
        ?.current ?? null,
  );

  const { id, details, online } = controller;
  const tasks: LifecycleTask[] = details
    ? LIFECYCLE_TASKS.filter((t) => details.supported_tasks.includes(t.taskClass))
    : [];
  const init = tasks.find((t) => t.taskClass === "InitTask");

  const run = async (task: LifecycleTask) => {
    const label = task.label;
    setStatus({ phase: "pending", label });
    try {
      await executeControllerTask(id, task.build());
      setStatus({ phase: "ok", label });
      setTimeout(() => setStatus({ phase: "idle" }), 3500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ phase: "err", label, message });
    }
  };

  const busy = status.phase === "pending";

  return (
    <div className="@container bg-panel-bg/60 border border-panel-border rounded-lg p-3 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-text-bright font-semibold truncate">
            {id}
          </div>
          <div className="text-[10px] text-text-dim uppercase tracking-wide">
            controller
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Pill label={online ? "online" : "offline"} tone={online ? "good" : "off"} />
          {operatingState && (
            <Pill
              label={operatingState.toLowerCase()}
              tone={operatingState === "OPERATE" ? "good" : "off"}
            />
          )}
        </div>
      </div>

      {/* Devices */}
      {details ? (
        <ControllerInventory controller={controller} deviceIndex={deviceIndex} />
      ) : (
        <div className="text-[10px] text-text-dim">
          Controller details unavailable
        </div>
      )}

      {/* Actions — lifecycle tasks the controller publishes in
          supported_tasks. Mount-specific Home/Park live on the mount card. */}
      {tasks.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1 border-t border-panel-border">
          {tasks.map((t) => (
            <ControlBtn
              key={t.taskClass}
              label={t.label}
              tooltip={t.taskClass}
              disabled={busy || !online}
              onClick={() => (t === init ? setConfirmInitOpen(true) : run(t))}
            />
          ))}
        </div>
      )}

      {/* Status */}
      {status.phase !== "idle" && (
        <div
          className={`text-[10px] font-mono ${
            status.phase === "err"
              ? "text-red-400"
              : status.phase === "ok"
                ? "text-green-400"
                : "text-text-dim"
          }`}
          title={status.phase === "err" ? status.message : undefined}
        >
          {status.phase === "pending" && `${status.label}…`}
          {status.phase === "ok" && `${status.label} sent`}
          {status.phase === "err" && `${status.label} failed: ${truncate(status.message, 80)}`}
        </div>
      )}

      {confirmInitOpen && (
        <InitConfirmModal
          controllerId={id}
          // Re-checked live: the lease or supported_tasks may change while
          // the dialog is open.
          canConfirm={online && !busy && init !== undefined}
          onConfirm={() => {
            setConfirmInitOpen(false);
            if (init) run(init);
          }}
          onCancel={() => setConfirmInitOpen(false)}
        />
      )}
    </div>
  );
}

function InitConfirmModal({
  controllerId,
  canConfirm,
  onConfirm,
  onCancel,
}: {
  controllerId: string;
  canConfirm: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="bg-panel-bg border border-panel-border rounded-lg p-5 max-w-sm w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-text-bright mb-4 break-all">
          Initialize {controllerId}?
        </h3>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="py-1 px-3 pointer-coarse:py-2 rounded text-[11px] font-medium border bg-black/40 text-text-bright border-panel-border hover:bg-black/60"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className="py-1 px-3 pointer-coarse:py-2 rounded text-[11px] font-medium border bg-accent/30 text-text-bright border-accent/50 hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function ControllerInventory({
  controller,
  deviceIndex,
}: {
  controller: ControllerRow;
  deviceIndex: Map<string, DeviceRow>;
}) {
  const instruments = controller.details?.instruments ?? [];
  const baseDevices: ControllerDevice[] = [];
  const devicesByInstrument = new Map<string, ControllerDevice[]>(
    instruments.map(({ name }) => [name, []]),
  );

  for (const device of controller.devices) {
    const archetype = archetypeOf(deviceIndex.get(device.id));
    // A single chain cannot distinguish root devices until SensorKit publishes placement.
    const showAtBase =
      instruments.length === 1 && (archetype === "mount" || archetype === "enclosure");
    const [instrumentName] = device.chains;
    const instrumentDevices =
      !showAtBase && device.chains.length === 1 && instrumentName !== undefined
        ? devicesByInstrument.get(instrumentName)
        : undefined;
    (instrumentDevices ?? baseDevices).push(device);
  }

  const deviceList = (devices: ControllerDevice[]) => (
    <ul className="flex flex-col gap-0.5">
      {[...devices]
        .sort((a, b) =>
          compareByArchetype(
            { id: a.id, archetype: archetypeOf(deviceIndex.get(a.id)) },
            { id: b.id, archetype: archetypeOf(deviceIndex.get(b.id)) },
          ),
        )
        .map((device) => (
          <InventoryDeviceRow key={device.id} device={device} row={deviceIndex.get(device.id)} />
        ))}
    </ul>
  );

  return (
    <div className="flex flex-col gap-1.5">
      {controller.devices.length === 0 ? (
        <NoDevices />
      ) : (
        baseDevices.length > 0 && deviceList(baseDevices)
      )}
      {instruments.map((chain) => {
        const devices = devicesByInstrument.get(chain.name);
        return (
          <div key={chain.name} className="flex flex-col gap-0.5 pt-1">
            <div className="text-[11px] font-semibold leading-4 tracking-wide text-text-bright whitespace-pre-wrap break-all">
              {chain.name}
            </div>
            {devices && devices.length > 0 && <div className="pl-2">{deviceList(devices)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function NoDevices() {
  return <span className="text-[10px] text-text-dim">No devices</span>;
}

function InventoryDeviceRow({
  device,
  row,
}: {
  device: ControllerDevice;
  row: DeviceRow | undefined;
}) {
  const archetype = archetypeOf(row);
  const label = archetypeLabel(archetype);
  const title = [
    `${label} · ${device.id}`,
    row ? (row.online ? "Online" : "Offline") : "No device entity for this ID",
    device.controlled ? "In controlled_devices" : "Not in controlled_devices",
    device.chains.length > 0 ? `Instrument chains: ${device.chains.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <li title={title} className="flex min-w-0 items-center gap-1.5 py-0.5 text-[10px] text-text-dim">
      <span className={`max-w-[45%] shrink-0 truncate ${archetypeLabelClass(archetype)}`}>
        {label}
      </span>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 truncate font-mono text-text-bright">{device.id}</span>
      {row ? (
        <span
          role="img"
          aria-label={row.online ? "Online" : "Offline"}
          className={`ml-auto size-1.5 shrink-0 rounded-full ${
            row.online ? "bg-green-400" : "bg-white/20"
          }`}
        />
      ) : (
        <span className="ml-auto shrink-0">no entity</span>
      )}
    </li>
  );
}

function ControlBtn({
  label,
  disabled,
  onClick,
  tooltip,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  tooltip?: string;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={tooltip}
      className={`shrink-0 py-1 px-2.5 pointer-coarse:py-2 pointer-coarse:px-3 rounded text-[11px] font-medium border transition-colors ${
        disabled
          ? "bg-black/20 text-text-dim border-panel-border opacity-50 cursor-not-allowed"
          : "bg-black/40 text-text-bright border-panel-border hover:bg-black/60 hover:border-text-dim"
      }`}
    >
      {label}
    </button>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// === Card shell ===

const EMPTY_STATE: Record<string, unknown> = {};

interface DeviceBodyProps {
  state: Record<string, unknown>;
  deviceId: string;
  /** Validated EntityInfo.details.supported_commands — gates direct actions. */
  supportedCommands: string[];
}

/**
 * Specialized card bodies by published archetype name (exact match). Any
 * other archetype — or none — gets the generic body. No inference from
 * traits, commands, or telemetry keywords.
 */
const ARCHETYPE_BODIES = new Map<string, (props: DeviceBodyProps) => React.ReactNode>([
  ["mount", MountBody],
  ["camera", CameraBody],
  ["focuser", FocuserBody],
  ["rotator", RotatorBody],
  ["filter_changer", FilterChangerBody],
  ["enclosure", EnclosureBody],
  ["mirror_cover", MirrorCoverBody],
  ["weather", WeatherBody],
]);

function DeviceCard({ row }: { row: DeviceRow }) {
  // Per-card subscription: the entity's own keyword map only changes identity
  // when one of its records arrives, so other devices' telemetry is ignored.
  const deviceState = useSensorKitStore((s) => s.state[row.id]) ?? EMPTY_STATE;
  const { details } = row;
  const archetype = details?.archetype ?? null;
  const Body = archetype !== null ? ARCHETYPE_BODIES.get(archetype) : undefined;
  const connected =
    (deviceState["Connected"] as { is_connected: boolean } | undefined)?.is_connected ?? null;
  const enabled =
    (
      (deviceState["DeviceState"] as { enable_state: { enabled: boolean } } | undefined)
        ?.enable_state
    )?.enabled ?? null;

  return (
    <div className="@container bg-panel-bg/60 border border-panel-border rounded-lg p-3 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-text-bright font-semibold truncate">{row.id}</div>
          <div
            className={`text-[10px] text-text-dim break-all ${archetypeLabelClass(archetype)}`}
          >
            {details ? archetypeLabel(archetype) : "device · details unavailable"}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Pill label={row.online ? "online" : "offline"} tone={row.online ? "good" : "off"} />
          <Pill
            label={connected === null ? "—" : connected ? "connected" : "disconnected"}
            tone={connected ? "good" : connected === false ? "bad" : "off"}
          />
          <Pill
            label={enabled === null ? "" : enabled ? "enabled" : "disabled"}
            tone={enabled ? "good" : enabled === false ? "off" : "hidden"}
          />
        </div>
      </div>

      {/* Body */}
      {Body && details ? (
        <Body
          state={deviceState}
          deviceId={row.id}
          supportedCommands={details.supported_commands}
        />
      ) : (
        <GenericBody state={deviceState} />
      )}
    </div>
  );
}

// Hook + row used to render per-device action buttons when direct device
// control is enabled. Each action is an async command dispatched via
// sendDeviceCommand; the row renders a transient status line on pending/ok/err.
type DirectAction = { label: string; cmd: () => unknown };

function DirectActionRow({
  deviceId,
  actions,
  supportedCommands,
  noTopBorder = false,
}: {
  deviceId: string;
  actions: DirectAction[];
  // command_ids the target device handles, from validated
  // EntityInfo.details.supported_commands. Actions whose cmd() produces a
  // command_id outside this list are hidden.
  supportedCommands: string[];
  // Drop the top border + extra padding when this row stacks directly below
  // another action row (so the two read as one block instead of two).
  noTopBorder?: boolean;
}) {
  const enabled = useFeatureFlags((s) => s.directDeviceControl);
  const [status, setStatus] = useState<ActionStatus>({ phase: "idle" });

  if (!enabled) return null;

  const visibleActions = actions.filter((a) => {
    const id = (a.cmd() as { command_id?: string }).command_id;
    return id !== undefined && supportedCommands.includes(id);
  });

  if (visibleActions.length === 0) return null;

  const run = async (label: string, cmd: () => unknown) => {
    setStatus({ phase: "pending", label });
    try {
      await sendDeviceCommand(deviceId, cmd());
      setStatus({ phase: "ok", label });
      setTimeout(() => setStatus({ phase: "idle" }), 3500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ phase: "err", label, message });
    }
  };

  const busy = status.phase === "pending";

  return (
    <div className={noTopBorder ? "mt-1" : "pt-2 mt-1 border-t border-panel-border"}>
      <div className="flex flex-wrap gap-1">
        {visibleActions.map((a) => {
          // Stop/Abort are interrupters — they exist to cancel an in-flight
          // action, so they must remain clickable even while another command
          // on this row is pending.
          const id = (a.cmd() as { command_id?: string }).command_id;
          const isInterrupter = id === "Stop" || id === "Abort";
          return (
            <ControlBtn
              key={a.label}
              label={a.label}
              disabled={busy && !isInterrupter}
              onClick={() => run(a.label, a.cmd)}
            />
          );
        })}
      </div>
      {status.phase !== "idle" && (
        <div
          className={`mt-1 text-[10px] font-mono ${
            status.phase === "err"
              ? "text-red-400"
              : status.phase === "ok"
                ? "text-green-400"
                : "text-text-dim"
          }`}
          title={status.phase === "err" ? status.message : undefined}
        >
          {status.phase === "pending" && `${status.label}…`}
          {status.phase === "ok" && `${status.label} sent`}
          {status.phase === "err" && `${status.label} failed: ${truncate(status.message, 80)}`}
        </div>
      )}
    </div>
  );
}

// === Device-specific bodies ===

// Pointing axes are nullable on the wire even when the keyword itself is
// present: SensorKit publishes an unknown axis as NaN, which serializes to JSON
// null (a dome that failed to home reports az=nan, alt=0.0). These fields are
// reached through an unchecked `as` cast, so declaring them non-nullable buys no
// safety — it just hides the null from the compiler until `.toFixed()` throws.
interface RADecPointing {
  right_ascension_hours: number | null;
  declination_degrees: number | null;
  reference_frame?: string;
}
interface AltAzPointing {
  altitude_degrees: number | null;
  azimuth_degrees: number | null;
}
interface AxisEnabled {
  axis: { enabled: boolean; axis: string }[];
}
interface AxisDistance {
  axis: { distance_arcseconds: number | null; axis: string }[];
}

function MountBody({
  state,
  deviceId,
  supportedCommands,
}: {
  state: Record<string, unknown>;
  deviceId: string;
  supportedCommands: string[];
}) {
  const radec = state["RADecPointing"] as RADecPointing | undefined;
  const altaz = state["AltAzPointing"] as AltAzPointing | undefined;
  const axEn = state["MountAxisEnabled"] as AxisEnabled | undefined;
  const dist = state["MountTargetDistance"] as AxisDistance | undefined;

  const azEnabled = axEn?.axis.find((a) => a.axis === "azimuth")?.enabled;
  const altEnabled = axEn?.axis.find((a) => a.axis === "altitude")?.enabled;
  const azErr = dist?.axis.find((a) => a.axis === "azimuth")?.distance_arcseconds;
  const altErr = dist?.axis.find((a) => a.axis === "altitude")?.distance_arcseconds;

  // SensorKit reports RA in hours; the display is degrees. Convert only once we
  // know the value is real — `null * 15` is 0, which would render a confident
  // "0.0000°" for an axis the mount can't actually report.
  const raDegrees =
    radec?.right_ascension_hours == null ? null : radec.right_ascension_hours * 15;

  return (
    <>
      <Metrics>
      {radec && (
        <>
          <Metric label="RA" value={fmtNum(raDegrees, 4)} />
          <Metric label="Dec" value={fmtNum(radec.declination_degrees, 4)} />
        </>
      )}
      {altaz && (
        <>
          <Metric label="Alt" value={fmtNum(altaz.altitude_degrees, 2)} />
          <Metric label="Az" value={fmtNum(altaz.azimuth_degrees, 2)} />
        </>
      )}
      {axEn && (
        <Metric
          label="Axes"
          value={
            azEnabled === undefined
              ? "—"
              : `az ${azEnabled ? "on" : "off"} / alt ${altEnabled ? "on" : "off"}`
          }
        />
      )}
      {/* `!= null` rather than `!== undefined`: a present-but-null axis passes an
          undefined check and then throws on .toFixed(). Still hidden when neither
          axis reports at all — that's absent telemetry, not an unknown reading. */}
      {dist && (azErr != null || altErr != null) && (
        <Metric
          label="Err"
          value={`${fmtNum(azErr, 2, "″")} / ${fmtNum(altErr, 2, "″")}`}
        />
      )}
      </Metrics>
      <DirectActionRow
        deviceId={deviceId}
        supportedCommands={supportedCommands}
        actions={[
          { label: "Init", cmd: initDevice },
          { label: "Deinit", cmd: deinitDevice },
          { label: "Home", cmd: homeMount },
          { label: "Park", cmd: parkMount },
          { label: "Stop", cmd: stopDevice },
        ]}
      />
    </>
  );
}

interface CameraTelemetry {
  ccd_temperature: number | null;
  heatsink_temperature: number | null;
  cooler_power_percent: number | null;
  last_exposure_duration: number | null;
  last_exposure_start_time: string | null;
  percent_completed: number | null;
}
interface CameraCurrentSettings {
  binning_x: number;
  binning_y: number;
  roi_start_x: number;
  roi_start_y: number;
  roi_num_x: number;
  roi_num_y: number;
  readout_mode: number;
  gain: number | null;
  offset: number | null;
  frame_type: string | null;
  cooler_on: boolean;
  ccd_temperature_setpoint: number | null;
}
interface SensorSize {
  x: number;
  y: number;
}

function tempUnitGlyph(units: string): string {
  switch (units?.toUpperCase()) {
    case "FAHRENHEIT": return "F";
    case "KELVIN": return "K";
    default: return "C";
  }
}

function CameraBody({
  state,
  deviceId,
  supportedCommands,
}: {
  state: Record<string, unknown>;
  deviceId: string;
  supportedCommands: string[];
}) {
  const tel = state["CameraTelemetry"] as CameraTelemetry | undefined;
  const cur = state["CameraCurrentSettings"] as CameraCurrentSettings | undefined;
  const size = state["CameraSensorSize"] as SensorSize | undefined;
  const sensorTemp = state["CameraSensorTemperature"] as
    | { temperature: number; units: string }
    | undefined;

  const exposing = (tel?.percent_completed ?? 0) > 0 && (tel?.percent_completed ?? 0) < 100;

  return (
    <>
      <Metrics>
      {sensorTemp && (
        <Metric
          label="Temperature"
          value={`${sensorTemp.temperature.toFixed(1)} \u00b0${tempUnitGlyph(sensorTemp.units)}`}
        />
      )}
      {tel?.ccd_temperature !== undefined && tel.ccd_temperature !== null && (
        <Metric
          label="CCD"
          value={`${tel.ccd_temperature.toFixed(1)} \u00b0C${
            cur?.ccd_temperature_setpoint != null ? ` → ${cur.ccd_temperature_setpoint.toFixed(1)}` : ""
          }`}
        />
      )}
      {tel?.cooler_power_percent != null && (
        <Metric
          label="Cooler"
          value={`${cur?.cooler_on ? "on" : "off"} · ${tel.cooler_power_percent.toFixed(0)}%`}
        />
      )}
      {cur && size && (
        <Metric
          label="ROI"
          value={`${cur.roi_num_x}×${cur.roi_num_y} (${size.x}×${size.y})`}
        />
      )}
      {cur && <Metric label="Binning" value={`${cur.binning_x}×${cur.binning_y}`} />}
      {cur?.gain != null && <Metric label="Gain" value={`${cur.gain}`} />}
      {cur?.offset != null && <Metric label="Offset" value={`${cur.offset}`} />}
      {cur?.frame_type && <Metric label="Frame" value={cur.frame_type} />}
      {tel?.last_exposure_duration != null && (
        <Metric label="Last exp" value={`${tel.last_exposure_duration.toFixed(2)} s`} />
      )}
      {exposing && (
        <div className="col-span-2 mt-1">
          <div className="flex items-center gap-2 text-[10px] text-text-dim">
            <span>Exposing</span>
            <div className="flex-1 h-1 bg-white/10 rounded overflow-hidden">
              <div
                className="h-full bg-orange-400"
                style={{ width: `${Math.max(0, Math.min(100, tel?.percent_completed ?? 0))}%` }}
              />
            </div>
            <span className="font-mono">{(tel?.percent_completed ?? 0).toFixed(0)}%</span>
          </div>
        </div>
      )}
      </Metrics>
      <DirectActionRow
        deviceId={deviceId}
        supportedCommands={supportedCommands}
        actions={[
          { label: "Abort", cmd: abortDevice },
        ]}
      />
    </>
  );
}

function FocuserBody({
  state,
  deviceId,
  supportedCommands,
}: {
  state: Record<string, unknown>;
  deviceId: string;
  supportedCommands: string[];
}) {
  const pos = state["FocusPosition"] as
    | { current_position: number; base_position?: number | null }
    | undefined;
  return (
    <>
      <Metrics>
        {pos?.current_position != null && (
          <Metric label="Position" value={pos.current_position.toFixed(0)} />
        )}
        {pos?.base_position != null && (
          <Metric label="Base" value={pos.base_position.toFixed(0)} />
        )}
      </Metrics>
      <PositionChangeControl
        deviceId={deviceId}
        currentPosition={pos?.current_position}
        supportedCommands={supportedCommands}
        commandId="ChangeFocusPosition"
        buildCommand={changeFocusPosition}
      />
      <DirectActionRow
        deviceId={deviceId}
        supportedCommands={supportedCommands}
        noTopBorder
        actions={[{ label: "Stop", cmd: stopDevice }]}
      />
    </>
  );
}

function PositionChangeControl({
  deviceId,
  currentPosition,
  supportedCommands,
  commandId,
  buildCommand,
  precision = 0,
  unitSuffix,
}: {
  deviceId: string;
  currentPosition: number | undefined;
  supportedCommands: string[];
  // command_id this control will send. Used for the gating check too.
  commandId: string;
  buildCommand: (position: number) => unknown;
  // Decimals shown in the placeholder (echoes the format of the Position metric).
  precision?: number;
  // Optional unit displayed to the right of the input field (e.g. "°").
  unitSuffix?: string;
}) {
  const directControl = useFeatureFlags((s) => s.directDeviceControl);
  const [target, setTarget] = useState("");
  const [status, setStatus] = useState<ActionStatus>({ phase: "idle" });

  if (!directControl) return null;
  if (!supportedCommands.includes(commandId)) return null;

  const busy = status.phase === "pending";
  const trimmed = target.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const valid = parsed !== null && Number.isFinite(parsed);

  const submit = async () => {
    if (!valid) return;
    setStatus({ phase: "pending", label: "Change" });
    try {
      await sendDeviceCommand(deviceId, buildCommand(parsed));
      setStatus({ phase: "ok", label: "Change" });
      setTarget("");
      setTimeout(() => setStatus({ phase: "idle" }), 3500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ phase: "err", label: "Change", message });
    }
  };

  return (
    <div className="pt-2 mt-1 border-t border-panel-border">
      {/* Two-column grid mirrors the Metrics layout above so the input's right
          edge aligns with the Position value's right edge (column 1 boundary).
          Change button sits at the left edge; col 2 is intentionally empty. */}
      <div className="grid grid-cols-1 @[360px]:grid-cols-2 gap-x-3 gap-y-1">
        <div className="flex items-center justify-between gap-2">
          <ControlBtn
            label="Change"
            disabled={busy || !valid}
            onClick={submit}
          />
          <div className="flex items-center gap-1">
            <input
              type="text"
              inputMode="decimal"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid && !busy) submit();
              }}
              disabled={busy}
              placeholder={
                currentPosition != null ? currentPosition.toFixed(precision) : "position"
              }
              className="bg-black/40 border border-panel-border rounded text-text-bright text-[11px] pointer-coarse:text-base pointer-coarse:py-2 font-mono px-2 py-1 w-24 text-right placeholder:text-text-dim disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-text-dim"
            />
            {unitSuffix && (
              <span className="text-text-dim text-[11px] font-mono">{unitSuffix}</span>
            )}
          </div>
        </div>
        <span />
      </div>
      {status.phase !== "idle" && (
        <div
          className={`mt-1 text-[10px] font-mono ${
            status.phase === "err"
              ? "text-red-400"
              : status.phase === "ok"
                ? "text-green-400"
                : "text-text-dim"
          }`}
          title={status.phase === "err" ? status.message : undefined}
        >
          {status.phase === "pending" && "Moving…"}
          {status.phase === "ok" && "Position set"}
          {status.phase === "err" && `Change failed: ${truncate(status.message, 80)}`}
        </div>
      )}
    </div>
  );
}

function RotatorBody({
  state,
  deviceId,
  supportedCommands,
}: {
  state: Record<string, unknown>;
  deviceId: string;
  supportedCommands: string[];
}) {
  const pos = state["RotatorPosition"] as { position: number } | undefined;
  return (
    <>
      <Metrics>
        {pos && <Metric label="Position" value={`${pos.position.toFixed(2)}\u00b0`} />}
      </Metrics>
      <PositionChangeControl
        deviceId={deviceId}
        currentPosition={pos?.position}
        supportedCommands={supportedCommands}
        commandId="ChangeRotatorPosition"
        buildCommand={changeRotatorPosition}
        precision={2}
        unitSuffix={"\u00b0"}
      />
      <DirectActionRow
        deviceId={deviceId}
        supportedCommands={supportedCommands}
        noTopBorder
        actions={[{ label: "Stop", cmd: stopDevice }]}
      />
    </>
  );
}

interface FilterEntry {
  name: string;
  position: number;
  wavelength: number | null;
}

function FilterChangerBody({
  state,
  deviceId,
  supportedCommands,
}: {
  state: Record<string, unknown>;
  deviceId: string;
  supportedCommands: string[];
}) {
  const current = state["Filter"] as FilterEntry | undefined;
  const all = state["Filters"] as { filters: FilterEntry[] } | undefined;
  const directControl = useFeatureFlags((s) => s.directDeviceControl);
  const [status, setStatus] = useState<ActionStatus>({ phase: "idle" });

  if (!all?.filters || all.filters.length === 0) {
    return <div className="text-[10px] text-text-dim">No filters reported</div>;
  }

  const canSetFilter = supportedCommands.includes("SetFilter");
  const busy = status.phase === "pending";

  const select = async (f: FilterEntry) => {
    setStatus({ phase: "pending", label: f.name });
    try {
      await sendDeviceCommand(deviceId, setFilter(f.name));
      setStatus({ phase: "ok", label: f.name });
      setTimeout(() => setStatus({ phase: "idle" }), 3500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ phase: "err", label: f.name, message });
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {all.filters.map((f) => {
          const active = current?.name.toLowerCase() === f.name.toLowerCase();
          const canClick = !active && directControl && !busy && canSetFilter;
          const tooltip = !directControl
            ? "Enable Direct Device Control in Settings"
            : !canSetFilter
              ? "Device does not support SetFilter"
              : undefined;
          return (
            <button
              key={f.position}
              type="button"
              disabled={!canClick}
              onClick={() => select(f)}
              title={tooltip}
              className={`px-1.5 py-0.5 pointer-coarse:px-2.5 pointer-coarse:py-1.5 pointer-coarse:min-h-9 pointer-coarse:min-w-9 rounded text-[10px] border transition-colors ${
                active
                  ? "bg-blue-500/30 text-blue-200 border-blue-500/40 cursor-default"
                  : canClick
                    ? "bg-white/5 text-text-dim border-panel-border hover:bg-black/40 hover:border-text-dim cursor-pointer"
                    : "bg-white/5 text-text-dim border-panel-border opacity-60 cursor-not-allowed"
              }`}
            >
              {f.name}
            </button>
          );
        })}
      </div>
      {/* Note only the rare case where the device itself lacks SetFilter; the
          direct-control-off case is left to the buttons' hover tooltip. */}
      {directControl && !canSetFilter && (
        <div className="text-[10px] text-text-dim">
          Device does not support SetFilter
        </div>
      )}
      {status.phase !== "idle" && (
        <div
          className={`text-[10px] font-mono ${
            status.phase === "err"
              ? "text-red-400"
              : status.phase === "ok"
                ? "text-green-400"
                : "text-text-dim"
          }`}
          title={status.phase === "err" ? status.message : undefined}
        >
          {status.phase === "pending" && `Setting ${status.label}…`}
          {status.phase === "ok" && `Set ${status.label}`}
          {status.phase === "err" && `${status.label} failed: ${truncate(status.message, 80)}`}
        </div>
      )}
    </div>
  );
}

function EnclosureBody({
  state,
  deviceId,
  supportedCommands,
}: {
  state: Record<string, unknown>;
  deviceId: string;
  supportedCommands: string[];
}) {
  const opened = state["Opened"] as { is_open: boolean } | undefined;
  const altaz = state["AltAzPointing"] as AltAzPointing | undefined;
  return (
    <>
      <Metrics>
        {opened && (
          <>
            <Metric label="Aperture" value={opened.is_open ? "open" : "closed"} />
            <span />
          </>
        )}
        {altaz && (
          <>
            <Metric label="Alt" value={fmtNum(altaz.altitude_degrees, 2)} />
            <Metric label="Az" value={fmtNum(altaz.azimuth_degrees, 2)} />
          </>
        )}
      </Metrics>
      <DirectActionRow
        deviceId={deviceId}
        supportedCommands={supportedCommands}
        actions={[
          { label: "Open", cmd: openEnclosure },
          { label: "Close", cmd: closeEnclosure },
          { label: "Stop", cmd: stopDevice },
        ]}
      />
    </>
  );
}

function MirrorCoverBody({
  state,
  deviceId,
  supportedCommands,
}: {
  state: Record<string, unknown>;
  deviceId: string;
  supportedCommands: string[];
}) {
  const opened = state["Opened"] as { is_open: boolean } | undefined;
  return (
    <>
      {opened && (
        <Metrics>
          <Metric label="Aperture" value={opened.is_open ? "open" : "closed"} />
        </Metrics>
      )}
      <DirectActionRow
        deviceId={deviceId}
        supportedCommands={supportedCommands}
        actions={[
          { label: "Open", cmd: openMirrorCover },
          { label: "Close", cmd: closeMirrorCover },
        ]}
      />
    </>
  );
}

interface BasicWeather {
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  cloud_cover: number | null;
  dew_point: number | null;
  rain_rate: number | null;
  wind_direction: number | null;
  wind_speed: number | null;
}

function WeatherBody({ state }: { state: Record<string, unknown> }) {
  const w = state["BasicWeather"] as BasicWeather | undefined;
  if (!w) return null;
  return (
    <Metrics>
      {w.temperature != null && (
        <Metric label="Temperature" value={`${w.temperature.toFixed(1)} \u00b0C`} />
      )}
      {w.humidity != null && (
        <Metric label="Humidity" value={`${w.humidity.toFixed(0)}%`} />
      )}
      {w.pressure != null && (
        <Metric label="Pressure" value={`${w.pressure.toFixed(1)} hPa`} />
      )}
      {w.cloud_cover != null && (
        <Metric label="Cloud cover" value={`${w.cloud_cover.toFixed(0)}%`} />
      )}
      {w.dew_point != null && (
        <Metric label="Dew point" value={`${w.dew_point.toFixed(1)} \u00b0C`} />
      )}
      {w.wind_speed != null && (
        <Metric
          label="Wind"
          value={`${w.wind_speed.toFixed(1)} m/s${
            w.wind_direction != null ? ` @ ${w.wind_direction.toFixed(0)}\u00b0` : ""
          }`}
        />
      )}
      {w.rain_rate != null && <Metric label="Rain rate" value={`${w.rain_rate} mm/h`} />}
    </Metrics>
  );
}

function GenericBody({ state }: { state: Record<string, unknown> }) {
  // Old SensorKit deployments may still have this retired KV key. Hide it from the count.
  const propKeys = Object.keys(state).filter(
    (k) => !["Capabilities", "EntityInfo", "EntityLease", "DeviceState", "Connected"].includes(k),
  );
  return (
    <div className="text-[10px] text-text-dim">
      {propKeys.length > 0 ? `${propKeys.length} props` : "No telemetry"}
    </div>
  );
}

// === Small presentational bits ===

function Metrics({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 @[360px]:grid-cols-2 gap-x-3 gap-y-1 text-xs">{children}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 min-w-0">
      <span className="text-text-dim">{label}</span>
      <span className="text-text-bright font-mono truncate">{value}</span>
    </div>
  );
}

/**
 * Format a nullable wire number as a fixed-precision reading, rendering an
 * unknown value as "—" (matching the Axes metric's existing convention).
 *
 * We show the dash rather than dropping the row: a dome that doesn't know its
 * own azimuth is operationally significant, and silently omitting "Az" would
 * read as "no azimuth telemetry" instead of "azimuth unknown".
 */
function fmtNum(
  v: number | null | undefined,
  digits: number,
  suffix = "°",
): string {
  return v == null ? "—" : `${v.toFixed(digits)}${suffix}`;
}

function Pill({
  label,
  tone,
}: {
  label: string;
  tone: "good" | "bad" | "off" | "hidden";
}) {
  if (tone === "hidden" || !label) return null;
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
