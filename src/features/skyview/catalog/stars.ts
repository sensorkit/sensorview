/**
 * Star record: [id, ra_deg, dec_deg, magnitude, spectral_class].
 *
 * `id` is the catalog identifier — HR number for the Bright Star Catalogue
 * (BSC5), HIP number for the Hipparcos catalogue. SensorView selects which
 * catalog to load via the SkyView store's `starCatalog` field.
 *
 * `spectral_class` is the leading O/B/A/F/G/K/M letter where known. HIP
 * doesn't have it for every entry; HR is filled for all entries (BSC5).
 */
export type StarRecord = [number, number, number, number, string | null];

/** Which catalog this StarCatalog was loaded from. */
export type StarCatalogKind = "HR" | "HIP";

export interface StarCatalog {
  kind: StarCatalogKind;
  stars: StarRecord[];
  names: Record<string, number>;
}

/** Reverse lookup: index → common name (cached per catalog kind). */
const nameByIndexCache: Map<StarCatalogKind, Map<number, string>> = new Map();

export function getStarName(catalog: StarCatalog, index: number): string | null {
  let cache = nameByIndexCache.get(catalog.kind);
  if (!cache) {
    cache = new Map();
    for (const [name, idx] of Object.entries(catalog.names)) {
      cache.set(idx, name);
    }
    nameByIndexCache.set(catalog.kind, cache);
  }
  return cache.get(index) ?? null;
}

/**
 * Display label for a star — proper name if available, otherwise the bare
 * catalog id formatted as e.g. "HR 7001" / "HIP 37826". The catalog prefix
 * is included so callers that don't have catalog-kind context still
 * disambiguate readably.
 */
export function getStarLabel(catalog: StarCatalog, index: number): string {
  const name = getStarName(catalog, index);
  if (name) return name;
  const star = catalog.stars[index];
  if (!star) return `Star #${index}`;
  return `${catalog.kind} ${star[0]}`;
}

/** Just the catalog id of a star (HR or HIP). */
export function getStarId(catalog: StarCatalog, index: number): number {
  return catalog.stars[index]![0];
}

/** Spectral type to approximate color temperature mapping. */
const SPECTRAL_COLORS: Record<string, string> = {
  O: "#9bb0ff",
  B: "#aabfff",
  A: "#cad7ff",
  F: "#f8f7ff",
  G: "#fff4ea",
  K: "#ffd2a1",
  M: "#ffcc6f",
};

export function getStarColor(spectralClass: string | null): string {
  return (spectralClass && SPECTRAL_COLORS[spectralClass]) ?? "#d8dce8";
}

/**
 * Display radius for a star based on its magnitude. Brighter stars (lower
 * mag) get larger radii.
 */
export function starRadius(magnitude: number, zoom: number): number {
  // mag -1.5 → ~5px, mag 0 → ~4px, mag 2 → ~3px, mag 4 → ~2px, mag 6 → ~1.2px
  const baseRadius = Math.max(1.0, 4.5 - magnitude * 0.6);
  return baseRadius * Math.min(1.5, 0.85 + zoom * 0.15);
}

/** Glow gate: only the brightest stars get a halo. */
export function shouldGlow(magnitude: number): boolean {
  return magnitude < 3.0;
}

/** Glow radius multiplier scaled by brightness. */
export function glowSize(magnitude: number): number {
  if (magnitude < 0) return 6;
  if (magnitude < 1) return 5;
  if (magnitude < 2) return 4;
  return 3;
}

// === Loading ============================================================

/**
 * Catalogs are cached per kind because they're large (HIP is ~5-10 MB
 * unzipped) and rarely change at runtime. First load is fetched + parsed
 * once; subsequent calls return the cached reference.
 */
const cache: Partial<Record<StarCatalogKind, StarCatalog>> = {};

/** Load HR (Bright Star Catalogue) — small file (~95 KB), shipped as JSON. */
async function loadHRCatalog(): Promise<StarCatalog> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/bsc5.json`);
  if (!response.ok) {
    throw new Error(`bsc5.json fetch failed: ${response.status}`);
  }
  const data = (await response.json()) as Omit<StarCatalog, "kind">;
  return { kind: "HR", stars: data.stars, names: data.names };
}

/**
 * Load HIP (Hipparcos main catalogue) — ~118k stars. Ships as a gzipped
 * JSON file named `hip.json.bin` (the `.bin` extension is deliberate: a
 * literal `.gz` would make Vite serve it with `Content-Encoding: gzip`,
 * which makes the browser auto-decompress before we get a chance to,
 * leaving our manual decompression looking at plaintext bytes. Using a
 * neutral extension keeps dev (Vite) and production (file://) loads
 * identical — both deliver raw gzip bytes that we decompress with
 * DecompressionStream).
 *
 * ~1.5 MB on the wire (compressed) / ~4 MB decompressed.
 */
async function loadHIPCatalog(): Promise<StarCatalog> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/hip.json.bin`);
  if (!response.ok) {
    throw new Error(`hip.json.bin fetch failed: ${response.status}`);
  }
  const stream = response.body;
  if (!stream) {
    throw new Error("hip.json.bin: empty response body");
  }
  // Native browser gzip decoder. Available in all evergreen browsers and
  // Electron's Chromium — see https://caniuse.com/?search=DecompressionStream
  const decompressed = stream.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(decompressed).text();
  const data = JSON.parse(text) as Omit<StarCatalog, "kind">;
  return { kind: "HIP", stars: data.stars, names: data.names };
}

/**
 * Load the requested star catalog, falling back to the cached copy on
 * subsequent calls. Default kind matches the SkyView store's default.
 */
export async function loadStarCatalog(
  kind: StarCatalogKind = "HR",
): Promise<StarCatalog> {
  const cached = cache[kind];
  if (cached) return cached;
  const loaded = kind === "HIP" ? await loadHIPCatalog() : await loadHRCatalog();
  cache[kind] = loaded;
  return loaded;
}
