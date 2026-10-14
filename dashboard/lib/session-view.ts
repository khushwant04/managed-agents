/**
 * Pure helpers for the sessions list and the session detail page: status
 * filters, search, which actions a status allows, per-run summaries and
 * event timing.
 */
import type { ApiEvent, SessionSummary } from "./api"
import type { TimelineItem, TokenUsage } from "./timeline"

export type StatusFilter = "all" | "running" | "idle" | "waiting" | "failed" | "terminated"

export const STATUS_FILTERS: readonly { value: StatusFilter; label: string; statuses: readonly string[] }[] = [
  { value: "all", label: "All", statuses: [] },
  { value: "running", label: "Running", statuses: ["running", "queued"] },
  { value: "idle", label: "Idle", statuses: ["idle"] },
  { value: "waiting", label: "Waiting", statuses: ["waiting_input", "approval_pending"] },
  { value: "failed", label: "Failed", statuses: ["failed"] },
  { value: "terminated", label: "Terminated", statuses: ["terminated"] },
]

export function isStatusFilter(v: unknown): v is StatusFilter {
  return STATUS_FILTERS.some((f) => f.value === v)
}

export function matchesStatus(status: string, filter: StatusFilter): boolean {
  if (filter === "all") return true
  return STATUS_FILTERS.find((f) => f.value === filter)!.statuses.includes(status)
}

/** Sessions matching a status filter and a free-text query (id, agent, alias or deployment). */
export function filterSessions<T extends Pick<SessionSummary, "id" | "agent" | "alias" | "status" | "deployment_id">>(
  sessions: readonly T[],
  { status = "all", query = "" }: { status?: StatusFilter; query?: string } = {}
): T[] {
  const q = query.trim().toLowerCase()
  return sessions.filter((s) => {
    if (!matchesStatus(s.status, status)) return false
    if (!q) return true
    return [s.id, s.agent, s.alias ? `${s.agent}@${s.alias}` : "", s.deployment_id ?? ""].some((v) => v.toLowerCase().includes(q))
  })
}

/** Count of sessions per status filter. */
export function countByFilter(sessions: readonly Pick<SessionSummary, "status">[]): Record<StatusFilter, number> {
  const out = Object.fromEntries(STATUS_FILTERS.map((f) => [f.value, 0])) as Record<StatusFilter, number>
  for (const s of sessions) {
    for (const f of STATUS_FILTERS) if (matchesStatus(s.status, f.value)) out[f.value] += 1
  }
  return out
}

export const isActiveStatus = (status: string | null | undefined) => status === "running" || status === "queued"

/** A user message can be sent (or steer the running turn) unless the session is gone. */
export const canSendMessage = (status: string | null | undefined) => status !== null && status !== undefined && status !== "terminated"

export const canInterrupt = isActiveStatus

export const canTerminate = (status: string | null | undefined) => status !== null && status !== undefined && status !== "terminated"

/** Milliseconds between two ISO timestamps, or null if either is missing. */
export function elapsedMs(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null
  const a = Date.parse(from)
  const b = Date.parse(to)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null
}

/** Timestamp of every event by seq, to time things the timeline joins (tool call → result). */
export function timesBySeq(events: readonly Pick<ApiEvent, "seq" | "ts">[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const e of events) if (e.ts) m.set(e.seq ?? 0, e.ts)
  return m
}

export interface RunSummary {
  runId: string
  /** 1-based position in the session. */
  index: number
  startedAt: string | undefined
  finishedAt: string | undefined
  durationMs: number | null
  /** Stop reason once finished, else null (still running). */
  stopReason: string | null
  usage: TokenUsage | null
  model: string | null
  error: string | undefined
}

/** One row per run, in order, from `run.started` / `run.finished` items. */
export function summarizeRuns(items: readonly TimelineItem[]): RunSummary[] {
  const byId = new Map<string, RunSummary>()
  const out: RunSummary[] = []
  const get = (runId: string): RunSummary => {
    let r = byId.get(runId)
    if (!r) {
      r = { runId, index: out.length + 1, startedAt: undefined, finishedAt: undefined, durationMs: null, stopReason: null, usage: null, model: null, error: undefined }
      byId.set(runId, r)
      out.push(r)
    }
    return r
  }
  for (const item of items) {
    if (!item.runId) continue
    if (item.kind === "run.started") get(item.runId).startedAt = item.ts
    else if (item.kind === "run.finished") {
      const r = get(item.runId)
      r.finishedAt = item.ts
      r.stopReason = item.stopReason
      r.usage = item.usage
      r.model = item.model ?? r.model
      r.error = item.error
    } else if (item.kind === "route" && item.model) get(item.runId).model ??= item.model
    else if (item.kind === "agent" && item.model) get(item.runId).model = item.model
  }
  for (const r of out) r.durationMs = elapsedMs(r.startedAt, r.finishedAt)
  return out
}

/** Distinct models seen in the session, in order of first use. */
export function modelsUsed(items: readonly TimelineItem[]): string[] {
  const seen = new Set<string>()
  for (const item of items) {
    const m = item.kind === "route" ? item.model : item.kind === "agent" || item.kind === "run.finished" ? item.model : null
    if (m) seen.add(m)
  }
  return [...seen]
}

/** Input plus output tokens of a usage record. */
export function totalTokens(u: TokenUsage | null | undefined): number {
  return u ? u.input_tokens + u.output_tokens : 0
}
