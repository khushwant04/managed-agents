/** Usage rollups for the usage page: per-day totals across models. */
import type { UsageRow } from "./api";

export interface DayTotals {
  /** YYYY-MM-DD (UTC). */
  day: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  runs: number;
  tool_calls: number;
  sandbox_seconds: number;
  models: string[];
}

export function dayKey(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}

/** Sum rows per day (all models), sorted oldest first. */
export function totalsByDay(rows: readonly UsageRow[]): DayTotals[] {
  const byDay = new Map<string, DayTotals>();
  for (const r of rows) {
    const day = dayKey(r.day);
    let t = byDay.get(day);
    if (!t) {
      t = { day, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, runs: 0, tool_calls: 0, sandbox_seconds: 0, models: [] };
      byDay.set(day, t);
    }
    t.input_tokens += r.input_tokens;
    t.output_tokens += r.output_tokens;
    t.cache_read_tokens += r.cache_read_tokens;
    t.cache_write_tokens += r.cache_write_tokens;
    t.runs += r.runs;
    t.tool_calls += r.tool_calls;
    t.sandbox_seconds += r.sandbox_seconds;
    if (r.model && !t.models.includes(r.model)) t.models.push(r.model);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Fill missing days in [from, to] with zero rows so the chart has a continuous axis. */
export function fillDays(days: readonly DayTotals[], from: string, to: string): DayTotals[] {
  const have = new Map(days.map((d) => [d.day, d]));
  const out: DayTotals[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [...days];
  for (let t = start; t <= end; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(
      have.get(day) ?? { day, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, runs: 0, tool_calls: 0, sandbox_seconds: 0, models: [] },
    );
  }
  return out;
}

/** A "nice" axis maximum (1, 2, 2.5 or 5 × 10^n) at or above `value`. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * base >= value) return m * base;
  }
  return 10 * base;
}
