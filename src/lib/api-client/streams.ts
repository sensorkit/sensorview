import { apiUrl } from "../../stores/backends";
import type { UrlStreamSource } from "../../stores/streams";

interface RegisterResponse {
  id: string;
  hls_url: string;
  whep_url: string;
}

export interface StreamStatus {
  state: "live" | "offline" | "error";
  error?: string;
}

/**
 * Register or update a URL-kind stream's MediaMTX path. Returns the local
 * HLS URL the renderer can play. Idempotent — safe to call on every tile
 * mount so MediaMTX state survives sidecar restarts.
 */
export async function registerUrlStream(
  source: UrlStreamSource,
): Promise<RegisterResponse> {
  const resp = await fetch(apiUrl("/api/streams/url"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: source.id,
      url: source.url,
      protocol: source.protocol,
      username: source.username,
      password: source.password,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`stream register failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

/** Best-effort unregister — swallow 404 since the path may already be gone. */
export async function unregisterUrlStream(streamId: string): Promise<void> {
  await fetch(apiUrl(`/api/streams/url/${encodeURIComponent(streamId)}`), {
    method: "DELETE",
  }).catch(() => {});
}

export async function getStreamStatus(streamId: string): Promise<StreamStatus> {
  const resp = await fetch(
    apiUrl(`/api/streams/url/${encodeURIComponent(streamId)}/status`),
  );
  if (!resp.ok) return { state: "error", error: `HTTP ${resp.status}` };
  return resp.json();
}

interface MjpegRegisterResponse {
  id: string;
  /** Sidecar-relative path; pair with apiUrl() to get the full URL. */
  proxy_url: string;
}

/**
 * Register an MJPEG source with the sidecar so the renderer can pull frames
 * via the local proxy (sidecar handles upstream auth — Digest or Basic).
 * Returns the absolute URL to use in the player's <img src>. Idempotent.
 */
export async function registerMjpegStream(
  source: UrlStreamSource,
): Promise<string> {
  const resp = await fetch(apiUrl("/api/streams/mjpeg"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: source.id,
      url: source.url,
      username: source.username,
      password: source.password,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`mjpeg register failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as MjpegRegisterResponse;
  return apiUrl(data.proxy_url);
}

/** Best-effort unregister — sidecar-side cleanup, swallow errors. */
export async function unregisterMjpegStream(streamId: string): Promise<void> {
  await fetch(apiUrl(`/api/streams/mjpeg/${encodeURIComponent(streamId)}`), {
    method: "DELETE",
  }).catch(() => {});
}
