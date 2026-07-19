import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { StreamSource, UrlStreamSource } from "../../stores/streams";
import { useStreamsStore } from "../../stores/streams";
import {
  registerMjpegStream,
  registerUrlStream,
  unregisterMjpegStream,
} from "../../lib/api-client/streams";

type Status = "idle" | "live" | "error";

interface Props {
  source: StreamSource;
  onEdit: () => void;
  onRemove: () => void;
  onFullscreen: () => void;
  /** True when this tile is currently the fullscreen target — hides the
   *  body so we don't run two player instances against the same source. */
  fullscreenActive?: boolean;
  /** HTML5 drag-and-drop handlers wired by StreamsPage for tile reordering. */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Touch fallback for reordering — HTML5 dnd doesn't fire from touch, so
   *  coarse pointers get explicit move buttons instead. Undefined at the
   *  ends of the grid. */
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}

/** Protocols that go through MediaMTX and therefore support a WebRTC mode. */
function supportsLowLatency(source: UrlStreamSource): boolean {
  return source.protocol === "rtsp" || source.protocol === "hls";
}

/**
 * One tile in the Streams grid. Owns its own playback lifecycle: starts when
 * not paused, tears down on unmount or when the source changes.
 *
 * v1 supports `kind: "device"` via getUserMedia. URL streams render a
 * placeholder until step 3 wires them through MediaMTX.
 */
