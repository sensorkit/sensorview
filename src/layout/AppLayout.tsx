import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useSensorKitStore } from "../stores/sensorkit";
import { useObserver, lstDegrees } from "../features/skyview/hooks/useObserver";
import { setAgentEnabled } from "../lib/sensorkit-client/commands";
import { RightDock } from "../features/panels/RightDock";
import { TabErrorBoundary } from "./TabErrorBoundary";
import {
  useTabsStore,
  reconcileOrder,
  tabsFromOrder,
  type TabDef,
  type TabId,
} from "../stores/tabs";
import {
  openTabWindow,
  onTabWindowClosed,
  listDetachedTabs,
} from "../lib/electron-bridge";

export function AppLayout() {
  const connection = useSensorKitStore((s) => s.connection);
  const { observer } = useObserver();
  const { pathname } = useLocation();
  const syncDetached = useTabsStore((s) => s.syncDetached);
  const setDetached = useTabsStore((s) => s.setDetached);

  // Keep the strip's detached markers in sync with the main process: restore the
  // set on (re)mount — covers a main-window reload while tab windows are open —
  // and re-dock a tab as soon as its window closes. Both are no-ops in a browser.
  useEffect(() => {
    listDetachedTabs()
      .then((ids) => syncDetached(ids))
      .catch(() => {});
    return onTabWindowClosed((id) => setDetached(id as TabId, false));
  }, [syncDetached, setDetached]);

  return (
    <div className="w-full h-dvh flex flex-col bg-sky-ink">
      {/* Top bar — V4 "Atlas Observatory" (paper) */}
      <nav
        className="flex items-center h-[46px] bg-paper px-3 md:px-5 shrink-0 gap-1"
        style={{ borderBottom: "1px solid var(--color-brass)" }}
      >
        <img
          src={`${import.meta.env.BASE_URL}logos/sensorkit-horizontal.svg`}
          alt="SensorKit"
          className="mr-6 h-[26px] w-auto select-none max-md:hidden"
          draggable={false}
        />
        <TabStrip />
        <div className="ml-auto shrink-0 pl-2 flex items-center gap-2.5 md:gap-[14px]">
          <AgentControlMenu connection={connection} />
          <UtcClock />
          <LstReadout lon={observer.lon} />
        </div>
      </nav>

      {/* Active tab content + right-edge dock share a row so the dock reserves
          space instead of overlaying page content (no more covering the catalog).
          Below lg the dock overlays instead (see RightDock), hence `relative`. */}
      <div className="flex-1 min-h-0 flex relative">
        <div className="flex-1 min-w-0 min-h-0">
          <TabErrorBoundary resetKey={pathname}>
            <Outlet />
          </TabErrorBoundary>
        </div>
        <RightDock />
      </div>
    </div>
  );
}

/**
 * The main navigation tabs, rendered from the persisted tab-order store.
 *
 *  - Reorder: press a tab and drag — it lifts and follows the cursor while the
 *    others slide apart to open the gap where it will land (Chrome-style). Built
 *    on pointer events (reliable in Electron + browser, no dependency); the
 *    order survives reloads.
 *  - Detach: the ⧉ button (hover to reveal) pops the tab out into its own OS
 *    window in Electron, or drag a tab clear of the strip to tear it off; the
 *    tab then shows italic/dimmed with a brass ⧉ — click either to focus the
 *    window. Closing the window (or its Dock button) re-docks it. In a plain
 *    browser there's no true detach, so ⧉ just opens a new window.
 *
 * Streams is always present; whether the renderer has a webcam is decided
 * inside AddStreamModal's device picker, which gracefully shows "No video
 * inputs detected" on headless boxes.
 */
