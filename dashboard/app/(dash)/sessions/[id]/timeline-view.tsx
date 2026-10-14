"use client";

import Link from "next/link";
import { useState } from "react";
import { StatusBadge } from "@/components/ui";
import { proxyUrl, seg } from "@/lib/client";
import { formatBytes, formatNumber, formatTime, shortId, toDisplay } from "@/lib/format";
import type { AgentItem, ApprovalItem, TimelineItem, TokenUsage, ToolItem } from "@/lib/timeline";

export interface Decide {
  (callId: string, approved: boolean, reason: string): Promise<void>;
}

export function TimelineView({
  items,
  sessionId,
  live,
  onDecide,
  highlightLast = false,
}: {
  items: TimelineItem[];
  sessionId: string;
  /** Whether the stream is live (agent text without `done` shows a caret). */
  live: boolean;
  /** Approve/deny handler; omitted in replay (read-only). */
  onDecide?: Decide;
  highlightLast?: boolean;
}) {
  return (
    <ol className="timeline" aria-label="Session timeline">
      {items.map((item, i) => (
        <Row key={item.key} item={item} highlight={highlightLast && i === items.length - 1}>
          <ItemBody item={item} sessionId={sessionId} live={live} onDecide={onDecide} />
        </Row>
      ))}
    </ol>
  );
}

function rowClass(item: TimelineItem): string {
  switch (item.kind) {
    case "tool":
      return `tool${item.result?.isError ? " is-error" : ""}`;
    case "approval":
      return `approval ${item.state}`;
    case "error":
      return `error${item.fatal ? "" : " nonfatal"}`;
    case "run.started":
    case "run.finished":
      return "run";
    default:
      return item.kind;
  }
}

function Row({ item, highlight, children }: { item: TimelineItem; highlight: boolean; children: React.ReactNode }) {
  return (
    <li className={`tl ${rowClass(item)}${highlight ? " highlight" : ""}`} data-seq={item.seq}>
      <div className="tl-time">
        {item.ts ? (
          <time dateTime={item.ts} title={`${item.ts} · seq ${item.seq}`}>
            {formatTime(item.ts)}
          </time>
        ) : null}
      </div>
      <div className="tl-body">{children}</div>
    </li>
  );
}

export function UsageLine({ usage }: { usage: TokenUsage }) {
  return (
    <span className="small muted">
      in {formatNumber(usage.input_tokens)} · out {formatNumber(usage.output_tokens)}
      {usage.cache_read_tokens ? ` · cache read ${formatNumber(usage.cache_read_tokens)}` : ""}
      {usage.cache_write_tokens ? ` · cache write ${formatNumber(usage.cache_write_tokens)}` : ""}
    </span>
  );
}

function ItemBody({ item, sessionId, live, onDecide }: { item: TimelineItem; sessionId: string; live: boolean; onDecide?: Decide }) {
  switch (item.kind) {
    case "route":
      return (
        <div className="tl-head">
          <span className="tl-kind">Routed</span>
          <span className="mono">
            {item.agent ?? "agent"}
            {item.alias ? `@${item.alias}` : ""} → v{item.version ?? "?"}
          </span>
          {item.model ? <span className="badge">{item.model}</span> : null}
        </div>
      );
    case "status":
      return (
        <div className="tl-head">
          <span className="tl-kind visually-hidden">Status</span>
          <StatusBadge status={item.status} />
          {Object.entries(item.detail).map(([k, v]) => (
            <span key={k} className="small muted">
              {k.replace(/_/g, " ")}: {typeof v === "string" ? v : JSON.stringify(v)}
            </span>
          ))}
        </div>
      );
    case "run.started":
      return (
        <div className="tl-head">
          <span className="tl-kind">Run started</span>
          <span className="mono small muted" title={item.runId ?? undefined}>
            {shortId(item.runId)}
          </span>
        </div>
      );
    case "run.finished":
      return (
        <>
          <div className="tl-head">
            <span className="tl-kind">Run finished</span>
            <StatusBadge status={item.stopReason} />
            {item.model ? <span className="badge">{item.model}</span> : null}
            {item.usage ? <UsageLine usage={item.usage} /> : null}
            {item.pendingApprovals ? <span className="small muted">{item.pendingApprovals} approval(s) pending</span> : null}
          </div>
          {item.error ? <div className="tl-text" style={{ color: "var(--danger)" }}>{item.error}</div> : null}
        </>
      );
    case "user":
      return (
        <>
          <div className="tl-head">
            <span className="tl-kind">User</span>
            {item.steering ? <span className="badge info">steering</span> : null}
          </div>
          <div className="tl-text">{item.text}</div>
        </>
      );
    case "agent":
      return <AgentBody item={item} live={live} />;
    case "tool":
      return <ToolBody item={item} />;
    case "approval":
      return <ApprovalBody item={item} onDecide={onDecide} />;
    case "subagent":
      return (
        <>
          <div className="tl-head">
            <span className="tl-kind">Subagent</span>
            {item.agent ? <span className="mono">{item.agent}</span> : null}
            {item.finished ? <StatusBadge status={item.stopReason ?? "finished"} /> : <StatusBadge status="running" live={live} />}
            {item.childSessionId ? (
              <Link href={`/sessions/${seg(item.childSessionId)}`} className="mono small">
                {shortId(item.childSessionId, 12)} →
              </Link>
            ) : null}
          </div>
          {item.task ? <div className="tl-text small">{item.task}</div> : null}
        </>
      );
    case "artifact":
      return (
        <div className="tl-head">
          <span className="tl-kind">Artifact</span>
          <span className="mono">{item.path}</span>
          {item.size !== undefined ? <span className="small muted">{formatBytes(item.size)}</span> : null}
          {item.artifactId ? (
            <a className="btn btn-sm" href={proxyUrl(`/v1/sessions/${seg(sessionId)}/artifacts/${seg(item.artifactId)}`)} download>
              Download
            </a>
          ) : null}
        </div>
      );
    case "error":
      return (
        <>
          <div className="tl-head">
            <span className="tl-kind">{item.fatal ? "Error" : "Warning"}</span>
            {item.errorKind ? <span className="badge">{item.errorKind.replace(/_/g, " ")}</span> : null}
          </div>
          <div className="tl-text">{item.message}</div>
          {Object.keys(item.detail).length ? <pre className="json">{toDisplay(item.detail)}</pre> : null}
        </>
      );
  }
}

