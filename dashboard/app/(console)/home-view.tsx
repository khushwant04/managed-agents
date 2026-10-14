"use client"

import * as React from "react"
import Link from "next/link"
import {
  ActivityIcon,
  ArrowRightIcon,
  BookOpenTextIcon,
  BotIcon,
  DatabaseZapIcon,
  FlaskConicalIcon,
  RocketIcon,
  SparklesIcon,
  WebhookIcon,
} from "lucide-react"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Page } from "@/components/page"
import { AnimatedNumber, FadeIn, Stagger, StaggerItem } from "@/components/motion"
import { AgentCard } from "@/components/agent-card"
import { StatusBadge } from "@/components/status-badge"
import { EmptyState, ErrorState } from "@/components/states"
import { TokenAreaChart } from "@/components/charts/token-area-chart"
import { useProject } from "@/components/shell/project-context"
import { DOCS_URL } from "@/components/shell/nav"
import { useApi } from "@/hooks/use-api"
import { useNow } from "@/hooks/use-client"
import type { AgentList, SessionList, UsageList } from "@/lib/api"
import { compactNumber, shortId, timeAgo } from "@/lib/format"
import { fillDays, totalsByDay } from "@/lib/usage"

function greeting(hour: number) {
  if (hour < 5) return "Working late"
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}


