/**
 * Sub-solar point and day/night terminator computation.
 *
 * Uses simple solar position approximation — no external dependencies.
 * Accuracy is ~1° which is plenty for visualization.
 */

export interface SubSolarPoint {
  lat: number; // degrees
  lon: number; // degrees
}

/**
 * Compute the approximate sub-solar point (lat/lon where the sun is directly overhead).
 */
export function subSolarPoint(date: Date): SubSolarPoint {
  // Day of year
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - start.getTime()) / 86400000;

  // Solar declination (axial tilt = 23.4393°)
  // Approximation: peaks at summer solstice (~day 172)
  const lat = 23.4393 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81));

  // Sub-solar longitude: based on UTC time
  // At 12:00 UTC, the sun is roughly over the prime meridian
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const lon = -15 * (hours - 12);

  return { lat, lon };
}
