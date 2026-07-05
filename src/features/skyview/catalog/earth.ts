/**
 * Natural Earth land polygon loaders. Ships both 50m and 110m land bundles
 * in public/data:
 *   - 50m (1.6 MB) for the flat ground-track map (no clipping, fine detail
 *     renders cheaply).
 *   - 110m (~140 KB) for the azimuthal overhead hemisphere, because d3-geo's
 *     clipAngle(90) resamples every polygon against the hemisphere boundary
 *     and 50m data makes that blow past the frame budget.
 */

const caches: Record<string, GeoJSON.FeatureCollection> = {};

async function load(file: string): Promise<GeoJSON.FeatureCollection> {
  const cached = caches[file];
  if (cached) return cached;
  const url = `${import.meta.env.BASE_URL}data/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  const parsed = (await response.json()) as GeoJSON.FeatureCollection;
  caches[file] = parsed;
  return parsed;
}

export function loadLandGeoJSON(): Promise<GeoJSON.FeatureCollection> {
  return load("ne_50m_land.geojson");
}

export function loadLandGeoJSONCoarse(): Promise<GeoJSON.FeatureCollection> {
  return load("ne_110m_land.geojson");
}
