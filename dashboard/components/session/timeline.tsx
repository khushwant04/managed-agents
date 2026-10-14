"use client"

import * as React from "react"
import Link from "next/link"
import { AnimatePresence, motion } from "motion/react"
import {
  ArrowUpRightIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  DownloadIcon,
  FileIcon,
  FlagIcon,
  PlayIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  SignpostIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AgentArt } from "@/components/agent-art"
import { CodeBlock } from "@/components/code-block"
import { EASE_OUT, Expand } from "@/components/motion"
import { StatusBadge } from "@/components/status-badge"
import { proxyUrl, seg } from "@/lib/client"
import { compactNumber, formatBytes, formatDuration, formatNumber, formatTime, shortId, toDisplay } from "@/lib/format"
import { elapsedMs, summarizeRuns } from "@/lib/session-view"
import type {
  AgentItem,
  ApprovalItem,
  ErrorItem,
  RunFinishedItem,
  SubagentItem,
  TimelineItem,
  TokenUsage,
  ToolItem,
} from "@/lib/timeline"
import { cn } from "@/lib/utils"

export type Decide = (callId: string, approved: boolean, reason: string) => Promise<void>

interface Ctx {
  sessionId: string
  agent: string | undefined
  /** The stream is live: unfinished agent text shows a caret, unanswered tools a spinner. */
  live: boolean
  /** Approve/deny handler; omitted when read-only (replay, viewer keys). */
  onDecide?: Decide
  /** Event timestamps by seq, to time tool calls. */
  times: Map<number, string>
  runIndex: Map<string, number>
}

const TimelineCtx = React.createContext<Ctx | null>(null)
const useCtx = () => React.useContext(TimelineCtx)!

/** Element id of a run's divider, so the side panel can scroll to it. */
export const runAnchor = (runId: string) => `run-${runId}`

