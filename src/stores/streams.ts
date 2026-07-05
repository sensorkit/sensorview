import { create } from "zustand";
import { persist } from "zustand/middleware";

export type StreamProtocol = "rtsp" | "hls" | "mjpeg" | "webrtc";

export interface UrlStreamSource {
  id: string;
  kind: "url";
  name: string;
  url: string;
  protocol: StreamProtocol;
  /**
   * If true, the tile plays via WebRTC/WHEP (sub-second latency) instead of
   * HLS. Per-stream, persisted, toggleable in the tile header. Only applies
   * when MediaMTX is the playback path (rtsp / hls protocols); ignored for
   * mjpeg and webrtc-direct sources.
   */
  lowLatency?: boolean;
  /**
   * Optional Basic-auth credentials for cameras that require them. Embedded
   * into the URL (`rtsp://user:pass@host/path`) when registering with
   * MediaMTX or when building a direct `<img>` src for MJPEG. Stored in
   * plaintext in localStorage — same security level as anything else
   * persisted client-side; users running on shared machines should use a
   * dedicated camera account.
   */
  username?: string;
  password?: string;
}

export interface DeviceStreamSource {
  id: string;
  kind: "device";
  name: string;
  /** Browser-assigned deviceId (may rotate; fall back to label match if empty). */
  deviceId: string;
  /** Cached label at add time, used as a fallback when deviceId rotates. */
  label?: string;
}

export type StreamSource = UrlStreamSource | DeviceStreamSource;

/** Layout density for the Streams tile grid. */
export type StreamLayout = "1col" | "2col" | "3col";

/**
 * Per-kind partial update payloads. A non-distributive
 * `Partial<Omit<StreamSource, …>>` collapses to only the union's *common*
 * fields, which loses kind-specific ones (lowLatency on url, etc.). The
 * explicit union below keeps both shapes available to callers.
 */
type StreamSourcePatch =
  | Partial<Omit<UrlStreamSource, "id" | "kind">>
  | Partial<Omit<DeviceStreamSource, "id" | "kind">>;

interface StreamsStore {
  sources: StreamSource[];
  layout: StreamLayout;

  addSource: (source: Omit<StreamSource, "id">) => string;
  updateSource: (id: string, patch: StreamSourcePatch) => void;
  removeSource: (id: string) => void;
  /** Move source `fromId` to the position currently occupied by `toId`. */
  reorderSources: (fromId: string, toId: string) => void;
  setLayout: (layout: StreamLayout) => void;
}

function makeId(): string {
  return `stream_${Math.random().toString(36).slice(2, 10)}`;
}

export const useStreamsStore = create<StreamsStore>()(
  persist(
    (set) => ({
      sources: [],
      layout: "2col",

      addSource: (source) => {
        const id = makeId();
        set((s) => ({ sources: [...s.sources, { ...source, id } as StreamSource] }));
        return id;
      },

      updateSource: (id, patch) =>
        set((s) => ({
          sources: s.sources.map((src) =>
            src.id === id ? ({ ...src, ...patch } as StreamSource) : src,
          ),
        })),

      removeSource: (id) =>
        set((s) => ({ sources: s.sources.filter((src) => src.id !== id) })),

      reorderSources: (fromId, toId) =>
        set((s) => {
          if (fromId === toId) return s;
          const from = s.sources.findIndex((src) => src.id === fromId);
          const to = s.sources.findIndex((src) => src.id === toId);
          if (from === -1 || to === -1) return s;
          const next = s.sources.slice();
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved!);
          return { sources: next };
        }),

      setLayout: (layout) => set({ layout }),
    }),
    {
      name: "sensorview.streams",
      version: 1,
    },
  ),
);
