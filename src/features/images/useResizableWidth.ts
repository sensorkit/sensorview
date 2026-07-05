import { useCallback, useState } from "react";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Opts {
  min?: number;
  max?: number;
  /** Which side the panel sits on. Left panel's grip is on its right edge
   *  (drag right = wider); right panel's grip is on its left edge (drag left = wider). */
  side: "left" | "right";
}

/**
 * Width state for a side panel plus a pointer handler for its resize grip.
 * Uses pointer capture so dragging keeps working over the JS9 canvas.
 */
export function useResizableWidth(initial: number, { min = 160, max = 640, side }: Opts) {
  const [width, setWidth] = useState(initial);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        // ignore — capture is best-effort (e.g. synthetic events)
      }
      const startX = e.clientX;
      const startW = width;

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        setWidth(clamp(startW + (side === "left" ? dx : -dx), min, max));
      };
      const onUp = (ev: PointerEvent) => {
        try {
          el.releasePointerCapture?.(ev.pointerId);
        } catch {
          // ignore
        }
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    },
    [width, min, max, side],
  );

  return { width, onPointerDown };
}
