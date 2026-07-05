import { useEffect, useMemo, useState } from "react";
import { useSensorKitStore } from "../../stores/sensorkit";

interface BasicWeather {
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  cloud_cover: number | null;
  dew_point: number | null;
  rain_rate: number | null;
  wind_direction: number | null;
  wind_speed: number | null;
}

interface WeatherConditions {
  cloud: string | null;
  humidity: string | null;
  rain: string | null;
  sky: string | null;
  wind: string | null;
}

/** Canonical safe/unsafe summary published by any StandardSafety device. */
interface BasicSafety {
  is_safe: boolean;
}

/**
 * Optional per-module safety breakdown (node_platform). The summary
 * `is_safe` is no longer here — read it from BasicSafety. These fields are
 * descriptive sub-conditions that the safety summary aggregates over.
 */
interface SafetyBreakdown {
  is_weather_safe: boolean;
  is_all_sky_safe: boolean;
  is_night: boolean;
}

type EntityState = Record<string, unknown> | undefined;

/**
 * Live weather card. Surfaces "current observatory conditions" from any
 * entity whose SK archetype is `weather` or `safety` — namely:
 *   • alpaca, indigo, nina, node_platform → archetype `weather`
 *   • node_platform, thesky               → archetype `safety`
 *
 * Discovery uses the archetype published in the entity listing, not
 * keyword sniffing. Each section renders only if its keyword is present
 * on the selected entity, so a safety-only device (e.g. thesky) collapses
 * to just the SAFE/UNSAFE pill while a richer weather device grows the
 * full stack.
 */
export function WeatherCard() {
  const state = useSensorKitStore((s) => s.state);
  const entities = useSensorKitStore((s) => s.entities);

  const weatherEntities = useMemo(() => {
    return entities
      .filter((e) => e.archetype === "weather" || e.archetype === "safety")
      .map((e) => e.name)
      .sort();
  }, [entities]);

  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (weatherEntities.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !weatherEntities.includes(selected)) {
      setSelected(weatherEntities[0]!);
    }
  }, [weatherEntities, selected]);

  if (weatherEntities.length === 0) return null;

  const ent = selected ? (state[selected] as EntityState) : undefined;
  const basic = ent?.["BasicWeather"] as BasicWeather | undefined;
  const conditions = ent?.["WeatherConditions"] as WeatherConditions | undefined;
  const basicSafety = ent?.["BasicSafety"] as BasicSafety | undefined;
  const safetyBreakdown = ent?.["Safety"] as SafetyBreakdown | undefined;

  const hasAny = basic || conditions || basicSafety || safetyBreakdown;

  return (
    <div className="bg-panel-bg/60 border border-panel-border rounded-lg p-4 space-y-3 w-fit mx-auto">
      <div className="flex items-baseline justify-end">
        {weatherEntities.length > 1 ? (
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value)}
            className="bg-black/40 border border-panel-border rounded px-2 py-0.5 text-[11px] font-mono text-text-bright outline-none focus:border-orange-300/60"
          >
            {weatherEntities.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[10px] text-text-dim font-mono">{selected}</span>
        )}
      </div>

      {!hasAny ? (
        <div className="text-xs text-text-dim">No weather data yet.</div>
      ) : (
        <div className="space-y-3">
          {/* High-level safety pill sits on top — answers "should we be
              observing?" before the user reads the numbers. The breakdown
              renders underneath when the device publishes one. */}
          {(basicSafety || safetyBreakdown) && (
            <SafetyBadge basic={basicSafety} breakdown={safetyBreakdown} />
          )}

          {basic && <BasicDisplay w={basic} />}

          {conditions && <ConditionsRow c={conditions} />}
        </div>
      )}
    </div>
  );
}

// === BasicWeather =======================================================

