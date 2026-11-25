import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FocusSweep } from "./focusSweepData";

/** Measured FWHM in pixels, with the provider's focus estimate or boundary. */
export function FocusSweepPlot({ sweep }: { sweep: FocusSweep }) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<{ center: number; factor: number } | null>(
    null,
  );
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const clip = useId();
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0]?.contentRect.width ?? 0),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setZoom(null);
    setHovered(null);
    setSelected(null);
  }, [sweep.id]);
  const samples = Object.values(sweep.samples).sort(
    (a, b) => a.sweep.sample_index - b.sweep.sample_index,
  );
  const measured = samples.filter(
    (s) => s.valid && s.median_fwhm_pixels !== null,
  );
  const position = sweep.analysis?.position;
  const domain = useMemo(() => {
    const all = Object.values(sweep.samples);
    const xs = all.map((s) => s.sweep.commanded_position);
    const first = all[0];
    const task = sweep.execution?.execution.task;
    if (first && task) {
      const low =
        first.sweep.commanded_position - first.sweep.sample_index * task.step;
      xs.push(low, low + (task.count - 1) * task.step);
    }
    if (position != null) xs.push(position);
    const low = xs.length ? Math.min(...xs) : 0;
    const high = xs.length ? Math.max(...xs) : 1;
    const pad = Math.max((high - low) * 0.08, 1);
    const ys = all
      .filter((s) => s.valid && s.median_fwhm_pixels !== null)
      .map((s) => s.median_fwhm_pixels!);
    const yLow = ys.length ? Math.min(...ys) : 0;
    const yHigh = ys.length ? Math.max(...ys) : 1;
    const yPad = Math.max((yHigh - yLow) * 0.15, 0.2);
    return {
      low: low - pad,
      high: high + pad,
      yLow: Math.max(0, yLow - yPad),
      yHigh: yHigh + yPad,
    };
  }, [sweep.samples, sweep.execution, position]);
  const left = 40,
    right = 14,
    top = 20,
    bottom = 186;
  const span = (domain.high - domain.low) / (zoom?.factor ?? 1);
  const center = zoom?.center ?? (domain.low + domain.high) / 2;
  const low = center - span / 2;
  const x = (value: number) =>
    left + ((value - low) / span) * (width - left - right);
  const y = (value: number) =>
    bottom -
    ((value - domain.yLow) / (domain.yHigh - domain.yLow)) * (bottom - top);
  const active =
    (hovered ?? selected) === null
      ? null
      : measured.find((s) => s.sweep.sample_index === (hovered ?? selected));
  const selectedSample = measured.find(
    (s) => s.sweep.sample_index === selected,
  );
  useEffect(() => {
    const node = plot.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!Object.keys(sweep.samples).length) return;
      event.preventDefault();
      const fraction = Math.max(
        0,
        Math.min(
          1,
          (event.clientX - node.getBoundingClientRect().left - left) /
            (width - left - right),
        ),
      );
      const factor = Math.max(
        1,
        Math.min(40, (zoom?.factor ?? 1) * Math.exp(-event.deltaY * 0.002)),
      );
      const anchor = low + fraction * span;
      setZoom(
        factor === 1
          ? null
          : {
              factor,
              center:
                anchor +
                ((0.5 - fraction) * (domain.high - domain.low)) / factor,
            },
      );
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [width, zoom, low, span, domain.high, domain.low, sweep.samples]);
  return (
    <div ref={container} className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-dim">
        <span>Median FWHM (pixels)</span>
        <div className="flex gap-1">
          <button
            type="button"
            className="px-2 py-1 border border-panel-border rounded disabled:opacity-40"
            aria-label="Zoom in on sweep"
            disabled={!samples.length}
            onClick={() =>
              setZoom({
                center:
                  selectedSample?.sweep.commanded_position ??
                  active?.sweep.commanded_position ??
                  position ??
                  center,
                factor: Math.min(40, (zoom?.factor ?? 1) * 2),
              })
            }
          >
            +
          </button>
          <button
            type="button"
            className="px-2 py-1 border border-panel-border rounded disabled:opacity-40"
            aria-label="Pan toward lower focus positions"
            disabled={!zoom}
            onClick={() =>
              setZoom({ center: center - span / 3, factor: zoom!.factor })
            }
          >
            ←
          </button>
          <button
            type="button"
            className="px-2 py-1 border border-panel-border rounded disabled:opacity-40"
            aria-label="Pan toward higher focus positions"
            disabled={!zoom}
            onClick={() =>
              setZoom({ center: center + span / 3, factor: zoom!.factor })
            }
          >
            →
          </button>
          <button
            type="button"
            className="px-2 py-1 border border-panel-border rounded disabled:opacity-40"
            aria-label="Reset sweep zoom"
            disabled={!zoom}
            onClick={() => setZoom(null)}
          >
            Reset zoom
          </button>
        </div>
      </div>
      {width > 0 && (
        <svg
          ref={plot}
          width="100%"
          height="220"
          viewBox={`0 0 ${width} 220`}
          role="group"
          aria-label="Commanded focus position against median FWHM in pixels"
          onPointerLeave={() => setHovered(null)}
          onDoubleClick={() => setZoom(null)}
        >
          <defs>
            <clipPath id={clip}>
              <rect
                x={left}
                y={top}
                width={Math.max(0, width - left - right)}
                height={bottom - top}
              />
            </clipPath>
          </defs>
          {[0, 0.5, 1].map((f) => {
            const value = domain.yLow + f * (domain.yHigh - domain.yLow);
            return (
              <g key={f}>
                <line
                  x1={left}
                  x2={width - right}
                  y1={y(value)}
                  y2={y(value)}
                  className="stroke-panel-border"
                />
                <text
                  x={left - 7}
                  y={y(value) + 4}
                  textAnchor="end"
                  fontSize={11}
                  className="fill-text-dim"
                >
                  {value.toFixed(1)}
                </text>
              </g>
            );
          })}
          {(width < 360 ? [0, 1] : [0, 0.5, 1]).map((f) => (
            <text
              key={f}
              x={left + f * (width - left - right)}
              y={bottom + 17}
              textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}
              fontSize={11}
              className="fill-text-dim"
            >
              {(low + span * f).toLocaleString(undefined, {
                maximumFractionDigits: 1,
              })}
            </text>
          ))}
          <g clipPath={`url(#${clip})`}>
            {position != null && (
              <line
                x1={x(position)}
                x2={x(position)}
                y1={top}
                y2={bottom}
                className="stroke-orange-300"
                strokeDasharray="4 4"
              />
            )}
            {samples
              .filter((s) => !s.valid)
              .map((s) => (
                <text
                  key={s.sweep.sample_index}
                  x={x(s.sweep.commanded_position)}
                  y={bottom - 7}
                  textAnchor="middle"
                  className="fill-orange-300"
                  fontSize={14}
                >
                  <title>{s.reason ?? "Invalid measurement"}</title>×
                </text>
              ))}
            {measured.map((s) => (
              <circle
                key={s.sweep.sample_index}
                cx={x(s.sweep.commanded_position)}
                cy={y(s.median_fwhm_pixels!)}
                r={active?.sweep.sample_index === s.sweep.sample_index ? 6 : 4}
                className="fill-cyan-300"
                tabIndex={0}
                role="button"
                aria-label={`Sample ${s.sweep.sample_index + 1}: focus ${s.sweep.commanded_position}, FWHM ${s.median_fwhm_pixels} pixels`}
                onFocus={() => setSelected(s.sweep.sample_index)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelected(s.sweep.sample_index);
                  }
                }}
                onPointerEnter={() => setHovered(s.sweep.sample_index)}
                onClick={() => setSelected(s.sweep.sample_index)}
              >
                <title>{`Sample ${s.sweep.sample_index + 1}: commanded ${s.sweep.commanded_position}, reported ${s.reported_position ?? "unknown"}, FWHM ${s.median_fwhm_pixels} pixels`}</title>
              </circle>
            ))}
            {active && (
              <g pointerEvents="none">
                <line
                  x1={x(active.sweep.commanded_position)}
                  x2={x(active.sweep.commanded_position)}
                  y1={top}
                  y2={bottom}
                  className="stroke-text-dim"
                  strokeDasharray="2 3"
                />
                <line
                  x1={left}
                  x2={width - right}
                  y1={y(active.median_fwhm_pixels!)}
                  y2={y(active.median_fwhm_pixels!)}
                  className="stroke-text-dim"
                  strokeDasharray="2 3"
                />
              </g>
            )}
          </g>
          <text
            x={width / 2}
            y={218}
            textAnchor="middle"
            className="fill-text-dim"
            fontSize={11}
          >
            Commanded focus position
          </text>
        </svg>
      )}
      <div className="min-h-5 text-xs text-text-dim" aria-live="polite">
        {active
          ? `Sample ${active.sweep.sample_index + 1} · commanded ${active.sweep.commanded_position} · reported ${active.reported_position ?? "unknown"} · ${active.median_fwhm_pixels?.toFixed(2)} pixels`
          : !samples.length
            ? "Waiting for focus measurements."
            : "Select a point to inspect its measurement."}
      </div>
    </div>
  );
}
