/**
 * Session timeline view model: folds the event log into renderable items.
 *
 * - `message.agent.delta` / `thinking.delta` events within a run are
 *   concatenated into one agent message until `message.agent.done` (or a tool
 *   call) closes it; the `done` text is authoritative when present.
 * - `tool.call` and `tool.result` are joined by call id.
 * - `tool.approval.requested` / `decided` become one approval item.
 * - `subagent.started` / `finished` are joined by child session id.
 * - Events at or below the last applied `seq` are ignored, so history and a
 *   live stream can overlap safely.
 *
 * `applyEvent` is immutable (safe for React state); `buildTimeline` folds a
 * whole list using a private mutable draft for speed.
 */
import type { ApiEvent } from "./api";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

interface Base {
  /** Stable React key (seq of the event that created the item). */
  key: string;
  seq: number;
  ts: string | undefined;
  runId: string | null;
}

export interface RouteItem extends Base {
  kind: "route";
  agent: string | undefined;
  alias: string | undefined;
  version: number | undefined;
  model: string | undefined;
}
export interface StatusItem extends Base {
  kind: "status";
  status: string;
  detail: Record<string, unknown>;
}
export interface RunStartItem extends Base {
  kind: "run.started";
  agent: string | undefined;
}
export interface RunFinishedItem extends Base {
  kind: "run.finished";
  stopReason: string;
  usage: TokenUsage | null;
  error: string | undefined;
  pendingApprovals: number;
  model: string | null;
}
export interface UserItem extends Base {
  kind: "user";
  text: string;
  steering: boolean;
}
export interface AgentItem extends Base {
  kind: "agent";
  text: string;
  thinking: string;
  done: boolean;
  model: string | null;
  deltas: number;
}
export interface ToolItem extends Base {
  kind: "tool";
  callId: string;
  name: string;
  arguments: unknown;
  result: { content: unknown; isError: boolean; seq: number } | null;
}
export interface ApprovalItem extends Base {
  kind: "approval";
  callId: string;
  name: string;
  arguments: unknown;
  state: "pending" | "approved" | "denied";
  reason: string | null;
  actor: string | null;
}
export interface SubagentItem extends Base {
  kind: "subagent";
  childSessionId: string;
  agent: string | undefined;
  task: string | undefined;
  finished: boolean;
  stopReason: string | undefined;
}
export interface ArtifactItem extends Base {
  kind: "artifact";
  artifactId: string | undefined;
  path: string;
  size: number | undefined;
  sha256: string | undefined;
}
export interface ErrorItem extends Base {
  kind: "error";
  message: string;
  errorKind: string | undefined;
  fatal: boolean;
  detail: Record<string, unknown>;
}

export type TimelineItem =
  | RouteItem
  | StatusItem
  | RunStartItem
  | RunFinishedItem
  | UserItem
  | AgentItem
  | ToolItem
  | ApprovalItem
  | SubagentItem
  | ArtifactItem
  | ErrorItem;

export interface TimelineState {
  items: TimelineItem[];
  /** Highest seq applied; -1 before any event. */
  lastSeq: number;
  /** Number of events applied (ignoring duplicates). */
  count: number;
  /** Latest `session.status` value. */
  status: string | null;
  /** Index of the open (still streaming) agent message per run id. */
  openAgent: Record<string, number>;
  toolIndex: Record<string, number>;
  approvalIndex: Record<string, number>;
  subagentIndex: Record<string, number>;
  /** Summed usage over all finished runs. */
  usage: TokenUsage;
  /** Call ids still waiting for a decision. */
  pendingApprovals: string[];
}

export function emptyTimeline(): TimelineState {
  return {
    items: [],
    lastSeq: -1,
    count: 0,
    status: null,
    openAgent: {},
    toolIndex: {},
    approvalIndex: {},
    subagentIndex: {},
    usage: zeroUsage(),
    pendingApprovals: [],
  };
}

