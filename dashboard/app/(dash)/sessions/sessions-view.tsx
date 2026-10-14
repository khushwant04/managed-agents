"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Empty, ErrorBanner, Loading, PageHead, StatusBadge, Time } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { AgentList, SessionList } from "@/lib/api";
import { seg } from "@/lib/client";
import { shortId } from "@/lib/format";

const LIMITS = [25, 50, 100, 250, 500];

export function SessionsView({ initialAgent }: { initialAgent: string }) {
  const router = useRouter();
  const [agent, setAgent] = useState(initialAgent);
  const [limit, setLimit] = useState(50);
  const agents = useApi<AgentList>("/v1/agents");
  const { data, error, loading, reload } = useApi<SessionList>("/v1/sessions", { agent: agent || undefined, limit });
  const sessions = data?.sessions ?? [];

  function chooseAgent(value: string) {
    setAgent(value);
    router.replace(value ? `/sessions?agent=${seg(value)}` : "/sessions", { scroll: false });
  }

  return (
    <>
      <PageHead
        title="Sessions"
        description="Conversations and tasks, newest first."
        actions={
          <button type="button" className="btn" onClick={reload} disabled={loading}>
            Refresh
          </button>
        }
      />
      <form className="row" style={{ marginBottom: 12, gap: 12 }} onSubmit={(e) => e.preventDefault()} aria-label="Filter sessions">
        <div className="field">
          <label htmlFor="filter-agent">Agent</label>
          <select id="filter-agent" value={agent} onChange={(e) => chooseAgent(e.target.value)}>
            <option value="">All agents</option>
            {agent && !agents.data?.agents.some((a) => a.name === agent) ? <option value={agent}>{agent}</option> : null}
            {(agents.data?.agents ?? []).map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-limit">Show</label>
          <select id="filter-limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </form>
      <ErrorBanner error={error} onRetry={reload} />
      {!data && loading ? (
        <Loading />
      ) : data && sessions.length === 0 ? (
        <Empty>No sessions{agent ? ` for ${agent}` : ""} yet.</Empty>
      ) : sessions.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Sessions</caption>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Agent</th>
                <th scope="col">Status</th>
                <th scope="col">Origin</th>
                <th scope="col">Created</th>
                <th scope="col">Last active</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link href={`/sessions/${seg(s.id)}`} className="mono" title={s.id}>
                      {shortId(s.id, 12)}
                    </Link>
                  </td>
                  <td className="mono">
                    <Link href={`/agents/${seg(s.agent)}`}>{s.agent}</Link>
                    <span className="muted">
                      {s.alias ? `@${s.alias}` : ""} v{s.version}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={s.status} live={s.status === "running"} />
                  </td>
                  <td className="small">
                    {s.parent_session_id ? (
                      <>
                        child of{" "}
                        <Link href={`/sessions/${seg(s.parent_session_id)}`} className="mono">
                          {shortId(s.parent_session_id)}
                        </Link>
                      </>
                    ) : s.deployment_id ? (
                      <span className="mono muted">{shortId(s.deployment_id)}</span>
                    ) : (
                      <span className="muted">direct</span>
                    )}
                  </td>
                  <td className="small">
                    <Time iso={s.created_at} />
                  </td>
                  <td className="small">
                    <Time iso={s.last_active_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
