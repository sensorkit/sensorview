/**
 * Geographic coordinate parsing/formatting for operator entry.
 *
 * Mirrors the input contract of common mount software (e.g. PlaneWave PWI4's
 * location field): a single text box accepts either decimal degrees
 * (`20.8195`) or sexagesimal `DD MM SS` (`20 49 10.2`), with negative meaning
 * South / West. We accept a few extra separators and an optional hemisphere
 * letter so pasted coordinates from other tools parse without hand-editing.
 */

export type Axis = "lat" | "lon";

/**
 * Parse a latitude/longitude string to decimal degrees.
 *
 * Accepts, case-insensitively:
 *   - Decimal:       `20.8195`, `-156.2795`, `20.8195 N`, `156.2795 W`
 *   - Deg/min:       `20 49`, `-156 16`
 *   - Deg/min/sec:   `20 49 10.2`, `-156 16 46.2`, `20:49:10.2`
 *   - Symbols:       `20°49'10.2"`, `156° 16' 46.2" W`
 *
 * Separators may be spaces, colons, or the °/'/" glyphs. A leading `-` or a
 * trailing/leading hemisphere letter (N/S/E/W) sets the sign; if both are
 * present the hemisphere letter wins. Minutes/seconds are always magnitudes;
 * the sign applies to the whole value.
 *
 * Returns the decimal degrees, or `null` if the string can't be parsed or is
 * numerically malformed. Range is NOT enforced here — callers validate against
 * the axis (see {@link isInRange}).
 */
export function parseCoordinate(raw: string): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s) return null;

  // Pull off a hemisphere letter (either end) before we touch the digits.
  let hemisphereSign: number | null = null;
  const hemiMatch = s.match(/([NSEW])\s*$/i) ?? s.match(/^\s*([NSEW])/i);
  if (hemiMatch) {
    const letter = hemiMatch[1]!.toUpperCase();
    hemisphereSign = letter === "S" || letter === "W" ? -1 : 1;
    s = s.replace(/[NSEW]/i, " ").trim();
  }

  // Normalize every supported separator to a single space.
  s = s.replace(/[°'":,]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;

  const tokens = s.split(" ");
  if (tokens.length > 3) return null;

  const nums = tokens.map((t) => Number(t));
  if (nums.some((n) => !Number.isFinite(n))) return null;

  const deg = nums[0];
  if (deg === undefined) return null;
  const min = nums[1] ?? 0;
  const sec = nums[2] ?? 0;
  // Minutes/seconds are magnitudes; reject nonsense like negative minutes.
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;

  const magnitude = Math.abs(deg) + min / 60 + sec / 3600;

  // Sign precedence: explicit hemisphere letter, else a leading '-' on degrees.
  // Test the original token string for '-' so "-0 30 0" (= -0.5) keeps its sign
  // even though Number("-0") is 0.
  const negFromSign = /^-/.test(tokens[0]!);
  const sign = hemisphereSign ?? (negFromSign ? -1 : 1);

  return sign * magnitude;
}

/** True if a decimal-degree value is within the valid range for its axis. */
export function isInRange(value: number, axis: Axis): boolean {
  if (!Number.isFinite(value)) return false;
  const limit = axis === "lat" ? 90 : 180;
  return value >= -limit && value <= limit;
}

/**
 * Format decimal degrees as sign-prefixed `DD MM SS.s` (space-separated, no
 * hemisphere letter) — the same shape PWI4 shows, so a value round-trips
 * through {@link parseCoordinate} unchanged.
 */
export function formatDMS(value: number, secondsDecimals = 1): string {
  if (!Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  let rem = Math.abs(value);

  let deg = Math.floor(rem);
  rem = (rem - deg) * 60;
  let min = Math.floor(rem);
  let sec = (rem - min) * 60;

  // Guard against FP roll-up (e.g. 59.99999" rounding to 60.0").
  const factor = 10 ** secondsDecimals;
  sec = Math.round(sec * factor) / factor;
  if (sec >= 60) {
    sec -= 60;
    min += 1;
  }
  if (min >= 60) {
    min -= 60;
    deg += 1;
  }

  return `${sign}${deg} ${String(min).padStart(2, "0")} ${sec
    .toFixed(secondsDecimals)
    .padStart(secondsDecimals ? 3 + secondsDecimals : 2, "0")}`;
}

/** Format decimal degrees with a fixed number of fractional digits. */
export function formatDecimal(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(digits);
}
