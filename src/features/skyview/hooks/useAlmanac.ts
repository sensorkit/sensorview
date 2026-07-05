import { useEffect, useState } from "react";
import * as Astronomy from "astronomy-engine";
import type { ObserverLocation } from "./useObserver";

export type MoonPhaseLabel =
  | "new"
  | "waxing crescent"
  | "first quarter"
  | "waxing gibbous"
  | "full"
  | "waning gibbous"
  | "last quarter"
  | "waning crescent";

export interface AlmanacDay {
  /** Local-midnight boundary at the start of "today". Header reference only. */
  dayStart: Date;
  /** dayStart + 24h. */
  dayEnd: Date;
  /** Wider search/render window: dayStart − 12h (= local noon yesterday). */
  windowStart: Date;
  /** dayEnd + 12h (= local noon tomorrow). */
  windowEnd: Date;

  // === Header values: next event from now (may be tomorrow). ===
  sunrise: Date | null;
  sunset: Date | null;
  moonrise: Date | null;
  /** Set that pairs with `moonrise` (i.e. ends the upcoming up-period). */
  moonset: Date | null;

  // === Visualization bands within window. Each band is an interval where
  // the body is above the relevant altitude. ===
  /** Sun above 0° (geometric horizon, modulo refraction). */
  sunBands: [Date, Date][];
  /** Sun above −6° (civil twilight upper bound). */
  civilBands: [Date, Date][];
  /** Sun above −12° (nautical twilight upper bound). */
  nautBands: [Date, Date][];
  /** Moon above 0°. */
  moonUpSegments: [Date, Date][];

  // === Edge markers — every rise/set within the window. ===
  sunriseEvents: Date[];
  sunsetEvents: Date[];
  moonriseEvents: Date[];
  moonsetEvents: Date[];

  /** 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  moonPhase: number;
  /** 0–1 illumination fraction. */
  moonIllum: number;
  moonPhaseLabel: MoonPhaseLabel;
}

const WINDOW_BUFFER_HOURS = 12;
/** Cap on iterative event searches per body — 48h holds at most 2 of each. */
const SEARCH_LIMIT = 6;

function phaseLabel(phase: number): MoonPhaseLabel {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.03 || p >= 0.97) return "new";
  if (p < 0.22) return "waxing crescent";
  if (p < 0.28) return "first quarter";
  if (p < 0.47) return "waxing gibbous";
  if (p < 0.53) return "full";
  if (p < 0.72) return "waning gibbous";
  if (p < 0.78) return "last quarter";
  return "waning crescent";
}

function toJSDate(t: Astronomy.AstroTime | null): Date | null {
  return t ? t.date : null;
}

/**
 * Iteratively call `searchOnce` to enumerate every event within
 * [windowStart, windowEnd]. Each call returns the next event after `cursor`
 * within the remaining lookahead, or null if none.
 */
function findAll(
  searchOnce: (cursor: Date, lookaheadDays: number) => Date | null,
  windowStart: Date,
  windowEnd: Date,
): Date[] {
  const out: Date[] = [];
  let cursor = windowStart;
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const remainingDays =
      (windowEnd.getTime() - cursor.getTime()) / 86_400_000;
    if (remainingDays <= 0) break;
    const next = searchOnce(cursor, remainingDays);
    if (!next || next.getTime() > windowEnd.getTime()) break;
    out.push(next);
    // Step past the event so the next call doesn't re-find it.
    cursor = new Date(next.getTime() + 60_000);
  }
  return out;
}

/**
 * Pair rises and sets into "above-altitude" segments across [windowStart,
 * windowEnd]. The starting state is inferred from the first event when
 * possible (a leading "set" implies "started above"); falls back to the
 * altitude check for windows with zero events (e.g. polar conditions).
 */
function buildSegments(
  rises: Date[],
  sets: Date[],
  isUpAtStart: boolean,
  windowStart: Date,
  windowEnd: Date,
): [Date, Date][] {
  const events: { time: Date; type: "rise" | "set" }[] = [
    ...rises.map((d) => ({ time: d, type: "rise" as const })),
    ...sets.map((d) => ({ time: d, type: "set" as const })),
  ].sort((a, b) => a.time.getTime() - b.time.getTime());

  const first = events[0];
  const startsUp = first ? first.type === "set" : isUpAtStart;

  const segments: [Date, Date][] = [];
  let segStart: Date | null = startsUp ? windowStart : null;
  for (const ev of events) {
    if (ev.type === "rise") {
      if (segStart === null) segStart = ev.time;
    } else if (segStart !== null) {
      segments.push([segStart, ev.time]);
      segStart = null;
    }
  }
  if (segStart) segments.push([segStart, windowEnd]);
  return segments;
}

function bodyAltitudeAt(
  body: Astronomy.Body,
  obs: Astronomy.Observer,
  t: Date,
): number {
  const equ = Astronomy.Equator(body, t, obs, true, true);
  const hor = Astronomy.Horizon(t, obs, equ.ra, equ.dec, "normal");
  return hor.altitude;
}

