import {
  formatAge,
  stateVectorAgeHours,
  svFreshness,
  type SVFreshness,
} from "../propagation/kepler";

/**
 * Epoch-age indicator for a state-vector row.
 *
 * A state vector is a snapshot at one instant, and SensorView propagates it
 * two-body — no drag, no manoeuvres. How fast that stops being true depends
 * hard on the orbit (see the measured table in kepler.ts), so the thresholds
 * are regime-aware and the raw age is always shown rather than hidden behind
 * a traffic light.
 */

const TONE: Record<SVFreshness, { color: string; border: string; background: string }> = {
  fresh: {
    color: "var(--color-paper-dim)",
    border: "transparent",
    background: "transparent",
  },
  aging: {
    color: "var(--color-brass)",
    border: "rgba(184,138,63,0.45)",
    background: "rgba(184,138,63,0.10)",
  },
  stale: {
    color: "var(--color-terracotta)",
    border: "rgba(199,95,60,0.5)",
    background: "rgba(199,95,60,0.12)",
  },
};

const EXPLANATION: Record<SVFreshness, string | null> = {
  fresh: null,
  aging: "Position is drifting — this state vector is old enough that the propagated position has likely moved off by around half a degree.",
  stale: "Position is unreliable. Two-body propagation over this span accumulates degrees of error, and any manoeuvre since the epoch is unmodelled.",
};

export function svEpochInfo(epoch: string, orbitRegime: string | undefined) {
  const ageHours = stateVectorAgeHours(epoch);
  const freshness = svFreshness(ageHours, orbitRegime);
  return { ageHours, freshness, explanation: EXPLANATION[freshness] };
}

/** Compact chip for a catalog row: "27d", tinted by freshness. */
export function SVEpochBadge({
  epoch,
  orbitRegime,
}: {
  epoch: string;
  orbitRegime: string | undefined;
}) {
  const { ageHours, freshness, explanation } = svEpochInfo(epoch, orbitRegime);
  if (ageHours == null) return null;
  const tone = TONE[freshness];

  return (
    <span
      className="mono shrink-0"
      title={
        `State vector epoch ${new Date(epoch).toISOString().replace(".000", "")}` +
        (explanation ? ` — ${explanation}` : "")
      }
      style={{
        fontSize: 9,
        lineHeight: "13px",
        padding: "0 4px",
        borderRadius: 2,
        color: tone.color,
        border: `1px solid ${tone.border}`,
        background: tone.background,
        fontWeight: freshness === "fresh" ? 400 : 600,
      }}
    >
      {formatAge(Math.max(0, ageHours))}
    </span>
  );
}

/**
 * Fuller readout for a detail pane, with the warning spelled out. The catalog
 * column renders on the paper panel and the sky-canvas sheet on the dark one,
 * so the muted text colour is palette-dependent; the freshness tints read on
 * both.
 */
export function SVEpochNotice({
  epoch,
  orbitRegime,
  palette = "panel",
}: {
  epoch: string;
  orbitRegime: string | undefined;
  palette?: "panel" | "paper";
}) {
  const { ageHours, freshness, explanation } = svEpochInfo(epoch, orbitRegime);
  if (ageHours == null) return null;
  const tone = TONE[freshness];
  const dim = palette === "paper" ? "var(--color-paper-dim)" : "var(--color-text-dim)";
  const idleBorder =
    palette === "paper" ? "var(--color-brass-dim)" : "var(--color-panel-border)";

  return (
    <div
      className="text-xs"
      style={{
        marginBottom: 10,
        padding: "6px 8px",
        borderRadius: 4,
        border: `1px solid ${freshness === "fresh" ? idleBorder : tone.border}`,
        background: freshness === "fresh" ? "transparent" : tone.background,
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span style={{ color: dim }}>State vector epoch</span>
        <span className="mono" style={{ color: tone.color, fontWeight: 600 }}>
          {formatAge(Math.max(0, ageHours))} old
        </span>
      </div>
      <div className="mono" style={{ color: dim, fontSize: 10, marginTop: 2 }}>
        {new Date(epoch).toISOString().replace(".000", "")}
      </div>
      {explanation && (
        <div style={{ color: tone.color, marginTop: 5, lineHeight: 1.4 }}>
          {explanation}
        </div>
      )}
    </div>
  );
}
