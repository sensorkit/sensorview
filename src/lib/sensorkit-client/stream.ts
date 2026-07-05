import type { ConnectionStatus, SKRecord } from "./types";
import { skUrl } from "../../stores/backends";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

export interface StreamHandle {
  close: () => void;
}

export interface StreamCallbacks {
  onRecord: (record: SKRecord) => void;
  onStatus: (status: ConnectionStatus, error?: string) => void;
}

/**
 * Opens the /data/subscribe SSE firehose with exponential-backoff reconnect.
 * Each message carries a JSON-encoded SKRecord tuple as its data field.
 */
export function openSensorKitStream({ onRecord, onStatus }: StreamCallbacks): StreamHandle {
  let source: EventSource | null = null;
  let attempt = 0;
  let reconnectTimer: number | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    onStatus("connecting");
    source = new EventSource(skUrl("/data/subscribe"));

    source.onopen = () => {
      attempt = 0;
      onStatus("open");
    };

    source.onmessage = (ev) => {
      try {
        const record = JSON.parse(ev.data) as SKRecord;
        onRecord(record);
      } catch (err) {
        console.warn("sensorkit SSE parse error", err, ev.data);
      }
    };

    source.onerror = () => {
      if (closed) return;
      source?.close();
      source = null;
      onStatus("error", "stream disconnected");
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      source?.close();
      source = null;
    },
  };
}
