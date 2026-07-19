import { useEffect, useRef, useCallback, useMemo } from "react";
import { createGroundTrackProjection, geoToScreen } from "../projection";
import { createPinchTracker } from "./pinchZoom";
import { renderGroundTrackMap } from "../layers/GroundTrackMapLayer";
import { renderGroundTrackSatellites } from "../layers/GroundTrackSatelliteLayer";
import { renderMountReticlesGroundTrack } from "../layers/MountReticleLayer";
import { useMountPointings } from "../../../lib/sensorkit-client/instruments";
import { useGroundTrack } from "../hooks/useGroundTrack";
import { useSkyViewStore } from "../../../stores/skyview";
import { useSatelliteStore } from "../../../stores/satellites";
import type { SatellitePosition } from "../../../stores/satellites";
import type { ObserverLocation } from "../hooks/useObserver";
import { quadtree, type Quadtree } from "d3-quadtree";

type SatNode = { x: number; y: number; id: string };
const HIT_RADIUS_GT = 14;

interface GroundTrackCanvasProps {
  size: { width: number; height: number };
  observer: ObserverLocation;
  positions: SatellitePosition[];
  landGeoJSON: GeoJSON.FeatureCollection | null;
  disableInteraction?: boolean;
}

export function GroundTrackCanvas({ size, observer, positions, landGeoJSON, disableInteraction }: GroundTrackCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const satelliteCanvasRef = useRef<HTMLCanvasElement>(null);
  const pointingCanvasRef = useRef<HTMLCanvasElement>(null);

  const {
    groundTrackCenterLon, groundTrackCenterLat, groundTrackZoom,
    selectedSatelliteId,
    setGroundTrackCenter, setGroundTrackZoom,
  } = useSkyViewStore();

  const selectSatellite = useSkyViewStore((s) => s.selectSatellite);
  const tles = useSatelliteStore((s) => s.tles);
  const mountPointings = useMountPointings();

  const projection = useMemo(
    () => createGroundTrackProjection(
      size.width, size.height,
      groundTrackCenterLon, groundTrackCenterLat, groundTrackZoom,
    ),
    [size.width, size.height, groundTrackCenterLon, groundTrackCenterLat, groundTrackZoom],
  );

  // Ground track for selected satellite
  const groundTrack = useGroundTrack(selectedSatelliteId);

  // Set up canvas dimensions
  useEffect(() => {
    if (size.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const canvases = [mapCanvasRef, satelliteCanvasRef, pointingCanvasRef];
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

  // Quadtree of on-screen sat positions for hover + click hit-test.
  const satQuadtree = useMemo<Quadtree<SatNode>>(() => {
    const items: SatNode[] = [];
    for (const pos of positions) {
      if (pos.lat == null || pos.lon == null) continue;
      const pt = geoToScreen(projection, pos.lon, pos.lat);
      if (!pt) continue;
      items.push({ x: pt[0], y: pt[1], id: pos.noradId });
    }
    return quadtree<SatNode>().x((d) => d.x).y((d) => d.y).addAll(items);
  }, [positions, projection]);

  // Expose live values to the interaction listeners via a ref. Keeps the
  // listener effect's deps stable — otherwise re-attaching listeners mid-drag
  // (which happens 10×/sec when the positions-driven quadtree rebuilds) would
  // reset the drag closure state and the gesture would stutter to a stop.
  const liveRef = useRef({ satQuadtree, groundTrackCenterLon, groundTrackCenterLat, groundTrackZoom });
  liveRef.current = { satQuadtree, groundTrackCenterLon, groundTrackCenterLat, groundTrackZoom };

  // Wheel zoom + drag pan + click detection
  useEffect(() => {
    const container = containerRef.current;
    if (disableInteraction) return;
    if (!container || size.width === 0) return;

    let dragging = false;
    let didDrag = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let dragLon = 0;
    let dragLat = 0;
    const CLICK_THRESHOLD = 5;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const next = Math.max(0.5, Math.min(20, liveRef.current.groundTrackZoom * factor));
      setGroundTrackZoom(next);
    };

    // touch-none suppresses native pinch, so two-finger zoom is ours to run.
    const pinch = createPinchTracker({
      getZoom: () => liveRef.current.groundTrackZoom,
      setZoom: setGroundTrackZoom,
      min: 0.5,
      max: 20,
    });

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pinch.down(e);
      if (pinch.pinching) {
        // Second finger: the gesture is a pinch — cancel the in-flight pan.
        dragging = false;
        didDrag = false;
        return;
      }
      dragging = true;
      didDrag = false;
      startX = e.clientX;
      startY = e.clientY;
      lastX = e.clientX;
      lastY = e.clientY;
      dragLon = liveRef.current.groundTrackCenterLon;
      dragLat = liveRef.current.groundTrackCenterLat;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pinch.move(e)) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (!dragging) {
        const nearest = liveRef.current.satQuadtree.find(x, y, HIT_RADIUS_GT);
        container.style.cursor = nearest ? "crosshair" : "grab";
        return;
      }
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      const totalDx = e.clientX - startX;
      const totalDy = e.clientY - startY;
      if (!didDrag && totalDx * totalDx + totalDy * totalDy > CLICK_THRESHOLD * CLICK_THRESHOLD) {
        didDrag = true;
        container.style.cursor = "grabbing";
      }

      if (didDrag) {
        const degreesPerPixel = 180 / (Math.min(size.width, size.height) * liveRef.current.groundTrackZoom);
        dragLon = ((dragLon - dx * degreesPerPixel) % 360 + 540) % 360 - 180;
        dragLat = Math.max(-90, Math.min(90, dragLat + dy * degreesPerPixel));
        setGroundTrackCenter(dragLon, dragLat);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (pinch.up(e)) {
        // This pointer was part of a pinch — never a click.
        dragging = false;
        didDrag = false;
        return;
      }
      const wasDrag = didDrag;
      dragging = false;
      didDrag = false;
      container.style.cursor = "grab";
      if (!wasDrag) {
        // Click — pick nearest sat
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const nearest = liveRef.current.satQuadtree.find(x, y, HIT_RADIUS_GT);
        selectSatellite(nearest?.id ?? null);
      }
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
  }, [size.width, size.height, disableInteraction, setGroundTrackCenter, setGroundTrackZoom, selectSatellite]);

  // === RENDER LAYERS ===

  useEffect(() => {
    if (size.width === 0) return;
    const ctx = getCtx(mapCanvasRef.current);
    if (!ctx) return;
    renderGroundTrackMap(ctx, size.width, size.height, projection, observer, landGeoJSON);
  }, [projection, observer, size, getCtx, landGeoJSON]);

  useEffect(() => {
    if (size.width === 0) return;
    const ctx = getCtx(satelliteCanvasRef.current);
    if (!ctx) return;
    renderGroundTrackSatellites(
      ctx, size.width, size.height,
      positions, tles, projection, selectedSatelliteId, groundTrack,
    );
  }, [positions, tles, projection, selectedSatelliteId, groundTrack, size, getCtx]);

  // Mount pointing arrows
  useEffect(() => {
    if (size.width === 0) return;
    const ctx = getCtx(pointingCanvasRef.current);
    if (!ctx) return;
    renderMountReticlesGroundTrack(
      ctx, size.width, size.height, projection, observer, mountPointings,
    );
  }, [projection, observer, mountPointings, size, getCtx]);

  return (
    <>
      <div
        className="absolute inset-0"
        style={{ background: "#000000" }}
      />
      <div ref={containerRef} className="absolute inset-0 touch-none" style={{ cursor: "grab" }}>
        <canvas ref={mapCanvasRef} className="absolute inset-0 pointer-events-none" />
        <canvas ref={satelliteCanvasRef} className="absolute inset-0 pointer-events-none" />
        <canvas ref={pointingCanvasRef} className="absolute inset-0 pointer-events-none" />
      </div>
    </>
  );
}
