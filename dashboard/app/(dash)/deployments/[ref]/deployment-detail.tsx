"use client";

import Link from "next/link";
import { useState } from "react";
import { ConfirmDialog } from "@/components/dialog";
import { CopyButton, Empty, ErrorBanner, JsonBlock, Loading, PageHead, StatusBadge, Time } from "@/components/ui";
import { useApi, useMutation } from "@/components/use-api";
import type { Deployment, DeploymentUpdate } from "@/lib/api";
import { api, seg } from "@/lib/client";
import { describeTrigger } from "../triggers";

export function DeploymentDetail({ deploymentRef }: { deploymentRef: string }) {
  const path = `/v1/deployments/${seg(deploymentRef)}`;
  const { data: d, error, loading, reload, setData } = useApi<Deployment>(path);
  const [confirming, setConfirming] = useState<"paused" | "active" | null>(null);
  const mutation = useMutation();

  async function setStatus() {
    if (!confirming) return;
    const change: DeploymentUpdate = { status: confirming };
    const updated = await mutation.run(() => api<Deployment>(path, { method: "PATCH", json: change }));
    if (updated) {
      setData(updated);
      setConfirming(null);
    }
  }

  return (
    <>
      <PageHead
        crumbs={
          <>
            <Link href="/deployments">Deployments</Link> / <span className="mono">{deploymentRef}</span>
          </>
        }
        title={
          <span className="row">
            <span className="mono">{d?.name ?? deploymentRef}</span>
            {d ? <StatusBadge status={d.status} /> : null}
          </span>
        }
        description={
          d ? (
            <>
              Serves{" "}
              <Link className="mono" href={`/agents/${seg(d.agent)}`}>
                {d.agent}@{d.alias}
              </Link>
            </>
          ) : undefined
        }
        actions={
          d ? (
            <>
              <Link className="btn" href={`/sessions?agent=${seg(d.agent)}`}>
                Sessions
              </Link>
              {d.status === "active" ? (
                <button type="button" className="btn btn-danger" onClick={() => setConfirming("paused")}>
                  Pause
                </button>
              ) : d.status === "paused" ? (
                <button type="button" className="btn btn-primary" onClick={() => setConfirming("active")}>
                  Resume
                </button>
              ) : null}
            </>
          ) : null
        }
      />
      <ErrorBanner error={error} onRetry={reload} />
      {!d && loading ? <Loading /> : null}
      {d ? (
        <div className="grid-2">
          <section className="card" aria-labelledby="dep-overview">
            <h2 id="dep-overview">Overview</h2>
            <dl className="kv">
              <dt>ID</dt>
              <dd className="mono">{d.id}</dd>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={d.status} />
              </dd>
              <dt>Concurrency</dt>
              <dd>{d.concurrency} concurrent sessions</dd>
              <dt>Environment</dt>
              <dd className="mono">{d.environment ?? <span className="muted">default</span>}</dd>
              <dt>Secrets</dt>
              <dd>{d.secrets.length ? d.secrets.map((s) => <span key={s} className="badge mono" style={{ marginRight: 4 }}>{s}</span>) : <span className="muted">none</span>}</dd>
              <dt>Created</dt>
              <dd>
                <Time iso={d.created_at} /> {d.created_by ? <span className="muted">by {d.created_by}</span> : null}
              </dd>
              <dt>Updated</dt>
              <dd>
                <Time iso={d.updated_at} />
              </dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="dep-triggers">
            <h2 id="dep-triggers">Triggers</h2>
            {d.triggers.length === 0 ? (
              <Empty>No triggers.</Empty>
            ) : (
              <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {d.triggers.map((t, i) => (
                  <li key={i}>
                    <strong>{describeTrigger(t)}</strong>
                    {t.type === "cron" && t.input ? <div className="small muted">Input: {String(t.input)}</div> : null}
                    {t.type === "webhook" && t.input ? <div className="small muted">Input template: <code>{String(t.input)}</code></div> : null}
                  </li>
                ))}
              </ul>
            )}
            {d.webhook_url ? (
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="webhook-url">Webhook URL</label>
                <div className="row">
                  <input id="webhook-url" type="url" readOnly value={d.webhook_url} style={{ flex: 1, minWidth: 0 }} onFocus={(e) => e.currentTarget.select()} />
                  <CopyButton text={d.webhook_url} />
                </div>
                <span className="hint">Deliveries must be signed with the deployment&apos;s webhook secret (shown only when the deployment is created).</span>
              </div>
            ) : null}
            <details className="fold">
              <summary>Raw triggers</summary>
              <JsonBlock value={d.triggers} label="Triggers JSON" />
            </details>
          </section>

          <section className="card" aria-labelledby="dep-budget">
            <h2 id="dep-budget">Budget</h2>
            {Object.keys(d.budget ?? {}).length === 0 ? <p className="muted">No budget limits.</p> : <JsonBlock value={d.budget} label="Budget JSON" />}
          </section>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming === "paused" ? `Pause ${d?.name ?? deploymentRef}?` : `Resume ${d?.name ?? deploymentRef}?`}
        confirmLabel={confirming === "paused" ? "Pause deployment" : "Resume deployment"}
        danger={confirming === "paused"}
        pending={mutation.pending}
        error={mutation.error}
        onCancel={() => {
          setConfirming(null);
          mutation.setError(null);
        }}
        onConfirm={setStatus}
      >
        {confirming === "paused" ? (
          <p>While paused, this deployment&apos;s triggers (HTTP, webhooks, cron and queues) stop starting new sessions. Sessions already running continue.</p>
        ) : (
          <p>Triggers start new sessions again as soon as the deployment is active.</p>
        )}
      </ConfirmDialog>
    </>
  );
}
