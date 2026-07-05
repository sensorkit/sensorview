import {
  geoStereographic,
  geoOrthographic,
  geoEquirectangular,
  geoProjection,
  type GeoProjection,
} from "d3-geo";

/**
 * Create a stereographic projection configured for celestial coordinates.
 * RA increases leftward (inverted longitude), Dec maps to latitude.
 */
export function createCelestialProjection(
  width: number,
  height: number,
  centerRA: number,
  centerDec: number,
  zoom: number,
): GeoProjection {
  // d3-geo's stereographic: a point at angular distance θ from center maps
  // to screen distance r = scale * tan(θ/2). At θ=90° (horizon when centered
  // at zenith), r = scale. To fit the hemisphere just inside the smaller
  // viewport dimension we'd want scale = min(w,h)/2; we use 0.45 instead so
  // the horizon circle leaves a small margin (and a bit of below-horizon
  // sky stays visible). FOV math in computeFovDegrees inverts this.
  const baseScale = Math.min(width, height) * 0.45;

  // clipAngle controls how much sky is visible. At zoom=1, show ~120° radius
  // (more than a hemisphere for better context). Tighten as we zoom in.
  const clipAngle = Math.min(150, 120 / zoom);

  return geoStereographic()
    .rotate([-centerRA, -centerDec, 0])
    .reflectX(true) // Astronomy convention: East on the left (sky viewed from inside)
    .translate([width / 2, height / 2])
    .scale(baseScale * zoom)
    .clipAngle(clipAngle);
}

/**
 * Convert RA/Dec to screen coordinates using a projection.
 * Returns null if the point is outside the clipping region.
 */
export function celestialToScreen(
  projection: GeoProjection,
  ra: number,
  dec: number,
): [number, number] | null {
  // d3-geo treats [longitude, latitude] — RA maps to longitude, Dec to latitude
  const result = projection([ra, dec]);
  return result as [number, number] | null;
}

/**
 * Convert screen coordinates back to RA/Dec.
 */
export function screenToCelestial(
  projection: GeoProjection,
  x: number,
  y: number,
): [number, number] | null {
  const result = projection.invert?.([x, y]);
  if (!result) return null;
  // Normalize RA to [0, 360)
  let ra = result[0] % 360;
  if (ra < 0) ra += 360;
  return [ra, result[1]];
}

// === Overhead (azimuthal equidistant) projection ===

/**
 * Create an azimuthal equidistant projection centered on the observer.
 * Shows the hemisphere visible from above the site.
 */
export function createOverheadProjection(
  width: number,
  height: number,
  observerLat: number,
  observerLon: number,
  zoom: number,
  clipAngle = 90,
): GeoProjection {
  // geoOrthographic matches the projection math used by project3D (the 3D
  // satellite / mount-line projection), so mount endpoints stay glued to the
  // observer marker when the user drags the globe. An azimuthal-equidistant
  // projection agreed with project3D only at the exact center — fine for
  // a fixed observer-centered view, broken as soon as the globe rotates.
  //
  // For orthographic, scale is the earth-disk radius in pixels directly
  // (vs. azeq's scale*π/2). We multiply baseScale by π/2 so the globe keeps
  // the same on-screen size as before.
  const baseScale = Math.min(width, height) * 0.45 * (Math.PI / 2);
  // precision(2): cap adaptive resampling at 2px. Default is ~0.7px, which
  // causes d3-geo to subdivide line segments aggressively when clipping
  // polygons against the hemisphere boundary. On detailed coastlines that
  // makes the first render lock the main thread for seconds.
  return geoOrthographic()
    .rotate([-observerLon, -observerLat])
    .translate([width / 2, height / 2])
    .scale(baseScale * zoom)
    .clipAngle(clipAngle)
    .precision(2);
}

// === Ground track (equirectangular) projection ===

/**
 * Create an equirectangular projection for ground track display.
 */
export function createGroundTrackProjection(
  width: number,
  height: number,
  centerLon: number,
  centerLat: number,
  zoom: number,
): GeoProjection {
  // Scale so -90° to 90° latitude fills the full viewport height
  const baseScale = height / Math.PI;
  return geoEquirectangular()
    .rotate([-centerLon, 0, 0])
    .center([0, centerLat])
    .translate([width / 2, height / 2])
    .scale(baseScale * zoom);
}

// === Field-of-view inverse ===