function AgentBody({ item, live }: { item: AgentItem; live: boolean }) {
  const streaming = live && !item.done;
  return (
    <>
      <div className="tl-head">
        <span className="tl-kind">Agent</span>
        {item.model ? <span className="badge">{item.model}</span> : null}
        {streaming ? <span className="small muted">streaming…</span> : null}
      </div>
      {item.thinking ? (
        <details className="fold">
          <summary>Thinking ({formatNumber(item.thinking.length)} chars)</summary>
          <div className="thinking">{item.thinking}</div>
        </details>
      ) : null}
      {item.text || streaming ? <div className={`tl-text${streaming ? " cursor-caret" : ""}`}>{item.text}</div> : null}
    </>
  );
}

function ToolBody({ item }: { item: ToolItem }) {
  const res = item.result;
  return (
    <>
      <div className="tl-head">
        <span className="tl-kind">Tool</span>
        <span className="mono">{item.name}</span>
        {res ? res.isError ? <span className="badge danger">error</span> : <span className="badge ok">done</span> : <span className="badge info">running</span>}
        <span className="mono small muted" title={item.callId}>
          {shortId(item.callId)}
        </span>
      </div>
      {item.arguments !== undefined ? (
        <details className="fold">
          <summary>Arguments</summary>
          <pre className="json">{toDisplay(item.arguments)}</pre>
        </details>
      ) : null}
      {res ? (
        <details className="fold" open={res.isError}>
          <summary>{res.isError ? "Error result" : "Result"}</summary>
          <pre className="json">{toDisplay(res.content)}</pre>
        </details>
      ) : null}
    </>
  );
}

function ApprovalBody({ item, onDecide }: { item: ApprovalItem; onDecide?: Decide }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (approved: boolean) => {
    if (!onDecide) return;
    setBusy(true);
    setError(null);
    try {
      await onDecide(item.callId, approved, reason);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const reasonId = `reason-${item.callId}`;
  return (
    <>
      <div className="tl-head">
        <span className="tl-kind">Approval</span>
        <span className="mono">{item.name}</span>
        <span className={`badge ${item.state === "pending" ? "warn" : item.state === "approved" ? "ok" : "danger"}`}>{item.state}</span>
        {item.actor ? <span className="small muted">by {item.actor}</span> : null}
      </div>
      {item.arguments !== undefined ? <pre className="json">{toDisplay(item.arguments)}</pre> : null}
      {item.reason ? <div className="small">Reason: {item.reason}</div> : null}
      {item.state === "pending" && onDecide ? (
        <div className="row" style={{ marginTop: 8 }}>
          <label htmlFor={reasonId} className="visually-hidden">
            Reason (optional)
          </label>
          <input id={reasonId} type="text" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: "1 1 200px" }} />
          <button type="button" className="btn btn-ok" disabled={busy} onClick={() => decide(true)}>
            Approve
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => decide(false)}>
            Deny
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="small" role="alert" style={{ color: "var(--danger)", marginTop: 4 }}>
          {error}
        </div>
      ) : null}
    </>
  );
}
