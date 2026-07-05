import { geoCircle, geoPath, type GeoProjection } from "d3-geo";
import type { ObserverLocation } from "../hooks/useObserver";

const EARTH_RADIUS_KM = 6371;

interface RegardRing {
  label: string;
  altitudeKm: number;
  color: string;
  fillColor: string;
}

const REGARD_RINGS: RegardRing[] = [
  { label: "LEO", altitudeKm: 400, color: "#2a6644", fillColor: "rgba(42, 102, 68, 0.06)" },
  { label: "MEO", altitudeKm: 20200, color: "#445588", fillColor: "rgba(68, 85, 136, 0.04)" },
  { label: "GEO", altitudeKm: 35786, color: "#885544", fillColor: "rgba(136, 85, 68, 0.04)" },
];

/**
 * Compute the angular radius (degrees) of the visibility footprint
 * on Earth's surface for a satellite at the given altitude.
 * This is the max ground distance from observer where a satellite is visible.
 */
function regardRadius(altitudeKm: number): number {
  return Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm)) * (180 / Math.PI);
}

/**
 * Render LEO/MEO/GEO regard cones as concentric circles on the overhead projection.
 */
export function renderRegardCones(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  projection: GeoProjection,
  observer: ObserverLocation,
) {
  ctx.clearRect(0, 0, width, height);

  const pathGenerator = geoPath(projection, ctx);

  // Draw from outermost to innermost so fills layer correctly
  for (let i = REGARD_RINGS.length - 1; i >= 0; i--) {
    const ring = REGARD_RINGS[i]!;
    const radius = regardRadius(ring.altitudeKm);
    const circle = geoCircle()
      .center([observer.lon, observer.lat])
      .radius(radius)
      .precision(1);

    const feature = circle();

    // Fill
    ctx.beginPath();
    pathGenerator(feature);
    ctx.fillStyle = ring.fillColor;
    ctx.fill();

    // Stroke
    ctx.beginPath();
    pathGenerator(feature);
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label — place at top of circle
    const labelPoint = projection([observer.lon, Math.min(90, observer.lat + radius)]);
    if (labelPoint) {
      ctx.fillStyle = ring.color;
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        `${ring.label} (${ring.altitudeKm.toLocaleString()} km)`,
        labelPoint[0],
        labelPoint[1] - 6,
      );
    }
  }

  ctx.textAlign = "start"; // reset
}
