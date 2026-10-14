"use client"

import * as React from "react"
import { AlertTriangleIcon } from "lucide-react"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Expand } from "@/components/motion"
import { useApi } from "@/hooks/use-api"
import type { AgentList, AliasInfo, AliasList, VersionList, VersionSummary } from "@/lib/api"
import { describeTarget, isValidAliasName } from "@/lib/alias"
import { api, seg } from "@/lib/client"

const NEW_ALIAS = "__new__"

/** Which agent and alias a deployment serves. `mode: "new"` points `alias` at `version` on create. */
export interface TargetValue {
  agent: string
  alias: string
  mode: "existing" | "new"
  version: string
}

export const EMPTY_TARGET: TargetValue = { agent: "", alias: "", mode: "existing", version: "" }

export function targetError(v: TargetValue): string | null {
  if (!v.agent) return "pick an agent"
  if (v.mode === "new") {
    if (!isValidAliasName(v.alias)) return "alias names use letters, digits, - and _"
    if (!v.version) return "pick a version for the new alias"
  } else if (!v.alias) return "pick an alias"
  return null
}

/** The `agent`, `alias` and `version` fields of a DeploymentCreate. */
export function targetPayload(v: TargetValue): { agent: string; alias: string; version?: number } {
  return v.mode === "new" ? { agent: v.agent, alias: v.alias, version: Number(v.version) } : { agent: v.agent, alias: v.alias }
}

interface AgentMeta {
  aliases: AliasInfo[]
  versions: VersionSummary[]
}

/** Agent + alias pickers; a new alias can be created from a version. */
export function AgentTargetFields({
  value,
  onChange,
  showErrors,
}: {
  value: TargetValue
  onChange: (v: TargetValue) => void
  showErrors?: boolean
}) {
  const agents = useApi<AgentList>("/v1/agents")
  const [meta, setMeta] = React.useState<Record<string, AgentMeta | "loading" | Error>>({})
  const latest = React.useRef(value)
  React.useEffect(() => {
    latest.current = value
  })

  const pickAgent = async (agent: string) => {
    onChange({ ...EMPTY_TARGET, agent })
    if (meta[agent] && meta[agent] !== "loading" && !(meta[agent] instanceof Error)) {
      const m = meta[agent] as AgentMeta
      onChange({ ...EMPTY_TARGET, agent, ...defaultAlias(m) })
      return
    }
    setMeta((s) => ({ ...s, [agent]: "loading" }))
    try {
      const [a, v] = await Promise.all([
        api<AliasList>(`/v1/agents/${seg(agent)}/aliases`),
        api<VersionList>(`/v1/agents/${seg(agent)}/versions`),
      ])
      const m: AgentMeta = { aliases: a.aliases, versions: [...v.versions].sort((x, y) => y.version - x.version) }
      setMeta((s) => ({ ...s, [agent]: m }))
      if (latest.current.agent === agent && !latest.current.alias) onChange({ ...latest.current, ...defaultAlias(m) })
    } catch (e) {
      setMeta((s) => ({ ...s, [agent]: e instanceof Error ? e : new Error(String(e)) }))
    }
  }

  const current = meta[value.agent]
  const info = current && current !== "loading" && !(current instanceof Error) ? current : null
  const agentItems = (agents.data?.agents ?? []).map((a) => ({ value: a.name, label: a.name }))
  const aliasItems = [
    ...(info?.aliases ?? []).map((a) => ({ value: a.alias, label: a.alias })),
    { value: NEW_ALIAS, label: "New alias…" },
  ]
  const err = showErrors ? targetError(value) : null
  const clobbers = value.mode === "new" && info?.aliases.find((a) => a.alias === value.alias)

  return (
    <div className="flex flex-col">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field data-invalid={!!err && !value.agent}>
          <FieldLabel htmlFor="dep-agent">Agent</FieldLabel>
          <Select items={agentItems} value={value.agent || null} onValueChange={(v) => v && void pickAgent(String(v))}>
            <SelectTrigger id="dep-agent" className="w-full" aria-invalid={!!err && !value.agent}>
              <SelectValue placeholder={agents.loading ? "Loading agents…" : "Select an agent"} />
            </SelectTrigger>
            <SelectContent>
              {agentItems.map((a) => (
                <SelectItem key={a.value} value={a.value}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="dep-alias">Alias</FieldLabel>
          <Select
            items={aliasItems}
            value={value.mode === "new" ? NEW_ALIAS : value.alias || null}
            disabled={!value.agent || current === "loading"}
            onValueChange={(v) => {
              if (v === NEW_ALIAS) onChange({ ...value, mode: "new", alias: "", version: String(info?.versions[0]?.version ?? "") })
              else if (v) onChange({ ...value, mode: "existing", alias: String(v), version: "" })
            }}
          >
            <SelectTrigger id="dep-alias" className="w-full">
              <SelectValue placeholder={current === "loading" ? "Loading…" : "Select an alias"} />
            </SelectTrigger>
            <SelectContent>
              {(info?.aliases ?? []).map((a) => (
                <SelectItem key={a.alias} value={a.alias}>
                  <span className="font-medium">{a.alias}</span>
                  <span className="text-xs text-muted-foreground">{describeTarget(a.versions)}</span>
                </SelectItem>
              ))}
              {info?.aliases.length ? <SelectSeparator /> : null}
              <SelectItem value={NEW_ALIAS}>New alias from a version…</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Expand open={value.mode === "new"}>
        <div className="grid gap-3 pt-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="dep-new-alias">Alias name</FieldLabel>
            <Input
              id="dep-new-alias"
              placeholder="e.g. webhooks"
              value={value.alias}
              onChange={(e) => onChange({ ...value, alias: e.target.value.trim() })}
              aria-invalid={showErrors && value.mode === "new" && !isValidAliasName(value.alias)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="dep-version">Version</FieldLabel>
            <Select
              items={(info?.versions ?? []).map((v) => ({ value: String(v.version), label: `v${v.version}` }))}
              value={value.version || null}
              onValueChange={(v) => v && onChange({ ...value, version: String(v) })}
            >
              <SelectTrigger id="dep-version" className="w-full">
                <SelectValue placeholder="Select a version" />
              </SelectTrigger>
              <SelectContent>
                {(info?.versions ?? []).map((v) => (
                  <SelectItem key={v.version} value={String(v.version)}>
                    v{v.version}
                    <span className="font-mono text-xs text-muted-foreground">{v.hash.slice(0, 10)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {clobbers ? (
            <FieldDescription className="flex items-center gap-1.5 text-warning sm:col-span-2">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              {value.alias} already exists; creating the deployment repoints it to v{value.version}.
            </FieldDescription>
          ) : null}
        </div>
      </Expand>

      {current instanceof Error ? <p className="mt-2 text-sm text-destructive">{current.message}</p> : null}
      {err ? <p className="mt-2 text-sm text-destructive">{err}</p> : null}
    </div>
  )
}

function defaultAlias(m: AgentMeta): Pick<TargetValue, "alias" | "mode" | "version"> {
  const prod = m.aliases.find((a) => a.alias === "prod") ?? m.aliases[0]
  if (prod) return { alias: prod.alias, mode: "existing", version: "" }
  return { alias: "prod", mode: "new", version: String(m.versions[0]?.version ?? "") }
}
