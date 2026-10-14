"use client";

import { useMemo, useState } from "react";
import { Empty, ErrorBanner, Loading, PageHead } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { UsageList } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { dayKey, fillDays, totalsByDay } from "@/lib/usage";
import { UsageChart } from "./usage-chart";

const RANGES = [7, 30, 90, 365];

export function UsageView() {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useApi<UsageList>("/v1/usage", { days });
  const rows = useMemo(() => data?.usage ?? [], [data]);

  const perDay = useMemo(() => {
    const totals = totalsByDay(rows);
    if (totals.length === 0) return totals;
    const to = totals[totals.length - 1]!.day;
    const from = dayKey(new Date(Date.parse(`${to}T00:00:00Z`) - (Math.min(days, 90) - 1) * 86_400_000).toISOString());
    return fillDays(totals, from < totals[0]!.day ? from : totals[0]!.day, to);
  }, [rows, days]);

  const sum = useMemo(
    () =>
      rows.reduce(
        (a, r) => ({
          input: a.input + r.input_tokens,
          output: a.output + r.output_tokens,
          cache: a.cache + r.cache_read_tokens,
          runs: a.runs + r.runs,
          tools: a.tools + r.tool_calls,
          sandbox: a.sandbox + r.sandbox_seconds,
        }),
        { input: 0, output: 0, cache: 0, runs: 0, tools: 0, sandbox: 0 },
      ),
    [rows],
  );

  const sortedRows = useMemo(() => [...rows].sort((a, b) => b.day.localeCompare(a.day) || (a.model ?? "").localeCompare(b.model ?? "")), [rows]);

  return (
    <>
      <PageHead
        title="Usage"
        description="Tokens, runs, tool calls and sandbox time recorded for this project."
        actions={
          <>
            <label htmlFor="usage-range" className="small">
              Range
            </label>
            <select id="usage-range" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {RANGES.map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </select>
          </>
        }
      />
      <ErrorBanner error={error} onRetry={reload} />
      {!data && loading ? (
        <Loading />
      ) : data && rows.length === 0 ? (
        <Empty>No usage recorded in the last {days} days.</Empty>
      ) : data ? (
        <>
          <div className="stat-row">
            <Stat label="Input tokens" value={sum.input} />
            <Stat label="Output tokens" value={sum.output} />
            <Stat label="Cache read tokens" value={sum.cache} />
            <Stat label="Runs" value={sum.runs} />
            <Stat label="Tool calls" value={sum.tools} />
            <Stat label="Sandbox minutes" value={Math.round(sum.sandbox / 60)} />
          </div>
          <section className="card" aria-labelledby="usage-chart-h">
            <h2 id="usage-chart-h">Tokens per day</h2>
            <UsageChart days={perDay} />
          </section>
          <section aria-labelledby="usage-table-h">
            <h2 id="usage-table-h">By day and model</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Model</th>
                    <th scope="col" className="num">Input</th>
                    <th scope="col" className="num">Output</th>
                    <th scope="col" className="num">Cache read</th>
                    <th scope="col" className="num">Cache write</th>
                    <th scope="col" className="num">Runs</th>
                    <th scope="col" className="num">Tool calls</th>
                    <th scope="col" className="num">Sandbox s</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r, i) => (
                    <tr key={`${r.day}-${r.model}-${i}`}>
                      <td className="nowrap">{dayKey(r.day)}</td>
                      <td className="mono">{r.model ?? "–"}</td>
                      <td className="num">{formatNumber(r.input_tokens)}</td>
                      <td className="num">{formatNumber(r.output_tokens)}</td>
                      <td className="num">{formatNumber(r.cache_read_tokens)}</td>
                      <td className="num">{formatNumber(r.cache_write_tokens)}</td>
                      <td className="num">{formatNumber(r.runs)}</td>
                      <td className="num">{formatNumber(r.tool_calls)}</td>
                      <td className="num">{formatNumber(Math.round(r.sandbox_seconds))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{formatNumber(value)}</div>
    </div>
  );
}
