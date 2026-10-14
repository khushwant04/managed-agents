"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronRightIcon, DownloadIcon, FileIcon, FilterIcon, PackageOpenIcon, RotateCwIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AnimatedNumber, Expand } from "@/components/motion"
import { CodeBlock } from "@/components/code-block"
import { CopyButton } from "@/components/copy-button"
import { StatusBadge } from "@/components/status-badge"
import { TimeAgo } from "@/components/session/time-ago"
import { runAnchor } from "@/components/session/timeline"
import type { ApiEvent, ArtifactList, Deployment, Session } from "@/lib/api"
import { proxyUrl, seg } from "@/lib/client"
import { compactNumber, formatBytes, formatDuration, formatNumber, formatTime, shortId } from "@/lib/format"
import { modelsUsed, summarizeRuns, totalTokens } from "@/lib/session-view"
import type { RouteItem, TimelineState } from "@/lib/timeline"
import { cn } from "@/lib/utils"

export function SidePanel({
  sessionId,
  session,
  deployment,
  status,
  timeline,
  events,
  artifacts,
  artifactsError,
  onReloadArtifacts,
}: {
  sessionId: string
  session: Session | undefined
  deployment: Deployment | undefined
  status: string | null
  timeline: TimelineState
  events: ApiEvent[]
  artifacts: ArtifactList | undefined
  artifactsError: Error | undefined
  onReloadArtifacts: () => void
}) {
  const artifactCount = artifacts?.artifacts.length ?? 0
  return (
    <Tabs defaultValue="details" className="gap-0 overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-foreground/10">
      <div className="border-b px-3 pt-3 pb-2">
        <TabsList variant="line" className="w-full justify-start gap-3">
          <TabsTrigger value="details" className="flex-none px-1">
            Details
          </TabsTrigger>
          <TabsTrigger value="artifacts" className="flex-none px-1">
            Artifacts
            {artifactCount ? <span className="text-[11px] text-muted-foreground tabular-nums">{artifactCount}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="events" className="flex-none px-1">
            Raw events
            {events.length ? <span className="text-[11px] text-muted-foreground tabular-nums">{events.length}</span> : null}
          </TabsTrigger>
        </TabsList>
      </div>
      <div className="lg:max-h-[calc(100svh-11rem)] lg:overflow-y-auto">
        <TabsContent value="details" className="p-4">
          <Details sessionId={sessionId} session={session} deployment={deployment} status={status} timeline={timeline} />
        </TabsContent>
        <TabsContent value="artifacts" className="p-2">
          <Artifacts sessionId={sessionId} data={artifacts} error={artifactsError} onReload={onReloadArtifacts} />
        </TabsContent>
        <TabsContent value="events" className="p-0">
          <RawEvents events={events} />
        </TabsContent>
      </div>
    </Tabs>
  )
}

function Heading({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>
      {action}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-4 text-[13px]">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-1 text-right">{children}</dd>
    </div>
  )
}

function Details({
  sessionId,
  session: s,
  deployment,
  status,
  timeline,
}: {
  sessionId: string
  session: Session | undefined
  deployment: Deployment | undefined
  status: string | null
  timeline: TimelineState
}) {
  const runs = React.useMemo(() => summarizeRuns(timeline.items), [timeline.items])
  const models = React.useMemo(() => modelsUsed(timeline.items), [timeline.items])
  const route = React.useMemo(
    () => timeline.items.findLast((i): i is RouteItem => i.kind === "route"),
    [timeline.items]
  )
  const u = timeline.usage

  return (
    <div className="flex flex-col gap-6">
      <section>
        <Heading>Overview</Heading>
        {s ? (
          <dl className="flex flex-col">
            <Row label="Status">
              <StatusBadge status={status} />
            </Row>
            <Row label="Session">
              <span className="truncate font-mono text-xs">{shortId(sessionId, 14)}</span>
              <CopyButton value={sessionId} size="icon-xs" label="Copy session id" />
            </Row>
            <Row label="Agent">
              <Link href={`/agents/${seg(s.agent)}`} className="truncate font-medium hover:underline">
                {s.agent}
              </Link>
              <span className="text-muted-foreground">
                {s.alias ? `@${s.alias}` : ""} · v{s.version}
              </span>
            </Row>
            {s.parent_session_id ? (
              <Row label="Parent">
                <Link href={`/sessions/${seg(s.parent_session_id)}`} className="truncate font-mono text-xs hover:underline">
                  {shortId(s.parent_session_id, 12)}
                </Link>
              </Row>
            ) : null}
            <Row label="Deployment">
              {s.deployment_id ? (
                <Link href={`/deployments/${seg(s.deployment_id)}`} className="truncate hover:underline">
                  {deployment?.name ?? <span className="font-mono text-xs">{shortId(s.deployment_id)}</span>}
                </Link>
              ) : (
                <span className="text-muted-foreground">Direct</span>
              )}
            </Row>
            <Row label="Sandbox">
              <span className="capitalize">{s.sandbox_state.replaceAll("_", " ")}</span>
            </Row>
            <Row label="Depth">
              <span className="tabular-nums">{s.depth}</span>
            </Row>
            <Row label="Created">
              <TimeAgo iso={s.created_at} />
            </Row>
            <Row label="Last active">
              <TimeAgo iso={s.last_active_at} />
            </Row>
          </dl>
        ) : (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        )}
      </section>

      {route ? (
        <section>
          <Heading>Route resolution</Heading>
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs ring-1 ring-foreground/5">
            <span>
              {route.agent ?? s?.agent}
              {route.alias ? `@${route.alias}` : ""}
            </span>
            <ChevronRightIcon className="size-3 text-muted-foreground" />
            <span>v{route.version ?? "?"}</span>
            {route.model ? (
              <>
                <ChevronRightIcon className="size-3 text-muted-foreground" />
                <span>{route.model}</span>
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {models.length ? (
        <section>
          <Heading>Models</Heading>
          <div className="flex flex-wrap gap-1.5">
            {models.map((m) => (
              <Badge key={m} variant="outline" className="rounded-md font-mono text-[11px] font-normal">
                {m}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <Heading action={<span className="text-xs text-muted-foreground tabular-nums">{formatNumber(totalTokens(u))} total</span>}>
          Token usage
        </Heading>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border ring-1 ring-border">
          {(
            [
              ["Input", u.input_tokens],
              ["Output", u.output_tokens],
              ["Cache read", u.cache_read_tokens],
              ["Cache write", u.cache_write_tokens],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5 bg-card px-3 py-2.5">
              <span className="text-[11px] text-muted-foreground">{label}</span>
              <AnimatedNumber value={value} className="text-base font-semibold tracking-tight tabular-nums" />
            </div>
          ))}
        </div>
      </section>

      <section>
        <Heading action={<span className="text-xs text-muted-foreground tabular-nums">{runs.length}</span>}>Runs</Heading>
        {runs.length ? (
          <ol className="-mx-2 flex flex-col">
            {runs.map((r) => (
              <li key={r.runId}>
                <button
                  type="button"
                  onClick={() => document.getElementById(runAnchor(r.runId))?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className="group/run flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-medium tabular-nums">
                    {r.index}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5 text-[13px]">
                      {r.stopReason ? (
                        <span className="font-mono text-xs">{r.stopReason}</span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-info">
                          <span className="size-1.5 animate-pulse rounded-full bg-info" />
                          in progress
                        </span>
                      )}
                      {r.durationMs !== null ? (
                        <span className="text-xs text-muted-foreground tabular-nums">· {formatDuration(r.durationMs)}</span>
                      ) : null}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground tabular-nums">
                      {r.startedAt ? formatTime(r.startedAt) : ""}
                      {r.usage ? ` · ${compactNumber(r.usage.input_tokens)} in / ${compactNumber(r.usage.output_tokens)} out` : ""}
                      {r.model ? ` · ${r.model}` : ""}
                    </span>
                  </div>
                  <ChevronRightIcon className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/run:opacity-100" />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">No runs yet.</p>
        )}
      </section>
    </div>
  )
}

function Artifacts({
  sessionId,
  data,
  error,
  onReload,
}: {
  sessionId: string
  data: ArtifactList | undefined
  error: Error | undefined
  onReload: () => void
}) {
  if (error)
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-muted-foreground">
        <p className="text-destructive">{error.message}</p>
        <Button variant="outline" size="sm" onClick={onReload}>
          <RotateCwIcon data-icon="inline-start" />
          Retry
        </Button>
      </div>
    )
  if (!data)
    return (
      <div className="flex flex-col gap-2 p-2">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    )
  if (!data.artifacts.length)
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <span className="flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <PackageOpenIcon className="size-4" />
        </span>
        <p className="text-sm font-medium">No artifacts</p>
        <p className="text-xs text-muted-foreground">Files the agent writes to its outputs folder show up here.</p>
      </div>
    )
  return (
    <ul className="flex flex-col">
      {data.artifacts.map((a) => (
        <li key={a.id} className="group/art flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/50">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <FileIcon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-xs" title={a.path}>
              {a.path}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {formatBytes(a.size_bytes)}
              {a.content_type ? ` · ${a.content_type}` : ""} · <TimeAgo iso={a.created_at} />
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Download ${a.path}`}
            render={<a href={proxyUrl(`/v1/sessions/${seg(sessionId)}/artifacts/${seg(a.id)}`)} download />}
          >
            <DownloadIcon />
          </Button>
        </li>
      ))}
    </ul>
  )
}

const WINDOW = 200

function typeTone(type: string): string {
  if (type === "error") return "bg-destructive"
  if (type.startsWith("tool.approval")) return "bg-warning"
  if (type.startsWith("tool.")) return "bg-chart-2"
  if (type.startsWith("message.") || type === "thinking.delta") return "bg-info"
  if (type.startsWith("subagent.") || type === "artifact.created") return "bg-success"
  return "bg-muted-foreground/50"
}

function RawEvents({ events }: { events: ApiEvent[] }) {
  const [filter, setFilter] = React.useState("")
  const [shown, setShown] = React.useState(WINDOW)
  const [open, setOpen] = React.useState<ReadonlySet<number>>(() => new Set())
  // Rows keep their JSON mounted after the first open so collapsing can animate.
  const [mounted, setMounted] = React.useState<ReadonlySet<number>>(() => new Set())
  const q = filter.trim().toLowerCase()
  const matching = React.useMemo(
    () => (q ? events.filter((e) => e.type.includes(q) || String(e.seq) === q || (e.run_id ?? "").includes(q)) : events),
    [events, q]
  )
  const visible = matching.slice(Math.max(0, matching.length - shown))
  const hidden = matching.length - visible.length

  const toggle = (seq: number) => {
    setMounted((s) => (s.has(seq) ? s : new Set(s).add(seq)))
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 border-b bg-card/95 p-2 backdrop-blur">
        <InputGroup className="h-7">
          <InputGroupAddon>
            <FilterIcon className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by type, seq or run id"
            aria-label="Filter events"
            className="text-xs"
          />
          <InputGroupAddon align="inline-end" className="text-[11px] tabular-nums">
            {matching.length}
          </InputGroupAddon>
        </InputGroup>
      </div>
      {hidden > 0 ? (
        <Button variant="ghost" size="sm" className="m-1 text-muted-foreground" onClick={() => setShown((n) => n + WINDOW)}>
          Show {Math.min(hidden, WINDOW)} earlier ({hidden} hidden)
        </Button>
      ) : null}
      {visible.length === 0 ? (
        <p className="p-6 text-center text-xs text-muted-foreground">{events.length ? "No events match." : "No events yet."}</p>
      ) : (
        <ol className="flex flex-col py-1 font-mono text-xs">
          {visible.map((e) => {
            const isOpen = open.has(e.seq)
            return (
              <li key={`${e.seq}-${e.id}`} className="border-b border-border/50 last:border-0">
                <button
                  type="button"
                  onClick={() => toggle(e.seq)}
                  aria-expanded={isOpen}
                  className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/50", isOpen && "bg-muted/40")}
                >
                  <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-200", isOpen && "rotate-90")} />
                  <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">{e.seq}</span>
                  <span className={cn("size-1.5 shrink-0 rounded-full", typeTone(e.type))} />
                  <span className="min-w-0 flex-1 truncate">{e.type}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{formatTime(e.ts)}</span>
                </button>
                <Expand open={isOpen}>
                  {mounted.has(e.seq) ? (
                    <div className="px-3 pb-3">
                      <CodeBlock
                        code={JSON.stringify({ id: e.id, run_id: e.run_id, model: e.model, ts: e.ts, payload: e.payload }, null, 2)}
                        className="[&_pre]:max-h-80"
                        wrap
                      />
                    </div>
                  ) : null}
                </Expand>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
