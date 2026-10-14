"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ConfirmDialog, Modal } from "@/components/dialog";
import { Empty, ErrorBanner, JsonBlock, Loading, PageHead, Time, WeightBar } from "@/components/ui";
import { useApi, useMutation } from "@/components/use-api";
import { aliasesForVersion, canaryTarget, describeTarget, isValidAliasName, promoteTarget, validateTarget } from "@/lib/alias";
import type { AgentVersion, AliasInfo, AliasList, AliasResult, AliasTarget, VersionList } from "@/lib/api";
import { api, seg } from "@/lib/client";

type Pending =
  | { kind: "move"; alias: string; target: AliasTarget; title: string }
  | { kind: "rollback"; alias: string }
  | null;

export function AgentDetail({ name }: { name: string }) {
  const base = `/v1/agents/${seg(name)}`;
  const versions = useApi<VersionList>(`${base}/versions`);
  const aliases = useApi<AliasList>(`${base}/aliases`);
  const [specVersion, setSpecVersion] = useState<number | null>(null);
  const [promoteVersion, setPromoteVersion] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation();

  const aliasList = useMemo(() => aliases.data?.aliases ?? [], [aliases.data]);
  const versionList = versions.data?.versions ?? [];
  const current = (alias: string) => aliasList.find((a) => a.alias === alias);

  async function confirm() {
    if (!pending) return;
    const result = await mutation.run(() =>
      pending.kind === "move"
        ? api<AliasResult>(`${base}/aliases/${seg(pending.alias)}`, { method: "PUT", json: pending.target })
        : api<AliasResult>(`${base}/aliases/${seg(pending.alias)}/rollback`, { method: "POST" }),
    );
    if (result) {
      setNotice(`${name}@${result.alias} now routes to ${describeTarget(result.versions)}.`);
      setPending(null);
      setPromoteVersion(null);
      aliases.reload();
    }
  }

  return (
    <>
      <PageHead
        crumbs={
          <>
            <Link href="/agents">Agents</Link> / <span className="mono">{name}</span>
          </>
        }
        title={<span className="mono">{name}</span>}
        description={versionList[0] ? <>Latest version v{versionList[0].version}</> : undefined}
        actions={
          <Link className="btn" href={`/sessions?agent=${seg(name)}`}>
            Sessions
          </Link>
        }
      />
      {notice ? (
        <div className="banner ok row" role="status">
          <span>{notice}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <section className="card" aria-labelledby="aliases-h">
        <h2 id="aliases-h">Aliases</h2>
        <ErrorBanner error={aliases.error} onRetry={aliases.reload} />
        {!aliases.data && aliases.loading ? (
          <Loading />
        ) : aliasList.length === 0 ? (
          <Empty>No aliases yet. Promote a version below to create one (for example “prod”).</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Alias</th>
                  <th scope="col">Routes to</th>
                  <th scope="col">Split</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {aliasList.map((a) => (
                  <tr key={a.alias}>
                    <th scope="row" className="mono">
                      {name}@{a.alias}
                    </th>
                    <td>{describeTarget(a.versions)}</td>
                    <td>
                      <WeightBar versions={a.versions} />
                    </td>
                    <td className="small">
                      <Time iso={a.updated_at} />
                      {a.updated_by ? <div className="muted">{a.updated_by}</div> : null}
                    </td>
                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => setPending({ kind: "rollback", alias: a.alias })}>
                        Roll back
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CanaryForm
        versions={versionList.map((v) => v.version)}
        aliases={aliasList}
        onReview={(alias, target) => setPending({ kind: "move", alias, target, title: `Set traffic split for ${name}@${alias}` })}
      />

      <section className="card" aria-labelledby="versions-h">
        <h2 id="versions-h">Versions</h2>
        <ErrorBanner error={versions.error} onRetry={versions.reload} />
        {!versions.data && versions.loading ? (
          <Loading />
        ) : versionList.length === 0 ? (
          <Empty>No versions.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Hash</th>
                  <th scope="col">Serving</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {versionList.map((v) => (
                  <tr key={v.version}>
                    <td className="mono">v{v.version}</td>
                    <td className="mono muted" title={v.hash}>
                      {v.hash.slice(0, 12)}
                    </td>
                    <td>
                      <div className="row">
                        {aliasesForVersion(aliasList, v.version).map((a) => (
                          <span key={a.alias} className="badge accent">
                            {a.alias}
                            {a.weight !== 100 ? ` ${a.weight}%` : ""}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="small">
                      <Time iso={v.created_at} />
                      {v.created_by ? <div className="muted">{v.created_by}</div> : null}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <button type="button" className="btn btn-sm" onClick={() => setSpecVersion(v.version)}>
                          View spec
                        </button>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setPromoteVersion(v.version)}>
                          Promote…
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <SpecDialog name={name} version={specVersion} onClose={() => setSpecVersion(null)} />

      <PromoteDialog
        name={name}
        version={promoteVersion}
        aliases={aliasList}
        onCancel={() => setPromoteVersion(null)}
        onReview={(alias) => {
          if (promoteVersion === null) return;
          setPending({ kind: "move", alias, target: promoteTarget(promoteVersion), title: `Promote v${promoteVersion} to ${name}@${alias}` });
          setPromoteVersion(null);
        }}
      />

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "rollback" ? `Roll back ${name}@${pending.alias}?` : (pending?.title ?? "")}
        confirmLabel={pending?.kind === "rollback" ? "Roll back" : "Move alias"}
        danger={pending?.kind === "rollback"}
        pending={mutation.pending}
        error={mutation.error}
        onCancel={() => {
          setPending(null);
          mutation.setError(null);
        }}
        onConfirm={confirm}
      >
        {pending?.kind === "rollback" ? (
          <p>
            This points <code>{name}@{pending.alias}</code> back at its previous target (currently {describeTarget(current(pending.alias)?.versions ?? [])}). New sessions
            route to the restored target immediately; running sessions keep their version.
          </p>
        ) : pending?.kind === "move" ? (
          <>
            <dl className="kv">
              <dt>Alias</dt>
              <dd className="mono">
                {name}@{pending.alias}
              </dd>
              <dt>Now</dt>
              <dd>{current(pending.alias) ? describeTarget(current(pending.alias)!.versions) : <span className="muted">(new alias)</span>}</dd>
              <dt>After</dt>
              <dd>
                <strong>{describeTarget(pending.target.versions)}</strong>
              </dd>
            </dl>
            <p className="muted small">New sessions are routed by the new weights right away. Sessions already running stay pinned to their version.</p>
          </>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function SpecDialog({ name, version, onClose }: { name: string; version: number | null; onClose: () => void }) {
  const { data, error, loading } = useApi<AgentVersion>(version !== null ? `/v1/agents/${seg(name)}/versions/${version}` : null);
  return (
    <Modal open={version !== null} onClose={onClose} title={`${name} v${version ?? ""} spec`} wide>
      <ErrorBanner error={error} />
      {loading && !data ? <Loading /> : null}
      {data && data.version === version ? (
        <>
          <dl className="kv small">
            <dt>Hash</dt>
            <dd className="mono">{data.hash}</dd>
            <dt>Created</dt>
            <dd>
              <Time iso={data.created_at} /> {data.created_by ? <span className="muted">by {data.created_by}</span> : null}
            </dd>
          </dl>
          <h3 style={{ marginTop: 12 }}>Spec</h3>
          <JsonBlock value={data.spec} label="Agent spec JSON" />
          <details className="fold">
            <summary>Agent card</summary>
            <JsonBlock value={data.card} label="Agent card JSON" />
          </details>
        </>
      ) : null}
    </Modal>
  );
}

function PromoteDialog({
  name,
  version,
  aliases,
  onCancel,
  onReview,
}: {
  name: string;
  version: number | null;
  aliases: AliasInfo[];
  onCancel: () => void;
  onReview: (alias: string) => void;
}) {
  const [alias, setAlias] = useState("");
  const chosen = alias || aliases[0]?.alias || "prod";
  const valid = isValidAliasName(chosen);
  return (
    <Modal
      open={version !== null}
      onClose={onCancel}
      title={`Promote ${name} v${version ?? ""}`}
      actions={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!valid} onClick={() => onReview(chosen)}>
            Review…
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="promote-alias">Alias</label>
        <input
          id="promote-alias"
          type="text"
          list="promote-alias-options"
          value={alias}
          placeholder={aliases[0]?.alias ?? "prod"}
          onChange={(e) => setAlias(e.target.value.trim())}
          aria-describedby="promote-alias-hint"
          aria-invalid={!valid}
        />
        <datalist id="promote-alias-options">
          {aliases.map((a) => (
            <option key={a.alias} value={a.alias} />
          ))}
        </datalist>
        <span id="promote-alias-hint" className="hint">
          {valid ? <>All new traffic on {name}@{chosen} will go to v{version}. Pick an existing alias or type a new one.</> : "Letters, digits, - and _ only."}
        </span>
      </div>
    </Modal>
  );
}

function CanaryForm({ versions, aliases, onReview }: { versions: number[]; aliases: AliasInfo[]; onReview: (alias: string, target: AliasTarget) => void }) {
  const firstAlias = aliases[0];
  const [alias, setAlias] = useState("");
  const [stable, setStable] = useState<number | "">("");
  const [canary, setCanary] = useState<number | "">("");
  const [percent, setPercent] = useState(10);

  const aliasName = alias || firstAlias?.alias || "prod";
  const current = aliases.find((a) => a.alias === aliasName);
  const stableV = stable || current?.versions[0]?.version || versions[1] || versions[0] || 0;
  const canaryV = canary || versions[0] || 0;

  let target: AliasTarget | null = null;
  let problem: string | null = null;
  try {
    if (!isValidAliasName(aliasName)) throw new Error("alias names use letters, digits, - and _");
    if (stableV === canaryV) throw new Error("pick two different versions");
    target = canaryTarget(stableV, canaryV, percent);
    problem = validateTarget(target);
  } catch (e) {
    problem = (e as Error).message;
  }

  if (versions.length < 2) return null;
  return (
    <section className="card" aria-labelledby="canary-h">
      <h2 id="canary-h">Canary split</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Send a percentage of new sessions on an alias to a second version.
      </p>
      <form
        className="row"
        style={{ alignItems: "flex-end", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (target && !problem) onReview(aliasName, target);
        }}
      >
        <div className="field">
          <label htmlFor="split-alias">Alias</label>
          <input id="split-alias" type="text" list="split-alias-options" value={alias} placeholder={firstAlias?.alias ?? "prod"} onChange={(e) => setAlias(e.target.value.trim())} style={{ width: 140 }} />
          <datalist id="split-alias-options">
            {aliases.map((a) => (
              <option key={a.alias} value={a.alias} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="split-stable">Stable version</label>
          <select id="split-stable" value={stableV} onChange={(e) => setStable(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="split-canary">Canary version</label>
          <select id="split-canary" value={canaryV} onChange={(e) => setCanary(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ minWidth: 220, flex: "1 1 220px" }}>
          <label htmlFor="split-percent">Canary share: {percent}%</label>
          <div className="row">
            <input id="split-percent" type="range" min={0} max={100} step={1} value={percent} onChange={(e) => setPercent(Number(e.target.value))} style={{ flex: 1 }} />
            <label htmlFor="split-percent-num" className="visually-hidden">
              Canary percent
            </label>
            <input
              id="split-percent-num"
              type="number"
              min={0}
              max={100}
              value={percent}
              onChange={(e) => setPercent(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              style={{ width: 72 }}
            />
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={!!problem}>
          Review split…
        </button>
      </form>
      <p className="small" aria-live="polite" style={{ marginBottom: 0 }}>
        {problem ? <span style={{ color: "var(--danger)" }}>{problem}</span> : target ? <>Result: {describeTarget(target.versions)}</> : null}
      </p>
    </section>
  );
}