function TabStrip() {
  const order = useTabsStore((s) => s.order);
  const reorderTo = useTabsStore((s) => s.reorderTo);
  const detached = useTabsStore((s) => s.detached);
  const setDetached = useTabsStore((s) => s.setDetached);
  const tabs = tabsFromOrder(reconcileOrder(order));
  const navigate = useNavigate();
  const location = useLocation();

  const stripRef = useRef<HTMLDivElement>(null);
  // Live pointer-drag bookkeeping that must not trigger re-renders. `mids` are
  // the tab midpoints captured at pickup, so the drop slot is measured against a
  // fixed layout (not the shifting one); `moved` gates click-vs-drag.
  const dragRef = useRef<{
    id: TabId;
    pointerId: number;
    grabOffset: number;
    gapWidth: number;
    mids: { id: string; mid: number }[];
    startX: number;
    startY: number;
    moved: boolean;
    captured: boolean;
  } | null>(null);
  // Set right after a drag so the click that trails it doesn't navigate.
  const justDragged = useRef(false);
  // The render-affecting slice of the drag: which tab is lifted, where it will
  // land, where the lifted tab floats (px from the strip's left edge), and
  // whether the pointer is off the strip (tear-off).
  const [drag, setDrag] = useState<{
    id: TabId;
    dropIndex: number;
    floatX: number;
    gapWidth: number;
    offStrip: boolean;
  } | null>(null);

  /** Pop a docked tab out into its own window (no-op if already detached). */
  const detachTab = async (tab: TabDef) => {
    if (detached.includes(tab.id)) return;
    const wasActive = location.pathname === tab.to;
    const detachedForReal = await openTabWindow(tab.id);
    if (!detachedForReal) return; // browser: opened a plain window, tab stays docked
    setDetached(tab.id, true);
    // If we popped out the tab that's showing, move the main window to the first
    // still-docked tab so it isn't mirroring the detached window.
    if (wasActive) {
      const fallback = tabs.find((t) => t.id !== tab.id && !detached.includes(t.id));
      if (fallback) navigate(fallback.to);
    }
  };

  const popOut = (tab: TabDef) => {
    // Already out → just bring its window forward; otherwise detach it.
    if (detached.includes(tab.id)) {
      void openTabWindow(tab.id);
      return;
    }
    void detachTab(tab);
  };

  const isOffStrip = (clientY: number): boolean => {
    const r = stripRef.current?.closest("nav")?.getBoundingClientRect();
    return r ? clientY > r.bottom + 24 || clientY < r.top - 24 : false;
  };
  // Slot = how many other tabs sit (by their pickup-time midpoint) left of the cursor.
  const dropSlot = (clientX: number, d: NonNullable<typeof dragRef.current>): number => {
    let idx = 0;
    for (const it of d.mids) if (it.id !== d.id && clientX > it.mid) idx++;
    return idx;
  };

  const onTabPointerDown = (e: ReactPointerEvent, tab: TabDef) => {
    // Mouse-only: on touch the strip scrolls natively and a tap must always
    // navigate — starting a drag here would fight the scroll gesture (the
    // browser wins via pointercancel) and swallow taps as aborted drags.
    if (e.button !== 0 || dragRef.current || e.pointerType !== "mouse") return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = {
      id: tab.id,
      pointerId: e.pointerId,
      grabOffset: e.clientX - rect.left,
      gapWidth: rect.width,
      mids: [...(stripRef.current?.querySelectorAll<HTMLElement>("[data-tabid]") ?? [])].map(
        (c) => {
          const r = c.getBoundingClientRect();
          return { id: c.dataset.tabid as string, mid: r.left + r.width / 2 };
        },
      ),
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      captured: false,
    };
  };

  const onStripPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved) {
      // Only start dragging past a small threshold, so a plain click still navigates.
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      d.moved = true;
      try {
        stripRef.current?.setPointerCapture(e.pointerId);
        d.captured = true;
      } catch {
        /* pointer may already have ended */
      }
    }
    e.preventDefault();
    const stripLeft = stripRef.current?.getBoundingClientRect().left ?? 0;
    setDrag({
      id: d.id,
      dropIndex: dropSlot(e.clientX, d),
      floatX: e.clientX - stripLeft - d.grabOffset,
      gapWidth: d.gapWidth,
      offStrip: isOffStrip(e.clientY),
    });
  };

  const finishDrag = (e: ReactPointerEvent, commit: boolean) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.captured) {
      try {
        stripRef.current?.releasePointerCapture(d.pointerId);
      } catch {
        /* already released */
      }
    }
    const { id, moved } = d;
    const slot = dropSlot(e.clientX, d);
    const off = isOffStrip(e.clientY);
    dragRef.current = null;
    setDrag(null);
    if (!commit || !moved) return; // a plain click — let the NavLink navigate
    justDragged.current = true;
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (off && !detached.includes(id)) void detachTab(tab);
    else reorderTo(id, slot);
  };

  // Order with the dragged tab removed — the space dropIndex is measured in.
  const visibleIds = drag == null ? [] : tabs.filter((t) => t.id !== drag.id).map((t) => t.id);

  return (
    <div
      ref={stripRef}
      className="relative flex items-center gap-1 h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onPointerMove={onStripPointerMove}
      onPointerUp={(e) => finishDrag(e, true)}
      onPointerCancel={(e) => finishDrag(e, false)}
    >
      {tabs.map((tab) => {
        const isDragging = drag?.id === tab.id;
        const isOut = detached.includes(tab.id);
        // Other tabs slide right to open the gap; it collapses once the pointer
        // is off the strip (the drag will tear the tab off instead of reordering).
        const shift =
          drag && !drag.offStrip && !isDragging && visibleIds.indexOf(tab.id) >= drag.dropIndex
            ? drag.gapWidth
            : 0;
        return (
          <div
            key={tab.id}
            data-tabid={tab.id}
            className="relative flex group shrink-0"
            style={
              isDragging
                ? {
                    // The lifted tab floats out of flow and follows the cursor.
                    position: "absolute",
                    left: drag!.floatX,
                    top: "50%",
                    transform: "translateY(-50%)",
                    zIndex: 30,
                    pointerEvents: "none",
                    opacity: drag!.offStrip ? 0.55 : 0.97,
                    background: "var(--color-paper)",
                    borderRadius: 6,
                    boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
                    transition: "opacity 120ms ease",
                  }
                : { transform: `translateX(${shift}px)`, transition: "transform 160ms ease" }
            }
          >
            <NavLink
              to={tab.to}
              end={tab.to === "/"}
              draggable={false}
              onPointerDown={(e) => onTabPointerDown(e, tab)}
              onClick={(e) => {
                // Swallow the click that trails a drag, and focus (not navigate)
                // a detached tab's own window.
                if (justDragged.current) {
                  e.preventDefault();
                  return;
                }
                if (isOut) {
                  e.preventDefault();
                  void openTabWindow(tab.id);
                }
              }}
              title={
                isOut ? `${tab.label} is open in its own window — click to focus` : undefined
              }
              className={({ isActive }) =>
                `pl-[14px] pr-[24px] py-2 text-[12.5px] transition-colors select-none cursor-grab active:cursor-grabbing ${
                  isActive && !isOut
                    ? "text-ink font-medium"
                    : "text-paper-dim hover:text-ink"
                } ${isOut ? "italic opacity-70" : ""}`
              }
              style={({ isActive }) => ({
                borderBottom:
                  isActive && !isOut
                    ? "2px solid var(--color-brass)"
                    : "2px solid transparent",
                letterSpacing: "0.1px",
              })}
            >
              {tab.label}
            </NavLink>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void popOut(tab);
              }}
              title={isOut ? "Focus window" : "Open in its own window"}
              aria-label={isOut ? `Focus ${tab.label} window` : `Pop out ${tab.label}`}
              className={`pointer-coarse:hidden absolute top-1/2 -translate-y-1/2 right-[3px] flex items-center justify-center w-4 h-4 rounded text-[11px] leading-none cursor-pointer transition-opacity hover:text-ink ${
                isOut
                  ? "text-brass opacity-100"
                  : "text-paper-dim opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              }`}
            >
              ⧉
            </button>
          </div>
        );
      })}
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
        className="inline-flex items-center gap-1.5 rounded-full px-[9px] py-[3px] pointer-coarse:px-3 pointer-coarse:py-1.5 text-[10px] cursor-pointer hover:brightness-110"
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
              className="block w-full text-left px-3 py-1.5 pointer-coarse:py-3 text-text-bright hover:bg-white/5"
            >
              Enable
            </button>
          )}
          {showDisable && (
            <button
              onClick={() => pickAction("disable")}
              className="block w-full text-left px-3 py-1.5 pointer-coarse:py-3 text-text-bright hover:bg-white/5"
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
    <span className="mono text-[12px] text-ink whitespace-nowrap">
      {hh}:{mm}
      <span className="hidden sm:inline">
        :{ss}
        <span className="text-paper-dim">.{hundredths}</span>
      </span>
      Z
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
    <span className="mono text-[11px] text-brass whitespace-nowrap hidden md:inline">
      LST {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}
    </span>
  );
}
