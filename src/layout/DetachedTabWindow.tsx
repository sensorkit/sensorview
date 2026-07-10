import { useEffect, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { AtlasContainer } from "../features/skyview/AtlasContainer";
import { DevicesPage } from "../features/devices/DevicesPage";
import { TasksPage } from "../features/tasks/TasksPage";
import { ImagesPage } from "../features/images/ImagesPage";
import { StatusPage } from "../features/status/StatusPage";
import { StreamsPage } from "../features/streams/StreamsPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { TAB_DEFS, type TabDef, type TabId } from "../stores/tabs";
import { isRunningInElectron, closeTabWindow } from "../lib/electron-bridge";

/**
 * The page content for each tab, keyed by tab id. Mirrors the routes in App.tsx
 * but renders the page bare — a detached window is a single tab with no nav
 * strip or right-dock (the main window keeps those).
 */
const PAGE_BY_TAB: Record<TabId, ReactNode> = {
  skyview: <AtlasContainer />,
  devices: <DevicesPage />,
  tasks: <TasksPage />,
  images: <ImagesPage />,
  status: <StatusPage />,
  streams: <StreamsPage />,
  settings: <SettingsPage />,
};

/**
 * Standalone window host for a popped-out main tab (route `#/window/:tabId`).
 * Renders a slim header (label + re-dock button) over the tab's page. Each
 * detached window is its own Electron renderer and opens its own SSE stream
 * (bootstrapped in App), so it stays live independently.
 */
export function DetachedTabWindow() {
  const { tabId } = useParams();
  const def = TAB_DEFS.find((t) => t.id === tabId);

  useEffect(() => {
    if (def) document.title = `SensorView — ${def.label}`;
  }, [def]);

  if (!def) {
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-sky-ink text-text-dim text-sm">
        Unknown tab: {String(tabId)}
      </div>
    );
  }

  return (
    <div className="w-screen h-screen flex flex-col overflow-hidden bg-sky-ink">
      <DetachedHeader def={def} />
      <div className="flex-1 min-w-0 min-h-0">{PAGE_BY_TAB[def.id]}</div>
    </div>
  );
}

/**
 * The detached window's title strip: the tab name and — in Electron — a button
 * that re-docks it back into the main window (closing this window).
 */
function DetachedHeader({ def }: { def: TabDef }) {
  return (
    <div className="shrink-0 h-8 flex items-center gap-2 px-3 bg-paper border-b border-brass/60 select-none">
      <span className="text-[12px] text-ink font-medium">{def.label}</span>
      {isRunningInElectron() && (
        <button
          type="button"
          onClick={() => void closeTabWindow(def.id)}
          title="Re-dock into the main window"
          aria-label="Re-dock into the main window"
          className="ml-auto flex items-center justify-center w-6 h-6 text-[13px] leading-none text-paper-dim hover:text-ink border border-brass/40 rounded cursor-pointer"
        >
          ⇤
        </button>
      )}
    </div>
  );
}
