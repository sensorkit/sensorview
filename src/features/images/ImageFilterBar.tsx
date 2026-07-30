import { useEffect, useMemo, useRef, useState } from "react";
import {
  ABSENT,
  anyFilterActive,
  emptyPredicate,
  type Facet,
  type FilterMap,
  type FilterPredicate,
} from "../../lib/sensorkit-client/fitsHeaders";

/** Decorative magnifier, matching the SkyView catalog's hand-rolled icon. */
function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="7.6" y1="7.6" x2="10.5" y2="10.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** Sliders glyph: three rails with staggered handles. */
function FilterIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <line x1="1" y1="3.5" x2="13" y2="3.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.2" />
      <line x1="1" y1="10.5" x2="13" y2="10.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.5" cy="3.5" r="1.6" fill="currentColor" />
      <circle cx="9.5" cy="7" r="1.6" fill="currentColor" />
      <circle cx="5.5" cy="10.5" r="1.6" fill="currentColor" />
    </svg>
  );
}

/**
 * Compact display of an observed bound. FITS cards carry full double
 * precision (ALT arrives as -49.764667188083045), which wraps the hint line
 * and tells the user nothing they need to type a range.
 */
function formatBound(v: number | undefined): string {
  if (v === undefined) return "";
  if (v === 0) return "0";
  const mag = Math.abs(v);
  if (mag >= 1e6 || mag < 1e-4) return v.toExponential(2);
  const digits = mag >= 100 ? 1 : mag >= 1 ? 3 : 5;
  return String(Number(v.toFixed(digits)));
}

/** Nullable numeric field: blank means "unbounded", not zero. */
function NumInput({
  value,
  placeholder,
  onChange,
}: {
  value: number | null;
  placeholder?: string;
  onChange: (v: number | null) => void;
}) {
  return (
    <input
      type="number"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value.trim();
        if (t === "") return onChange(null);
        const n = Number(t);
        onChange(Number.isFinite(n) ? n : null);
      }}
      className="w-full min-w-0 rounded-sm border border-panel-border bg-white/5 px-1.5 py-0.5 pointer-coarse:py-1.5 font-mono text-[10.5px] text-text-bright outline-none placeholder:text-text-dim/50 focus:border-blue-500/60"
    />
  );
}

function ValueChip({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={`max-w-full rounded-sm border px-1.5 py-0.5 pointer-coarse:py-1.5 text-left font-mono text-[10.5px] transition-colors ${
        selected
          ? "border-blue-500 bg-blue-500/20 text-blue-100"
          : "border-panel-border text-text-dim hover:border-panel-border/80 hover:text-text-bright"
      }`}
    >
      <span className="truncate">{label}</span>{" "}
      <span className={selected ? "text-blue-300/80" : "text-text-dim/60"}>{count}</span>
    </button>
  );
}