/**
 * Compute the angular field of view (in degrees) visible across the
 * smaller of the two canvas dimensions — the constrained axis. With a
 * landscape canvas this is the *vertical* FOV; with portrait it's the
 * horizontal. This matches the user's intuitive reference: when the
 * horizon circle is fully inscribed inside the canvas (vertically for
 * landscape), the FOV exceeds 180°.
 *
 * Each formula mirrors the projection setup in `createCelestialProjection`,
 * `createOverheadProjection`, `createGroundTrackProjection` above — when
 * one changes, the matching branch here must follow.
 */
export function computeFovDegrees(
  viewMode: "sky" | "overhead" | "groundtrack",
  zoom: number,
  width: number,
  height: number,
): number {
  if (width <= 0 || height <= 0) return 0;
  const minDim = Math.min(width, height);
  const halfMin = minDim / 2;
  const RAD = 180 / Math.PI;

  if (viewMode === "sky") {
    // d3-geo stereographic: r = S * tan(θ/2)  →  θ_edge = 2 * atan(r / S)
    const scale = 0.45 * minDim * zoom;
    const screenHalfFov = 2 * Math.atan(halfMin / scale) * RAD;
    // Honor the projection's clipAngle so the reported FOV never exceeds
    // what's actually rendered (relevant only at very low zoom).
    const clipAngle = Math.min(150, 120 / zoom);
    return Math.min(screenHalfFov, clipAngle) * 2;
  }

  if (viewMode === "overhead") {
    // Orthographic: r = S * sin(θ) → θ = asin(r/S), capped at 90°.
    const scale = 0.45 * minDim * (Math.PI / 2) * zoom;
    const ratio = Math.min(1, halfMin / scale);
    return Math.asin(ratio) * 2 * RAD;
  }

  // Ground track: equirectangular, linear with scale = h/π.
  const scale = (height / Math.PI) * zoom;
  return Math.min(360, (halfMin / scale) * 2 * RAD);
}

// === Geographic coordinate helpers ===

/**
 * Convert geographic lon/lat to screen coordinates.
 * Returns null if the point is outside the clipping region.
 */
export function geoToScreen(
  projection: GeoProjection,
  lon: number,
  lat: number,
): [number, number] | null {
  const result = projection([lon, lat]);
  return result as [number, number] | null;
}

/**
 * Convert screen coordinates back to geographic lon/lat.
 */
export function screenToGeo(
  projection: GeoProjection,
  x: number,
  y: number,
): [number, number] | null {
  const result = projection.invert?.([x, y]);
  if (!result) return null;
  return [result[0], result[1]];
}

// === Morphing projection (overhead ↔ ground track) ===

/**
 * Create a projection that smoothly morphs between azimuthal equidistant
 * (globe from above) and equirectangular (flat map).
 *
 * At t=0: azimuthal equidistant centered on observer (overhead view)
 * At t=1: equirectangular centered on observer longitude (ground track)
 *
 * The raw projection functions are lerped, so all d3-geo features
 * (geoPath, geoGraticule, geoCircle) work naturally.
 */
export function createMorphProjection(
  width: number,
  height: number,
  observerLat: number,
  observerLon: number,
  t: number,
  overheadZoom: number,
  groundTrackZoom: number,
): GeoProjection {
  // Lerped raw projection: azimuthal equidistant → equirectangular
  const raw = (lambda: number, phi: number): [number, number] => {
    // Azimuthal equidistant raw
    const cosPhi = Math.cos(phi);
    const cosLambda = Math.cos(lambda);
    const k = Math.acos(Math.max(-1, Math.min(1, cosPhi * cosLambda)));

    let ax: number, ay: number;
    if (k < 1e-10) {
      ax = 0;
      ay = 0;
    } else {
      ax = (k * cosPhi * Math.sin(lambda)) / Math.sin(k);
      ay = (k * Math.sin(phi)) / Math.sin(k);
    }

    // Equirectangular raw is just (lambda, phi)
    // Lerp between them
    return [
      ax + (lambda - ax) * t,
      ay + (phi - ay) * t,
    ];
  };

  // Interpolate rotation: overhead [-lon, -lat] → ground track [-lon, 0]
  const rotLat = -observerLat * (1 - t);

  // Interpolate scale
  const overheadBase = Math.min(width, height) * 0.45;
  const groundTrackBase = height / Math.PI;
  const scaleA = overheadBase * overheadZoom;
  const scaleB = groundTrackBase * groundTrackZoom;
  const scale = scaleA + (scaleB - scaleA) * t;

  // Interpolate clipAngle: 90° → 180°
  const clipAngle = 90 + t * 90;

  return geoProjection(raw)
    .rotate([-observerLon, rotLat])
    .translate([width / 2, height / 2])
    .scale(scale)
    .clipAngle(clipAngle)
    .precision(10000); // disable adaptive resampling — input vertices are dense enough
}
