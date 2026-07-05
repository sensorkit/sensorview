import type { GeoProjection } from "d3-geo";
import {
  type StarCatalog,
  getStarColor,
  starRadius,
  shouldGlow,
  glowSize,
} from "../catalog/stars";
import { celestialToScreen } from "../projection";

/**
 * Render the star field onto a canvas.
 * Only redraws when projection/zoom changes (not every frame).
 */
export function renderStarField(
  ctx: CanvasRenderingContext2D,
  catalog: StarCatalog,
  projection: GeoProjection,
  zoom: number,
  limitingMagnitude: number,
  dimmed = false,
): void {
  const w = ctx.canvas.width / (window.devicePixelRatio || 1);
  const h = ctx.canvas.height / (window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, w, h);

  let drawn = 0;

  for (const star of catalog.stars) {
    // StarRecord = [id, ra_deg, dec_deg, mag, spectral_class | null]
    const [, ra, dec, mag, spec] = star;

    // Stars are sorted by magnitude — stop at limiting mag
    if (mag > limitingMagnitude) break;

    const pos = celestialToScreen(projection, ra, dec);
    if (!pos) continue;

    const [x, y] = pos;

    // Skip if off-screen
    if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;

    const radius = starRadius(mag, zoom);
    const color = dimmed ? "#666666" : getStarColor(spec);

    // Draw glow for bright stars (reduced when dimmed)
    if (shouldGlow(mag) && !dimmed) {
      const glowR = radius * glowSize(mag);
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, glowR);
      gradient.addColorStop(0, color + "70");
      gradient.addColorStop(0.4, color + "30");
      gradient.addColorStop(1, color + "00");

      ctx.beginPath();
      ctx.arc(x, y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    // Draw star dot
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = dimmed ? 0.6 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    drawn++;
  }

  // Debug overlay (remove later)
  ctx.fillStyle = "#ffffff33";
  ctx.font = "10px monospace";
  ctx.fillText(`stars: ${drawn}/${catalog.stars.length} | canvas: ${w.toFixed(0)}x${h.toFixed(0)}`, 4, h - 4);
}