/** One active keyword's control, chosen by the facet's inferred type. */
function FacetRow({
  facet,
  predicate,
  onChange,
  onRemove,
}: {
  facet: Facet;
  predicate: FilterPredicate;
  onChange: (p: FilterPredicate) => void;
  onRemove: () => void;
}) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[10px] uppercase tracking-wider text-blue-300">
          {facet.keyword}
        </span>
        <button
          onClick={onRemove}
          title={`Remove ${facet.keyword} filter`}
          className="shrink-0 px-1 text-[11px] leading-none text-text-dim hover:text-text-bright"
        >
          ✕
        </button>
      </div>

      {predicate.kind === "enum" && (
        <div className="flex flex-wrap gap-1">
          {facet.values.map((v) => (
            <ValueChip
              key={v.value}
              label={v.value}
              count={v.count}
              selected={predicate.selected.includes(v.value)}
              onClick={() =>
                onChange({
                  kind: "enum",
                  selected: predicate.selected.includes(v.value)
                    ? predicate.selected.filter((s) => s !== v.value)
                    : [...predicate.selected, v.value],
                })
              }
            />
          ))}
          {facet.missing > 0 && (
            <ValueChip
              label="—"
              count={facet.missing}
              selected={predicate.selected.includes(ABSENT)}
              onClick={() =>
                onChange({
                  kind: "enum",
                  selected: predicate.selected.includes(ABSENT)
                    ? predicate.selected.filter((s) => s !== ABSENT)
                    : [...predicate.selected, ABSENT],
                })
              }
            />
          )}
        </div>
      )}

      {predicate.kind === "numeric" && (
        <>
          <div className="grid grid-cols-[26px_1fr_8px_1fr] items-center gap-1">
            <span className="font-mono text-[10px] text-text-dim">min</span>
            <NumInput
              value={predicate.min}
              placeholder={formatBound(facet.min)}
              onChange={(min) => onChange({ ...predicate, min })}
            />
            <span className="text-center text-[10px] text-text-dim/60">–</span>
            <NumInput
              value={predicate.max}
              placeholder={formatBound(facet.max)}
              onChange={(max) => onChange({ ...predicate, max })}
            />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="font-mono text-[9.5px] text-text-dim/70">
              observed {formatBound(facet.min)} … {formatBound(facet.max)}
              {facet.unparsed > 0 && (
                <span
                  className="text-terracotta/80"
                  title={`${facet.unparsed} frames carry a non-numeric ${facet.keyword} and can't be range-matched`}
                >
                  {" "}
                  · {facet.unparsed} unparsable
                </span>
              )}
            </span>
            {facet.missing > 0 && (
              <label className="flex items-center gap-1 text-[9.5px] text-text-dim">
                <input
                  type="checkbox"
                  checked={predicate.absent}
                  onChange={(e) => onChange({ ...predicate, absent: e.target.checked })}
                  className="h-2.5 w-2.5 accent-blue-500"
                />
                keep {facet.missing} without it
              </label>
            )}
          </div>
        </>
      )}

      {predicate.kind === "text" && (
        <input
          value={predicate.contains}
          onChange={(e) => onChange({ kind: "text", contains: e.target.value })}
          placeholder={`contains… (${facet.distinct} values)`}
          className="w-full rounded-sm border border-panel-border bg-white/5 px-1.5 py-0.5 pointer-coarse:py-1.5 font-mono text-[10.5px] text-text-bright outline-none placeholder:text-text-dim/50 focus:border-blue-500/60"
        />
      )}
    </div>
  );
}