function zeroUsage(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Session status implied by a run's stop reason (mirrors the worker). A later
 * `session.status` event overrides it; this keeps the view right when a run
 * finishes without one.
 */
export const STATUS_AFTER_STOP: Record<string, string> = {
  end_turn: "idle",
  budget: "idle",
  interrupted: "idle",
  approval_pending: "approval_pending",
  needs_input: "waiting_input",
  error: "failed",
};

export function parseUsage(v: unknown): TokenUsage | null {
  if (!v || typeof v !== "object") return null;
  const u = v as Record<string, unknown>;
  return {
    input_tokens: num(u.input_tokens) ?? 0,
    output_tokens: num(u.output_tokens) ?? 0,
    cache_read_tokens: num(u.cache_read_tokens) ?? 0,
    cache_write_tokens: num(u.cache_write_tokens) ?? 0,
  };
}

/**
 * Mutable draft used by both entry points. In immutable mode, every container
 * and item it touches is copied first so the previous state is left intact.
 */
class Draft {
  constructor(
    readonly s: TimelineState,
    private readonly immutable: boolean,
  ) {}

  private copiedItems = false;
  private copiedMaps = new Set<string>();
  private copiedItemIdx = new Set<number>();

  static from(prev: TimelineState, immutable: boolean): Draft {
    return new Draft(immutable ? { ...prev } : prev, immutable);
  }

  push(item: TimelineItem): number {
    this.items();
    this.s.items.push(item);
    const idx = this.s.items.length - 1;
    this.copiedItemIdx.add(idx);
    return idx;
  }

  /** Get an item for in-place modification. */
  edit<T extends TimelineItem>(idx: number): T {
    this.items();
    if (this.immutable && !this.copiedItemIdx.has(idx)) {
      this.s.items[idx] = { ...this.s.items[idx]! };
      this.copiedItemIdx.add(idx);
    }
    return this.s.items[idx] as T;
  }

  map(name: "openAgent" | "toolIndex" | "approvalIndex" | "subagentIndex"): Record<string, number> {
    if (this.immutable && !this.copiedMaps.has(name)) {
      this.s[name] = { ...this.s[name] };
      this.copiedMaps.add(name);
    }
    return this.s[name];
  }

  pending(): string[] {
    if (this.immutable && !this.copiedMaps.has("pending")) {
      this.s.pendingApprovals = [...this.s.pendingApprovals];
      this.copiedMaps.add("pending");
    }
    return this.s.pendingApprovals;
  }

  private items(): void {
    if (this.immutable && !this.copiedItems) {
      this.s.items = [...this.s.items];
      this.copiedItems = true;
    }
  }
}

function closeAgent(d: Draft, runKey: string): void {
  if (runKey in d.s.openAgent) {
    const open = d.map("openAgent");
    const idx = open[runKey]!;
    delete open[runKey];
    const item = d.edit<AgentItem>(idx);
    item.done = true;
  }
}

function openAgentItem(d: Draft, ev: ApiEvent, runKey: string): AgentItem {
  const existing = d.s.openAgent[runKey];
  if (existing !== undefined) return d.edit<AgentItem>(existing);
  const idx = d.push({
    kind: "agent",
    key: `e${ev.seq}`,
    seq: ev.seq ?? 0,
    ts: ev.ts,
    runId: ev.run_id ?? null,
    text: "",
    thinking: "",
    done: false,
    model: ev.model ?? null,
    deltas: 0,
  });
  d.map("openAgent")[runKey] = idx;
  return d.s.items[idx] as AgentItem;
}

function apply(d: Draft, ev: ApiEvent): void {
  const seq = ev.seq ?? 0;
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const base = { key: `e${seq}`, seq, ts: ev.ts, runId: ev.run_id ?? null };
  const runKey = ev.run_id ?? "_";

  switch (ev.type) {
    case "route.resolved":
      d.push({ ...base, kind: "route", agent: str(p.agent), alias: str(p.alias), version: num(p.version), model: str(p.model) ?? ev.model ?? undefined });
      break;
    case "session.status": {
      const status = str(p.status) ?? "unknown";
      d.s.status = status;
      const { status: _omit, ...detail } = p;
      void _omit;
      d.push({ ...base, kind: "status", status, detail });
      break;
    }
    case "run.started":
      d.push({ ...base, kind: "run.started", agent: str(p.agent) });
      break;
    case "run.finished": {
      closeAgent(d, runKey);
      const implied = STATUS_AFTER_STOP[str(p.stop_reason) ?? ""];
      if (implied && d.s.status !== "terminated") d.s.status = implied;
      const usage = parseUsage(p.usage);
      if (usage) {
        const u = { ...d.s.usage };
        u.input_tokens += usage.input_tokens;
        u.output_tokens += usage.output_tokens;
        u.cache_read_tokens += usage.cache_read_tokens;
        u.cache_write_tokens += usage.cache_write_tokens;
        d.s.usage = u;
      }
      d.push({
        ...base,
        kind: "run.finished",
        stopReason: str(p.stop_reason) ?? "unknown",
        usage,
        error: str(p.error),
        pendingApprovals: Array.isArray(p.pending_approvals) ? p.pending_approvals.length : 0,
        model: ev.model ?? null,
      });
      break;
    }
    case "message.user":
      d.push({ ...base, kind: "user", text: str(p.text) ?? "", steering: p.steering === true });
      break;
    case "message.agent.delta": {
      const item = openAgentItem(d, ev, runKey);
      item.text += str(p.text) ?? "";
      item.deltas += 1;
      if (ev.model) item.model = ev.model;
      break;
    }
    case "thinking.delta": {
      const item = openAgentItem(d, ev, runKey);
      item.thinking += str(p.text) ?? "";
      break;
    }
    case "message.agent.done": {
      const text = str(p.text) ?? "";
      const open = d.s.openAgent[runKey];
      if (open === undefined) {
        if (text) {
          d.push({ ...base, kind: "agent", text, thinking: "", done: true, model: ev.model ?? null, deltas: 0 });
        }
        break;
      }
      const item = d.edit<AgentItem>(open);
      if (text) item.text = text;
      if (ev.model) item.model = ev.model;
      closeAgent(d, runKey);
      break;
    }
    case "tool.call": {
      closeAgent(d, runKey);
      const callId = str(p.id) ?? str(p.call_id) ?? `seq${seq}`;
      const idx = d.push({ ...base, kind: "tool", callId, name: str(p.name) ?? "tool", arguments: p.arguments, result: null });
      d.map("toolIndex")[callId] = idx;
      break;
    }
    case "tool.result": {
      const callId = str(p.id) ?? str(p.call_id) ?? "";
      const result = { content: p.content, isError: p.is_error === true, seq };
      const idx = d.s.toolIndex[callId];
      if (idx !== undefined) {
        d.edit<ToolItem>(idx).result = result;
      } else {
        // A result without its call (e.g. history started mid-run): show it on its own.
        const newIdx = d.push({ ...base, kind: "tool", callId, name: str(p.name) ?? "tool", arguments: undefined, result });
        if (callId) d.map("toolIndex")[callId] = newIdx;
      }
      break;
    }
    case "tool.approval.requested": {
      closeAgent(d, runKey);
      const callId = str(p.call_id) ?? str(p.id) ?? `seq${seq}`;
      if (d.s.approvalIndex[callId] !== undefined) break;
      const idx = d.push({
        ...base,
        kind: "approval",
        callId,
        name: str(p.name) ?? "tool",
        arguments: p.arguments,
        state: "pending",
        reason: null,
        actor: null,
      });
      d.map("approvalIndex")[callId] = idx;
      d.pending().push(callId);
      break;
    }
    case "tool.approval.decided": {
      const callId = str(p.call_id) ?? "";
      const approved = p.approved === true || p.decision === "approve";
      const idx = d.s.approvalIndex[callId];
      const reason = str(p.reason) ?? null;
      const actor = str(p.actor) ?? null;
      if (idx !== undefined) {
        const item = d.edit<ApprovalItem>(idx);
        item.state = approved ? "approved" : "denied";
        item.reason = reason;
        item.actor = actor;
      } else {
        const newIdx = d.push({ ...base, kind: "approval", callId, name: "tool", arguments: undefined, state: approved ? "approved" : "denied", reason, actor });
        d.map("approvalIndex")[callId] = newIdx;
      }
      const pending = d.s.pendingApprovals;
      if (pending.includes(callId)) {
        const list = d.pending();
        list.splice(list.indexOf(callId), 1);
      }
      break;
    }
    case "subagent.started": {
      const child = str(p.child_session_id) ?? "";
      const idx = d.push({ ...base, kind: "subagent", childSessionId: child, agent: str(p.agent), task: str(p.task), finished: false, stopReason: undefined });
      if (child) d.map("subagentIndex")[child] = idx;
      break;
    }
    case "subagent.finished": {
      const child = str(p.child_session_id) ?? "";
      const idx = d.s.subagentIndex[child];
      if (idx !== undefined) {
        const item = d.edit<SubagentItem>(idx);
        item.finished = true;
        item.stopReason = str(p.stop_reason);
        item.agent ??= str(p.agent);
      } else {
        d.push({ ...base, kind: "subagent", childSessionId: child, agent: str(p.agent), task: undefined, finished: true, stopReason: str(p.stop_reason) });
      }
      break;
    }
    case "artifact.created":
      d.push({ ...base, kind: "artifact", artifactId: str(p.id), path: str(p.path) ?? "(unnamed)", size: num(p.size) ?? num(p.size_bytes), sha256: str(p.sha256) });
      break;
    case "error": {
      const { message, kind, fatal, ...detail } = p;
      d.push({ ...base, kind: "error", message: str(message) ?? "error", errorKind: str(kind), fatal: fatal === true, detail });
      break;
    }
    default:
      break;
  }
}

function accept(state: TimelineState, ev: ApiEvent): boolean {
  const seq = ev.seq ?? 0;
  // seq 0 means "unsequenced" (never stored); always apply those.
  return !(seq > 0 && seq <= state.lastSeq);
}

/** Apply one event, returning a new state (the input is not modified). */
export function applyEvent(state: TimelineState, ev: ApiEvent): TimelineState {
  if (!accept(state, ev)) return state;
  const d = Draft.from(state, true);
  apply(d, ev);
  d.s.lastSeq = Math.max(state.lastSeq, ev.seq ?? 0);
  d.s.count = state.count + 1;
  return d.s;
}

/** Apply several events immutably (one copy for the whole batch). */
export function applyEvents(state: TimelineState, events: readonly ApiEvent[]): TimelineState {
  let fresh = events.filter((e) => accept(state, e));
  if (fresh.length === 0) return state;
  fresh = [...fresh].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const d = Draft.from(state, true);
  for (const ev of fresh) {
    if (!accept(d.s, ev)) continue;
    apply(d, ev);
    d.s.lastSeq = Math.max(d.s.lastSeq, ev.seq ?? 0);
    d.s.count += 1;
  }
  return d.s;
}

/** Fold a full list of events from scratch. */
export function buildTimeline(events: readonly ApiEvent[]): TimelineState {
  const d = Draft.from(emptyTimeline(), false);
  for (const ev of events) {
    if (!accept(d.s, ev)) continue;
    apply(d, ev);
    d.s.lastSeq = Math.max(d.s.lastSeq, ev.seq ?? 0);
    d.s.count += 1;
  }
  return d.s;
}

/** Merge newly received events into a sorted, de-duplicated event list. */
export function mergeEvents(existing: readonly ApiEvent[], incoming: readonly ApiEvent[]): ApiEvent[] {
  if (incoming.length === 0) return existing as ApiEvent[];
  const last = existing.length ? (existing[existing.length - 1]!.seq ?? 0) : -1;
  const seen = new Set(existing.map((e) => e.seq));
  const fresh = incoming.filter((e) => !seen.has(e.seq));
  if (fresh.length === 0) return existing as ApiEvent[];
  const inOrder = fresh.every((e, i) => (e.seq ?? 0) > (i === 0 ? last : (fresh[i - 1]!.seq ?? 0)));
  const merged = [...existing, ...fresh];
  return inOrder ? merged : merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}
