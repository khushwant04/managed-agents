"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Empty, ErrorBanner, Loading, PageHead } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { AgentList } from "@/lib/api";
import { seg } from "@/lib/client";

export function AgentsView() {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);
  const { data, error, loading, reload } = useApi<AgentList>("/v1/agents", { q: q || undefined });
  const agents = data?.agents ?? [];

  return (
    <>
      <PageHead title="Agents" description="Registered agents and their latest versions." />
      <form className="row" role="search" onSubmit={(e) => e.preventDefault()} style={{ marginBottom: 12 }}>
        <label htmlFor="agent-search" className="visually-hidden">
          Search agents
        </label>
        <input id="agent-search" type="search" placeholder="Search by name, description or tag" value={input} onChange={(e) => setInput(e.target.value)} style={{ flex: "1 1 280px" }} />
        {loading ? <span className="muted small" role="status">Searching…</span> : null}
      </form>
      <ErrorBanner error={error} onRetry={reload} />
      {!data && loading ? (
        <Loading />
      ) : agents.length === 0 && data ? (
        <Empty>{q ? <>No agents match “{q}”.</> : <>No agents yet. Register one with <code>agents deploy</code> or <code>POST /v1/agents</code>.</>}</Empty>
      ) : agents.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Agents</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Description</th>
                <th scope="col">Tags</th>
                <th scope="col" className="num">Latest</th>
                <th scope="col">Owner</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.name}>
                  <td>
                    <Link href={`/agents/${seg(a.name)}`} className="mono">
                      {a.name}
                    </Link>
                  </td>
                  <td>{a.description || <span className="muted">–</span>}</td>
                  <td>
                    <div className="row">
                      {a.tags.map((t) => (
                        <span key={t} className="badge">
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="num">v{a.latest_version}</td>
                  <td className="muted">{a.created_by ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
