"use client"

import * as React from "react"
import Link from "next/link"
import { AnimatePresence, motion } from "motion/react"
import {
  ArrowRightIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileIcon,
  RouteIcon,
  ShieldAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AnimatedNumber, EASE_OUT, Expand } from "@/components/motion"
import { CodeBlock } from "@/components/code-block"
import { StatusBadge } from "@/components/status-badge"
import { seg } from "@/lib/client"
import { compactNumber, formatDuration, shortId, toDisplay } from "@/lib/format"
import type { AgentItem, RouteItem, TimelineItem, ToolItem } from "@/lib/timeline"
import { cn } from "@/lib/utils"
import type { RunState } from "./use-agent-run"

const item = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: EASE_OUT },
}

function preview(v: unknown, max = 80): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "")
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function ToolRow({ t }: { t: ToolItem }) {
  const [open, setOpen] = React.useState(false)
  const done = t.result !== null
  const failed = t.result?.isError
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-foreground/10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
      >
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
        <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs font-medium">{t.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{preview(t.arguments)}</span>
        {!done ? (
          <Spinner className="size-3.5 text-muted-foreground" />
        ) : failed ? (
          <XIcon className="size-3.5 text-destructive" />
        ) : (
          <CheckIcon className="size-3.5 text-success" />
        )}
      </button>
      <Expand open={open}>
        <div className="flex flex-col gap-2 border-t bg-muted/20 p-3">
          <CodeBlock code={toDisplay(t.arguments)} label="Arguments" />
          {t.result ? <CodeBlock code={toDisplay(t.result.content)} label={failed ? "Error" : "Result"} wrap /> : null}
        </div>
      </Expand>
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <BrainIcon className="size-3.5" />
        Thinking
        <ChevronRightIcon className={cn("size-3 transition-transform duration-200", open && "rotate-90")} />
      </button>
      <Expand open={open}>
        <p className="mt-1.5 border-l-2 pl-3 text-xs whitespace-pre-wrap text-muted-foreground">{text}</p>
      </Expand>
    </div>
  )
}

function Caret() {
  return <span aria-hidden className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-blink bg-foreground" />
}

function AgentText({ a, live }: { a: AgentItem; live: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {a.thinking ? <Thinking text={a.thinking} /> : null}
      {a.text || live ? (
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
          {a.text}
          {live ? <Caret /> : null}
        </p>
      ) : null}
    </div>
  )
}

function Entry({ it, live }: { it: TimelineItem; live: boolean }) {
  switch (it.kind) {
    case "agent":
      return <AgentText a={it} live={live} />
    case "tool":
      return <ToolRow t={it} />
    case "approval":
      return (
        <div className="flex items-center gap-2 rounded-lg bg-warning/8 px-3 py-2 text-sm ring-1 ring-warning/25">
          <ShieldAlertIcon className="size-4 text-warning" />
          <span>
            <span className="font-mono text-xs">{it.name}</span> {it.state === "pending" ? "is waiting for approval" : `was ${it.state}`}
          </span>
        </div>
      )
    case "subagent":
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <BotIcon className="size-3.5" />
          Subagent <span className="font-mono text-foreground">{it.agent ?? shortId(it.childSessionId)}</span>
          {it.finished ? "finished" : "started"}
          {!it.finished ? <Spinner className="size-3" /> : null}
        </div>
      )
    case "artifact":
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileIcon className="size-3.5" />
          Created <span className="font-mono text-foreground">{it.path}</span>
        </div>
      )
    case "error":
      return (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/6 px-3 py-2 text-sm ring-1 ring-destructive/20">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span className="break-words">{it.message}</span>
        </div>
      )
    default:
      return null
  }
}

function elapsed(items: TimelineItem[]): number | null {
  const ts = items.map((i) => (i.ts ? Date.parse(i.ts) : NaN)).filter(Number.isFinite)
  if (ts.length < 2) return null
  return Math.max(...ts) - Math.min(...ts)
}

