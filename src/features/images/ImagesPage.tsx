import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JS9Viewer, type ImageSource } from "./JS9Viewer";
import { FileBrowserPanel, type BrowserGroup, type BrowserRow } from "./FileBrowserPanel";
import { HeaderPanel } from "./HeaderPanel";
import { ImageFilterBar } from "./ImageFilterBar";
import { useHeaderIndex, type ProductRef } from "./useHeaderIndex";
import { useResizableWidth } from "./useResizableWidth";
import { Toggle } from "../settings/Toggle";
import { useSensorKitStore } from "../../stores/sensorkit";
import { useUIPanelsStore } from "../../stores/uiPanels";
import {
  ProductListingNotReady,
  fetchControllerProducts,
  fetchProductMetadata,
  productDataUrl,
} from "../../lib/sensorkit-client/products";
import {
  buildFacets,
  matchesFilters,
  matchesSearch,
  toCards,
  type FilterMap,
  type HeaderCards,
} from "../../lib/sensorkit-client/fitsHeaders";
import type { ProductEntry, ProductMetadata } from "../../lib/sensorkit-client/types";
import { useCompactLayout } from "../../lib/useMediaQuery";

/** Rows rendered per controller. The list is unvirtualized, and a deep catalog
 *  can run to tens of thousands of files; the remainder is reported in the
 *  panel rather than silently dropped. */
const MAX_ROWS = 500;

/** Retry delay while SK's initial product scan is still running (503). */
const LISTING_RETRY_MS = 2000;

