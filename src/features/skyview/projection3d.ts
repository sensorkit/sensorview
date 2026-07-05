/**
 * True 3D orthographic projection from directly above an observer.
 *
 * Converts lat/lon/altitude to ECEF, rotates so the observer is at the
 * "north pole", then projects orthographically downward.
 * Returns null if the point is behind the earth.
 */

const DEG2RAD = Math.PI / 180;
const EARTH_R = 6371; // km

export interface Observer3D {
  sinLat: number;
  cosLat: number;
  sinLon: number;
  cosLon: number;
}

export function makeObserver3D(latDeg: number, lonDeg: number): Observer3D {
  const latR = latDeg * DEG2RAD;
  const lonR = lonDeg * DEG2RAD;
  return {
    sinLat: Math.sin(latR),
    cosLat: Math.cos(latR),
    sinLon: Math.sin(lonR),
    cosLon: Math.cos(lonR),
  };
}

export function project3D(
  satLatDeg: number,
  satLonDeg: number,
  altKm: number,
  obs: Observer3D,
  scale: number,
  cx: number,
  cy: number,
): [number, number] | null {
  const r = EARTH_R + altKm;
  const satLat = satLatDeg * DEG2RAD;
  const satLon = satLonDeg * DEG2RAD;

  const cosSlat = Math.cos(satLat);
  const sx = r * cosSlat * Math.cos(satLon);
  const sy = r * cosSlat * Math.sin(satLon);
  const sz = r * Math.sin(satLat);

  // Rotate around z-axis by -obsLon
  const x1 = sx * obs.cosLon + sy * obs.sinLon;
  const y1 = -sx * obs.sinLon + sy * obs.cosLon;
  const z1 = sz;

  // Rotate around y-axis by (obsLat - π/2)
  const x2 = x1 * obs.sinLat - z1 * obs.cosLat;
  const y2 = y1;
  const z2 = x1 * obs.cosLat + z1 * obs.sinLat;

  // Behind earth: z < 0 and within earth disk
  if (z2 < 0 && (x2 * x2 + y2 * y2) < EARTH_R * EARTH_R) {
    return null;
  }

  // x2 = south, y2 = east in the rotated frame.
  // Screen needs North-up (x2 neg → up) and East-right (y2 pos → right)
  // to match the d3-geo azimuthal equidistant map layer.
  return [cx + y2 * scale, cy + x2 * scale];
}

/** Scale factor to map EARTH_R to screen earth-disk radius */
export function overheadScale(earthScreenR: number): number {
  return earthScreenR / EARTH_R;
}
