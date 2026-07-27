import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SatKey } from "./satellites";

export type ViewMode = "sky" | "overhead" | "groundtrack";
export type StarCatalogChoice = "HR" | "HIP";
export type RAUnit = "hr" | "deg";
export type CatalogTab = "satellites" | "stars" | "horizons";

/**
 * A Horizons object the operator selected. Carries the current position for the
 * marker, a sampled on-sky path for the motion track, and the readout values.
 * Ephemeral (not persisted).
 */
export interface HorizonsSelection {
  name: string;
  command: string;
  isSun: boolean;
  ra: number; // current RA, degrees (ICRF)
  dec: number; // current Dec, degrees
  magnitude: number | null;
  rangeAu: number | null;
  rateArcsecHr: number | null; // total apparent sky-motion rate
  track: { ra: number; dec: number }[]; // sampled path for the canvas overlay
}

export interface TransitionState {
  from: ViewMode;
  to: ViewMode;
  progress: number; // 0..1 (eased)
  startTime: number; // performance.now()
}

export interface ViewState {
  /** Projection center in RA/Dec degrees */
  centerRA: number;
  centerDec: number;
  /** Zoom scale factor (1 = default hemisphere view) */
  zoom: number;
  /** Limiting magnitude for star display */
  limitingMagnitude: number;
  /** Show constellation lines */
  showConstellations: boolean;
  /** Show grid lines */
  showGrid: boolean;
  /** Follow mount pointing */
  followMount: boolean;
  /** Show Sun, Moon, planets on SkyView */
  showSolarSystem: boolean;
}

export interface SkyViewStore extends ViewState {
  /** Active view mode */
  viewMode: ViewMode;

  /** Which star catalog to load + display in the Stars list. Persisted. */
  starCatalog: StarCatalogChoice;
  /** Unit shown in the Stars list's RA column. Persisted. */
  raUnit: RAUnit;
  /** Active segment in the catalog column. Not persisted — ephemeral nav state. */
  catalogTab: CatalogTab;
  /** Width of the right-hand catalog column in px. Persisted — the divider
   *  between the sky scene and the catalog is draggable, trading width
   *  between the two (narrower catalog = wider sky renderer). */
  catalogWidth: number;

  /** Currently selected satellite NORAD ID */
  /** Selected catalog object — kind and id, since a NORAD id alone is not unique. */
  selectedSatellite: SatKey | null;
  /** Currently selected star index in catalog */
  selectedStarIndex: number | null;
  /** Currently selected solar-system body name (e.g. "Sun", "Moon", "Mars"). */
  selectedBodyName: string | null;
  /** Currently selected JPL Horizons object (search-driven targeting). */
  selectedHorizonsTarget: HorizonsSelection | null;
  /** Free-form target entered manually (RA/Dec degrees). Mutually exclusive with entity selection. */
  manualTarget: { ra: number; dec: number } | null;
  /** Whether the detail sheet is open */
  detailSheetOpen: boolean;
  /** Whether the satellite list panel is open */
  listPanelOpen: boolean;

  /** Overhead view state */
  overheadZoom: number;
  /** Pan center for the overhead globe (degrees). null = follow observer. */
  overheadCenter: { lon: number; lat: number } | null;

  /** Ground track view state */
  groundTrackCenterLon: number;
  groundTrackCenterLat: number;
  groundTrackZoom: number;

  /** Transition animation state */
  transition: TransitionState | null;

  setViewMode: (mode: ViewMode) => void;
  startTransition: (to: ViewMode) => void;
  setTransitionProgress: (progress: number) => void;
  completeTransition: () => void;
  setCenter: (ra: number, dec: number) => void;
  setZoom: (zoom: number) => void;
  setLimitingMagnitude: (mag: number) => void;
  toggleConstellations: () => void;
  toggleGrid: () => void;
  toggleFollowMount: () => void;
  toggleSolarSystem: () => void;
  selectSatellite: (key: SatKey | null) => void;
  selectStar: (index: number | null) => void;
  selectBody: (name: string | null) => void;
  selectHorizonsTarget: (sel: HorizonsSelection | null) => void;
  setManualTarget: (ra: number, dec: number) => void;
  clearManualTarget: () => void;
  setDetailSheetOpen: (open: boolean) => void;
  setListPanelOpen: (open: boolean) => void;
  setOverheadZoom: (zoom: number) => void;
  setOverheadCenter: (center: { lon: number; lat: number } | null) => void;
  setGroundTrackCenter: (lon: number, lat: number) => void;
  setGroundTrackZoom: (zoom: number) => void;
  setStarCatalog: (kind: StarCatalogChoice) => void;
  setRAUnit: (unit: RAUnit) => void;
  setCatalogTab: (tab: CatalogTab) => void;
  setCatalogWidth: (width: number) => void;
}

