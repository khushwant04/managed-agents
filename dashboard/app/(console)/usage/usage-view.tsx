"use client"

import * as React from "react"
import Link from "next/link"
import { motion } from "motion/react"
import {
  ActivityIcon,
  ArrowDownToLineIcon,
  ChartColumnIcon,
  CpuIcon,
  DatabaseZapIcon,
  FlaskConicalIcon,
  HammerIcon,
  SparklesIcon,
  TimerIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Page, PageHeader } from "@/components/page"
import { EASE_OUT, FadeIn, Stagger, StaggerItem } from "@/components/motion"
import { EmptyState, ErrorState } from "@/components/states"
import { StatCard } from "@/components/analytics/stat-card"
import { ActivityChart, TokenBarChart } from "@/components/analytics/usage-charts"
import { useApi } from "@/hooks/use-api"
import { useNow } from "@/hooks/use-client"
import type { UsageList } from "@/lib/api"
import { compactNumber, formatNumber } from "@/lib/format"
import { dayKey, fillDays, totalsByDay } from "@/lib/usage"
import { byModel, modelOf, rangeStart, sumUsage, usageCsv } from "@/lib/usage-report"
import { cn } from "@/lib/utils"

const RANGES = [7, 30, 90] as const
const ALL = "__all__"

function downloadText(filename: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const percent = (n: number) => `${n.toFixed(1)}%`

export function UsageView() {
  const [days, setDays] = React.useState<number>(30)
  const [model, setModel] = React.useState<string>(ALL)
  const usage = useApi<UsageList>("/v1/usage", { days })
  const now = useNow()

  const rows = React.useMemo(() => usage.data?.usage ?? [], [usage.data])
  const models = React.useMemo(() => byModel(rows), [rows])
  const filtered = React.useMemo(() => (model === ALL ? rows : rows.filter((r) => modelOf(r) === model)), [rows, model])
  const totals = React.useMemo(() => sumUsage(filtered), [filtered])

  const series = React.useMemo(() => {
    const perDay = totalsByDay(filtered)
    // The server's clock decides "today"; before hydration fall back to the newest row.
    const to = now ? new Date(now).toISOString().slice(0, 10) : (perDay.at(-1)?.day ?? (rows[0] ? dayKey(rows[0].day) : null))
    if (!to) return perDay
    const from = rangeStart(to, days)
    return fillDays(
      perDay.filter((d) => d.day >= from),
      from,
      to
    )
  }, [filtered, rows, now, days])

  const modelItems = React.useMemo(() => {
    const items: Record<string, string> = { [ALL]: "All models" }
    for (const m of models) items[m.model] = m.model
    if (model !== ALL) items[model] = model
    return items
  }, [models, model])

  const loadingFirst = usage.loading && !usage.data
  const refreshing = usage.loading && !!usage.data
  const empty = !!usage.data && rows.length === 0

  const exportCsv = () => {
    const stamp = now ? new Date(now).toISOString().slice(0, 10) : "export"
    const suffix = model === ALL ? "" : `-${model.replace(/[^\w.-]+/g, "_")}`
    downloadText(`usage-${days}d${suffix}-${stamp}.csv`, usageCsv(filtered))
  }

  return (
    <Page>
      <PageHeader
        title="Usage"
        description="Tokens, runs, tool calls and sandbox time recorded for this project, per day and model."
        actions={
          <Button variant="outline" onClick={exportCsv} disabled={!filtered.length}>
            <ArrowDownToLineIcon data-icon="inline-start" />
            Export CSV
          </Button>
        }
      />

      <FadeIn delay={0.05} className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          variant="outline"
          spacing={0}
          value={[String(days)]}
          onValueChange={(v) => {
            if (v[0]) setDays(Number(v[0]))
          }}
          aria-label="Date range"
        >
          {RANGES.map((d) => (
            <ToggleGroupItem key={d} value={String(d)} className="px-3 aria-pressed:bg-muted aria-pressed:text-foreground">
              {d} days
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Select value={model} onValueChange={(v) => setModel(v ?? ALL)} items={modelItems}>
          <SelectTrigger className="min-w-44" aria-label="Model">
            <CpuIcon className="text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All models</SelectItem>
            {models.map((m) => (
              <SelectItem key={m.model} value={m.model}>
                <span className="font-mono text-xs">{m.model}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <motion.span
          initial={false}
          animate={{ opacity: refreshing ? 1 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          aria-live="polite"
        >
          <Spinner className="size-3.5" />
          {refreshing ? "Updating…" : null}
        </motion.span>
        <span className="ml-auto text-xs text-muted-foreground">
          {series.length ? `${shortRange(series[0]!.day)} – ${shortRange(series.at(-1)!.day)} (UTC)` : null}
        </span>
      </FadeIn>

      {usage.error ? <ErrorState error={usage.error} onRetry={usage.reload} /> : null}

      {empty ? (
        <EmptyState
          icon={<ChartColumnIcon />}
          title={`No usage in the last ${days} days`}
          description="Usage is recorded for every run: tokens per model, tool calls and sandbox time. Run an agent to see it here."
          action={
            <Button render={<Link href="/playground" />}>
              <FlaskConicalIcon data-icon="inline-start" />
              Open the playground
            </Button>
          }
        />
      ) : (
        <>
          <Stagger className="grid grid-cols-2 gap-4 lg:grid-cols-4" gap={0.05} delay={0.05}>
            <StaggerItem className="col-span-2">
              <StatCard
                title="Total tokens"
                icon={SparklesIcon}
                size="lg"
                value={usage.data ? totals.tokens : undefined}
                format={(n) => formatNumber(Math.round(n))}
                loading={loadingFirst}
              >
                <TokenSplit input={totals.input} cache={totals.cacheRead} output={totals.output} />
              </StatCard>
            </StaggerItem>
            <StaggerItem>
              <StatCard
                title="Cache hit rate"
                icon={DatabaseZapIcon}
                value={usage.data ? Math.round(totals.cacheHitRate * 1000) / 10 : undefined}
                format={percent}
                loading={loadingFirst}
              >
                <Progress value={totals.cacheHitRate * 100} className="h-1.5" aria-label="Cache hit rate" />
                <span>{compactNumber(totals.cacheRead)} prompt tokens read from cache</span>
              </StatCard>
            </StaggerItem>
            <StaggerItem>
              <StatCard title="Runs" icon={ActivityIcon} value={usage.data ? totals.runs : undefined} loading={loadingFirst}>
                <span>{totals.runs ? `${compactNumber(totals.tokens / totals.runs)} tokens per run` : "No runs"}</span>
              </StatCard>
            </StaggerItem>
            <StaggerItem>
              <StatCard title="Input tokens" value={usage.data ? totals.input : undefined} format={compactFmt} loading={loadingFirst}>
                <Legend swatch="bg-chart-2">Uncached prompt tokens</Legend>
              </StatCard>
            </StaggerItem>
            <StaggerItem>
              <StatCard title="Output tokens" value={usage.data ? totals.output : undefined} format={compactFmt} loading={loadingFirst}>
                <Legend swatch="bg-foreground">Generated tokens</Legend>
              </StatCard>
            </StaggerItem>
            <StaggerItem>
              <StatCard title="Tool calls" icon={HammerIcon} value={usage.data ? totals.toolCalls : undefined} loading={loadingFirst}>
                <span>{totals.runs ? `${(totals.toolCalls / totals.runs).toFixed(1)} per run` : "–"}</span>
              </StatCard>
            </StaggerItem>
            <StaggerItem>
              <StatCard
                title="Sandbox minutes"
                icon={TimerIcon}
                value={usage.data ? totals.sandboxSeconds / 60 : undefined}
                format={(n) => (n < 10 ? n.toFixed(1) : formatNumber(Math.round(n)))}
                loading={loadingFirst}
              >
                <span>Compute time in agent sandboxes</span>
              </StatCard>
            </StaggerItem>
          </Stagger>

          <FadeIn delay={0.15}>
            <Card>
              <CardHeader>
                <CardTitle>Tokens per day</CardTitle>
                <CardDescription>
                  Input, cached input and output tokens{model === ALL ? " across all models" : <> for <span className="font-mono text-xs">{model}</span></>}.
                </CardDescription>
              </CardHeader>
              <CardContent>{loadingFirst ? <Skeleton className="h-72 w-full" /> : <TokenBarChart data={series} />}</CardContent>
            </Card>
          </FadeIn>

          <FadeIn delay={0.2}>
            <Card>
              <CardHeader>
                <CardTitle>Runs and tool calls</CardTitle>
                <CardDescription>How much work agents did each day.</CardDescription>
              </CardHeader>
              <CardContent>{loadingFirst ? <Skeleton className="h-56 w-full" /> : <ActivityChart data={series} />}</CardContent>
            </Card>
          </FadeIn>

          <FadeIn delay={0.25}>
            <Card className="gap-0 py-0">
              <CardHeader className="border-b py-4">
                <CardTitle>By model</CardTitle>
                <CardDescription>Share of tokens in the selected range. Click a model to filter the page.</CardDescription>
                <CardAction>
                  <Badge variant="muted">{models.length} {models.length === 1 ? "model" : "models"}</Badge>
                </CardAction>
              </CardHeader>
              <ModelTable
                models={models}
                loading={loadingFirst}
                selected={model}
                onSelect={(m) => setModel((cur) => (cur === m ? ALL : m))}
              />
            </Card>
          </FadeIn>
        </>
      )}
    </Page>
  )
}

const compactFmt = (n: number) => compactNumber(Math.round(n))

function shortRange(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
}

function Legend({ swatch, children }: { swatch: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2 rounded-[2px]", swatch)} />
      {children}
    </span>
  )
}

/** Proportional bar of input / cache reads / output with a legend. */
function TokenSplit({ input, cache, output }: { input: number; cache: number; output: number }) {
  const total = input + cache + output
  const parts = [
    { key: "input", label: "Input", value: input, className: "bg-chart-2" },
    { key: "cache", label: "Cache reads", value: cache, className: "bg-chart-1" },
    { key: "output", label: "Output", value: output, className: "bg-foreground" },
  ]
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
        {total > 0
          ? parts.map((p, i) => (
              <motion.div
                key={p.key}
                className={cn("h-full first:rounded-l-full last:rounded-r-full", p.className)}
                initial={{ width: 0 }}
                animate={{ width: `${(p.value / total) * 100}%` }}
                transition={{ duration: 0.8, ease: EASE_OUT, delay: 0.1 + i * 0.05 }}
              />
            ))
          : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <Legend key={p.key} swatch={p.className}>
            {p.label} <span className="font-medium text-foreground tabular-nums">{compactNumber(p.value)}</span>
          </Legend>
        ))}
      </div>
    </div>
  )
}

function ModelTable({
  models,
  loading,
  selected,
  onSelect,
}: {
  models: ReturnType<typeof byModel>
  loading: boolean
  selected: string
  onSelect: (model: string) => void
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4 text-xs font-normal text-muted-foreground">Model</TableHead>
          <TableHead className="text-right text-xs font-normal text-muted-foreground">Tokens</TableHead>
          <TableHead className="text-right text-xs font-normal text-muted-foreground">Input</TableHead>
          <TableHead className="text-right text-xs font-normal text-muted-foreground">Output</TableHead>
          <TableHead className="text-right text-xs font-normal text-muted-foreground">Cache hit</TableHead>
          <TableHead className="text-right text-xs font-normal text-muted-foreground">Runs</TableHead>
          <TableHead className="w-[28%] min-w-40 pr-4 text-xs font-normal text-muted-foreground">Share</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((m, i) => {
          const active = selected === m.model
          return (
            <motion.tr
              key={m.model}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: EASE_OUT, delay: Math.min(i, 10) * 0.04 }}
              onClick={() => onSelect(m.model)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onSelect(m.model)
                }
              }}
              tabIndex={0}
              aria-pressed={active}
              className={cn(
                "cursor-pointer border-b transition-colors outline-none last:border-0 hover:bg-muted/50 focus-visible:bg-muted/60",
                active && "bg-muted/70 hover:bg-muted/70"
              )}
            >
              <TableCell className="pl-4">
                <span className="flex items-center gap-2 font-mono text-xs">
                  <span
                    className={cn(
                      "size-1.5 rounded-full transition-colors",
                      active ? "bg-foreground" : "bg-muted-foreground/40"
                    )}
                  />
                  {m.model}
                </span>
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{formatNumber(m.tokens)}</TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{compactNumber(m.input)}</TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{compactNumber(m.output)}</TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{percent(m.cacheHitRate * 100)}</TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{formatNumber(m.runs)}</TableCell>
              <TableCell className="pr-4">
                <div className="flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <motion.div
                      className="h-full rounded-full bg-foreground/80"
                      initial={{ width: 0 }}
                      animate={{ width: `${m.share * 100}%` }}
                      transition={{ duration: 0.8, ease: EASE_OUT, delay: 0.15 + Math.min(i, 10) * 0.05 }}
                    />
                  </div>
                  <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">{percent(m.share * 100)}</span>
                </div>
              </TableCell>
            </motion.tr>
          )
        })}
      </TableBody>
    </Table>
  )
}
