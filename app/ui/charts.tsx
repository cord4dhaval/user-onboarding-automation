"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Charts drawn as plain SVG against the console's own tokens.
 *
 * A charting library would bring its own type scale, its own colours and 40kB to draw a
 * fourteen-bar column chart. These read the same custom properties as everything else, so
 * the theme toggle moves them too, and the marks follow one spec: thin, rounded only at
 * the data end, a 2px surface gap between neighbours, and a label only where a label earns
 * its place.
 *
 * Series colour is a single validated hue (--viz-1) — one series never needs a legend, and
 * the status hues stay reserved for status.
 */

/** Real pixels rather than a stretched viewBox: a scaled viewBox distorts the type with it. */
function useWidth<T extends HTMLElement>(fallback = 520) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

/** A bar with square feet on the baseline and a rounded head, per the mark spec. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const radius = Math.min(r, w / 2, h);
  return [
    `M${x},${y + h}`,
    `V${y + radius}`,
    `A${radius},${radius} 0 0 1 ${x + radius},${y}`,
    `H${x + w - radius}`,
    `A${radius},${radius} 0 0 1 ${x + w},${y + radius}`,
    `V${y + h}`,
    "Z",
  ].join(" ");
}

export interface Point {
  label: string;
  value: number;
}

/**
 * Volume over time. One series, so no legend — the title names it — and only the peak is
 * labelled, because a number over every bar is a table wearing a chart's clothes.
 */
export function BarChart({
  data,
  height = 150,
  unit = "",
  emptyNote = "Nothing yet in this window.",
}: {
  data: Point[];
  height?: number;
  unit?: string;
  emptyNote?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const max = Math.max(1, ...data.map((d) => d.value));
  const peak = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? 0) ? i : best), 0);
  const allZero = data.every((d) => d.value === 0);

  const padTop = 20;
  const padBottom = 22;
  const plot = height - padTop - padBottom;
  const slot = data.length ? width / data.length : width;
  const gap = 2;
  const barW = Math.max(3, Math.min(34, slot - gap * 2));

  return (
    <div className="viz" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={`${data.length} day history`}>
        {/* One recessive rule at the top of the scale — enough to read height against. */}
        <line x1={0} y1={padTop} x2={width} y2={padTop} className="viz-grid" />
        <line x1={0} y1={padTop + plot} x2={width} y2={padTop + plot} className="viz-axis" />

        {data.map((d, i) => {
          const h = allZero ? 0 : Math.max(d.value > 0 ? 3 : 0, (d.value / max) * plot);
          const x = i * slot + (slot - barW) / 2;
          const y = padTop + plot - h;

          return (
            <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* The hit target is the whole column, not the three pixels of bar in it. */}
              <rect x={i * slot} y={0} width={slot} height={height} fill="transparent" />
              {h > 0 && (
                <path
                  d={barPath(x, y, barW, h)}
                  className={hover === i ? "viz-bar on" : "viz-bar"}
                />
              )}
              {i === peak && !allZero && (
                <text x={x + barW / 2} y={y - 7} className="viz-peak" textAnchor="middle">
                  {d.value}{unit}
                </text>
              )}
            </g>
          );
        })}

        {/* First and last day only. Fourteen date labels is a wall of grey. */}
        {data.length > 0 && (
          <>
            <text x={0} y={height - 6} className="viz-tick">{data[0]?.label}</text>
            <text x={width} y={height - 6} className="viz-tick" textAnchor="end">
              {data[data.length - 1]?.label}
            </text>
          </>
        )}
      </svg>

      {hover !== null && (
        <div
          className="viz-tip"
          style={{ left: Math.min(Math.max(hover * slot + slot / 2, 60), width - 60) }}
        >
          <strong>{data[hover]?.value}{unit}</strong> · {data[hover]?.label}
        </div>
      )}

      {allZero && <p className="viz-empty">{emptyNote}</p>}
    </div>
  );
}

/** The shape of a tile's recent history. No axes, no labels — it is a texture, not a plot. */
export function Sparkline({ data, height = 30 }: { data: number[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>(120);
  if (data.length < 2) return <div className="spark" ref={ref} />;

  const max = Math.max(1, ...data);
  const step = width / (data.length - 1);
  const y = (v: number) => height - 3 - (v / max) * (height - 8);
  const last = data[data.length - 1] ?? 0;
  const line = data.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const lastX = (data.length - 1) * step;

  return (
    <div className="spark" ref={ref}>
      <svg width={width} height={height} aria-hidden="true">
        <path d={area} className="spark-area" />
        <path d={line} className="spark-line" />
        <circle cx={lastX - 1.5} cy={y(last)} r={2.5} className="spark-dot" />
      </svg>
    </div>
  );
}

export interface Stage {
  label: string;
  value: number;
  hint?: string;
}

/**
 * An ordinal funnel: one hue, light to dark, because the stages are ordered rather than
 * merely different. Every bar is directly labelled, so nothing rests on colour alone.
 */
export function Funnel({ stages }: { stages: Stage[] }) {
  const max = Math.max(1, ...stages.map((s) => s.value));

  return (
    <ol className="funnel">
      {stages.map((s, i) => (
        <li key={s.label}>
          <span className="funnel-label">
            {s.label}
            {s.hint && <span className="funnel-hint">{s.hint}</span>}
          </span>
          <span className="funnel-track">
            <span
              className="funnel-fill"
              style={{
                width: `${Math.max(s.value > 0 ? 2 : 0, (s.value / max) * 100)}%`,
                // Ordinal ramp, stepped so the lightest still clears the surface.
                background: `var(--viz-step-${Math.min(i + 1, 4)})`,
              }}
            />
          </span>
          <span className="funnel-value num">{s.value}</span>
        </li>
      ))}
    </ol>
  );
}
