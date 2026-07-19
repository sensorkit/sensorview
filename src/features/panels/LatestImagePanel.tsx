import { useEffect, useMemo, useRef, useState } from "react";
import { useSensorKitStore } from "../../stores/sensorkit";
import { useUIPanelsStore } from "../../stores/uiPanels";
import { productPreviewUrl } from "../../lib/sensorkit-client/products";

/** Live-updating "12s ago / 4m ago" from an ISO timestamp; re-renders each second. */
function useRelativeTime(iso?: string): string | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Sliders-icon filter button + dropdown of controllerIds, matching the SkyView
 *  Catalog filter affordance (adapted to the dark panel theme). */
function ControllerFilter({
  controllers,
  value,
  onPick,
}: {
  controllers: string[];
  value: string | null;
  onPick: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const active = value != null;
  const color = active || open ? "var(--color-text-bright)" : "var(--color-text-dim)";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-pressed={open}
        title="Filter by controller"
        className="relative inline-flex items-center justify-center w-[18px] h-[18px] rounded-sm border border-panel-border cursor-pointer hover:bg-white/5 before:absolute before:-inset-2.5 before:content-['']"
        style={{ background: open ? "rgba(255,255,255,0.08)" : "transparent" }}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
          <line x1="1" y1="3.5" x2="13" y2="3.5" stroke={color} strokeWidth="1" />
          <line x1="1" y1="7" x2="13" y2="7" stroke={color} strokeWidth="1" />
          <line x1="1" y1="10.5" x2="13" y2="10.5" stroke={color} strokeWidth="1" />
          <circle cx="4" cy="3.5" r="1.6" fill="var(--color-panel-bg)" stroke={color} strokeWidth="1" />
          <circle cx="9.5" cy="7" r="1.6" fill="var(--color-panel-bg)" stroke={color} strokeWidth="1" />
          <circle cx="5.5" cy="10.5" r="1.6" fill="var(--color-panel-bg)" stroke={color} strokeWidth="1" />
        </svg>
        {active && (
          <span
            className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full"
            style={{ background: "var(--color-terracotta)" }}
          />
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[150px] max-w-[calc(100vw-2rem)] sm:max-w-[240px] max-h-[260px] overflow-auto rounded-md border border-panel-border bg-panel-bg/95 backdrop-blur-md shadow-xl py-1 text-[11px]">
          <button
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
            className={`block w-full text-left px-3 py-1 pointer-coarse:py-2.5 hover:bg-white/5 ${value == null ? "text-text-bright" : "text-text-dim"}`}
          >
            All
          </button>
          {controllers.map((c) => (
            <button
              key={c}
              onClick={() => {
                onPick(c);
                setOpen(false);
              }}
              title={c}
              className={`block w-full text-left px-3 py-1 pointer-coarse:py-2.5 hover:bg-white/5 truncate ${value === c ? "text-text-bright" : "text-text-dim"}`}
            >
              {c}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Shows only the most-recent image off the firehose as the server's Zscaled JPEG
 * preview. A header carries the controller filter, filename, and a live "X ago"
 * ticker; the image fills the rest. Closed via its arrow tab. The <img> key is
 * the product id, so a new arrival swaps the source and the browser refetches.
 */
export function LatestImagePanel() {
  const products = useSensorKitStore((s) => s.products);
  const globalLatest = useSensorKitStore((s) => s.latestProduct);
  const filterId = useUIPanelsStore((s) => s.imageFilterControllerId);
  const setFilterId = useUIPanelsStore((s) => s.setImageFilterControllerId);

  const controllers = useMemo(() => Object.keys(products).sort(), [products]);

  // With a filter, show the newest product within that controller; otherwise the
  // global firehose-latest tracked on the store.
  const displayed = useMemo(() => {
    if (!filterId) return globalLatest;
    const byId = products[filterId];
    if (!byId) return null;
    let best: { productId: string; registerTime?: string } | null = null;
    let bestKey = "";
    for (const e of Object.values(byId)) {
      const k = e.registerTime ?? e.productId;
      if (!best || k.localeCompare(bestKey) > 0) {
        best = { productId: e.productId, registerTime: e.registerTime };
        bestKey = k;
      }
    }
    return best
      ? { controllerId: filterId, productId: best.productId, registerTime: best.registerTime }
      : null;
  }, [filterId, products, globalLatest]);

  // Track the product whose preview failed, not a bare boolean — otherwise a
  // stale error would suppress the next arrival's image too.
  const [erroredKey, setErroredKey] = useState<string | null>(null);
  const age = useRelativeTime(displayed?.registerTime);

  const key = displayed ? `${displayed.controllerId}/${displayed.productId}` : null;
  const showImage = displayed && erroredKey !== key;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Fixed 44px to match the Images page "Controller" bar height. */}
      <div className="shrink-0 flex items-center gap-2 px-3 h-[44px] border-b border-panel-border">
        <ControllerFilter controllers={controllers} value={filterId} onPick={setFilterId} />
        {displayed && (
          <span className="mono text-[10px] text-text-dim truncate" title={displayed.productId}>
            {displayed.productId}
          </span>
        )}
        {displayed && age && (
          <span className="ml-auto shrink-0 text-[10px] text-text-dim tabular-nums">{age}</span>
        )}
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center bg-black/40 p-2">
        {showImage ? (
          <img
            key={key}
            src={productPreviewUrl(displayed.controllerId, displayed.productId)}
            alt={displayed.productId}
            className="max-w-full max-h-full object-contain"
            onError={() => setErroredKey(key)}
          />
        ) : (
          <div className="text-text-dim text-xs">
            {displayed
              ? "Preview unavailable"
              : filterId
                ? "No image for this controller"
                : "Waiting for first image…"}
          </div>
        )}
      </div>
    </div>
  );
}