function BasicDisplay({ w }: { w: BasicWeather }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3 items-stretch">
      <div className="grid grid-cols-3 gap-2">
        <Tile
          graphic={<Thermometer temperature={w.temperature} />}
          value={fmtTemp(w.temperature)}
          label="Temp"
        />
        <Tile
          graphic={<HumidityDrop pct={w.humidity} />}
          value={w.humidity != null ? `${w.humidity.toFixed(0)}%` : "—"}
          label="Humidity"
        />
        <Tile
          graphic={
            <WindArrow speed={w.wind_speed} direction={w.wind_direction} />
          }
          value={w.wind_speed != null ? `${w.wind_speed.toFixed(1)} m/s` : "—"}
          label={
            w.wind_direction != null
              ? `from ${cardinalOf(w.wind_direction)}`
              : "Wind"
          }
        />
      </div>

      <div className="flex flex-col justify-center text-[11px] space-y-1">
        {w.pressure != null && (
          <Row label="Pressure" value={`${w.pressure.toFixed(1)} hPa`} />
        )}
        {w.cloud_cover != null && (
          <Row label="Cloud cover" value={`${w.cloud_cover.toFixed(0)}%`} />
        )}
        {w.dew_point != null && (
          <Row label="Dew point" value={fmtTemp(w.dew_point)} />
        )}
        {w.rain_rate != null && (
          <Row label="Rain rate" value={`${w.rain_rate.toFixed(1)} mm/h`} />
        )}
      </div>
    </div>
  );
}

// === Safety =============================================================

/**
 * Renders the canonical SAFE/UNSAFE pill from `BasicSafety.is_safe` plus
 * (optionally) sub-condition chips from the per-module `Safety` keyword.
 * Either input can be absent: a thesky entity publishes only BasicSafety
 * (just the pill); a future module could publish only the breakdown
 * (chips with no top-line summary).
 */
function SafetyBadge({
  basic,
  breakdown,
}: {
  basic: BasicSafety | undefined;
  breakdown: SafetyBreakdown | undefined;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      {basic && (
        <BigPill
          ok={basic.is_safe}
          label={basic.is_safe ? "SAFE" : "UNSAFE"}
        />
      )}
      {breakdown && (
        <div className="flex flex-wrap gap-1 justify-center">
          <SubPill ok={breakdown.is_weather_safe} label="Weather" />
          <SubPill ok={breakdown.is_all_sky_safe} label="All-sky" />
          {/* Night is informational, not pass/fail — show neutral. */}
          <NeutralPill label={breakdown.is_night ? "Night" : "Day"} />
        </div>
      )}
    </div>
  );
}

