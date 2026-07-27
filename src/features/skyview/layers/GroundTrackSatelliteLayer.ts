import { geoPath, type GeoProjection } from "d3-geo";
import { geoToScreen } from "../projection";
import {
  sameSatKey,
  satKeyId,
  satKeyOf,
  type CatalogRecord,
  type SatellitePosition,
  type SatKey,
} from "../../../stores/satellites";
import type { GroundTrackPoint } from "../hooks/useGroundTrack";
import { regimeColor } from "./regimeColors";

/**
 * Build GeoJSON MultiLineString from ground track points, splitting at antimeridian.
 */
function trackToGeoJSON(points: GroundTrackPoint[]): GeoJSON.MultiLineString {
  const lines: number[][][] = [[]];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i]!;
    const prev = i > 0 ? points[i - 1]! : null;
    // Split at antimeridian crossing
    if (prev && Math.abs(pt.lon - prev.lon) > 180) {
      lines.push([]);
    }
    lines[lines.length - 1]!.push([pt.lon, pt.lat]);
  }
  return { type: "MultiLineString", coordinates: lines.filter((l) => l.length >= 2) };
}

/**
 * Render satellites and ground track path on equirectangular map.
 */
export function renderGroundTrackSatellites(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  positions: SatellitePosition[],
  tles: CatalogRecord[],
  projection: GeoProjection,
  selectedId: SatKey | null,
  groundTrack: GroundTrackPoint[],
) {
  ctx.clearRect(0, 0, width, height);

  const tleMap = new Map(tles.map((t) => [satKeyId(satKeyOf(t)), t]));
  const pathGenerator = geoPath(projection, ctx);

  // Draw ground track for selected satellite using d3-geo path (handles wrapping)
  if (selectedId && groundTrack.length > 1) {
    // Split into past and future segments
    const pastPoints = groundTrack.filter((p) => p.time <= 0);
    const futurePoints = groundTrack.filter((p) => p.time >= 0);

    // Past track
    if (pastPoints.length >= 2) {
      ctx.beginPath();
      pathGenerator(trackToGeoJSON(pastPoints));
      ctx.strokeStyle = "rgba(100, 180, 255, 0.6)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Future track
    if (futurePoints.length >= 2) {
      ctx.beginPath();
      pathGenerator(trackToGeoJSON(futurePoints));
      ctx.strokeStyle = "rgba(255, 180, 100, 0.4)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

  }

  // Draw non-selected satellites
  for (const pos of positions) {
    if (pos.lat == null || pos.lon == null) continue;
    if (selectedId && sameSatKey(pos, selectedId)) continue;

    const pt = geoToScreen(projection, pos.lon, pos.lat);
    if (!pt) continue;

    const regime = tleMap.get(pos.noradId)?.orbitRegime ?? "OTHER";
    const color = regimeColor(regime);

    const s = 3.5;
    ctx.fillStyle = color;
    ctx.globalAlpha = pos.isVisible ? 0.8 : 0.25;
    ctx.beginPath();
    ctx.moveTo(pt[0], pt[1] - s);
    ctx.lineTo(pt[0] + s, pt[1]);
    ctx.lineTo(pt[0], pt[1] + s);
    ctx.lineTo(pt[0] - s, pt[1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Draw selected satellite on top
  if (selectedId) {
    const pos = positions.find((p) => sameSatKey(p, selectedId));
    if (pos?.lat != null && pos?.lon != null) {
      const pt = geoToScreen(projection, pos.lon, pos.lat);
      if (pt) {
        const name = tleMap.get(satKeyId(selectedId))?.name ?? selectedId.noradId;
        const regime = tleMap.get(satKeyId(selectedId))?.orbitRegime ?? "OTHER";
        const color = regimeColor(regime);

        // Glow
        const grad = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], 10);
        grad.addColorStop(0, color);
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], 10, 0, Math.PI * 2);
        ctx.fill();

        // Diamond
        const s = 4;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(pt[0], pt[1] - s);
        ctx.lineTo(pt[0] + s, pt[1]);
        ctx.lineTo(pt[0], pt[1] + s);
        ctx.lineTo(pt[0] - s, pt[1]);
        ctx.closePath();
        ctx.fill();

        // Label
        ctx.fillStyle = "#ffffff";
        ctx.font = "11px sans-serif";
        ctx.fillText(name, pt[0] + 8, pt[1] + 4);
      }
    }
  }
}
