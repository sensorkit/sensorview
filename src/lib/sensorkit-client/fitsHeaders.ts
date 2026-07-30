import type { ProductMetadata } from "./types";

/**
 * FITS-header indexing primitives for the Images tab: turn SK's `/metadata`
 * responses into a flat card map, infer a filterable facet per keyword, and
 * evaluate search / filter predicates against a product's cards.
 *
 * The filter UI can't hardcode its fields the way the SkyView star catalog
 * does — every instrument writes a different card set — so the keyword list
 * and each keyword's control type are derived from whatever headers have
 * actually been indexed.
 */

/** A product's header flattened to `keyword -> display string`. */
export type HeaderCards = Record<string, string>;

/**
 * Sentinel selected-value meaning "this product has no such keyword".
 * Parenthesized so it can't be confused with a real card value in the chip
 * list. Absence is offered as an explicit choice rather than silently
 * dropping those products, which otherwise looks like a bug the first time
 * you filter on a card only some frames carry.
 */
export const ABSENT = "(no value)";

/** Keys of SK's KeywordDict that aren't FITS cards. */
const NON_CARD_KEYS = new Set(["ProductInfo"]);

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Pull the FITS cards out of SK's `/metadata` response.
 *
 * The response is a KeywordDict keyed by keyword *class* name. Since sensorkit
 * "Nest FITS cards under the `FITSHeader` keyword" the cards live in a
 * `FITSHeader` sub-object alongside `ProductInfo`; older builds spread the
 * cards flat at the top level instead. Accept either, so this keeps working
 * against whichever SK a site is running.
 */
export function fitsCardEntries(meta: ProductMetadata): [string, unknown][] {
  const nested = meta.FITSHeader;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return Object.entries(nested as Record<string, unknown>);
  }
  return Object.entries(meta).filter(([k]) => !NON_CARD_KEYS.has(k));
}

/** Flatten a `/metadata` response to `keyword -> display string`. */
export function toCards(meta: ProductMetadata): HeaderCards {
  const cards: HeaderCards = {};
  for (const [k, v] of fitsCardEntries(meta)) {
    const s = formatVal(v);
    // Blank cards (FITS pads unused slots) carry no filterable signal, and
    // would otherwise dominate every facet's value list with "".
    if (s !== "") cards[k] = s;
  }
  return cards;
}

// === Facets ===

export type FacetKind = "enum" | "numeric" | "text";

export interface FacetValue {
  value: string;
  count: number;
}

export interface Facet {
  keyword: string;
  kind: FacetKind;
  /** Distinct values with counts — populated for `enum` only. */
  values: FacetValue[];
  /** How many indexed products lack this keyword. */
  missing: number;
  /**
   * Numeric facets only: products carrying a value that doesn't parse as a
   * number. A range filter can't judge them, so they drop out — surfaced in
   * the UI rather than left as an unexplained gap in the results.
   */
  unparsed: number;
  /** Distinct value count (all kinds). */
  distinct: number;
  /** Observed numeric bounds — `numeric` only. */
  min?: number;
  max?: number;
}

/**
 * Above this many distinct values a keyword stops being a chip list: it
 * becomes a numeric range if its values are numbers, and a free-text
 * "contains" box otherwise. A chip list stops being scannable well before it
 * stops being renderable.
 *
 * This threshold gates numeric facets too, deliberately. Plenty of numeric
 * cards are really identifiers or fixed settings — TARGETID holds NORAD ids,
 * XBINNING holds two or three values — and you want to pick those from a list,
 * not type a range around them. Genuinely continuous cards (ALT, RA, CCDTEMP
 * on a real cooler) run to thousands of distinct values and clear this easily.
 */
const MAX_ENUM_VALUES = 25;

/**
 * Share of a keyword's products whose value must parse as a number for it to
 * be treated as numeric. Deliberately not 100%: a single malformed frame
 * shouldn't turn a continuous card into a several-thousand-value text box.
 * Real rigs have them — this rig writes literal 'alt'/'az'/'ra'/'dec' strings
 * into a handful of frames whose pointing never got substituted.
 */
const NUMERIC_SHARE = 0.95;

