import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { formatDMS } from "../../lib/coords";

/**
 * Interactive map for picking an observing site. Keyless by design: raster
 * tiles from OpenStreetMap (streets) and Esri World Imagery (satellite),
 * geocoding search via Nominatim, and best-effort elevation via Open-Meteo —
 * none require an API key or billing. Picking is inherently an online action;
 * the picked coordinates are then saved and drive SkyView offline.
 *
 * PROVIDER SWAP: to move to Google Maps later, this component is the only place
 * that needs to change — swap the tile layers below for a Google raster/JS
 * layer and `geocode()` for the Google Geocoding API. The surrounding Settings
 * flow (a "Pick on map" button that resolves to {lat, lon, alt}) is provider-
 * agnostic.
 */

const TILE_STREETS = {
  url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
  maxZoom: 19,
};
const TILE_SATELLITE = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  maxZoom: 19,
};

// Bright teardrop pin drawn inline so we don't depend on Leaflet's default
// marker PNGs (which break under bundlers) and it reads on both base layers.
const PIN_ICON = L.divIcon({
  className: "",
  iconSize: [26, 34],
  iconAnchor: [13, 33],
  html: `<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 1C6.4 1 1 6.3 1 12.8 1 21.5 13 33 13 33s12-11.5 12-20.2C25 6.3 19.6 1 13 1z"
      fill="#38bdf8" stroke="#ffffff" stroke-width="2"/>
    <circle cx="13" cy="12.5" r="4.5" fill="#0b1220"/>
  </svg>`,
});

interface GeoResult {
  label: string;
  lat: number;
  lon: number;
}

async function geocode(query: string, signal?: AbortSignal): Promise<GeoResult[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`geocode HTTP ${res.status}`);
  const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name?: string }>;
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => ({
    label: r.display_name ?? `${r.lat}, ${r.lon}`,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
  }));
}

async function lookupElevation(lat: number, lon: number): Promise<number | null> {
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`elevation HTTP ${res.status}`);
  const data = (await res.json()) as { elevation?: number[] };
  const e = Array.isArray(data.elevation) ? data.elevation[0] : null;
  return typeof e === "number" ? e : null;
}

interface MapPickerModalProps {
  initial: { lat: number; lon: number; alt: number };
  onConfirm: (loc: { lat: number; lon: number; alt: number }) => void;
  onCancel: () => void;
}

