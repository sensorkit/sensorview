import { useRef } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AgentCapabilities,
  AgentState,
  ConnectionStatus,
  EntityListing,
  ProductEntry,
  ProductInfo,
  SKRecord,
  SitePosition,
} from "../lib/sensorkit-client/types";

/** Nested key for cached state: `path.join("/")` → prop → payload. */
export type StateMap = Record<string, Record<string, unknown>>;

/** Data products per controller: controllerId → productId → entry. */
type ProductsMap = Record<string, Record<string, ProductEntry>>;

/** Pointer to the single newest product across all controllers (the firehose's latest image). */
export type LatestProduct = {
  controllerId: string;
  productId: string;
  registerTime?: string;
};

/** What a given instrument has been commanded to follow. */
export type TrackedMountTarget =
  | { kind: "satellite"; noradId: string }
  | { kind: "icrs"; ra: number; dec: number };

export interface SensorKitStore {
  connection: ConnectionStatus;
  lastError: string | null;
  entities: EntityListing[];
  state: StateMap;
  /** FITS products served by SK, keyed by controller. Fed live by the firehose. */
  products: ProductsMap;
  /** Newest product across all controllers — drives the latest-image pop-out. null until one arrives. */
  latestProduct: LatestProduct | null;
  /** User-chosen controller (instrument). null = auto (first online). */
  selectedInstrumentId: string | null;
  /** Last target commanded per instrument, keyed by controller id. */
  mountTargets: Record<string, TrackedMountTarget>;

  setConnection: (status: ConnectionStatus, error?: string) => void;
  setEntities: (entities: EntityListing[]) => void;
  applyRecord: (record: SKRecord) => void;
  /**
   * Apply a batch of records in ONE store commit. The SSE client buffers the
   * firehose and flushes through here on a ~100ms cadence, so subscribers see
   * at most ~10 notifications/s no matter how fast telemetry arrives.
   * (Per-record `set()` calls used to notify every subscriber for every mount
   * pointing tick — the renderer-pegging/clock-freeze bug.)
   */
  applyRecords: (records: SKRecord[]) => void;
  /** Merge backlog products (from the REST listing) without dropping a fetched header. */
  applyProductListing: (controllerId: string, infos: ProductInfo[]) => void;
  resetState: () => void;
  setSelectedInstrumentId: (id: string | null) => void;
  setMountTarget: (instrumentId: string, target: TrackedMountTarget | null) => void;

  getState: <T = unknown>(entityId: string, prop: string) => T | null;
  /** Products for a controller, newest first. */
  getControllerProducts: (controllerId: string) => ProductEntry[];
  getSitePosition: () => SitePosition | null;
  getAgentState: () => AgentState | null;
  getAgentCapabilities: () => AgentCapabilities | null;
}

function applyOne(state: StateMap, record: SKRecord): StateMap {
  const [, , subject, payload] = record;
  const key = subject.path.join("/");
  const prev = state[key] ?? {};

  // SK's webapi forwarder emits records with `payload: null` to mark KV
  // entry deletes (see core/webapi/forwarder.py). EntityLease in
  // particular relies on this — when the broker-level TTL expires the
  // entity goes away by deleting that key, and consumers detect the
  // departure via `"EntityLease" in state[entity]`. Mirror SK's own
  // cache semantics: pop the prop rather than writing null.
  if (payload === null) {
    if (!(subject.prop in prev)) return state;
    const nextEntity = { ...prev };
    delete nextEntity[subject.prop];
    return { ...state, [key]: nextEntity };
  }

  if (prev[subject.prop] === payload) return state;
  return { ...state, [key]: { ...prev, [subject.prop]: payload } };
}

/**
 * Route a `kind:"product"` firehose record into the products map. SK shares the
 * firehose between KV/stream and product forwarders, so these arrive on the same
 * connection; we keep them out of the generic `state` map (where the productId
 * would masquerade as a KV keyword on the controller) and in their own slice.
 */
