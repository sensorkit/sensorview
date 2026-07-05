import { useEffect, useRef } from "react";
import { useSatelliteStore, type SatellitePosition } from "../../../stores/satellites";
import type { ObserverLocation } from "./useObserver";

/**
 * Manages the Web Worker that propagates satellite positions from TLEs.
 * Fast position ticks at 10Hz, rise/set computation every 10 seconds.
 */
export function useSatellitePropagation(observer: ObserverLocation, computeGeodetic = false) {
  const workerRef = useRef<Worker | null>(null);
  const tickRef = useRef(0);
  const sentIdsRef = useRef<Set<string>>(new Set());
  const { tles, setPositions } = useSatelliteStore();

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/propagator.worker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (event: MessageEvent<SatellitePosition[]>) => {
      setPositions(event.data);
    };

    worker.onerror = (err) => {
      console.error("[propagator worker] error:", err.message);
    };

    workerRef.current = worker;
    return () => { worker.terminate(); };
  }, [setPositions]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || tles.length === 0) return;

    const currentIds = new Set(tles.map((t) => t.noradId));
    const sent = sentIdsRef.current;
    const removed = [...sent].some((id) => !currentIds.has(id));
    const added = tles.filter((t) => !sent.has(t.noradId));

    if (removed || sent.size === 0) {
      worker.postMessage({
        type: "setTLEs",
        tles: tles.map((t) => ({
          noradId: t.noradId, name: t.name, line1: t.line1, line2: t.line2,
        })),
      });
    } else {
      for (const t of added) {
        worker.postMessage({
          type: "addTLE",
          tle: { noradId: t.noradId, name: t.name, line1: t.line1, line2: t.line2 },
        });
      }
    }
    sentIdsRef.current = currentIds;
  }, [tles]);

  useEffect(() => {
    if (tles.length === 0) return;

    const tick = () => {
      const worker = workerRef.current;
      if (!worker) return;

      tickRef.current++;
      // Compute rise/set batch on every tick — worker staggers 1/10th per tick
      const computeRiseSet = true;

      worker.postMessage({
        type: "propagate",
        observer: { lat: observer.lat, lon: observer.lon, alt: observer.alt },
        time: Date.now(),
        computeRiseSet,
        computeGeodetic,
      });
    };

    tick(); // immediate first tick with rise/set
    // 10Hz — keeps the satellite marker in sync with the live mount reticle
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [tles.length, observer.lat, observer.lon, observer.alt, computeGeodetic]);
}
