"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion } from "motion/react"
import { ActivityIcon, ChevronRightIcon, CornerDownRightIcon, FlaskConicalIcon, RefreshCwIcon, RocketIcon, SearchIcon, XIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AgentArt } from "@/components/agent-art"
import { CopyButton } from "@/components/copy-button"
import { EASE_OUT } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states"
import { StatusBadge } from "@/components/status-badge"
import { TimeAgo } from "@/components/session/time-ago"
import { useApi } from "@/hooks/use-api"
import type { AgentList, DeploymentList, SessionList, SessionSummary } from "@/lib/api"
import { seg } from "@/lib/client"
import { shortId } from "@/lib/format"
import { countByFilter, filterSessions, isStatusFilter, STATUS_FILTERS, type StatusFilter } from "@/lib/session-view"

const ALL_AGENTS = "__all"
const PAGE_SIZE = 50
const MAX_LIMIT = 500
const REFRESH_MS = 5000

export function SessionsView({
  initialAgent,
  initialStatus,
  initialQuery,
}: {
  initialAgent: string
  initialStatus: string
  initialQuery: string
}) {
  const router = useRouter()
  const [agent, setAgent] = React.useState(initialAgent)
  const [status, setStatus] = React.useState<StatusFilter>(isStatusFilter(initialStatus) ? initialStatus : "all")
  const [query, setQuery] = React.useState(initialQuery)
  const [limit, setLimit] = React.useState(PAGE_SIZE)
  const [auto, setAuto] = React.useState(false)

  const agents = useApi<AgentList>("/v1/agents")
  const deployments = useApi<DeploymentList>("/v1/deployments")
  const { data, error, loading, reload } = useApi<SessionList>("/v1/sessions", { agent: agent || undefined, limit })

  React.useEffect(() => {
    if (!auto) return
    const t = setInterval(reload, REFRESH_MS)
    return () => clearInterval(t)
  }, [auto, reload])

  const sync = (next: { agent?: string; status?: StatusFilter; q?: string }) => {
    const qs = new URLSearchParams()
    const a = next.agent ?? agent
    const s = next.status ?? status
    const q = next.q ?? query
    if (a) qs.set("agent", a)
    if (s !== "all") qs.set("status", s)
    if (q.trim()) qs.set("q", q.trim())
    const str = qs.toString()
    router.replace(str ? `/sessions?${str}` : "/sessions", { scroll: false })
  }

  const all = React.useMemo(() => data?.sessions ?? [], [data])
  const counts = React.useMemo(() => countByFilter(all), [all])
  const rows = React.useMemo(() => filterSessions(all, { status, query }), [all, status, query])
  const deploymentNames = React.useMemo(
    () => new Map((deployments.data?.deployments ?? []).map((d) => [d.id, d.name])),
    [deployments.data]
  )
  const agentNames = agents.data?.agents.map((a) => a.name) ?? []
  if (agent && !agentNames.includes(agent)) agentNames.unshift(agent)
  const filtered = status !== "all" || query.trim() !== ""

  return (
    <Page>
      <PageHeader
        title="Sessions"
        description="Every conversation and task your agents have run, newest first. Open one to follow it live or replay it."
        actions={
          <>
            <div className="flex h-8 items-center gap-2 rounded-lg pr-1 text-sm sm:px-2">
              <Switch id="auto-refresh" checked={auto} onCheckedChange={setAuto} />
              <Label htmlFor="auto-refresh" className="cursor-pointer font-normal text-muted-foreground">
                Auto-refresh
              </Label>
              <AnimatePresence>
                {auto ? (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    className="relative flex size-1.5"
                    aria-hidden
                  >
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-success" />
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </div>
            <Button variant="outline" onClick={reload} disabled={loading}>
              {loading && data ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              Refresh
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <InputGroup className="lg:max-w-xs">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search sessions…"
            value={query}
            aria-label="Search sessions"
            onChange={(e) => {
              setQuery(e.target.value)
              sync({ q: e.target.value })
            }}
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("")
                  sync({ q: "" })
                }}
              >
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        <Select
          value={agent || ALL_AGENTS}
          onValueChange={(v) => {
            const next = !v || v === ALL_AGENTS ? "" : v
            setAgent(next)
            setLimit(PAGE_SIZE)
            sync({ agent: next })
          }}
        >
          <SelectTrigger className="w-full lg:w-48" aria-label="Filter by agent">
            <SelectValue>{(v: string) => (v === ALL_AGENTS ? "All agents" : v)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_AGENTS}>All agents</SelectItem>
            {agentNames.length ? <SelectSeparator /> : null}
            {agentNames.map((name) => (
              <SelectItem key={name} value={name}>
                <AgentArt name={name} className="size-3.5 rounded-full" />
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            value={[status]}
            onValueChange={(v) => {
              const next = (v[0] as StatusFilter | undefined) ?? "all"
              setStatus(next)
              sync({ status: next })
            }}
            aria-label="Filter by status"
          >
            {STATUS_FILTERS.map((f) => (
              <ToggleGroupItem key={f.value} value={f.value} className="gap-1.5 px-2.5">
                {f.label}
                {data ? (
                  <span className="text-[11px] text-muted-foreground tabular-nums">{counts[f.value]}</span>
                ) : null}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="text-xs text-muted-foreground tabular-nums lg:ml-auto">
          {data ? `${rows.length} ${rows.length === 1 ? "session" : "sessions"}${filtered ? ` of ${all.length}` : ""}` : null}
        </div>
      </div>

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {!data && loading ? (
        <Card className="p-4">
          <TableSkeleton rows={8} cols={6} />
        </Card>
      ) : data && all.length === 0 ? (
        <EmptyState
          icon={<ActivityIcon />}
          title={agent ? `No sessions for ${agent} yet` : "No sessions yet"}
          description="Sessions appear here when an agent is invoked from the API, a deployment trigger or the playground."
          action={
            <Button render={<Link href="/playground" />}>
              <FlaskConicalIcon data-icon="inline-start" />
              Open the playground
            </Button>
          }
        />
      ) : data && rows.length === 0 ? (
        <EmptyState
          icon={<SearchIcon />}
          title="No matching sessions"
          description="Nothing matches these filters. Try another status or clear the search."
          action={
            <Button
              variant="outline"
              onClick={() => {
                setQuery("")
                setStatus("all")
                sync({ q: "", status: "all" })
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : data ? (
        <Card className="gap-0 py-0">
          <Table>
            <TableHeader>
              <TableRow className="text-xs hover:bg-transparent [&>th]:text-muted-foreground">
                <TableHead className="pl-4">Session</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead className="w-8 pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial>
                {rows.map((s, i) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    index={i}
                    deploymentName={s.deployment_id ? deploymentNames.get(s.deployment_id) : undefined}
                    onOpen={() => router.push(`/sessions/${seg(s.id)}`)}
                  />
                ))}
              </AnimatePresence>
            </TableBody>
          </Table>
          {all.length >= limit && limit < MAX_LIMIT ? (
            <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
              <span>Showing the {all.length} most recent sessions</span>
              <Button variant="ghost" size="sm" onClick={() => setLimit((l) => Math.min(MAX_LIMIT, l + PAGE_SIZE * 2))} disabled={loading}>
                {loading ? <Spinner data-icon="inline-start" /> : null}
                Load more
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}
    </Page>
  )
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation()

function SessionRow({
  session: s,
  index,
  deploymentName,
  onOpen,
}: {
  session: SessionSummary
  index: number
  deploymentName: string | undefined
  onOpen: () => void
}) {
  const href = `/sessions/${seg(s.id)}`
  return (
    <motion.tr
      data-slot="table-row"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE_OUT, delay: Math.min(index, 12) * 0.025 } }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onClick={onOpen}
      className="group/row cursor-pointer border-b transition-colors hover:bg-muted/50"
    >
      <TableCell className="pl-4">
        <div className="flex items-center gap-1">
          {s.parent_session_id ? (
            <Tooltip>
              <TooltipTrigger render={<span className="text-muted-foreground" />}>
                <CornerDownRightIcon className="size-3.5" aria-label="Subagent session" />
              </TooltipTrigger>
              <TooltipContent>Subagent of {shortId(s.parent_session_id, 12)}</TooltipContent>
            </Tooltip>
          ) : null}
          <Link href={href} onClick={stop} className="font-mono text-xs underline-offset-4 outline-none hover:underline focus-visible:underline" title={s.id}>
            {shortId(s.id, 12)}
          </Link>
          <span onClick={stop} className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
            <CopyButton value={s.id} size="icon-xs" label="Copy session id" />
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <AgentArt name={s.agent} className="size-5 shrink-0 rounded-md" />
          <span className="font-medium">{s.agent}</span>
          <span className="-ml-1 text-muted-foreground">
            {s.alias ? `@${s.alias}` : ""} · v{s.version}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <StatusBadge status={s.status} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {s.parent_session_id ? (
          <Link href={`/sessions/${seg(s.parent_session_id)}`} onClick={stop} className="inline-flex items-center gap-1.5 text-xs hover:text-foreground">
            <Badge variant="muted" className="rounded-md">
              subagent
            </Badge>
            <span className="font-mono">{shortId(s.parent_session_id)}</span>
          </Link>
        ) : s.deployment_id ? (
          <Link href={`/deployments/${seg(s.deployment_id)}`} onClick={stop} className="inline-flex items-center gap-1.5 text-xs hover:text-foreground">
            <RocketIcon className="size-3.5" />
            {deploymentName ? <span>{deploymentName}</span> : <span className="font-mono">{shortId(s.deployment_id)}</span>}
          </Link>
        ) : (
          <span className="text-xs">Direct</span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        <TimeAgo iso={s.created_at} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        <TimeAgo iso={s.last_active_at} />
      </TableCell>
      <TableCell className="pr-4">
        <ChevronRightIcon className="size-4 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover/row:translate-x-0 group-hover/row:opacity-100" />
      </TableCell>
    </motion.tr>
  )
}
