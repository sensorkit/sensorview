import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SVEpochNotice } from "./SVEpochBadge";
import {
  isSV,
  sameSatKey,
  satKeyOf,
  satLabel,
  useSatelliteStore,
  type CatalogRecord,
  type SatellitePosition,
  type SatKey,
} from "../../../stores/satellites";
import { useSkyViewStore } from "../../../stores/skyview";
import { useSensorKitStore } from "../../../stores/sensorkit";
import { useBackends } from "../../../stores/backends";
import {
  useCollectPresetsStore,
  type CollectPreset,
} from "../../../stores/collectPresets";
import { useObserver, radecToAltAz } from "../hooks/useObserver";
import { useSolarSystemBodies, type SolarBody } from "../hooks/useSolarSystemBodies";
import {
  useInstruments,
  useMountActivities,
} from "../../../lib/sensorkit-client/instruments";
import {
  executeControllerTask,
  followTarget,
  icrsTarget,
  initTask,
  ephemerisTarget,
  sendDeviceCommand,
  standardCollectTask,
  stateVectorTargetFrom,
  tleTargetFrom,
  type Target,
} from "../../../lib/sensorkit-client/commands";
import { fetchHorizonsEphemeris } from "../../../lib/api-client/horizons";
import { collectWindow } from "../horizons/window";
import { type StarCatalog, getStarName, getStarLabel } from "../catalog/stars";

const SPECTRAL_NAMES: Record<string, string> = {
  O: "O (Blue)", B: "B (Blue-white)", A: "A (White)",
  F: "F (Yellow-white)", G: "G (Yellow)", K: "K (Orange)", M: "M (Red)",
};

interface Props {
  catalog: StarCatalog | null;
}

export function DetailSheet({ catalog }: Props) {
  const positions = useSatelliteStore((s) => s.positions);
  const tles = useSatelliteStore((s) => s.tles);
  const { observer } = useObserver();
  const bodies = useSolarSystemBodies(observer);
  const {
    selectedSatellite, selectedStarIndex, selectedBodyName,
    manualTarget, detailSheetOpen,
    selectSatellite, selectStar, selectBody, clearManualTarget, setDetailSheetOpen,
  } = useSkyViewStore();

  const close = () => {
    selectSatellite(null);
    selectStar(null);
    selectBody(null);
    clearManualTarget();
    setDetailSheetOpen(false);
  };

  if (!detailSheetOpen) return null;

  if (selectedSatellite) {
    return <SatelliteDetail id={selectedSatellite} positions={positions} tles={tles} onClose={close} />;
  }

  if (selectedStarIndex !== null && catalog) {
    return <StarDetail index={selectedStarIndex} catalog={catalog} onClose={close} />;
  }

  if (selectedBodyName) {
    const body = bodies.find((b) => b.name === selectedBodyName);
    if (body) return <BodyDetail body={body} onClose={close} />;
  }

  if (manualTarget) {
    return <ManualTargetDetail ra={manualTarget.ra} dec={manualTarget.dec} onClose={close} />;
  }

  return null;
}

