import { useEffect, useRef, useCallback, useMemo } from "react";
import { createCelestialProjection, screenToGeo } from "../projection";
import type { StarCatalog } from "../catalog/stars";
import type { Constellation } from "../catalog/constellations";
import { renderStarField } from "../layers/StarFieldLayer";
import { renderConstellations } from "../layers/ConstellationLayer";
import { renderSatellites } from "../layers/SatelliteLayer";
import { renderHorizon } from "../layers/HorizonLayer";
import { renderMountReticles } from "../layers/MountReticleLayer";
import { renderSolarSystem } from "../layers/SolarSystemLayer";
import { renderHorizonsTarget } from "../layers/HorizonsTargetLayer";
import { useMountPointings } from "../../../lib/sensorkit-client/instruments";
import { useSolarSystemBodies } from "../hooks/useSolarSystemBodies";
import { InteractionLayer } from "../layers/InteractionLayer";
import { createPinchTracker } from "./pinchZoom";
import { useAtlasInteraction } from "../hooks/useAtlasInteraction";
import { useSatelliteTrack } from "../hooks/useSatelliteTrack";
import { useSkyViewStore } from "../../../stores/skyview";
import { useSatelliteStore, type SatellitePosition } from "../../../stores/satellites";
import type { ObserverLocation } from "../hooks/useObserver";
import type { SolarBody } from "../hooks/useSolarSystemBodies";

const EMPTY_BODIES: SolarBody[] = [];

interface SkyCanvasProps {
  size: { width: number; height: number };
  catalog: StarCatalog | null;
  constellations: Constellation[];
  observer: ObserverLocation;
  filteredPositions: SatellitePosition[];
}

