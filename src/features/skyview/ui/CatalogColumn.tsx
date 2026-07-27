import { useEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import { SVEpochBadge, SVEpochNotice } from "./SVEpochBadge";
import {
  isSV,
  sameSatKey,
  satKeyId,
  satKeyOf,
  satLabel,
  useSatelliteStore,
  type CatalogRecord,
  type SatellitePosition,
  type SatKey,
} from "../../../stores/satellites";
import { useSkyViewStore, type HorizonsSelection } from "../../../stores/skyview";
import { useObserver, radecToAltAz, type ObserverLocation } from "../hooks/useObserver";
import { useStarAltitudes } from "../hooks/useStarAltitudes";
import { useSolarSystemBodies, type SolarBody } from "../hooks/useSolarSystemBodies";
import { fetchTLECatalog } from "../../../lib/api-client/tle";
import {
  lookupHorizons,
  fetchHorizonsEphemeris,
  totalRateArcsecHr,
  type HorizonsLookup,
} from "../../../lib/api-client/horizons";
import { previewWindow } from "../horizons/window";
import { regimeColor } from "../layers/regimeColors";
import { type StarCatalog, getStarName, getStarLabel } from "../catalog/stars";
import { ActionButtons, type ActionTarget } from "./DetailSheet";

type Tab = "satellites" | "stars" | "horizons";

const RISE_SOON_MIN = 30;

interface Props {
  loading?: boolean;
  catalog: StarCatalog | null;
}

/**
 * V4 "Atlas Observatory" catalog column — 354 px paper-themed panel on the
 * right edge of SkyView. Replaces the floating SatelliteListPanel + DetailSheet.
 */
export function CatalogColumn({ loading = false, catalog }: Props) {
  // Active segment lives in the SkyView store so the SkyHUD's stat chips
  // (above-horizon counts, etc.) can react to it without a prop-drill.
  const tab = useSkyViewStore((s) => s.catalogTab) as Tab;
  const setTab = useSkyViewStore((s) => s.setCatalogTab);
  const [searchText, setSearchText] = useState("");
  // Filter panel is hidden by default. Toggled per-tab via the sliders
  // icon next to the search input. Stars and Satellites share this flag —
  // only one tab is visible at a time, so a single bool is sufficient.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Satellites + Solar tabs share a single ALT-direction toggle. Stars has
  // two sortable columns (Alt and Mag) so it gets its own (col, dir) state.
  const [altSort, setAltSort] = useState<"desc" | "asc">("desc");
  const toggleAltSort = () => setAltSort((s) => (s === "desc" ? "asc" : "desc"));
  const [starsSort, setStarsSort] = useState<{
    col: "alt" | "mag";
    dir: "desc" | "asc";
  }>({ col: "alt", dir: "desc" });
  // Stable identity so the memoized StarRows doesn't re-render on every
  // unrelated parent re-render — CatalogColumn re-renders ~60×/s while
  // sensorkit streams (its store subscriptions fire per record).
  const onStarsHeaderClick = useCallback(
    (col: "alt" | "mag") =>
      setStarsSort((s) =>
        s.col === col
          ? { col, dir: s.dir === "desc" ? "asc" : "desc" }
          : { col, dir: "desc" },
      ),
    [],
  );
  const searchInputRef = useRef<HTMLInputElement>(null);

  const positions = useSatelliteStore((s) => s.positions);
  const tles = useSatelliteStore((s) => s.tles);
  const addTLE = useSatelliteStore((s) => s.addTLE);
  const filter = useSatelliteStore((s) => s.filter);

  const {
    selectedSatellite,
    selectedStarIndex,
    selectedBodyName,
    selectedHorizonsTarget,
    manualTarget,
    selectSatellite,
    selectStar,
    selectBody,
    selectHorizonsTarget,
    clearManualTarget,
    setDetailSheetOpen,
  } = useSkyViewStore();

  const { observer } = useObserver();
  const starAlts = useStarAltitudes(catalog, observer);
  const bodies = useSolarSystemBodies(observer);

  // "/" keybind focuses the search input, matching the design
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Debounced full-catalog search for the satellites tab
  const [searchResults, setSearchResults] = useState<CatalogRecord[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (tab !== "satellites" || searchText.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      fetchTLECatalog(searchText)
        .then(setSearchResults)
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [searchText, tab]);

  // Keyed by satKeyId: a bare NORAD id would collapse an object's TLE and SV
  // records onto a single entry, and lookups would silently return whichever
  // was inserted last.
  const tleMap = useMemo(
    () => new Map(tles.map((t) => [satKeyId(satKeyOf(t)), t])),
    [tles],
  );

  const altCmp = (a: { alt: number }, b: { alt: number }) =>
    altSort === "desc" ? b.alt - a.alt : a.alt - b.alt;

  // Tab-scoped filters. Ephemeral (not persisted) — they're a "narrow the
  // current view" tool, not a long-lived preference. Min/max bounds are
  // independent (either, both, or neither can be set). For star type, an
  // empty set means "no filter" (show all including null-spec); a
  // non-empty set means "only these spectral classes".
  const [satFilter, setSatFilter] = useState<{
    altMin: number | null;
    altMax: number | null;
  }>({ altMin: null, altMax: null });
  const [starFilter, setStarFilter] = useState<{
    types: Set<string>;
    raMin: number | null;
    raMax: number | null;
    decMin: number | null;
    decMax: number | null;
    altMin: number | null;
    altMax: number | null;
    magMin: number | null;
    magMax: number | null;
  }>({
    types: new Set<string>(),
    raMin: null,
    raMax: null,
    decMin: null,
    decMax: null,
    altMin: null,
    altMax: null,
    magMin: null,
    magMax: null,
  });

  const inMinMax = (
    value: number,
    min: number | null,
    max: number | null,
  ): boolean =>
    (min == null || value >= min) && (max == null || value <= max);

  const { aboveList, risingList } = useMemo(() => {
    const inRegime = (p: SatellitePosition) => {
      const tle = tleMap.get(satKeyId(p));
      return filter.orbitRegimes.has(tle?.orbitRegime ?? "OTHER");
    };
    const q = searchText.trim().toLowerCase();
    const matchText = (p: SatellitePosition) => {
      if (!q) return true;
      const name = tleMap.get(satKeyId(p))?.name ?? p.noradId;
      return name.toLowerCase().includes(q) || p.noradId.includes(q);
    };

    const altOk = (alt: number) => inMinMax(alt, satFilter.altMin, satFilter.altMax);
    const above = positions
      .filter(
        (p) =>
          p.alt > 0 &&
          inRegime(p) &&
          matchText(p) &&
          altOk(p.alt),
      )
      .sort(altCmp)
      .slice(0, 200);
    const rising = positions
      .filter(
        (p) =>
          p.alt <= 0 &&
          p.riseInMinutes !== null &&
          p.riseInMinutes <= RISE_SOON_MIN &&
          inRegime(p) &&
          matchText(p) &&
          altOk(p.alt),
      )
      .sort((a, b) => (a.riseInMinutes ?? 999) - (b.riseInMinutes ?? 999))
      .slice(0, 50);
    return { aboveList: above, risingList: rising };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, tleMap, filter, searchText, altSort, satFilter]);

  const visibleStars = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    // Without a search query, restrict to above-horizon (the default
    // "what's up right now" view). With a query, drop the horizon filter
    // so the user can find any star — Alkarab below the horizon should
    // still be discoverable by typing "alkarab" or its HR/HIP id.
    let list = q ? starAlts : starAlts.filter((s) => s.alt > 0);
    if (q) {
      list = list.filter((s) => {
        // Match against the displayed name (proper name when known, else
        // the bare catalog id) AND against the raw catalog id string.
        // That way "alkarab" finds the named star and "8905" finds the
        // same star by its HR id without needing the user to know
        // whether it has a proper name or not.
        if ((s.name ?? "").toLowerCase().includes(q)) return true;
        if (String(s.id).includes(q)) return true;
        return false;
      });
    }
    // Apply panel filters. Empty types set => no type filter; otherwise
    // only stars whose spectral letter is in the set (null-spec stars
    // drop out when the set is non-empty).
    const { types, raMin, raMax, decMin, decMax, altMin, altMax, magMin, magMax } =
      starFilter;
    const typeActive = types.size > 0;
    list = list.filter((s) => {
      if (typeActive && (s.spec == null || !types.has(s.spec))) return false;
      if (!inMinMax(s.ra, raMin, raMax)) return false;
      if (!inMinMax(s.dec, decMin, decMax)) return false;
      if (!inMinMax(s.alt, altMin, altMax)) return false;
      if (!inMinMax(s.mag, magMin, magMax)) return false;
      return true;
    });
    return list
      .sort((a, b) => {
        const av = starsSort.col === "alt" ? a.alt : a.mag;
        const bv = starsSort.col === "alt" ? b.alt : b.mag;
        return starsSort.dir === "desc" ? bv - av : av - bv;
      })
      .slice(0, 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starAlts, searchText, starsSort, starFilter]);

  const selectedTle = selectedSatellite ? tleMap.get(satKeyId(selectedSatellite)) : undefined;
  const selectedSat = selectedSatellite
    ? positions.find((p) => sameSatKey(p, selectedSatellite))
    : undefined;
  const selectedStar =
    selectedStarIndex !== null && catalog
      ? starAlts.find((s) => s.index === selectedStarIndex)
      : undefined;
  const selectedBody = selectedBodyName
    ? bodies.find((b) => b.name === selectedBodyName)
    : undefined;

  const close = () => {
    selectSatellite(null);
    selectStar(null);
    selectBody(null);
    selectHorizonsTarget(null);
    clearManualTarget();
    setDetailSheetOpen(false);
  };

  const hasSelection =
    selectedSat ||
    selectedStar ||
    selectedBody ||
    selectedHorizonsTarget ||
    manualTarget !== null;

  return (
    <div
      className="h-full w-full flex flex-col overflow-hidden"
      style={{ background: "var(--color-paper)", color: "var(--color-ink)" }}
    >
      {/* Header */}
      <div
        className="px-[18px] pt-[14px] pb-[10px]"
        style={{ borderBottom: "1px solid rgba(199,184,143,0.5)" }}
      >
        <div className="flex items-baseline justify-between">
          <div>
            <div
              className="serif"
              style={{
                fontSize: 19,
                fontWeight: 600,
                letterSpacing: 0.2,
                color: "var(--color-ink)",
              }}
            >
              Catalog
            </div>
            {tab !== "horizons" && (
              <div
                className="mt-[3px]"
                style={{ fontSize: 11.5, color: "var(--color-paper-dim)" }}
              >
                Objects above the local horizon
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-[3px] mt-[10px]">
          {(["satellites", "stars", "horizons"] as Tab[]).map((t) => {
            const active = tab === t;
            // Stars button is special when active: it shows the current
            // catalog name and acts as the HR/HIP chevron trigger. When
            // inactive it behaves like the other segment buttons.
            if (t === "stars" && active) {
              return (
                <StarsActiveButton
                  key={t}
                  onActivate={() => {
                    setTab(t);
                    setSearchText("");
                  }}
                />
              );
            }
            return (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTab(t);
                  setSearchText("");
                }}
                className="rounded-sm font-medium"
                style={{
                  padding: "4px 11px",
                  fontSize: 11,
                  background: active ? "var(--color-ink)" : "transparent",
                  color: active ? "var(--color-paper)" : "var(--color-paper-dim)",
                  border: active
                    ? "none"
                    : "1px solid rgba(199,184,143,0.5)",
                  textTransform: "capitalize",
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
      </div>

      {/* Search row */}
      <div
        className="flex items-center gap-2 px-[18px] py-[8px]"
        style={{
          borderBottom: "1px solid rgba(199,184,143,0.5)",
          fontSize: 11.5,
        }}
      >
        {(tab === "satellites" || tab === "stars") && (
          <FilterToggleButton
            open={filtersOpen}
            active={
              tab === "satellites"
                ? satFilter.altMin != null || satFilter.altMax != null
                : starFilter.types.size > 0 ||
                  starFilter.raMin != null ||
                  starFilter.raMax != null ||
                  starFilter.decMin != null ||
                  starFilter.decMax != null ||
                  starFilter.altMin != null ||
                  starFilter.altMax != null ||
                  starFilter.magMin != null ||
                  starFilter.magMax != null
            }
            onClick={() => setFiltersOpen((v) => !v)}
          />
        )}
        <SearchIcon />
        <input
          ref={searchInputRef}
          type="text"
          value={searchText}
          placeholder="Search catalog…"
          onChange={(e) => setSearchText(e.target.value)}
          className="flex-1 bg-transparent outline-none"
          style={{ color: "var(--color-ink)", fontSize: 11.5 }}
        />
        <span
          className="mono"
          style={{
            fontSize: 9,
            color: "var(--color-paper-dim)",
            letterSpacing: 0.5,
          }}
        >
          /
        </span>
      </div>

      {/* Filter panel — tab-aware, hidden until the sliders icon is toggled.
          Solar has no filters today. */}
      {filtersOpen && tab === "satellites" && (
        <SatelliteFilterPanel value={satFilter} onChange={setSatFilter} />
      )}
      {filtersOpen && tab === "stars" && (
        <StarFilterPanel value={starFilter} onChange={setStarFilter} />
      )}

      {/* Scrollable rows + grouping */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === "satellites" && (
          <SatelliteRows
            loading={loading}
            searching={searching}
            searchText={searchText}
            searchResults={searchResults}
            aboveList={aboveList}
            risingList={risingList}
            positions={positions}
            tleMap={tleMap}
            selectedKey={selectedSatellite}
            onSelectExisting={selectSatellite}
            onSelectFromSearch={(tle) => {
              addTLE(tle);
              selectSatellite(satKeyOf(tle));
            }}
            altSort={altSort}
            onToggleAltSort={toggleAltSort}
          />
        )}
        {tab === "stars" && (
          <StarRows
            loading={loading}
            stars={visibleStars}
            catalog={catalog}
            selectedIndex={selectedStarIndex}
            onSelect={selectStar}
            starsSort={starsSort}
            onHeaderClick={onStarsHeaderClick}
            searching={searchText.trim().length > 0}
          />
        )}
        {tab === "horizons" && (
          <HorizonsPanel searchText={searchText} observer={observer} />
        )}
      </div>

      {/* Pinned detail panel */}
      {hasSelection && (
        <div
          className="px-[16px] py-[16px]"
          style={{
            background: "var(--color-paper-dark)",
            borderTop: "1px solid var(--color-brass)",
          }}
        >
          {selectedSat ? (
            <SatelliteDetail sat={selectedSat} tle={selectedTle} onClose={close} />
          ) : selectedStar && catalog ? (
            <StarDetail star={selectedStar} catalog={catalog} onClose={close} />
          ) : selectedBody ? (
            <BodyDetail body={selectedBody} onClose={close} />
          ) : selectedHorizonsTarget ? (
            <HorizonsDetail target={selectedHorizonsTarget} onClose={close} />
          ) : manualTarget ? (
            <ManualTargetDetail
              ra={manualTarget.ra}
              dec={manualTarget.dec}
              onClose={close}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ---------------- Sub-components ---------------- */

function ColumnHeader({
  altSort,
  onToggleAltSort,
}: {
  altSort: "desc" | "asc";
  onToggleAltSort: () => void;
}) {
  return (
    <div
      className="uppercase"
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 42px 60px",
        gap: 10,
        padding: "5px 18px",
        fontSize: 9.5,
        letterSpacing: 1.1,
        color: "var(--color-paper-dim)",
        borderBottom: "1px solid rgba(199,184,143,0.5)",
      }}
    >
      <span>Name</span>
      <AltSortHeader altSort={altSort} onClick={onToggleAltSort} />
      <span className="text-right">Event</span>
    </div>
  );
}

/**
 * Clickable column header that toggles a sort direction. The ▼/▲ triangle
 * only renders when this column is the *active* sort key — otherwise the
 * header reads as a plain non-active option the user can switch to.
 */
function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "desc" | "asc";
  onClick: () => void;
}) {
  const title = active
    ? `Sort by ${label} ${dir === "desc" ? "ascending" : "descending"}`
    : `Sort by ${label}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="text-right cursor-pointer hover:opacity-80 uppercase"
      style={{
        color: "var(--color-terracotta)",
        background: "transparent",
        border: "none",
        padding: 0,
        fontSize: "inherit",
        letterSpacing: "inherit",
        fontFamily: "inherit",
      }}
    >
      {label} {active ? (dir === "desc" ? "▼" : "▲") : ""}
    </button>
  );
}

/** Convenience wrapper for tabs where Alt is the only sortable column. */
function AltSortHeader({
  altSort,
  onClick,
}: {
  altSort: "desc" | "asc";
  onClick: () => void;
}) {
  return <SortHeader label="Alt" active dir={altSort} onClick={onClick} />;
}

function BulletDot() {
  return (
    <span style={{ color: "var(--color-paper-dim)", fontSize: 9 }}>·</span>
  );
}

// === Filter panels =====================================================

/**
 * Compact paper-themed number input that accepts an optional bound and
 * surfaces `null` when blank. Used inside the filter panels for all
 * "min/max" pairs — caller decides what unit/range it represents.
 */
function NumInput({
  value,
  placeholder,
  onChange,
}: {
  value: number | null;
  placeholder: string;
  onChange: (v: number | null) => void;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          onChange(null);
          return;
        }
        const parsed = Number(raw);
        onChange(Number.isFinite(parsed) ? parsed : null);
      }}
      className="mono"
      style={{
        width: "100%",
        padding: "2px 5px",
        fontSize: 10.5,
        background: "rgba(244,234,212,0.6)",
        color: "var(--color-ink)",
        border: "1px solid rgba(199,184,143,0.45)",
        borderRadius: 2,
        outline: "none",
        textAlign: "right",
        minWidth: 0,
      }}
    />
  );
}

/** One filter row: a label and a min–max pair of NumInputs. */
function MinMaxRow({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  min: number | null;
  max: number | null;
  onMin: (v: number | null) => void;
  onMax: (v: number | null) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "32px 1fr 8px 1fr",
        gap: 6,
        alignItems: "center",
      }}
    >
      <span
        className="uppercase"
        style={{
          fontSize: 9,
          letterSpacing: 0.8,
          color: "var(--color-paper-dim)",
        }}
      >
        {label}
      </span>
      <NumInput value={min} placeholder="min" onChange={onMin} />
      <span
        style={{
          fontSize: 10,
          color: "var(--color-paper-dim)",
          textAlign: "center",
        }}
      >
        –
      </span>
      <NumInput value={max} placeholder="max" onChange={onMax} />
    </div>
  );
}

function SatelliteFilterPanel({
  value,
  onChange,
}: {
  value: { altMin: number | null; altMax: number | null };
  onChange: (next: { altMin: number | null; altMax: number | null }) => void;
}) {
  return (
    <div
      style={{
        padding: "6px 18px 8px",
        borderBottom: "1px solid rgba(199,184,143,0.5)",
        background: "rgba(244,234,212,0.4)",
      }}
    >
      <MinMaxRow
        label="Alt"
        min={value.altMin}
        max={value.altMax}
        onMin={(v) => onChange({ ...value, altMin: v })}
        onMax={(v) => onChange({ ...value, altMax: v })}
      />
    </div>
  );
}

const SPECTRAL_LETTERS = ["O", "B", "A", "F", "G", "K", "M"] as const;

function StarFilterPanel({
  value,
  onChange,
}: {
  value: {
    types: Set<string>;
    raMin: number | null;
    raMax: number | null;
    decMin: number | null;
    decMax: number | null;
    altMin: number | null;
    altMax: number | null;
    magMin: number | null;
    magMax: number | null;
  };
  onChange: (next: typeof value) => void;
}) {
  // RA min/max are stored in degrees (so the filter logic stays unit-agnostic
  // against the catalog's degree-valued RA). The input displays whatever
  // unit the user has selected for the RA column. Hours <-> degrees is a
  // 15:1 scale, so we convert at the input boundary.
  const raUnit = useSkyViewStore((s) => s.raUnit);
  const degFromInput = (v: number | null) =>
    v == null ? null : raUnit === "hr" ? v * 15 : v;
  const inputFromDeg = (v: number | null) =>
    v == null ? null : raUnit === "hr" ? v / 15 : v;

  const toggleType = (t: string) => {
    const next = new Set(value.types);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    onChange({ ...value, types: next });
  };
  const setField = <K extends keyof typeof value>(key: K, v: typeof value[K]) =>
    onChange({ ...value, [key]: v });

  const typeActive = value.types.size > 0;

  return (
    <div
      style={{
        padding: "6px 18px 8px",
        borderBottom: "1px solid rgba(199,184,143,0.5)",
        background: "rgba(244,234,212,0.4)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "32px 1fr",
          gap: 6,
          alignItems: "center",
        }}
      >
        <span
          className="uppercase"
          style={{
            fontSize: 9,
            letterSpacing: 0.8,
            color: "var(--color-paper-dim)",
          }}
        >
          Type
        </span>
        <div className="flex" style={{ gap: 4 }}>
          {SPECTRAL_LETTERS.map((t) => {
            const active = value.types.has(t);
            // When the set is empty we treat *everything* as included
            // (no-filter semantics). Dim the chips in that case so it's
            // visually clear that no type filter is active.
            const dimAll = !typeActive;
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleType(t)}
                className="mono w-[18px] h-[18px] pointer-coarse:w-9 pointer-coarse:h-9"
                style={{
                  fontSize: 10,
                  fontWeight: active ? 700 : 400,
                  background: active
                    ? "var(--color-ink)"
                    : dimAll
                      ? "rgba(244,234,212,0.5)"
                      : "transparent",
                  color: active
                    ? "var(--color-paper)"
                    : dimAll
                      ? "var(--color-paper-dim)"
                      : "var(--color-ink)",
                  border: "1px solid rgba(199,184,143,0.5)",
                  borderRadius: 2,
                  cursor: "pointer",
                }}
                title={`Filter to spectral type ${t}`}
              >
                {t}
              </button>
            );
          })}
        </div>
      </div>
      <MinMaxRow
        label="RA"
        min={inputFromDeg(value.raMin)}
        max={inputFromDeg(value.raMax)}
        onMin={(v) => setField("raMin", degFromInput(v))}
        onMax={(v) => setField("raMax", degFromInput(v))}
      />
      <MinMaxRow
        label="Dec"
        min={value.decMin}
        max={value.decMax}
        onMin={(v) => setField("decMin", v)}
        onMax={(v) => setField("decMax", v)}
      />
      <MinMaxRow
        label="Alt"
        min={value.altMin}
        max={value.altMax}
        onMin={(v) => setField("altMin", v)}
        onMax={(v) => setField("altMax", v)}
      />
      <MinMaxRow
        label="Mag"
        min={value.magMin}
        max={value.magMax}
        onMin={(v) => setField("magMin", v)}
        onMax={(v) => setField("magMax", v)}
      />
    </div>
  );
}

/**
 * Display the satellite's name. If the TLE record carries a real name
 * (e.g. "ISS (ZARYA)") show it as-is; if the catalog only has the default
 * "SAT NNNNN" placeholder — or no name at all — render "TLE · NNNNN" with
 * a small dim bullet between TLE and the NORAD id.
 */
function SatName({
  tle,
  noradId,
}: {
  tle: CatalogRecord | undefined;
  noradId: string;
}) {
  const label = satLabel(tle, noradId);
  return (
    <span
      className="inline-flex items-baseline"
      style={{
        color: "var(--color-ink)",
        fontWeight: 500,
        gap: 6,
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <span>{label.prefix}</span>
      <BulletDot />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label.tail}</span>
    </span>
  );
}

function GroupDivider({ label, tone }: { label: string; tone: "sage" | "brass" }) {
  const color = tone === "sage" ? "var(--color-sage)" : "var(--color-brass)";
  const bg = tone === "sage" ? "rgba(107,142,107,0.08)" : "rgba(184,138,63,0.08)";
  return (
    <div
      className="uppercase font-medium"
      style={{
        padding: "4px 18px",
        fontSize: 10,
        color,
        background: bg,
        letterSpacing: 0.9,
      }}
    >
      {label}
    </div>
  );
}

function SatelliteRows({
  loading,
  searching,
  searchText,
  searchResults,
  aboveList,
  risingList,
  positions,
  tleMap,
  selectedKey,
  onSelectExisting,
  onSelectFromSearch,
  altSort,
  onToggleAltSort,
}: {
  loading: boolean;
  searching: boolean;
  searchText: string;
  searchResults: CatalogRecord[];
  aboveList: SatellitePosition[];
  risingList: SatellitePosition[];
  positions: SatellitePosition[];
  tleMap: Map<string, CatalogRecord>;
  selectedKey: SatKey | null;
  onSelectExisting: (key: SatKey) => void;
  onSelectFromSearch: (tle: CatalogRecord) => void;
  altSort: "desc" | "asc";
  onToggleAltSort: () => void;
}) {
  const showCatalogSearch = searchText.length >= 2 && searchResults.length > 0;

  return (
    <>
      <ColumnHeader altSort={altSort} onToggleAltSort={onToggleAltSort} />
      {loading && <RowMessage>Loading TLE catalog…</RowMessage>}

      {!loading && aboveList.length > 0 && (
        <>
          {aboveList.map((sat) => (
            <SatRow
              key={satKeyId(sat)}
              sat={sat}
              tle={tleMap.get(satKeyId(sat))}
              selected={sameSatKey(sat, selectedKey)}
              onClick={() => onSelectExisting(sat)}
            />
          ))}
        </>
      )}

      {!loading && risingList.length > 0 && (
        <>
          <GroupDivider
            label={`Rising soon — ${risingList.length}`}
            tone="brass"
          />
          {risingList.map((sat) => (
            <SatRow
              key={satKeyId(sat)}
              sat={sat}
              tle={tleMap.get(satKeyId(sat))}
              selected={sameSatKey(sat, selectedKey)}
              onClick={() => onSelectExisting(sat)}
            />
          ))}
        </>
      )}

      {!loading && showCatalogSearch && (
        <>
          <GroupDivider
            label={`Catalog matches — ${searchResults.length}`}
            tone="brass"
          />
          {searchResults.slice(0, 50).map((tle) => {
            const key = satKeyOf(tle);
            const pos = positions.find((p) => sameSatKey(p, key));
            return (
              <SatRow
                key={satKeyId(key)}
                sat={
                  pos ?? {
                    kind: key.kind,
                    noradId: tle.noradId,
                    ra: 0, dec: 0, alt: -90, az: 0, isVisible: false,
                    range: 0, velocity: 0, riseInMinutes: null,
                    setInMinutes: null, maxAlt: null,
                  }
                }
                tle={tle}
                selected={sameSatKey(key, selectedKey)}
                onClick={() => onSelectFromSearch(tle)}
              />
            );
          })}
        </>
      )}

      {!loading && searching && (
        <RowMessage>Searching full catalog…</RowMessage>
      )}
      {!loading &&
        !searching &&
        aboveList.length === 0 &&
        risingList.length === 0 &&
        !showCatalogSearch && (
          <RowMessage>
            {searchText ? `No matches for “${searchText}”` : "No satellites match filters"}
          </RowMessage>
        )}
    </>
  );
}

/**
 * Stars catalog list. Six columns: NAME · TYPE · RA · DEC · ALT · MAG.
 *   • NAME is the IAU/common name when available, else the bare catalog id
 *     (no "HR"/"HIP" prefix — the catalog chevron above already tells you
 *     which one you're in).
 *   • TYPE is the leading spectral class letter (O/B/A/F/G/K/M) or blank
 *     when missing (common in HIP).
 *   • RA renders per the user's `raUnit` choice (hr or deg), one decimal.
 *   • DEC is decimal degrees, one decimal, with leading sign.
 *
 * The six-column layout is wider than the Satellites/Solar list. We use
 * `min-width` + horizontal scroll on overflow so narrower windows stay
 * legible by scrolling rather than truncating columns.
 */
// Memoized: CatalogColumn re-renders ~60×/s while sensorkit streams (its
// useObserver/store subscriptions fire per record). Without this, the 200-row
// grid reconciled every record (~1.5 s of render work over a 5 s window,
// ~50% main-thread on the HIP catalog). All props are referentially stable —
// `stars`/`catalog`/`starsSort` memoized or useState, `onSelect`/`onHeaderClick`
// stable callbacks — so memo lets the list bail out of the per-record churn.
const StarRows = memo(function StarRows({
  loading,
  stars,
  catalog,
  selectedIndex,
  onSelect,
  starsSort,
  onHeaderClick,
  searching,
}: {
  loading: boolean;
  stars: ReturnType<typeof useStarAltitudes>;
  catalog: StarCatalog | null;
  selectedIndex: number | null;
  onSelect: (idx: number) => void;
  starsSort: { col: "alt" | "mag"; dir: "desc" | "asc" };
  onHeaderClick: (col: "alt" | "mag") => void;
  /** Whether a search query is active — affects horizon filtering + header. */
  searching: boolean;
}) {
  const raUnit = useSkyViewStore((s) => s.raUnit);

  // Width tuned so the six columns lay out cleanly at ~12 px monofont;
  // when the right panel narrows past this, the surrounding scroll
  // container handles horizontal overflow gracefully. NAME and TYPE are
  // left-aligned; RA / DEC / ALT / MAG are right-aligned (both header
  // and value), so the numeric columns read as a tidy block.
  const cols = "1fr 28px 56px 56px 40px 36px";

  return (
    <div style={{ minWidth: 320 }}>
      <div
        className="uppercase"
        style={{
          display: "grid",
          gridTemplateColumns: cols,
          gap: 8,
          padding: "5px 18px",
          fontSize: 9.5,
          letterSpacing: 1.1,
          color: "var(--color-paper-dim)",
          borderBottom: "1px solid rgba(199,184,143,0.5)",
          alignItems: "center",
        }}
      >
        <span>Name</span>
        <span>Type</span>
        <RAUnitHeader />
        <span style={{ textAlign: "right" }}>Dec</span>
        <SortHeader
          label="Alt"
          active={starsSort.col === "alt"}
          dir={starsSort.dir}
          onClick={() => onHeaderClick("alt")}
        />
        <SortHeader
          label="Mag"
          active={starsSort.col === "mag"}
          dir={starsSort.dir}
          onClick={() => onHeaderClick("mag")}
        />
      </div>
      {loading && <RowMessage>Loading star catalog…</RowMessage>}
      {!loading && stars.length === 0 && <RowMessage>No stars match</RowMessage>}
      {/* Kept the brass "Matches — N" header for searches since it changes
          the implied content of the list (below-horizon stars become
          visible while a query is active). The sage "Above horizon"
          banner that used to head the default view was removed per UX
          request — the column header alone tells you what you're looking
          at, and the new filter panel above carries the per-tab cues. */}
      {!loading && stars.length > 0 && searching && (
        <GroupDivider label={`Matches — ${stars.length}`} tone="brass" />
      )}
      {!loading &&
        stars.map((s) => {
          const selected = s.index === selectedIndex;
          const commonName = catalog ? getStarName(catalog, s.index) : null;
          const displayName = commonName ?? String(s.id);
          const isBelowHorizon = s.alt <= 0;
          return (
            <div
              key={s.index}
              role="button"
              onClick={() => onSelect(s.index)}
              className="cursor-pointer"
              style={{
                display: "grid",
                gridTemplateColumns: cols,
                gap: 8,
                padding: "5px 18px 5px 16px",
                alignItems: "center",
                fontSize: 11.5,
                borderLeft: `2px solid ${selected ? "var(--color-terracotta)" : "transparent"}`,
                background: selected ? "rgba(199,95,60,0.09)" : "transparent",
                // Below-horizon rows (only seen while searching) get a
                // slight desaturation so they read as "found but not up"
                // without losing the row content.
                opacity: isBelowHorizon ? 0.55 : 1,
              }}
            >
              <span
                className="font-medium"
                style={{
                  color: "var(--color-ink)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {displayName}
              </span>
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--color-paper-dim)" }}
              >
                {s.spec ?? ""}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--color-ink)",
                  textAlign: "right",
                }}
              >
                {formatRA(s.ra, raUnit)}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--color-ink)",
                  textAlign: "right",
                }}
              >
                {formatDec(s.dec)}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: s.alt >= 60 ? "var(--color-sage)" : "var(--color-ink)",
                  fontWeight: s.alt >= 60 ? 600 : 400,
                  textAlign: "right",
                }}
              >
                {s.alt.toFixed(1)}°
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 10.5,
                  color: "var(--color-paper-dim)",
                  textAlign: "right",
                }}
              >
                {s.mag.toFixed(1)}
              </span>
            </div>
          );
        })}
    </div>
  );
});

// === Formatters =========================================================

function formatRA(raDeg: number, unit: "hr" | "deg"): string {
  if (unit === "hr") return (raDeg / 15).toFixed(1);
  return `${raDeg.toFixed(1)}°`;
}

function formatDec(decDeg: number): string {
  const sign = decDeg >= 0 ? "+" : "−";
  return `${sign}${Math.abs(decDeg).toFixed(1)}°`;
}

// === Chevron pickers ====================================================

/**
 * The "Stars" segment button when active. Renders as a single pill (matching
 * the other selected tab pills) but its label includes the current catalog
 * name and a chevron — click anywhere on it to open the HR/HIP picker.
 * `onActivate` is provided for symmetry but only fires if the segment is
 * not yet active (it always is by the time this renders, so it's effectively
 * unused — kept so the call site remains uniform with the other branches).
 */
function StarsActiveButton({ onActivate: _ }: { onActivate: () => void }) {
  const value = useSkyViewStore((s) => s.starCatalog);
  const setValue = useSkyViewStore((s) => s.setStarCatalog);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-sm font-medium inline-flex items-center gap-[6px]"
        style={{
          padding: "4px 9px",
          fontSize: 11,
          background: "var(--color-ink)",
          color: "var(--color-paper)",
          border: "none",
          textTransform: "capitalize",
        }}
        title={`Star catalog (currently ${value}) — click to change`}
      >
        <span>stars</span>
        <span style={{ opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div
          className="absolute left-0 mt-1 z-30 min-w-[90px] rounded-sm shadow-lg"
          style={{
            background: "var(--color-paper)",
            border: "1px solid rgba(199,184,143,0.7)",
            fontSize: 11,
          }}
        >
          {(["HR", "HIP"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => {
                setValue(opt);
                setOpen(false);
              }}
              className="block w-full text-left"
              style={{
                padding: "4px 10px",
                color: "var(--color-ink)",
                fontWeight: opt === value ? 600 : 400,
                background:
                  opt === value ? "rgba(199,95,60,0.10)" : "transparent",
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** RA column header with a chevron that switches the unit (hr ↔ deg). */
function RAUnitHeader() {
  const unit = useSkyViewStore((s) => s.raUnit);
  const setUnit = useSkyViewStore((s) => s.setRAUnit);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="uppercase cursor-pointer text-right w-full"
        style={{
          fontSize: 9.5,
          letterSpacing: 1.1,
          color: "var(--color-paper-dim)",
          background: "transparent",
          padding: 0,
        }}
        title={`RA in ${unit} — click to change`}
      >
        RA ▾
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 z-30 min-w-[60px] rounded-sm shadow-lg"
          style={{
            background: "var(--color-paper)",
            border: "1px solid rgba(199,184,143,0.7)",
            fontSize: 10.5,
          }}
        >
          {(["hr", "deg"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => {
                setUnit(opt);
                setOpen(false);
              }}
              className="block w-full text-left"
              style={{
                padding: "3px 10px",
                color: "var(--color-ink)",
                fontWeight: opt === unit ? 600 : 400,
                background:
                  opt === unit ? "rgba(199,95,60,0.10)" : "transparent",
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Amber accent for Horizons objects — distinct from solar-body colors and the
// satellite/star palettes.
const HORIZONS_ACCENT = "#ff9e3d";

function isSunQuery(name: string, command: string): boolean {
  return /\bSun\b/i.test(name) || command === "10" || command.toLowerCase() === "sun";
}

/**
 * The "Horizons" catalog tab. Resolves the shared search box against JPL
 * Horizons (via the sidecar proxy), shows the match or a disambiguation list,
 * and on selection fetches a short ephemeris to populate the readout + the
 * SkyView motion-track overlay.
 */
function HorizonsPanel({
  searchText,
  observer,
}: {
  searchText: string;
  observer: ObserverLocation;
}) {
  const selectHorizonsTarget = useSkyViewStore((s) => s.selectHorizonsTarget);
  const selected = useSkyViewStore((s) => s.selectedHorizonsTarget);
  const [lookup, setLookup] = useState<HorizonsLookup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCmd, setPendingCmd] = useState<string | null>(null);

  // Debounced lookup as the operator types (Horizons calls aren't free).
  useEffect(() => {
    const q = searchText.trim();
    setError(null);
    if (q.length < 2) {
      setLookup(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      lookupHorizons(q)
        .then((l) => setLookup(l))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    }, 500);
    return () => clearTimeout(t);
  }, [searchText]);

  const selectByCommand = useCallback(
    async (command: string, name: string) => {
      setPendingCmd(command);
      setError(null);
      try {
        const win = previewWindow({ spanSec: 7200, intervals: 24 });
        const ephem = await fetchHorizonsEphemeris({
          command,
          lon: observer.lon,
          lat: observer.lat,
          altKm: observer.alt / 1000,
          start: win.start,
          stop: win.stop,
          intervals: win.intervals,
        });
        const s0 = ephem.samples[0];
        if (!s0) throw new Error("No ephemeris returned");
        const resolvedName = ephem.name ?? name;
        selectHorizonsTarget({
          name: resolvedName,
          command,
          isSun: isSunQuery(resolvedName, command),
          ra: s0.ra,
          dec: s0.dec,
          magnitude: s0.magnitude,
          rangeAu: s0.rangeAu,
          rateArcsecHr: totalRateArcsecHr(s0),
          track: ephem.samples.map((s) => ({ ra: s.ra, dec: s.dec })),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingCmd(null);
      }
    },
    [observer, selectHorizonsTarget],
  );

  const q = searchText.trim();
  const candidates = lookup?.candidates ?? [];

  return (
    <div style={{ padding: "4px 0" }}>
      {q.length < 2 && <RowMessage>Search the JPL Horizons Observer Table</RowMessage>}
      {q.length >= 2 && loading && <RowMessage>Searching…</RowMessage>}
      {error && <RowMessage>{error}</RowMessage>}
      {!loading && lookup?.resolved && lookup.command && (
        <HorizonsResultRow
          name={lookup.name ?? lookup.command}
          kind={lookup.kind}
          active={selected?.command === lookup.command}
          loading={pendingCmd === lookup.command}
          onClick={() => selectByCommand(lookup.command!, lookup.name ?? lookup.command!)}
        />
      )}
      {!loading && lookup && !lookup.resolved && candidates.length > 0 && (
        <>
          {candidates.map((c) => (
            <HorizonsResultRow
              key={c.command}
              name={c.name}
              kind={c.kind}
              active={selected?.command === c.command}
              loading={pendingCmd === c.command}
              onClick={() => selectByCommand(c.command, c.name)}
            />
          ))}
        </>
      )}
      {!loading && lookup && !lookup.resolved && candidates.length === 0 && q.length >= 2 && (
        <RowMessage>No object found for “{q}”</RowMessage>
      )}
    </div>
  );
}

function HorizonsResultRow({
  name,
  kind,
  active,
  loading,
  onClick,
}: {
  name: string;
  kind?: string;
  active: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      onClick={onClick}
      className="cursor-pointer"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 18px 6px 16px",
        fontSize: 11.5,
        borderLeft: `2px solid ${active ? "var(--color-terracotta)" : "transparent"}`,
        background: active ? "rgba(199,95,60,0.09)" : "transparent",
      }}
    >
      <Dot color={HORIZONS_ACCENT} size={6} />
      <span
        className="min-w-0"
        style={{
          flex: 1,
          color: "var(--color-ink)",
          fontWeight: 500,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {name}
      </span>
      <span
        className="uppercase"
        style={{ fontSize: 9, color: "var(--color-paper-dim)", letterSpacing: 1 }}
      >
        {loading ? "…" : (kind ?? "")}
      </span>
    </div>
  );
}

function HorizonsModeToggle({
  mode,
  onChange,
}: {
  mode: "ephemeris" | "fixed";
  onChange: (m: "ephemeris" | "fixed") => void;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        className="uppercase"
        style={{ fontSize: 9, letterSpacing: 1, color: "var(--color-paper-dim)", marginBottom: 4 }}
      >
        Collect as
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {(["ephemeris", "fixed"] as const).map((m) => {
          const active = m === mode;
          return (
            <button
              key={m}
              type="button"
              onClick={() => onChange(m)}
              title={
                m === "ephemeris"
                  ? "Track the sampled path — best for movers (asteroids, comets)"
                  : "Snapshot RA/Dec at start, tracked sidereally"
              }
              style={{
                flex: 1,
                padding: "4px 8px",
                fontSize: 10,
                borderRadius: 2,
                textTransform: "capitalize",
                cursor: "pointer",
                background: active ? "var(--color-ink)" : "transparent",
                color: active ? "var(--color-paper)" : "var(--color-paper-dim)",
                border: active ? "none" : "1px solid rgba(199,184,143,0.5)",
              }}
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HorizonsDetail({
  target,
  onClose,
}: {
  target: HorizonsSelection;
  onClose: () => void;
}) {
  const { observer } = useObserver();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const { alt, az } = useMemo(
    () => radecToAltAz(now, observer, target.ra, target.dec),
    [now, observer, target.ra, target.dec],
  );
  // Ephemeris tracks the sampled path (right for movers); Fixed snapshots the
  // current RA/Dec. The Sun is never tracked at all, so the choice is moot.
  const [mode, setMode] = useState<"ephemeris" | "fixed">("ephemeris");

  const data: [string, string][] = [
    ["RA", `${target.ra.toFixed(3)}°`],
    ["Dec", `${target.dec.toFixed(3)}°`],
    ["Alt", `${alt.toFixed(2)}°`],
    ["Az", `${az.toFixed(2)}°`],
    ["Rate", target.rateArcsecHr != null ? `${target.rateArcsecHr.toFixed(1)} "/hr` : "—"],
    ["Mag", target.magnitude != null ? target.magnitude.toFixed(1) : "—"],
    ["Range", target.rangeAu != null ? `${target.rangeAu.toFixed(3)} AU` : "—"],
  ];

  const actionTarget: ActionTarget = {
    kind: "horizons",
    ra: target.ra,
    dec: target.dec,
    name: target.name,
    command: target.command,
    isSun: target.isSun,
    mode,
    rateArcsecHr: target.rateArcsecHr,
  };

  return (
    <DetailFrame
      title={target.name}
      onClose={onClose}
      meta={
        alt > 0 ? (
          <span style={{ color: "var(--color-sage)" }}>above horizon</span>
        ) : (
          <span style={{ color: "var(--color-paper-dim)" }}>below ({alt.toFixed(1)}°)</span>
        )
      }
    >
      <DataGrid rows={data} />
      {!target.isSun && <HorizonsModeToggle mode={mode} onChange={setMode} />}
      <ActionButtons target={actionTarget} palette="paper" />
    </DetailFrame>
  );
}

function SatRow({
  sat,
  tle,
  selected,
  onClick,
}: {
  sat: SatellitePosition;
  tle: CatalogRecord | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  const regime = tle?.orbitRegime ?? "OTHER";
  const color = regimeColor(regime);
  const altAbove = sat.alt > 0;

  const event = useMemo(() => {
    if (altAbove && sat.setInMinutes != null) {
      return formatEventMins("sets", sat.setInMinutes);
    }
    if (!altAbove && sat.riseInMinutes != null) {
      return formatEventMins("rises", sat.riseInMinutes);
    }
    return "—";
  }, [altAbove, sat.setInMinutes, sat.riseInMinutes]);

  return (
    <div
      role="button"
      onClick={onClick}
      className="cursor-pointer"
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 42px 60px",
        gap: 10,
        padding: "5px 18px 5px 16px",
        alignItems: "center",
        fontSize: 11.5,
        borderLeft: `2px solid ${selected ? "var(--color-terracotta)" : "transparent"}`,
        background: selected ? "rgba(199,95,60,0.09)" : "transparent",
      }}
    >
      <div className="flex items-center gap-[7px] min-w-0">
        <Dot color={color} size={6} />
        <SatName tle={tle} noradId={sat.noradId} />
        {isSV(tle) && (
          <SVEpochBadge epoch={tle.epoch} orbitRegime={tle.orbitRegime} />
        )}
      </div>
      <span
        className="mono text-right"
        style={{
          fontSize: 11,
          color:
            altAbove && sat.alt >= 60
              ? "var(--color-sage)"
              : altAbove
                ? "var(--color-ink)"
                : "var(--color-paper-dim)",
          fontWeight: altAbove && sat.alt >= 60 ? 600 : 400,
        }}
      >
        {altAbove ? `${sat.alt.toFixed(0)}°` : "—"}
      </span>
      <span
        className="mono text-right"
        style={{
          fontSize: 10.5,
          color:
            event === "—" ? "var(--color-paper-muted)" : "var(--color-terracotta)",
        }}
      >
        {event}
      </span>
    </div>
  );
}

function SatelliteDetail({
  sat,
  tle,
  onClose,
}: {
  sat: SatellitePosition;
  tle: CatalogRecord | undefined;
  onClose: () => void;
}) {
  const regime = tle?.orbitRegime ?? "OTHER";
  const color = regimeColor(regime);
  const name = satLabel(tle, sat.noradId).text;

  const data: [string, string][] = [
    ["Alt", `${sat.alt.toFixed(2)}°`],
    ["Az", `${sat.az.toFixed(2)}°`],
    ["Range", `${sat.range.toFixed(0)} km`],
    ["Vel", `${sat.velocity.toFixed(2)} km/s`],
    ["Orbit", sat.satAlt != null ? `${sat.satAlt.toFixed(0)} km` : "—"],
    [
      "Sets",
      sat.setInMinutes != null ? `${Math.round(sat.setInMinutes)} min` : "—",
    ],
  ];

  const target: ActionTarget = {
    kind: "satellite",
    ra: sat.ra,
    dec: sat.dec,
    tle,
  };

  return (
    <DetailFrame
      title={name}
      onClose={onClose}
      meta={
        <>
          <span className="mono" style={{ fontSize: 10.5 }}>
            NORAD {sat.noradId}
          </span>
          <RegimeBadge regime={regime} color={color} />
          {sat.isVisible ? (
            <span style={{ color: "var(--color-sage)" }}>above horizon</span>
          ) : (
            <span style={{ color: "var(--color-paper-dim)" }}>
              below ({sat.alt.toFixed(1)}°)
            </span>
          )}
        </>
      }
    >
      {isSV(tle) && (
        <SVEpochNotice
          epoch={tle.epoch}
          orbitRegime={tle.orbitRegime}
          palette="paper"
        />
      )}
      <DataGrid rows={data} />
      <ActionButtons target={target} palette="paper" />
    </DetailFrame>
  );
}

function StarDetail({
  star,
  catalog,
  onClose,
}: {
  star: { index: number; ra: number; dec: number; mag: number; spec: string | null; alt: number; az: number };
  catalog: StarCatalog;
  onClose: () => void;
}) {
  const name = getStarLabel(catalog, star.index);
  const target: ActionTarget = { kind: "star", ra: star.ra, dec: star.dec, name };

  const raHours = star.ra / 15;
  const raH = Math.floor(raHours);
  const raM = Math.floor((raHours - raH) * 60);
  const decSign = star.dec >= 0 ? "+" : "-";
  const absDec = Math.abs(star.dec);
  const decD = Math.floor(absDec);
  const decM = Math.floor((absDec - decD) * 60);

  const data: [string, string][] = [
    ["RA", `${raH}h ${raM}m`],
    ["Dec", `${decSign}${decD}° ${decM}′`],
    ["Alt", `${star.alt.toFixed(2)}°`],
    ["Az", `${star.az.toFixed(2)}°`],
    ["Mag", star.mag.toFixed(2)],
    ["Spec", star.spec ?? "—"],
  ];

  return (
    <DetailFrame
      title={name}
      onClose={onClose}
      meta={
        <>
          <span className="mono" style={{ fontSize: 10.5 }}>
            mag {star.mag.toFixed(2)}
          </span>
          {star.alt > 0 && <span style={{ color: "var(--color-sage)" }}>above horizon</span>}
        </>
      }
    >
      <DataGrid rows={data} />
      <ActionButtons target={target} palette="paper" />
    </DetailFrame>
  );
}

function BodyDetail({ body, onClose }: { body: SolarBody; onClose: () => void }) {
  const target: ActionTarget = {
    kind: "body",
    ra: body.ra,
    dec: body.dec,
    name: body.name,
  };
  const distance =
    body.kind === "moon"
      ? `${(body.distanceAU * 149597870.7).toFixed(0)} km`
      : `${body.distanceAU.toFixed(3)} AU`;

  const data: [string, string][] = [
    ["Alt", `${body.alt.toFixed(2)}°`],
    ["Az", `${body.az.toFixed(2)}°`],
    ["RA", `${body.ra.toFixed(2)}°`],
    ["Dec", `${body.dec.toFixed(2)}°`],
    ["Dist", distance],
    ["Mag", body.magnitude != null ? body.magnitude.toFixed(1) : "—"],
  ];

  return (
    <DetailFrame
      title={body.name}
      onClose={onClose}
      meta={
        <>
          <span
            className="uppercase"
            style={{
              fontSize: 9.5,
              color: "var(--color-paper-dim)",
              letterSpacing: 1,
            }}
          >
            {body.kind}
          </span>
          {body.alt > 0 && <span style={{ color: "var(--color-sage)" }}>above horizon</span>}
        </>
      }
    >
      <DataGrid rows={data} />
      <ActionButtons target={target} palette="paper" />
    </DetailFrame>
  );
}

function ManualTargetDetail({
  ra,
  dec,
  onClose,
}: {
  ra: number;
  dec: number;
  onClose: () => void;
}) {
  const { observer } = useObserver();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const { alt, az } = useMemo(
    () => radecToAltAz(now, observer, ra, dec),
    [now, observer, ra, dec],
  );

  const data: [string, string][] = [
    ["RA", `${ra.toFixed(3)}°`],
    ["Dec", `${dec.toFixed(3)}°`],
    ["Alt", `${alt.toFixed(2)}°`],
    ["Az", `${az.toFixed(2)}°`],
  ];
  const target: ActionTarget = { kind: "manual", ra, dec };
  return (
    <DetailFrame
      title="Manual target"
      onClose={onClose}
      meta={
        alt > 0 ? (
          <span style={{ color: "var(--color-sage)" }}>above horizon</span>
        ) : (
          <span style={{ color: "var(--color-paper-dim)" }}>
            below ({alt.toFixed(1)}°)
          </span>
        )
      }
    >
      <DataGrid rows={data} />
      <ActionButtons target={target} palette="paper" />
    </DetailFrame>
  );
}

/* ---------------- Small primitives ---------------- */

function DetailFrame({
  title,
  meta,
  onClose,
  children,
}: {
  title: string;
  meta: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex justify-between items-start mb-[10px]">
        <div>
          <div
            style={{
              fontSize: 17,
              fontWeight: 600,
              letterSpacing: 0.1,
              color: "var(--color-ink)",
            }}
          >
            {title}
          </div>
          <div
            className="flex items-center gap-2 mt-[3px]"
            style={{ fontSize: 10.5, color: "var(--color-paper-dim)" }}
          >
            {meta}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close selection"
          className="p-2 -m-2"
          style={{
            background: "transparent",
            color: "var(--color-paper-dim)",
            fontSize: 16,
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      {children}
    </>
  );
}

function DataGrid({ rows }: { rows: [string, string][] }) {
  return (
    <div
      className="mb-[12px]"
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "3px 18px",
        fontSize: 11,
      }}
    >
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="flex justify-between"
          style={{
            padding: "2px 0",
            borderBottom: "1px dotted var(--color-paper-muted)",
          }}
        >
          <span style={{ color: "var(--color-paper-dim)" }}>{k}</span>
          <span className="mono" style={{ color: "var(--color-ink)" }}>
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}

function RegimeBadge({ regime, color }: { regime: string; color: string }) {
  return (
    <span
      className="uppercase"
      style={{
        padding: "1px 6px",
        borderRadius: 2,
        background: `${color}30`,
        color,
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: 1,
      }}
    >
      {regime}
    </span>
  );
}

function Dot({ color, size = 6 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 99,
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function RowMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-center"
      style={{
        padding: "16px 18px",
        fontSize: 11.5,
        color: "var(--color-paper-dim)",
      }}
    >
      {children}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <circle
        cx="5"
        cy="5"
        r="3.5"
        fill="none"
        stroke="var(--color-paper-dim)"
      />
      <line
        x1="7.5"
        y1="7.5"
        x2="11"
        y2="11"
        stroke="var(--color-paper-dim)"
      />
    </svg>
  );
}

/**
 * Adjustments-horizontal "sliders" pictogram used to expand/collapse the
 * filter panel. Three horizontal rails with circular handles at staggered
 * positions — the standard filter icon seen on e-commerce sites.
 *
 * `active` darkens the icon when at least one filter value is set, so the
 * user has a hint that the (hidden) panel is currently narrowing results.
 */
function FilterToggleButton({
  open,
  active,
  onClick,
}: {
  open: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const color = open || active ? "var(--color-ink)" : "var(--color-paper-dim)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={open}
      title={open ? "Hide filters" : "Show filters"}
      className="before:absolute before:-inset-2.5 before:content-['']"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        padding: 0,
        background: open ? "rgba(199,184,143,0.35)" : "transparent",
        border: "1px solid rgba(199,184,143,0.5)",
        borderRadius: 2,
        cursor: "pointer",
        position: "relative",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
        <line x1="1" y1="3.5" x2="13" y2="3.5" stroke={color} strokeWidth="1" />
        <line x1="1" y1="7" x2="13" y2="7" stroke={color} strokeWidth="1" />
        <line x1="1" y1="10.5" x2="13" y2="10.5" stroke={color} strokeWidth="1" />
        <circle cx="4" cy="3.5" r="1.6" fill="var(--color-paper)" stroke={color} strokeWidth="1" />
        <circle cx="9.5" cy="7" r="1.6" fill="var(--color-paper)" stroke={color} strokeWidth="1" />
        <circle cx="5.5" cy="10.5" r="1.6" fill="var(--color-paper)" stroke={color} strokeWidth="1" />
      </svg>
      {active && (
        <span
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "var(--color-terracotta)",
          }}
        />
      )}
    </button>
  );
}

function formatEventMins(verb: "sets" | "rises", mins: number): string {
  if (mins < 1) return `${verb} <1m`;
  if (mins < 60) return `${verb} ${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${verb} ${h}h${m > 0 ? `${m}m` : ""}`;
}