function BigPill({ ok, label }: { ok: boolean; label: string }) {
  const cls = ok
    ? "border-green-400/60 bg-green-400/15 text-green-200"
    : "border-red-400/60 bg-red-400/15 text-red-200";
  return (
    <span
      className={`px-3 py-1 rounded-full border text-[12px] font-semibold tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function SubPill({ ok, label }: { ok: boolean; label: string }) {
  const cls = ok
    ? "border-green-400/40 text-green-300/90"
    : "border-red-400/40 text-red-300/90";
  return (
    <span
      className={`px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function NeutralPill({ label }: { label: string }) {
  return (
    <span className="px-2 py-0.5 rounded-full border border-panel-border text-[10px] uppercase tracking-wide text-text-dim">
      {label}
    </span>
  );
}

// === Categorical conditions =============================================

type Severity = "good" | "warn" | "bad" | "neutral";

const CONDITION_SEVERITY: Record<keyof WeatherConditions, Record<string, Severity>> = {
  cloud: { Clear: "good", Cloudy: "warn", Overcast: "bad" },
  humidity: { Dry: "good", Normal: "good", Humid: "warn" },
  rain: { Dry: "good", Wet: "warn", Raining: "bad" },
  sky: { Dark: "good", Light: "warn", "Very Light": "bad" },
  wind: { Calm: "good", Moderate: "warn", Strong: "bad" },
};

function classifyCondition(field: keyof WeatherConditions, value: string): Severity {
  return CONDITION_SEVERITY[field]?.[value] ?? "neutral";
}

function ConditionsRow({ c }: { c: WeatherConditions }) {
  const fields: Array<{ field: keyof WeatherConditions; label: string }> = [
    { field: "cloud", label: "Cloud" },
    { field: "rain", label: "Rain" },
    { field: "wind", label: "Wind" },
    { field: "humidity", label: "Humidity" },
    { field: "sky", label: "Sky" },
  ];
  const present = fields.filter(({ field }) => c[field] != null);
  if (present.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 justify-center">
      {present.map(({ field, label }) => (
        <ConditionChip
          key={field}
          label={label}
          value={c[field]!}
          severity={classifyCondition(field, c[field]!)}
        />
      ))}
    </div>
  );
}

function ConditionChip({
  label,
  value,
  severity,
}: {
  label: string;
  value: string;
  severity: Severity;
}) {
  const cls =
    severity === "good"
      ? "border-green-400/40 text-green-200/95 bg-green-400/5"
      : severity === "warn"
        ? "border-amber-300/40 text-amber-200/95 bg-amber-300/5"
        : severity === "bad"
          ? "border-red-400/40 text-red-200/95 bg-red-400/5"
          : "border-panel-border text-text-dim";
  return (
    <span
      className={`px-2 py-0.5 rounded border text-[10px] uppercase tracking-wide ${cls}`}
    >
      <span className="text-text-dim mr-1">{label}</span>
      {value}
    </span>
  );
}

// === Shared helpers =====================================================

function Tile({
  graphic,
  value,
  label,
}: {
  graphic: React.ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="bg-black/30 border border-panel-border rounded px-2 py-2 text-center flex flex-col items-center gap-1">
      <div className="flex items-center justify-center h-10">{graphic}</div>
      <div className="text-text-bright text-[12px] font-mono leading-none mt-1">
        {value}
      </div>
      <div className="text-[9px] text-text-dim uppercase tracking-wide leading-none">
        {label}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-text-dim">{label}</span>
      <span className="text-text-bright font-mono">{value}</span>
    </div>
  );
}

// === Graphics ===========================================================

/** Thermometer with mercury level proportional to temperature (-20°C..40°C). */
function Thermometer({ temperature }: { temperature: number | null }) {
  const t = temperature ?? null;
  const color =
    t == null
      ? "rgba(148, 163, 184, 0.6)"
      : t < 0
        ? "rgb(96, 165, 250)"
        : t < 15
          ? "rgb(34, 211, 238)"
          : t < 25
            ? "rgb(74, 222, 128)"
            : t < 32
              ? "rgb(251, 191, 36)"
              : "rgb(248, 113, 113)";

  const minT = -20;
  const maxT = 40;
  const clamped = Math.max(minT, Math.min(maxT, t ?? 20));
  const fillFrac = (clamped - minT) / (maxT - minT);
  const fillTop = 26 - fillFrac * 22;

  return (
    <svg viewBox="0 0 24 40" width="24" height="40" aria-hidden>
      <rect
        x="9"
        y="3"
        width="6"
        height="24"
        rx="3"
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        opacity="0.9"
      />
      {t != null && (
        <rect
          x="10.2"
          y={fillTop}
          width="3.6"
          height={26 - fillTop}
          fill={color}
        />
      )}
      <circle cx="12" cy="32" r="5.5" fill={color} />
    </svg>
  );
}

/** Teardrop with cyan fill rising to humidity %. */
function HumidityDrop({ pct }: { pct: number | null }) {
  const dropPath =
    "M 12 2 C 12 2 4 16 4 24 C 4 29 8 33 12 33 C 16 33 20 29 20 24 C 20 16 12 2 12 2 Z";
  const value = pct ?? null;
  const fillFrac = value != null ? Math.max(0, Math.min(1, value / 100)) : 0;
  const fillTop = 33 - fillFrac * 31;

  return (
    <svg viewBox="0 0 24 36" width="22" height="34" aria-hidden>
      <defs>
        <clipPath id="hum-drop-clip">
          <path d={dropPath} />
        </clipPath>
      </defs>
      <path d={dropPath} fill="rgba(56, 189, 248, 0.12)" />
      {value != null && (
        <rect
          x="0"
          y={fillTop}
          width="24"
          height={36 - fillTop}
          fill="rgba(56, 189, 248, 0.65)"
          clipPath="url(#hum-drop-clip)"
        />
      )}
      <path
        d={dropPath}
        fill="none"
        stroke="rgb(56, 189, 248)"
        strokeWidth="1.4"
      />
    </svg>
  );
}

/** Wind arrow rotated downwind. Color intensity scales with speed. */
function WindArrow({
  speed,
  direction,
}: {
  speed: number | null;
  direction: number | null;
}) {
  if (direction == null) {
    return <div className="text-text-dim text-xs leading-none">—</div>;
  }
  const rotation = (direction + 180) % 360;
  const s = speed ?? 0;
  const intensity = Math.max(0.4, Math.min(1, s / 10));
  const color = `rgba(251, 191, 36, ${intensity})`;
  return (
    <svg
      viewBox="0 0 36 36"
      width="34"
      height="34"
      aria-hidden
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <line
        x1="18"
        y1="30"
        x2="18"
        y2="9"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <polyline
        points="11,15 18,7 25,15"
        fill="none"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// === Helpers ============================================================

function fmtTemp(t: number | null): string {
  if (t == null) return "—";
  return `${t.toFixed(1)}°C`;
}

function cardinalOf(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return dirs[idx]!;
}
