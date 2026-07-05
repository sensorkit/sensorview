import { geoGraticule, geoPath, geoCircle, type GeoProjection } from "d3-geo";
import type { ObserverLocation } from "../hooks/useObserver";
import { geoToScreen } from "../projection";
import { subSolarPoint } from "../catalog/daynight";

/**
 * Render earth surface, land, day/night, and grid for the overhead view.
 */
export function renderOverheadGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  projection: GeoProjection,
  observer: ObserverLocation,
  landGeoJSON: GeoJSON.FeatureCollection | null,
) {
  ctx.clearRect(0, 0, width, height);

  const pathGenerator = geoPath(projection, ctx);

  // Earth atmosphere glow (drawn before the disk so it appears behind)
  const earthRadius = projection.scale();
  const cx = width / 2;
  const cy = height / 2;
  const glowGrad = ctx.createRadialGradient(cx, cy, earthRadius * 0.95, cx, cy, earthRadius * 1.15);
  glowGrad.addColorStop(0, "rgba(60, 140, 255, 0.15)");
  glowGrad.addColorStop(0.5, "rgba(40, 100, 200, 0.06)");
  glowGrad.addColorStop(1, "rgba(20, 60, 140, 0)");
  ctx.beginPath();
  ctx.arc(cx, cy, earthRadius * 1.15, 0, Math.PI * 2);
  ctx.fillStyle = glowGrad;
  ctx.fill();

  // Earth disk — ocean
  ctx.beginPath();
  pathGenerator({ type: "Sphere" });
  ctx.fillStyle = "#070d1a";
  ctx.fill();

  // Night hemisphere
  const sun = subSolarPoint(new Date());
  const nightCircle = geoCircle()
    .center([-sun.lon, -sun.lat])
    .radius(90)
    .precision(1);
  ctx.beginPath();
  pathGenerator(nightCircle());
  ctx.fillStyle = "rgba(0, 0, 8, 0.55)";
  ctx.fill();

  const twilightCircle = geoCircle()
    .center([-sun.lon, -sun.lat])
    .radius(96)
    .precision(1);
  ctx.beginPath();
  pathGenerator(twilightCircle());
  ctx.fillStyle = "rgba(0, 0, 8, 0.15)";
  ctx.fill();

  // Land polygons
  if (landGeoJSON) {
    for (const feature of landGeoJSON.features) {
      ctx.beginPath();
      pathGenerator(feature as GeoJSON.Feature);
      ctx.fillStyle = "#0f1f0f";
      ctx.fill();
      ctx.strokeStyle = "#1a4a1a";
      ctx.lineWidth = 0.4;
      ctx.stroke();
    }
  }

  // Day side warm wash
  const dayCircle = geoCircle()
    .center([sun.lon, sun.lat])
    .radius(80)
    .precision(1);
  ctx.beginPath();
  pathGenerator(dayCircle());
  ctx.fillStyle = "rgba(255, 240, 200, 0.04)";
  ctx.fill();

  // Terminator line
  const terminatorCircle = geoCircle()
    .center([sun.lon, sun.lat])
    .radius(90)
    .precision(0.5);
  ctx.beginPath();
  pathGenerator(terminatorCircle());
  ctx.strokeStyle = "rgba(255, 200, 100, 0.15)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Grid
  const fineGraticule = geoGraticule().step([10, 10]);
  ctx.beginPath();
  pathGenerator(fineGraticule());
  ctx.strokeStyle = "#091520";
  ctx.lineWidth = 0.3;
  ctx.stroke();

  const graticule = geoGraticule().step([30, 30]);
  ctx.beginPath();
  pathGenerator(graticule());
  ctx.strokeStyle = "#0d1a2a";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Earth disk boundary
  ctx.beginPath();
  pathGenerator({ type: "Sphere" });
  ctx.strokeStyle = "#1a3a5a";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Observer marker at center
  const obs = geoToScreen(projection, observer.lon, observer.lat);
  if (obs) {
    const r = 8;
    ctx.strokeStyle = "#4a9eff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(obs[0] - r, obs[1]);
    ctx.lineTo(obs[0] + r, obs[1]);
    ctx.moveTo(obs[0], obs[1] - r);
    ctx.lineTo(obs[0], obs[1] + r);
    ctx.stroke();

    ctx.fillStyle = "#4a9eff";
    ctx.beginPath();
    ctx.arc(obs[0], obs[1], 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#6b8baa";
    ctx.font = "10px sans-serif";
    ctx.fillText(observer.name, obs[0] + 12, obs[1] + 4);
  }
}
