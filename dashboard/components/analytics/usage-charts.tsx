"use client"

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { compactNumber } from "@/lib/format"
import type { DayTotals } from "@/lib/usage"

export function shortDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
}

function longDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}

const tokenConfig = {
  input_tokens: { label: "Input", color: "var(--chart-2)" },
  cache_read_tokens: { label: "Cache reads", color: "var(--chart-1)" },
  output_tokens: { label: "Output", color: "var(--foreground)" },
} satisfies ChartConfig

const STACK = ["input_tokens", "cache_read_tokens", "output_tokens"] as const

/** Stacked tokens per day: input, cached input and output. */
export function TokenBarChart({ data }: { data: DayTotals[] }) {
  const dense = data.length > 45
  return (
    <ChartContainer config={tokenConfig} className="aspect-auto h-72 w-full">
      <BarChart data={data} margin={{ left: 0, right: 4, top: 8 }} barCategoryGap={dense ? 1 : "22%"}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} />
        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => compactNumber(v)} />
        <ChartTooltip
          cursor={{ radius: 4 }}
          content={<ChartTooltipContent indicator="dot" labelFormatter={(v) => longDay(String(v))} />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        {STACK.map((k, i) => (
          <Bar
            key={k}
            dataKey={k}
            stackId="t"
            fill={`var(--color-${k})`}
            stroke="var(--card)"
            strokeWidth={dense ? 0.5 : 1}
            radius={i === STACK.length - 1 ? [4, 4, 0, 0] : 0}
            maxBarSize={36}
            animationDuration={700}
            animationEasing="ease-out"
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

const activityConfig = {
  runs: { label: "Runs", color: "var(--foreground)" },
  tool_calls: { label: "Tool calls", color: "var(--chart-2)" },
} satisfies ChartConfig

/** Runs (area) and tool calls (line) per day, on one count axis. */
export function ActivityChart({ data }: { data: DayTotals[] }) {
  return (
    <ChartContainer config={activityConfig} className="aspect-auto h-56 w-full">
      <AreaChart data={data} margin={{ left: 0, right: 4, top: 8 }}>
        <defs>
          <linearGradient id="fill-activity-runs" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-runs)" stopOpacity={0.18} />
            <stop offset="95%" stopColor="var(--color-runs)" stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} />
        <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tickFormatter={(v: number) => compactNumber(v)} />
        <ChartTooltip
          cursor={{ strokeDasharray: "3 3" }}
          content={<ChartTooltipContent indicator="line" labelFormatter={(v) => longDay(String(v))} />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Area
          dataKey="runs"
          type="monotone"
          stroke="var(--color-runs)"
          strokeWidth={2}
          fill="url(#fill-activity-runs)"
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          animationDuration={800}
        />
        <Line
          dataKey="tool_calls"
          type="monotone"
          stroke="var(--color-tool_calls)"
          strokeWidth={2}
          strokeDasharray="4 3"
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          animationDuration={800}
        />
      </AreaChart>
    </ChartContainer>
  )
}
