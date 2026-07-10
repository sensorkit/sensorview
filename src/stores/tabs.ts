import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Canonical definition of the main app tabs. `id` is a stable key used for
 * ordering/detaching (never change it); `to` is the router path; `label` is the
 * display text. Order here is the default first-run order — the persisted store
 * takes over once the user rearranges the strip.
 */
export const TAB_DEFS = [
  { id: "skyview", to: "/", label: "SkyView" },
  { id: "devices", to: "/devices", label: "Devices" },
  { id: "tasks", to: "/tasks", label: "Tasks" },
  { id: "images", to: "/images", label: "Images" },
  { id: "status", to: "/status", label: "Status" },
  { id: "streams", to: "/streams", label: "Streams" },
  { id: "settings", to: "/settings", label: "Settings" },
] as const;

export type TabId = (typeof TAB_DEFS)[number]["id"];
export type TabDef = (typeof TAB_DEFS)[number];

const DEFAULT_ORDER = TAB_DEFS.map((t) => t.id) as TabId[];
const TAB_BY_ID = new Map(TAB_DEFS.map((t) => [t.id, t] as const));

/**
 * Reconcile a persisted order against the current TAB_DEFS: keep known ids in
 * their saved order, drop any that no longer exist, and append tabs added since
 * the order was saved (in their canonical position order). This keeps a stale
 * localStorage value from ever hiding a real tab or referencing a dead one.
 */
export function reconcileOrder(order: readonly TabId[]): TabId[] {
  const seen = new Set<TabId>();
  const kept: TabId[] = [];
  for (const id of order) {
    if (TAB_BY_ID.has(id) && !seen.has(id)) {
      seen.add(id);
      kept.push(id);
    }
  }
  for (const id of DEFAULT_ORDER) {
    if (!seen.has(id)) kept.push(id);
  }
  return kept;
}

/** Resolve an ordered list of ids to their full tab definitions. */
export function tabsFromOrder(order: readonly TabId[]): TabDef[] {
  return order.map((id) => TAB_BY_ID.get(id)!).filter(Boolean) as TabDef[];
}

interface TabsStore {
  /** User-arranged order of tab ids. Always run through reconcileOrder on read. */
  order: TabId[];
  /**
   * Tabs currently popped out into their own OS window (Electron only). This is
   * live runtime state owned by the main window — it is NOT persisted (see
   * partialize), and is kept in sync with the Electron main process via
   * onTabWindowClosed / listDetachedTabs.
   */
  detached: TabId[];
  /** Replace the whole order (e.g. after a drag settles). */
  setOrder: (order: TabId[]) => void;
  /**
   * Move `dragId` to `toIndex`, where `toIndex` is a slot in the order with
   * `dragId` removed (0 = first, length = last). This is the coordinate space
   * the drag-reorder gap is computed in.
   */
  reorderTo: (dragId: TabId, toIndex: number) => void;
  /** Mark a tab detached (popped out) or re-docked. */
  setDetached: (id: TabId, on: boolean) => void;
  /** Replace the detached set from an external source of truth (the main process). */
  syncDetached: (ids: readonly string[]) => void;
}

const KNOWN = new Set<string>(DEFAULT_ORDER);

export const useTabsStore = create<TabsStore>()(
  persist(
    (set, get) => ({
      order: DEFAULT_ORDER,
      detached: [],
      setOrder: (order) => set({ order: reconcileOrder(order) }),
      reorderTo: (dragId, toIndex) => {
        const cur = reconcileOrder(get().order);
        if (!cur.includes(dragId)) return;
        const without = cur.filter((id) => id !== dragId);
        const clamped = Math.max(0, Math.min(toIndex, without.length));
        without.splice(clamped, 0, dragId);
        set({ order: without });
      },
      setDetached: (id, on) =>
        set((s) => {
          const has = s.detached.includes(id);
          if (on === has) return s;
          return {
            detached: on ? [...s.detached, id] : s.detached.filter((x) => x !== id),
          };
        }),
      syncDetached: (ids) =>
        set({ detached: ids.filter((id): id is TabId => KNOWN.has(id)) }),
    }),
    {
      name: "sensorview.tabs",
      version: 1,
      // Persist only the arrangement — detached windows are ephemeral runtime state.
      partialize: (s) => ({ order: s.order }),
    },
  ),
);
