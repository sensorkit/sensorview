import { useEffect, useRef, useCallback, useMemo } from "react";
import { createOverheadProjection } from "../projection";
import { createPinchTracker } from "./pinchZoom";
import { project3D, makeObserver3D, overheadScale } from "../projection3d";
import { renderOverheadGrid } from "../layers/OverheadGridLayer";
import { renderOverheadSatellites } from "../layers/OverheadSatelliteLayer";
import { renderMountReticlesOverhead } from "../layers/MountReticleLayer";
import { useMountPointings } from "../../../lib/sensorkit-client/instruments";
import { useGroundTrack } from "../hooks/useGroundTrack";
import { useSkyViewStore } from "../../../stores/skyview";
import { useSatelliteStore } from "../../../stores/satellites";
import type { SatellitePosition } from "../../../stores/satellites";
import type { ObserverLocation } from "../hooks/useObserver";
import { quadtree, type Quadtree } from "d3-quadtree";

interface OverheadCanvasProps {
  size: { width: number; height: number };
  observer: ObserverLocation;
  positions: SatellitePosition[];
  landGeoJSON: GeoJSON.FeatureCollection | null;
  clipAngleOverride?: number;
  disableInteraction?: boolean;
}

type SatNode = { x: number; y: number; id: string };

const HIT_RADIUS = 14;
const DRAG_THRESHOLD_PX_SQ = 25;

