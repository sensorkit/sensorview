import type { GeoProjection } from "d3-geo";
import { celestialToScreen } from "../projection";
import type { SolarBody } from "../hooks/useSolarSystemBodies";

const SUN_RADIUS = 8;
const MOON_RADIUS = 7;
const PLANET_RADIUS = 4;

function bodyRadius(kind: SolarBody["kind"]): number {
  return kind === "sun" ? SUN_RADIUS : kind === "moon" ? MOON_RADIUS : PLANET_RADIUS;
}

export function renderSolarSystem(
  ctx: CanvasRenderingContext2D,
  projection: GeoProjection,
  bodies: SolarBody[],
  selectedName: string | null,
): void {
  // Clear in raw device-pixel coords so we guarantee the entire canvas is
  // wiped regardless of whatever transform happens to be current.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();

  for (const body of bodies) {
    const pt = celestialToScreen(projection, body.ra, body.dec);
    if (!pt) continue;
    const [x, y] = pt;
    const r = bodyRadius(body.kind);

    if (body.kind === "sun") drawSun(ctx, x, y, body.color);
    else if (body.kind === "moon") drawMoon(ctx, x, y, body.color);
    else drawPlanet(ctx, x, y, body.color);

    if (body.name === selectedName) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
    ctx.fillStyle = body.color;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(body.name, x + r + 4, y);
  }
}

function drawSun(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  // Soft glow
  const glow = ctx.createRadialGradient(x, y, 0, x, y, SUN_RADIUS * 3);
  glow.addColorStop(0, color + "80");
  glow.addColorStop(1, color + "00");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, SUN_RADIUS * 3, 0, Math.PI * 2);
  ctx.fill();
  // Disc
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, SUN_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

function drawMoon(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.arc(x, y, MOON_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  // Filled core + thin ring to distinguish from stars at small size
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, PLANET_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color + "aa";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, PLANET_RADIUS + 1.5, 0, Math.PI * 2);
  ctx.stroke();
}
