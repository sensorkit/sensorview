import { useEffect, useState } from "react";
import { useObserver } from "../hooks/useObserver";
import { useAlmanac, type AlmanacDay } from "../hooks/useAlmanac";
import { MoonGlyph } from "./MoonGlyph";

/**
 * Visible portion of the strip at any moment. The data window is wider (see
 * useAlmanac), and the inner content is scaled accordingly so that NOW always
 * sits at the strip's center while the rest scrolls in around it.
 */
const VISIBLE_HOURS = 24;
/** Hours between hour-tick labels along the timeline. */
const TICK_INTERVAL_H = 6;

/**
 * V4 "Atlas Observatory" Almanac strip. Shows twilight bands, sun and moon
 * events, and a NOW indicator along a 24h-visible scale centered on now. The
 * underlying data window is widened so the strip can scroll past today's
 * midnight in either direction without clipping the next day's events.
 */
export function AlmanacStrip() {
  const { observer } = useObserver();
  const almanac = useAlmanac(observer);

  // NOW line ticks every 30 s — that's fast enough to stay a pixel accurate on
  // an ~1000 px wide strip and cheap enough to ignore.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Scrub position along the strip, as a 0..1 fraction of its width, plus the
  // input that produced it. Null when nothing is pointing at the timeline.
  // Touch reads out above the strip because a fingertip covers all 22 px of it.
  const [scrub, setScrub] = useState<Scrub | null>(null);

  // Safety net for the touch readout. The strip captures the pointer so it
  // normally gets its own pointerup, but capture can fail (see below) — and
  // then a finger lifted off the strip would leave the readout stuck on
  // screen with no way to dismiss it. Window listeners always fire.
  useEffect(() => {
    if (!scrub?.touch) return;
    const clear = () => setScrub(null);
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
    };
  }, [scrub?.touch]);

  if (!almanac) {
    // First render before the deferred computation completes — show the
    // empty paper strip so layout doesn't jump when data arrives.
    return (
      <div
        className="h-full w-full flex items-center"
        style={{
          padding: "8px 18px 10px",
          color: "var(--color-paper-dim)",
          fontSize: 11,
          letterSpacing: 0.3,
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--color-ink)" }}>
          Almanac
        </span>
        <span className="ml-3 mono" style={{ fontSize: 10 }}>
          computing…
        </span>
      </div>
    );
  }

  const { windowStart, windowEnd } = almanac;
  const windowMs = windowEnd.getTime() - windowStart.getTime();
  const windowHours = windowMs / 3_600_000;
  // Inner content is wider than the strip so VISIBLE_HOURS' worth of pixels
  // still maps to the strip width. Ratio of "data width" to "viewport width".
  const innerScale = windowHours / VISIBLE_HOURS;

  const toFrac = (d: Date | null): number | null => {
    if (!d) return null;
    const ms = d.getTime() - windowStart.getTime();
    if (ms < 0 || ms > windowMs) return null;
    return ms / windowMs;
  };

  const nowFrac = Math.max(
    0,
    Math.min(1, (now.getTime() - windowStart.getTime()) / windowMs),
  );
  // translateX is a percentage of the inner element's own width. Place NOW
  // (at fraction nowFrac along the inner content) at the strip's horizontal
  // center: see derivation in PR description.
  const offsetPct = (1 / (2 * innerScale) - nowFrac) * 100;

  // Inverse of the transform above: strip fraction -> instant on the timeline.
  // Derived from x_inner = f*W - translate, so the window fraction under the
  // cursor is (f - 0.5)/innerScale + nowFrac.
  const scrubTime = !scrub
    ? null
    : new Date(
        windowStart.getTime() +
          windowMs * ((scrub.frac - 0.5) / innerScale + nowFrac),
      );

  return (
    <div
      className="h-full w-full flex flex-col"
      style={{ padding: "8px 18px 10px", color: "var(--color-ink)" }}
    >
      <HeaderRow almanac={almanac} />
      <div className="relative mt-[5px]" style={{ flex: "0 0 auto" }}>
        <TwilightStrip
          almanac={almanac}
          toFrac={toFrac}
          offsetPct={offsetPct}
          innerScale={innerScale}
          onScrub={setScrub}
          overlay={
            <>
              <NowIndicator />
              {scrub && scrubTime && (
                <ScrubLine frac={scrub.frac} touch={scrub.touch} />
              )}
              {scrub && scrubTime && !scrub.touch && (
                <ScrubChipInline frac={scrub.frac} time={scrubTime} />
              )}
            </>
          }
        >
          {almanac.moonUpSegments.map(([a, b], i) => {
            const fa = toFrac(a);
            const fb = toFrac(b);
            if (fa === null || fb === null || fb <= fa) return null;
            return (
              <div
                key={i}
                className="absolute"
                style={{
                  bottom: 0,
                  height: 5,
                  left: `${fa * 100}%`,
                  width: `${(fb - fa) * 100}%`,
                  background: "var(--color-moon)",
                  opacity: 0.95,
                  borderTop: "1px solid var(--color-brass-dim)",
                }}
              />
            );
          })}
          {almanac.sunriseEvents.map((d, i) => (
            <EdgeMarker
              key={`sr${i}`}
              frac={toFrac(d)}
              edge="top"
              color="var(--color-sun)"
              title="sunrise"
            />
          ))}
          {almanac.sunsetEvents.map((d, i) => (
            <EdgeMarker
              key={`ss${i}`}
              frac={toFrac(d)}
              edge="top"
              color="var(--color-sun)"
              title="sunset"
            />
          ))}
          {almanac.moonriseEvents.map((d, i) => (
            <EdgeMarker
              key={`mr${i}`}
              frac={toFrac(d)}
              edge="bottom"
              color="var(--color-moon)"
              title="moonrise"
            />
          ))}
          {almanac.moonsetEvents.map((d, i) => (
            <EdgeMarker
              key={`ms${i}`}
              frac={toFrac(d)}
              edge="bottom"
              color="var(--color-moon)"
              title="moonset"
            />
          ))}
        </TwilightStrip>
        {/* Touch readout floats above the strip, outside its overflow-hidden
            box, so a fingertip doesn't cover it. It overlays the header row
            while scrubbing — still inside the almanac panel, so nothing clips. */}
        {scrub?.touch && scrubTime && (
          <ScrubChipFloating frac={scrub.frac} time={scrubTime} />
        )}
      </div>
      {/* Hour tick labels scroll with the timeline in their own row, so the
          AtlasContainer's overflow-hidden can't clip them. */}
      <div
        className="relative"
        style={{ height: 11, marginTop: 3, flex: "0 0 auto" }}
      >
        <div
          className="absolute"
          style={{
            top: 0,
            bottom: 0,
            left: 0,
            width: `${innerScale * 100}%`,
            transform: `translateX(${offsetPct}%)`,
            pointerEvents: "none",
          }}
        >
          {hourTicks(windowStart, windowHours).map(({ offset, label }) => (
            <span
              key={offset}
              className="mono absolute"
              style={{
                top: 0,
                left: `calc(${(offset / windowHours) * 100}% - 8px)`,
                fontSize: 9,
                lineHeight: 1,
                color: "var(--color-paper-dim)",
                letterSpacing: 0.5,
              }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Build the list of hour-tick positions across the window. Labels are local
 * hour-of-day so they cycle naturally past midnight (e.g. "… 18 00 06 12 …").
 */
function hourTicks(
  windowStart: Date,
  windowHours: number,
): { offset: number; label: string }[] {
  const out: { offset: number; label: string }[] = [];
  for (let h = 0; h <= windowHours; h += TICK_INTERVAL_H) {
    const t = new Date(windowStart.getTime() + h * 3_600_000);
    out.push({ offset: h, label: String(t.getHours()).padStart(2, "0") });
  }
  return out;
}

function HeaderRow({ almanac }: { almanac: AlmanacDay }) {
  const fmt = (d: Date | null) =>
    d
      ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      : "—";

  const illumPct = Math.round(almanac.moonIllum * 100);

  return (
    <div
      className="flex items-center flex-wrap gap-x-[18px] gap-y-1"
      style={{ fontSize: 10.5, flex: "0 0 auto" }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--color-ink)",
          letterSpacing: 0.3,
        }}
      >
        Almanac
      </span>

      <span className="inline-flex items-center" style={{ gap: 6 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 99,
            background: "var(--color-sun)",
          }}
        />
        <span style={{ color: "var(--color-paper-dim)" }}>rise</span>
        <span className="mono" style={{ color: "var(--color-ink)" }}>
          {fmt(almanac.sunrise)}
        </span>
        <span style={{ color: "var(--color-paper-dim)", marginLeft: 4 }}>
          set
        </span>
        <span className="mono" style={{ color: "var(--color-ink)" }}>
          {fmt(almanac.sunset)}
        </span>
      </span>

      <span className="inline-flex items-center" style={{ gap: 6 }}>
        <MoonGlyph size={14} phase={almanac.moonPhase} bg="var(--color-paper)" />
        <span style={{ color: "var(--color-paper-dim)" }}>rise</span>
        <span className="mono" style={{ color: "var(--color-ink)" }}>
          {fmt(almanac.moonrise)}
        </span>
        <span style={{ color: "var(--color-paper-dim)", marginLeft: 4 }}>
          set
        </span>
        <span className="mono" style={{ color: "var(--color-ink)" }}>
          {fmt(almanac.moonset)}
        </span>
        <span className="max-sm:hidden" style={{ color: "var(--color-paper-dim)", marginLeft: 6 }}>
          {almanac.moonPhaseLabel} · {illumPct}%
        </span>
      </span>

      <Legend />
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["day", "var(--color-sun)"],
    ["civil", "var(--color-civil)"],
    ["nautical", "var(--color-nautical)"],
    ["astronomical", "var(--color-night)"],
  ];
  return (
    <div
      className="ml-auto flex items-center max-lg:hidden"
      style={{ gap: 10, fontSize: 10, color: "var(--color-paper-dim)" }}
    >
      {items.map(([label, bg]) => (
        <span key={label} className="inline-flex items-center" style={{ gap: 4 }}>
          <span style={{ width: 10, height: 6, background: bg, display: "inline-block" }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function TwilightStrip({
  almanac,
  toFrac,
  offsetPct,
  innerScale,
  children,
  overlay,
  onScrub,
}: {
  almanac: AlmanacDay;
  toFrac: (d: Date | null) => number | null;
  offsetPct: number;
  innerScale: number;
  children: React.ReactNode;
  overlay?: React.ReactNode;
  onScrub?: (scrub: Scrub | null) => void;
}) {
  const report = (e: React.PointerEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const f = (e.clientX - box.left) / box.width;
    onScrub?.({
      frac: Math.max(0, Math.min(1, f)),
      touch: e.pointerType === "touch",
    });
  };
  const band = (segments: [Date, Date][], bg: string, key: string) =>
    segments.map(([from, to], i) => {
      const a = toFrac(from);
      const b = toFrac(to);
      if (a === null || b === null || b <= a) return null;
      return (
        <div
          key={`${key}${i}`}
          className="absolute"
          style={{
            top: 0,
            bottom: 0,
            left: `${a * 100}%`,
            width: `${(b - a) * 100}%`,
            background: bg,
          }}
        />
      );
    });

  return (
    <div
      className="relative"
      style={{
        height: 22,
        borderRadius: 1,
        border: "1px solid rgba(199,184,143,0.6)",
        overflow: "hidden",
        background: "var(--color-night)",
        cursor: onScrub ? "crosshair" : undefined,
        // Claim horizontal drags for scrubbing but leave vertical alone, so a
        // flick that starts on the strip still scrolls the compact layout.
        touchAction: onScrub ? "pan-y" : undefined,
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        // The strip is 22 px tall — capture so the readout survives a finger
        // that drifts off it mid-drag. Capture is a nicety, not a
        // precondition: if the pointer is already gone this throws, and the
        // readout should still appear.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* no active pointer to capture */
        }
        report(e);
      }}
      onPointerMove={report}
      onPointerUp={() => onScrub?.(null)}
      onPointerCancel={() => onScrub?.(null)}
      onPointerLeave={(e) => {
        // Touch ends via up/cancel; leave fires mid-drag and would clear early.
        if (e.pointerType !== "touch") onScrub?.(null);
      }}
    >
      <div
        className="absolute"
        style={{
          top: 0,
          bottom: 0,
          left: 0,
          width: `${innerScale * 100}%`,
          transform: `translateX(${offsetPct}%)`,
        }}
      >
        {band(almanac.nautBands, "var(--color-nautical)", "n")}
        {band(almanac.civilBands, "var(--color-civil)", "c")}
        {band(almanac.sunBands, "var(--color-sun)", "s")}
        {children}
      </div>
      {overlay}
    </div>
  );
}

function EdgeMarker({
  frac,
  edge,
  color,
  title,
}: {
  frac: number | null;
  edge: "top" | "bottom";
  color: string;
  title: string;
}) {
  if (frac === null) return null;
  return (
    <div
      title={title}
      className="absolute"
      style={{
        top: edge === "top" ? -3 : undefined,
        bottom: edge === "bottom" ? -3 : undefined,
        left: `calc(${frac * 100}% - 4px)`,
        width: 8,
        height: 8,
        borderRadius: 99,
        background: color,
        border: "1px solid var(--color-brass-dim)",
      }}
    />
  );
}

/** Where the pointer is on the strip, and whether a finger put it there. */
type Scrub = { frac: number; touch: boolean };

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Readout text: local clock time first (matching the hour ticks), then UTC. */
function clockLabel(time: Date) {
  return {
    local: `${pad2(time.getHours())}:${pad2(time.getMinutes())}`,
    utc: `${pad2(time.getUTCHours())}:${pad2(time.getUTCMinutes())}Z`,
  };
}

const CHIP_BASE: React.CSSProperties = {
  background: "rgba(28,25,20,0.88)",
  border: "1px solid var(--color-brass-dim)",
  borderRadius: 2,
  whiteSpace: "nowrap",
  color: "var(--color-paper)",
  pointerEvents: "none",
};

/** Guide line at the scrub position. Thicker under a finger. */
function ScrubLine({ frac, touch }: { frac: number; touch: boolean }) {
  return (
    <div
      className="absolute"
      style={{
        left: `${frac * 100}%`,
        top: 0,
        bottom: 0,
        width: touch ? 2 : 1,
        marginLeft: touch ? -1 : 0,
        background: "var(--color-paper)",
        opacity: touch ? 0.9 : 0.7,
        pointerEvents: "none",
      }}
    />
  );
}

/**
 * Mouse readout, inside the 22 px strip beside the guide line — so neither the
 * atlas root's overflow-hidden nor the header row can clip it. Flips to the
 * other side of the line past the midpoint to stay in bounds.
 */
function ScrubChipInline({ frac, time }: { frac: number; time: Date }) {
  const { local, utc } = clockLabel(time);
  const flip = frac > 0.5;
  return (
    <div
      className="mono absolute"
      style={{
        ...CHIP_BASE,
        left: `${frac * 100}%`,
        top: "50%",
        marginTop: -8,
        transform: flip ? "translateX(calc(-100% - 5px))" : "translateX(5px)",
        padding: "1px 5px",
        fontSize: 9.5,
        lineHeight: "12px",
      }}
    >
      {local} <span style={{ opacity: 0.55 }}>{utc}</span>
    </div>
  );
}

/**
 * Touch readout, floated above the strip and out of the fingertip's shadow.
 * Anchoring switches to the strip edges near either end rather than centring on
 * the touch, which keeps the chip in view without measuring its width.
 */
function ScrubChipFloating({ frac, time }: { frac: number; time: Date }) {
  const { local, utc } = clockLabel(time);
  const edge: React.CSSProperties =
    frac < 0.2
      ? { left: 0 }
      : frac > 0.8
        ? { right: 0 }
        : { left: `${frac * 100}%`, transform: "translateX(-50%)" };

  return (
    <div
      className="mono absolute"
      style={{
        ...CHIP_BASE,
        ...edge,
        bottom: "calc(100% + 4px)",
        padding: "2px 7px",
        fontSize: 11,
        lineHeight: "14px",
        boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
        zIndex: 2,
      }}
    >
      {local} <span style={{ opacity: 0.6 }}>{utc}</span>
    </div>
  );
}

function NowIndicator() {
  return (
    <>
      <div
        className="absolute"
        style={{
          left: "50%",
          top: -2,
          bottom: -2,
          width: 1.5,
          background: "var(--color-terracotta)",
        }}
      />
      <div
        className="absolute"
        style={{
          left: "calc(50% - 4px)",
          top: -6,
          width: 9,
          height: 9,
          background: "var(--color-terracotta)",
          transform: "rotate(45deg)",
        }}
      />
      <span
        className="mono absolute"
        style={{
          left: "calc(50% - 14px)",
          top: -16,
          fontSize: 9,
          color: "var(--color-terracotta)",
          fontWeight: 600,
          letterSpacing: 0.5,
        }}
      >
        NOW
      </span>
    </>
  );
}