function applyProduct(products: ProductsMap, record: SKRecord): ProductsMap {
  const [, , subject, payload] = record;
  const controllerId = subject.path.join("/");
  const productId = subject.prop;
  const prev = products[controllerId] ?? {};

  // payload null marks a removed product (file gone); mirror applyOne and pop.
  if (payload === null) {
    if (!(productId in prev)) return products;
    const next = { ...prev };
    delete next[productId];
    return { ...products, [controllerId]: next };
  }

  // Payload is a ProductInfo. Keep any header already fetched for this product.
  const info = payload as ProductInfo;
  const entry: ProductEntry = {
    ...prev[productId],
    productId,
    registerTime: info.register_time,
    dataSize: info.data_size,
  };
  return { ...products, [controllerId]: { ...prev, [productId]: entry } };
}

/** Newest first: by file register time, falling back to the name. */
function productSortKey(e: ProductEntry): string {
  return e.registerTime ?? e.productId;
}

/**
 * Cap on live-firehose product retention per controller. SK's webapi replays
 * the entire on-disk product catalog into every new subscription (~tens of
 * thousands of FITS on this rig); the live map only needs enough for the
 * latest-image panel and recent history.
 */
const MAX_LIVE_PRODUCTS_PER_CONTROLLER = 200;

const latestKey = (registerTime: string | undefined, productId: string): string =>
  registerTime ?? productId;

/** Full scan for the newest product across every controller. Used on the rare
 *  paths (deletion of the current latest, backlog merge) where an incremental
 *  compare isn't enough. */
function latestFromProducts(products: ProductsMap): LatestProduct | null {
  let best: LatestProduct | null = null;
  let bestKey = "";
  for (const [controllerId, byId] of Object.entries(products)) {
    for (const entry of Object.values(byId)) {
      const key = latestKey(entry.registerTime, entry.productId);
      if (!best || key.localeCompare(bestKey) > 0) {
        best = { controllerId, productId: entry.productId, registerTime: entry.registerTime };
        bestKey = key;
      }
    }
  }
  return best;
}

/** Resolve the new latest pointer after a single firehose product record. */
function latestAfterRecord(
  current: LatestProduct | null,
  nextProducts: ProductsMap,
  record: SKRecord,
): LatestProduct | null {
  const [, , subject, payload] = record;
  const controllerId = subject.path.join("/");
  const productId = subject.prop;

  if (payload === null) {
    // A delete only matters if it removed the product we were pointing at.
    if (current && current.controllerId === controllerId && current.productId === productId) {
      return latestFromProducts(nextProducts);
    }
    return current;
  }

  const registerTime = (payload as ProductInfo).register_time;
  const incomingKey = latestKey(registerTime, productId);
  const currentKey = current ? latestKey(current.registerTime, current.productId) : "";
  if (!current || incomingKey.localeCompare(currentKey) >= 0) {
    return { controllerId, productId, registerTime };
  }
  return current;
}

/**
 * True iff this entity's live KV state identifies it as a controller. Reads
 * `entity_type` from the EntityInfo keyword (current SK), with a fallback to a
 * top-level `type` field (older SK).
 *
 * Keyed off live `state` (not the `/entities` snapshot) on purpose: the
 * snapshot is only refetched on SSE (re)connect, but EntityInfo/EntityLease/
 * Capabilities records stream in live, so a controller that registers after
 * the initial fetch — e.g. shut down for maintenance, then brought back — is
 * recognized the moment its records arrive, no reconnect required. Both
 * `useInstruments` and `getSitePosition` gate on this so they stay in sync.
 */
export function isControllerState(
  entityState: Record<string, unknown> | undefined,
): boolean {
  if (!entityState) return false;
  const info = entityState["EntityInfo"] as { entity_type?: string } | undefined;
  return (
    info?.entity_type === "controller" ||
    (entityState as { type?: string }).type === "controller"
  );
}