function asNumber(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build one facet per keyword seen across the indexed headers. `total` is the
 * number of indexed products, so each facet can report how many are missing
 * the keyword entirely.
 */
export function buildFacets(cardsByProduct: HeaderCards[]): Facet[] {
  const counts = new Map<string, Map<string, number>>();
  for (const cards of cardsByProduct) {
    for (const [k, v] of Object.entries(cards)) {
      let byValue = counts.get(k);
      if (!byValue) counts.set(k, (byValue = new Map()));
      byValue.set(v, (byValue.get(v) ?? 0) + 1);
    }
  }

  const total = cardsByProduct.length;
  const facets: Facet[] = [];
  for (const [keyword, byValue] of counts) {
    const distinct = byValue.size;
    let present = 0;
    let numeric = 0;
    let numericDistinct = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const [value, count] of byValue) {
      present += count;
      const n = asNumber(value);
      if (n === null) continue;
      numeric += count;
      numericDistinct++;
      if (n < min) min = n;
      if (n > max) max = n;
    }

    const allNumeric = numericDistinct === distinct;
    const numericRange =
      present > 0 &&
      numeric / present >= NUMERIC_SHARE &&
      distinct > MAX_ENUM_VALUES;
    const kind: FacetKind = numericRange
      ? "numeric"
      : distinct <= MAX_ENUM_VALUES
        ? "enum"
        : "text";

    const values: FacetValue[] =
      kind === "enum"
        ? [...byValue.entries()]
            .map(([value, count]) => ({ value, count }))
            // Numeric enums read best in numeric order; everything else by
            // frequency, so the values you're most likely to want come first.
            .sort((a, b) =>
              allNumeric
                ? (asNumber(a.value) ?? 0) - (asNumber(b.value) ?? 0)
                : b.count - a.count || a.value.localeCompare(b.value),
            )
        : [];

    facets.push({
      keyword,
      kind,
      values,
      distinct,
      missing: total - present,
      // Only meaningful on a numeric facet: frames a range filter can't judge.
      unparsed: numericRange ? present - numeric : 0,
      ...(numericRange ? { min, max } : {}),
    });
  }

  return facets.sort((a, b) => a.keyword.localeCompare(b.keyword));
}

// === Predicates ===

export type FilterPredicate =
  /** Selected values (may include ABSENT). Empty = facet inactive. */
  | { kind: "enum"; selected: string[] }
  /** Both bounds nullable; `absent` decides whether cardless products pass. */
  | { kind: "numeric"; min: number | null; max: number | null; absent: boolean }
  /** Case-insensitive substring; empty = inactive. */
  | { kind: "text"; contains: string };

/** Active filters, keyed by FITS keyword. Combined with AND. */
export type FilterMap = Record<string, FilterPredicate>;

/** True when the predicate would narrow anything. */
export function predicateActive(p: FilterPredicate): boolean {
  switch (p.kind) {
    case "enum":
      return p.selected.length > 0;
    case "numeric":
      return p.min !== null || p.max !== null || !p.absent;
    case "text":
      return p.contains.trim() !== "";
  }
}

/** Any filter in the map that would narrow anything. */
export function anyFilterActive(filters: FilterMap): boolean {
  return Object.values(filters).some(predicateActive);
}

/** A fresh, inactive predicate for a facet. */
export function emptyPredicate(facet: Facet): FilterPredicate {
  switch (facet.kind) {
    case "enum":
      return { kind: "enum", selected: [] };
    case "numeric":
      return { kind: "numeric", min: null, max: null, absent: true };
    case "text":
      return { kind: "text", contains: "" };
  }
}

const inMinMax = (v: number, min: number | null, max: number | null): boolean =>
  (min === null || v >= min) && (max === null || v <= max);

/**
 * Evaluate one keyword's predicate. AND across keywords is the caller's job;
 * within a keyword, a multi-select is an OR over its values.
 */
function matchesPredicate(cards: HeaderCards, keyword: string, p: FilterPredicate): boolean {
  const raw = cards[keyword];
  switch (p.kind) {
    case "enum": {
      if (p.selected.length === 0) return true;
      return p.selected.includes(raw === undefined ? ABSENT : raw);
    }
    case "numeric": {
      if (raw === undefined) return p.absent;
      const n = asNumber(raw);
      // A non-numeric value in a keyword classified numeric means the index
      // grew a new shape after the facet was built; don't silently pass it.
      if (n === null) return false;
      return inMinMax(n, p.min, p.max);
    }
    case "text": {
      const q = p.contains.trim().toLowerCase();
      if (q === "") return true;
      return raw !== undefined && raw.toLowerCase().includes(q);
    }
  }
}

/** True when the product's cards satisfy every active filter. */
export function matchesFilters(cards: HeaderCards, filters: FilterMap): boolean {
  for (const [keyword, p] of Object.entries(filters)) {
    if (!predicateActive(p)) continue;
    if (!matchesPredicate(cards, keyword, p)) return false;
  }
  return true;
}

/**
 * Free-text search across the header: matches a keyword name, any card value,
 * or the product id (so a partial UUID still finds its file).
 */
export function matchesSearch(
  cards: HeaderCards | undefined,
  productId: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (productId.toLowerCase().includes(q)) return true;
  if (!cards) return false;
  for (const [k, v] of Object.entries(cards)) {
    if (v.toLowerCase().includes(q)) return true;
    if (k.toLowerCase().includes(q)) return true;
  }
  return false;
}

