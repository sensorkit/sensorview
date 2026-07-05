/**
 * Shared fetch helper for the supplemental API clients.
 *
 * The PyInstaller onefile sidecar takes a few seconds to unpack + bind on cold
 * start, so we retry fetches that fail at the network layer (ECONNREFUSED) and
 * let the first requests after launch succeed instead of surfacing as errors.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const maxAttempts = 12;
  let delayMs = 400;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 1.5, 3000);
    }
  }
  throw new Error("unreachable");
}
