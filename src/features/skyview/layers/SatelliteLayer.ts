import type { GeoProjection } from "d3-geo";
import type { SatellitePosition, TLERecord } from "../../../stores/satellites";
import type { TrackPoint } from "../hooks/useSatelliteTrack";
import { celestialToScreen } from "../projection";
import { regimeColor } from "./regimeColors";

const SAT_SIZE = 4;
const TRACK_WIDTH = 1.5;

/**
 * Render satellite positions as diamond shapes, plus the selected satellite's orbital track.
 * Color-coded by orbit regime to match overhead and ground track views.
 */
export function renderSatellites(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  positions: SatellitePosition[],
  tles: TLERecord[],
  projection: GeoProjection,
  selectedId: string | null,
  showBelowHorizon: boolean,
  track: TrackPoint[],
): void {
  ctx.clearRect(0, 0, width, height);

  const tleMap = new Map(tles.map((t) => [t.noradId, t]));

  // Draw orbital track first (behind satellites)
  if (track.length > 1 && selectedId) {
    const regime = tleMap.get(selectedId)?.orbitRegime;
    drawTrack(ctx, width, height, track, projection, regimeColor(regime));
  }

  // Draw satellite diamonds
  for (const sat of positions) {
    if (!showBelowHorizon && sat.alt < 0) continue;

    const pos = celestialToScreen(projection, sat.ra, sat.dec);
    if (!pos) continue;

    const [x, y] = pos;
    if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;

    const isSelected = sat.noradId === selectedId;
    const regime = tleMap.get(sat.noradId)?.orbitRegime;
    const color = sat.alt < 0 ? "#555555" : regimeColor(regime);
    const s = isSelected ? SAT_SIZE * 1.4 : SAT_SIZE;

    // Glow
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, s * 3);
    gradient.addColorStop(0, color + "50");
    gradient.addColorStop(1, color + "00");
    ctx.beginPath();
    ctx.arc(x, y, s * 3, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Diamond
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s, y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function drawTrack(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  track: TrackPoint[],
  projection: GeoProjection,
  color: string,
): void {
  ctx.lineWidth = TRACK_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  let prevPos: [number, number] | null = null;
  const maxTime = Math.max(...track.map((p) => Math.abs(p.time)));

  for (let i = 0; i < track.length; i++) {
    const pt = track[i]!;
    const pos = celestialToScreen(projection, pt.ra, pt.dec);

    if (!pos) {
      prevPos = null;
      continue;
    }

    const [x, y] = pos;
    if (x < -50 || x > width + 50 || y < -50 || y > height + 50) {
      prevPos = null;
      continue;
    }

    if (prevPos) {
      const dx = x - prevPos[0];
      const dy = y - prevPos[1];
      if (dx * dx + dy * dy < (width * 0.5) ** 2) {
        const timeFade = 1 - Math.abs(pt.time) / maxTime * 0.7;

        ctx.beginPath();
        ctx.moveTo(prevPos[0], prevPos[1]);
        ctx.lineTo(x, y);

        if (pt.time <= 0) {
          ctx.strokeStyle = color;
          ctx.globalAlpha = timeFade * (pt.alt > 0 ? 0.7 : 0.25);
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = color;
          ctx.globalAlpha = timeFade * (pt.alt > 0 ? 0.5 : 0.15);
          ctx.setLineDash([4, 4]);
        }
        ctx.stroke();
      }
    }

    prevPos = [x, y];
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}
