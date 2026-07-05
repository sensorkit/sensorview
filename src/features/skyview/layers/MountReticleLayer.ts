import type { GeoProjection } from "d3-geo";
import {
  rayEndpoint,
  type InstrumentPointing,
} from "../../../lib/sensorkit-client/instruments";
import { celestialToScreen, geoToScreen } from "../projection";
import { makeObserver3D, overheadScale, project3D } from "../projection3d";
import { regimeColor } from "./regimeColors";
import type { ObserverLocation } from "../hooks/useObserver";

/**
 * Fully clear a canvas in raw device-pixel coordinates, regardless of any
 * transform currently applied. Prevents trails when the caller's transform
 * leaves clearRect covering less than the canvas bounds.
 */
function clearFully(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

/**
 * Orbit-regime markers along the sight-line. Each band ends at `rangeKm`; a
 * regime-colored ring is drawn there whose radius corresponds to a real cone
 * cross-section — i.e. `rangeKm * tan(half_angle) * screen_scale`. Until
 * per-instrument FOV metadata arrives, a nominal half-angle is used; swapping
 * in a real FOV replaces only the constant.
 */
const REGIME_BANDS = [
  { regime: "LEO", rangeKm: 2000 },
  { regime: "MEO", rangeKm: 20000 },
  { regime: "GEO", rangeKm: 42000 },
] as const;

/** Nominal full FOV (degrees). Placeholder for real instrument FOV. */
const NOMINAL_FOV_DEG = 0.5;
const TAN_NOMINAL_HALF = Math.tan(((NOMINAL_FOV_DEG / 2) * Math.PI) / 180);
const MIN_RING_PX = 1.5;

/**
 * Palette for distinguishing multiple mounts. Cycles if there are more
 * instruments than colors.
 */
const MOUNT_COLORS = [
  "#4da3ff", // blue
  "#ffb347", // orange
  "#77dd77", // green
  "#ff6b9d", // pink
  "#c792ea", // purple
  "#ffd866", // yellow
];

export function mountColor(index: number): string {
  return MOUNT_COLORS[index % MOUNT_COLORS.length]!;
}

const MANUAL_COLOR = "#ffffff";

/** Render a labeled reticle for each mount + an optional manual target marker. */
export function renderMountReticles(
  ctx: CanvasRenderingContext2D,
  projection: GeoProjection,
  pointings: InstrumentPointing[],
  manualTarget: { ra: number; dec: number } | null,
): void {
  clearFully(ctx);

  pointings.forEach((p, i) => {
    if (!p.radec) return;
    const screen = celestialToScreen(projection, p.radec.ra, p.radec.dec);
    if (!screen) return;
    drawReticle(ctx, screen[0], screen[1], mountColor(i), p.mountId);
  });

  if (manualTarget) {
    const screen = celestialToScreen(projection, manualTarget.ra, manualTarget.dec);
    if (screen) drawManualMarker(ctx, screen[0], screen[1], MANUAL_COLOR);
  }
}

function drawReticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  label: string,
): void {
  const arm = 18;
  const gap = 6;
  const ring = 9;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);

  // Crosshair arms (gap in the center)
  ctx.beginPath();
  ctx.moveTo(x - arm, y);
  ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y);
  ctx.lineTo(x + arm, y);
  ctx.moveTo(x, y - arm);
  ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap);
  ctx.lineTo(x, y + arm);
  ctx.stroke();

  // Center ring
  ctx.beginPath();
  ctx.arc(x, y, ring, 0, Math.PI * 2);
  ctx.stroke();

  // Label
  ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText(label, x + arm + 2, y + 2);
}

/**
 * Render mount pointings on the Overhead (3D-from-above-observer) view as a
 * regime-banded sight-line. When a pointing has a commanded target, an
 * additional reticle is placed on the sight-line at the target's actual range.
 */
export function renderMountReticlesOverhead(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  projection: GeoProjection,
  observer: ObserverLocation,
  pointings: InstrumentPointing[],
  // View center — the pan/rotation applied by the user. When absent the
  // 3D projection degenerates to an observer-centered view, which is fine
  // for the no-pan default.
  viewCenter?: { lat: number; lon: number },
): void {
  clearFully(ctx);

  const earthScreenR = projection.scale();
  // The 3D viewpoint must match the d3-geo projection's rotation, otherwise
  // mount-line endpoints float away from the observer marker when the user
  // rotates the globe.
  const obs3d = makeObserver3D(viewCenter?.lat ?? observer.lat, viewCenter?.lon ?? observer.lon);
  const s3d = overheadScale(earthScreenR);
  const cx = width / 2;
  const cy = height / 2;

  // Ring radius = physical cross-section radius × overhead's km→px scale.
  // Linear in range, so LEO:MEO:GEO reads as a true cone silhouette.
  const ringRadii = REGIME_BANDS.map((b) =>
    Math.max(MIN_RING_PX, b.rangeKm * TAN_NOMINAL_HALF * s3d),
  );

  pointings.forEach((p, i) => {
    if (!p.altaz || p.altaz.alt < -5) return;
    const start = project3D(observer.lat, observer.lon, 0, obs3d, s3d, cx, cy);
    if (!start) return;
    const bandPoints = REGIME_BANDS.map((b) => {
      const end = rayEndpoint(observer, p.altaz!.alt, p.altaz!.az, b.rangeKm);
      return project3D(end.lat, end.lon, end.altKm, obs3d, s3d, cx, cy);
    });
    const targetPt = p.target
      ? (() => {
          const end = rayEndpoint(observer, p.altaz!.alt, p.altaz!.az, p.target!.rangeKm);
          return project3D(end.lat, end.lon, end.altKm, obs3d, s3d, cx, cy);
        })()
      : null;
    drawBandedRay(ctx, start, bandPoints, ringRadii, mountColor(i), p.mountId, targetPt, p.target);
  });
}

