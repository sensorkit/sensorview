import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCapabilities,
  ScheduleEntry,
} from "../../lib/sensorkit-client/types";
import { useObserver } from "../skyview/hooks/useObserver";
import { useAlmanac } from "../skyview/hooks/useAlmanac";

type ZoomKind = "full" | "dark" | "6h" | "1h" | "30min";
type Zoom = { kind: ZoomKind } | { kind: "custom"; start: Date; end: Date };

const PRESETS: { kind: ZoomKind; label: string }[] = [
  { kind: "full", label: "Full" },
  { kind: "dark", label: "Dark" },
  { kind: "6h", label: "6 h" },
  { kind: "1h", label: "1 h" },
  { kind: "30min", label: "30 min" },
];

/** Min drag distance in pixels to commit as a custom zoom. Smaller = treat as click. */
const DRAG_THRESHOLD = 5;

/**
 * Forward-looking schedule visualization for a single controller. Two-band
 * row: top 25% is mode (operate/standby) tint, bottom 75% is the program
 * pill with a stable letter. Preset zoom chips above; "now" cursor anchored
 * at the left edge of the strip.
 *
 * Operate/standby classification is resolved against the agent's published
 * Capabilities keyword. If unavailable (e.g. SK ever drops the deprecated
 * keyword), the mode tint falls back to neutral and only the program layer
 * remains visible.
 */
