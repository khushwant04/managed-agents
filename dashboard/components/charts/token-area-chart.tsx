"use client"

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { compactNumber } from "@/lib/format"
import type { DayTotals } from "@/lib/usage"

const config = {
  input_tokens: { label: "Input", color: "var(--chart-2)" },
  output_tokens: { label: "Output", color: "var(--foreground)" },
  cache_read_tokens: { label: "Cache reads", color: "var(--chart-1)" },
} satisfies ChartConfig

function shortDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
}

/** Stacked token volume per day with soft gradient fills. */
export function TokenAreaChart({ data, className }: { data: DayTotals[]; className?: string }) {
  return (
    <ChartContainer config={config} className={className ?? "aspect-auto h-56 w-full"}>
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <defs>
          {Object.keys(config).map((k) => (
            <linearGradient key={k} id={`fill-${k}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={`var(--color-${k})`} stopOpacity={0.35} />
              <stop offset="95%" stopColor={`var(--color-${k})`} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={shortDay} />
        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => compactNumber(v)} />
        <ChartTooltip
          cursor={{ strokeDasharray: "3 3" }}
          content={<ChartTooltipContent indicator="dot" labelFormatter={(v) => shortDay(String(v))} />}
        />
        {(["cache_read_tokens", "input_tokens", "output_tokens"] as const).map((k) => (
          <Area
            key={k}
            dataKey={k}
            type="monotone"
            stackId="t"
            stroke={`var(--color-${k})`}
            strokeWidth={1.5}
            fill={`url(#fill-${k})`}
            animationDuration={900}
            animationEasing="ease-out"
          />
        ))}
      </AreaChart>
    </ChartContainer>
  )
}
