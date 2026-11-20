import { useEffect, useRef, useState } from "react";

interface CameraTelemetryLike {
  percent_completed: number | null;
}

interface TaskContextLike {
  /** Zero-based frame index from controller execution context, when published. */
  frame_num?: number | null;
}

/**
 * Use a published frame index when available. Otherwise count exposure
 * starts from camera telemetry. The estimate covers samples received
 * since the task or camera changed, so joining mid-task can undercount.
 * Callers supplying a camera ID skip missing samples and require a resolved
 * camera. Callers omitting it retain the task-based count and 0% default.
 */
export function useFrameIndex(
  taskId: string | null,
  cameraTel: CameraTelemetryLike | undefined,
  taskContext?: TaskContextLike | null,
  cameraId?: string | null,
): number | null {
  const cameraScoped = cameraId !== undefined;
  // Reset key: task plus resolved camera.
  const resetKey = taskId === null ? null : JSON.stringify([taskId, cameraId ?? null]);
  // The fallback count, tagged with the key it was counted under.
  const [counted, setCounted] = useState<{ key: string | null; index: number | null }>({
    key: null,
    index: null,
  });
  const prevTaskId = useRef<string | null>(null);
  const prevPct = useRef(-1);
  const sawChange = useRef(false);
  // Debounce so a single frame boundary only counts once, even when the camera
  // emits multiple transitions in quick succession (e.g. stale 100 → 0 → 15
  // at the moment the first real exposure of a task begins).
  const armed = useRef(true);

  useEffect(() => {
    if (resetKey !== prevTaskId.current) {
      prevTaskId.current = resetKey;
      prevPct.current = -1;
      sawChange.current = false;
      armed.current = true;
      setCounted({ key: resetKey, index: null });
    }

    const reading = cameraTel?.percent_completed;
    // Skip missing samples when a caller supplies a camera ID.
    if (cameraScoped && (reading === null || reading === undefined)) return;
    const pct = reading ?? 0;
    const prev = prevPct.current;

    // First reading of this task — seed and bail; don't count anything yet.
    if (prev === -1) {
      prevPct.current = pct;
      return;
    }

    if (pct !== prev) sawChange.current = true;

    if (sawChange.current && armed.current) {
      const risingFromLow = prev < 10 && pct >= 10;
      const fallingFromPeak = prev >= 90 && pct < 30;
      if (risingFromLow || fallingFromPeak) {
        setCounted((c) => ({ key: c.key, index: c.index === null ? 0 : c.index + 1 }));
        armed.current = false;
      }
    }

    // Re-arm once the exposure is clearly underway (pct well past the start
    // region) so the next frame's boundary can be counted.
    if (pct >= 50) armed.current = true;

    prevPct.current = pct;
  }, [resetKey, cameraScoped, cameraTel?.percent_completed]);

  if (cameraScoped && cameraId === null) return null;

  const ctxFrame = taskContext?.frame_num;
  if (typeof ctxFrame === "number" && Number.isFinite(ctxFrame)) {
    return ctxFrame;
  }
  // Hide the previous camera's count while the reset effect is pending.
  if (cameraScoped && counted.key !== resetKey) return null;
  return counted.index;
}