function ResizeHandle({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="w-1.5 shrink-0 cursor-col-resize bg-panel-border/30 transition-colors hover:bg-blue-400/50"
    />
  );
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `2026-07-24T21:14:03Z` → `07-24 21:14`, in local time. */
function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Newest first: by file register time, falling back to the name. */
function sortKey(e: ProductEntry): string {
  return e.registerTime ?? e.productId;
}

export function ImagesPage() {
  const [source, setSource] = useState<ImageSource | null>(null);
  const [open, setOpen] = useState<{ controllerId: string; productId: string } | null>(null);
  const [openMeta, setOpenMeta] = useState<ProductMetadata | null>(null);
  // Guards against a slow header fetch clobbering a newer selection.
  const openKeyRef = useRef<string | null>(null);

  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<FilterMap>({});
  // null = show the raw filename. Defaults to the filename so the list reads
  // the same as it did before indexing; a header keyword is opt-in.
  const [labelKeyword, setLabelKeyword] = useState<string | null>(null);

  const products = useSensorKitStore((s) => s.products);
  const productCatalog = useSensorKitStore((s) => s.productCatalog);
  const productHeaders = useSensorKitStore((s) => s.productHeaders);
  const setProductCatalog = useSensorKitStore((s) => s.setProductCatalog);
  const mergeProductHeaders = useSensorKitStore((s) => s.mergeProductHeaders);
  const entities = useSensorKitStore((s) => s.entities);
  const selectedInstrumentId = useSensorKitStore((s) => s.selectedInstrumentId);
  const connection = useSensorKitStore((s) => s.connection);
  const latestProduct = useSensorKitStore((s) => s.latestProduct);

  const followLatest = useUIPanelsStore((s) => s.imagesFollowLatest);
  const setFollowLatest = useUIPanelsStore((s) => s.setImagesFollowLatest);

  const controllers = useMemo(
    () => entities.filter((e) => e.entity_type === "controller"),
    [entities],
  );
  const [controllerOverride, setControllerOverride] = useState<string | null>(null);
  const activeControllerId =
    controllerOverride ??
    selectedInstrumentId ??
    controllers.find((c) => c.online)?.name ??
    controllers[0]?.name ??
    null;

  const compact = useCompactLayout();
  const left = useResizableWidth(240, { side: "left", min: 160, max: 560 });
  const right = useResizableWidth(280, { side: "right", min: 160, max: 600 });

  /**
   * Ids products are registered under. These are NOT entity names: SK's
   * `from_path` strategy keys products by a directory segment under the serve
   * root (on this rig, "raw"), so the browser has to group by what the product
   * records actually carry. Entity controller names are tried too, for deploys
   * configured with `from_metadata`.
   */
  const groupIds = useMemo(() => {
    const ids = new Set([...Object.keys(products), ...Object.keys(productCatalog)]);
    for (const c of controllers) ids.add(c.name);
    return [...ids].sort();
  }, [products, productCatalog, controllers]);
  const groupIdsKey = groupIds.join(" ");

  // Deep history: the firehose map is trimmed to the newest 200 per controller,
  // so the full catalog has to come from the REST listing. SK answers 503 while
  // its initial directory scan runs — retry rather than showing a short list.
  const [listingError, setListingError] = useState<string | null>(null);
  const listedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (connection !== "open") return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const load = async (id: string) => {
      try {
        const infos = await fetchControllerProducts(id);
        if (cancelled) return;
        listedRef.current.add(id);
        setProductCatalog(id, infos);
        setListingError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ProductListingNotReady) {
          setListingError("Waiting for SensorKit to finish scanning products…");
          timers.push(setTimeout(() => void load(id), LISTING_RETRY_MS));
          return;
        }
        // An id that isn't a serve group 404s — expected while probing entity
        // names. Only a real failure on a group we know has products matters.
        if (id in products) {
          setListingError("Couldn't load the full product listing; showing recent files only.");
        }
      }
    };

    for (const id of groupIds) {
      if (!listedRef.current.has(id)) void load(id);
    }

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
    // `products` is read only to classify a failure; re-running on every
    // firehose flush would refetch listings needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupIdsKey, connection, setProductCatalog]);

  // Every product known per group: the REST catalog plus live arrivals that
  // postdate it, newest first.
  const entriesByGroup = useMemo(() => {
    const out = new Map<string, ProductEntry[]>();
    for (const id of groupIds) {
      const merged: Record<string, ProductEntry> = {
        ...productCatalog[id],
        ...products[id],
      };
      const list = Object.values(merged).sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
      if (list.length > 0) out.set(id, list);
    }
    return out;
  }, [groupIds, productCatalog, products]);

  const refs = useMemo(() => {
    const out: ProductRef[] = [];
    for (const [controllerId, list] of entriesByGroup) {
      for (const e of list) out.push({ controllerId, productId: e.productId });
    }
    return out;
  }, [entriesByGroup]);
  const index = useHeaderIndex(refs);

  // Flatten the indexed headers once; facets and row matching both read these.
  const cardsById = useMemo(() => {
    const out = new Map<string, HeaderCards>();
    for (const controllerId of entriesByGroup.keys()) {
      const byId = productHeaders[controllerId];
      if (!byId) continue;
      for (const [productId, meta] of Object.entries(byId)) {
        out.set(`${controllerId}/${productId}`, toCards(meta));
      }
    }
    return out;
  }, [entriesByGroup, productHeaders]);

  const facets = useMemo(() => buildFacets([...cardsById.values()]), [cardsById]);

  const groups: BrowserGroup[] = useMemo(() => {
    const out: BrowserGroup[] = [];
    for (const [controllerId, list] of entriesByGroup) {
      const rows: BrowserRow[] = [];
      let matches = 0;
      for (const entry of list) {
        const cards = cardsById.get(`${controllerId}/${entry.productId}`);
        if (!matchesSearch(cards, entry.productId, search)) continue;
        // A product with no header yet can't satisfy a keyword predicate; keep
        // it out rather than showing it as a match the index hasn't confirmed.
        if (!matchesFilters(cards ?? {}, filters)) continue;
        matches++;
        if (rows.length >= MAX_ROWS) continue;

        const labelled = labelKeyword ? cards?.[labelKeyword] : undefined;
        rows.push({
          productId: entry.productId,
          label: labelled ?? entry.productId,
          detail: [formatTime(entry.registerTime), formatSize(entry.dataSize)]
            .filter(Boolean)
            .join(" · "),
        });
      }
      out.push({ controllerId, rows, total: list.length, capped: matches - rows.length });
    }
    return out;
  }, [entriesByGroup, cardsById, search, filters, labelKeyword]);

  const onSelectFile = useCallback(
    async (controllerId: string, productId: string) => {
      const key = `${controllerId}/${productId}`;
      setSource({ kind: "url", url: productDataUrl(controllerId, productId), name: productId });
      setOpen({ controllerId, productId });
      openKeyRef.current = key;

      const cached = useSensorKitStore.getState().productHeaders[controllerId]?.[productId];
      if (cached) {
        setOpenMeta(cached);
        return;
      }
      setOpenMeta(null);
      try {
        const meta = await fetchProductMetadata(controllerId, productId);
        // Feed the index too, so opening a file also fills its facet values.
        mergeProductHeaders(controllerId, { [productId]: meta });
        if (openKeyRef.current === key) setOpenMeta(meta);
      } catch {
        // Header is optional; the viewer still works without it.
      }
    },
    [mergeProductHeaders],
  );

  // Auto-follow: when enabled, open each new firehose-latest product as it
  // arrives — and snap to the current latest the moment it's switched on. Rides
  // the store's single `latestProduct` pointer (whose identity only changes on a
  // genuinely newer arrival, capped at the ~10Hz batch commit) instead of
  // rescanning the products map, and de-dupes by key so a same-product pointer
  // refresh (e.g. a backlog merge) doesn't reload the viewer.
  const followedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!followLatest) {
      followedKeyRef.current = null;
      return;
    }
    if (!latestProduct) return;
    const key = `${latestProduct.controllerId}/${latestProduct.productId}`;
    if (followedKeyRef.current === key) return;
    followedKeyRef.current = key;
    onSelectFile(latestProduct.controllerId, latestProduct.productId);
  }, [followLatest, latestProduct, onSelectFile]);

  const matchTotals = useMemo(
    () => ({
      matched: groups.reduce((n, g) => n + g.rows.length + g.capped, 0),
      total: groups.reduce((n, g) => n + g.total, 0),
    }),
    [groups],
  );

  const browser = (
    <>
      <ImageFilterBar
        facets={facets}
        search={search}
        onSearch={setSearch}
        filters={filters}
        onFilters={setFilters}
        labelKeyword={labelKeyword}
        onLabelKeyword={setLabelKeyword}
      />
      <div className="flex items-center gap-2 border-b border-panel-border px-2 py-1 font-mono text-[9.5px] text-text-dim/70">
        <span>
          {index.running
            ? `indexing ${index.indexed} / ${index.total} headers…`
            : `${index.indexed} / ${index.total} headers indexed`}
        </span>
        {matchTotals.matched !== matchTotals.total && (
          <span className="ml-auto text-blue-300/80">
            {matchTotals.matched} of {matchTotals.total} match
          </span>
        )}
      </div>
      {listingError && (
        <p className="border-b border-panel-border px-2 py-1 text-[10.5px] text-text-dim">
          {listingError}
        </p>
      )}
      <FileBrowserPanel groups={groups} selected={open} onSelect={onSelectFile} />
    </>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Top bar: controller picker, or connection status when offline */}
      <div className="flex flex-wrap shrink-0 items-center gap-3 border-b border-panel-border px-3 py-2">
        {connection !== "open" ? (
          <span className="text-xs text-text-dim">Waiting for SensorKit connection…</span>
        ) : (
          <label className="flex min-w-0 items-center gap-2 text-xs text-text-dim">
            <span className="uppercase tracking-wide">Controller</span>
            {controllers.length > 0 && (
              <select
                value={activeControllerId ?? ""}
                onChange={(e) => setControllerOverride(e.target.value || null)}
                className="max-w-[60vw] rounded border border-panel-border bg-panel-bg/60 px-2 py-1 pointer-coarse:py-2 text-xs text-text-bright"
              >
                {controllers.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                    {c.online ? "" : " (offline)"}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}

        {/* Right-aligned live-follow switch: keep the viewer pinned to the
            newest image off the firehose. Off by default (persisted). */}
        <div className="ml-auto shrink-0">
          <Toggle
            size="sm"
            checked={followLatest}
            onChange={setFollowLatest}
            label={
              <span className="uppercase tracking-wide text-xs text-text-dim">Open latest image</span>
            }
            title="When on, the viewer jumps to the newest image as it arrives"
          />
        </div>
      </div>

      {compact ? (
        /* Compact: stack browser / viewer / header vertically — the fixed-width
           side panes would leave the viewer 0px on a phone. */
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="max-h-56 shrink-0 overflow-y-auto border-b border-panel-border">
            {browser}
          </div>
          <JS9Viewer
            source={source}
            className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden bg-sky-ink"
          />
          <div className="max-h-40 shrink-0 overflow-y-auto border-t border-panel-border">
            <HeaderPanel meta={openMeta} />
          </div>
        </div>
      ) : (
        /* Main: file browser | viewer | header */
        <div className="flex min-h-0 flex-1">
          <div
            style={{ width: left.width }}
            className="flex shrink-0 flex-col overflow-y-auto border-r border-panel-border"
          >
            {browser}
          </div>
          <ResizeHandle onPointerDown={left.onPointerDown} />

          <JS9Viewer
            source={source}
            className="flex min-w-0 flex-1 flex-col overflow-hidden bg-sky-ink"
          />

          <ResizeHandle onPointerDown={right.onPointerDown} />
          <div
            style={{ width: right.width }}
            className="shrink-0 overflow-y-auto border-l border-panel-border"
          >
            <HeaderPanel meta={openMeta} />
          </div>
        </div>
      )}
    </div>
  );
}
