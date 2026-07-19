/**
 * RFC 4122 v4 UUID that works outside secure contexts.
 *
 * `crypto.randomUUID()` is defined only in secure contexts (https, or the
 * localhost/127.0.0.1 special cases). When SensorView is served over plain
 * http from a LAN IP (e.g. a phone hitting the Mac's dev server at
 * http://192.168.x.x:5180), `crypto.randomUUID` is `undefined` and calling it
 * throws — and because the collect-presets store seeds ids at import time,
 * that throw blanks the whole app before React mounts. `getRandomValues` is
 * NOT secure-context-gated, so we build the UUID from it instead, falling back
 * to `Math.random()` only if `crypto` is absent entirely.
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);

  // Version (4) and variant (10xx) bits per RFC 4122.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