/** Live view of one playground run: streaming text, tool calls, status and usage. */
export function RunOutput({ state, onDismiss }: { state: RunState; onDismiss: () => void }) {
  const { timeline, phase, accepted } = state
  const live = phase === "starting" || phase === "streaming"
  const visible = timeline.items.filter((i) => ["agent", "tool", "approval", "subagent", "artifact", "error"].includes(i.kind))
  const lastAgent = [...visible].reverse().find((i) => i.kind === "agent")
  const route = timeline.items.find((i): i is RouteItem => i.kind === "route")
  const finished = [...timeline.items].reverse().find((i) => i.kind === "run.finished")
  // A run that ended its turn reads better as "completed" than the session's "idle".
  const endedTurn = !live && finished?.kind === "run.finished" && finished.stopReason === "end_turn" && timeline.status === "idle"
  const status = endedTurn ? "completed" : (timeline.status ?? (phase === "error" ? "failed" : "queued"))
  const usage = timeline.usage
  const took = elapsed(timeline.items)

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <span className="text-sm font-medium">Output</span>
        <StatusBadge status={status} />
        {route || accepted ? (
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
            <RouteIcon className="size-3.5 shrink-0" />
            <span className="font-mono">
              {route?.agent ?? accepted?.agent}
              {(route?.alias ?? accepted?.alias) ? `@${route?.alias ?? accepted?.alias}` : ""} → v{route?.version ?? accepted?.version}
            </span>
            {route?.model ? <span className="hidden font-mono sm:inline">· {route.model}</span> : null}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {accepted ? (
            <Button variant="ghost" size="sm" render={<Link href={`/sessions/${seg(accepted.session_id)}`} />}>
              Open full session
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          ) : null}
          {!live ? (
            <Button variant="ghost" size="icon-sm" aria-label="Clear output" onClick={onDismiss}>
              <XIcon />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-24 flex-col gap-3 px-4 py-4" aria-live="polite">
        {state.input ? (
          <div className="self-end rounded-xl rounded-br-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap sm:max-w-[80%]">
            {state.input}
          </div>
        ) : null}
        {state.error && phase === "error" && !visible.length ? (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/6 px-3 py-2 text-sm ring-1 ring-destructive/20">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span className="break-words">{state.error}</span>
          </div>
        ) : null}
        {!visible.length && live ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-3.5" />
            {phase === "starting" ? "Starting session…" : "Waiting for the first token…"}
          </div>
        ) : null}
        <AnimatePresence initial={false}>
          {visible.map((it) => (
            <motion.div key={it.key} {...item}>
              <Entry it={it} live={live && it === lastAgent && !(it.kind === "agent" && it.done)} />
            </motion.div>
          ))}
        </AnimatePresence>
        {!live && phase === "settled" && !visible.length ? (
          <p className="text-sm text-muted-foreground">The run finished without a reply.</p>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {finished || (!live && phase !== "error" && usage.output_tokens > 0) ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
              {finished && finished.kind === "run.finished" ? (
                <Badge variant={finished.error ? "destructive" : "muted"} className="font-mono">
                  {finished.stopReason.replaceAll("_", " ")}
                </Badge>
              ) : null}
              <span className="tabular-nums">
                <AnimatedNumber value={usage.input_tokens} format={(n) => compactNumber(n)} className="font-medium text-foreground" /> input
              </span>
              <span className="tabular-nums">
                <AnimatedNumber value={usage.output_tokens} format={(n) => compactNumber(n)} className="font-medium text-foreground" /> output
              </span>
              {usage.cache_read_tokens ? (
                <span className="tabular-nums">
                  <AnimatedNumber value={usage.cache_read_tokens} format={(n) => compactNumber(n)} className="font-medium text-foreground" /> cached
                </span>
              ) : null}
              {took !== null ? <span className="ml-auto tabular-nums">{formatDuration(took)}</span> : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
