import { useState } from "react";
import { useSensorKitStore } from "../../stores/sensorkit";
import { useFeatureFlags } from "../../stores/featureFlags";
import {
  useInstruments,
  type Instrument,
} from "../../lib/sensorkit-client/instruments";
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
import type { Capabilities, EntityListing } from "../../lib/sensorkit-client/types";

// Display-only overrides for SensorKit-native device kinds whose underscore form
// reads awkwardly as a header. Other kinds keep their underscore — if an
// Alpaca-leaked name like `cover_calibrator` ever shows up here, the leak is
// diagnostic (a SensorKit module forgot to canonicalize), not noise.
const KIND_LABELS: Record<string, string> = {
  filter_changer: "filter changer",
  mirror_cover: "mirror cover",
};

// Card sort order, by direction of light travel through the system. Anything
// not listed (including Alpaca-leaked names) falls to the bottom and sorts
// alphabetically among its peers — surfacing oddities rather than hiding them.
const KIND_ORDER: Record<string, number> = {
  weather: 0,
  enclosure: 1,
  mirror_cover: 2,
  mount: 3,
  rotator: 4,
  focuser: 5,
  filter_changer: 6,
  camera: 7,
  safety_monitor: 8,
  switch: 9,
};

export function DevicesPage() {
  const entities = useSensorKitStore((s) => s.entities);
  const state = useSensorKitStore((s) => s.state);
  const connection = useSensorKitStore((s) => s.connection);
  const instruments = useInstruments();

  // Order devices by light-travel priority (KIND_ORDER), then alphabetically
  // within each kind. Kind is computed the same way DeviceCard resolves it so
  // the displayed header and the sort key always agree.
  const devices = entities
    .filter((e) => e.entity_type === "device")
    .sort((a, b) => {
      const aState = state[a.name] ?? {};
      const bState = state[b.name] ?? {};
      const aKind = resolveDeviceKind(
        aState["Capabilities"] as Capabilities | undefined,
        a.archetype,
        aState,
      );
      const bKind = resolveDeviceKind(
        bState["Capabilities"] as Capabilities | undefined,
        b.archetype,
        bState,
      );
      const aPri = KIND_ORDER[aKind] ?? 99;
      const bPri = KIND_ORDER[bKind] ?? 99;
      if (aPri !== bPri) return aPri - bPri;
      if (aKind !== bKind) return aKind.localeCompare(bKind);
      return a.name.localeCompare(b.name);
    });

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
        {/* Controllers — with lifecycle + mount actions */}
        {instruments.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-[11px] text-text-dim uppercase tracking-wider">
              Controllers
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {instruments.map((inst) => (
                <ControllerCard
                  key={inst.id}
                  instrument={inst}
                  operatingState={
                    (state[inst.id]?.["OperatingState"] as { current?: string } | undefined)
                      ?.current ?? null
                  }
                />
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
                <DeviceCard key={d.name} entity={d} deviceState={state[d.name] ?? {}} />
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

function ControllerCard({
  instrument,
  operatingState,
}: {
  instrument: Instrument;
  operatingState: string | null;
}) {
  const [status, setStatus] = useState<ActionStatus>({ phase: "idle" });
  const [confirmInitOpen, setConfirmInitOpen] = useState(false);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setStatus({ phase: "pending", label });
    try {
      await fn();
      setStatus({ phase: "ok", label });
      setTimeout(() => setStatus({ phase: "idle" }), 3500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ phase: "err", label, message });
    }
  };

  const runInit = () => {
    setConfirmInitOpen(false);
    run("Init", () => executeControllerTask(instrument.id, initTask()));
  };

  const busy = status.phase === "pending";

  return (
    <div className="bg-panel-bg/60 border border-panel-border rounded-lg p-3 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-text-bright font-semibold truncate">
            {instrument.id}
          </div>
          <div className="text-[10px] text-text-dim uppercase tracking-wide">
            controller
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Pill
            label={instrument.online ? "online" : "offline"}
            tone={instrument.online ? "good" : "off"}
          />
          {operatingState && (
            <Pill
              label={operatingState.toLowerCase()}
              tone={operatingState === "OPERATE" ? "good" : "off"}
            />
          )}
        </div>
      </div>

      {/* Devices */}
      <ControllerDeviceChips instrument={instrument} />

      {/* Actions — Standard Controller lifecycle tasks (see std/sensor.py).
          Mount-specific Home/Park live on the mount device card. */}
      <div className="flex flex-wrap gap-1 pt-1 border-t border-panel-border">
        <ControlBtn
          label="Init"
          disabled={busy || !instrument.online}
          onClick={() => setConfirmInitOpen(true)}
        />
        <ControlBtn
          label="Standby"
          disabled={busy || !instrument.online}
          onClick={() =>
            run("Standby", () =>
              executeControllerTask(instrument.id, standbyTask()),
            )
          }
        />
        <ControlBtn
          label="Shutdown"
          disabled={busy || !instrument.online}
          onClick={() =>
            run("Shutdown", () =>
              executeControllerTask(instrument.id, shutdownTask()),
            )
          }
        />
      </div>

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
          instrument={instrument}
          onConfirm={runInit}
          onCancel={() => setConfirmInitOpen(false)}
        />
      )}
    </div>
  );
}

function InitConfirmModal({
  instrument,
  onConfirm,
  onCancel,
}: {
  instrument: Instrument;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const steps: string[] = [];
  if (instrument.dome) steps.push("Open the dome");
  if (instrument.mount) steps.push("Power on and enable the mount");
  if (instrument.mirror_cover) steps.push("Open the mirror cover");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="bg-panel-bg border border-panel-border rounded-lg p-5 max-w-sm w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-text-bright mb-2">
          Initialize {instrument.id}?
        </h3>
        <p className="text-xs text-text-dim mb-3">Controller Init will:</p>
        <ul className="text-xs text-text-bright space-y-1 mb-4 pl-4 list-disc">
          {steps.length > 0 ? (
            steps.map((s) => <li key={s}>{s}</li>)
          ) : (
            <li className="text-text-dim">(no orchestrated devices configured)</li>
          )}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="py-1 px-3 rounded text-[11px] font-medium border bg-black/40 text-text-bright border-panel-border hover:bg-black/60"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="py-1 px-3 rounded text-[11px] font-medium border bg-accent/30 text-text-bright border-accent/50 hover:bg-accent/50"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function ControllerDeviceChips({ instrument }: { instrument: Instrument }) {
  // Role labels match the device-card kind headers (see KIND_LABELS) and the
  // order matches KIND_ORDER (light-travel direction) so chips and the device
  // cards below read top-to-bottom in the same sequence.
  const chips: { role: string; id: string | null }[] = [
    { role: "enclosure", id: instrument.dome },
    { role: "mirror cover", id: instrument.mirror_cover },
    { role: "mount", id: instrument.mount },
    { role: "rotator", id: instrument.rotator },
    { role: "focuser", id: instrument.focuser },
    { role: "filter changer", id: instrument.filter_wheel },
    { role: "camera", id: instrument.camera },
  ].filter((c) => c.id);

  if (chips.length === 0) {
    return <div className="text-[10px] text-text-dim">No devices linked</div>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.role}
          className="text-[10px] bg-white/5 text-text-dim border border-panel-border rounded px-1.5 py-0.5"
        >
          <span className="uppercase tracking-wide">{c.role}</span>
          <span className="text-text-bright font-mono ml-1">{c.id}</span>
        </span>
      ))}
    </div>
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
      className={`shrink-0 py-1 px-2.5 rounded text-[11px] font-medium border transition-colors ${
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

function DeviceCard({
  entity,
  deviceState,
}: {
  entity: EntityListing;
  deviceState: Record<string, unknown>;
}) {
  const caps = deviceState["Capabilities"] as Capabilities | undefined;
  const kind = resolveDeviceKind(caps, entity.archetype, deviceState);
  // SK auto-publishes the set of command_ids each device handles (derived from
  // its registered @sk.command_handler functions) in
  // EntityInfo.details.supported_commands. We thread this through to
  // DirectActionRow to gate buttons. If the field is absent (older SK,
  // transient load state), DirectActionRow falls open — shows all buttons —
  // so deployments that don't publish capability info aren't silently muted.
  const supportedCommands = entity.details?.["supported_commands"] as string[] | undefined;
  const connected =
    (deviceState["Connected"] as { is_connected: boolean } | undefined)?.is_connected ?? null;
  const enabled =
    (
      (deviceState["DeviceState"] as { enable_state: { enabled: boolean } } | undefined)
        ?.enable_state
    )?.enabled ?? null;

  return (
    <div className="bg-panel-bg/60 border border-panel-border rounded-lg p-3 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-text-bright font-semibold truncate">{entity.name}</div>
          <div className="text-[10px] text-text-dim uppercase tracking-wide">{KIND_LABELS[kind] ?? kind}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Pill label={entity.online ? "online" : "offline"} tone={entity.online ? "good" : "off"} />
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
      <DeviceBody
        kind={kind}
        state={deviceState}
        deviceId={entity.name}
        supportedCommands={supportedCommands}
      />
    </div>
  );
}

function DeviceBody({
  kind,
  state,
  deviceId,
  supportedCommands,
}: {
  kind: string;
  state: Record<string, unknown>;
  deviceId: string;
  supportedCommands: string[] | undefined;
}) {
  switch (kind) {
    case "mount":
      return <MountBody state={state} deviceId={deviceId} supportedCommands={supportedCommands} />;
    case "camera":
      return <CameraBody state={state} deviceId={deviceId} supportedCommands={supportedCommands} />;
    case "focuser":
      return <FocuserBody state={state} deviceId={deviceId} supportedCommands={supportedCommands} />;
    case "rotator":
      return <RotatorBody state={state} deviceId={deviceId} supportedCommands={supportedCommands} />;
    case "filter_changer":
      return <FilterChangerBody state={state} deviceId={deviceId} supportedCommands={supportedCommands} />;
    case "enclosure":
      return <EnclosureBody state={state} deviceId={deviceId} supportedCommands={supportedCommands} />;
    case "mirror_cover":
      return <MirrorCoverBody state={state} deviceId={deviceId} supportedCommands={supportedCommands} />;
    case "weather":
      return <WeatherBody state={state} />;
    default:
      return <GenericBody state={state} />;
  }
}

// Resolve a device kind in a way that's robust to partial telemetry.
// Precedence: published Capabilities.device_type → entity archetype →
// inference from state keywords (e.g. BasicWeather → weather). Falls back
// to "device" if no signal is available yet.
function resolveDeviceKind(
  caps: Capabilities | undefined,
  archetype: string | null | undefined,
  state: Record<string, unknown>,
): string {
  if (caps?.device_type) return caps.device_type;
  if (archetype) return archetype;
  if ("BasicWeather" in state) return "weather";
  if ("RADecPointing" in state || "AltAzPointing" in state || "MountAxisEnabled" in state)
    return "mount";
  if ("CameraTelemetry" in state || "CameraCurrentSettings" in state) return "camera";
  if ("Opened" in state) return "enclosure";
  return "device";
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
  // Set of command_ids the target device handles, from
  // EntityInfo.details.supported_commands. When provided, actions whose cmd()
  // produces a command_id outside this set are filtered out. When undefined
  // (older SK, transient load state), no filtering happens — fall open rather
  // than hiding all controls.
  supportedCommands?: string[];
  // Drop the top border + extra padding when this row stacks directly below
  // another action row (so the two read as one block instead of two).
  noTopBorder?: boolean;
}) {
  const enabled = useFeatureFlags((s) => s.directDeviceControl);
  const [status, setStatus] = useState<ActionStatus>({ phase: "idle" });

  if (!enabled) return null;

  const visibleActions = supportedCommands
    ? actions.filter((a) => {
        const id = (a.cmd() as { command_id?: string }).command_id;
        return id ? supportedCommands.includes(id) : true;
      })
    : actions;

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

interface RADecPointing {
  right_ascension_hours: number;
  declination_degrees: number;
  reference_frame?: string;
}
interface AltAzPointing {
  altitude_degrees: number;
  azimuth_degrees: number;
}
interface AxisEnabled {
  axis: { enabled: boolean; axis: string }[];
}
interface AxisDistance {
  axis: { distance_arcseconds: number; axis: string }[];
}

function MountBody({
  state,
  deviceId,
  supportedCommands,
}: {
  state: Record<string, unknown>;
  deviceId: string;
  supportedCommands: string[] | undefined;
}) {
  const radec = state["RADecPointing"] as RADecPointing | undefined;
  const altaz = state["AltAzPointing"] as AltAzPointing | undefined;
  const axEn = state["MountAxisEnabled"] as AxisEnabled | undefined;
  const dist = state["MountTargetDistance"] as AxisDistance | undefined;

  const azEnabled = axEn?.axis.find((a) => a.axis === "azimuth")?.enabled;
  const altEnabled = axEn?.axis.find((a) => a.axis === "altitude")?.enabled;
  const azErr = dist?.axis.find((a) => a.axis === "azimuth")?.distance_arcseconds;
  const altErr = dist?.axis.find((a) => a.axis === "altitude")?.distance_arcseconds;

  return (
    <>
      <Metrics>
      {radec && (
        <>
          <Metric label="RA" value={`${(radec.right_ascension_hours * 15).toFixed(4)}\u00b0`} />
          <Metric label="Dec" value={`${radec.declination_degrees.toFixed(4)}\u00b0`} />
        </>
      )}
      {altaz && (
        <>
          <Metric label="Alt" value={`${altaz.altitude_degrees.toFixed(2)}\u00b0`} />
          <Metric label="Az" value={`${altaz.azimuth_degrees.toFixed(2)}\u00b0`} />
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
      {dist && azErr !== undefined && altErr !== undefined && (
        <Metric
          label="Err"
          value={`${azErr.toFixed(2)}″ / ${altErr.toFixed(2)}″`}
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
  supportedCommands: string[] | undefined;
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
  supportedCommands: string[] | undefined;
}) {
  const pos = state["FocusPosition"] as { position: number } | undefined;
  return (
    <>
      <Metrics>
        {pos && <Metric label="Position" value={pos.position.toFixed(0)} />}
      </Metrics>
      <PositionChangeControl
        deviceId={deviceId}
        currentPosition={pos?.position}
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
  supportedCommands: string[] | undefined;
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
  // Falls open when supportedCommands is undefined (older SK / transient load).
  const supported = supportedCommands ? supportedCommands.includes(commandId) : true;
  if (!supported) return null;

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
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
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
              className="bg-black/40 border border-panel-border rounded text-text-bright text-[11px] font-mono px-2 py-1 w-24 text-right placeholder:text-text-dim disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-text-dim"
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
  supportedCommands: string[] | undefined;
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
  supportedCommands: string[] | undefined;
}) {
  const current = state["Filter"] as FilterEntry | undefined;
  const all = state["Filters"] as { filters: FilterEntry[] } | undefined;
  const directControl = useFeatureFlags((s) => s.directDeviceControl);
  const [status, setStatus] = useState<ActionStatus>({ phase: "idle" });

  if (!all?.filters || all.filters.length === 0) {
    return <div className="text-[10px] text-text-dim">No filters reported</div>;
  }

  // Falls open when supportedCommands is undefined (older SK / transient load).
  const canSetFilter = supportedCommands ? supportedCommands.includes("SetFilter") : true;
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
              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
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
  supportedCommands: string[] | undefined;
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
            <Metric label="Alt" value={`${altaz.altitude_degrees.toFixed(2)}°`} />
            <Metric label="Az" value={`${altaz.azimuth_degrees.toFixed(2)}°`} />
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
  supportedCommands: string[] | undefined;
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
  return <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">{children}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 min-w-0">
      <span className="text-text-dim">{label}</span>
      <span className="text-text-bright font-mono truncate">{value}</span>
    </div>
  );
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
