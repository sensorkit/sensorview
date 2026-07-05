import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useSensorKitStore } from "../stores/sensorkit";
import { useObserver, lstDegrees } from "../features/skyview/hooks/useObserver";
import { setAgentEnabled } from "../lib/sensorkit-client/commands";
import { RightDock } from "../features/panels/RightDock";

// Streams is always shown; whether the renderer has a webcam is decided
// inside AddStreamModal's device picker, which gracefully shows "No video
// inputs detected" on headless boxes. The previous gating made it
// impossible to add a network stream from a headless host (chicken-and-egg
// — the only way in was hidden by its own absence).
const tabs = [
  { to: "/", label: "SkyView" },
  { to: "/devices", label: "Devices" },
  { to: "/tasks", label: "Tasks" },
  { to: "/images", label: "Images" },
  { to: "/status", label: "Status" },
  { to: "/streams", label: "Streams" },
  { to: "/settings", label: "Settings" },
] as const;

export function AppLayout() {
  const connection = useSensorKitStore((s) => s.connection);
  const { observer } = useObserver();

  return (
    <div className="w-full h-screen flex flex-col bg-sky-ink">
      {/* Top bar — V4 "Atlas Observatory" (paper) */}
      <nav
        className="flex items-center h-[46px] bg-paper px-5 shrink-0 gap-1"
        style={{ borderBottom: "1px solid var(--color-brass)" }}
      >
        <img
          src={`${import.meta.env.BASE_URL}logos/sensorkit-horizontal.svg`}
          alt="SensorKit"
          className="mr-6 h-[26px] w-auto select-none"
          draggable={false}
        />
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === "/"}
            className={({ isActive }) =>
              `px-[14px] py-2 text-[12.5px] transition-colors ${
                isActive
                  ? "text-ink font-medium"
                  : "text-paper-dim hover:text-ink"
              }`
            }
            style={({ isActive }) => ({
              borderBottom: isActive
                ? "2px solid var(--color-brass)"
                : "2px solid transparent",
              letterSpacing: "0.1px",
            })}
          >
            {tab.label}
          </NavLink>
        ))}
        <div className="ml-auto flex items-center gap-[14px]">
          <AgentControlMenu connection={connection} />
          <UtcClock />
          <LstReadout lon={observer.lon} />
        </div>
      </nav>

      {/* Active tab content + right-edge dock share a row so the dock reserves
          space instead of overlaying page content (no more covering the catalog). */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0">
          <Outlet />
        </div>
        <RightDock />
      </div>
    </div>
  );
}

/**
 * SK LIVE pill that doubles as the agent enable/disable trigger. The
 * pill text reflects SSE connection state (LIVE / CONNECTING / ERROR /
 * OFFLINE); the trailing chevron opens a dropdown for the agent action
 * that would actually change something — Enable when currently disabled,
 * Disable when currently enabled. We hide the no-op action so a glance
 * at the menu also tells you the agent's current state. Confirmation
 * modal mirrors the Init flow in DevicesPage — global control is a big
 * enough hammer to warrant it.
 */
function AgentControlMenu({ connection }: { connection: string }) {
  const [open, setOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"enable" | "disable" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const agentState = useSensorKitStore((s) => s.getAgentState)();

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

  const runAction = async () => {
    if (!pendingAction) return;
    setBusy(true);
    setError(null);
    try {
      await setAgentEnabled(pendingAction === "enable");
      setPendingAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pickAction = (action: "enable" | "disable") => {
    setOpen(false);
    setPendingAction(action);
  };

  const live = connection === "open";
  const label =
    connection === "open"
      ? "LIVE"
      : connection === "connecting"
        ? "CONNECTING"
        : connection === "error"
          ? "ERROR"
          : "OFFLINE";
  const color = live
    ? "var(--color-sage)"
    : connection === "connecting"
      ? "var(--color-brass)"
      : "var(--color-paper-muted)";

  // Show only the action that would change something. If we don't have
  // AgentState yet (agent service not up, or first-render race), fall back
  // to showing both so the menu is never empty.
  const enabled = agentState?.operating_state.global_control_enabled;
  const showEnable = enabled === false || enabled === undefined;
  const showDisable = enabled === true || enabled === undefined;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full px-[9px] py-[3px] text-[10px] cursor-pointer hover:brightness-110"
        style={{
          color,
          border: `1px solid ${color}77`,
          background: `${color}1a`,
          letterSpacing: "0.5px",
        }}
        aria-label="Agent control"
        title="Agent control"
      >
        <span
          className="inline-block rounded-full"
          style={{ width: 5, height: 5, background: color }}
        />
        <span className="mono">{label}</span>
        <span>▾</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 z-30 min-w-[120px] rounded-md border border-panel-border bg-panel-bg/95 backdrop-blur-md shadow-xl py-1 text-[11px]">
          {showEnable && (
            <button
              onClick={() => pickAction("enable")}
              className="block w-full text-left px-3 py-1.5 text-text-bright hover:bg-white/5"
            >
              Enable
            </button>
          )}
          {showDisable && (
            <button
              onClick={() => pickAction("disable")}
              className="block w-full text-left px-3 py-1.5 text-text-bright hover:bg-white/5"
            >
              Disable
            </button>
          )}
        </div>
      )}

      {pendingAction && (
        <AgentConfirmModal
          action={pendingAction}
          busy={busy}
          error={error}
          onConfirm={runAction}
          onCancel={() => {
            if (busy) return;
            setPendingAction(null);
            setError(null);
          }}
        />
      )}
    </div>
  );
}

function AgentConfirmModal({
  action,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  action: "enable" | "disable";
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const verb = action === "enable" ? "Enable" : "Disable";
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
          {verb} the agent?
        </h3>
        <p className="text-xs text-text-dim mb-4">
          {action === "enable"
            ? "Turns on global control. The agent will orchestrate every controller it manages — initializing devices, scheduling tasks, and reacting to constraints. Have a look at what's queued before proceeding."
            : "Turns off global control. The agent will stop scheduling new tasks and will deactivate every controller it manages. In-flight tasks may be cancelled."}
        </p>
        {error && (
          <div className="text-[11px] text-red-300 mb-3 break-words">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="py-1 px-3 rounded text-[11px] font-medium border bg-black/40 text-text-bright border-panel-border hover:bg-black/60 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="py-1 px-3 rounded text-[11px] font-medium border bg-accent/30 text-text-bright border-accent/50 hover:bg-accent/50 disabled:opacity-50"
          >
            {busy ? "…" : verb}
          </button>
        </div>
      </div>
    </div>
  );
}

function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Tick every 100 ms so the hundredths readout flickers like the mock
    const id = window.setInterval(() => setNow(new Date()), 100);
    return () => window.clearInterval(id);
  }, []);

  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  const hundredths = String(Math.floor(now.getUTCMilliseconds() / 10)).padStart(2, "0");

  return (
    <span className="mono text-[12px] text-ink">
      {hh}:{mm}:{ss}
      <span className="text-paper-dim">.{hundredths}</span>Z
    </span>
  );
}

function LstReadout({ lon }: { lon: number }) {
  // Recompute once per second — sidereal drift is slow compared to UTC clock.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const lst = lstDegrees(new Date(), lon);
  // Convert 0–360° to 0–24h
  const hours = (lst / 15) % 24;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  void tick;
  return (
    <span className="mono text-[11px] text-brass">
      LST {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}
    </span>
  );
}
