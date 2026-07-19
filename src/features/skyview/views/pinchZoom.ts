/**
 * Two-pointer pinch tracking for the canvas views, designed to slot into
 * their existing raw-pointer-event effects (wheel zoom + single-pointer pan).
 *
 * Each canvas calls `down`/`move`/`up` from its own handlers:
 *  - `down` records the pointer; when a second lands, the pinch baseline is
 *    captured (the caller should cancel any in-flight pan).
 *  - `move` returns true while a pinch is active — the caller skips its pan
 *    logic — and drives `setZoom` with baselineZoom × (distance ratio).
 *  - `up` releases the pointer and ends the pinch when fewer than two remain.
 *    It returns true if that pointer ever participated in a pinch, so the
 *    caller can suppress its tap/click fallback for those pointers.
 *
 * The zoom get/set go through closures so the canvas can keep its local
 * `currentZoom` in sync with the store update.
 */
export function createPinchTracker(opts: {
  getZoom: () => number;
  setZoom: (z: number) => void;
  min: number;
  max: number;
}) {
  const pts = new Map<number, { x: number; y: number; pinched: boolean }>();
  let baselineDist = 0;
  let baselineZoom = 0;

  const dist = (): number => {
    const [a, b] = [...pts.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  return {
    get pinching(): boolean {
      return pts.size >= 2;
    },
    down(e: PointerEvent): void {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, pinched: false });
      if (pts.size >= 2) {
        for (const p of pts.values()) p.pinched = true;
        baselineDist = dist();
        baselineZoom = opts.getZoom();
      }
    },
    move(e: PointerEvent): boolean {
      const pt = pts.get(e.pointerId);
      if (!pt) return false;
      pt.x = e.clientX;
      pt.y = e.clientY;
      if (pts.size < 2) return false;
      if (baselineDist > 0) {
        const next = baselineZoom * (dist() / baselineDist);
        opts.setZoom(Math.max(opts.min, Math.min(opts.max, next)));
      }
      return true;
    },
    up(e: PointerEvent): boolean {
      const pt = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      if (pts.size >= 2) {
        // 3+ fingers dropping to 2: re-baseline on the survivors.
        baselineDist = dist();
        baselineZoom = opts.getZoom();
      } else {
        baselineDist = 0;
      }
      return pt?.pinched ?? false;
    },
  };
}