/**
 * Render mount pointings on the Ground Track (flat equirectangular) view as a
 * regime-banded arrow on the ground. Each slice shows where on the ground a
 * LEO / MEO / GEO target along this sight-line would project.
 */
/**
 * Render mount pointings on the Ground Track (flat equirectangular) view.
 * The flat map doesn't preserve great circles, so the LEO/MEO/GEO cone reads
 * as three scattered points — not useful. Instead, draw a short fixed-length
 * compass arrow at the observer showing the mount's azimuth, plus a target
 * reticle at the tracked target's sub-point (the sat's position on the map).
 */
export function renderMountReticlesGroundTrack(
  ctx: CanvasRenderingContext2D,
  _width: number,
  _height: number,
  projection: GeoProjection,
  observer: ObserverLocation,
  pointings: InstrumentPointing[],
): void {
  clearFully(ctx);

  const origin = geoToScreen(projection, observer.lon, observer.lat);
  if (!origin) return;

  const ARROW_PX = 40;

  pointings.forEach((p, i) => {
    if (!p.altaz) return;
    const accent = mountColor(i);

    // Local compass direction: project a near-observer ray point, normalize to
    // fixed screen length so the arrow reads consistently at any zoom.
    const near = rayEndpoint(observer, p.altaz.alt, p.altaz.az, 100);
    const nearPt = geoToScreen(projection, near.lon, near.lat);

    let tip: [number, number] | null = null;
    if (nearPt) {
      const dx = nearPt[0] - origin[0];
      const dy = nearPt[1] - origin[1];
      const len = Math.hypot(dx, dy);
      if (len > 0.1) {
        tip = [origin[0] + (dx / len) * ARROW_PX, origin[1] + (dy / len) * ARROW_PX];
      }
    }

    // Compass arrow at observer
    if (tip) {
      drawCompassArrow(ctx, origin, tip, accent);
    } else {
      // Very near zenith from observer — draw a small ring at observer
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(origin[0], origin[1], 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Target reticle at the tracked sub-point, when tracking a satellite
    let targetPt: [number, number] | null = null;
    if (p.target) {
      const end = rayEndpoint(observer, p.altaz.alt, p.altaz.az, p.target.rangeKm);
      targetPt = geoToScreen(projection, end.lon, end.lat);
      if (targetPt) {
        drawTargetReticle(ctx, targetPt[0], targetPt[1], regimeColor(p.target.regime), accent);
      }
    }

    // Label: next to the target when tracking, otherwise next to the arrow tip
    const anchor = targetPt ?? tip ?? origin;
    ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
    ctx.fillStyle = accent;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(p.mountId, anchor[0] + 10, anchor[1] + 4);
  });
}

function drawCompassArrow(
  ctx: CanvasRenderingContext2D,
  tail: [number, number],
  tip: [number, number],
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);

  // Observer dot
  ctx.beginPath();
  ctx.arc(tail[0], tail[1], 3, 0, Math.PI * 2);
  ctx.fill();

  // Shaft
  ctx.beginPath();
  ctx.moveTo(tail[0], tail[1]);
  ctx.lineTo(tip[0], tip[1]);
  ctx.stroke();

  // Arrowhead
  const dx = tip[0] - tail[0];
  const dy = tip[1] - tail[1];
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const perpX = -uy;
  const perpY = ux;
  const back = 8;
  const side = 4;
  ctx.beginPath();
  ctx.moveTo(tip[0], tip[1]);
  ctx.lineTo(tip[0] - ux * back + perpX * side, tip[1] - uy * back + perpY * side);
  ctx.lineTo(tip[0] - ux * back - perpX * side, tip[1] - uy * back - perpY * side);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw a sight-line as a visual cone: a thin ray from the observer out to GEO,
 * with regime-colored rings at LEO / MEO / GEO. Ring sizes grow with range so
 * the three rings read as the silhouette of a cone opening away from observer.
 * `bandPoints[k]` is the screen position at the far end of band k.
 */
function drawBandedRay(
  ctx: CanvasRenderingContext2D,
  start: [number, number],
  bandPoints: ([number, number] | null)[],
  ringRadii: number[],
  accentColor: string,
  label: string,
  targetPt: [number, number] | null,
  trackedTarget: { rangeKm: number; regime: string | undefined } | null,
): void {
  ctx.setLineDash([]);

  // Outermost visible scale-ring position (fallback anchor when no target)
  let outermost: [number, number] = start;
  let outermostBandIdx = -1;
  for (let k = REGIME_BANDS.length - 1; k >= 0; k--) {
    if (bandPoints[k]) {
      outermost = bandPoints[k]!;
      outermostBandIdx = k;
      break;
    }
  }

  // Translucent cone silhouette — joins the scale rings into one visual shape
  drawConeSilhouette(ctx, start, bandPoints, ringRadii, accentColor);

  // Thin spine — extend through the target when one exists, otherwise to the
  // outermost scale ring. Dims when a target is present so the target stands out.
  const spineEnd = targetPt ?? (outermostBandIdx >= 0 ? outermost : null);
  if (spineEnd) {
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.lineTo(spineEnd[0], spineEnd[1]);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Origin marker at observer
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.arc(start[0], start[1], 3, 0, Math.PI * 2);
  ctx.fill();

  // Primary reticle + label — at the tracked target's distance when available,
  // otherwise at the outermost visible scale ring
  if (targetPt && trackedTarget) {
    const targetColor = regimeColor(trackedTarget.regime);
    drawTargetReticle(ctx, targetPt[0], targetPt[1], targetColor, accentColor);
    ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
    ctx.fillStyle = accentColor;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(label, targetPt[0] + 12, targetPt[1] + 4);
  } else if (outermostBandIdx >= 0) {
    const offset = ringRadii[outermostBandIdx]! + 4;
    ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
    ctx.fillStyle = accentColor;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(label, outermost[0] + offset, outermost[1] + 4);
  }
}

/**
 * Fill a translucent cone silhouette that wraps observer → LEO → MEO → GEO
 * rings. Perpendicular at each ring is computed locally so the silhouette
 * tracks the projection's curvature (rays aren't straight on the overhead view).
 */
function drawConeSilhouette(
  ctx: CanvasRenderingContext2D,
  start: [number, number],
  bandPoints: ([number, number] | null)[],
  ringRadii: number[],
  color: string,
): void {
  const pts: [number, number][] = [start];
  const radii: number[] = [0];
  for (let k = 0; k < REGIME_BANDS.length; k++) {
    const p = bandPoints[k];
    if (!p) break;
    pts.push(p);
    radii.push(ringRadii[k]!);
  }
  if (pts.length < 2) return;

  const leftSide: [number, number][] = [];
  const rightSide: [number, number][] = [];

  for (let i = 0; i < pts.length; i++) {
    let dx: number;
    let dy: number;
    if (i === 0) {
      dx = pts[1]![0] - pts[0]![0];
      dy = pts[1]![1] - pts[0]![1];
    } else if (i === pts.length - 1) {
      dx = pts[i]![0] - pts[i - 1]![0];
      dy = pts[i]![1] - pts[i - 1]![1];
    } else {
      // Average incoming + outgoing direction so kinks are smooth
      dx = (pts[i + 1]![0] - pts[i - 1]![0]) / 2;
      dy = (pts[i + 1]![1] - pts[i - 1]![1]) / 2;
    }
    const len = Math.hypot(dx, dy) || 1;
    const perpX = -dy / len;
    const perpY = dx / len;
    const r = radii[i]!;
    leftSide.push([pts[i]![0] + perpX * r, pts[i]![1] + perpY * r]);
    rightSide.push([pts[i]![0] - perpX * r, pts[i]![1] - perpY * r]);
  }

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.08;
  ctx.beginPath();
  ctx.moveTo(leftSide[0]![0], leftSide[0]![1]);
  for (let i = 1; i < leftSide.length; i++) {
    ctx.lineTo(leftSide[i]![0], leftSide[i]![1]);
  }
  for (let i = rightSide.length - 1; i >= 0; i--) {
    ctx.lineTo(rightSide[i]![0], rightSide[i]![1]);
  }
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawTargetReticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  regimeC: string,
  accent: string,
): void {
  // Regime-colored filled dot + accent crosshair arms
  ctx.fillStyle = regimeC;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x - 11, y); ctx.lineTo(x - 5, y);
  ctx.moveTo(x + 5, y);  ctx.lineTo(x + 11, y);
  ctx.moveTo(x, y - 11); ctx.lineTo(x, y - 5);
  ctx.moveTo(x, y + 5);  ctx.lineTo(x, y + 11);
  ctx.stroke();
}

function drawManualMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  const arm = 8;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x - arm, y);
  ctx.lineTo(x + arm, y);
  ctx.moveTo(x, y - arm);
  ctx.lineTo(x, y + arm);
  ctx.stroke();

  ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText("target", x + arm + 2, y + 2);
}
