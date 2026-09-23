import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { VCurveSample } from "./vcurveData";

/**
 * Interactive V-curve plot: focuser position (x) against measured FWHM in
 * arcsec (y), with the fitted parabola overlaid and a Grafana-style crosshair
 * that reads out values under the cursor.
 *
 * Hand-rolled SVG rather than a charting library: one series of ~9 points and
 * a smooth curve needs no chart engine, and this way the plot inherits the
 * app's theme tokens, stays in the offline bundle, and gives exact control
 * over the crosshair behaviour.
 */

const HEIGHT = 210;
const M = { top: 12, right: 14, bottom: 26, left: 48 };
/** Cursor distance (px) within which the crosshair snaps to a measured point. */
const SNAP_PX = 22;
/** Deepest zoom, as a factor on the auto-fitted x range. */
const MAX_ZOOM = 40;

export interface VCurveFit {
  /** FWHM² = a·(p − p_opt)² + b, in arcsec². */
  a: number;
  pOpt: number;
  /** Best FWHM [arcsec] — sqrt(b). */
  bestFwhm: number;
}

export function VCurvePlot({
  points,
  fit,
  bestPosition,
  span,
}: {
  points: VCurveSample[];
  fit: VCurveFit | null;
  /** SensorKit's published best focus, if it differs from the local fit vertex. */
  bestPosition: number | null;
  /**
   * Focuser range the sweep was commanded over. Keeps the view on the whole
   * sweep while its points trickle in — without it the first frame or two
   * would set a hairline domain and the vertex would sit off at one edge.
   */
  span: { lo: number; hi: number } | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  // X-axis zoom: `k` shrinks the domain, `cx` is the focus position it stays
  // centred on. Reset with a double-click.
  const [zoom, setZoom] = useState<{ k: number; cx: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Native listener because React attaches wheel passively, and a passive
  // handler cannot preventDefault the page scroll / browser pinch-zoom.
  // A trackpad pinch arrives here too, as a wheel event with ctrlKey set.
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();
  const domainRef = useRef({ x0: 0, x1: 1 });
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const w = rect.width - M.left - M.right;
      if (w <= 0) return;
      const { x0, x1 } = domainRef.current;
      // Keep the focus position under the pointer pinned while zooming.
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - M.left) / w));
      const at = x0 + frac * (x1 - x0);
      setZoom((z) => {
        const k = Math.min(MAX_ZOOM, Math.max(1, (z?.k ?? 1) * Math.exp(-e.deltaY * 0.002)));
        if (k === 1) return null; // fully zoomed out -> back to the auto domain
        const cx = at - (at - (z?.cx ?? at)) * ((z?.k ?? 1) / k);
        return { k, cx };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // Re-runs on `width`: the <svg> only mounts once ResizeObserver reports a
    // width, so a mount-only effect would find no element to listen on.
  }, [width]);

  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = HEIGHT - M.top - M.bottom;

  const domain = useMemo(() => {
    const base = computeDomain(points, fit, bestPosition, span);
    if (!zoom) return base;
    const half = (base.x1 - base.x0) / (2 * zoom.k);
    return { ...base, x0: zoom.cx - half, x1: zoom.cx + half };
  }, [points, fit, bestPosition, span, zoom]);
  domainRef.current = domain;

  const sx = (p: number) =>
    M.left + ((p - domain.x0) / (domain.x1 - domain.x0)) * plotW;
  const sy = (f: number) =>
    M.top + plotH - ((f - domain.y0) / (domain.y1 - domain.y0)) * plotH;

  // Fitted curve, sampled across the visible x range.
  const curvePath = useMemo(() => {
    if (!fit || plotW <= 0) return null;
    const steps = 100;
    const pts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const p = domain.x0 + ((domain.x1 - domain.x0) * i) / steps;
      const sq = fit.a * (p - fit.pOpt) ** 2 + fit.bestFwhm ** 2;
      if (sq <= 0) continue;
      pts.push(`${i === 0 ? "M" : "L"}${sx(p).toFixed(1)},${sy(Math.sqrt(sq)).toFixed(1)}`);
    }
    return pts.join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, domain, plotW, plotH, width]);

  const xTicks = useMemo(() => niceTicks(domain.x0, domain.x1, 5), [domain]);
  const yTicks = useMemo(() => niceTicks(domain.y0, domain.y1, 4), [domain]);

  // Crosshair readout: snap to the nearest measured point when the cursor is
  // close to one, otherwise track the fitted curve at the cursor's position.
  const readout = useMemo(() => {
    if (!cursor || plotW <= 0) return null;
    const position = domain.x0 + ((cursor.x - M.left) / plotW) * (domain.x1 - domain.x0);

    let nearest: VCurveSample | null = null;
    let nearestDist = Infinity;
    for (const p of points) {
      const d = Math.hypot(sx(p.position) - cursor.x, sy(p.fwhmArcsec) - cursor.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = p;
      }
    }
    if (nearest && nearestDist <= SNAP_PX) {
      return {
        position: nearest.position,
        fwhm: nearest.fwhmArcsec,
        measured: true,
        px: sx(nearest.position),
        py: sy(nearest.fwhmArcsec),
      };
    }
    if (fit) {
      const sq = fit.a * (position - fit.pOpt) ** 2 + fit.bestFwhm ** 2;
      const fwhm = Math.sqrt(Math.max(sq, 0));
      return { position, fwhm, measured: false, px: sx(position), py: sy(fwhm) };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, points, fit, domain, plotW, plotH, width]);

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < M.left || x > M.left + plotW || y < M.top || y > M.top + plotH) {
      setCursor(null);
      return;
    }
    setCursor({ x, y });
  };

  const vertexX = fit ? sx(fit.pOpt) : bestPosition != null ? sx(bestPosition) : null;

  return (
    <div ref={wrapRef} className="w-full min-w-0">
      {width > 0 && (
        <svg
          ref={svgRef}
          width={width}
          height={HEIGHT}
          className="touch-pan-y select-none"
          style={{ cursor: "crosshair" }}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setCursor(null)}
          onPointerCancel={() => setCursor(null)}
          onDoubleClick={() => setZoom(null)}
        >
          {/* Everything data-driven is clipped to the plot box, so zooming in
              doesn't paint points or curve arms over the axes. */}
          <clipPath id={clipId}>
            <rect x={M.left} y={M.top} width={plotW} height={plotH} />
          </clipPath>

          {/* Plot frame */}
          <rect
            x={M.left}
            y={M.top}
            width={plotW}
            height={plotH}
            fill="rgba(0,0,0,0.30)"
            stroke="currentColor"
            className="text-panel-border"
            strokeWidth={1}
          />

          {/* Grid + ticks */}
          {xTicks.map((t) => (
            <g key={`x${t}`}>
              <line
                x1={sx(t)}
                x2={sx(t)}
                y1={M.top}
                y2={M.top + plotH}
                stroke="rgba(255,255,255,0.07)"
              />
              <text
                x={sx(t)}
                y={M.top + plotH + 15}
                textAnchor="middle"
                className="fill-text-dim font-mono"
                fontSize={9}
              >
                {fmtPos(t)}
              </text>
            </g>
          ))}
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={M.left}
                x2={M.left + plotW}
                y1={sy(t)}
                y2={sy(t)}
                stroke="rgba(255,255,255,0.07)"
              />
              <text
                x={M.left - 6}
                y={sy(t) + 3}
                textAnchor="end"
                className="fill-text-dim font-mono"
                fontSize={9}
              >
                {t.toFixed(1)}
              </text>
            </g>
          ))}

          {/* Axis titles */}
          <text
            x={M.left + plotW / 2}
            y={HEIGHT - 1}
            textAnchor="middle"
            className="fill-text-dim"
            fontSize={9}
          >
            Focus Position
          </text>
          <text
            x={-(M.top + plotH / 2)}
            y={10}
            transform="rotate(-90)"
            textAnchor="middle"
            className="fill-text-dim"
            fontSize={9}
          >
            FWHM (arcsec)
          </text>

          <g clipPath={`url(#${clipId})`}>
          {/* Best-focus marker */}
          {vertexX !== null && (
            <line
              x1={vertexX}
              x2={vertexX}
              y1={M.top}
              y2={M.top + plotH}
              stroke="rgb(253,186,116)"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.8}
            />
          )}

          {/* Fitted curve */}
          {curvePath && (
            <path
              d={curvePath}
              fill="none"
              stroke="rgb(103,232,249)"
              strokeWidth={1.5}
              opacity={0.75}
            />
          )}

          {/* Measured points */}
          {points.map((p) => (
            <circle
              key={p.position}
              cx={sx(p.position)}
              cy={sy(p.fwhmArcsec)}
              r={3}
              fill="rgb(103,232,249)"
              stroke="rgba(0,0,0,0.6)"
              strokeWidth={1}
            />
          ))}
          </g>

          {/* Crosshair */}
          {cursor && readout && (
            <g pointerEvents="none">
              <line
                x1={readout.px}
                x2={readout.px}
                y1={M.top}
                y2={M.top + plotH}
                stroke="rgba(255,255,255,0.35)"
                strokeDasharray="2 2"
              />
              <line
                x1={M.left}
                x2={M.left + plotW}
                y1={readout.py}
                y2={readout.py}
                stroke="rgba(255,255,255,0.35)"
                strokeDasharray="2 2"
              />
              <circle
                cx={readout.px}
                cy={readout.py}
                r={readout.measured ? 5 : 3}
                fill="none"
                stroke="rgb(253,186,116)"
                strokeWidth={1.5}
              />
              <Tooltip
                x={readout.px}
                y={readout.py}
                plotRight={M.left + plotW}
                position={readout.position}
                fwhm={readout.fwhm}
                measured={readout.measured}
              />
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

function Tooltip({
  x,
  y,
  plotRight,
  position,
  fwhm,
  measured,
}: {
  x: number;
  y: number;
  plotRight: number;
  position: number;
  fwhm: number;
  measured: boolean;
}) {
  const w = 116;
  const h = 30;
  // Flip to the cursor's left when the box would overflow the plot area.
  const left = x + 10 + w > plotRight ? x - 10 - w : x + 10;
  const top = Math.max(M.top, y - h - 8);
  return (
    <g transform={`translate(${left},${top})`}>
      <rect
        width={w}
        height={h}
        rx={3}
        fill="rgba(13,17,23,0.95)"
        stroke={measured ? "rgb(253,186,116)" : "rgba(255,255,255,0.25)"}
      />
      <text x={6} y={12} className="fill-text-bright font-mono" fontSize={9}>
        {fmtPos(position)} steps
      </text>
      <text x={6} y={23} className="fill-text-bright font-mono" fontSize={9}>
        {fwhm.toFixed(2)}&quot;
        <tspan className="fill-text-dim"> {measured ? "measured" : "fit"}</tspan>
      </text>
    </g>
  );
}

// === Scales ===

function computeDomain(
  points: VCurveSample[],
  fit: VCurveFit | null,
  bestPosition: number | null,
  span: { lo: number; hi: number } | null,
) {
  const xs = points.map((p) => p.position);
  const ys = points.map((p) => p.fwhmArcsec);
  if (fit) xs.push(fit.pOpt);
  if (bestPosition != null) xs.push(bestPosition);
  if (span) xs.push(span.lo, span.hi);

  // No samples and no commanded span: the fit alone sets the view, so show
  // enough either side of the vertex for the parabola to open up.
  if (xs.length === 0 && fit) {
    xs.push(fit.pOpt - 200, fit.pOpt + 200);
  }
  if (xs.length === 0) return { x0: 0, x1: 1, y0: 0, y1: 1 };

  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (x1 - x0 < 1) {
    x0 -= 50;
    x1 += 50;
  }
  const xPad = (x1 - x0) * 0.08;
  x0 -= xPad;
  x1 += xPad;

  if (fit) {
    // Include the curve's own range so it never clips out of view.
    for (const p of [x0, x1]) {
      const sq = fit.a * (p - fit.pOpt) ** 2 + fit.bestFwhm ** 2;
      if (sq > 0) ys.push(Math.sqrt(sq));
    }
    ys.push(fit.bestFwhm);
  }
  if (ys.length === 0) return { x0, x1, y0: 0, y1: 1 };

  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (y1 - y0 < 0.2) {
    y0 -= 0.1;
    y1 += 0.1;
  }
  const yPad = (y1 - y0) * 0.12;
  return { x0, x1, y0: Math.max(0, y0 - yPad), y1: y1 + yPad };
}

/** Tick values at 1/2/5×10ⁿ steps covering [lo, hi]. */
function niceTicks(lo: number, hi: number, target: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    ticks.push(Number(t.toFixed(6)));
    if (ticks.length > 12) break;
  }
  return ticks;
}

function fmtPos(p: number): string {
  return Math.abs(p) >= 1000 ? p.toFixed(0) : p.toFixed(1);
}
