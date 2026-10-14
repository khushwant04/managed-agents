import { describe, expect, it } from "vitest";
import type { ApiEvent, EventType } from "./api";
import { applyEvent, applyEvents, buildTimeline, emptyTimeline, mergeEvents, type AgentItem, type ApprovalItem, type ToolItem } from "./timeline";

let seq = 0;
function ev(type: EventType, payload: Record<string, unknown> = {}, extra: Partial<ApiEvent> = {}): ApiEvent {
  seq += 1;
  return { id: `evt_${seq}`, session_id: "ses_1", run_id: "run_1", seq, type, ts: new Date(1_700_000_000_000 + seq * 100).toISOString(), payload, ...extra };
}

function session(): ApiEvent[] {
  seq = 0;
  return [
    ev("route.resolved", { agent: "bot", alias: "prod", version: 3, model: "claude-opus-5-5" }, { model: "claude-opus-5-5" }),
    ev("session.status", { status: "queued" }),
    ev("session.status", { status: "running" }),
    ev("run.started", { agent: "bot" }),
    ev("message.user", { text: "hello" }),
    ev("thinking.delta", { text: "Let me " }, { model: "m1" }),
    ev("thinking.delta", { text: "think." }, { model: "m1" }),
    ev("message.agent.delta", { text: "Hi" }, { model: "m1" }),
    ev("message.agent.delta", { text: " there" }, { model: "m1" }),
    ev("message.agent.done", { text: "Hi there" }, { model: "m1" }),
    ev("tool.call", { id: "call_1", name: "bash", arguments: { cmd: "ls" } }),
    ev("tool.result", { id: "call_1", name: "bash", content: "a\nb", is_error: false }),
    ev("tool.call", { id: "call_2", name: "deploy", arguments: { env: "prod" } }),
    ev("tool.approval.requested", { call_id: "call_2", name: "deploy", arguments: { env: "prod" } }),
    ev("run.finished", { stop_reason: "approval_pending", usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 0 }, pending_approvals: [{ call_id: "call_2" }] }),
    ev("session.status", { status: "approval_pending" }),
  ];
}

describe("buildTimeline", () => {
  it("folds a run into route, status, user, agent, tool and approval items", () => {
    const t = buildTimeline(session());
    expect(t.items.map((i) => i.kind)).toEqual([
      "route",
      "status",
      "status",
      "run.started",
      "user",
      "agent",
      "tool",
      "tool",
      "approval",
      "run.finished",
      "status",
    ]);
    const agent = t.items[5] as AgentItem;
    expect(agent).toMatchObject({ text: "Hi there", thinking: "Let me think.", done: true, model: "m1", deltas: 2 });
    const tool = t.items[6] as ToolItem;
    expect(tool.result).toMatchObject({ content: "a\nb", isError: false });
    expect((t.items[7] as ToolItem).result).toBeNull();
    expect(t.items[8]).toMatchObject({ kind: "approval", callId: "call_2", state: "pending" });
    expect(t.pendingApprovals).toEqual(["call_2"]);
    expect(t.status).toBe("approval_pending");
    expect(t.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 0 });
    expect(t.lastSeq).toBe(16);
    expect(t.count).toBe(16);
  });

  it("splits agent text at tool calls and starts a new message for later deltas", () => {
    seq = 0;
    const t = buildTimeline([
      ev("message.agent.delta", { text: "first" }),
      ev("tool.call", { id: "c", name: "x", arguments: {} }),
      ev("tool.result", { id: "c", content: "boom", is_error: true }),
      ev("message.agent.delta", { text: "second" }),
      ev("run.finished", { stop_reason: "end_turn", usage: {} }),
    ]);
    const agents = t.items.filter((i): i is AgentItem => i.kind === "agent");
    expect(agents.map((a) => [a.text, a.done])).toEqual([
      ["first", true],
      ["second", true],
    ]);
    expect((t.items[1] as ToolItem).result?.isError).toBe(true);
  });

  it("keeps deltas of concurrent runs apart", () => {
    seq = 0;
    const t = buildTimeline([
      ev("message.agent.delta", { text: "A1" }, { run_id: "a" }),
      ev("message.agent.delta", { text: "B1" }, { run_id: "b" }),
      ev("message.agent.delta", { text: "A2" }, { run_id: "a" }),
    ]);
    expect(t.items.map((i) => (i as AgentItem).text)).toEqual(["A1A2", "B1"]);
  });

  it("creates an agent message from done alone (non-streaming models) and skips empty ones", () => {
    seq = 0;
    const t = buildTimeline([ev("message.agent.done", { text: "whole answer" }), ev("message.agent.done", { text: "" })]);
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: "agent", text: "whole answer", done: true });
  });

  it("joins subagent start and finish, and records artifacts and errors", () => {
    seq = 0;
    const t = buildTimeline([
      ev("subagent.started", { child_session_id: "ses_child", task: "dig" }),
      ev("artifact.created", { id: "art_1", path: "/workspace/outputs/report.md", size: 120, sha256: "abc" }),
      ev("subagent.finished", { child_session_id: "ses_child", agent: "subagent", stop_reason: "end_turn" }),
      ev("error", { kind: "model_fallback", message: "overloaded", from: "a", to: "b", fatal: false }),
    ]);
    expect(t.items).toHaveLength(3);
    expect(t.items[0]).toMatchObject({ kind: "subagent", childSessionId: "ses_child", task: "dig", finished: true, stopReason: "end_turn", agent: "subagent" });
    expect(t.items[1]).toMatchObject({ kind: "artifact", artifactId: "art_1", path: "/workspace/outputs/report.md", size: 120 });
    expect(t.items[2]).toMatchObject({ kind: "error", errorKind: "model_fallback", fatal: false, detail: { from: "a", to: "b" } });
  });

  it("ignores duplicate and older seqs", () => {
    const events = session();
    const t = buildTimeline([...events, ...events.slice(10)]);
    expect(t.count).toBe(16);
    expect(t.items).toHaveLength(11);
  });
});