function SatelliteDetail({ id, positions, tles, onClose }: {
  id: SatKey;
  positions: SatellitePosition[];
  tles: CatalogRecord[];
  onClose: () => void;
}) {
  const sat = useMemo(() => positions.find((p) => sameSatKey(p, id)), [positions, id]);
  const tle = useMemo(() => tles.find((t) => sameSatKey(satKeyOf(t), id)), [tles, id]);

  if (!sat) return null;

  return (
    <div className="absolute bottom-10 left-4 right-4 sm:left-auto max-w-[calc(100vw-2rem)] sm:max-w-sm z-20">
      <div className="bg-panel-bg/95 backdrop-blur-md rounded-xl border border-panel-border shadow-2xl p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-text-bright">
              {satLabel(tle, id.noradId).text}
            </h3>
            <span className="text-xs text-text-dim">
              NORAD {id.noradId}
              {tle?.orbitRegime && (
                <span className="ml-2 px-1.5 py-0.5 bg-blue-600/20 text-blue-300 rounded text-[10px]">
                  {tle.orbitRegime}
                </span>
              )}
            </span>
          </div>
          <button onClick={onClose} className="text-text-dim hover:text-text-bright text-lg leading-none">&times;</button>
        </div>

        {isSV(tle) && (
          <SVEpochNotice epoch={tle.epoch} orbitRegime={tle.orbitRegime} />
        )}

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3">
          <DataRow label="Alt" value={`${sat.alt.toFixed(2)}\u00b0`} />
          <DataRow label="Az" value={`${sat.az.toFixed(2)}\u00b0`} />
          <DataRow label="RA" value={`${sat.ra.toFixed(4)}\u00b0`} />
          <DataRow label="Dec" value={`${sat.dec.toFixed(4)}\u00b0`} />
          <DataRow label="Range" value={`${sat.range.toFixed(0)} km`} />
          <DataRow label="Velocity" value={`${sat.velocity.toFixed(2)} km/s`} />
          {sat.lat != null && <DataRow label="Lat" value={`${sat.lat.toFixed(2)}\u00b0`} />}
          {sat.lon != null && <DataRow label="Lon" value={`${sat.lon.toFixed(2)}\u00b0`} />}
          {sat.satAlt != null && <DataRow label="Orbit Alt" value={`${sat.satAlt.toFixed(0)} km`} />}
          {sat.maxAlt !== null && <DataRow label="Max Alt" value={`${sat.maxAlt.toFixed(1)}\u00b0`} />}
          {sat.setInMinutes !== null && <DataRow label="Sets in" value={`${Math.round(sat.setInMinutes)} min`} />}
        </div>

        <div className="flex items-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full ${sat.isVisible ? "bg-green-400" : "bg-red-400"}`} />
          <span className="text-xs text-text-dim">
            {sat.isVisible ? "Above horizon" : `Below horizon (${sat.alt.toFixed(1)}\u00b0)`}
          </span>
        </div>

        <ActionButtons target={{ kind: "satellite", ra: sat.ra, dec: sat.dec, tle }} />
      </div>
    </div>
  );
}

function StarDetail({ index, catalog, onClose }: {
  index: number;
  catalog: StarCatalog;
  onClose: () => void;
}) {
  const star = catalog.stars[index];
  if (!star) return null;

  // StarRecord = [id, ra_deg, dec_deg, mag, spectral_class | null]
  const [, ra, dec, mag, spec] = star;
  const commonName = getStarName(catalog, index);
  const label = getStarLabel(catalog, index);

  // Format RA as hours
  const raHours = ra / 15;
  const raH = Math.floor(raHours);
  const raM = Math.floor((raHours - raH) * 60);
  const raS = ((raHours - raH) * 60 - raM) * 60;

  // Format Dec as DMS
  const decSign = dec >= 0 ? "+" : "-";
  const absDec = Math.abs(dec);
  const decD = Math.floor(absDec);
  const decM = Math.floor((absDec - decD) * 60);
  const decS = ((absDec - decD) * 60 - decM) * 60;

  return (
    <div className="absolute bottom-10 left-4 right-4 sm:left-auto max-w-[calc(100vw-2rem)] sm:max-w-sm z-20">
      <div className="bg-panel-bg/95 backdrop-blur-md rounded-xl border border-panel-border shadow-2xl p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-text-bright">
              {label}
            </h3>
            <span className="text-xs text-text-dim">
              {spec ? `${SPECTRAL_NAMES[spec] ?? spec} type` : "Unknown spectral type"}
              <span className="ml-2">mag {mag.toFixed(2)}</span>
              {commonName && <span className="ml-2 text-star-warm">{commonName}</span>}
            </span>
          </div>
          <button onClick={onClose} className="text-text-dim hover:text-text-bright text-lg leading-none">&times;</button>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3">
          <DataRow label="RA" value={`${raH}h ${raM}m ${raS.toFixed(1)}s`} />
          <DataRow label="Dec" value={`${decSign}${decD}\u00b0 ${decM}' ${decS.toFixed(1)}"`} />
          <DataRow label="RA (deg)" value={`${ra.toFixed(4)}\u00b0`} />
          <DataRow label="Dec (deg)" value={`${dec.toFixed(4)}\u00b0`} />
          <DataRow label="Magnitude" value={mag.toFixed(2)} />
          <DataRow label="Spectral" value={spec ?? "—"} />
        </div>

        <ActionButtons target={{ kind: "star", ra, dec, name: label }} />
      </div>
    </div>
  );
}

