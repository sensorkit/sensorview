import { useEffect, useRef, useState } from "react";
import { useSensorKitStore } from "../../stores/sensorkit";
import { fetchProductMetadata } from "../../lib/sensorkit-client/products";
import type { ProductMetadata } from "../../lib/sensorkit-client/types";

/** Concurrent `/metadata` requests. SK answers these from an in-memory cache
 *  (webapi/serve.py `get_metadata`) — no disk read, no FITS re-parse — so the
 *  limit is about not starving the firehose connection, not about SK's cost. */
const CONCURRENCY = 8;

/** How often fetched headers are flushed into the store. One `set()` per
 *  header would notify every subscriber hundreds of times over an index run;
 *  the same batching rationale as the SSE client's record buffer. */
const FLUSH_MS = 200;

/** A product to index. `controllerId` is the id products are *registered*
 *  under — SK's `from_path` strategy makes that a directory segment (e.g.
 *  "raw"), which needn't match any entity name. */
export interface ProductRef {
  controllerId: string;
  productId: string;
}

export interface HeaderIndexProgress {
  /** Headers held for the requested products (including ones indexed earlier). */
  indexed: number;
  /** Products known across all groups. */
  total: number;
  /** True while a run is in flight. */
  running: boolean;
}

/**
 * Fetch the FITS header of every listed product, newest first, and merge the
 * results into the store.
 *
 * Newest-first matters: the file list is sorted newest-first too, so the
 * headers that arrive first are the rows the user is already looking at.
 * Search and filtering work on whatever is indexed so far — the caller shows
 * the progress counts so a partial index never reads as an empty result.
 *
 * A run is cancelled when the product set changes or the tab unmounts;
 * whatever it had already fetched is flushed rather than discarded.
 */
export function useHeaderIndex(refs: ProductRef[]): HeaderIndexProgress {
  const mergeProductHeaders = useSensorKitStore((s) => s.mergeProductHeaders);
  const [running, setRunning] = useState(false);
  const [indexedCount, setIndexedCount] = useState(0);

  // `refs` gets a fresh identity on every firehose flush; key the effect on the
  // content so a new frame doesn't restart the whole sweep.
  const refsKey =
    refs.length > 0 ? `${refs.length}:${refs[0]!.controllerId}/${refs[0]!.productId}` : "";

  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    const all = refsRef.current;
    if (all.length === 0) {
      setRunning(false);
      setIndexedCount(0);
      return;
    }

    let cancelled = false;
    // controllerId -> productId -> header, awaiting the next flush.
    const pending = new Map<string, Record<string, ProductMetadata>>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const held = () => {
      const store = useSensorKitStore.getState().productHeaders;
      let n = 0;
      for (const ref of refsRef.current) {
        if (store[ref.controllerId]?.[ref.productId]) n++;
      }
      return n;
    };

    const drain = () => {
      for (const [controllerId, batch] of pending) {
        if (Object.keys(batch).length > 0) mergeProductHeaders(controllerId, batch);
      }
      pending.clear();
    };

    const flush = () => {
      flushTimer = null;
      if (cancelled) return;
      drain();
      setIndexedCount(held());
    };

    const scheduleFlush = () => {
      if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
    };

    // Only fetch what we don't already hold — revisiting the tab, or a handful
    // of new arrivals, should cost a handful of requests, not a resweep.
    const have = useSensorKitStore.getState().productHeaders;
    const queue = all.filter((r) => !have[r.controllerId]?.[r.productId]);
    setIndexedCount(all.length - queue.length);

    if (queue.length === 0) {
      setRunning(false);
      return;
    }

    setRunning(true);
    let cursor = 0;

    const worker = async () => {
      while (!cancelled) {
        const i = cursor++;
        if (i >= queue.length) return;
        const { controllerId, productId } = queue[i]!;
        try {
          const meta = await fetchProductMetadata(controllerId, productId);
          if (cancelled) return;
          let batch = pending.get(controllerId);
          if (!batch) pending.set(controllerId, (batch = {}));
          batch[productId] = meta;
          scheduleFlush();
        } catch {
          // A product can vanish between listing and fetch, and a header is
          // optional anyway — skip it rather than aborting the sweep.
        }
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker);
    void Promise.all(workers).then(() => {
      if (cancelled) return;
      if (flushTimer !== null) clearTimeout(flushTimer);
      flush();
      setRunning(false);
    });

    return () => {
      cancelled = true;
      if (flushTimer !== null) clearTimeout(flushTimer);
      // Keep whatever this run already fetched. A live arrival restarts the
      // effect, and discarding the in-flight batch would make the next run
      // refetch it — thrashing while frames stream in.
      drain();
    };
  }, [refsKey, mergeProductHeaders]);

  return { indexed: indexedCount, total: refs.length, running };
}
