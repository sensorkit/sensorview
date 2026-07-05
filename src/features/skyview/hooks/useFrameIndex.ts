import { useEffect, useRef, useState } from "react";

interface CameraTelemetryLike {
  percent_completed: number | null;
}

interface TaskContextLike {
  /** 0-indexed frame number, published by SK's collect loop into
   *  `TaskExecutionState.context`. Authoritative when present. */
  frame_num?: number | null;
}

/**
 * Return the current 0-indexed frame number within a collect task.
 *
 * Prefers SK's authoritative `frame_num` from `TaskExecutionState.context`
 * (since 2026-05-14). When that's absent (older SK, non-collect tasks,
 * race during startup), falls back to a brittle heuristic that derives
 * the index by counting exposure starts seen in
 * `CameraTelemetry.percent_completed`:
 *   • rising through a low threshold (cold camera → first exposure)
 *   • falling from near-peak (between-frames → next exposure)
 *
 * To avoid a stale pre-task `percent_completed=100` being mistaken for a
 * completed frame (the falling 100→15 on the real first exposure would
 * otherwise double-count), we ignore the very first reading after a task
 * change and only start counting once the value actually *changes*.
 *
 * Resets on task change. Caveat for the fallback path: joining mid-task
 * can't recover past frames, so you may see a lower count than reality
 * until the next edge.
 */
export function useFrameIndex(
  taskId: string | null,
  cameraTel: CameraTelemetryLike | undefined,
  taskContext?: TaskContextLike | null,
): number | null {
  const [index, setIndex] = useState<number | null>(null);
  const prevTaskId = useRef<string | null>(null);
  const prevPct = useRef(-1);
  const sawChange = useRef(false);
  // Debounce so a single frame boundary only counts once, even when the camera
  // emits multiple transitions in quick succession (e.g. stale 100 → 0 → 15
  // at the moment the first real exposure of a task begins).
  const armed = useRef(true);

  useEffect(() => {
    if (taskId !== prevTaskId.current) {
      prevTaskId.current = taskId;
      prevPct.current = -1;
      sawChange.current = false;
      armed.current = true;
      setIndex(null);
    }

    const pct = cameraTel?.percent_completed ?? 0;
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
        setIndex((i) => (i === null ? 0 : i + 1));
        armed.current = false;
      }
    }

    // Re-arm once the exposure is clearly underway (pct well past the start
    // region) so the next frame's boundary can be counted.
    if (pct >= 50) armed.current = true;

    prevPct.current = pct;
  }, [taskId, cameraTel?.percent_completed]);

  // Authoritative path: SK publishes `frame_num` into the task context once
  // per frame. When present, return it directly; telemetry-counting is only
  // the fallback for older SK builds (or for tasks that don't publish
  // context). Hook calls above always run so React's rules-of-hooks stays
  // happy across renders that toggle between the two paths.
  const ctxFrame = taskContext?.frame_num;
  if (typeof ctxFrame === "number" && Number.isFinite(ctxFrame)) {
    return ctxFrame;
  }
  return index;
}
