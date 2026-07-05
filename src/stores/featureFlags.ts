import { create } from "zustand";
import { persist } from "zustand/middleware";

interface FeatureFlagsState {
  /**
   * Show per-device action buttons (Init/Deinit/Open/Close/Stop/etc.) on
   * DevicesPage cards. Bypasses the controller's orchestrated init sequence —
   * intended for daytime testing where operators want to exercise the mount
   * without opening the dome.
   */
  directDeviceControl: boolean;
  setDirectDeviceControl: (enabled: boolean) => void;
}

export const useFeatureFlags = create<FeatureFlagsState>()(
  persist(
    (set) => ({
      directDeviceControl: false,
      setDirectDeviceControl: (directDeviceControl) => set({ directDeviceControl }),
    }),
    {
      name: "sensorview.featureFlags.v1",
    },
  ),
);
