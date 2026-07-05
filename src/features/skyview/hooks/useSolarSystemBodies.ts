import { useEffect, useState } from "react";
import * as Astronomy from "astronomy-engine";
import type { ObserverLocation } from "./useObserver";

export type BodyKind = "sun" | "moon" | "planet";

export interface SolarBody {
  id: string; // e.g. "Sun", "Moon", "Mars" — matches name
  name: string;
  kind: BodyKind;
  /** Apparent topocentric right ascension in degrees. */
  ra: number;
  dec: number;
  alt: number;
  az: number;
  magnitude: number | null;
  distanceAU: number;
  color: string;
}

/**
 * Bodies to render in SkyView. Ordered so brighter / more commonly-tracked
 * objects draw last and sit visually on top of dimmer ones.
 */
const BODIES: {
  body: Astronomy.Body;
  name: string;
  kind: BodyKind;
  color: string;
}[] = [
  { body: Astronomy.Body.Neptune, name: "Neptune", kind: "planet", color: "#4d7ed4" },
  { body: Astronomy.Body.Uranus, name: "Uranus", kind: "planet", color: "#7fd2e0" },
  { body: Astronomy.Body.Saturn, name: "Saturn", kind: "planet", color: "#e8cf84" },
  { body: Astronomy.Body.Jupiter, name: "Jupiter", kind: "planet", color: "#d9b57a" },
  { body: Astronomy.Body.Mars, name: "Mars", kind: "planet", color: "#ff7744" },
  { body: Astronomy.Body.Venus, name: "Venus", kind: "planet", color: "#ffe9b0" },
  { body: Astronomy.Body.Mercury, name: "Mercury", kind: "planet", color: "#bfbfbf" },
  { body: Astronomy.Body.Moon, name: "Moon", kind: "moon", color: "#cccccc" },
  { body: Astronomy.Body.Sun, name: "Sun", kind: "sun", color: "#ffcc44" },
];

/** Re-evaluate every 5 s — the slowest thing (Neptune) moves ~0.006"/s. */
const REFRESH_MS = 5000;

const EMPTY: SolarBody[] = [];

function computeBodies(observer: ObserverLocation, now: Date): SolarBody[] {
  const obs = new Astronomy.Observer(observer.lat, observer.lon, observer.alt);
  const out: SolarBody[] = [];
  for (const def of BODIES) {
    try {
      // ofdate=true + aberration=true → apparent topocentric coords
      const eq = Astronomy.Equator(def.body, now, obs, true, true);
      const hor = Astronomy.Horizon(now, obs, eq.ra, eq.dec, "normal");
      let mag: number | null = null;
      try {
        const illum = Astronomy.Illumination(def.body, now);
        mag = illum.mag;
      } catch {
        // Earth and a few others don't have Illumination — leave null.
      }
      out.push({
        id: def.name,
        name: def.name,
        kind: def.kind,
        ra: eq.ra * 15, // Astronomy returns RA in hours
        dec: eq.dec,
        alt: hor.altitude,
        az: hor.azimuth,
        magnitude: mag,
        distanceAU: eq.dist,
        color: def.color,
      });
    } catch {
      // skip body on unexpected failure
    }
  }
  return out;
}

export function useSolarSystemBodies(observer: ObserverLocation): SolarBody[] {
  // Computed in an effect so the first paint isn't blocked by ~180 ms of
  // astronomy-engine calls. Callers see an empty array until the first
  // computation completes (one tick after mount).
  const [bodies, setBodies] = useState<SolarBody[]>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setBodies(computeBodies(observer, new Date()));
    };
    // Defer initial computation past the first paint.
    const raf = requestAnimationFrame(tick);
    const interval = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearInterval(interval);
    };
  }, [observer.lat, observer.lon, observer.alt]);

  return bodies;
}
