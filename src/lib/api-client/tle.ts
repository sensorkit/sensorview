import type { TLERecord } from "../../stores/satellites";
import { apiUrl } from "../../stores/backends";
import { fetchWithRetry } from "./http";

/**
 * Client for the supplemental API's TLE endpoints.
 *
 * The catalog is merged from one or more sources (Spacebook, Space-Track,
 * a local file upload, a custom URL) by user-configured priority; the
 * /sources endpoints manage that configuration.
 */

export type TLESourceId = "spacebook" | "spacetrack" | "local" | "url";

export interface TLESourceStatus {
  id: TLESourceId;
  enabled: boolean;
  /** Rows this source contributes before priority dedup. */
  count: number;
  lastRefresh: string | null;
  cacheAgeHours: number | null;
  /** Space-Track: stored account name (null = not signed in). */
  username?: string | null;
  /** Local file: name of the last uploaded file. */
  filename?: string | null;
  /** Custom URL: the configured endpoint. */
  url?: string | null;
  /** Local file / custom URL: detected element-set format. */
  format?: "2le" | "3le" | null;
}

export interface TLERefreshResult {
  /** Merged catalog size after the refresh. */
  count: number;
  /** Per-source outcome, keyed by source id. */
  results: Record<string, { count?: number; error?: string }>;
}

async function requestJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithRetry(apiUrl(path), init);
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* no JSON body; keep the status code */
    }
    throw new Error(detail);
  }
  return response.json();
}

const jsonBody = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

export async function fetchTLECatalog(search?: string): Promise<TLERecord[]> {
  const params = new URLSearchParams();
  if (search) params.set("search", search);

  if (!params.has("limit")) params.set("limit", "2000");
  return requestJSON(`/api/tle/catalog?${params}`);
}

export async function fetchTLEBySatellite(
  noradId: string,
): Promise<TLERecord | null> {
  const response = await fetchWithRetry(apiUrl(`/api/tle/satellite/${noradId}`));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`TLE fetch failed: ${response.status}`);
  return response.json();
}

/** Refresh remote sources — one if given, else every enabled, configured one. */
export async function refreshTLESources(
  source?: TLESourceId,
): Promise<TLERefreshResult> {
  const suffix = source ? `?source=${source}` : "";
  return requestJSON(`/api/tle/refresh${suffix}`, { method: "POST" });
}

/** Back-compat alias for callers that only care that a refresh happened. */
export async function refreshTLECache(): Promise<{ count: number }> {
  return refreshTLESources();
}

export async function getTLEStatus(): Promise<{
  count: number;
  lastRefresh: string | null;
  cacheAgeHours: number | null;
}> {
  return requestJSON("/api/tle/status");
}

// === Source management ========================================================

export async function getTLESources(): Promise<TLESourceStatus[]> {
  const data = await requestJSON<{ sources: TLESourceStatus[] }>("/api/tle/sources");
  return data.sources;
}

export async function updateTLESourceConfig(patch: {
  order?: TLESourceId[];
  enabled?: Partial<Record<TLESourceId, boolean>>;
}): Promise<TLESourceStatus[]> {
  const data = await requestJSON<{ sources: TLESourceStatus[] }>(
    "/api/tle/sources/config",
    { ...jsonBody(patch), method: "PUT" },
  );
  return data.sources;
}

export async function spaceTrackLogin(
  username: string,
  password: string,
): Promise<TLESourceStatus[]> {
  const data = await requestJSON<{ sources: TLESourceStatus[] }>(
    "/api/tle/sources/spacetrack/login",
    jsonBody({ username, password }),
  );
  return data.sources;
}

export async function spaceTrackLogout(): Promise<TLESourceStatus[]> {
  const data = await requestJSON<{ sources: TLESourceStatus[] }>(
    "/api/tle/sources/spacetrack/login",
    { method: "DELETE" },
  );
  return data.sources;
}

export async function uploadLocalTLEFile(
  filename: string,
  content: string,
): Promise<{ count: number; format: "2le" | "3le"; sources: TLESourceStatus[] }> {
  return requestJSON("/api/tle/sources/local", jsonBody({ filename, content }));
}

export async function fetchCustomTLEUrl(
  url: string,
): Promise<{ count: number; sources: TLESourceStatus[] }> {
  return requestJSON("/api/tle/sources/url/fetch", jsonBody({ url }));
}
