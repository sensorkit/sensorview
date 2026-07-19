import { useCallback, useMemo, useRef, useState } from "react";
import { JS9Viewer, type ImageSource } from "./JS9Viewer";
import { FileBrowserPanel } from "./FileBrowserPanel";
import { HeaderPanel } from "./HeaderPanel";
import { useResizableWidth } from "./useResizableWidth";
import { useSensorKitStore } from "../../stores/sensorkit";
import { fetchProductMetadata, productDataUrl } from "../../lib/sensorkit-client/products";
import type { ProductMetadata } from "../../lib/sensorkit-client/types";
import { useCompactLayout } from "../../lib/useMediaQuery";

function ResizeHandle({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="w-1.5 shrink-0 cursor-col-resize bg-panel-border/30 transition-colors hover:bg-blue-400/50"
    />
  );
}

export function ImagesPage() {
  const [source, setSource] = useState<ImageSource | null>(null);
  const [open, setOpen] = useState<{ controllerId: string; productId: string } | null>(null);
  const [openMeta, setOpenMeta] = useState<ProductMetadata | null>(null);
  // Guards against a slow header fetch clobbering a newer selection.
  const openKeyRef = useRef<string | null>(null);

  const products = useSensorKitStore((s) => s.products);
  const entities = useSensorKitStore((s) => s.entities);
  const selectedInstrumentId = useSensorKitStore((s) => s.selectedInstrumentId);
  const connection = useSensorKitStore((s) => s.connection);

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

  const onSelectFile = useCallback(async (controllerId: string, productId: string) => {
    const key = `${controllerId}/${productId}`;
    setSource({ kind: "url", url: productDataUrl(controllerId, productId), name: productId });
    setOpen({ controllerId, productId });
    openKeyRef.current = key;

    const entry = useSensorKitStore.getState().products[controllerId]?.[productId];
    if (entry?.header) {
      setOpenMeta(entry.header);
      return;
    }
    setOpenMeta(null);
    try {
      const meta = await fetchProductMetadata(controllerId, productId);
      if (openKeyRef.current === key) setOpenMeta(meta);
    } catch {
      // Header is optional; the viewer still works without it.
    }
  }, []);

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
      </div>

      {compact ? (
        /* Compact: stack browser / viewer / header vertically — the fixed-width
           side panes would leave the viewer 0px on a phone. */
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="max-h-40 shrink-0 overflow-y-auto border-b border-panel-border">
            <FileBrowserPanel products={products} selected={open} onSelect={onSelectFile} />
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
            className="shrink-0 overflow-y-auto border-r border-panel-border"
          >
            <FileBrowserPanel products={products} selected={open} onSelect={onSelectFile} />
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