function computeAlmanac(observer: ObserverLocation): AlmanacDay {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  const windowStart = new Date(
    dayStart.getTime() - WINDOW_BUFFER_HOURS * 3600 * 1000,
  );
  const windowEnd = new Date(
    dayEnd.getTime() + WINDOW_BUFFER_HOURS * 3600 * 1000,
  );

  const obs = new Astronomy.Observer(observer.lat, observer.lon, observer.alt);
  const now = new Date();

  // === Sun: rise/set + −6°/−12° threshold crossings ===
  const sunRises = findAll(
    (cursor, days) =>
      toJSDate(
        Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, +1, cursor, days),
      ),
    windowStart,
    windowEnd,
  );
  const sunSets = findAll(
    (cursor, days) =>
      toJSDate(
        Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, -1, cursor, days),
      ),
    windowStart,
    windowEnd,
  );
  const civilUps = findAll(
    (cursor, days) =>
      toJSDate(
        Astronomy.SearchAltitude(
          Astronomy.Body.Sun,
          obs,
          +1,
          cursor,
          days,
          -6,
        ),
      ),
    windowStart,
    windowEnd,
  );
  const civilDowns = findAll(
    (cursor, days) =>
      toJSDate(
        Astronomy.SearchAltitude(
          Astronomy.Body.Sun,
          obs,
          -1,
          cursor,
          days,
          -6,
        ),
      ),
    windowStart,
    windowEnd,
  );
  const nautUps = findAll(
    (cursor, days) =>
      toJSDate(
        Astronomy.SearchAltitude(
          Astronomy.Body.Sun,
          obs,
          +1,
          cursor,
          days,
          -12,
        ),
      ),
    windowStart,
    windowEnd,
  );
  const nautDowns = findAll(
    (cursor, days) =>
      toJSDate(
        Astronomy.SearchAltitude(
          Astronomy.Body.Sun,
          obs,
          -1,
          cursor,
          days,
          -12,
        ),
      ),
    windowStart,
    windowEnd,
  );

  // === Moon: rise/set ===
  const moonRises = findAll(
    (cursor, days) =>
      toJSDate(
        Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, +1, cursor, days),
      ),
    windowStart,
    windowEnd,
  );
  const moonSets = findAll(
    (cursor, days) =>
      toJSDate(
        Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, -1, cursor, days),
      ),
    windowStart,
    windowEnd,
  );

  // === Bands ===
  const sunAltAtStart = bodyAltitudeAt(Astronomy.Body.Sun, obs, windowStart);
  const moonAltAtStart = bodyAltitudeAt(Astronomy.Body.Moon, obs, windowStart);

  const sunBands = buildSegments(
    sunRises,
    sunSets,
    sunAltAtStart > 0,
    windowStart,
    windowEnd,
  );
  const civilBands = buildSegments(
    civilUps,
    civilDowns,
    sunAltAtStart > -6,
    windowStart,
    windowEnd,
  );
  const nautBands = buildSegments(
    nautUps,
    nautDowns,
    sunAltAtStart > -12,
    windowStart,
    windowEnd,
  );
  const moonUpSegments = buildSegments(
    moonRises,
    moonSets,
    moonAltAtStart > 0,
    windowStart,
    windowEnd,
  );

  // === Header values: next from now ===
  const nextAfter = (events: Date[], from: Date): Date | null =>
    events.find((d) => d.getTime() >= from.getTime()) ?? null;

  const sunrise = nextAfter(sunRises, now);
  const sunset = nextAfter(sunSets, now);
  const upcomingMoonrise = nextAfter(moonRises, now);
  // Pair: the moonset that ends the upcoming up-period. If the moon is
  // currently down, that's the set after the next rise. If currently up,
  // that's the next set from now.
  const upcomingMoonset = upcomingMoonrise
    ? nextAfter(moonSets, upcomingMoonrise)
    : nextAfter(moonSets, now);

  const moonPhase = Astronomy.MoonPhase(dayStart) / 360;
  const moonIllum = Astronomy.Illumination(
    Astronomy.Body.Moon,
    dayStart,
  ).phase_fraction;

  return {
    dayStart,
    dayEnd,
    windowStart,
    windowEnd,
    sunrise,
    sunset,
    moonrise: upcomingMoonrise,
    moonset: upcomingMoonset,
    sunBands,
    civilBands,
    nautBands,
    moonUpSegments,
    sunriseEvents: sunRises,
    sunsetEvents: sunSets,
    moonriseEvents: moonRises,
    moonsetEvents: moonSets,
    moonPhase,
    moonIllum,
    moonPhaseLabel: phaseLabel(moonPhase),
  };
}

/**
 * Compute one day's worth of sun / twilight / moon events for the observer.
 * "Today" is anchored at local-midnight — JS Date's local timezone proxies the
 * observer's timezone, which is accurate for desktop installs at the site.
 *
 * The window is widened to ±12 h around today so the strip can scroll cleanly
 * past midnight in either direction without running out of data.
 *
 * The actual computation runs in a post-paint effect so the first frame of
 * the app isn't blocked by ~500 ms of astronomy-engine iterative searches.
 * Callers receive `null` for the first ~1 RAF, then the real AlmanacDay.
 */
export function useAlmanac(observer: ObserverLocation): AlmanacDay | null {
  const [data, setData] = useState<AlmanacDay | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      try {
        setData(computeAlmanac(observer));
      } catch (err) {
        // astronomy-engine throws on non-finite inputs; surface the error
        // and leave any previously-computed data in place rather than
        // letting an uncaught throw bubble out of the rAF callback (which
        // would silently leave the strip stuck on "computing…").
        console.error("almanac computation failed:", err);
      }
    };
    const raf = requestAnimationFrame(tick);
    const interval = window.setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearInterval(interval);
    };
  }, [observer.lat, observer.lon, observer.alt]);

  return data;
}
