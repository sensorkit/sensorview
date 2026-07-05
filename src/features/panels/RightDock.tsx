import { useUIPanelsStore } from "../../stores/uiPanels";
import { usePaneResize } from "./usePaneResize";
import { LatestImagePanel } from "./LatestImagePanel";
import { ServiceLogPanel } from "./ServiceLogPanel";

const DOCK_MIN = 260;
const DOCK_MAX = 760;
const IMG_MIN = 120;
const IMG_MAX = 1400;
const DOCK_TOP = 46; // app-bar height; the dock starts below it

/**
 * Global right-edge dock holding two stacked pop-out panels — the latest-image
 * viewer (top) and the service log tailer (bottom). It's an inline flex column,
 * so opening it reserves space and shifts page content left rather than
 * overlaying it. Each panel is toggled by an arrow tab that hangs off the dock's
 * left edge: `→` to deploy, `←` to re-dock.
 */
export function RightDock() {
  const imageOpen = useUIPanelsStore((s) => s.imagePanelOpen);
  const logOpen = useUIPanelsStore((s) => s.logPanelOpen);
  const dockWidth = useUIPanelsStore((s) => s.dockWidth);
  const imageHeight = useUIPanelsStore((s) => s.imagePaneHeight);
  const toggleImage = useUIPanelsStore((s) => s.toggleImagePanel);
  const toggleLog = useUIPanelsStore((s) => s.toggleLogPanel);
  const setDockWidth = useUIPanelsStore((s) => s.setDockWidth);
  const setImageHeight = useUIPanelsStore((s) => s.setImagePaneHeight);

  const anyOpen = imageOpen || logOpen;

  // Grip on the dock's left edge: dragging left widens it (invert).
  const widthGrip = usePaneResize("x", dockWidth, setDockWidth, {
    min: DOCK_MIN,
    max: DOCK_MAX,
    invert: true,
  });
  // Divider below the image pane: dragging down makes the image taller.
  const heightGrip = usePaneResize("y", imageHeight, setImageHeight, {
    min: IMG_MIN,
    max: IMG_MAX,
  });

  // Tab vertical positions. When both panels are open, center each tab on its
  // panel's region so they straddle (and track) the divider as it's dragged.
  // Otherwise keep them as a tidy pair at the dock center — pushing a collapsed
  // panel's tab to the far top/bottom edge looked detached.
  const dockCenter = `calc((${DOCK_TOP}px + 100vh) / 2)`;
  const imageTabTop =
    imageOpen && logOpen
      ? `calc(${DOCK_TOP}px + ${imageHeight / 2}px)` // center of image region
      : `calc(${dockCenter} - 31px)`; // upper of the centered pair
  const logTabTop =
    imageOpen && logOpen
      ? `calc((${DOCK_TOP + imageHeight}px + 100vh) / 2)` // center of log region
      : `calc(${dockCenter} + 31px)`; // lower of the centered pair
  const tabRight = anyOpen ? dockWidth : 0;

  return (
    <>
      {/* Inline dock column — reserves layout width when open. */}
      <div
        className="relative shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
        style={{ width: anyOpen ? dockWidth : 0 }}
        aria-hidden={!anyOpen}
      >
        <div
          className="absolute inset-y-0 right-0 flex flex-col bg-panel-bg/95 backdrop-blur-md border-l border-panel-border shadow-2xl"
          style={{ width: dockWidth }}
        >
          {/* Width grip */}
          <div
            onPointerDown={widthGrip}
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-brass/40 z-10"
            title="Resize"
          />

          {imageOpen && (
            <div
              className="flex flex-col min-h-0"
              style={logOpen ? { height: imageHeight, flexShrink: 0 } : { flex: "1 1 0%" }}
            >
              <LatestImagePanel />
            </div>
          )}

          {imageOpen && logOpen && (
            <div
              onPointerDown={heightGrip}
              className="shrink-0 h-1.5 cursor-ns-resize hover:bg-brass/40 border-y border-panel-border"
              title="Resize"
            />
          )}

          {logOpen && (
            <div className="flex flex-col min-h-0" style={{ flex: "1 1 0%" }}>
              <ServiceLogPanel />
            </div>
          )}
        </div>
      </div>

      {/* Hanging tabs — each centered on its panel's region, tracking the divider.
          The dock spans from the 46px app bar to the bottom; `splitY` is the
          boundary between the image region (top) and the log region (bottom). */}
      <ArrowTab open={imageOpen} onClick={toggleImage} label="image" right={tabRight} top={imageTabTop} />
      <ArrowTab open={logOpen} onClick={toggleLog} label="logs" right={tabRight} top={logTabTop} />
    </>
  );
}

function ArrowTab({
  open,
  onClick,
  label,
  right,
  top,
}: {
  open: boolean;
  onClick: () => void;
  label: string;
  right: number;
  top: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{ right, top }}
      title={open ? `Hide ${label}` : `Show ${label}`}
      aria-label={open ? `Hide ${label}` : `Show ${label}`}
      className="fixed z-40 -translate-y-1/2 flex items-center justify-center w-5 h-14 rounded-l-lg bg-panel-bg/95 backdrop-blur-md border border-r-0 border-panel-border text-text-dim hover:text-text-bright hover:bg-panel-bg cursor-pointer select-none text-xs shadow-[-3px_0_10px_rgba(0,0,0,0.4)] transition-[right] duration-200 ease-out"
    >
      {open ? "→" : "←"}
    </button>
  );
}
