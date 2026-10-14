"use client";

import { useState } from "react";
import { Empty, ErrorBanner, Loading, PageHead, Time } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { AuditList } from "@/lib/api";
import { ApiError } from "@/lib/client";

const LIMITS = [50, 100, 250, 500, 1000];

export function AuditView() {
  const [limit, setLimit] = useState(100);
  const [filter, setFilter] = useState("");
  const { data, error, loading, reload } = useApi<AuditList>("/v1/audit", { limit });
  const forbidden = error instanceof ApiError && error.status === 403;
  const f = filter.trim().toLowerCase();
  const entries = (data?.entries ?? []).filter((e) => !f || `${e.actor} ${e.action} ${e.target}`.toLowerCase().includes(f));

  return (
    <>
      <PageHead
        title="Audit log"
        description="Registrations, alias moves, deployments, sessions, approvals and secret reads."
        actions={
          <button type="button" className="btn" onClick={reload} disabled={loading || forbidden}>
            Refresh
          </button>
        }
      />
      {forbidden ? (
        <div className="card">
          <h2>Admins only</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            The audit log needs an API key with the <strong>admin</strong> role. You&apos;re signed in with a key that can&apos;t read it. Sign out and use an admin key, or ask a
            project admin.
          </p>
        </div>
      ) : (
        <>
          <form className="row" style={{ marginBottom: 12, gap: 12 }} onSubmit={(e) => e.preventDefault()} aria-label="Filter audit log">
            <div className="field" style={{ flex: "1 1 260px" }}>
              <label htmlFor="audit-filter">Filter</label>
              <input id="audit-filter" type="search" placeholder="actor, action or target" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="audit-limit">Entries</label>
              <select id="audit-limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
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
          ) : data && entries.length === 0 ? (
            <Empty>{f ? "No entries match." : "No audit entries yet."}</Empty>
          ) : entries.length > 0 ? (
            <div className="table-wrap">
              <table>
                <caption className="visually-hidden">Audit log entries, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Action</th>
                    <th scope="col">Target</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={`${e.at}-${i}`}>
                      <td className="small">
                        <Time iso={e.at} />
                      </td>
                      <td className="mono small">{e.actor}</td>
                      <td>
                        <span className="badge">{e.action}</span>
                      </td>
                      <td className="mono small" style={{ overflowWrap: "anywhere" }}>
                        {e.target}
                      </td>
                      <td>
                        {Object.keys(e.details ?? {}).length ? (
                          <code className="small" style={{ overflowWrap: "anywhere" }}>
                            {JSON.stringify(e.details)}
                          </code>
                        ) : (
                          <span className="muted">–</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
