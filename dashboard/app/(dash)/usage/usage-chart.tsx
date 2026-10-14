"use client";

import { useEffect, useRef, useState } from "react";
import { compactNumber, formatNumber } from "@/lib/format";
import { niceMax, type DayTotals } from "@/lib/usage";

const H = 260;

/** A bar with only its top (data end) corners rounded. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}
const M = { top: 12, right: 8, bottom: 28, left: 48 };
const GAP = 2; // surface gap between stacked segments

/** Stacked bars (input + output tokens) per day in inline SVG, with a hover/focus readout. */
export function UsageChart({ days }: { days: DayTotals[] }) {
  const [active, setActive] = useState<number | null>(null);
  // Draw at the container's real width so text and marks are never scaled.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(760);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setW(Math.max(280, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const totals = days.map((d) => d.input_tokens + d.output_tokens);
  const max = niceMax(Math.max(0, ...totals));
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const step = plotW / Math.max(days.length, 1);
  const barW = Math.max(2, Math.min(28, step * 0.7));
  const y = (v: number) => M.top + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(plotW / 70)));
  const shown = active !== null ? days[active] : undefined;

  return (
    <figure style={{ margin: 0 }}>
      <div className="legend" aria-hidden="true">
        <span>
          <span className="swatch" style={{ background: "var(--series-1)" }} />
          Input tokens
        </span>
        <span>
          <span className="swatch" style={{ background: "var(--series-2)" }} />
          Output tokens
        </span>
      </div>
      <div ref={box}>
        <svg
          className="chart"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="group"
          aria-label={`Tokens per day over ${days.length} days, input and output stacked. The table below lists the values.`}
          onMouseLeave={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="gridline" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
              <text className="axis-label" x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
                {compactNumber(t)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const cx = M.left + step * i + step / 2;
            const x = cx - barW / 2;
            const inH = (d.input_tokens / max) * plotH;
            const outH = (d.output_tokens / max) * plotH;
            const base = M.top + plotH;
            const outGap = inH > 0 && outH > 0 ? GAP : 0;
            const r = Math.min(4, barW / 2);
            return (
              <g
                key={d.day}
                tabIndex={0}
                role="img"
                aria-label={`${d.day}: ${formatNumber(d.input_tokens)} input, ${formatNumber(d.output_tokens)} output tokens`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                style={{ outline: "none" }}
              >
                <rect x={M.left + step * i} y={M.top} width={step} height={plotH} fill={active === i ? "var(--surface-2)" : "transparent"} />
                {inH > 0 ? (
                  outH > 0 ? (
                    <rect className="bar-in" x={x} y={base - inH} width={barW} height={inH} />
                  ) : (
                    <path className="bar-in" d={topRounded(x, base - inH, barW, inH, r)} />
                  )
                ) : null}
                {outH > 0 ? <path className="bar-out" d={topRounded(x, base - inH - outGap - outH, barW, outH, r)} /> : null}
                {i % labelEvery === 0 ? (
                  <text className="axis-label" x={cx} y={H - 8} textAnchor="middle">
                    {d.day.slice(5)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="small muted" aria-live="polite" style={{ minHeight: "1.5em" }}>
        {shown ? (
          <>
            <strong style={{ color: "var(--text)" }}>{shown.day}</strong> · input {formatNumber(shown.input_tokens)} · output {formatNumber(shown.output_tokens)} · cache read{" "}
            {formatNumber(shown.cache_read_tokens)} · {formatNumber(shown.runs)} runs
          </>
        ) : (
          "Hover or focus a bar for that day's numbers."
        )}
      </figcaption>
    </figure>
  );
}