export function Timeline({
  items,
  sessionId,
  agent,
  live,
  onDecide,
  times,
  highlightLast = false,
}: {
  items: TimelineItem[]
  sessionId: string
  agent?: string
  live: boolean
  onDecide?: Decide
  times: Map<number, string>
  highlightLast?: boolean
}) {
  // Items present on first render stagger in; later ones animate as they arrive.
  const [initialCount] = React.useState(items.length)
  const runIndex = React.useMemo(() => new Map(summarizeRuns(items).map((r) => [r.runId, r.index])), [items])
  const ctx = React.useMemo<Ctx>(
    () => ({ sessionId, agent, live, onDecide, times, runIndex }),
    [sessionId, agent, live, onDecide, times, runIndex]
  )
  return (
    <TimelineCtx.Provider value={ctx}>
      <ol className="flex flex-col" aria-label="Session timeline">
        <AnimatePresence initial>
          {items.map((item, i) => (
            <motion.li
              key={item.key}
              data-seq={item.seq}
              initial={{ opacity: 0, y: 10 }}
              animate={{
                opacity: 1,
                y: 0,
                transition: { duration: 0.4, ease: EASE_OUT, delay: i < initialCount ? Math.min(i, 14) * 0.025 : 0 },
              }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              className={cn(
                "group/item relative grid grid-cols-1 gap-x-4 rounded-lg sm:grid-cols-[4rem_minmax(0,1fr)]",
                SPACING[item.kind],
                highlightLast && i === items.length - 1 && "before:absolute before:inset-y-1 before:-left-2 before:w-0.5 before:rounded-full before:bg-info"
              )}
            >
              <ItemTime item={item} />
              <div className="min-w-0">
                <ItemBody item={item} />
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </TimelineCtx.Provider>
  )
}

const SPACING: Record<TimelineItem["kind"], string> = {
  route: "py-1",
  status: "py-1",
  "run.started": "pt-5 pb-2 first:pt-0",
  "run.finished": "pt-2 pb-4",
  user: "py-2.5",
  agent: "py-2.5",
  tool: "py-1.5",
  approval: "py-2",
  subagent: "py-1.5",
  artifact: "py-1.5",
  error: "py-2",
}

/** Bookkeeping items the timeline can hide to show just the conversation. */
export const QUIET_KINDS = new Set<TimelineItem["kind"]>(["route", "status"])

function ItemTime({ item }: { item: TimelineItem }) {
  if (!item.ts) return <span className="hidden sm:block" />
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            dateTime={item.ts}
            className={cn(
              "hidden pt-[3px] text-right font-mono text-[11px] text-muted-foreground/70 tabular-nums transition-colors group-hover/item:text-muted-foreground sm:block",
              item.kind === "run.started" && "pt-0 leading-5",
              (item.kind === "user" || item.kind === "agent") && "pt-1"
            )}
          />
        }
      >
        {formatTime(item.ts)}
      </TooltipTrigger>
      <TooltipContent side="left">
        seq {item.seq} · {item.ts}
      </TooltipContent>
    </Tooltip>
  )
}

function ItemBody({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "route":
      return (
        <Meta icon={SignpostIcon}>
          Routed to{" "}
          <span className="font-mono text-foreground">
            {item.agent ?? "agent"}
            {item.alias ? `@${item.alias}` : ""}
          </span>{" "}
          → v{item.version ?? "?"}
          {item.model ? (
            <Badge variant="outline" className="ml-1 font-mono text-[11px] font-normal">
              {item.model}
            </Badge>
          ) : null}
        </Meta>
      )
    case "status":
      return (
        <Meta icon={FlagIcon}>
          Status <span className="font-medium text-foreground capitalize">{item.status.replaceAll("_", " ")}</span>
          {Object.entries(item.detail).map(([k, v]) => (
            <span key={k} className="text-muted-foreground">
              · {k.replaceAll("_", " ")} {typeof v === "string" ? v : JSON.stringify(v)}
            </span>
          ))}
        </Meta>
      )
    case "run.started":
      return <RunStart runId={item.runId} />
    case "run.finished":
      return <RunFinish item={item} />
    case "user":
      return (
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {item.steering ? (
              <Badge variant="info" className="rounded-md">
                steering
              </Badge>
            ) : null}
            User
          </div>
          <div className="max-w-[min(85%,36rem)] rounded-2xl rounded-tr-md bg-muted px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap ring-1 ring-foreground/5">
            {item.text}
          </div>
        </div>
      )
    case "agent":
      return <AgentMessage item={item} />
    case "tool":
      return <ToolCard item={item} />
    case "approval":
      return <ApprovalCard item={item} />
    case "subagent":
      return <SubagentCard item={item} />
    case "artifact":
      return <ArtifactRow item={item} />
    case "error":
      return <ErrorCard item={item} />
  }
}

function Meta({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0 opacity-70" />
      {children}
    </div>
  )
}

function RunStart({ runId }: { runId: string | null }) {
  const { runIndex } = useCtx()
  const n = runId ? runIndex.get(runId) : undefined
  return (
    <div id={runId ? runAnchor(runId) : undefined} className="flex scroll-mt-24 items-center gap-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <PlayIcon className="size-3 fill-current opacity-60" />
        Run {n ?? ""}
      </span>
      {runId ? <span className="font-mono text-[11px]">{shortId(runId, 10)}</span> : null}
      <span className="h-px flex-1 bg-linear-to-r from-border to-transparent" />
    </div>
  )
}

export function UsageText({ usage, className }: { usage: TokenUsage; className?: string }) {
  return (
    <span className={cn("tabular-nums", className)}>
      {formatNumber(usage.input_tokens)} in · {formatNumber(usage.output_tokens)} out
      {usage.cache_read_tokens ? ` · ${compactNumber(usage.cache_read_tokens)} cached` : ""}
    </span>
  )
}

function RunFinish({ item }: { item: RunFinishedItem }) {
  const ok = item.stopReason === "end_turn" || item.stopReason === "stop_sequence"
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="h-px w-4 bg-border" />
        <Badge variant={ok ? "muted" : item.stopReason === "error" ? "destructive" : "warning"} className="rounded-md font-mono text-[11px]">
          {item.stopReason}
        </Badge>
        {item.usage ? <UsageText usage={item.usage} /> : null}
        {item.model ? <span className="font-mono text-[11px]">· {item.model}</span> : null}
        {item.pendingApprovals ? (
          <span className="text-warning">
            · {item.pendingApprovals} approval{item.pendingApprovals === 1 ? "" : "s"} pending
          </span>
        ) : null}
        <span className="h-px flex-1 bg-linear-to-r from-border to-transparent" />
      </div>
      {item.error ? (
        <p className="rounded-lg bg-destructive/6 px-3 py-2 text-xs text-destructive ring-1 ring-destructive/20">{item.error}</p>
      ) : null}
    </div>
  )
}

function Caret() {
  return <span aria-hidden className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-blink rounded-full bg-foreground" />
}

function AgentMessage({ item }: { item: AgentItem }) {
  const { live, agent } = useCtx()
  const streaming = live && !item.done
  const [showThinking, setShowThinking] = React.useState(false)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <AgentArt name={agent ?? "agent"} className="size-5 rounded-full ring-1 ring-foreground/10" />
        <span className="font-medium text-foreground">{agent ?? "Agent"}</span>
        {item.model ? <span className="font-mono text-[11px]">{item.model}</span> : null}
        <AnimatePresence>
          {streaming ? (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1 text-info">
              <span className="size-1.5 animate-pulse rounded-full bg-info" />
              streaming
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
      {item.thinking ? (
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => setShowThinking((s) => !s)}
            aria-expanded={showThinking}
            className="flex w-fit items-center gap-1.5 rounded-md py-0.5 pr-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <BrainIcon className="size-3.5" />
            {streaming && !item.text ? <span className="animate-pulse">Thinking…</span> : "Thought process"}
            <span className="text-muted-foreground/70 tabular-nums">· {compactNumber(item.thinking.length)} chars</span>
            <ChevronRightIcon className={cn("size-3.5 transition-transform duration-200", showThinking && "rotate-90")} />
          </button>
          <Expand open={showThinking}>
            <div className="mt-1.5 ml-1.5 border-l-2 pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground italic">
              {item.thinking}
            </div>
          </Expand>
        </div>
      ) : null}
      {item.text || streaming ? (
        <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">
          {item.text.trimEnd()}
          {streaming ? <Caret /> : null}
        </div>
      ) : null}
    </div>
  )
}

function oneLine(value: unknown, max = 90): string {
  if (value === undefined || value === null) return ""
  const s = typeof value === "string" ? value : JSON.stringify(value)
  if (!s || s === "{}") return ""
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function ToolCard({ item }: { item: ToolItem }) {
  const { live, times } = useCtx()
  const res = item.result
  const [open, setOpen] = React.useState(res?.isError ?? false)
  const duration = res ? elapsedMs(item.ts, times.get(res.seq)) : null
  const preview = oneLine(item.arguments)
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-foreground/10 transition-shadow duration-300 hover:shadow-card-hover",
        res?.isError && "ring-destructive/30"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
            res?.isError && "bg-destructive/10 text-destructive"
          )}
        >
          <WrenchIcon className="size-3.5" />
        </span>
        <span className="shrink-0 font-mono text-[13px] font-medium">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{preview}</span>
        {duration !== null ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDuration(duration)}</span> : null}
        <ToolState item={item} live={live} />
        <ChevronRightIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
      </button>
      <Expand open={open}>
        <div className="flex flex-col gap-3 border-t p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Call</span>
            <span className="font-mono">{item.callId}</span>
          </div>
          {item.arguments !== undefined ? <CodeBlock code={toDisplay(item.arguments) || "{}"} label="Arguments" wrap /> : null}
          {res ? (
            <CodeBlock
              code={toDisplay(res.content) || "(empty)"}
              label={<span className={cn(res.isError && "text-destructive")}>{res.isError ? "Error result" : "Result"}</span>}
              wrap
              className={cn(res.isError && "bg-destructive/5 ring-destructive/20")}
            />
          ) : (
            <p className="text-xs text-muted-foreground">{live ? "Waiting for the result…" : "No result was recorded."}</p>
          )}
        </div>
      </Expand>
    </div>
  )
}