function ManualTargetDetail({ ra, dec, onClose }: {
  ra: number;
  dec: number;
  onClose: () => void;
}) {
  const setManualTarget = useSkyViewStore((s) => s.setManualTarget);
  const { observer } = useObserver();

  // Local editable inputs, synced when the store value changes from outside
  const [raStr, setRaStr] = useState(ra.toFixed(4));
  const [decStr, setDecStr] = useState(dec.toFixed(4));

  useEffect(() => {
    setRaStr(ra.toFixed(4));
    setDecStr(dec.toFixed(4));
  }, [ra, dec]);

  // Live alt/az — recomputes once per second as LST advances
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const { alt, az } = useMemo(
    () => radecToAltAz(now, observer, ra, dec),
    [now, observer, ra, dec],
  );

  const commit = () => {
    const raN = parseFloat(raStr);
    const decN = parseFloat(decStr);
    if (Number.isFinite(raN) && Number.isFinite(decN)) {
      const normRa = ((raN % 360) + 360) % 360;
      const clampDec = Math.max(-90, Math.min(90, decN));
      setManualTarget(normRa, clampDec);
    }
  };

  const raHours = ra / 15;
  const raH = Math.floor(raHours);
  const raM = Math.floor((raHours - raH) * 60);
  const raS = ((raHours - raH) * 60 - raM) * 60;
  const decSign = dec >= 0 ? "+" : "-";
  const absDec = Math.abs(dec);
  const decD = Math.floor(absDec);
  const decM = Math.floor((absDec - decD) * 60);
  const decS = ((absDec - decD) * 60 - decM) * 60;

  return (
    <div className="absolute bottom-10 left-4 right-4 sm:left-auto max-w-[calc(100vw-2rem)] sm:max-w-sm z-20">
      <div className="bg-panel-bg/95 backdrop-blur-md rounded-xl border border-panel-border shadow-2xl p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-text-bright">Manual target</h3>
            <span className="text-xs text-text-dim">Double-click to move · edit to refine</span>
          </div>
          <button onClick={onClose} className="text-text-dim hover:text-text-bright text-lg leading-none">&times;</button>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3">
          <DataRow label="RA" value={`${raH}h ${raM}m ${raS.toFixed(1)}s`} />
          <DataRow label="Dec" value={`${decSign}${decD}\u00b0 ${decM}' ${decS.toFixed(1)}"`} />
          <DataRow label="Alt" value={`${alt.toFixed(2)}\u00b0`} />
          <DataRow label="Az" value={`${az.toFixed(2)}\u00b0`} />
        </div>

        <div className="flex items-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full ${alt > 0 ? "bg-green-400" : "bg-red-400"}`} />
          <span className="text-xs text-text-dim">
            {alt > 0 ? "Above horizon" : `Below horizon (${alt.toFixed(1)}\u00b0)`}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <label className="flex flex-col text-[10px] text-text-dim gap-0.5">
            RA (deg)
            <input
              type="number"
              step="0.01"
              value={raStr}
              onChange={(e) => setRaStr(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
            />
          </label>
          <label className="flex flex-col text-[10px] text-text-dim gap-0.5">
            Dec (deg)
            <input
              type="number"
              step="0.01"
              value={decStr}
              onChange={(e) => setDecStr(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              className="bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright font-mono"
            />
          </label>
        </div>

        <ActionButtons target={{ kind: "manual", ra, dec }} />
      </div>
    </div>
  );
}

export type ActionTarget =
  | { kind: "satellite"; ra: number; dec: number; tle: CatalogRecord | undefined }
  | { kind: "star"; ra: number; dec: number; name: string }
  | { kind: "manual"; ra: number; dec: number }
  | { kind: "body"; ra: number; dec: number; name: string }
  | {
      kind: "horizons";
      ra: number; // current RA/Dec (degrees), used for slew/track + fixed collect
      dec: number;
      name: string;
      command: string; // resolved Horizons COMMAND, for the ephemeris fetch
      isSun: boolean;
      mode: "ephemeris" | "fixed";
      rateArcsecHr: number | null; // total sky-motion rate → adaptive sampling
    };

function BodyDetail({ body, onClose }: { body: SolarBody; onClose: () => void }) {
  // Format RA/Dec sexagesimal
  const raHours = body.ra / 15;
  const raH = Math.floor(raHours);
  const raM = Math.floor((raHours - raH) * 60);
  const raS = ((raHours - raH) * 60 - raM) * 60;
  const decSign = body.dec >= 0 ? "+" : "-";
  const absDec = Math.abs(body.dec);
  const decD = Math.floor(absDec);
  const decM = Math.floor((absDec - decD) * 60);
  const decS = ((absDec - decD) * 60 - decM) * 60;

  const distanceLabel =
    body.kind === "moon"
      ? `${(body.distanceAU * 149597870.7).toFixed(0)} km`
      : `${body.distanceAU.toFixed(3)} AU`;

  return (
    <div className="absolute bottom-10 left-4 right-4 sm:left-auto max-w-[calc(100vw-2rem)] sm:max-w-sm z-20">
      <div className="bg-panel-bg/95 backdrop-blur-md rounded-xl border border-panel-border shadow-2xl p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-text-bright">{body.name}</h3>
            <span className="text-xs text-text-dim capitalize">
              {body.kind}
              {body.magnitude != null && (
                <span className="ml-2">mag {body.magnitude.toFixed(1)}</span>
              )}
            </span>
          </div>
          <button onClick={onClose} className="text-text-dim hover:text-text-bright text-lg leading-none">&times;</button>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3">
          <DataRow label="RA" value={`${raH}h ${raM}m ${raS.toFixed(1)}s`} />
          <DataRow label="Dec" value={`${decSign}${decD}\u00b0 ${decM}' ${decS.toFixed(1)}"`} />
          <DataRow label="RA (deg)" value={`${body.ra.toFixed(4)}\u00b0`} />
          <DataRow label="Dec (deg)" value={`${body.dec.toFixed(4)}\u00b0`} />
          <DataRow label="Alt" value={`${body.alt.toFixed(2)}\u00b0`} />
          <DataRow label="Az" value={`${body.az.toFixed(2)}\u00b0`} />
          <DataRow label="Distance" value={distanceLabel} />
        </div>

        <div className="flex items-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full ${body.alt > 0 ? "bg-green-400" : "bg-red-400"}`} />
          <span className="text-xs text-text-dim">
            {body.alt > 0 ? "Above horizon" : `Below horizon (${body.alt.toFixed(1)}\u00b0)`}
          </span>
        </div>

        <ActionButtons target={{ kind: "body", ra: body.ra, dec: body.dec, name: body.name }} />
      </div>
    </div>
  );
}

type ActionStatus =
  | { phase: "idle" }
  | { phase: "pending"; label: string }
  | { phase: "ok"; label: string }
  | { phase: "err"; label: string; message: string };

export type ActionPalette = "dark" | "paper";

export function ActionButtons({
  target,
  palette = "dark",
}: {
  target: ActionTarget;
  palette?: ActionPalette;
}) {
  const instruments = useInstruments();
  const activities = useMountActivities();
  const { observer } = useObserver();
  const selectedInstrumentId = useSensorKitStore((s) => s.selectedInstrumentId);
  const setSelectedInstrumentId = useSensorKitStore((s) => s.setSelectedInstrumentId);
  const setMountTarget = useSensorKitStore((s) => s.setMountTarget);

  // Resolve the active instrument: explicit selection → first with a mount, online preferred
  const active = useMemo(() => {
    if (selectedInstrumentId) {
      const found = instruments.find((i) => i.id === selectedInstrumentId);
      if (found) return found;
    }
    return (
      instruments.find((i) => i.online && i.mount) ??
      instruments.find((i) => i.mount) ??
      null
    );
  }, [instruments, selectedInstrumentId]);

  const activeActivity = active ? activities.find((a) => a.instrumentId === active.id) : null;
  const mountBusy = activeActivity?.busy ?? false;
  const mountBusyReason = activeActivity
    ? activeActivity.kind === "collecting"
      ? "Collect in progress"
      : activeActivity.kind === "slewing"
        ? "Mount slewing"
        : null
    : null;

  const [status, setStatus] = useState<ActionStatus>({ phase: "idle" });

  // Auto-clear transient status
  useEffect(() => {
    if (status.phase === "ok" || status.phase === "err") {
      const t = setTimeout(() => setStatus({ phase: "idle" }), 4000);
      return () => clearTimeout(t);
    }
  }, [status.phase]);

  const satRecord = target.kind === "satellite" ? target.tle : undefined;
  // Both element-set kinds give SK a rate-tracked orbital target — a TLETarget
  // for TLEs, a StateVectorTarget for uploaded state vectors. Everything else
  // falls through to ICRS.
  const orbitalTarget = satRecord
    ? isSV(satRecord)
      ? stateVectorTargetFrom(satRecord)
      : tleTargetFrom(satRecord)
    : null;
  // Track is meaningful for any non-manual target: satellites via TLE,
  // stars and bodies via sidereal-rate ICRS tracking. Manual RA/Dec drops
  // through to Slew alone since the operator probably wants a static
  // pointing, not a continuous follow.
  const showTrack = target.kind !== "manual";
  // Any target type can be collected — satellites via TLE track, everything
  // else as an ICRS fixed position with sidereal tracking.
  const showCollect = true;
  // Client-side safety guard: never let anyone command a mount at the Sun,
  // even if SK's own interlocks are somehow off.
  const sunGuarded =
    (target.kind === "body" && target.name === "Sun") ||
    (target.kind === "horizons" && target.isSun);
  const sunTooltip = sunGuarded ? "Disabled for safety — target is the Sun" : null;

  const hasMount = !!active?.mount;
  const canSlew = hasMount && !mountBusy && !sunGuarded;
  const canTrack = hasMount && showTrack && !mountBusy && !sunGuarded;
  const canCollect = !!active && !mountBusy && !sunGuarded;

  const busy = status.phase === "pending";

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setStatus({ phase: "pending", label });
    try {
      await fn();
      setStatus({ phase: "ok", label });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ phase: "err", label, message });
    }
  };

  const onInit = () =>
    active && runAction("Init", () => executeControllerTask(active.id, initTask()));

  const targetName =
    target.kind === "star" || target.kind === "body" || target.kind === "horizons"
      ? target.name
      : null;

  const onSlew = () => {
    if (!active?.mount) return;
    // Set target optimistically so the cone re-anchors the moment the user clicks.
    setMountTarget(active.id, { kind: "icrs", ra: target.ra, dec: target.dec });
    runAction("Slew", () =>
      sendDeviceCommand(
        active.mount!,
        followTarget(icrsTarget(target.ra, target.dec, targetName)),
      ),
    );
  };

  const onTrack = () => {
    if (!active?.mount) return;
    // For a satellite, track via the TLE (continuous repointing along the
    // satellite's path). For stars / solar-system bodies / anything else,
    // track via ICRS — SK's FollowTarget on an ICRSTarget produces sidereal-
    // rate tracking that keeps the inertial position centered.
    if (orbitalTarget && satRecord) {
      setMountTarget(active.id, {
        kind: "satellite",
        noradId: satRecord.noradId,
        elementSet: satKeyOf(satRecord).kind,
      });
      runAction("Track", () =>
        sendDeviceCommand(active.mount!, followTarget(orbitalTarget)),
      );
    } else {
      setMountTarget(active.id, { kind: "icrs", ra: target.ra, dec: target.dec });
      runAction("Track", () =>
        sendDeviceCommand(
          active.mount!,
          followTarget(icrsTarget(target.ra, target.dec, targetName)),
        ),
      );
    }
  };

  const onCollect = (preset: CollectPreset) => {
    if (!active) return;
    if (satRecord)
      setMountTarget(active.id, {
        kind: "satellite",
        noradId: satRecord.noradId,
        elementSet: satKeyOf(satRecord).kind,
      });
    else setMountTarget(active.id, { kind: "icrs", ra: target.ra, dec: target.dec });
    const programName = useBackends.getState().programName.trim() || "sensorview";
    const rawTargetId =
      target.kind === "satellite" ? (satRecord?.noradId ?? "manual")
      : target.kind === "star" ? target.name
      : target.kind === "body" ? target.name
      : target.kind === "horizons" ? target.name
      : "manual";
    // rawTargetId is the human-readable id: it rides on the task body → SK's
    // Collect snapshot → the FITS `TARGET` card, so we keep it verbatim (e.g.
    // "1 Ceres (A801 AA)").
    //
    // The *filename* instead uses a filesystem-safe slug, since SK drops the
    // template's values into the output path verbatim (no sanitizing). Whitelist
    // to path-safe chars, collapse every other run — spaces, colons, slashes,
    // parentheses — to a single "_", and trim leading/trailing separators so we
    // never emit a dotfile or a leading "-". The slug travels as a custom
    // `target_slug` context key: SK's compat layer rewrites its built-in fields
    // (`{target_id}`, `{target_name}`, …) but leaves unknown keys untouched.
    const safe = (s: string) =>
      s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "x";
    const targetSlug = safe(rawTargetId);
    const programSafe = safe(programName);
    const collectTime = new Date().toISOString().replace(/[-:]/g, "").split(".")[0]; // 20260422T143012
    // Horizons ephemeris collects fetch a fresh, collect-sized ephemeris at
    // submit time so the sampled path actually brackets execution.
    const ephemTarget =
      target.kind === "horizons" && target.mode === "ephemeris" ? target : null;
    runAction(`Collect (${preset.name})`, async () => {
      let t: Target;
      let endTime: Date | undefined;
      if (orbitalTarget) {
        t = orbitalTarget;
      } else if (ephemTarget) {
        const win = collectWindow({
          integrationSec: preset.integration_time_seconds,
          frameCount: preset.frame_count,
          rateArcsecPerHr: ephemTarget.rateArcsecHr,
        });
        const ephem = await fetchHorizonsEphemeris({
          command: ephemTarget.command,
          lon: observer.lon,
          lat: observer.lat,
          altKm: observer.alt / 1000,
          start: win.start,
          stop: win.stop,
          intervals: win.intervals,
        });
        if (!ephem.samples.length) throw new Error("Horizons returned no ephemeris samples");
        t = ephemerisTarget(
          ephem.samples.map((s) => s.jd),
          ephem.samples.map((s) => ({ ra: s.ra, dec: s.dec })),
        );
        endTime = win.stopDate;
      } else {
        t = icrsTarget(target.ra, target.dec, targetName);
      }
      return executeControllerTask(
        active.id,
        standardCollectTask(t, {
          integrationSec: preset.integration_time_seconds,
          frameCount: preset.frame_count,
          endTime,
          siderealFrames: preset.sidereal_frames ?? [],
          // Human-readable target id on the task body → SK copies it into the
          // Collect snapshot, which feeds the FITS `TARGET` card. Kept raw; the
          // filesystem-safe form rides in `target_slug` below. SK only
          // auto-derives an id for TLE/catalog targets, so our star/body/Horizons
          // ICRS/ephemeris collects would otherwise be null (→ literal "None").
          // Must ride the task body, not `context` — SK's compat layer overwrites
          // a context-dict `target_id`.
          targetId: rawTargetId,
          camera: {
            binning_x: preset.binning_x ?? null,
            binning_y: preset.binning_y ?? null,
            gain: preset.gain ?? null,
            frame_type: preset.frame_type ?? null,
            filter_name: preset.filter_name ?? null,
          },
          context: {
            program_name: programSafe,
            controller_name: active.id,
            collect_time: collectTime,
            // Filesystem-safe slug for the filename. A custom key (not a built-in
            // like `target_id`) so SK's compat layer passes it through verbatim —
            // it survives from the submission context into the template namespace
            // just like `program_name`.
            target_slug: targetSlug,
            // SK keyword: key must be the registered name `FileNameTemplate` and
            // the value an object matching the model (`{ template: "…" }`), or the
            // webapi won't deserialize it as a keyword. The template references
            // `{target_slug}` (our sanitized key), NOT SK's `{target_id}`, which
            // would carry the raw label's spaces/parentheses straight into the path.
            FileNameTemplate: { template: "{program_name}_{target_slug}_{collect_time}_f{frame_num:03d}.fits" },
          },
        }),
      );
    });
  };

  const noInstrumentsMsg = instruments.length === 0 ? "No SensorKit controllers online" : null;

  return (
    <div className="space-y-2">
      {instruments.length > 1 && (
        <label
          className="flex items-center gap-2 text-[10px]"
          style={{ color: palette === "paper" ? "var(--color-paper-dim)" : undefined }}
        >
          Instrument
          <select
            value={selectedInstrumentId ?? active?.id ?? ""}
            onChange={(e) => setSelectedInstrumentId(e.target.value || null)}
            className={
              palette === "paper"
                ? "flex-1 rounded-sm px-2 py-1 text-xs mono"
                : "flex-1 bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright"
            }
            style={
              palette === "paper"
                ? {
                    background: "var(--color-paper)",
                    color: "var(--color-ink)",
                    border: "1px solid var(--color-paper-muted)",
                  }
                : undefined
            }
          >
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.id}
                {i.online ? "" : " (offline)"}
                {i.mount ? "" : " — no mount"}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex gap-2">
        <ActionBtn
          palette={palette}
          label="Slew"
          disabled={!canSlew || busy}
          tooltip={
            sunTooltip ??
            noInstrumentsMsg ??
            mountBusyReason ??
            (!hasMount ? "No mount available" : "Slew to target")
          }
          onClick={onSlew}
          tone="blue"
        />
        {showTrack && (
          <ActionBtn
            palette={palette}
            label="Track"
            disabled={!canTrack || busy}
            tooltip={
              sunTooltip ??
              noInstrumentsMsg ??
              mountBusyReason ??
              (!hasMount ? "No mount available" : !satRecord ? "Elements not loaded" : "Track target")
            }
            onClick={onTrack}
            tone="blue"
          />
        )}
        {showCollect && (
          <CollectSplitButton
            palette={palette}
            disabled={!canCollect || busy}
            tooltip={
              sunTooltip ??
              noInstrumentsMsg ??
              mountBusyReason ??
              (!active ? "No controller" : undefined)
            }
            onCollect={onCollect}
          />
        )}
      </div>

      {status.phase !== "idle" && (
        <div
          className={`text-[10px] font-mono flex items-center gap-2 flex-wrap ${
            status.phase === "err"
              ? "text-red-400"
              : status.phase === "ok"
                ? "text-green-400"
                : "text-text-dim"
          }`}
          title={status.phase === "err" ? status.message : undefined}
        >
          {status.phase === "pending" && <span>{status.label}…</span>}
          {status.phase === "ok" && <span>{status.label} sent</span>}
          {status.phase === "err" && (
            <>
              <span>
                {status.label} failed: {truncate(status.message, 60)}
              </span>
              {/^.*device not connected.*$/i.test(status.message) && active && (
                <button
                  onClick={onInit}
                  disabled={busy}
                  className="px-2 py-0.5 rounded text-[10px] font-medium border border-blue-500/40 bg-blue-500/20 text-blue-200 hover:bg-blue-500/30 disabled:opacity-50"
                >
                  Init mount
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ActionBtn({
  label, disabled, onClick, tooltip, tone, palette = "dark",
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  tooltip?: string;
  tone: "blue" | "orange";
  palette?: ActionPalette;
}) {
  if (palette === "paper") {
    // Outlined ink button on paper — matches the V4 Slew/Track styling
    return (
      <button
        disabled={disabled}
        onClick={onClick}
        title={tooltip}
        className="flex-1 text-center text-[12px] font-medium rounded-sm transition-colors"
        style={{
          padding: "8px 0",
          background: "transparent",
          color: "var(--color-ink)",
          border: "1px solid var(--color-ink)",
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        {label}
      </button>
    );
  }

  const base =
    "shrink-0 py-2 px-3 rounded-lg text-xs font-medium border transition-colors";
  const enabled =
    tone === "blue"
      ? "bg-blue-600/30 text-blue-200 border-blue-500/40 hover:bg-blue-600/50"
      : "bg-orange-600/30 text-orange-200 border-orange-500/40 hover:bg-orange-600/50";
  const off =
    tone === "blue"
      ? "bg-blue-600/20 text-blue-300 border-blue-500/20 opacity-50 cursor-not-allowed"
      : "bg-orange-600/20 text-orange-300 border-orange-500/20 opacity-50 cursor-not-allowed";
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={tooltip}
      className={`${base} ${disabled ? off : enabled}`}
    >
      {label}
    </button>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function CollectSplitButton({
  disabled,
  tooltip,
  onCollect,
  palette = "dark",
}: {
  disabled: boolean;
  tooltip?: string;
  onCollect: (preset: CollectPreset) => void;
  palette?: ActionPalette;
}) {
  const presets = useCollectPresetsStore((s) => s.presets);
  const defaultPresetId = useCollectPresetsStore((s) => s.defaultPresetId);
  const setDefault = useCollectPresetsStore((s) => s.setDefault);
  const navigate = useNavigate();

  const defaultPreset = presets.find((p) => p.id === defaultPresetId) ?? presets[0] ?? null;

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape
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

  if (palette === "paper") {
    // Filled terracotta button — V4's primary CTA, sized flex 1.7 so it's
    // visibly the widest of the three actions.
    const paperStyle = {
      background: "var(--color-terracotta)",
      color: "#fff",
      border: "1px solid var(--color-terracotta)",
      opacity: disabled || !defaultPreset ? 0.55 : 1,
      cursor: disabled || !defaultPreset ? "not-allowed" : "pointer",
    } as const;
    return (
      <div
        ref={rootRef}
        className="relative flex min-w-0"
        style={{ flex: 1.7 }}
      >
        <button
          disabled={disabled || !defaultPreset}
          onClick={() => defaultPreset && onCollect(defaultPreset)}
          title={tooltip ?? (defaultPreset ? `Collect with "${defaultPreset.name}"` : undefined)}
          className="flex-1 text-center text-[12px] font-medium truncate rounded-l-sm"
          style={{ padding: "8px 6px", borderRight: "none", ...paperStyle }}
        >
          ◉ Collect
          {defaultPreset && (
            <span className="ml-1 text-[10px] opacity-80">· {defaultPreset.name}</span>
          )}
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          title="Choose preset"
          className="text-[12px] rounded-r-sm"
          style={{ padding: "8px", ...paperStyle }}
        >
          <span aria-hidden>▾</span>
        </button>

        {open && (
          <div
            className="absolute bottom-full right-0 mb-1 w-56 z-30 rounded-sm shadow-xl p-1 text-xs"
            style={{
              background: "var(--color-paper-dark)",
              border: "1px solid var(--color-brass)",
              color: "var(--color-ink)",
            }}
          >
            {presets.length === 0 && (
              <div className="px-2 py-1.5 text-paper-dim">No presets yet.</div>
            )}
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  // Selecting a preset only makes it the default; it does not
                  // start a collect. The user starts it with the Collect button.
                  setDefault(p.id);
                  setOpen(false);
                }}
                className="w-full text-left px-2 py-1.5 rounded-sm"
                style={{
                  color:
                    p.id === defaultPresetId
                      ? "var(--color-ink)"
                      : "var(--color-paper-dim)",
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate">{p.name}</span>
                  {p.id === defaultPresetId && (
                    <span
                      className="ml-auto text-[9px] uppercase tracking-wide text-brass"
                      style={{ letterSpacing: "1px" }}
                    >
                      default
                    </span>
                  )}
                </div>
                <div className="text-[10px] mono truncate text-paper-dim">
                  {p.integration_time_seconds}s × {p.frame_count}
                  {p.sidereal_frames?.length ? ` · sid@${p.sidereal_frames.join(",")}` : ""}
                  {p.filter_name && ` · ${p.filter_name}`}
                </div>
              </button>
            ))}
            <div className="my-1" style={{ borderTop: "1px solid var(--color-paper-muted)" }} />
            <button
              onClick={() => {
                setOpen(false);
                navigate("/settings#collect?new");
              }}
              className="w-full text-left px-2 py-1.5 rounded-sm text-terracotta"
            >
              + New preset…
            </button>
            <button
              onClick={() => {
                setOpen(false);
                navigate("/settings#collect");
              }}
              className="w-full text-left px-2 py-1.5 rounded-sm text-paper-dim"
            >
              Manage presets…
            </button>
          </div>
        )}
      </div>
    );
  }

  const baseBtn = "py-2 px-3 text-xs font-medium border transition-colors";
  const enabledCls =
    "bg-orange-600/30 text-orange-200 border-orange-500/40 hover:bg-orange-600/50";
  const disabledCls =
    "bg-orange-600/20 text-orange-300 border-orange-500/20 opacity-50 cursor-not-allowed";

  const main = disabled || !defaultPreset ? disabledCls : enabledCls;

  return (
    <div ref={rootRef} className="relative flex flex-1 min-w-0">
      <button
        disabled={disabled || !defaultPreset}
        onClick={() => defaultPreset && onCollect(defaultPreset)}
        title={tooltip ?? (defaultPreset ? `Collect with "${defaultPreset.name}"` : undefined)}
        className={`${baseBtn} flex-1 rounded-l-lg border-r-0 truncate ${main}`}
      >
        Collect
        {defaultPreset && (
          <span className="ml-1 text-[10px] opacity-70">· {defaultPreset.name}</span>
        )}
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Choose preset"
        className={`${baseBtn} rounded-r-lg px-2 ${
          disabled ? disabledCls : enabledCls
        }`}
      >
        <span aria-hidden>▾</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-56 z-30 rounded-lg border border-panel-border bg-panel-bg/95 backdrop-blur-md shadow-xl p-1 text-xs">
          {presets.length === 0 && (
            <div className="px-2 py-1.5 text-text-dim">No presets yet.</div>
          )}
          {presets.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                // Selecting a preset only makes it the default; it does not
                // start a collect. The user starts it with the Collect button.
                setDefault(p.id);
                setOpen(false);
              }}
              className={`w-full text-left px-2 py-1.5 rounded hover:bg-white/10 ${
                p.id === defaultPresetId ? "text-text-bright" : "text-text-dim"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="truncate">{p.name}</span>
                {p.id === defaultPresetId && (
                  <span className="ml-auto text-[9px] text-blue-300 uppercase tracking-wide">
                    default
                  </span>
                )}
              </div>
              <div className="text-[10px] text-text-dim font-mono truncate">
                {p.integration_time_seconds}s × {p.frame_count}
                {p.sidereal_frames?.length ? ` · sid@${p.sidereal_frames.join(",")}` : ""}
                {p.filter_name && ` · ${p.filter_name}`}
              </div>
            </button>
          ))}
          <div className="border-t border-panel-border my-1" />
          <button
            onClick={() => {
              setOpen(false);
              navigate("/settings#collect?new");
            }}
            className="w-full text-left px-2 py-1.5 rounded hover:bg-white/10 text-blue-300"
          >
            + New preset…
          </button>
          <button
            onClick={() => {
              setOpen(false);
              navigate("/settings#collect");
            }}
            className="w-full text-left px-2 py-1.5 rounded hover:bg-white/10 text-text-dim"
          >
            Manage presets…
          </button>
        </div>
      )}
    </div>
  );
}

function DataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-text-dim">{label}</span>
      <span className="text-text-bright font-mono">{value}</span>
    </div>
  );
}
