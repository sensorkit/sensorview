import { create } from "zustand";

/**
 * Which kind of element set a catalog record carries. Drives the label prefix
 * for objects with no real name ("TLE · 12545" vs "SV · 12545"). Absent means
 * TLE — every record predates the distinction.
 */
export type ElementSetKind = "tle" | "sv";

interface CatalogRecordBase {
  noradId: string;
  name: string;
  objectType?: "PAYLOAD" | "ROCKET_BODY" | "DEBRIS" | "UNKNOWN";
  orbitRegime?: "LEO" | "MEO" | "GEO" | "HEO" | "OTHER";
  /** Which configured source won the priority merge for this object. */
  source?: string;
}

export interface TLERecord extends CatalogRecordBase {
  /** Absent on records that predate state-vector support; treated as "tle". */
  kind?: "tle";
  line1: string;
  line2: string;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A single-epoch orbital state. Position km, velocity km/s — the units the
 * uploaded documents use and the ones SensorView displays. SensorKit wants
 * metres, and that conversion happens once, in the command builder.
 */
export interface SVRecord extends CatalogRecordBase {
  kind: "sv";
  /** ISO-8601 UTC instant the state is valid at. */
  epoch: string;
  /** SensorKit reference-frame name, lowercase (e.g. "gcrf"). */
  frame: string;
  r: Vec3;
  v: Vec3;
}

export type CatalogRecord = TLERecord | SVRecord;

export function isSV(record: CatalogRecord | undefined): record is SVRecord {
  return record?.kind === "sv";
}

export function isTLE(record: CatalogRecord | undefined): record is TLERecord {
  return !!record && record.kind !== "sv";
}

/**
 * Catalog objects are identified by kind *and* NORAD id: the same satellite
 * can hold both a TLE and a state vector, and they are two separate rows.
 */
export interface SatKey {
  kind: ElementSetKind;
  noradId: string;
}

export function satKeyOf(record: CatalogRecord): SatKey {
  return { kind: record.kind === "sv" ? "sv" : "tle", noradId: record.noradId };
}

export function sameSatKey(a: SatKey | null, b: SatKey | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.noradId === b.noradId;
}

/** Stable string form, for Map/Set keys and React keys only — never displayed. */
export function satKeyId(key: SatKey): string {
  return `${key.kind}:${key.noradId}`;
}

/** Inverse of satKeyId. Bare ids (no prefix) are read as TLEs. */
export function parseSatKeyId(id: string): SatKey {
  const [head, ...rest] = id.split(":");
  if (rest.length && (head === "tle" || head === "sv")) {
    return { kind: head, noradId: rest.join(":") };
  }
  return { kind: "tle", noradId: id };
}

/**
 * True when a record's name is a backend-generated stand-in rather than a real
 * satellite name. Sources without a line0 (Spacebook, bare 2LE uploads) get
 * "SAT {norad}" synthesized server-side — see api/services/tle_parser.py.
 */
export function isPlaceholderName(name: string | undefined): boolean {
  return !name || /^SAT\s+\d+$/i.test(name);
}

/**
 * The pieces of a catalog object's display label. Callers that render the
 * label as styled spans (the catalog list puts a bullet glyph between the
 * prefix and the id) need the parts; everything else wants `text`.
 */
export interface SatLabel {
  /** True when there is no real name and the tail is the NORAD id. */
  isPlaceholder: boolean;
  /** Element-set marker, "TLE" or "SV". Always rendered. */
  prefix: string;
  noradId: string;
  /**
   * What follows the prefix — the NORAD id when unnamed, else the name. For
   * callers that render the parts as separate styled spans.
   */
  tail: string;
  /** Ready-to-render string: e.g. "TLE · MOLNIYA 2-10", "SV · 41838". */
  text: string;
}

/**
 * Resolve how to name a catalog object. Keeps the naming rule in one place so
 * the sky chart, catalog list, detail panes and the mount-activity pill can't
 * drift apart.
 *
 * The element-set marker always leads, named or not:
 *   "TLE · 12545"          — no name known
 *   "TLE · MOLNIYA 2-10"   — named
 *   "SV · 41838"
 *   "SV · MOLNIYA 2-10"
 *
 * It is unconditional because one object can appear as both rows at once, and
 * the two disagree about where it is whenever the state vector has aged — so
 * which element set produced a row is never incidental.
 */
export function satLabel(
  record: { name?: string; kind?: ElementSetKind } | undefined,
  noradId: string,
): SatLabel {
  const prefix = record?.kind === "sv" ? "SV" : "TLE";
  const isPlaceholder = isPlaceholderName(record?.name);
  const tail = isPlaceholder ? noradId : record!.name!;
  return { isPlaceholder, prefix, noradId, tail, text: `${prefix} · ${tail}` };
}

export interface SatellitePosition {
  /** Which element set produced this position — a NORAD id alone isn't unique. */
  kind: ElementSetKind;
  noradId: string;
  ra: number;
  dec: number;
  alt: number;
  az: number;
  isVisible: boolean;
  range: number;
  velocity: number;
  /** Minutes until satellite rises above horizon (null if already up or won't rise soon) */
  riseInMinutes: number | null;
  /** Minutes until satellite sets below horizon (null if already down or won't set soon) */
  setInMinutes: number | null;
  /** Max altitude this pass in degrees (null if not computed yet) */
  maxAlt: number | null;
  /** Sub-satellite latitude in degrees (only when geodetic mode active) */
  lat?: number;
  /** Sub-satellite longitude in degrees (only when geodetic mode active) */
  lon?: number;
  /** Orbital altitude above Earth surface in km (only when geodetic mode active) */
  satAlt?: number;
}

export interface SatelliteFilter {
  search: string;
  orbitRegimes: Set<string>;
  objectTypes: Set<string>;
  minElevation: number;
  onlyVisible: boolean;
  showBelowHorizon: boolean;
}

export interface SatelliteStore {
  /** Merged catalog: TLE and state-vector records side by side. */
  tles: CatalogRecord[];
  positions: SatellitePosition[];
  loading: boolean;
  lastRefresh: Date | null;
  cacheAge: number | null;
  filter: SatelliteFilter;

  setTLEs: (tles: CatalogRecord[]) => void;
  addTLE: (tle: CatalogRecord) => void;
  setPositions: (positions: SatellitePosition[]) => void;
  setLoading: (loading: boolean) => void;
  setLastRefresh: (date: Date) => void;
  updateFilter: (partial: Partial<SatelliteFilter>) => void;
}

export const useSatelliteStore = create<SatelliteStore>((set) => ({
  tles: [],
  positions: [],
  loading: false,
  lastRefresh: null,
  cacheAge: null,
  filter: {
    search: "",
    orbitRegimes: new Set(["LEO", "MEO", "GEO", "HEO"]),
    objectTypes: new Set(["PAYLOAD", "ROCKET_BODY", "DEBRIS", "UNKNOWN"]),
    minElevation: 0,
    onlyVisible: false,
    showBelowHorizon: true,
  },

  setTLEs: (tles) => set({ tles }),
  addTLE: (tle) =>
    set((s) =>
      s.tles.some((t) => sameSatKey(satKeyOf(t), satKeyOf(tle)))
        ? s
        : { tles: [...s.tles, tle] },
    ),
  setPositions: (positions) => set({ positions }),
  setLoading: (loading) => set({ loading }),
  setLastRefresh: (date) => set({ lastRefresh: date }),
  updateFilter: (partial) =>
    set((s) => ({ filter: { ...s.filter, ...partial } })),
}));
