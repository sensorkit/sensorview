import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Open/closed state and sizing for the global right-edge dock (latest-image
 * viewer + service log tailer). These are pure UI preferences, so unlike the
 * sensorkit store we persist the whole thing.
 */
export interface UIPanelsStore {
  imagePanelOpen: boolean;
  logPanelOpen: boolean;
  /** Width of the dock column in px. */
  dockWidth: number;
  /** Height of the image pane in px when both panels are open (log fills the rest). */
  imagePaneHeight: number;
  /** Restrict the latest-image panel to one controllerId; null = all (firehose latest). */
  imageFilterControllerId: string | null;
  /** Images tab: auto-open the newest image off the firehose as it arrives. Off by default. */
  imagesFollowLatest: boolean;
  /** Log panel font size in px. */
  logFontSize: number;
  /** Whether log lines word-wrap; false = no wrap (horizontal scroll). */
  logWrap: boolean;

  setImagePanelOpen: (open: boolean) => void;
  setLogPanelOpen: (open: boolean) => void;
  toggleImagePanel: () => void;
  toggleLogPanel: () => void;
  setDockWidth: (w: number) => void;
  setImagePaneHeight: (h: number) => void;
  setImageFilterControllerId: (id: string | null) => void;
  setImagesFollowLatest: (on: boolean) => void;
  setLogFontSize: (n: number) => void;
  toggleLogWrap: () => void;
}

export const useUIPanelsStore = create<UIPanelsStore>()(
  persist(
    (set) => ({
      imagePanelOpen: false,
      logPanelOpen: false,
      dockWidth: 360,
      imagePaneHeight: 300,
      imageFilterControllerId: null,
      imagesFollowLatest: false,
      logFontSize: 10.5,
      logWrap: true,

      setImagePanelOpen: (open) => set({ imagePanelOpen: open }),
      setLogPanelOpen: (open) => set({ logPanelOpen: open }),
      toggleImagePanel: () => set((s) => ({ imagePanelOpen: !s.imagePanelOpen })),
      toggleLogPanel: () => set((s) => ({ logPanelOpen: !s.logPanelOpen })),
      setDockWidth: (w) => set({ dockWidth: w }),
      setImagePaneHeight: (h) => set({ imagePaneHeight: h }),
      setImageFilterControllerId: (id) => set({ imageFilterControllerId: id }),
      setImagesFollowLatest: (on) => set({ imagesFollowLatest: on }),
      setLogFontSize: (n) => set({ logFontSize: n }),
      toggleLogWrap: () => set((s) => ({ logWrap: !s.logWrap })),
    }),
    { name: "sensorview.uipanels", version: 1 },
  ),
);