/** Searchable keyword picker for adding a facet. */
function AddFilter({
  facets,
  active,
  onAdd,
}: {
  facets: Facet[];
  active: FilterMap;
  onAdd: (facet: Facet) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return facets
      .filter((f) => !(f.keyword in active))
      .filter((f) => q === "" || f.keyword.toLowerCase().includes(q));
  }, [facets, active, query]);

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => {
          setOpen((o) => !o);
          setQuery("");
        }}
        disabled={facets.length === 0}
        className="text-[10.5px] text-blue-300 hover:text-blue-200 disabled:text-text-dim/50"
      >
        + Add filter
      </button>

      {/* Opens downward on purpose: the filter panel sits at the top of the
          browser's scroll container, and an upward menu is clipped against the
          scroll origin, where it can't be scrolled back into view. */}
      {open && (
        <div className="absolute top-full left-0 z-30 mt-1 w-56 rounded-sm border border-panel-border bg-panel-bg shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Keyword…"
            className="w-full border-b border-panel-border bg-transparent px-2 py-1.5 font-mono text-[10.5px] text-text-bright outline-none placeholder:text-text-dim/50"
          />
          <ul className="max-h-56 overflow-y-auto py-0.5">
            {candidates.length === 0 && (
              <li className="px-2 py-1.5 text-[10.5px] text-text-dim">No matching keyword</li>
            )}
            {candidates.map((f) => (
              <li key={f.keyword}>
                <button
                  onClick={() => {
                    onAdd(f);
                    setOpen(false);
                  }}
                  className="flex w-full items-baseline gap-2 px-2 py-1 pointer-coarse:py-2 text-left hover:bg-white/5"
                >
                  <span className="truncate font-mono text-[10.5px] text-text-bright">
                    {f.keyword}
                  </span>
                  <span className="ml-auto shrink-0 text-[9.5px] text-text-dim">
                    {f.kind === "numeric" ? "numeric" : `${f.distinct} values`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface Props {
  facets: Facet[];
  search: string;
  onSearch: (v: string) => void;
  filters: FilterMap;
  onFilters: (f: FilterMap) => void;
  /** Keyword used as the file-list row label, or null for the raw filename. */
  labelKeyword: string | null;
  onLabelKeyword: (k: string | null) => void;
}

/**
 * Search box + faceted filter panel for the Images file browser.
 *
 * The panel is rendered inline below the search row rather than floating —
 * matching the SkyView catalog, which has no popover primitive either. Filter
 * state is ephemeral (owned by ImagesPage, not persisted): it's a "narrow the
 * current view" tool, not a saved preference.
 */
export function ImageFilterBar({
  facets,
  search,
  onSearch,
  filters,
  onFilters,
  labelKeyword,
  onLabelKeyword,
}: Props) {
  const [open, setOpen] = useState(false);
  const active = anyFilterActive(filters);
  const rows = Object.keys(filters);

  const facetByKeyword = useMemo(
    () => new Map(facets.map((f) => [f.keyword, f])),
    [facets],
  );

  const labelCandidates = useMemo(
    () => facets.filter((f) => f.kind !== "numeric" && f.distinct > 1),
    [facets],
  );

  return (
    <div className="border-b border-panel-border">
      {/* Filter toggle sits left of the search field, matching the SkyView
          catalog's search row. */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-pressed={open}
          title={open ? "Hide filters" : "Show filters"}
          className={`relative shrink-0 rounded-sm border p-1 pointer-coarse:p-2 transition-colors ${
            open || active
              ? "border-blue-500/60 bg-blue-500/15 text-blue-200"
              : "border-panel-border text-text-dim hover:text-text-bright"
          }`}
        >
          <FilterIcon />
          {active && (
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-terracotta" />
          )}
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm border border-panel-border bg-white/5 px-1.5 py-1 pointer-coarse:py-2 focus-within:border-blue-500/60">
          <span className="shrink-0 text-text-dim">
            <SearchIcon />
          </span>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search headers…"
            className="min-w-0 flex-1 bg-transparent text-[11.5px] text-text-bright outline-none placeholder:text-text-dim"
          />
          {search !== "" && (
            <button
              onClick={() => onSearch("")}
              title="Clear search"
              className="shrink-0 px-0.5 text-[11px] leading-none text-text-dim hover:text-text-bright"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-panel-border bg-white/[0.02] px-2 py-2">
          {rows.length === 0 && facets.length === 0 && (
            <p className="mb-2 text-[10.5px] text-text-dim">No headers indexed yet.</p>
          )}

          {rows.map((keyword) => {
            const facet = facetByKeyword.get(keyword);
            if (!facet) return null;
            return (
              <FacetRow
                key={keyword}
                facet={facet}
                predicate={filters[keyword]!}
                onChange={(p) => onFilters({ ...filters, [keyword]: p })}
                onRemove={() => {
                  const next = { ...filters };
                  delete next[keyword];
                  onFilters(next);
                }}
              />
            );
          })}

          <div className="flex items-center justify-between gap-2 border-t border-panel-border pt-1.5">
            <AddFilter
              facets={facets}
              active={filters}
              onAdd={(f) => onFilters({ ...filters, [f.keyword]: emptyPredicate(f) })}
            />
            <button
              onClick={() => onFilters({})}
              disabled={rows.length === 0}
              className="text-[10.5px] text-text-dim hover:text-text-bright disabled:opacity-40"
            >
              Clear all
            </button>
          </div>

          {labelCandidates.length > 0 && (
            <label className="mt-2 flex items-center gap-2 border-t border-panel-border pt-2 text-[10px] uppercase tracking-wide text-text-dim">
              <span className="shrink-0">Label rows by</span>
              <select
                value={labelKeyword ?? ""}
                onChange={(e) => onLabelKeyword(e.target.value || null)}
                className="min-w-0 flex-1 rounded-sm border border-panel-border bg-panel-bg/60 px-1 py-0.5 pointer-coarse:py-1.5 font-mono text-[10.5px] normal-case tracking-normal text-text-bright"
              >
                <option value="">Filename</option>
                {labelCandidates.map((f) => (
                  <option key={f.keyword} value={f.keyword}>
                    {f.keyword}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
