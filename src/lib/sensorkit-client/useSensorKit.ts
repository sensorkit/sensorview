import { useEffect } from "react";
import { useSensorKitStore } from "../../stores/sensorkit";
import { useBackends } from "../../stores/backends";
import { fetchEntities, fetchSnapshot } from "./http";
import { openSensorKitStream } from "./stream";
import type { SKRecord } from "./types";

/**
 * Coalescing window for firehose records. During an active collect all three
 * mounts stream pointing/telemetry at up to tens of records per second;
 * committing each record to the store individually notified every subscriber
 * per record and pegged the renderer (reconciliation storm → frozen UTC
 * clock). Buffering to one store commit per window caps subscriber
 * notifications at ~10/s while keeping reticle motion at the 10Hz the UI
 * targets.
 */
const FLUSH_MS = 100;

/**
 * Bootstraps and maintains the SensorKit connection:
 *   1. Opens the SSE firehose for live updates
 *   2. On every SSE open (first connect or reconnect) refetches /entities +
 *      /data/snapshot so the client reflects the current backend state.
 *   3. On stream error clears cached state and entities so stale device
 *      pills and reticles don't linger when SensorKit goes away.
 *
 * Mount once at app root. Re-runs whenever the SensorKit base URL changes
 * in Settings so the user can switch hosts without restarting the app.
 */
export function useSensorKit() {
  const setConnection = useSensorKitStore((s) => s.setConnection);
  const setEntities = useSensorKitStore((s) => s.setEntities);
  const applyRecords = useSensorKitStore((s) => s.applyRecords);
  const resetState = useSensorKitStore((s) => s.resetState);
  const sensorKitBase = useBackends((s) => s.sensorKit);

  useEffect(() => {
    let cancelled = false;

    const buffer: SKRecord[] = [];
    let flushTimer: number | null = null;

    const flush = () => {
      flushTimer = null;
      if (cancelled || buffer.length === 0) return;
      applyRecords(buffer.splice(0, buffer.length));
    };

    const refetchBootstrap = async () => {
      try {
        const [entities, snapshot] = await Promise.all([
          fetchEntities(),
          fetchSnapshot(),
        ]);
        if (cancelled) return;
        setEntities(entities);
        // One commit for the whole snapshot (it can be hundreds of records —
        // applying them one-by-one used to trigger hundreds of re-render
        // passes on every reconnect). Any live records buffered while the
        // fetch was in flight flush within FLUSH_MS after and win, so the
        // newest data still lands last.
        applyRecords(snapshot);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setConnection("error", msg);
      }
    };

    const handle = openSensorKitStream({
      onRecord: (record) => {
        if (cancelled) return;
        buffer.push(record);
        if (flushTimer === null) {
          flushTimer = window.setTimeout(flush, FLUSH_MS);
        }
      },
      onStatus: (status, error) => {
        if (cancelled) return;
        setConnection(status, error);
        if (status === "open") {
          // Fresh fetch on every connect and reconnect so entities +
          // snapshot match what the running SensorKit has right now.
          void refetchBootstrap();
        } else if (status === "error") {
          // Stream dropped — don't keep showing fake-live pills,
          // reticles, and telemetry against data from minutes ago.
          // Drop anything buffered too: it predates the reset.
          buffer.length = 0;
          resetState();
        }
      },
    });

    return () => {
      cancelled = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      handle.close();
      resetState();
      setConnection("idle");
    };
  }, [sensorKitBase, setConnection, setEntities, applyRecords, resetState]);
}