export function ScheduleStrip({
  controllerName,
  schedule,
  agentCapabilities,
}: {
  controllerName: string;
  schedule: ScheduleEntry[];
  agentCapabilities: AgentCapabilities | null;
}) {
  const { observer } = useObserver();
  const almanac = useAlmanac(observer);
  const now = useNow();
  const [zoom, setZoom] = useState<Zoom>({ kind: "1h" });
  const [lastPreset, setLastPreset] = useState<ZoomKind>("1h");

  // Click-drag zoom state. `startX`/`currentX` are pixel offsets within the
  // strip. Commit as a custom range only if the drag exceeded DRAG_THRESHOLD
  // pixels — below that we treat it as a click and don't zoom.
  const stripRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ startX: number; currentX: number } | null>(
    null,
  );

  // Measured strip width drives axis tick density; null until the first
  // ResizeObserver callback, when pickStep falls back to a fixed ~6-tick
  // target.
  const [stripWidth, setStripWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setStripWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const intervals = useMemo(
    () =>
      schedule.map(([s, e, w]) => ({
        start: new Date(s),
        end: new Date(e),
        mode: w.mode,
        programs: w.programs,
      })),
    [schedule],
  );

  const view = useMemo(
    () => computeWindow(zoom, now, intervals, almanac),
    [zoom, now, intervals, almanac],
  );

  // Stable letter + color per program seen in this controller's schedule.
  const programLegend = useMemo(() => buildLegend(intervals), [intervals]);

  const modeStateOf = (modeName: string): "operate" | "standby" | null => {
    const modes = agentCapabilities?.controllers[controllerName]?.modes;
    return modes?.find((m) => m.name === modeName)?.state ?? null;
  };

  const visible = intervals.filter(
    (iv) => iv.end > view.start && iv.start < view.end,
  );

  const pickPreset = (kind: ZoomKind) => {
    setLastPreset(kind);
    setZoom({ kind });
  };

  const resetToPreset = () => setZoom({ kind: lastPreset });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    setDrag({ startX: x, currentX: x });
    stripRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    setDrag({ ...drag, currentX: x });
  };

  // Interval under the last tap/click, shown as a text line below the strip
  // since the title tooltips never fire on touch.
  const [tapped, setTapped] = useState<Interval | null>(null);

  const onPointerUp = (_e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const rect = stripRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const a = Math.min(drag.startX, drag.currentX);
      const b = Math.max(drag.startX, drag.currentX);
      const span = view.end.getTime() - view.start.getTime();
      if (b - a >= DRAG_THRESHOLD) {
        const t0 = view.start.getTime() + (a / rect.width) * span;
        const t1 = view.start.getTime() + (b / rect.width) * span;
        setZoom({ kind: "custom", start: new Date(t0), end: new Date(t1) });
      } else {
        const t = new Date(view.start.getTime() + (a / rect.width) * span);
        setTapped(visible.find((iv) => iv.start <= t && t < iv.end) ?? null);
      }
    }
    setDrag(null);
  };

  const onPointerCancel = () => setDrag(null);

  const dragLeft = drag ? Math.min(drag.startX, drag.currentX) : 0;
  const dragWidth = drag ? Math.abs(drag.currentX - drag.startX) : 0;
  const showDragRect = drag && dragWidth >= 1;

  const tappedModeState = tapped ? modeStateOf(tapped.mode) : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 pointer-coarse:gap-3 flex-wrap">
        {PRESETS.map((p) => (
          <Chip
            key={p.kind}
            label={p.label}
            active={zoom.kind === p.kind}
            onClick={() => pickPreset(p.kind)}
          />
        ))}
        {zoom.kind === "custom" && (
          <Chip label="Reset" active onClick={resetToPreset} />
        )}
      </div>

      <div className="relative">
        <div
          ref={stripRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          className="relative w-full rounded border border-panel-border overflow-hidden bg-black/40 select-none touch-pan-y"
          style={{ height: 32, cursor: drag ? "ew-resize" : "crosshair" }}
        >
          {/* Top band — mode tint. Default is red (down): the operator falls
              back to standby when no mode demands operate, so gaps in the
              schedule render as down. Operate intervals overlay green;
              explicit standby intervals stay red; unknown mode draws grey. */}
          <div
            className="absolute inset-x-0 top-0 bg-red-500/30"
            style={{ height: "25%" }}
            title="down"
          >
            {visible.map((iv, i) => {
              const ms = modeStateOf(iv.mode);
              if (ms === "standby") return null;
              const cls = ms === "operate" ? "bg-green-500/40" : "bg-white/20";
              const left = pct(iv.start, view);
              const right = pct(iv.end, view);
              return (
                <div
                  key={`m-${i}`}
                  className={cls}
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    width: `${Math.max(0, right - left)}%`,
                    top: 0,
                    bottom: 0,
                  }}
                  title={`${iv.mode}${ms ? ` (${ms})` : ""}`}
                />
              );
            })}
          </div>

          {/* Bottom band — program pills */}
          <div
            className="absolute inset-x-0"
            style={{ top: "25%", bottom: 0 }}
          >
            {visible.map((iv, i) => {
              const program = iv.programs[0];
              if (!program) return null;
              const meta = programLegend.get(program);
              if (!meta) return null;
              const left = pct(iv.start, view);
              const right = pct(iv.end, view);
              const widthPct = Math.max(0, right - left);
              if (widthPct < 0.2) return null;
              return (
                <div
                  key={`p-${i}`}
                  className={`${meta.bg} ${meta.text} font-mono text-[10px] flex items-center justify-center overflow-hidden`}
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    width: `${widthPct}%`,
                    top: 0,
                    bottom: 0,
                  }}
                  title={`${program} · ${fmtShort(iv.start)} → ${fmtShort(iv.end)}`}
                >
                  {widthPct > 1.5 ? meta.letter : ""}
                </div>
              );
            })}
          </div>

          {/* Now cursor */}
          {now >= view.start && now <= view.end && (
            <div
              className="absolute top-0 bottom-0 bg-orange-300 pointer-events-none"
              style={{
                left: `${pct(now, view)}%`,
                width: 1,
                boxShadow: "0 0 4px rgba(253, 186, 116, 0.8)",
              }}
            />
          )}

          {/* Drag selection rectangle */}
          {showDragRect && (
            <div
              className="absolute top-0 bottom-0 bg-cyan-300/15 border-l border-r border-cyan-300/70 pointer-events-none"
              style={{ left: dragLeft, width: dragWidth }}
            />
          )}
        </div>

        {/* Axis */}
        <div className="relative h-3 mt-1 text-[9px] font-mono text-text-dim">
          {axisTicks(view, stripWidth).map((t, i) => (
            <span
              key={i}
              className="absolute -translate-x-1/2"
              style={{ left: `${pct(t, view)}%` }}
            >
              {fmtAxis(t, view)}
            </span>
          ))}
        </div>
      </div>

      {tapped && (
        <div className="text-[10px] font-mono text-text-dim">
          {tapped.programs[0] && (
            <span className="text-text-bright">{tapped.programs[0]} · </span>
          )}
          {tapped.mode}
          {tappedModeState ? ` (${tappedModeState})` : ""}
          {" · "}
          {fmtShort(tapped.start)} → {fmtShort(tapped.end)}
        </div>
      )}

      {programLegend.size > 0 && (
        <div className="flex items-center gap-3 flex-wrap text-[10px] text-text-dim">
          {Array.from(programLegend.entries()).map(([name, meta]) => (
            <span key={name} className="inline-flex items-center gap-1.5">
              <span
                className={`${meta.bg} ${meta.text} font-mono inline-flex items-center justify-center`}
                style={{ width: 14, height: 14, fontSize: 9 }}
              >
                {meta.letter}
              </span>
              <span className="text-text-bright">{name}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// === Helpers ===

interface Window {
  start: Date;
  end: Date;
}

interface Interval {
  start: Date;
  end: Date;
  mode: string;
  programs: string[];
}

function computeWindow(
  zoom: Zoom,
  now: Date,
  intervals: Interval[],
  almanac: ReturnType<typeof useAlmanac>,
): Window {
  if (zoom.kind === "custom") {
    return { start: zoom.start, end: zoom.end };
  }
  if (zoom.kind === "30min") {
    return { start: now, end: new Date(now.getTime() + 30 * 60_000) };
  }
  if (zoom.kind === "1h") {
    return { start: now, end: new Date(now.getTime() + 60 * 60_000) };
  }
  if (zoom.kind === "6h") {
    return { start: now, end: new Date(now.getTime() + 6 * 3600_000) };
  }
  if (zoom.kind === "dark") {
    // Use the next sunset → next sunrise from useAlmanac. If we're already
    // past sunset, sunset is null and we anchor on `now`.
    const sunset = almanac?.sunset ?? now;
    const sunrise =
      almanac?.sunrise ??
      new Date(sunset.getTime() + 12 * 3600_000);
    const start = sunset < now ? now : sunset;
    return { start, end: sunrise > start ? sunrise : new Date(start.getTime() + 12 * 3600_000) };
  }
  // full — from now to the latest end in the schedule (min 1h to avoid empty)
  const latest = intervals.reduce(
    (m, iv) => Math.max(m, iv.end.getTime()),
    now.getTime() + 3600_000,
  );
  return { start: now, end: new Date(latest) };
}

function pct(t: Date, w: Window): number {
  const total = w.end.getTime() - w.start.getTime();
  if (total <= 0) return 0;
  const offset = t.getTime() - w.start.getTime();
  return Math.max(0, Math.min(100, (offset / total) * 100));
}

const PROGRAM_COLORS: { bg: string; text: string }[] = [
  { bg: "bg-blue-500/50",   text: "text-blue-100" },
  { bg: "bg-purple-500/50", text: "text-purple-100" },
  { bg: "bg-amber-500/50",  text: "text-amber-100" },
  { bg: "bg-cyan-500/50",   text: "text-cyan-100" },
  { bg: "bg-pink-500/50",   text: "text-pink-100" },
  { bg: "bg-emerald-500/50",text: "text-emerald-100" },
  { bg: "bg-rose-500/50",   text: "text-rose-100" },
  { bg: "bg-indigo-500/50", text: "text-indigo-100" },
];

function buildLegend(
  intervals: Interval[],
): Map<string, { letter: string; bg: string; text: string }> {
  const seen: string[] = [];
  for (const iv of intervals) {
    const p = iv.programs[0];
    if (p && !seen.includes(p)) seen.push(p);
  }
  seen.sort();
  return new Map(
    seen.map((name, i) => ({
      name,
      letter: String.fromCharCode(65 + (i % 26)),
      ...PROGRAM_COLORS[i % PROGRAM_COLORS.length]!,
    })).map((entry) => [entry.name, entry]),
  );
}

function axisTicks(w: Window, stripWidth: number | null): Date[] {
  const span = w.end.getTime() - w.start.getTime();
  const step = pickStep(span, stripWidth);
  // Snap first tick to the next step boundary at/after start.
  const startMs = w.start.getTime();
  const first = Math.ceil(startMs / step) * step;
  const ticks: Date[] = [];
  for (let t = first; t <= w.end.getTime(); t += step) {
    ticks.push(new Date(t));
    if (ticks.length > 12) break;
  }
  return ticks;
}

function pickStep(spanMs: number, stripWidth: number | null): number {
  const candidates = [
    60_000,        // 1m
    5 * 60_000,    // 5m
    10 * 60_000,
    15 * 60_000,
    30 * 60_000,
    60 * 60_000,
    2 * 3600_000,
    6 * 3600_000,
    12 * 3600_000,
    24 * 3600_000,
  ];
  // Aim for one label per ~55px of strip so narrow screens thin out; cap at
  // ~6 so wide strips keep the familiar density. Fall back to ~6 ticks until
  // the strip has been measured.
  const tickTarget =
    stripWidth != null
      ? Math.min(6, Math.max(2, Math.floor(stripWidth / 55)))
      : 6;
  const target = spanMs / tickTarget;
  for (const c of candidates) if (c >= target) return c;
  return candidates[candidates.length - 1]!;
}

function fmtAxis(t: Date, w: Window): string {
  const span = w.end.getTime() - w.start.getTime();
  const h = String(t.getHours()).padStart(2, "0");
  const m = String(t.getMinutes()).padStart(2, "0");
  if (span >= 24 * 3600_000) {
    const dd = String(t.getDate()).padStart(2, "0");
    return `${dd} ${h}:${m}`;
  }
  return `${h}:${m}`;
}

function fmtShort(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${h}:${m}`;
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "px-2 py-0.5 pointer-coarse:px-3 pointer-coarse:py-1.5 text-[10px] uppercase tracking-wide rounded border border-orange-300/60 bg-orange-300/15 text-orange-200 cursor-pointer"
          : "px-2 py-0.5 pointer-coarse:px-3 pointer-coarse:py-1.5 text-[10px] uppercase tracking-wide rounded border border-panel-border bg-white/5 text-text-dim hover:bg-white/10 hover:text-text-bright cursor-pointer"
      }
    >
      {label}
    </button>
  );
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