function StatCard({
  title,
  icon: Icon,
  value,
  format,
  hint,
  loading,
  children,
}: {
  title: string
  icon: React.ElementType
  value: number | undefined
  format?: (n: number) => string
  hint?: React.ReactNode
  loading: boolean
  children?: React.ReactNode
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5">
          <Icon className="size-3.5" />
          {title}
        </CardDescription>
        <CardTitle className="text-3xl font-semibold tracking-tight tabular-nums">
          {loading || value === undefined ? (
            <Skeleton className="h-9 w-24" />
          ) : (
            <AnimatedNumber value={value} format={format} />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="mt-auto flex flex-col gap-2 text-xs text-muted-foreground">
        {children}
        {hint}
      </CardContent>
    </Card>
  )
}

const RESOURCES = [
  { title: "Open the playground", body: "Run any agent and watch its events stream in.", href: "/playground", icon: FlaskConicalIcon },
  { title: "Register an agent", body: "Push a spec from code, YAML or here.", href: "/agents?new=1", icon: BotIcon },
  { title: "Deploy with triggers", body: "HTTP, webhooks, cron and queues.", href: "/deployments?new=1", icon: RocketIcon },
  { title: "Connect a webhook", body: "GitHub, Slack, Stripe or generic.", href: "/webhooks", icon: WebhookIcon },
]

export function HomeView() {
  const project = useProject()
  // The clock is read on the client only, so server and client markup match.
  const now = useNow()
  const hello = now ? greeting(new Date(now).getHours()) : null
  const [range, setRange] = React.useState<"7" | "30">("30")

  const usage = useApi<UsageList>("/v1/usage", { days: 30 })
  const sessions = useApi<SessionList>("/v1/sessions", { limit: 100 })
  const agents = useApi<AgentList>("/v1/agents")

  const days = React.useMemo(() => {
    if (!now) return []
    const today = new Date(now).toISOString().slice(0, 10)
    const from = new Date(now - (Number(range) - 1) * 86_400_000).toISOString().slice(0, 10)
    return fillDays(totalsByDay(usage.data?.usage ?? []).filter((d) => d.day >= from), from, today)
  }, [usage.data, range, now])

  const totals = React.useMemo(() => {
    const all = totalsByDay(usage.data?.usage ?? [])
    const sum = (k: "input_tokens" | "output_tokens" | "cache_read_tokens" | "runs") => all.reduce((a, d) => a + d[k], 0)
    const input = sum("input_tokens")
    const cache = sum("cache_read_tokens")
    return { input, output: sum("output_tokens"), cache, runs: sum("runs"), cacheShare: input + cache > 0 ? cache / (input + cache) : 0 }
  }, [usage.data])

  const sessionList = sessions.data?.sessions ?? []
  const weekAgo = now - 7 * 86_400_000
  const recentCount = sessionList.filter((s) => Date.parse(s.created_at) >= weekAgo).length
  const activeCount = sessionList.filter((s) => s.status === "running" || s.status === "queued").length

  return (
    <Page className="gap-8">
      <FadeIn className="flex flex-col gap-1">
        <h1 className="min-h-9 font-heading text-3xl font-semibold tracking-tight">
          {hello ? (
            <FadeIn y={4}>
              {hello}, <span className="text-muted-foreground">{project.name}</span>
            </FadeIn>
          ) : null}
        </h1>
        <p className="text-sm text-muted-foreground">Here&apos;s what your agents have been up to.</p>
      </FadeIn>

      {usage.error ? <ErrorState error={usage.error} onRetry={usage.reload} /> : null}

      <Stagger className="grid gap-4 md:grid-cols-3" gap={0.07}>
        <StaggerItem>
          <StatCard
            title="Sessions, last 7 days"
            icon={ActivityIcon}
            value={sessions.data ? recentCount : undefined}
            loading={sessions.loading && !sessions.data}
            hint={
              <span className="flex items-center gap-1.5">
                <span className={activeCount ? "size-1.5 rounded-full bg-info" : "size-1.5 rounded-full bg-muted-foreground/40"} />
                {activeCount} running now
              </span>
            }
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            title="Tokens, last 30 days"
            icon={SparklesIcon}
            value={usage.data ? totals.input + totals.output : undefined}
            format={(n) => compactNumber(n)}
            loading={usage.loading && !usage.data}
            hint={`${compactNumber(totals.input)} input · ${compactNumber(totals.output)} output · ${totals.runs.toLocaleString()} runs`}
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            title="Prompt caching"
            icon={DatabaseZapIcon}
            value={usage.data ? Math.round(totals.cacheShare * 1000) / 10 : undefined}
            format={(n) => `${n.toFixed(1)}%`}
            loading={usage.loading && !usage.data}
            hint={`${compactNumber(totals.cache)} input tokens served from cache`}
          >
            <Progress value={totals.cacheShare * 100} className="h-1.5" />
          </StatCard>
        </StaggerItem>
      </Stagger>

      <FadeIn delay={0.15}>
        <Card>
          <CardHeader>
            <CardTitle>Token volume</CardTitle>
            <CardDescription>Input, output and cached input tokens per day, across all models.</CardDescription>
            <CardAction>
              <Tabs value={range} onValueChange={(v) => setRange(v as "7" | "30")}>
                <TabsList>
                  <TabsTrigger value="7">7 days</TabsTrigger>
                  <TabsTrigger value="30">30 days</TabsTrigger>
                </TabsList>
              </Tabs>
            </CardAction>
          </CardHeader>
          <CardContent>
            {usage.loading && !usage.data ? <Skeleton className="h-56 w-full" /> : <TokenAreaChart data={days} />}
          </CardContent>
        </Card>
      </FadeIn>

      <section className="flex flex-col gap-3">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-sm font-semibold">Agents</h2>
            <p className="text-sm text-muted-foreground">Your most recently registered agents.</p>
          </div>
          <Button variant="ghost" size="sm" render={<Link href="/agents" />}>
            View all
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </div>
        {agents.error ? (
          <ErrorState error={agents.error} onRetry={agents.reload} />
        ) : agents.loading && !agents.data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-48 rounded-xl" />
            ))}
          </div>
        ) : agents.data?.agents.length ? (
          <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" delay={0.2}>
            {agents.data.agents.slice(0, 4).map((a) => (
              <StaggerItem key={a.name} className="flex">
                <AgentCard agent={a} className="flex-1" />
              </StaggerItem>
            ))}
          </Stagger>
        ) : (
          <EmptyState
            icon={<BotIcon />}
            title="No agents yet"
            description="Register one with `agents apply` or from a template in the playground."
            action={
              <Button render={<Link href="/playground" />}>
                <FlaskConicalIcon data-icon="inline-start" />
                Start from a template
              </Button>
            }
          />
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <FadeIn delay={0.25}>
          <Card className="h-full">
            <CardHeader>
              <CardTitle>Recent sessions</CardTitle>
              <CardAction>
                <Button variant="ghost" size="sm" render={<Link href="/sessions" />}>
                  All sessions
                  <ArrowRightIcon data-icon="inline-end" />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col">
              {sessions.loading && !sessions.data ? (
                Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="my-1.5 h-8" />)
              ) : sessionList.length ? (
                sessionList.slice(0, 6).map((s) => (
                  <Link
                    key={s.id}
                    href={`/sessions/${encodeURIComponent(s.id)}`}
                    className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-200 hover:bg-muted/60"
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">
                        {s.agent}
                        <span className="text-muted-foreground">
                          {s.alias ? `@${s.alias}` : ""} · v{s.version}
                        </span>
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{shortId(s.id, 10)}</span>
                    </div>
                    <span className="hidden text-xs text-muted-foreground sm:inline">{now ? timeAgo(s.last_active_at ?? s.created_at, now) : null}</span>
                    <StatusBadge status={s.status} />
                  </Link>
                ))
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">No sessions yet. Run an agent to see it here.</p>
              )}
            </CardContent>
          </Card>
        </FadeIn>

        <FadeIn delay={0.3} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Start building</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {RESOURCES.map((r) => (
              <Link
                key={r.title}
                href={r.href}
                className="group/res flex items-center gap-3 rounded-xl bg-card p-3 shadow-card ring-1 ring-foreground/10 transition-[box-shadow,transform] duration-300 ease-(--ease-out-quint) hover:-translate-y-0.5 hover:shadow-card-hover"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground transition-colors group-hover/res:bg-primary group-hover/res:text-primary-foreground">
                  <r.icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{r.title}</div>
                  <div className="truncate text-xs text-muted-foreground">{r.body}</div>
                </div>
                <ArrowRightIcon className="size-4 text-muted-foreground transition-transform duration-300 group-hover/res:translate-x-0.5" />
              </Link>
            ))}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <BookOpenTextIcon className="size-3.5" />
              Read the docs: architecture, SDKs and the REST API
            </a>
          </div>
        </FadeIn>
      </div>
    </Page>
  )
}
