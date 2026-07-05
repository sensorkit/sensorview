import type { GeoProjection } from "d3-geo";
import { celestialToScreen } from "../projection";
import { lstDegrees } from "../hooks/useObserver";
import type { ObserverLocation } from "../hooks/useObserver";

const HORIZON_LINE_COLOR = "#2a5a2a";
const HORIZON_LINE_WIDTH = 1.5;
const CARDINAL_COLOR = "#3a7a3a";
const HORIZON_POINTS = 180;

/**
 * Render the horizon circle and cardinal direction markers.
 * Points below the horizon get a subtle dark green tint.
 */
export function renderHorizon(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  projection: GeoProjection,
  observer: ObserverLocation,
  now: Date,
): void {
  ctx.clearRect(0, 0, width, height);

  const lst = lstDegrees(now, observer.lon);
  const latRad = (observer.lat * Math.PI) / 180;

  // Compute horizon circle points (alt=0 ring in RA/Dec)
  // For each azimuth, convert (az, alt=0) to RA/Dec
  const horizonPoints: [number, number][] = [];

  for (let i = 0; i <= HORIZON_POINTS; i++) {
    const az = (i / HORIZON_POINTS) * 360;
    const azRad = (az * Math.PI) / 180;

    // Convert (az, alt=0) to (RA, Dec)
    // At alt=0: dec = arcsin(cos(az) * cos(lat)), ha = atan2(-sin(az), -cos(az)*sin(lat))
    // Simplified horizon dec/ha formulas
    const sinDec = Math.cos(azRad) * Math.cos(latRad);
    // Clamp for numerical safety
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec))) * (180 / Math.PI);

    const cosHA =
      -Math.cos(azRad) * Math.sin(latRad) /
      Math.max(0.001, Math.cos(dec * Math.PI / 180));
    const sinHA = -Math.sin(azRad) / Math.max(0.001, Math.cos(dec * Math.PI / 180));
    const ha = Math.atan2(sinHA, Math.max(-1, Math.min(1, cosHA))) * (180 / Math.PI);

    const ra = ((lst - ha) % 360 + 360) % 360;
    horizonPoints.push([ra, dec]);
  }

  // Draw the horizon as a filled region below (dark tint) + line
  // First, draw the horizon line
  ctx.beginPath();
  ctx.strokeStyle = HORIZON_LINE_COLOR;
  ctx.lineWidth = HORIZON_LINE_WIDTH;
  ctx.setLineDash([6, 4]);

  let started = false;
  for (const [ra, dec] of horizonPoints) {
    const pos = celestialToScreen(projection, ra, dec);
    if (!pos) {
      started = false;
      continue;
    }
    if (!started) {
      ctx.moveTo(pos[0], pos[1]);
      started = true;
    } else {
      ctx.lineTo(pos[0], pos[1]);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw cardinal direction labels
  const cardinals: [string, number][] = [
    ["N", 0],
    ["E", 90],
    ["S", 180],
    ["W", 270],
  ];

  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const [label, az] of cardinals) {
    const azRad = (az * Math.PI) / 180;
    // Alt just slightly above horizon for label placement
    const altLabel = 2;
    const altRad = (altLabel * Math.PI) / 180;

    const sinDec =
      Math.sin(altRad) * Math.sin(latRad) +
      Math.cos(altRad) * Math.cos(latRad) * Math.cos(azRad);
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec))) * (180 / Math.PI);

    const cosHA =
      (Math.sin(altRad) - Math.sin(latRad) * Math.sin(dec * Math.PI / 180)) /
      (Math.cos(latRad) * Math.cos(dec * Math.PI / 180));
    const sinHA = (-Math.sin(azRad) * Math.cos(altRad)) / Math.cos(dec * Math.PI / 180);
    const ha = Math.atan2(sinHA, Math.max(-1, Math.min(1, cosHA))) * (180 / Math.PI);
    const ra = ((lst - ha) % 360 + 360) % 360;

    const pos = celestialToScreen(projection, ra, dec);
    if (!pos) continue;

    ctx.fillStyle = CARDINAL_COLOR;
    ctx.fillText(label, pos[0], pos[1]);
  }
}