export const useSensorKitStore = create<SensorKitStore>()(
  persist(
    (set, get) => ({
      connection: "idle",
      lastError: null,
      entities: [],
      state: {},
      products: {},
      latestProduct: null,
      selectedInstrumentId: null,
      mountTargets: {},

      setConnection: (status, error) =>
        set({ connection: status, lastError: error ?? null }),

      setEntities: (entities) => set({ entities }),

      applyRecord: (record) =>
        set((s) => {
          if (record[0] !== "product") return { state: applyOne(s.state, record) };
          const products = applyProduct(s.products, record);
          return { products, latestProduct: latestAfterRecord(s.latestProduct, products, record) };
        }),

      applyRecords: (records) =>
        set((s) => {
          let state = s.state;
          let latestProduct = s.latestProduct;
          // Product ingest is O(records), NOT O(records × map size): clone
          // each touched controller map ONCE per flush, then mutate the
          // clone. The per-record `{...prev}` spread in applyProduct was
          // quadratic across SK's subscribe-time replay of the ENTIRE
          // product catalog (tens of thousands of records at ~3k/s): the
          // renderer could never drain the SSE socket, backpressure made
          // the webapi drop the stream, and the reconnect triggered the
          // replay again — a self-sustaining main-thread peg.
          let products: ProductsMap | null = null;
          const cloned = new Set<string>();
          let latestDeleted = false;

          const controllerMap = (cid: string): Record<string, ProductEntry> => {
            if (products === null) products = { ...s.products };
            if (!cloned.has(cid)) {
              products[cid] = { ...(products[cid] ?? {}) };
              cloned.add(cid);
            }
            return products[cid]!;
          };

          for (const record of records) {
            if (record[0] !== "product") {
              state = applyOne(state, record);
              continue;
            }
            const [, , subject, payload] = record;
            const cid = subject.path.join("/");
            const pid = subject.prop;
            const map = controllerMap(cid);
            if (payload === null) {
              // payload null marks a removed product (file gone) — pop it.
              if (pid in map) {
                delete map[pid];
                if (
                  latestProduct &&
                  latestProduct.controllerId === cid &&
                  latestProduct.productId === pid
                ) {
                  latestDeleted = true;
                }
              }
              continue;
            }
            const info = payload as ProductInfo;
            map[pid] = {
              ...map[pid],
              productId: pid,
              registerTime: info.register_time,
              dataSize: info.data_size,
            };
            const incomingKey = latestKey(info.register_time, pid);
            const currentKey = latestProduct
              ? latestKey(latestProduct.registerTime, latestProduct.productId)
              : "";
            if (!latestProduct || incomingKey.localeCompare(currentKey) >= 0) {
              latestProduct = { controllerId: cid, productId: pid, registerTime: info.register_time };
              latestDeleted = false;
            }
          }

          if (products !== null) {
            // Bound each touched controller's live map to the newest N. The
            // firehose replays the full historical catalog on every
            // (re)connect; retaining all of it costs memory and makes every
            // downstream sort/scan proportional to disk history. Consumers of
            // deep history (ImagesPage) fetch the REST listing instead.
            for (const cid of cloned) {
              const map = (products as ProductsMap)[cid]!;
              const ids = Object.keys(map);
              if (ids.length > MAX_LIVE_PRODUCTS_PER_CONTROLLER) {
                ids.sort((a, b) =>
                  productSortKey(map[b]!).localeCompare(productSortKey(map[a]!)),
                );
                const trimmed: Record<string, ProductEntry> = {};
                for (const id of ids.slice(0, MAX_LIVE_PRODUCTS_PER_CONTROLLER)) {
                  trimmed[id] = map[id]!;
                }
                (products as ProductsMap)[cid] = trimmed;
              }
            }
            if (latestDeleted) latestProduct = latestFromProducts(products);
          }

          const patch: Partial<SensorKitStore> = {};
          if (state !== s.state) patch.state = state;
          if (products !== null) {
            patch.products = products;
            patch.latestProduct = latestProduct;
          }
          return patch;
        }),

      applyProductListing: (controllerId, infos) =>
        set((s) => {
          const prev = s.products[controllerId] ?? {};
          const next = { ...prev };
          let changed = false;
          for (const info of infos) {
            const existing = next[info.product_id];
            if (
              !existing ||
              existing.registerTime !== info.register_time ||
              existing.dataSize !== info.data_size
            ) {
              next[info.product_id] = {
                ...existing,
                productId: info.product_id,
                registerTime: info.register_time,
                dataSize: info.data_size,
              };
              changed = true;
            }
          }
          if (!changed) return {};
          const products = { ...s.products, [controllerId]: next };
          // Backlog can surface a product newer than anything seen live (e.g. on
          // reconnect), so re-derive the latest pointer from the merged map.
          return { products, latestProduct: latestFromProducts(products) };
        }),

      resetState: () => set({ state: {}, entities: [], products: {}, latestProduct: null }),

      setSelectedInstrumentId: (id) => set({ selectedInstrumentId: id }),

      setMountTarget: (instrumentId, target) =>
        set((s) => {
          const next = { ...s.mountTargets };
          if (target === null) delete next[instrumentId];
          else next[instrumentId] = target;
          return { mountTargets: next };
        }),

      getState: <T = unknown>(entityId: string, prop: string) => {
        const v = get().state[entityId]?.[prop];
        return (v as T) ?? null;
      },

      getControllerProducts: (controllerId) => {
        const ctrl = get().products[controllerId];
        if (!ctrl) return [];
        return Object.values(ctrl).sort((a, b) =>
          productSortKey(b).localeCompare(productSortKey(a)),
        );
      },

      getSitePosition: () => {
        // SitePosition is taken from the controller only. Device-level
        // republishes (e.g. alpaca telescope echoing ASCOM's SiteElevation)
        // are mount-specific and frequently misconfigured; the controller
        // is the operator's source of truth.
        const state = get().state;
        for (const entityState of Object.values(state)) {
          if (!isControllerState(entityState)) continue;
          const sp = entityState["SitePosition"];
          if (sp) return sp as SitePosition;
        }
        return null;
      },

      // Agent state lives on whichever entity hosts the auto-orchestration
      // agent — name is up to the deployer (e.g. "agent", "agent_service").
      // Look it up by keyword presence rather than entity name.
      getAgentState: () => {
        const state = get().state;
        for (const entityState of Object.values(state)) {
          const a = entityState["AgentState"];
          if (a) return a as AgentState;
        }
        return null;
      },

      // Agent's published Capabilities (deprecated SK keyword) — same entity
      // as AgentState. Discriminated from per-entity Capabilities by `type`.
      getAgentCapabilities: () => {
        const state = get().state;
        for (const entityState of Object.values(state)) {
          const c = entityState["Capabilities"] as
            | { type?: string }
            | undefined;
          if (c?.type === "agent") return c as AgentCapabilities;
        }
        return null;
      },
    }),
    {
      name: "sensorview.sensorkit",
      version: 1,
      // Only persist user intent — `state` and `entities` must always come live from the webapi.
      partialize: (s) => ({
        mountTargets: s.mountTargets,
        selectedInstrumentId: s.selectedInstrumentId,
      }),
    },
  ),
);

/**
 * Subscribe to a *computed slice* of the SensorKit store with a custom
 * equality function.
 *
 * The `state` map gets a fresh identity on every applied record batch, so a
 * hook must NEVER do `useSensorKitStore((s) => s.state)` — that re-renders
 * the subscribing component (and its whole subtree) on every telemetry
 * flush, which is exactly the reconciliation storm that pegged the renderer
 * and froze the UTC clock. Instead: compute the minimal slice you need
 * inside `compute`, and return the previous reference whenever `equals`
 * says nothing changed so React bails out of the re-render entirely.
 *
 * Same ref-cache pattern as zustand's own `useShallow`, generalized to an
 * arbitrary equality function.
 */
export function useSensorKitSlice<T>(
  compute: (s: SensorKitStore) => T,
  equals: (a: T, b: T) => boolean,
): T {
  const cache = useRef<{ value: T } | null>(null);
  return useSensorKitStore((s) => {
    const next = compute(s);
    if (cache.current && equals(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { value: next };
    return next;
  });
}

/** Element-wise `Object.is` compare — pair with slices built as flat arrays. */
export function shallowArrayEqual(
  a: readonly unknown[],
  b: readonly unknown[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}
