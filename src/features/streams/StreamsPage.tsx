import { useRef, useState } from "react";
import {
  type StreamLayout,
  type StreamSource,
  useStreamsStore,
} from "../../stores/streams";
import { unregisterUrlStream } from "../../lib/api-client/streams";
import { AddStreamModal } from "./AddStreamModal";
import { FullscreenView } from "./FullscreenView";
import { StreamTile } from "./StreamTile";

export function StreamsPage() {
  const sources = useStreamsStore((s) => s.sources);
  const layout = useStreamsStore((s) => s.layout);
  const setLayout = useStreamsStore((s) => s.setLayout);
  const removeSource = useStreamsStore((s) => s.removeSource);
  const reorderSources = useStreamsStore((s) => s.reorderSources);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StreamSource | null>(null);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const fullscreenSource = sources.find((s) => s.id === fullscreenId) ?? null;

  // Drag-reorder uses HTML5 dnd. We track the dragged tile's id in a ref so
  // any sibling tile's drop handler can read it without React state churn.
  const dragSourceId = useRef<string | null>(null);

  /** Tear down the MediaMTX path (best-effort) before forgetting the source. */
  const removeStream = (source: StreamSource) => {
    if (source.kind === "url" && source.protocol !== "mjpeg") {
      void unregisterUrlStream(source.id);
    }
    if (fullscreenId === source.id) setFullscreenId(null);
    removeSource(source.id);
  };

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (source: StreamSource) => {
    setEditing(source);
    setModalOpen(true);
  };
  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-4 space-y-4">
        {/* No page heading — the Streams nav tab itself is the label. */}
        <div className="flex items-center justify-end gap-2">
          <LayoutToggle layout={layout} setLayout={setLayout} />
          <button
            type="button"
            onClick={openAdd}
            className="px-3 py-1 pointer-coarse:py-2 text-[11px] uppercase tracking-wide rounded border border-orange-300/60 bg-orange-300/15 text-orange-200 hover:bg-orange-300/25"
          >
            + Add stream
          </button>
        </div>

        {sources.length === 0 ? (
          <div className="border border-dashed border-panel-border rounded-lg p-10 text-center text-sm text-text-dim">
            No streams configured. Click{" "}
            <span className="text-text-bright uppercase tracking-wide">+ Add stream</span>.
          </div>
        ) : (
          <div
            // Persisted layout choice applies from sm: up; below that the
            // tiles always stack single-column so headers aren't clipped.
            className={
              "grid gap-3 grid-cols-1" +
              (layout !== "1col" ? " sm:grid-cols-2" : "") +
              (layout === "3col" ? " lg:grid-cols-3" : "")
            }
          >
            {sources.map((source, i) => (
              <StreamTile
                key={source.id}
                source={source}
                onEdit={() => openEdit(source)}
                onRemove={() => removeStream(source)}
                onFullscreen={() => setFullscreenId(source.id)}
                fullscreenActive={fullscreenId === source.id}
                // HTML5 dnd never fires from touch input; these feed the
                // tile's coarse-pointer-only move buttons as the fallback.
                onMoveLeft={
                  i > 0
                    ? () => reorderSources(source.id, sources[i - 1]!.id)
                    : undefined
                }
                onMoveRight={
                  i < sources.length - 1
                    ? () => reorderSources(source.id, sources[i + 1]!.id)
                    : undefined
                }
                draggable
                onDragStart={(e) => {
                  dragSourceId.current = source.id;
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", source.id);
                }}
                onDragOver={(e) => {
                  if (
                    dragSourceId.current &&
                    dragSourceId.current !== source.id
                  ) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const fromId =
                    dragSourceId.current ?? e.dataTransfer.getData("text/plain");
                  dragSourceId.current = null;
                  if (fromId && fromId !== source.id) {
                    reorderSources(fromId, source.id);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      <AddStreamModal open={modalOpen} editing={editing} onClose={closeModal} />
      {fullscreenSource && (
        <FullscreenView
          source={fullscreenSource}
          onClose={() => setFullscreenId(null)}
        />
      )}
    </div>
  );
}

function LayoutToggle({
  layout,
  setLayout,
}: {
  layout: StreamLayout;
  setLayout: (l: StreamLayout) => void;
}) {
  const opts: { kind: StreamLayout; label: string }[] = [
    { kind: "1col", label: "1×" },
    { kind: "2col", label: "2×" },
    { kind: "3col", label: "3×" },
  ];
  return (
    <div className="flex items-center gap-0">
      {opts.map((o, i) => {
        const active = layout === o.kind;
        return (
          <button
            key={o.kind}
            type="button"
            onClick={() => setLayout(o.kind)}
            className={
              // `relative` + bumped z-index on the active button so its
              // orange right edge sits above the next sibling's dim left
              // edge (negative margins below stack later siblings on top).
              "relative px-2 py-1 pointer-coarse:px-3 pointer-coarse:py-2 text-[11px] border " +
              (active
                ? "z-10 bg-orange-300/15 text-orange-200 border-orange-300/60"
                : "bg-white/5 text-text-dim border-panel-border hover:bg-white/10 hover:text-text-bright") +
              (i === 0 ? " rounded-l" : "") +
              (i === opts.length - 1 ? " rounded-r" : "") +
              (i > 0 ? " -ml-px" : "")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