export function OverheadCanvas({ size, observer, positions, landGeoJSON, clipAngleOverride, disableInteraction }: OverheadCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  const satelliteCanvasRef = useRef<HTMLCanvasElement>(null);
  const pointingCanvasRef = useRef<HTMLCanvasElement>(null);

  const { overheadZoom, overheadCenter, selectedSatelliteId, setOverheadZoom, setOverheadCenter } = useSkyViewStore();
  const selectSatellite = useSkyViewStore((s) => s.selectSatellite);
  const tles = useSatelliteStore((s) => s.tles);
  const mountPointings = useMountPointings();

  // Effective view center — the user's pan if set, else the observer's site.
  // Both the d3-geo projection AND the 3D satellite viewpoint follow this
  // so the whole scene rotates together when dragging.
  const centerLat = overheadCenter?.lat ?? observer.lat;
  const centerLon = overheadCenter?.lon ?? observer.lon;

  const projection = useMemo(
    () => createOverheadProjection(size.width, size.height, centerLat, centerLon, overheadZoom, clipAngleOverride),
    [size.width, size.height, centerLat, centerLon, overheadZoom, clipAngleOverride],
  );

  const groundTrack = useGroundTrack(selectedSatelliteId);

  // Set up canvas dimensions
  useEffect(() => {
    if (size.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const canvases = [gridCanvasRef, satelliteCanvasRef, pointingCanvasRef];
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

  // Quadtree of on-screen satellite positions. Rebuilt whenever anything that
  // can move a sat on screen changes. Reused for both hover cursor and click
  // hit-test.
  const satQuadtree = useMemo<Quadtree<SatNode>>(() => {
    const earthScreenR = projection.scale();
    const obs3d = makeObserver3D(centerLat, centerLon);
    const s3d = overheadScale(earthScreenR);
    const cx = size.width / 2;
    const cy = size.height / 2;
    const items: SatNode[] = [];
    for (const pos of positions) {
      if (pos.lat == null || pos.lon == null) continue;
      const pt = project3D(pos.lat, pos.lon, pos.satAlt ?? 0, obs3d, s3d, cx, cy);
      if (!pt) continue;
      items.push({ x: pt[0], y: pt[1], id: pos.noradId });
    }
    return quadtree<SatNode>().x((d) => d.x).y((d) => d.y).addAll(items);
  }, [positions, projection, centerLat, centerLon, size.width, size.height]);

  // Live values exposed to the interaction listeners via refs. We can't put
  // these in the listener effect's deps — projection and center change on
  // every drag frame, and re-attaching listeners mid-gesture tears down the
  // closure-local drag state (startX, dragging, etc.) so only the first
  // pixel of each drag would actually apply. Listeners attach once per
  // resize/mount and read the refs live.
  const liveRef = useRef({ projection, centerLat, centerLon, satQuadtree, overheadZoom });
  liveRef.current = { projection, centerLat, centerLon, satQuadtree, overheadZoom };

  // Wheel zoom + drag-to-rotate + click-to-select
  useEffect(() => {
    if (disableInteraction) return;
    const container = containerRef.current;
    if (!container || size.width === 0) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const next = Math.max(0.08, Math.min(20, liveRef.current.overheadZoom * factor));
      setOverheadZoom(next);
    };

    // touch-none suppresses native pinch, so two-finger zoom is ours to run.
    const pinch = createPinchTracker({
      getZoom: () => liveRef.current.overheadZoom,
      setZoom: setOverheadZoom,
      min: 0.08,
      max: 20,
    });

    let startX = 0, startY = 0;
    let startCenterLon = 0, startCenterLat = 0;
    let dragging = false;
    let didDrag = false;
    let pointerId: number | null = null;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pinch.down(e);
      if (pinch.pinching) {
        // Second finger: the gesture is a pinch — cancel the in-flight pan.
        dragging = false;
        didDrag = false;
        return;
      }
      startX = e.clientX;
      startY = e.clientY;
      startCenterLon = liveRef.current.centerLon;
      startCenterLat = liveRef.current.centerLat;
      dragging = true;
      didDrag = false;
      pointerId = e.pointerId;
      try { container.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pinch.move(e)) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (dragging) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!didDrag && dx * dx + dy * dy > DRAG_THRESHOLD_PX_SQ) {
          didDrag = true;
          container.style.cursor = "grabbing";
        }
        if (didDrag) {
          // Orthographic scale is the earth-disk radius in pixels. Near the
          // center the tangent-plane sensitivity is 1 px = 1/scale rad =
          // 180/(π·scale) deg. We multiply by π/2 so dragging feels roughly
          // the same as the previous azeq projection did.
          const degPerPx = 90 / liveRef.current.projection.scale();
          const newLon = startCenterLon - dx * degPerPx / Math.max(0.2, Math.cos(startCenterLat * Math.PI / 180));
          const newLat = Math.max(-89, Math.min(89, startCenterLat + dy * degPerPx));
          const wrappedLon = ((newLon + 540) % 360) - 180;
          setOverheadCenter({ lon: wrappedLon, lat: newLat });
        }
        return;
      }

      // Not dragging — hover detection for cursor feedback.
      const nearest = liveRef.current.satQuadtree.find(x, y, HIT_RADIUS);
      container.style.cursor = nearest ? "crosshair" : "grab";
    };

    const onPointerUp = (e: PointerEvent) => {
      if (pointerId != null) {
        try { container.releasePointerCapture(pointerId); } catch { /* ignore */ }
        pointerId = null;
      }
      if (pinch.up(e)) {
        // This pointer was part of a pinch — never a click.
        dragging = false;
        didDrag = false;
        return;
      }
      const wasDragging = didDrag;
      dragging = false;
      didDrag = false;
      container.style.cursor = "grab";
      if (wasDragging) return;
      // Click — pick nearest sat
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const nearest = liveRef.current.satQuadtree.find(x, y, HIT_RADIUS);
      selectSatellite(nearest?.id ?? null);
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);

    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
    };
  }, [size.width, size.height, disableInteraction, setOverheadCenter, setOverheadZoom, selectSatellite]);

  // === RENDER LAYERS ===

  // Grid — also rAF-throttled now so drag-to-rotate doesn't stack clips of the
  // 110m land polygons (d3-geo's clipAngle(90) resampling is the main cost).
  const gridStateRef = useRef({ projection, observer, landGeoJSON });
  gridStateRef.current = { projection, observer, landGeoJSON };
  const gridDirtyRef = useRef(true);
  useEffect(() => { gridDirtyRef.current = true; }, [projection, observer, landGeoJSON, size]);

  useEffect(() => {
    if (size.width === 0) return;
    let rafId = 0;
    const loop = () => {
      if (gridDirtyRef.current) {
        gridDirtyRef.current = false;
        const ctx = getCtx(gridCanvasRef.current);
        if (ctx) {
          const g = gridStateRef.current;
          renderOverheadGrid(ctx, size.width, size.height, g.projection, g.observer, g.landGeoJSON);
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [size, getCtx]);

  // Satellite layer — rAF loop reading from a ref. The propagator pushes
  // positions at 10 Hz; without decoupling from React we'd stack synchronous
  // canvas redraws faster than the main thread can finish them.
  const satStateRef = useRef({ positions, tles, projection, selectedSatelliteId, groundTrack, centerLat, centerLon });
  satStateRef.current = { positions, tles, projection, selectedSatelliteId, groundTrack, centerLat, centerLon };
  const satDirtyRef = useRef(true);
  useEffect(() => { satDirtyRef.current = true; }, [positions, tles, projection, selectedSatelliteId, groundTrack, centerLat, centerLon, size]);

  useEffect(() => {
    if (size.width === 0) return;
    let rafId = 0;
    const loop = () => {
      if (satDirtyRef.current) {
        satDirtyRef.current = false;
        const ctx = getCtx(satelliteCanvasRef.current);
        if (ctx) {
          const s = satStateRef.current;
          // Pass an observer-shaped object with the view center so project3D
          // sees the scene from the user's pan angle.
          const viewpoint: ObserverLocation = { lat: s.centerLat, lon: s.centerLon, alt: 0, name: "overhead-center" };
          renderOverheadSatellites(
            ctx, size.width, size.height,
            s.positions, s.tles, s.projection, s.selectedSatelliteId, s.groundTrack, viewpoint,
          );
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [size, getCtx]);

  // Mount pointing rays
  useEffect(() => {
    if (size.width === 0) return;
    const ctx = getCtx(pointingCanvasRef.current);
    if (!ctx) return;
    renderMountReticlesOverhead(
      ctx, size.width, size.height, projection, observer, mountPointings,
      { lat: centerLat, lon: centerLon },
    );
  }, [projection, observer, mountPointings, size, getCtx, centerLat, centerLon]);

  return (
    <>
      <div
        className="absolute inset-0"
        style={{ background: "#000000" }}
      />
      <div ref={containerRef} className="absolute inset-0 touch-none" style={{ cursor: "grab" }}>
        <canvas ref={gridCanvasRef} className="absolute inset-0 pointer-events-none" />
        <canvas ref={satelliteCanvasRef} className="absolute inset-0 pointer-events-none" />
        <canvas ref={pointingCanvasRef} className="absolute inset-0 pointer-events-none" />
      </div>
    </>
  );
}