export function StreamTile({
  source,
  onEdit,
  onRemove,
  onFullscreen,
  fullscreenActive,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onMoveLeft,
  onMoveRight,
}: Props) {
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const updateSource = useStreamsStore((s) => s.updateSource);

  const showLowLatencyToggle =
    source.kind === "url" && supportsLowLatency(source);
  const lowLatencyOn =
    source.kind === "url" && !!source.lowLatency && supportsLowLatency(source);

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="bg-panel-bg/60 border border-panel-border rounded-lg overflow-hidden flex flex-col"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-panel-border">
        <div className="min-w-0">
          <div className="text-sm text-text-bright font-medium truncate">{source.name}</div>
          <div className="text-[10px] text-text-dim uppercase tracking-wide">
            {source.kind === "device" ? "device" : source.protocol}
          </div>
        </div>
        <StatusDot status={fullscreenActive ? "idle" : status} />
        {showLowLatencyToggle && (
          <button
            type="button"
            onClick={() => updateSource(source.id, { lowLatency: !lowLatencyOn })}
            title={
              lowLatencyOn
                ? "Low-latency (WebRTC) — click to switch to HLS"
                : "Standard latency (HLS) — click to switch to WebRTC"
            }
            className={
              "px-1.5 py-0.5 pointer-coarse:px-2 pointer-coarse:py-1 pointer-coarse:min-h-9 text-[9px] uppercase tracking-wide rounded border transition-colors " +
              (lowLatencyOn
                ? "bg-orange-300/15 text-orange-200 border-orange-300/60"
                : "bg-white/5 text-text-dim border-panel-border hover:bg-white/10 hover:text-text-bright")
            }
          >
            {lowLatencyOn ? "LL" : "HLS"}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1 pointer-coarse:gap-2">
          {(onMoveLeft || onMoveRight) && (
            <span className="hidden pointer-coarse:flex items-center gap-2">
              {onMoveLeft && (
                <IconButton label="Move left" onClick={onMoveLeft}>←</IconButton>
              )}
              {onMoveRight && (
                <IconButton label="Move right" onClick={onMoveRight}>→</IconButton>
              )}
            </span>
          )}
          <IconButton
            label={paused ? "Play" : "Pause"}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? "▶" : "⏸"}
          </IconButton>
          <IconButton label="Fullscreen" onClick={onFullscreen}>⛶</IconButton>
          <IconButton label="Edit" onClick={onEdit}>✎</IconButton>
          <IconButton label="Remove" onClick={onRemove} danger>✕</IconButton>
        </div>
      </div>

      <div className="relative bg-black aspect-video flex items-center justify-center">
        {fullscreenActive ? (
          <Placeholder>
            <div className="text-text-dim">Playing in fullscreen…</div>
          </Placeholder>
        ) : (
          <StreamPlayer
            source={source}
            paused={paused}
            lowLatencyOn={lowLatencyOn}
            onStatus={setStatus}
            onError={setError}
          />
        )}
        {error && !fullscreenActive && (
          <div className="absolute bottom-2 left-2 right-2 text-[10px] text-red-300 bg-black/70 px-2 py-1 rounded">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Centralised player switch — picks the right inner player based on source
 * kind / protocol / lowLatency. Used by both the tile and the fullscreen
 * view so we only have one place to evolve playback logic.
 */
export function StreamPlayer({
  source,
  paused,
  lowLatencyOn,
  onStatus,
  onError,
}: {
  source: StreamSource;
  paused: boolean;
  lowLatencyOn: boolean;
  onStatus: (s: Status) => void;
  onError: (e: string | null) => void;
}) {
  if (paused) {
    return <Placeholder>Paused</Placeholder>;
  }
  if (source.kind === "device") {
    return (
      <DevicePlayer source={source} onStatus={onStatus} onError={onError} />
    );
  }
  if (source.protocol === "mjpeg") {
    return (
      <MjpegPlayer source={source} onStatus={onStatus} onError={onError} />
    );
  }
  if (source.protocol === "webrtc") {
    return (
      <Placeholder>
        <div className="text-text-dim">WebRTC playback not yet supported.</div>
      </Placeholder>
    );
  }
  if (lowLatencyOn) {
    return (
      <WebrtcPlayer source={source} onStatus={onStatus} onError={onError} />
    );
  }
  return <UrlPlayer source={source} onStatus={onStatus} onError={onError} />;
}

function DevicePlayer({
  source,
  onStatus,
  onError,
}: {
  source: { deviceId: string; label?: string };
  onStatus: (s: Status) => void;
  onError: (e: string | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    const start = async () => {
      onStatus("idle");
      onError(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: source.deviceId
            ? { deviceId: { exact: source.deviceId } }
            : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          onStatus("live");
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        onError(msg);
        onStatus("error");
      }
    };

    start();
    return () => {
      cancelled = true;
      if (videoRef.current) videoRef.current.srcObject = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [source.deviceId, onStatus, onError]);

  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className="w-full h-full object-contain"
    />
  );
}

/**
 * Plays an HLS or RTSP source by registering the path with MediaMTX (via the
 * sidecar) and pointing hls.js at the resulting local HLS URL. RTSP is
 * always proxied; HLS we proxy too so that CORS and segmentation are uniform
 * regardless of what the upstream camera serves.
 *
 * Idempotent registration: every mount POSTs the path again, so MediaMTX
 * recovers if it (or the sidecar) restarts mid-session.
 */
function UrlPlayer({
  source,
  onStatus,
  onError,
}: {
  source: UrlStreamSource;
  onStatus: (s: Status) => void;
  onError: (e: string | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cancelled = false;
    let hls: Hls | null = null;

    const start = async () => {
      onStatus("idle");
      onError(null);
      try {
        const { hls_url } = await registerUrlStream(source);
        if (cancelled || !videoRef.current) return;

        const video = videoRef.current;
        if (Hls.isSupported()) {
          hls = new Hls({
            // LL-HLS off — MediaMTX's mpegts HLS variant (which we pin in
            // resources/mediamtx.yml) doesn't emit LL-HLS parts. Asking hls.js
            // for low-latency parts when the server isn't producing them just
            // confuses the playlist parser.
            lowLatencyMode: false,
            // Stay near the live edge. With 1 s segments, count 2 keeps us
            // ~2 s behind under healthy conditions; if we drift past 5 segments
            // (≈5 s) hls.js seeks forward to resync rather than letting the
            // gap grow unbounded.
            liveSyncDurationCount: 2,
            liveMaxLatencyDurationCount: 5,
            maxBufferLength: 10,
          });
          hls.loadSource(hls_url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => {});
            onStatus("live");
          });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            // Always log — non-fatal errors auto-recover but we want the
            // diagnostic trail when playback degrades.
            const detail = `${data.type}/${data.details}`;
            console.warn(`[hls.js ${source.id}]`, data.fatal ? "fatal" : "warn", detail, data);
            if (data.fatal) {
              onError(`hls.js: ${data.details}`);
              onStatus("error");
            }
          });
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Native HLS (Safari only — Electron's Chromium won't take this path).
          video.src = hls_url;
          video.play().catch(() => {});
          onStatus("live");
        } else {
          onError("HLS playback not supported in this browser.");
          onStatus("error");
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        onError(msg);
        onStatus("error");
      }
    };

    start();
    return () => {
      cancelled = true;
      hls?.destroy();
      if (videoRef.current) {
        videoRef.current.removeAttribute("src");
        videoRef.current.load();
      }
    };
  }, [source, onStatus, onError]);

  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className="w-full h-full object-contain"
    />
  );
}

/**
 * Plays via WebRTC/WHEP for sub-second latency. Same upstream RTSP path as
 * UrlPlayer (and MediaMTX is happy to publish the same path over both HLS
 * and WebRTC simultaneously), but signaling is a single SDP exchange and
 * media flows over a peer connection rather than HTTP segments. Typical
 * glass-to-glass latency on a LAN: ~200–500 ms, vs ~3–4 s for HLS.
 */
function WebrtcPlayer({
  source,
  onStatus,
  onError,
}: {
  source: UrlStreamSource;
  onStatus: (s: Status) => void;
  onError: (e: string | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let resourceUrl: string | null = null;

    const start = async () => {
      onStatus("idle");
      onError(null);
      try {
        const { whep_url } = await registerUrlStream(source);
        if (cancelled) return;

        pc = new RTCPeerConnection();
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        pc.ontrack = (event) => {
          if (!videoRef.current) return;
          if (videoRef.current.srcObject !== event.streams[0]) {
            videoRef.current.srcObject = event.streams[0]!;
          }
        };
        pc.onconnectionstatechange = () => {
          if (!pc || cancelled) return;
          if (pc.connectionState === "connected") onStatus("live");
          if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            onError(`WebRTC ${pc.connectionState}`);
            onStatus("error");
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering. MediaMTX's WHEP doesn't fully implement
        // trickle ICE; sending the offer before candidates are gathered
        // sometimes leaves the peer with no usable transport.
        if (pc.iceGatheringState !== "complete") {
          await new Promise<void>((resolve) => {
            const onChange = () => {
              if (pc?.iceGatheringState === "complete") {
                pc.removeEventListener("icegatheringstatechange", onChange);
                resolve();
              }
            };
            pc?.addEventListener("icegatheringstatechange", onChange);
          });
        }
        if (cancelled) return;

        const resp = await fetch(whep_url, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: pc.localDescription!.sdp,
        });
        if (!resp.ok) {
          throw new Error(`WHEP ${resp.status}: ${await resp.text()}`);
        }

        resourceUrl = resp.headers.get("location");
        const answerSdp = await resp.text();
        if (cancelled) return;

        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        onError(msg);
        onStatus("error");
      }
    };

    start();
    return () => {
      cancelled = true;
      if (resourceUrl) {
        // Best-effort tell the server we're done. MediaMTX cleans up its
        // peer after a timeout regardless, but this is faster.
        fetch(resourceUrl, { method: "DELETE" }).catch(() => {});
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      pc?.close();
    };
  }, [source, onStatus, onError]);

  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className="w-full h-full object-contain"
    />
  );
}

/**
 * MJPEG renders via the sidecar's proxy. The sidecar handles upstream auth
 * (Digest or Basic) — many IP cameras (notably AXIS) require Digest, which
 * the browser's <img src> with embedded user:pass@ can't speak. Proxying
 * also sidesteps Chromium's subresource-credentials block.
 *
 * Sources without auth still go through the proxy — single code path, and
 * the localhost hop is a few hundred microseconds. The proxy passes the
 * upstream's content-type (including the multipart boundary) through
 * verbatim so the browser sees the same stream the camera serves.
 */
function MjpegPlayer({
  source,
  onStatus,
  onError,
}: {
  source: UrlStreamSource;
  onStatus: (s: Status) => void;
  onError: (e: string | null) => void;
}) {
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Force the multipart/x-mixed-replace connection to abort on unmount.
  // Removing the <img> from the DOM does not reliably tear down an in-flight
  // MJPEG stream in Chromium, so the browser→proxy socket lingers, the proxy's
  // body() generator never hits its finally, and the upstream camera slot stays
  // held. After a few tab switches the camera runs out of slots and every tile
  // is stuck "Connecting…" until the app restarts. Clearing src aborts the load
  // immediately, which lets the sidecar see the disconnect and free the camera.
  useEffect(() => {
    const img = imgRef.current;
    return () => {
      if (img) img.src = "";
    };
  }, [proxyUrl]);

  useEffect(() => {
    let cancelled = false;
    onError(null);
    onStatus("idle");
    setProxyUrl(null);

    registerMjpegStream(source)
      .then((url) => {
        if (cancelled) return;
        // Cache-bust per registration so a credential change forces the
        // browser to drop any cached connection to the old proxy URL.
        setProxyUrl(`${url}?t=${Date.now()}`);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        onError(`Failed to register MJPEG proxy: ${err.message}`);
        onStatus("error");
      });

    return () => {
      cancelled = true;
      void unregisterMjpegStream(source.id);
    };
  }, [
    source.id,
    source.url,
    source.username,
    source.password,
    onStatus,
    onError,
  ]);

  if (!proxyUrl) {
    return <Placeholder>Connecting…</Placeholder>;
  }

  return (
    <img
      ref={imgRef}
      src={proxyUrl}
      alt={source.name}
      className="w-full h-full object-contain"
      onLoad={() => {
        onError(null);
        onStatus("live");
      }}
      onError={() => {
        onError("Failed to load MJPEG stream.");
        onStatus("error");
      }}
    />
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs text-text-dim p-4 text-center">{children}</div>
  );
}

function StatusDot({ status }: { status: Status }) {
  const color =
    status === "live"
      ? "bg-green-400"
      : status === "error"
        ? "bg-red-400"
        : "bg-white/20";
  const label =
    status === "live" ? "live" : status === "error" ? "error" : "idle";
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-text-dim">
      <span className={`inline-block rounded-full ${color}`} style={{ width: 6, height: 6 }} />
      {label}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={
        "w-6 h-6 pointer-coarse:w-10 pointer-coarse:h-10 inline-flex items-center justify-center rounded text-xs " +
        (danger
          ? "text-red-300 hover:bg-red-500/15"
          : "text-text-dim hover:bg-white/10 hover:text-text-bright")
      }
    >
      {children}
    </button>
  );
}