describe("status", () => {
  it("derives the session status from run.finished until a status event says otherwise", () => {
    seq = 0;
    const base = [ev("session.status", { status: "running" }), ev("run.finished", { stop_reason: "end_turn", usage: {} })];
    expect(buildTimeline(base).status).toBe("idle");
    expect(buildTimeline([...base, ev("session.status", { status: "queued" })]).status).toBe("queued");
    seq = 0;
    expect(buildTimeline([ev("run.finished", { stop_reason: "error" })]).status).toBe("failed");
    seq = 0;
    expect(buildTimeline([ev("session.status", { status: "terminated" }), ev("run.finished", { stop_reason: "interrupted" })]).status).toBe("terminated");
  });
});

describe("applyEvent", () => {
  it("does not mutate the previous state and matches buildTimeline", () => {
    const events = session();
    let state = emptyTimeline();
    const snapshots: string[] = [];
    const states = [state];
    for (const e of events) {
      state = applyEvent(state, e);
      states.push(state);
      snapshots.push(JSON.stringify(state));
    }
    // Earlier snapshots are untouched by later events.
    states.slice(1).forEach((s, i) => expect(JSON.stringify(s)).toBe(snapshots[i]));
    expect(state).toEqual(buildTimeline(events));
  });

  it("returns the same object for a duplicate event", () => {
    const events = session();
    const t = buildTimeline(events);
    expect(applyEvent(t, events[3]!)).toBe(t);
  });

  it("resolves an approval when the decision arrives", () => {
    const events = session();
    seq = 16;
    let t = buildTimeline(events);
    const before = t;
    t = applyEvent(t, ev("tool.approval.decided", { call_id: "call_2", approved: false, reason: "not now", actor: "key:admin" }));
    const item = t.items.find((i): i is ApprovalItem => i.kind === "approval")!;
    expect(item).toMatchObject({ state: "denied", reason: "not now", actor: "key:admin" });
    expect(t.pendingApprovals).toEqual([]);
    expect(before.pendingApprovals).toEqual(["call_2"]);
    expect((before.items.find((i) => i.kind === "approval") as ApprovalItem).state).toBe("pending");
  });
});

describe("applyEvents / mergeEvents", () => {
  it("applies a batch in seq order, skipping seen events", () => {
    const events = session();
    const half = buildTimeline(events.slice(0, 8));
    const shuffled = [...events.slice(5)].reverse();
    expect(applyEvents(half, shuffled)).toEqual(buildTimeline(events));
  });

  it("merges history and live events without duplicates", () => {
    const events = session();
    const merged = mergeEvents(events.slice(0, 10), events.slice(8));
    expect(merged.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
    expect(mergeEvents(merged, [])).toBe(merged);
    const outOfOrder = mergeEvents(events.slice(0, 2), [events[4]!, events[3]!, events[2]!]);
    expect(outOfOrder.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});
