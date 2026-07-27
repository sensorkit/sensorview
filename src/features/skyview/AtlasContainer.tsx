import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { loadStarCatalog, type StarCatalog } from "./catalog/stars";
import { loadConstellations, type Constellation } from "./catalog/constellations";
import { loadLandGeoJSON, loadLandGeoJSONCoarse } from "./catalog/earth";
import { useSatellitePropagation } from "./hooks/useSatellitePropagation";
import { useViewTransition } from "./hooks/useViewTransition";
import { useObserver, zenithRADec } from "./hooks/useObserver";
import { useStarAltitudes } from "./hooks/useStarAltitudes";
import { MountActivityIndicator } from "./ui/MountActivityIndicator";
import { useSkyViewStore } from "../../stores/skyview";
import { satKeyId, satKeyOf, useSatelliteStore } from "../../stores/satellites";
import { fetchTLECatalog, getTLEStatus, refreshTLECache } from "../../lib/api-client/tle";
import { LeftRail } from "./ui/LeftRail";
import { CatalogColumn } from "./ui/CatalogColumn";
import { SkyHUD } from "./ui/SkyHUD";
import { AlmanacStrip } from "./ui/AlmanacStrip";
import { SkyCanvas } from "./views/SkyCanvas";
import { OverheadCanvas } from "./views/OverheadCanvas";
import { GroundTrackCanvas } from "./views/GroundTrackCanvas";
import { usePaneResize } from "../panels/usePaneResize";
import { useCompactLayout } from "../../lib/useMediaQuery";

// V4 layout constants — see design_handoff_skyview/README.md
const LEFT_RAIL_WIDTH = 68;
// Catalog column is user-resizable (persisted in the SkyView store). Dragging
// the divider narrows the catalog to give the sky renderer more room; the
// catalog's row table scrolls horizontally once it dips below its natural
// width. Bounds keep the header tabs on one line at the low end and leave the
// sky usable at the high end.
const CATALOG_MIN = 260;
const CATALOG_MAX = 640;
const ALMANAC_HEIGHT = 70;
const FOOTER_HEIGHT = 40;

