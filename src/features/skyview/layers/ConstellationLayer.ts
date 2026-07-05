import type { GeoProjection } from "d3-geo";
import type { Constellation } from "../catalog/constellations";
import { celestialToScreen } from "../projection";

const LINE_COLOR = "#334466";
const LINE_OPACITY = 0.4;
const LINE_WIDTH = 0.8;

/**
 * Render constellation stick-figure lines onto a canvas.
 * Same redraw strategy as star field — only when projection changes.
 */
export function renderConstellations(
  ctx: CanvasRenderingContext2D,
  constellations: Constellation[],
  projection: GeoProjection,
  _highlightId?: string | null,
): void {
  const w = ctx.canvas.width / (window.devicePixelRatio || 1);
  const h = ctx.canvas.height / (window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = LINE_COLOR;
  ctx.globalAlpha = LINE_OPACITY;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = "round";

  for (const constellation of constellations) {
    ctx.beginPath();

    for (const [ra1, dec1, ra2, dec2] of constellation.lines) {
      const p1 = celestialToScreen(projection, ra1, dec1);
      const p2 = celestialToScreen(projection, ra2, dec2);

      if (!p1 || !p2) continue;

      // Skip lines that span across the entire screen (wrapping artifacts)
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      if (dx * dx + dy * dy > (w * 0.8) ** 2) continue;

      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
    }

    ctx.stroke();
  }

  ctx.globalAlpha = 1.0;
}