export const useSkyViewStore = create<SkyViewStore>()(
  persist(
    (set) => ({
  // Will be overridden on mount to show current zenith
  centerRA: 0,
  centerDec: 0,
  zoom: 1,
  // Hard cap on rendered stars. Defaults high enough that the adaptive
  // mag formula in SkyCanvas controls how deep we go in practice; a user
  // who wants to manually clamp visibility can still lower this via the
  // setter (e.g. "always show only mag<6") and the renderer respects it.
  limitingMagnitude: 15,
  showConstellations: true,
  showGrid: false,
  followMount: false,
  showSolarSystem: true,
  viewMode: "sky",
  selectedSatellite: null,
  selectedStarIndex: null,
  selectedBodyName: null,
  selectedHorizonsTarget: null,
  manualTarget: null,
  detailSheetOpen: false,
  listPanelOpen: true,
  overheadZoom: 1,
  overheadCenter: null,
  groundTrackCenterLon: 0,
  groundTrackCenterLat: 0,
  groundTrackZoom: 1,
  transition: null,
  starCatalog: "HR" as StarCatalogChoice,
  raUnit: "hr" as RAUnit,
  catalogTab: "satellites" as CatalogTab,
  catalogWidth: 354,

  setViewMode: (mode) =>
    // Jump straight to the new view — no crossfade. Rendering both canvases
    // during a transition (overhead is already the heaviest) was locking the
    // main thread for long enough to feel like a hang. Sky↔track also doesn't
    // animate, so behavior is consistent across all mode switches now.
    set((s) => ({
      viewMode: mode,
      selectedStarIndex: mode !== "sky" ? null : s.selectedStarIndex,
      detailSheetOpen: mode !== "sky" && s.selectedStarIndex !== null ? false : s.detailSheetOpen,
    })),
  startTransition: (to) =>
    set((s) => ({
      transition: { from: s.viewMode, to, progress: 0, startTime: performance.now() },
    })),
  setTransitionProgress: (progress) =>
    set((s) => (s.transition ? { transition: { ...s.transition, progress } } : {})),
  completeTransition: () =>
    set((s) => {
      if (!s.transition) return {};
      return {
        viewMode: s.transition.to,
        transition: null,
      };
    }),
  setCenter: (ra, dec) => set({ centerRA: ra, centerDec: dec }),
  setZoom: (zoom) => set({ zoom }),
  setLimitingMagnitude: (mag) => set({ limitingMagnitude: mag }),
  toggleConstellations: () =>
    set((s) => ({ showConstellations: !s.showConstellations })),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  toggleFollowMount: () => set((s) => ({ followMount: !s.followMount })),
  toggleSolarSystem: () => set((s) => ({ showSolarSystem: !s.showSolarSystem })),
  selectSatellite: (key) =>
    set({
      selectedSatellite: key,
      selectedStarIndex: null,
      selectedBodyName: null,
      selectedHorizonsTarget: null,
      manualTarget: null,
      detailSheetOpen: key !== null,
    }),
  selectStar: (index) =>
    set({
      selectedStarIndex: index,
      selectedSatellite: null,
      selectedBodyName: null,
      selectedHorizonsTarget: null,
      manualTarget: null,
      detailSheetOpen: index !== null,
    }),
  selectBody: (name) =>
    set({
      selectedBodyName: name,
      selectedSatellite: null,
      selectedStarIndex: null,
      selectedHorizonsTarget: null,
      manualTarget: null,
      detailSheetOpen: name !== null,
    }),
  selectHorizonsTarget: (sel) =>
    set({
      selectedHorizonsTarget: sel,
      selectedSatellite: null,
      selectedStarIndex: null,
      selectedBodyName: null,
      manualTarget: null,
      detailSheetOpen: sel !== null,
    }),
  setManualTarget: (ra, dec) =>
    set({
      manualTarget: { ra, dec },
      selectedSatellite: null,
      selectedStarIndex: null,
      selectedBodyName: null,
      selectedHorizonsTarget: null,
      detailSheetOpen: true,
    }),
  clearManualTarget: () =>
    set((s) => ({
      manualTarget: null,
      detailSheetOpen:
        s.selectedSatellite !== null ||
        s.selectedStarIndex !== null ||
        s.selectedBodyName !== null ||
        s.selectedHorizonsTarget !== null
          ? s.detailSheetOpen
          : false,
    })),
  setDetailSheetOpen: (open) =>
    set({ detailSheetOpen: open, selectedSatellite: open ? undefined : null }),
  setListPanelOpen: (open) => set({ listPanelOpen: open }),
  setOverheadZoom: (zoom) => set({ overheadZoom: zoom }),
  setOverheadCenter: (center) => set({ overheadCenter: center }),
  setGroundTrackCenter: (lon, lat) => set({ groundTrackCenterLon: lon, groundTrackCenterLat: lat }),
  setGroundTrackZoom: (zoom) => set({ groundTrackZoom: zoom }),
  setStarCatalog: (kind) => set({ starCatalog: kind }),
  setRAUnit: (unit) => set({ raUnit: unit }),
  setCatalogTab: (tab) => set({ catalogTab: tab }),
  setCatalogWidth: (width) => set({ catalogWidth: width }),
    }),
    {
      name: "sensorview.skyview",
      version: 1,
      // Only persist user prefs that survive a reload by design. Everything
      // else (selections, transition state, view-mode-specific zooms) is
      // ephemeral and resets every time.
      partialize: (s) => ({
        starCatalog: s.starCatalog,
        raUnit: s.raUnit,
        catalogWidth: s.catalogWidth,
      }),
    },
  ),
);
