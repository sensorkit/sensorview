import { useEffect, useState } from "react";
import type { StreamSource } from "../../stores/streams";
import { StreamPlayer } from "./StreamTile";

type Status = "idle" | "live" | "error";

/**
 * Fullscreen overlay that renders a single stream filling most of the
 * viewport. Closing it swaps the page back to the grid view; the tile that
 * spawned it remains paused while this is active so we don't have two
 * player instances reading the same upstream simultaneously.
 *
 * Closes on Escape, on backdrop click, or via the explicit close button.
 */
export function FullscreenView({
  source,
  onClose,
}: {
  source: StreamSource;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/95 flex flex-col"
      onClick={onClose}
    >
      <div
        className="flex items-center gap-3 px-4 py-2 border-b border-panel-border bg-panel-bg/90"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0">
          <div className="text-sm text-text-bright font-medium truncate">{source.name}</div>
          <div className="text-[10px] text-text-dim uppercase tracking-wide">
            {source.kind === "device" ? "device" : source.protocol}
            {" · "}
            <span className={statusColor(status)}>{status}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-text-dim hover:text-text-bright text-xl leading-none px-2"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      <div
        className="flex-1 flex items-center justify-center relative"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-full h-full max-w-[95vw] max-h-[90vh] flex items-center justify-center">
          <StreamPlayer
            source={source}
            paused={false}
            lowLatencyOn={
              source.kind === "url" && !!source.lowLatency
            }
            onStatus={setStatus}
            onError={setError}
          />
        </div>
        {error && (
          <div className="absolute bottom-4 left-4 right-4 text-xs text-red-300 bg-black/70 px-3 py-2 rounded">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function statusColor(status: Status): string {
  if (status === "live") return "text-green-400";
  if (status === "error") return "text-red-400";
  return "text-text-dim";
}
