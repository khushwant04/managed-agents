import { describe, expect, it } from "vitest"
import type { ApiEvent } from "./api"
import {
  canInterrupt,
  canSendMessage,
  canTerminate,
  countByFilter,
  elapsedMs,
  filterSessions,
  isStatusFilter,
  modelsUsed,
  summarizeRuns,
  timesBySeq,
  totalTokens,
} from "./session-view"
import { buildTimeline } from "./timeline"

const sessions = [
  { id: "ses_aaa", agent: "code-reviewer", alias: "prod", status: "running", deployment_id: null },
  { id: "ses_bbb", agent: "support-triage", alias: null, status: "idle", deployment_id: "dep_123" },
  { id: "ses_ccc", agent: "code-reviewer", alias: "canary", status: "approval_pending", deployment_id: null },
  { id: "ses_ddd", agent: "data-analyst", alias: "prod", status: "queued", deployment_id: null },
  { id: "ses_eee", agent: "data-analyst", alias: "prod", status: "failed", deployment_id: null },
]

describe("filterSessions", () => {
  it("filters by status group", () => {
    expect(filterSessions(sessions, { status: "running" }).map((s) => s.id)).toEqual(["ses_aaa", "ses_ddd"])
    expect(filterSessions(sessions, { status: "waiting" }).map((s) => s.id)).toEqual(["ses_ccc"])
    expect(filterSessions(sessions, { status: "all" })).toHaveLength(5)
    expect(filterSessions(sessions)).toHaveLength(5)
  })

  it("searches ids, agent@alias and deployment, case-insensitively", () => {
    expect(filterSessions(sessions, { query: " SES_B " }).map((s) => s.id)).toEqual(["ses_bbb"])
    expect(filterSessions(sessions, { query: "reviewer@canary" }).map((s) => s.id)).toEqual(["ses_ccc"])
    expect(filterSessions(sessions, { query: "dep_1" }).map((s) => s.id)).toEqual(["ses_bbb"])
    expect(filterSessions(sessions, { query: "analyst", status: "failed" }).map((s) => s.id)).toEqual(["ses_eee"])
  })

  it("counts per filter", () => {
    expect(countByFilter(sessions)).toEqual({ all: 5, running: 2, idle: 1, waiting: 1, failed: 1, terminated: 0 })
  })

  it("recognises filter values", () => {
    expect(isStatusFilter("waiting")).toBe(true)
    expect(isStatusFilter("nope")).toBe(false)
    expect(isStatusFilter(null)).toBe(false)
  })
})

describe("status actions", () => {
  it("allows input unless terminated or unknown", () => {
    expect(canSendMessage("idle")).toBe(true)
    expect(canSendMessage("running")).toBe(true)
    expect(canSendMessage("terminated")).toBe(false)
    expect(canSendMessage(null)).toBe(false)
  })
  it("interrupts only in-flight runs and terminates anything not yet terminated", () => {
    expect(canInterrupt("running")).toBe(true)
    expect(canInterrupt("queued")).toBe(true)
    expect(canInterrupt("idle")).toBe(false)
    expect(canTerminate("failed")).toBe(true)
    expect(canTerminate("terminated")).toBe(false)
  })
})

const ev = (seq: number, type: ApiEvent["type"], payload: Record<string, unknown>, opts: { run?: string; ms?: number; model?: string } = {}): ApiEvent => ({
  id: `evt_${seq}`,
  session_id: "s",
  run_id: opts.run ?? null,
  seq,
  type,
  ts: new Date(1_700_000_000_000 + (opts.ms ?? seq * 100)).toISOString(),
  model: opts.model ?? null,
  payload,
})

const events: ApiEvent[] = [
  ev(1, "route.resolved", { agent: "a", model: "claude-x" }, { run: "r1", ms: 0 }),
  ev(2, "run.started", {}, { run: "r1", ms: 10 }),
  ev(3, "message.agent.delta", { text: "hi" }, { run: "r1", ms: 20, model: "claude-x" }),
  ev(4, "tool.call", { id: "c1", name: "search", arguments: {} }, { run: "r1", ms: 30 }),
  ev(5, "tool.result", { id: "c1", content: "ok" }, { run: "r1", ms: 530 }),
  ev(6, "run.finished", { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 4 } }, { run: "r1", ms: 1010, model: "claude-x" }),
  ev(7, "run.started", {}, { run: "r2", ms: 2000 }),
  ev(8, "message.agent.delta", { text: "again" }, { run: "r2", ms: 2100, model: "claude-y" }),
]

describe("runs and timing", () => {
  const tl = buildTimeline(events)

  it("summarises runs in order, open runs without a stop reason", () => {
    const runs = summarizeRuns(tl.items)
    expect(runs.map((r) => [r.runId, r.index, r.stopReason, r.durationMs, r.model])).toEqual([
      ["r1", 1, "end_turn", 1000, "claude-x"],
      ["r2", 2, null, null, "claude-y"],
    ])
    expect(runs[0]!.usage).toEqual({ input_tokens: 10, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0 })
  })

  it("lists distinct models", () => {
    expect(modelsUsed(tl.items)).toEqual(["claude-x", "claude-y"])
  })

  it("times a tool call to its result through the seq map", () => {
    const times = timesBySeq(events)
    const tool = tl.items.find((i) => i.kind === "tool")!
    expect(tool.kind === "tool" && elapsedMs(tool.ts, times.get(tool.result!.seq))).toBe(500)
    expect(elapsedMs(undefined, "2024-01-01T00:00:00Z")).toBeNull()
    expect(elapsedMs("garbage", "2024-01-01T00:00:00Z")).toBeNull()
  })

  it("totals tokens", () => {
    expect(totalTokens({ input_tokens: 3, output_tokens: 2, cache_read_tokens: 9, cache_write_tokens: 0 })).toBe(5)
    expect(totalTokens(null)).toBe(0)
  })
})
