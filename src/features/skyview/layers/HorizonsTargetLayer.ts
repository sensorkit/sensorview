import type { GeoProjection } from "d3-geo";
import { celestialToScreen } from "../projection";

/**
 * Overlay for the operator-selected JPL Horizons object: its sampled forward
 * motion track (dashed polyline) plus a white circle marker + label at the
 * current position — matching the selected-solar-body highlight ring.
 */
export interface HorizonsRenderTarget {
  name: string;
  ra: number; // current RA/Dec, degrees (ICRF)
  dec: number;
  track: { ra: number; dec: number }[]; // sampled forward path
}

export function renderHorizonsTarget(
  ctx: CanvasRenderingContext2D,
  projection: GeoProjection,
  target: HorizonsRenderTarget | null,
): void {
  // Clear in raw device pixels so the whole canvas is wiped regardless of the
  // current transform (matches SolarSystemLayer).
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();

  if (!target) return;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = ctx.canvas.width / dpr;

  // Motion track — dashed, semi-transparent. Skip segments that jump across a
  // projection discontinuity (clip edge / antimeridian).
  if (target.track.length > 1) {
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([4, 4]);
    let prev: [number, number] | null = null;
    for (const p of target.track) {
      const pos = celestialToScreen(projection, p.ra, p.dec);
      if (!pos) {
        prev = null;
        continue;
      }
      const [x, y] = pos;
      if (prev) {
        const dx = x - prev[0];
        const dy = y - prev[1];
        if (dx * dx + dy * dy < (cssWidth * 0.5) ** 2) {
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
      }
      prev = [x, y];
    }
    ctx.restore();
  }

  // Marker + label at the current position.
  const pt = celestialToScreen(projection, target.ra, target.dec);
  if (pt) {
    const [x, y] = pt;
    const r = 6;
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    // White circle — matches the selected-solar-body highlight ring.
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    // Center dot
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    // Label
    ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(target.name, x + r + 5, y);
    ctx.restore();
  }
}
