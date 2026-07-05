import { geoGraticule, geoPath, geoCircle, type GeoProjection } from "d3-geo";
import type { ObserverLocation } from "../hooks/useObserver";
import { geoToScreen } from "../projection";
import { subSolarPoint } from "../catalog/daynight";

const EARTH_RADIUS_KM = 6371;

/**
 * Render the equirectangular map background with land, day/night, grid, observer.
 */
export function renderGroundTrackMap(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  projection: GeoProjection,
  observer: ObserverLocation,
  landGeoJSON: GeoJSON.FeatureCollection | null,
) {
  ctx.clearRect(0, 0, width, height);

  const pathGenerator = geoPath(projection, ctx);

  // Ocean background
  ctx.beginPath();
  pathGenerator({ type: "Sphere" });
  ctx.fillStyle = "#070d1a";
  ctx.fill();

  // Night hemisphere overlay (drawn before land so land is on top)
  const sun = subSolarPoint(new Date());
  // Anti-solar point — center of night hemisphere
  const nightCircle = geoCircle()
    .center([-sun.lon, -sun.lat]) // opposite side of earth from sun
    .radius(90)
    .precision(1);
  ctx.beginPath();
  pathGenerator(nightCircle());
  ctx.fillStyle = "rgba(0, 0, 8, 0.55)";
  ctx.fill();

  // Twilight band — slightly wider circle for gradual transition
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

  // Day side subtle warm wash
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

  // Equator
  ctx.beginPath();
  pathGenerator({
    type: "LineString",
    coordinates: Array.from({ length: 361 }, (_, i) => [i - 180, 0]),
  });
  ctx.strokeStyle = "#1a3040";
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Observer visibility footprint (LEO)
  const leoRadius = Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + 400)) * (180 / Math.PI);
  const footprintCircle = geoCircle()
    .center([observer.lon, observer.lat])
    .radius(leoRadius)
    .precision(1);

  ctx.beginPath();
  pathGenerator(footprintCircle());
  ctx.fillStyle = "rgba(74, 158, 255, 0.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(74, 158, 255, 0.3)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Observer marker
  const obs = geoToScreen(projection, observer.lon, observer.lat);
  if (obs) {
    ctx.fillStyle = "#4a9eff";
    ctx.beginPath();
    ctx.arc(obs[0], obs[1], 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#4a9eff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(obs[0], obs[1], 8, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "#6b8baa";
    ctx.font = "10px sans-serif";
    ctx.fillText(observer.name, obs[0] + 12, obs[1] + 4);
  }

  // Sphere boundary stroke
  ctx.beginPath();
  pathGenerator({ type: "Sphere" });
  ctx.strokeStyle = "#1a2a3a";
  ctx.lineWidth = 1;
  ctx.stroke();
}
