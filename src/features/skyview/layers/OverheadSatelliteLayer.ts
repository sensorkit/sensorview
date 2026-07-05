import type { GeoProjection } from "d3-geo";
import type { SatellitePosition, TLERecord } from "../../../stores/satellites";
import type { GroundTrackPoint } from "../hooks/useGroundTrack";
import type { ObserverLocation } from "../hooks/useObserver";
import { project3D, makeObserver3D, overheadScale } from "../projection3d";
import { regimeColor } from "./regimeColors";

/**
 * Render satellites and altitude-aware orbit track on the overhead projection.
 */
export function renderOverheadSatellites(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  positions: SatellitePosition[],
  tles: TLERecord[],
  projection: GeoProjection,
  selectedId: string | null,
  groundTrack: GroundTrackPoint[],
  observer: ObserverLocation,
) {
  ctx.clearRect(0, 0, width, height);

  const tleMap = new Map(tles.map((t) => [t.noradId, t]));
  const cx = width / 2;
  const cy = height / 2;
  const earthScreenR = projection.scale();
  const obs = makeObserver3D(observer.lat, observer.lon);
  const scale3d = overheadScale(earthScreenR);

  // Draw orbit track for selected satellite using true 3D projection
  if (selectedId && groundTrack.length > 1) {
    const maxTime = Math.max(...groundTrack.map((p) => Math.abs(p.time)));
    let prev: [number, number] | null = null;

    for (const pt of groundTrack) {
      const s = project3D(pt.lat, pt.lon, pt.altitude, obs, scale3d, cx, cy);

      if (s && prev) {
        const dx = s[0] - prev[0];
        const dy = s[1] - prev[1];
        if (dx * dx + dy * dy < (width * 0.5) ** 2) {
          const timeFrac = Math.abs(pt.time) / maxTime;
          const alpha = Math.max(0.1, 0.6 - timeFrac * 0.5);

          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(s[0], s[1]);

          if (pt.time <= 0) {
            ctx.strokeStyle = `rgba(100, 180, 255, ${alpha})`;
            ctx.setLineDash([]);
          } else {
            ctx.strokeStyle = `rgba(255, 180, 100, ${alpha * 0.7})`;
            ctx.setLineDash([4, 4]);
          }
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      prev = s;
    }
    ctx.setLineDash([]);

    // "Now" marker with glow and label — driven by the live position, not the
    // snapshot track, so it moves as the sat propagates.
    const livePos = positions.find((p) => p.noradId === selectedId);
    const nowScreen = livePos && livePos.lat != null && livePos.lon != null
      ? project3D(livePos.lat, livePos.lon, livePos.satAlt ?? 0, obs, scale3d, cx, cy)
      : null;
    if (nowScreen) {
      const regime = tleMap.get(selectedId)?.orbitRegime ?? "OTHER";
      const color = regimeColor(regime);
      const name = tleMap.get(selectedId)?.name ?? selectedId;

      // Glow
      const grad = ctx.createRadialGradient(nowScreen[0], nowScreen[1], 0, nowScreen[0], nowScreen[1], 12);
      grad.addColorStop(0, color);
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(nowScreen[0], nowScreen[1], 12, 0, Math.PI * 2);
      ctx.fill();

      // Diamond
      const ds = 5;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(nowScreen[0], nowScreen[1] - ds);
      ctx.lineTo(nowScreen[0] + ds, nowScreen[1]);
      ctx.lineTo(nowScreen[0], nowScreen[1] + ds);
      ctx.lineTo(nowScreen[0] - ds, nowScreen[1]);
      ctx.closePath();
      ctx.fill();

      // Label
      ctx.fillStyle = "#ffffff";
      ctx.font = "11px sans-serif";
      ctx.fillText(name, nowScreen[0] + 10, nowScreen[1] + 4);
    }
  }

  // Draw non-selected satellites using same 3D projection
  for (const pos of positions) {
    if (pos.lat == null || pos.lon == null) continue;
    if (pos.noradId === selectedId) continue;

    const pt = project3D(pos.lat, pos.lon, pos.satAlt ?? 0, obs, scale3d, cx, cy);
    if (!pt) continue;

    const regime = tleMap.get(pos.noradId)?.orbitRegime ?? "OTHER";
    const color = regimeColor(regime);

    const s = 3;
    ctx.fillStyle = color;
    ctx.globalAlpha = pos.isVisible ? 0.9 : 0.3;
    ctx.beginPath();
    ctx.moveTo(pt[0], pt[1] - s);
    ctx.lineTo(pt[0] + s, pt[1]);
    ctx.lineTo(pt[0], pt[1] + s);
    ctx.lineTo(pt[0] - s, pt[1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

}
