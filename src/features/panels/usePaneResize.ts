import { useCallback } from "react";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Opts {
  min: number;
  max: number;
  /** Invert the drag direction (e.g. a left-edge grip where dragging left = wider). */
  invert?: boolean;
}

/**
 * Controlled resize grip — a pointer handler that drives an external value via
 * `onChange`. Same pointer-capture approach as `useResizableWidth` (so drags
 * keep working over canvases/iframes), but controlled so the size can live in a
 * persisted store. Works on either axis.
 */
export function usePaneResize(
  axis: "x" | "y",
  value: number,
  onChange: (v: number) => void,
  { min, max, invert = false }: Opts,
) {
  return useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        // best-effort
      }
      const start = axis === "x" ? e.clientX : e.clientY;
      const startV = value;

      const onMove = (ev: PointerEvent) => {
        const cur = axis === "x" ? ev.clientX : ev.clientY;
        const d = (cur - start) * (invert ? -1 : 1);
        onChange(clamp(startV + d, min, max));
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
    [axis, value, onChange, min, max, invert],
  );
}