function ToolState({ item, live }: { item: ToolItem; live: boolean }) {
  const res = item.result
  if (res?.isError)
    return (
      <Badge variant="destructive" className="shrink-0 rounded-md">
        <XIcon />
        error
      </Badge>
    )
  if (res)
    return (
      <Badge variant="success" className="shrink-0 rounded-md">
        <CheckIcon />
        done
      </Badge>
    )
  return live ? (
    <Badge variant="info" className="shrink-0 rounded-md">
      <Spinner className="size-3" />
      running
    </Badge>
  ) : (
    <Badge variant="muted" className="shrink-0 rounded-md">
      no result
    </Badge>
  )
}

function ApprovalCard({ item }: { item: ApprovalItem }) {
  const { onDecide } = useCtx()
  const [reason, setReason] = React.useState("")
  const [busy, setBusy] = React.useState<"approve" | "deny" | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const pending = item.state === "pending"

  const decide = async (approved: boolean) => {
    if (!onDecide) return
    setBusy(approved ? "approve" : "deny")
    setError(null)
    try {
      await onDecide(item.callId, approved, reason)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const Icon = pending ? ShieldAlertIcon : item.state === "approved" ? ShieldCheckIcon : ShieldXIcon
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl p-3.5 ring-1 transition-colors duration-500",
        pending ? "bg-warning/8 ring-warning/35 shadow-card" : "bg-card ring-foreground/10"
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-lg",
            pending ? "bg-warning/15 text-warning" : item.state === "approved" ? "bg-success/12 text-success" : "bg-destructive/10 text-destructive"
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">
            {pending ? "Approval required" : item.state === "approved" ? "Tool call approved" : "Tool call denied"}
          </span>
          <span className="text-xs text-muted-foreground">
            <span className="font-mono">{item.name}</span>
            {item.actor ? ` · by ${item.actor}` : ""}
          </span>
        </div>
        <Badge variant={pending ? "warning" : item.state === "approved" ? "success" : "destructive"} className="ml-auto rounded-md capitalize">
          {item.state}
        </Badge>
      </div>
      {item.arguments !== undefined ? <CodeBlock code={toDisplay(item.arguments) || "{}"} wrap className="bg-background/60" /> : null}
      {item.reason ? <p className="text-xs text-muted-foreground">Reason: {item.reason}</p> : null}
      {pending && onDecide ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="Reason (optional)"
            aria-label="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="bg-background sm:flex-1"
          />
          <div className="flex gap-2">
            <Button onClick={() => decide(true)} disabled={busy !== null} className="flex-1">
              {busy === "approve" ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
              Approve
            </Button>
            <Button variant="destructive" onClick={() => decide(false)} disabled={busy !== null} className="flex-1">
              {busy === "deny" ? <Spinner data-icon="inline-start" /> : <XIcon data-icon="inline-start" />}
              Deny
            </Button>
          </div>
        </div>
      ) : pending ? (
        <p className="text-xs text-muted-foreground">Waiting for a developer to approve or deny this call.</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function SubagentCard({ item }: { item: SubagentItem }) {
  const { live } = useCtx()
  return (
    <div className="flex items-start gap-3 rounded-xl bg-card p-3 shadow-card ring-1 ring-foreground/10">
      {item.agent ? (
        <AgentArt name={item.agent} className="size-8 shrink-0 rounded-lg" />
      ) : (
        <span className="flex size-8 items-center justify-center rounded-lg bg-muted">
          <BotIcon className="size-4" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Subagent</span>
          <span className="text-sm font-medium">{item.agent ?? "agent"}</span>
          {item.finished ? (
            <StatusBadge status={item.stopReason ?? "completed"} />
          ) : live ? (
            <StatusBadge status="running" />
          ) : (
            <StatusBadge status="unknown" />
          )}
        </div>
        {item.task ? <p className="line-clamp-3 text-xs text-muted-foreground">{item.task}</p> : null}
      </div>
      {item.childSessionId ? (
        <Button variant="outline" size="sm" render={<Link href={`/sessions/${seg(item.childSessionId)}`} />}>
          Open
          <ArrowUpRightIcon data-icon="inline-end" />
        </Button>
      ) : null}
    </div>
  )
}

function ArtifactRow({ item }: { item: TimelineItem & { kind: "artifact" } }) {
  const { sessionId } = useCtx()
  return (
    <div className="flex items-center gap-3 rounded-xl bg-card px-3 py-2 shadow-card ring-1 ring-foreground/10">
      <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <FileIcon className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-[13px]" title={item.path}>
          {item.path}
        </span>
        <span className="text-xs text-muted-foreground">
          Artifact{item.size !== undefined ? ` · ${formatBytes(item.size)}` : ""}
        </span>
      </div>
      {item.artifactId ? (
        <Button
          variant="ghost"
          size="sm"
          render={<a href={proxyUrl(`/v1/sessions/${seg(sessionId)}/artifacts/${seg(item.artifactId)}`)} download />}
        >
          <DownloadIcon data-icon="inline-start" />
          Download
        </Button>
      ) : null}
    </div>
  )
}

function ErrorCard({ item }: { item: ErrorItem }) {
  const fatal = item.fatal
  const Icon = fatal ? CircleAlertIcon : TriangleAlertIcon
  return (
    <div
      role={fatal ? "alert" : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-xl p-3 ring-1",
        fatal ? "bg-destructive/6 ring-destructive/25" : "bg-warning/6 ring-warning/25"
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4", fatal ? "text-destructive" : "text-warning")} />
        <span className={cn("text-sm font-medium", fatal ? "text-destructive" : "text-warning")}>{fatal ? "Error" : "Warning"}</span>
        {item.errorKind ? (
          <Badge variant="outline" className="rounded-md font-mono text-[11px] font-normal">
            {item.errorKind}
          </Badge>
        ) : null}
      </div>
      <p className="text-sm break-words whitespace-pre-wrap">{item.message}</p>
      {Object.keys(item.detail).length ? <CodeBlock code={toDisplay(item.detail)} wrap className="bg-background/60" /> : null}
    </div>
  )
}
