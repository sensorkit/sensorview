import { create } from "zustand";

export interface TLERecord {
  noradId: string;
  name: string;
  line1: string;
  line2: string;
  objectType?: "PAYLOAD" | "ROCKET_BODY" | "DEBRIS" | "UNKNOWN";
  orbitRegime?: "LEO" | "MEO" | "GEO" | "HEO" | "OTHER";
}

export interface SatellitePosition {
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
  tles: TLERecord[];
  positions: SatellitePosition[];
  loading: boolean;
  lastRefresh: Date | null;
  cacheAge: number | null;
  filter: SatelliteFilter;

  setTLEs: (tles: TLERecord[]) => void;
  addTLE: (tle: TLERecord) => void;
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
    set((s) => (s.tles.some((t) => t.noradId === tle.noradId) ? s : { tles: [...s.tles, tle] })),
  setPositions: (positions) => set({ positions }),
  setLoading: (loading) => set({ loading }),
  setLastRefresh: (date) => set({ lastRefresh: date }),
  updateFilter: (partial) =>
    set((s) => ({ filter: { ...s.filter, ...partial } })),
}));
