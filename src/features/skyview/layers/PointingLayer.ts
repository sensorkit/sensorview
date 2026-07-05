import type { GeoProjection } from "d3-geo";
import { celestialToScreen } from "../projection";

export interface RADecPointing {
  ra: number;
  dec: number;
}

export interface CameraFOV {
  widthDeg: number;
  heightDeg: number;
  rotationDeg: number;
}

const RETICLE_COLOR = "#4488ff";
const FOV_COLOR = "#4488ff44";
const FOV_BORDER = "#4488ff88";

/**
 * Render mount pointing reticle and camera FOV rectangle.
 * Updates when new state arrives from SensorKit (1-10 Hz).
 */
export function renderPointing(
  ctx: CanvasRenderingContext2D,
  projection: GeoProjection,
  pointing: RADecPointing | null,
  fov: CameraFOV | null,
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  if (!pointing) return;

  const center = celestialToScreen(projection, pointing.ra, pointing.dec);
  if (!center) return;

  const [cx, cy] = center;

  // Draw crosshair reticle
  drawReticle(ctx, cx, cy);

  // Draw camera FOV rectangle
  if (fov) {
    drawFOVRect(ctx, projection, pointing, fov);
  }
}

function drawReticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
): void {
  const size = 20;
  const gap = 6;

  ctx.strokeStyle = RETICLE_COLOR;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);

  // Horizontal lines
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y);
  ctx.lineTo(x + size, y);

  // Vertical lines
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap);
  ctx.lineTo(x, y + size);

  ctx.stroke();

  // Small center dot
  ctx.beginPath();
  ctx.arc(x, y, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = RETICLE_COLOR;
  ctx.fill();
}

function drawFOVRect(
  ctx: CanvasRenderingContext2D,
  projection: GeoProjection,
  pointing: RADecPointing,
  fov: CameraFOV,
): void {
  const hw = fov.widthDeg / 2;
  const hh = fov.heightDeg / 2;
  const cosRot = Math.cos((fov.rotationDeg * Math.PI) / 180);
  const sinRot = Math.sin((fov.rotationDeg * Math.PI) / 180);
  const cosDec = Math.cos((pointing.dec * Math.PI) / 180);

  // Compute 4 corners of the FOV rectangle in RA/Dec
  const corners: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([dra, ddec]) => {
    const rotRA = (dra! * cosRot - ddec! * sinRot) / Math.max(cosDec, 0.01);
    const rotDec = dra! * sinRot + ddec! * cosRot;
    return [pointing.ra + rotRA, pointing.dec + rotDec];
  });

  // Project corners to screen
  const screenCorners = corners
    .map(([ra, dec]) => celestialToScreen(projection, ra, dec))
    .filter((p): p is [number, number] => p !== null);

  if (screenCorners.length < 4) return;

  // Draw filled rectangle
  ctx.beginPath();
  ctx.moveTo(screenCorners[0]![0], screenCorners[0]![1]);
  for (let i = 1; i < screenCorners.length; i++) {
    ctx.lineTo(screenCorners[i]![0], screenCorners[i]![1]);
  }
  ctx.closePath();
  ctx.fillStyle = FOV_COLOR;
  ctx.fill();
  ctx.strokeStyle = FOV_BORDER;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}