export function MapPickerModal({ initial, onConfirm, onCancel }: MapPickerModalProps) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  // Guards against an earlier elevation response landing after a newer pick.
  const elevReqRef = useRef(0);

  const [pos, setPos] = useState({ lat: initial.lat, lon: initial.lon });
  const [alt, setAlt] = useState(initial.alt);
  const [elevLoading, setElevLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Set when a result is chosen so the dropdown doesn't immediately re-open
  // from the debounced effect re-firing on the programmatic setSearch.
  const justPickedRef = useRef(false);

  // Move the pin + readout to a new point and best-effort fetch its elevation.
  // Stable (no deps) so the once-only map-init effect can capture it safely.
  const applyPick = useCallback(
    (lat: number, lon: number, opts?: { pan?: boolean }) => {
      setPos({ lat, lon });
      markerRef.current?.setLatLng([lat, lon]);
      if (opts?.pan && mapRef.current) {
        mapRef.current.setView([lat, lon], Math.max(mapRef.current.getZoom(), 10));
      }
      const reqId = ++elevReqRef.current;
      setElevLoading(true);
      lookupElevation(lat, lon)
        .then((e) => {
          if (reqId === elevReqRef.current && e !== null) setAlt(Math.round(e));
        })
        .catch(() => {
          /* best-effort: keep the prior altitude on failure */
        })
        .finally(() => {
          if (reqId === elevReqRef.current) setElevLoading(false);
        });
    },
    [],
  );

  // Initialize Leaflet exactly once. Imperative lifecycle → empty deps; the
  // cleanup fully tears the map down so React 18/19 StrictMode's double-invoke
  // re-creates cleanly rather than hitting "container already initialized".
  useEffect(() => {
    const div = mapDivRef.current;
    if (!div || mapRef.current) return;

    const map = L.map(div, {
      center: [initial.lat, initial.lon],
      zoom: 9,
      worldCopyJump: true,
      zoomControl: true,
    });
    mapRef.current = map;

    const streets = L.tileLayer(TILE_STREETS.url, {
      attribution: TILE_STREETS.attribution,
      maxZoom: TILE_STREETS.maxZoom,
    });
    const satellite = L.tileLayer(TILE_SATELLITE.url, {
      attribution: TILE_SATELLITE.attribution,
      maxZoom: TILE_SATELLITE.maxZoom,
    });
    satellite.addTo(map); // default to imagery — matches the Google-satellite feel
    L.control.layers({ Satellite: satellite, Streets: streets }, undefined, {
      position: "topright",
    }).addTo(map);

    const marker = L.marker([initial.lat, initial.lon], {
      draggable: true,
      icon: PIN_ICON,
    }).addTo(map);
    markerRef.current = marker;
    marker.on("dragend", () => {
      const ll = marker.getLatLng();
      applyPick(ll.lat, ll.lng);
    });
    map.on("click", (e: L.LeafletMouseEvent) => applyPick(e.latlng.lat, e.latlng.lng));

    // The modal panel is already laid out, but Leaflet measures on create —
    // nudge it after paint so tiles fill the container.
    const t = setTimeout(() => map.invalidateSize(), 0);

    return () => {
      clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init once; initial values are a seed
  }, []);

  // Escape closes the results dropdown first, else the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (resultsOpen) setResultsOpen(false);
      else onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, resultsOpen]);

  // Debounced typeahead: fetch candidate places as the operator types and show
  // them as a dropdown to disambiguate (e.g. "Haleakala" matches a Maui summit
  // AND a California street — the operator picks the right one instead of us
  // guessing the first hit). Aborts the in-flight request on each keystroke to
  // stay a good Nominatim citizen.
  useEffect(() => {
    if (justPickedRef.current) {
      justPickedRef.current = false;
      return;
    }
    const q = search.trim();
    if (q.length < 3) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      geocode(q, ctl.signal)
        .then((hits) => {
          setResults(hits);
          setResultsOpen(true);
          setSearchError(hits.length === 0 ? "No matches found." : null);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError")
            setSearchError("Search failed — check your connection.");
        })
        .finally(() => {
          if (!ctl.signal.aborted) setSearching(false);
        });
    }, 450);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [search]);

  const selectResult = (r: GeoResult) => {
    justPickedRef.current = true;
    setSearch(r.label.split(",")[0] ?? r.label);
    setResults([]);
    setResultsOpen(false);
    applyPick(r.lat, r.lon, { pan: true });
  };

  // Force an immediate lookup (Search button / Enter) instead of waiting for the
  // debounce. Still shows the list to disambiguate rather than auto-jumping.
  const runSearchNow = () => {
    const q = search.trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    geocode(q)
      .then((hits) => {
        setResults(hits);
        setResultsOpen(true);
        setSearchError(hits.length === 0 ? "No matches found." : null);
      })
      .catch(() => setSearchError("Search failed — check your connection."))
      .finally(() => setSearching(false));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="flex h-[min(600px,85dvh)] max-h-[90dvh] w-[900px] max-w-[95vw] flex-col overflow-hidden rounded-lg border border-panel-border bg-panel-bg shadow-2xl">
        <div className="flex items-center justify-between border-b border-panel-border px-4 py-2">
          <h3 className="text-sm font-semibold text-text-bright">Choose observer location</h3>
          <button
            onClick={onCancel}
            className="rounded px-2 py-0.5 pointer-coarse:p-2 text-text-dim hover:bg-white/10 hover:text-text-bright"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="relative flex-1">
          <div ref={mapDivRef} className="absolute inset-0" />

          {/* Search box floats above the map (outside Leaflet's DOM). */}
          <div className="absolute left-2 top-2 z-[1000] flex w-[min(360px,70%)] flex-col gap-1">
            <div className="flex gap-1">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onFocus={() => results.length > 0 && setResultsOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runSearchNow();
                  }
                }}
                placeholder="Search place or address…"
                className="w-full rounded border border-panel-border bg-black/70 px-2 py-1 text-xs text-text-bright shadow outline-none focus:border-orange-300/60"
              />
              <button
                onClick={runSearchNow}
                disabled={searching}
                className="rounded border border-panel-border bg-black/70 px-2 py-1 pointer-coarse:py-2 text-xs text-text-bright shadow hover:bg-white/10 disabled:opacity-50"
              >
                {searching ? "…" : "Search"}
              </button>
            </div>

            {/* Typeahead results — click to disambiguate between same-named places. */}
            {resultsOpen && results.length > 0 && (
              <ul className="max-h-56 overflow-y-auto rounded border border-panel-border bg-panel-bg/95 shadow-lg backdrop-blur">
                {results.map((r, i) => (
                  <li key={`${r.lat},${r.lon},${i}`}>
                    <button
                      onClick={() => selectResult(r)}
                      className="block w-full truncate px-2 py-1 pointer-coarse:py-2.5 text-left text-[11px] text-text-bright hover:bg-white/10"
                      title={r.label}
                    >
                      {r.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {searchError && (
              <span className="rounded bg-black/70 px-2 py-0.5 text-[11px] text-red-300 shadow">
                {searchError}
              </span>
            )}
          </div>

          <div className="pointer-events-none absolute bottom-2 left-2 z-[1000] rounded bg-black/70 px-2 py-0.5 text-[11px] text-text-dim shadow">
            Click the map or drag the pin to set the site.
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-panel-border px-4 py-2 text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-text-bright">
            <span>
              <span className="text-text-dim">Lat </span>
              {formatDMS(pos.lat)}{" "}
              <span className="text-text-dim">({pos.lat.toFixed(5)}°)</span>
            </span>
            <span>
              <span className="text-text-dim">Lon </span>
              {formatDMS(pos.lon)}{" "}
              <span className="text-text-dim">({pos.lon.toFixed(5)}°)</span>
            </span>
            <span>
              <span className="text-text-dim">Alt </span>
              {elevLoading ? "…" : `${Math.round(alt)} m`}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="rounded border border-panel-border bg-white/5 px-3 py-1 pointer-coarse:py-2 uppercase tracking-wide text-[11px] text-text-dim hover:bg-white/10 hover:text-text-bright"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm({ lat: pos.lat, lon: pos.lon, alt: Math.round(alt) })}
              className="rounded border border-orange-300/60 bg-orange-300/15 px-3 py-1 pointer-coarse:py-2 uppercase tracking-wide text-[11px] text-orange-200 hover:bg-orange-300/25"
            >
              Use this location
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
