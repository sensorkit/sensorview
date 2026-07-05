import { useEffect, useRef } from "react";
import { useSkyViewStore } from "../../../stores/skyview";
import { useSatelliteStore } from "../../../stores/satellites";

const ZOOM_MS = 600;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Target overhead zoom level for a given orbit regime. */
function overheadZoomForRegime(regime: string | undefined): number {
  switch (regime) {
    case "LEO": return 0.5;
    case "MEO": return 0.15;
    case "GEO": return 0.1;
    case "HEO": return 0.12;
    default: return 0.3;
  }
}

/**
 * Animates the overhead zoom to match the selected satellite's orbit regime
 * whenever the user enters overhead view. View-mode switches themselves are
 * now instant (the crossfade was causing long main-thread hangs while both
 * canvases rendered), but this zoom animation is cheap and keeps the nice
 * "zoom in/out to the right scale" feel when you arrive at overhead.
 */
export function useViewTransition() {
  const viewMode = useSkyViewStore((s) => s.viewMode);
  const setOverheadZoom = useSkyViewStore((s) => s.setOverheadZoom);
  const setOverheadCenter = useSkyViewStore((s) => s.setOverheadCenter);
  const zoomRef = useRef<number>(0);
  const prevViewRef = useRef(viewMode);

  useEffect(() => {
    const prev = prevViewRef.current;
    prevViewRef.current = viewMode;

    if (viewMode !== "overhead" || prev === "overhead") return;

    // Snap the globe back to observer-centered on each fresh entry; the user
    // can drag to rotate from there. Prevents "stuck on the other side" if a
    // previous session left the globe panned.
    setOverheadCenter(null);

    const selectedId = useSkyViewStore.getState().selectedSatelliteId;
    const tles = useSatelliteStore.getState().tles;
    const tle = selectedId ? tles.find((t) => t.noradId === selectedId) : null;
    const targetZoom = overheadZoomForRegime(tle?.orbitRegime);
    // Start from 1.0 so the globe fills the viewport, then ease to the
    // regime-appropriate zoom (tight on LEO, wide on GEO).
    const startZoom = 1;
    setOverheadZoom(startZoom);

    if (Math.abs(startZoom - targetZoom) < 0.01) return;

    const startTime = performance.now();
    const tick = () => {
      const elapsed = performance.now() - startTime;
      const rawT = Math.min(1, elapsed / ZOOM_MS);
      const easedT = easeInOutCubic(rawT);
      setOverheadZoom(startZoom + (targetZoom - startZoom) * easedT);
      if (rawT < 1) zoomRef.current = requestAnimationFrame(tick);
    };
    zoomRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(zoomRef.current);
  }, [viewMode, setOverheadZoom, setOverheadCenter]);
}
