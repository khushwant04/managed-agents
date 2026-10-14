"use client";

import Link from "next/link";
import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/dialog";
import { Empty, ErrorBanner, PageHead, StatusBadge, Time } from "@/components/ui";
import { useApi, useMutation } from "@/components/use-api";
import { SETTLED_STATUSES, type ApiEvent, type ArtifactList, type InterruptResult, type Session, type SessionEventBody, type SessionEventResult } from "@/lib/api";
import { api, proxyUrl, seg } from "@/lib/client";
import { formatBytes, formatDuration, formatTime, shortId } from "@/lib/format";
import { nextDelay, recordedOffsetMs, REPLAY_SPEEDS, replaySessionReducer, startReplay } from "@/lib/replay";
import { parseUsage } from "@/lib/timeline";
import { TimelineView, UsageLine } from "./timeline-view";
import { useSessionEvents, type Connection } from "./use-session-events";

const CONNECTION_LABEL: Record<Connection, string> = {
  loading: "loading history",
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  error: "offline",
};

export function SessionView({ sessionId }: { sessionId: string }) {
  const base = `/v1/sessions/${seg(sessionId)}`;
  const { events, timeline, connection, error: streamError } = useSessionEvents(sessionId);
  const session = useApi<Session>(base);
  const artifacts = useApi<ArtifactList>(`${base}/artifacts`);
  const [replayEvents, setReplayEvents] = useState<ApiEvent[] | null>(null);

  const status = timeline.status ?? session.data?.status ?? null;
  const settled = status !== null && SETTLED_STATUSES.has(status);

  // Refresh session details when the status changes, and artifacts when new ones appear.
  const { reload: reloadSession } = session;
  const { reload: reloadArtifacts } = artifacts;
  const artifactEvents = timeline.items.filter((i) => i.kind === "artifact").length;
  const statusSeen = useRef(status);
  useEffect(() => {
    if (statusSeen.current !== timeline.status && timeline.status) reloadSession();
    statusSeen.current = timeline.status;
  }, [timeline.status, reloadSession]);
  const artifactsSeen = useRef(0);
  useEffect(() => {
    if (artifactEvents > artifactsSeen.current && artifactsSeen.current > 0) reloadArtifacts();
    artifactsSeen.current = artifactEvents;
  }, [artifactEvents, reloadArtifacts]);

  const s = session.data;
  const lastRunUsage = parseUsage(s?.last_run?.usage);

  return (
    <>
      <PageHead
        crumbs={
          <>
            <Link href="/sessions">Sessions</Link> / <span className="mono">{shortId(sessionId, 12)}</span>
          </>
        }
        title={
          <span className="row">
            <span className="mono" style={{ overflowWrap: "anywhere" }}>
              {sessionId}
            </span>
            <StatusBadge status={status} live={status === "running"} />
          </span>
        }
        description={
          s ? (
            <>
              <Link href={`/agents/${seg(s.agent)}`} className="mono">
                {s.agent}
              </Link>
              {s.alias ? `@${s.alias}` : ""} · v{s.version}
            </>
          ) : undefined
        }
        actions={
          <>
            <span className={`badge ${connection === "live" ? "ok live" : connection === "error" ? "danger" : "info"}`} role="status" aria-live="polite">
              <span className="dot" aria-hidden="true" />
              {replayEvents ? "replaying" : CONNECTION_LABEL[connection]}
            </span>
            {replayEvents ? (
              <button type="button" className="btn" onClick={() => setReplayEvents(null)}>
                Exit replay
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={!settled || events.length === 0}
                title={settled ? "Step through the recorded events" : "Replay is available once the session has settled"}
                onClick={() => setReplayEvents(events)}
              >
                Replay
              </button>
            )}
          </>
        }
      />
      <ErrorBanner error={session.error} onRetry={session.reload} />
      {streamError ? <div className="banner warn" role="status">{streamError}</div> : null}

      <div className="session-layout">
        <div>
          {replayEvents ? (
            <ReplayPanel events={replayEvents} sessionId={sessionId} />
          ) : (
            <>
              {connection === "loading" ? (
                <p className="muted" role="status">
                  Loading events…
                </p>
              ) : timeline.items.length === 0 ? (
                <Empty>No events yet.</Empty>
              ) : (
                <TimelineView
                  items={timeline.items}
                  sessionId={sessionId}
                  live={connection === "live"}
                  onDecide={async (callId, approved, reason) => {
                    const decision: SessionEventBody = { type: "tool.approval.decided", call_id: callId, approved, reason: reason.trim() || null };
                    await api<SessionEventResult>(`${base}/events`, { method: "POST", json: decision });
                  }}
                />
              )}
              <Composer sessionId={sessionId} status={status} />
            </>
          )}
        </div>

        <aside className="sidebar" aria-label="Session details">
          <section className="card">
            <h2>Details</h2>
            {s ? (
              <dl className="kv small">
                <dt>Agent</dt>
                <dd className="mono">
                  <Link href={`/agents/${seg(s.agent)}`}>{s.agent}</Link>
                  {s.alias ? `@${s.alias}` : ""} v{s.version}
                </dd>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={status} />
                </dd>
                {s.parent_session_id ? (
                  <>
                    <dt>Parent</dt>
                    <dd>
                      <Link href={`/sessions/${seg(s.parent_session_id)}`} className="mono">
                        {shortId(s.parent_session_id, 12)}
                      </Link>
                    </dd>
                  </>
                ) : null}
                {s.deployment_id ? (
                  <>
                    <dt>Deployment</dt>
                    <dd className="mono">{shortId(s.deployment_id, 12)}</dd>
                  </>
                ) : null}
                <dt>Sandbox</dt>
                <dd>{s.sandbox_state}</dd>
                <dt>Depth</dt>
                <dd>{s.depth}</dd>
                <dt>Created</dt>
                <dd>
                  <Time iso={s.created_at} />
                </dd>
                <dt>Last active</dt>
                <dd>
                  <Time iso={s.last_active_at} />
                </dd>
                {s.last_run ? (
                  <>
                    <dt>Last run</dt>
                    <dd>
                      {s.last_run.stop_reason ? <StatusBadge status={s.last_run.stop_reason} /> : <StatusBadge status={s.last_run.status} />}
                      {lastRunUsage ? (
                        <div>
                          <UsageLine usage={lastRunUsage} />
                        </div>
                      ) : null}
                    </dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <p className="muted small">Loading…</p>
            )}
          </section>

          <section className="card">
            <h2>Usage (all runs)</h2>
            <UsageLine usage={timeline.usage} />
          </section>

          <section className="card" aria-labelledby="artifacts-h">
            <h2 id="artifacts-h">Artifacts</h2>
            <ErrorBanner error={artifacts.error} onRetry={artifacts.reload} />
            {artifacts.data && artifacts.data.artifacts.length === 0 ? <p className="muted small">No output files.</p> : null}
            <ul className="stack small" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {(artifacts.data?.artifacts ?? []).map((a) => (
                <li key={a.id}>
                  <a href={proxyUrl(`${base}/artifacts/${seg(a.id)}`)} download className="mono" style={{ overflowWrap: "anywhere" }}>
                    {a.path}
                  </a>
                  <div className="muted">
                    {formatBytes(a.size_bytes)}
                    {a.content_type ? ` · ${a.content_type}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}

function Composer({ sessionId, status }: { sessionId: string; status: string | null }) {
  const base = `/v1/sessions/${seg(sessionId)}`;
  const [text, setText] = useState("");
  const [confirmInterrupt, setConfirmInterrupt] = useState(false);
  const send = useMutation();
  const interrupt = useMutation();
  const [notice, setNotice] = useState<string | null>(null);
  const terminated = status === "terminated";
  const running = status === "running" || status === "queued";

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    const message: SessionEventBody = { type: "message.user", text: body };
    const res = await send.run(() => api<SessionEventResult>(`${base}/events`, { method: "POST", json: message }));
    if (res) {
      setText("");
      setNotice(res.steered ? "Sent to the running turn." : "Message sent.");
    }
  }

  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="composer-h">
      <h2 id="composer-h" className="visually-hidden">
        Send a message
      </h2>
      <form className="composer" onSubmit={submit}>
        <label htmlFor="composer-text">Message</label>
        <textarea
          id="composer-text"
          value={text}
          disabled={terminated}
          placeholder={terminated ? "This session has been terminated." : "Send a message to the agent (Ctrl+Enter to send)"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        {send.error ? (
          <div className="banner error" role="alert">
            {send.error}
          </div>
        ) : null}
        {interrupt.error ? (
          <div className="banner error" role="alert">
            {interrupt.error}
          </div>
        ) : null}
        <div className="row">
          <span className="small muted" aria-live="polite">
            {notice}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-danger" disabled={!running || interrupt.pending} onClick={() => setConfirmInterrupt(true)}>
            Interrupt
          </button>
          <button type="submit" className="btn btn-primary" disabled={send.pending || !text.trim() || terminated}>
            {send.pending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={confirmInterrupt}
        title="Interrupt the current run?"
        confirmLabel="Interrupt"
        danger
        pending={interrupt.pending}
        error={interrupt.error}
        onCancel={() => setConfirmInterrupt(false)}
        onConfirm={async () => {
          const res = await interrupt.run(() => api<InterruptResult>(`${base}/interrupt`, { method: "POST" }));
          if (res) {
            setConfirmInterrupt(false);
            setNotice(res.interrupted ? "Run interrupted." : "Nothing was running.");
          }
        }}
      >
        <p>The agent stops at its next checkpoint. The session stays open and you can send another message.</p>
      </ConfirmDialog>
    </section>
  );
}

function ReplayPanel({ events, sessionId }: { events: ApiEvent[]; sessionId: string }) {
  const [state, dispatch] = useReducer(replaySessionReducer, events, (evs) => startReplay(evs));
  const { replay, cache } = state;
  const total = events.length;
  const current = replay.cursor > 0 ? events[replay.cursor - 1] : undefined;

  useEffect(() => {
    if (!replay.playing) return;
    const t = setTimeout(() => dispatch({ type: "tick" }), nextDelay(events, replay.cursor, replay.speed));
    return () => clearTimeout(t);
  }, [replay.playing, replay.cursor, replay.speed, events]);

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (replay.playing) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [replay.cursor, replay.playing]);

  const elapsed = recordedOffsetMs(events, replay.cursor);
  const duration = recordedOffsetMs(events, total);

  return (
    <>
      <div className="replay" role="group" aria-label="Replay controls">
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: "start" })} aria-label="Go to start" disabled={replay.cursor === 0}>
            ⏮
          </button>
          <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: "step", delta: -1 })} aria-label="Step back" disabled={replay.cursor === 0}>
            ◀ Step
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => dispatch({ type: "toggle" })} style={{ minWidth: 72 }}>
            {replay.playing ? "Pause" : replay.cursor >= total ? "Replay" : "Play"}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: "step", delta: 1 })} aria-label="Step forward" disabled={replay.cursor >= total}>
            Step ▶
          </button>
          <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: "end" })} aria-label="Go to end" disabled={replay.cursor >= total}>
            ⏭
          </button>
          <span className="spacer" />
          <label htmlFor="replay-speed" className="small">
            Speed
          </label>
          <select id="replay-speed" value={replay.speed} onChange={(e) => dispatch({ type: "speed", speed: Number(e.target.value) })}>
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </div>
        <label htmlFor="replay-scrub" className="visually-hidden">
          Position in recording
        </label>
        <input
          id="replay-scrub"
          type="range"
          min={0}
          max={total}
          step={1}
          value={replay.cursor}
          onChange={(e) => dispatch({ type: "seek", cursor: Number(e.target.value) })}
          aria-valuetext={`event ${replay.cursor} of ${total}`}
        />
        <div className="row small muted" aria-live="off">
          <span>
            Event {replay.cursor} / {total}
          </span>
          {current ? (
            <span className="mono">
              #{current.seq} {current.type} · {formatTime(current.ts)}
            </span>
          ) : null}
          <span className="spacer" />
          <span>
            {formatDuration(elapsed)} / {formatDuration(duration)} recorded
          </span>
        </div>
      </div>
      {cache.timeline.items.length === 0 ? (
        <Empty>Press Play or Step to start the replay.</Empty>
      ) : (
        <TimelineView items={cache.timeline.items} sessionId={sessionId} live={replay.cursor < total} highlightLast />
      )}
      <div ref={endRef} />
    </>
  );
}