export function AtlasContainer() {
  const containerRef = useRef<HTMLDivElement>(null);

  // Below lg the three-column atlas doesn't fit: the rail becomes a top bar,
  // the catalog becomes a toggleable bottom sheet, and the almanac/footer
  // stack in flow. Desktop keeps the absolute V4 layout untouched.
  const compact = useCompactLayout();
  const [sheetOpen, setSheetOpen] = useState(false);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [catalog, setCatalog] = useState<StarCatalog | null>(null);
  const [constellations, setConstellations] = useState<Constellation[]>([]);
  const [landGeoJSON, setLandGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null);
  const [landGeoJSONCoarse, setLandGeoJSONCoarse] = useState<GeoJSON.FeatureCollection | null>(null);
  const observerKeyRef = useRef<string | null>(null);
  const [status, setStatus] = useState<string | null>("Initializing...");

  const {
    viewMode,
    setCenter,
  } = useSkyViewStore();

  // User-adjustable width of the catalog column. The grip lives on the
  // column's left edge, so dragging left widens the catalog (invert) and
  // dragging right hands that space back to the sky renderer.
  const catalogWidth = useSkyViewStore((s) => s.catalogWidth);
  const setCatalogWidth = useSkyViewStore((s) => s.setCatalogWidth);
  const catalogGrip = usePaneResize("x", catalogWidth, setCatalogWidth, {
    min: CATALOG_MIN,
    max: CATALOG_MAX,
    invert: true,
  });

  const positions = useSatelliteStore((s) => s.positions);
  const tles = useSatelliteStore((s) => s.tles);
  const filter = useSatelliteStore((s) => s.filter);
  const setTLEs = useSatelliteStore((s) => s.setTLEs);

  const { observer } = useObserver();

  const setGroundTrackCenter = useSkyViewStore((s) => s.setGroundTrackCenter);

  // Drive view transition animation
  useViewTransition();

  // Initialize view centers — re-centers whenever the observer location
  // changes (e.g. site data arrives after connecting to SK) so the first
  // render doesn't get stuck on the Haleakala fallback's meridian.
  useEffect(() => {
    const key = `${observer.lat.toFixed(3)}|${observer.lon.toFixed(3)}`;
    if (observerKeyRef.current === key) return;
    observerKeyRef.current = key;
    // Center on the observer's zenith: horizon circle ends up centered on
    // screen. For northern-hemisphere sites the d3-stereographic's rotation
    // keeps celestial north at the top naturally.
    const z = zenithRADec(new Date(), observer);
    setCenter(z.ra, z.dec);
    setGroundTrackCenter(observer.lon, 0);
  }, [observer, setCenter, setGroundTrackCenter]);

  // Start satellite propagation — compute geodetic coords for overhead/groundtrack views
  const computeGeodetic = viewMode !== "sky";
  useSatellitePropagation(observer, computeGeodetic);

  // Index TLEs by noradId ONCE per catalog change — NOT on every 10Hz position
  // tick. `tles` is a stable store reference between refreshes (setPositions only
  // touches `positions`), so this memo holds and the 10Hz filters below just do
  // O(1) lookups instead of rebuilding a 32k-entry Map twice per tick.
  // Keyed by satKeyId, not a bare NORAD id: an object can hold both a TLE and
  // a state vector, and keying on the id alone would collapse them.
  const tleMap = useMemo(
    () => new Map(tles.map((t) => [satKeyId(satKeyOf(t)), t])),
    [tles],
  );

  // Filter: above horizon + rising within 15 min, filtered by regime
  const filteredPositions = useMemo(() => {
    return positions.filter((p) => {
      const isAbove = p.alt > 0;
      const isRisingSoon = p.riseInMinutes !== null && p.riseInMinutes <= 15;
      if (!isAbove && !isRisingSoon) return false;
      const tle = tleMap.get(satKeyId(p));
      const regime = tle?.orbitRegime ?? "OTHER";
      if (!filter.orbitRegimes.has(regime)) return false;
      return true;
    });
  }, [positions, tleMap, filter]);

  // For overhead/ground track: all satellites filtered by regime only (no horizon check)
  const regimeFilteredPositions = useMemo(() => {
    // Only overhead/groundtrack render this, and they request the full set via
    // computeGeodetic. In sky view the worker ships only above-horizon sats, so
    // computing it here would be incomplete AND unused — skip it.
    if (viewMode === "sky") return [];
    return positions.filter((p) => {
      const tle = tleMap.get(satKeyId(p));
      const regime = tle?.orbitRegime ?? "OTHER";
      return filter.orbitRegimes.has(regime);
    });
  }, [positions, tleMap, filter, viewMode]);

  // Load catalog data. Re-runs whenever the user toggles HR↔HIP in the
  // Stars chevron so the column + SkyView render switch over together.
  // HR is small (~95 KB) so the first switch is near-instant; HIP is the
  // ~1.5 MB gzip and takes a beat on first load (cached afterward).
  const starCatalogKind = useSkyViewStore((s) => s.starCatalog);
  useEffect(() => {
    setStatus("Loading star catalog...");
    Promise.all([
      loadStarCatalog(starCatalogKind).then((c) => { setCatalog(c); return c; }),
      loadConstellations().then((c) => { setConstellations(c); return c; }),
      loadLandGeoJSON().then((g) => { setLandGeoJSON(g); return g; }),
      loadLandGeoJSONCoarse().then((g) => { setLandGeoJSONCoarse(g); return g; }),
    ]).then(([stars, cons]) => {
      setStatus(`Loaded ${stars.stars.length} stars, ${cons.length} constellations`);
    });
  }, [starCatalogKind]);

  // Fetch TLEs from cache, optionally forcing a Spacebook refresh first
  const loadTLEs = useCallback(async (forceRefresh = false) => {
    setStatus("loading");
    try {
      if (forceRefresh) {
        setStatus("Refreshing satellite catalog...");
        await refreshTLECache();
      }
      const tleData = await fetchTLECatalog();
      setTLEs(tleData);
      setStatus(null);
    } catch {
      try {
        const tleData = await fetchTLECatalog();
        setTLEs(tleData);
      } catch { /* empty */ }
      setStatus(null);
    }
  }, [setTLEs]);

  // On mount: auto-refresh if cache is seed-only or stale
  useEffect(() => {
    getTLEStatus().then((s) => {
      const needsRefresh = s.lastRefresh === null || (s.cacheAgeHours ?? Infinity) > 12;
      loadTLEs(needsRefresh);
    }).catch(() => loadTLEs(false));
  }, [loadTLEs]);

  // Observe container resize. Keyed on `compact` because the scene div is a
  // different element in each layout branch — the observer must re-attach
  // when the viewport crosses the breakpoint.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [compact]);

  // The bottom-right `CATALOG N ▲ / N ≤ M` chip reflects whichever
  // catalog tab is currently active in the right-hand column, mirroring
  // the SkyHUD chips. Counts derive from whatever data feeds the
  // corresponding list.
  const catalogTab = useSkyViewStore((s) => s.catalogTab);
  const selectedHorizonsTarget = useSkyViewStore((s) => s.selectedHorizonsTarget);
  const starAlts = useStarAltitudes(catalog, observer);
  const { visibleCount, totalCount } = useMemo(() => {
    if (catalogTab === "stars") {
      return {
        visibleCount: starAlts.filter((s) => s.alt > 0).length,
        totalCount: catalog?.stars.length ?? 0,
      };
    }
    if (catalogTab === "horizons") {
      // No fixed catalog to count — reflect the single selected target.
      const n = selectedHorizonsTarget ? 1 : 0;
      return { visibleCount: n, totalCount: n };
    }
    return {
      visibleCount: positions.filter((p) => p.isVisible).length,
      totalCount: tles.length,
    };
  }, [catalogTab, starAlts, catalog, selectedHorizonsTarget, positions, tles]);

  // Scene + HUD are identical in both layouts; only the wrapper differs.
  const scene = (
    <>
      <div ref={containerRef} className="absolute inset-0">
        {viewMode === "sky" && (
          <SkyCanvas
            size={size}
            catalog={catalog}
            constellations={constellations}
            observer={observer}
            filteredPositions={filteredPositions}
          />
        )}
        {viewMode === "overhead" && (
          <OverheadCanvas
            size={size}
            observer={observer}
            positions={regimeFilteredPositions}
            landGeoJSON={landGeoJSONCoarse}
          />
        )}
        {viewMode === "groundtrack" && (
          <GroundTrackCanvas
            size={size}
            observer={observer}
            positions={regimeFilteredPositions}
            landGeoJSON={landGeoJSON}
          />
        )}
      </div>

      <SkyHUD
        canvasWidth={size.width}
        canvasHeight={size.height}
        catalog={catalog}
      />
    </>
  );

  // inline-flex with items-center keeps the ▲ and ≤ glyphs vertically aligned
  // with the digits (their natural baselines differ in the mono font), and the
  // explicit gap gives them breathing room.
  const catalogCounts = (
    <span className="mono inline-flex items-center" style={{ gap: 6 }}>
      <span>{visibleCount}</span>
      <span>▲</span>
      <span>/</span>
      <span>N</span>
      <span>≤</span>
      <span>{totalCount}</span>
    </span>
  );
  const version = (
    <span className="mono text-paper-muted" style={{ fontSize: 10 }}>
      v{__APP_VERSION__}
    </span>
  );

  const footerContent = (
    <>
      <span
        className="text-brass font-semibold uppercase"
        style={{ fontSize: 10, letterSpacing: 1.5 }}
      >
        Observer
      </span>
      <span className="mono min-w-0 truncate">
        {formatDMS(observer.lat, "lat")} · {formatDMS(observer.lon, "lon")} ·{" "}
        {observer.alt.toFixed(0)} m
      </span>
      <MountActivityIndicator />
      <button
        className="mono text-[10px] px-2 py-0.5 pointer-coarse:py-1.5 pointer-coarse:px-2.5 rounded-sm text-paper-dim hover:text-paper"
        style={{ border: "1px solid var(--color-brass-dim)" }}
        onClick={() => loadTLEs(true)}
        disabled={status === "loading" || status === "Refreshing satellite catalog..."}
      >
        {status === "Refreshing satellite catalog..." ? "refreshing…" : "refresh TLE"}
      </button>
      {compact ? (
        // Keep the catalog label, counts, and version as one right-aligned
        // block — label on top, counts + version beneath — so the counts can't
        // orphan onto their own line away from the "Catalog" heading.
        <div className="ml-auto flex flex-col items-end leading-tight">
          <span
            className="text-brass font-semibold uppercase"
            style={{ fontSize: 10, letterSpacing: 1.5 }}
          >
            Catalog
          </span>
          <span className="flex items-center gap-2">
            {catalogCounts}
            {version}
          </span>
        </div>
      ) : (
        <>
          <span
            className="text-brass font-semibold uppercase ml-auto"
            style={{ fontSize: 10, letterSpacing: 1.5 }}
          >
            Catalog
          </span>
          {catalogCounts}
          {version}
        </>
      )}
    </>
  );

  if (compact) {
    return (
      <div className="w-full h-full relative overflow-hidden bg-sky-ink text-paper flex flex-col">
        {/* Rail as a horizontal top bar */}
        <div
          className="shrink-0 bg-rail-ink z-[4]"
          style={{ borderBottom: "1px solid rgba(184,138,63,0.28)" }}
        >
          <LeftRail horizontal />
        </div>

        {/* Sky scene region — `isolate` keeps the HUD's z-indexes local so the
            catalog sheet (a later sibling) always paints above them */}
        <div className="relative isolate flex-1 min-h-0">
          {scene}
          {/* Catalog sheet toggle — the compact stand-in for the right column */}
          <button
            type="button"
            onClick={() => setSheetOpen((v) => !v)}
            className="absolute bottom-2.5 right-2.5 z-[6] px-3.5 py-2 rounded-full text-[11px] font-semibold uppercase bg-paper text-ink shadow-lg cursor-pointer"
            style={{ border: "1px solid var(--color-brass)", letterSpacing: 1 }}
          >
            Catalog ▴
          </button>
        </div>

        {/* Almanac strip — auto height so the header can wrap on phones.
            overflow-hidden clips the timeline's deliberately-oversized inner
            content (desktop relies on the atlas root for this). */}
        <div
          className="shrink-0 z-[3] overflow-hidden"
          style={{
            background: "rgba(244,234,212,0.96)",
            borderTop: "1px solid var(--color-brass)",
            borderBottom: "1px solid var(--color-brass-dim)",
          }}
        >
          <AlmanacStrip />
        </div>

        {/* Status footer — wraps instead of clipping */}
        <footer
          className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5 text-[11px] text-paper-dim z-[5]"
          style={{
            background: "var(--color-topbar-ink)",
            borderTop: "1px solid var(--color-brass-dim)",
          }}
        >
          {footerContent}
        </footer>

        {/* Catalog bottom sheet */}
        {sheetOpen && (
          <div
            className="absolute inset-x-0 bottom-0 top-[22%] z-[7] flex flex-col bg-paper shadow-[0_-10px_28px_rgba(0,0,0,0.55)]"
            style={{ borderTop: "1px solid var(--color-brass)" }}
          >
            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              className="shrink-0 w-full py-1.5 text-[11px] uppercase text-paper-dim hover:text-ink cursor-pointer"
              style={{
                borderBottom: "1px solid var(--color-brass-dim)",
                letterSpacing: 1,
              }}
              aria-label="Close catalog"
            >
              ▾ close
            </button>
            <div className="flex-1 min-h-0">
              <CatalogColumn loading={status === "loading"} catalog={catalog} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full h-full relative overflow-hidden bg-sky-ink text-paper">
      {/* Left rail — view modes + orbit regime chips */}
      <aside
        className="absolute left-0 top-0 bg-rail-ink z-[4]"
        style={{
          width: LEFT_RAIL_WIDTH,
          bottom: FOOTER_HEIGHT,
          borderRight: "1px solid rgba(184,138,63,0.28)",
        }}
      >
        <LeftRail />
      </aside>

      {/* Sky scene region */}
      <div
        className="absolute"
        style={{
          left: LEFT_RAIL_WIDTH,
          right: catalogWidth,
          top: 0,
          bottom: ALMANAC_HEIGHT + FOOTER_HEIGHT,
        }}
      >
        {scene}
      </div>

      {/* Almanac strip — sun / twilight / moon over 24h for the observer */}
      <div
        className="absolute z-[3]"
        style={{
          left: LEFT_RAIL_WIDTH,
          right: catalogWidth,
          bottom: FOOTER_HEIGHT,
          height: ALMANAC_HEIGHT,
          background: "rgba(244,234,212,0.96)",
          borderTop: "1px solid var(--color-brass)",
          borderBottom: "1px solid var(--color-brass-dim)",
        }}
      >
        <AlmanacStrip />
      </div>

      {/* Catalog column — user-resizable paper panel (default 354px) */}
      <aside
        className="absolute z-[3] bg-paper"
        style={{
          right: 0,
          top: 0,
          bottom: FOOTER_HEIGHT,
          width: catalogWidth,
          borderLeft: "1px solid var(--color-brass)",
          boxShadow: "inset 3px 0 0 rgba(184,138,63,0.1)",
        }}
      >
        {/* Resize grip on the column's left edge. Drag left/right to trade
            width between the catalog and the sky renderer — same pointer-
            capture grip used by the right-dock pop-outs. */}
        <div
          onPointerDown={catalogGrip}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-brass/40 z-20"
          title="Drag to resize the sky view"
        />
        <CatalogColumn loading={status === "loading"} catalog={catalog} />
      </aside>

      {/* Status footer — 40px, V4 styling */}
      <footer
        className="absolute bottom-0 left-0 right-0 flex items-center gap-[18px] px-5 text-[11px] text-paper-dim z-[5]"
        style={{
          height: FOOTER_HEIGHT,
          background: "var(--color-topbar-ink)",
          borderTop: "1px solid var(--color-brass-dim)",
        }}
      >
        {footerContent}
      </footer>
    </div>
  );
}

function formatDMS(deg: number, kind: "lat" | "lon"): string {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60);
  const hemi = kind === "lat" ? (deg >= 0 ? "N" : "S") : deg >= 0 ? "E" : "W";
  return `${d}°${String(m).padStart(2, "0")}′${String(s).padStart(2, "0")}″ ${hemi}`;
}
