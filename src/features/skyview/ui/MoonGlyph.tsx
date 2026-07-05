interface Props {
  size?: number;
  /** 0 new · 0.25 first quarter · 0.5 full · 0.75 last quarter */
  phase: number;
  /** Colour of the lit side of the disc. */
  color?: string;
  /** Background colour used to mask the shadow side — set to the surface the
   *  glyph sits on (e.g. paper on Almanac, ink on dark panels). */
  bg?: string;
}

/**
 * Moon-phase glyph. A filled disc with an elliptical-wedge shadow over the
 * unlit side, computed as a signed ellipse whose width is |cos(phase·2π)|·r.
 * Ported from the V4 handoff sandbox.
 */
export function MoonGlyph({
  size = 18,
  phase,
  color = "var(--color-moon)",
  bg = "var(--color-ink)",
}: Props) {
  const r = size / 2;
  const t = Math.cos(phase * Math.PI * 2);
  const waxing = phase < 0.5;
  const termRx = Math.abs(t) * r;

  const terminatorPath =
    phase < 0.5
      ? `M ${r} 0.5 A ${r - 0.5} ${r - 0.5} 0 0 0 ${r} ${size - 0.5} A ${termRx} ${r - 0.5} 0 0 ${waxing ? 1 : 0} ${r} 0.5 Z`
      : `M ${r} 0.5 A ${r - 0.5} ${r - 0.5} 0 0 1 ${r} ${size - 0.5} A ${termRx} ${r - 0.5} 0 0 ${waxing ? 0 : 1} ${r} 0.5 Z`;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
    >
      <circle
        cx={r}
        cy={r}
        r={r - 0.5}
        fill={color}
        stroke="var(--color-brass-dim)"
        strokeWidth="0.5"
      />
      <path d={terminatorPath} fill={bg} />
    </svg>
  );
}
