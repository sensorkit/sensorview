import type { TLERecord } from "../../stores/satellites";
import { apiUrl } from "../../stores/backends";
import { fetchWithRetry } from "./http";

/**
 * Client for the supplemental API's TLE endpoints.
 */
export async function fetchTLECatalog(
  search?: string,
): Promise<TLERecord[]> {
  const params = new URLSearchParams();
  if (search) params.set("search", search);

  if (!params.has("limit")) params.set("limit", "2000");
  const url = apiUrl(`/api/tle/catalog?${params}`);
  const response = await fetchWithRetry(url);

  if (!response.ok) {
    throw new Error(`TLE catalog fetch failed: ${response.status}`);
  }

  return response.json();
}

export async function fetchTLEBySatellite(
  noradId: string,
): Promise<TLERecord | null> {
  const response = await fetchWithRetry(apiUrl(`/api/tle/satellite/${noradId}`));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`TLE fetch failed: ${response.status}`);
  return response.json();
}

export async function refreshTLECache(): Promise<{ count: number }> {
  const response = await fetchWithRetry(apiUrl("/api/tle/refresh"), { method: "POST" });
  if (!response.ok) throw new Error(`TLE refresh failed: ${response.status}`);
  return response.json();
}

export async function getTLEStatus(): Promise<{
  count: number;
  lastRefresh: string | null;
  cacheAgeHours: number | null;
}> {
  const response = await fetchWithRetry(apiUrl("/api/tle/status"));
  if (!response.ok) throw new Error(`TLE status failed: ${response.status}`);
  return response.json();
}
