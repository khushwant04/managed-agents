"use client";

import Link from "next/link";
import { Empty, ErrorBanner, Loading, PageHead, StatusBadge, Time } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { DeploymentList } from "@/lib/api";
import { seg } from "@/lib/client";
import { TriggerBadges } from "./triggers";

export function DeploymentsView() {
  const { data, error, loading, reload } = useApi<DeploymentList>("/v1/deployments");
  const deployments = data?.deployments ?? [];
  return (
    <>
      <PageHead
        title="Deployments"
        description="Aliases made reachable through HTTP, webhook, cron and queue triggers."
        actions={
          <button type="button" className="btn" onClick={reload} disabled={loading}>
            Refresh
          </button>
        }
      />
      <ErrorBanner error={error} onRetry={reload} />
      {!data && loading ? (
        <Loading />
      ) : data && deployments.length === 0 ? (
        <Empty>No deployments yet.</Empty>
      ) : deployments.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Deployments</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Target</th>
                <th scope="col">Status</th>
                <th scope="col">Triggers</th>
                <th scope="col" className="num">Concurrency</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`/deployments/${seg(d.name)}`} className="mono">
                      {d.name}
                    </Link>
                  </td>
                  <td className="mono">
                    <Link href={`/agents/${seg(d.agent)}`}>{d.agent}</Link>@{d.alias}
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td>
                    <TriggerBadges triggers={d.triggers} />
                  </td>
                  <td className="num">{d.concurrency}</td>
                  <td className="small">
                    <Time iso={d.updated_at} />
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