export function SkyCanvas({
  size, catalog, constellations, observer, filteredPositions,
}: SkyCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const starCanvasRef = useRef<HTMLCanvasElement>(null);
  const constellationCanvasRef = useRef<HTMLCanvasElement>(null);
  const solarSystemCanvasRef = useRef<HTMLCanvasElement>(null);
  const satelliteCanvasRef = useRef<HTMLCanvasElement>(null);
  const horizonsCanvasRef = useRef<HTMLCanvasElement>(null);
  const horizonCanvasRef = useRef<HTMLCanvasElement>(null);
  const pointingCanvasRef = useRef<HTMLCanvasElement>(null);

  const {
    centerRA, centerDec, zoom, limitingMagnitude, showConstellations,
    showSolarSystem, selectedSatellite, selectedBodyName, selectedHorizonsTarget,
    manualTarget, setCenter, setZoom, setManualTarget,
  } = useSkyViewStore();

  const tles = useSatelliteStore((s) => s.tles);
  const mountPointings = useMountPointings();
  const bodies = useSolarSystemBodies(observer);
  const visibleBodies = showSolarSystem ? bodies : EMPTY_BODIES;

  // Create projection
  const projection = useMemo(
    () => createCelestialProjection(size.width, size.height, centerRA, centerDec, zoom),
    [size.width, size.height, centerRA, centerDec, zoom],
  );

  // Orbital track for selected satellite
  const track = useSatelliteTrack(selectedSatellite, observer);

  // Adaptive magnitude cap. Targets ~2000 visible stars at any zoom by
  // scaling the limit with `log10(zoom)` — derived from HIP density:
  // doubling zoom cuts the visible area to a quarter, so density must
  // rise 4× to keep the count constant, which is ~+0.6 mag (HIP density
  // grows roughly 10^(0.6 mag) up to its completeness limit). Calibrated
  // empirically so zoom 1 → mag 5.5 (≈ BSC naked-eye), zoom 50 → mag 12
  // (full HIP). Capped by the store's `limitingMagnitude` so a user who
  // sets a manual ceiling still sees it honored.
  const starMagLimit = useMemo(() => {
    const adaptive = 5.5 + 3.8 * Math.log10(Math.max(1, zoom));
    return Math.min(adaptive, limitingMagnitude);
  }, [zoom, limitingMagnitude]);
  const { handleClickAt, handleMouseMove } = useAtlasInteraction(
    filteredPositions, projection, catalog, visibleBodies, starMagLimit,
  );

  // Set up canvas dimensions
  useEffect(() => {
    if (size.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const canvases = [
      starCanvasRef, constellationCanvasRef, horizonCanvasRef,
      solarSystemCanvasRef, satelliteCanvasRef, horizonsCanvasRef, pointingCanvasRef,
    ];
    for (const ref of canvases) {
      const canvas = ref.current;
      if (!canvas) continue;
      canvas.width = size.width * dpr;
      canvas.height = size.height * dpr;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
    }
  }, [size]);

  const getCtx = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas || size.width === 0) return null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return ctx;
    },
    [size],
  );

  // Keep handleClickAt in a ref so the pointer handler can use it without re-attaching
  const clickAtRef = useRef(handleClickAt);
  clickAtRef.current = handleClickAt;

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const geo = screenToGeo(projection, x, y);
      if (!geo) return;
      const ra = ((geo[0] % 360) + 360) % 360;
      const dec = Math.max(-90, Math.min(90, geo[1]));
      setManualTarget(ra, dec);
    },
    [projection, setManualTarget],
  );

  // Wheel zoom + pointer drag pan + click detection
  useEffect(() => {
    const container = containerRef.current;
    if (!container || size.width === 0) return;

    let currentRA = centerRA;
    let currentDec = centerDec;
    let currentZoom = zoom;
    let dragging = false;
    let didDrag = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    const CLICK_THRESHOLD = 5;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      // Max zoom 250 → FOV ≈ 240/250 ≈ 1° (matches the projection's clipAngle
      // floor in computeFovDegrees / createCelestialProjection).
      currentZoom = Math.max(0.5, Math.min(250, currentZoom * factor));
      setZoom(currentZoom);
    };

    // touch-none suppresses native pinch, so two-finger zoom is ours to run.
    const pinch = createPinchTracker({
      getZoom: () => currentZoom,
      setZoom: (z) => {
        currentZoom = z;
        setZoom(z);
      },
      min: 0.5,
      max: 250,
    });

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pinch.down(e);
      if (pinch.pinching) {
        // Second finger: the gesture is a pinch, not a pan or a click.
        dragging = false;
        return;
      }
      dragging = true;
      didDrag = false;
      startX = e.clientX;
      startY = e.clientY;
      lastX = e.clientX;
      lastY = e.clientY;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pinch.move(e)) return;
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      const totalDx = e.clientX - startX;
      const totalDy = e.clientY - startY;
      if (totalDx * totalDx + totalDy * totalDy > CLICK_THRESHOLD * CLICK_THRESHOLD) {
        didDrag = true;
      }

      if (didDrag) {
        const degreesPerPixel = 120 / (Math.min(size.width, size.height) * currentZoom);
        // Drag-right pans the camera right (sky appears to slide left under
        // your cursor) — matches Google-Maps-style "grab and pull" pointer
        // semantics. With the projection's E-on-left convention this means
        // RA increases with positive dx, not decreases.
        currentRA = ((currentRA + dx * degreesPerPixel) % 360 + 360) % 360;
        currentDec = Math.max(-90, Math.min(90, currentDec + dy * degreesPerPixel));
        setCenter(currentRA, currentDec);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (pinch.up(e)) {
        dragging = false;
        return;
      }
      if (dragging && !didDrag) {
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        clickAtRef.current(x, y, rect);
      }
      dragging = false;
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerUp);

    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  // === RENDER LAYERS ===

  useEffect(() => {
    if (!catalog || size.width === 0) return;
    const ctx = getCtx(starCanvasRef.current);
    if (!ctx) return;
    const showingSatellites = filteredPositions.length > 0;
    // Use the adaptive limit (already capped by store's limitingMagnitude)
    // so wide-FOV views stay uncluttered while zoom progressively reveals
    // fainter stars. The catalog is sorted brightest-first; the renderer's
    // break-early loop terminates the iteration as soon as mag exceeds
    // this cap, so iterating 118k HIP rows costs nothing past the cap.
    renderStarField(ctx, catalog, projection, zoom, starMagLimit, showingSatellites);
  }, [catalog, projection, zoom, starMagLimit, filteredPositions.length, size, getCtx]);

  useEffect(() => {
    if (constellations.length === 0 || size.width === 0) return;
    const ctx = getCtx(constellationCanvasRef.current);
    if (!ctx) return;
    if (showConstellations) {
      renderConstellations(ctx, constellations, projection);
    } else {
      ctx.clearRect(0, 0, size.width, size.height);
    }
  }, [constellations, projection, showConstellations, size, getCtx]);

  useEffect(() => {
    if (size.width === 0) return;
    const ctx = getCtx(horizonCanvasRef.current);
    if (!ctx) return;
    renderHorizon(ctx, size.width, size.height, projection, observer, new Date());
  }, [projection, observer, size, getCtx]);

  useEffect(() => {
    if (size.width === 0) return;
    const ctx = getCtx(satelliteCanvasRef.current);
    if (!ctx) return;
    renderSatellites(
      ctx, size.width, size.height,
      filteredPositions, tles, projection, selectedSatellite, true, track,
    );
  }, [filteredPositions, tles, projection, selectedSatellite, size, getCtx, track]);

  // Solar-system bodies — draws beneath satellite layer
  useEffect(() => {
    if (size.width === 0) return;
    const ctx = getCtx(solarSystemCanvasRef.current);
    if (!ctx) return;
    renderSolarSystem(ctx, projection, visibleBodies, selectedBodyName);
  }, [projection, visibleBodies, selectedBodyName, size, getCtx]);

  // Selected JPL Horizons object — marker + sampled motion track.
  useEffect(() => {
    if (size.width === 0) return;
    const ctx = getCtx(horizonsCanvasRef.current);
    if (!ctx) return;
    renderHorizonsTarget(ctx, projection, selectedHorizonsTarget);
  }, [projection, selectedHorizonsTarget, size, getCtx]);

  // Mount reticles + manual target marker
  useEffect(() => {
    if (size.width === 0) return;
    const ctx = getCtx(pointingCanvasRef.current);
    if (!ctx) return;
    renderMountReticles(ctx, projection, mountPointings, manualTarget);
  }, [projection, mountPointings, manualTarget, size, getCtx]);

  return (
    <>
      {/* Sky background */}
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse at center, #0a0e1a 0%, #050810 50%, #000000 100%)",
        }}
      />

      {/* Canvas stack */}
      <div
        ref={containerRef}
        className="absolute inset-0 touch-none"
        style={{ cursor: "grab" }}
        onDoubleClick={handleDoubleClick}
      >
        <canvas ref={starCanvasRef} className="absolute inset-0 pointer-events-none" />
        <canvas ref={constellationCanvasRef} className="absolute inset-0 pointer-events-none" />
        <canvas ref={horizonCanvasRef} className="absolute inset-0 pointer-events-none" />
        <canvas ref={solarSystemCanvasRef} className="absolute inset-0 pointer-events-none" />
        <canvas ref={satelliteCanvasRef} className="absolute inset-0 pointer-events-none" />
        <canvas ref={horizonsCanvasRef} className="absolute inset-0 pointer-events-none" />
        <canvas ref={pointingCanvasRef} className="absolute inset-0 pointer-events-none" />
        <InteractionLayer
          positions={filteredPositions}
          projection={projection}
          catalog={catalog}
          width={size.width}
          height={size.height}
          onMouseMove={handleMouseMove}
        />
      </div>
    </>
  );
}
