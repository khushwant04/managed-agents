"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ChevronRightIcon, FilterIcon, RotateCwIcon, ScrollTextIcon, SearchIcon, ShieldIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Page, PageHeader } from "@/components/page"
import { EASE_OUT, Expand, FadeIn } from "@/components/motion"
import { CodeBlock } from "@/components/code-block"
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states"
import { ActionBadge } from "@/components/analytics/action-badge"
import { useApi } from "@/hooks/use-api"
import { useNow } from "@/hooks/use-client"
import type { AuditEntry, AuditList } from "@/lib/api"
import { ApiError } from "@/lib/client"
import { formatDateTime, formatTime, shortId, timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

const ALL = "__all__"
const LIMITS = [50, 100, 250, 500, 1000]
const LIVE_EVERY_MS = 10_000

/** Stable row keys that survive refreshes (new entries arrive at the top). */
function withKeys(entries: readonly AuditEntry[]) {
  const seen = new Map<string, number>()
  return entries.map((e) => {
    const base = `${e.at}|${e.actor}|${e.action}|${e.target}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { e, key: n ? `${base}#${n}` : base }
  })
}

export function LogsView() {
  const [limit, setLimit] = React.useState(100)
  const [action, setAction] = React.useState(ALL)
  const [query, setQuery] = React.useState("")
  const [live, setLive] = React.useState(false)
  const [open, setOpen] = React.useState<Set<string>>(() => new Set())
  const audit = useApi<AuditList>("/v1/audit", { limit })
  const now = useNow()
  const { reload } = audit

  React.useEffect(() => {
    if (!live) return
    const id = setInterval(reload, LIVE_EVERY_MS)
    return () => clearInterval(id)
  }, [live, reload])

  const forbidden = audit.error instanceof ApiError && audit.error.status === 403
  const entries = React.useMemo(() => audit.data?.entries ?? [], [audit.data])

  const actions = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of entries) counts.set(e.action, (counts.get(e.action) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [entries])

  const q = query.trim().toLowerCase()
  const shown = React.useMemo(
    () =>
      withKeys(entries).filter(({ e }) => (action === ALL || e.action === action) && (!q || `${e.actor} ${e.target}`.toLowerCase().includes(q))),
    [entries, action, q]
  )
  const filtering = action !== ALL || !!q

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const actionItems = React.useMemo(() => {
    const items: Record<string, string> = { [ALL]: "All actions" }
    for (const [a] of actions) items[a] = a
    if (action !== ALL) items[action] = action
    return items
  }, [actions, action])

  return (
    <Page>
      <PageHeader
        title="Logs"
        description="An audit trail of every change in this project: registrations, alias moves, deployments, secrets, keys and approvals."
        actions={
          forbidden ? null : (
            <>
              <Label className="mr-1 flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm font-normal text-muted-foreground">
                <Switch size="sm" checked={live} onCheckedChange={setLive} />
                <span className="flex items-center gap-1.5">
                  <span className="relative flex size-1.5">
                    {live ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" /> : null}
                    <span className={cn("relative inline-flex size-1.5 rounded-full transition-colors", live ? "bg-success" : "bg-muted-foreground/40")} />
                  </span>
                  Live
                </span>
              </Label>
              <Button variant="outline" onClick={audit.reload} disabled={audit.loading}>
                <RotateCwIcon data-icon="inline-start" className={cn(audit.loading && "animate-spin")} />
                Refresh
              </Button>
            </>
          )
        }
      />

      {forbidden ? (
        <FadeIn className="flex items-start gap-3 rounded-xl bg-card p-5 text-sm shadow-card ring-1 ring-foreground/10">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ShieldIcon className="size-4" />
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-medium">Admins only</p>
            <p className="max-w-xl text-muted-foreground">
              The audit log needs an API key with the <span className="font-medium text-foreground">admin</span> role. You&apos;re signed in with a key
              that can&apos;t read it. Sign out and use an admin key, or ask a project admin.
            </p>
          </div>
        </FadeIn>
      ) : (
        <>
          <FadeIn delay={0.05} className="flex flex-wrap items-center gap-2">
            <InputGroup className="w-full sm:w-72">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                placeholder="Search actor or target"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search actor or target"
              />
              <AnimatePresence>
                {query ? (
                  <InputGroupAddon align="inline-end">
                    <motion.span initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                      <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                        <XIcon />
                      </InputGroupButton>
                    </motion.span>
                  </InputGroupAddon>
                ) : null}
              </AnimatePresence>
            </InputGroup>
            <Select value={action} onValueChange={(v) => setAction(v ?? ALL)} items={actionItems}>
              <SelectTrigger className="min-w-44" aria-label="Action">
                <FilterIcon className="text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All actions</SelectItem>
                {actions.length ? <SelectSeparator /> : null}
                <SelectGroup>
                  {actions.length ? <SelectLabel>In these entries</SelectLabel> : null}
                  {actions.map(([a, n]) => (
                    <SelectItem key={a} value={a}>
                      <span className="font-mono text-xs">{a}</span>
                      <span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">{n}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={String(limit)} onValueChange={(v) => v && setLimit(Number(v))}>
              <SelectTrigger aria-label="Entries to load">
                <SelectValue>{(v: string) => `Last ${v}`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {LIMITS.map((l) => (
                  <SelectItem key={l} value={String(l)}>
                    Last {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {audit.data ? (filtering ? `${shown.length} of ${entries.length} entries` : `${entries.length} entries`) : null}
            </span>
          </FadeIn>

          {audit.error ? <ErrorState error={audit.error} onRetry={audit.reload} /> : null}

          {audit.loading && !audit.data ? (
            <Card className="p-4">
              <TableSkeleton rows={8} cols={5} />
            </Card>
          ) : audit.data && shown.length === 0 ? (
            <EmptyState
              icon={<ScrollTextIcon />}
              title={filtering ? "No entries match" : "No audit entries yet"}
              description={
                filtering
                  ? "Try a different action or search, or load more entries."
                  : "Changes to agents, deployments, secrets, keys and policy will be listed here."
              }
              action={
                filtering ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuery("")
                      setAction(ALL)
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null
              }
            />
          ) : audit.data ? (
            <FadeIn delay={0.1}>
              <Card className="py-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-8 pl-3" />
                      <TableHead className="text-xs font-normal text-muted-foreground">Time</TableHead>
                      <TableHead className="text-xs font-normal text-muted-foreground">Actor</TableHead>
                      <TableHead className="text-xs font-normal text-muted-foreground">Action</TableHead>
                      <TableHead className="text-xs font-normal text-muted-foreground">Target</TableHead>
                      <TableHead className="pr-4 text-right text-xs font-normal text-muted-foreground">Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map(({ e, key }, i) => (
                      <LogRow key={key} entry={e} index={i} now={now} open={open.has(key)} onToggle={() => toggle(key)} />
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </FadeIn>
          ) : null}
        </>
      )}
    </Page>
  )
}

/** `key: value` pairs on one line for the collapsed row. */
function preview(details: Record<string, unknown>) {
  return Object.entries(details)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ·  ")
}

function Actor({ actor }: { actor: string }) {
  const [kind, ...rest] = actor.split(":")
  const id = rest.join(":")
  if (!id) return <span className="font-mono text-xs">{actor}</span>
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="font-mono text-xs" />}>
        <span className="text-muted-foreground">{kind}:</span>
        {shortId(id, 8)}
      </TooltipTrigger>
      <TooltipContent className="font-mono">{actor}</TooltipContent>
    </Tooltip>
  )
}

function LogRow({
  entry: e,
  index,
  now,
  open,
  onToggle,
}: {
  entry: AuditEntry
  index: number
  now: number
  open: boolean
  onToggle: () => void
}) {
  const details = e.details ?? {}
  const keys = Object.keys(details)
  const hasDetails = keys.length > 0
  // Render the panel once it has been opened so it can animate closed.
  const [mounted, setMounted] = React.useState(open)
  if (open && !mounted) setMounted(true)

  return (
    <>
      <motion.tr
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: EASE_OUT, delay: Math.min(index, 14) * 0.025 }}
        onClick={hasDetails ? onToggle : undefined}
        className={cn(
          "group/row transition-colors hover:bg-muted/50",
          hasDetails && "cursor-pointer",
          open ? "bg-muted/40" : "border-b"
        )}
      >
        <TableCell className="w-8 pl-3">
          {hasDetails ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Hide details" : "Show details"}
              onClick={(ev) => {
                ev.stopPropagation()
                onToggle()
              }}
              className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <ChevronRightIcon className={cn("size-3.5 transition-transform duration-300 ease-(--ease-out-quint)", open && "rotate-90")} />
            </button>
          ) : null}
        </TableCell>
        <TableCell className="text-muted-foreground">
          <Tooltip>
            <TooltipTrigger render={<span className="cursor-default tabular-nums" />}>{now ? timeAgo(e.at, now) : formatTime(e.at)}</TooltipTrigger>
            <TooltipContent>{formatDateTime(e.at)}</TooltipContent>
          </Tooltip>
        </TableCell>
        <TableCell>
          <Actor actor={e.actor} />
        </TableCell>
        <TableCell>
          <ActionBadge action={e.action} details={details} />
        </TableCell>
        <TableCell className="max-w-72 truncate font-mono text-xs" title={e.target}>
          {e.target}
        </TableCell>
        <TableCell className="pr-4 text-right text-xs text-muted-foreground">
          {hasDetails ? (
            <span className="inline-block max-w-64 truncate align-middle font-mono">{preview(details)}</span>
          ) : (
            "–"
          )}
        </TableCell>
      </motion.tr>
      {hasDetails ? (
        <tr className={cn(open && "border-b bg-muted/40")}>
          <td colSpan={6} className="p-0">
            <Expand open={open}>
              {mounted ? (
                <div className="grid gap-3 px-4 pt-1 pb-4 pl-11 md:grid-cols-[14rem_1fr]">
                  <dl className="grid content-start gap-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">When</dt>
                      <dd className="tabular-nums">{formatDateTime(e.at)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Actor</dt>
                      <dd className="font-mono break-all">{e.actor}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Target</dt>
                      <dd className="font-mono break-all">{e.target}</dd>
                    </div>
                  </dl>
                  <CodeBlock code={JSON.stringify(details, null, 2)} label="details" className="bg-background" />
                </div>
              ) : null}
            </Expand>
          </td>
        </tr>
      ) : null}
    </>
  )
}
