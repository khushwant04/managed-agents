/** Usage page rollups: per-model breakdown, period totals and CSV export. */
import type { UsageRow } from "./api";
import { dayKey } from "./usage";

export const UNKNOWN_MODEL = "unknown";

export const modelOf = (r: UsageRow): string => r.model || UNKNOWN_MODEL;

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  runs: number;
  toolCalls: number;
  sandboxSeconds: number;
  /** input + output */
  tokens: number;
  /** Share of prompt tokens served from cache: cacheRead / (input + cacheRead). */
  cacheHitRate: number;
}

export function sumUsage(rows: readonly UsageRow[]): UsageTotals {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, runs = 0, toolCalls = 0, sandboxSeconds = 0;
  for (const r of rows) {
    input += r.input_tokens;
    output += r.output_tokens;
    cacheRead += r.cache_read_tokens;
    cacheWrite += r.cache_write_tokens;
    runs += r.runs;
    toolCalls += r.tool_calls;
    sandboxSeconds += r.sandbox_seconds;
  }
  const prompt = input + cacheRead;
  return { input, output, cacheRead, cacheWrite, runs, toolCalls, sandboxSeconds, tokens: input + output, cacheHitRate: prompt > 0 ? cacheRead / prompt : 0 };
}

export interface ModelShare extends UsageTotals {
  model: string;
  /** Share of all tokens (input + output) in the rows, 0..1. */
  share: number;
}

/** Totals per model, largest token volume first. */
export function byModel(rows: readonly UsageRow[]): ModelShare[] {
  const groups = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const m = modelOf(r);
    const g = groups.get(m);
    if (g) g.push(r);
    else groups.set(m, [r]);
  }
  const all = sumUsage(rows).tokens;
  return [...groups.entries()]
    .map(([model, g]) => {
      const t = sumUsage(g);
      return { model, ...t, share: all > 0 ? t.tokens / all : 0 };
    })
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
}

/** The UTC day `days - 1` days before `to` (YYYY-MM-DD), so [from, to] spans `days` days. */
export function rangeStart(to: string, days: number): string {
  return new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

const CSV_COLUMNS = [
  "day",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "runs",
  "tool_calls",
  "sandbox_seconds",
] as const;

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One line per (day, model), newest day first, with a header row. */
export function usageCsv(rows: readonly UsageRow[]): string {
  const sorted = [...rows].sort((a, b) => dayKey(b.day).localeCompare(dayKey(a.day)) || modelOf(a).localeCompare(modelOf(b)));
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of sorted) {
    lines.push(
      [
        dayKey(r.day),
        r.model ?? "",
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        r.cache_write_tokens,
        r.runs,
        r.tool_calls,
        Math.round(r.sandbox_seconds * 1000) / 1000,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
