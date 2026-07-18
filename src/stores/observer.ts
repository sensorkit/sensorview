import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * A geodetic observing site. `alt` is meters above the ellipsoid. `name` is a
 * free-form label shown in the UI (a place name, or a controller entity key
 * when the site comes live from SensorKit).
 */
export interface ObserverLocation {
  lat: number;
  lon: number;
  alt: number;
  name: string;
}

/**
 * Seed for the manually-configured site. Matches the historical hardcoded
 * SkyView fallback so first-run behavior is unchanged before the operator sets
 * anything. Haleakalā High Altitude Observatory, Maui.
 */
export const DEFAULT_MANUAL_LOCATION: ObserverLocation = {
  lat: 20.7084,
  lon: -156.2568,
  alt: 3055,
  name: "Haleakalā, Maui",
};

interface ObserverStore {
  /** Operator-entered site. Used by SkyView when overriding SensorKit, and as
   *  the fallback whenever no live controller site is available (offline use). */
  manual: ObserverLocation;
  /**
   * When true, SkyView always uses {@link manual}, ignoring any live SensorKit
   * controller SitePosition. When false, a live controller site wins and manual
   * is only the fallback. Persisted — this is operator intent.
   */
  overrideSensorKit: boolean;

  setManual: (patch: Partial<ObserverLocation>) => void;
  setOverride: (value: boolean) => void;
}

export const useObserverStore = create<ObserverStore>()(
  persist(
    (set) => ({
      manual: DEFAULT_MANUAL_LOCATION,
      overrideSensorKit: false,
      setManual: (patch) => set((s) => ({ manual: { ...s.manual, ...patch } })),
      setOverride: (value) => set({ overrideSensorKit: value }),
    }),
    { name: "sensorview.observer", version: 1 },
  ),
);
