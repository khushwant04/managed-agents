"use client"

import * as React from "react"
import {
  ArrowRightIcon,
  BookOpenIcon,
  BotIcon,
  BracesIcon,
  CodeIcon,
  FileTextIcon,
  GlobeIcon,
  type LucideIcon,
  NetworkIcon,
  PlugIcon,
  ShieldCheckIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Stagger, StaggerItem } from "@/components/motion"
import { CodeBlock } from "@/components/code-block"
import { CopyButton } from "@/components/copy-button"
import { ErrorState } from "@/components/states"
import { WeightBar } from "@/components/agents/weight-bar"
import type { ApiState } from "@/hooks/use-api"
import { describeTarget } from "@/lib/alias"
import type { AgentVersion, AliasInfo, ToolRef } from "@/lib/api"
import { formatDateTime, formatDuration, formatNumber } from "@/lib/format"
import type { AliasActions } from "./agent-view"

interface SpecShape {
  models?: string[]
  instructions?: string
  tools?: ToolRef[]
  skills?: { name: string; version?: string | null; description?: string }[]
  reasoning?: string | null
  subagents?: { max_concurrent?: number; max_depth?: number; tools?: string[] | null } | null
  limits?: Record<string, number | null | undefined>
  environment?: { name?: string; provider?: string; template?: string; allow_internet?: boolean } | null
}

const BUILTIN_ICONS: Record<string, LucideIcon> = {
  shell: TerminalIcon,
  files: FileTextIcon,
  code: CodeIcon,
  web_search: GlobeIcon,
  web_fetch: GlobeIcon,
}

function toolIcon(t: ToolRef): LucideIcon {
  if (t.type === "builtin") return BUILTIN_ICONS[t.name] ?? WrenchIcon
  if (t.type === "function") return BracesIcon
  if (t.type === "mcp") return PlugIcon
  return BotIcon
}

function approvalLabel(a: unknown): string | null {
  if (a === undefined || a === null || a === "never" || a === false) return null
  if (a === "always" || a === true) return "always"
  return "conditional"
}

const LIMITS: { key: string; label: string; fmt: (n: number) => string }[] = [
  { key: "max_steps", label: "Max steps", fmt: formatNumber },
  { key: "max_tokens", label: "Max tokens / run", fmt: formatNumber },
  { key: "max_output_tokens", label: "Max output tokens", fmt: formatNumber },
  { key: "max_wall_clock_s", label: "Wall clock", fmt: (n) => formatDuration(n * 1000) },
  { key: "compact_at_tokens", label: "Compact at", fmt: formatNumber },
]

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm not-last:border-b">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h3>
}

export function OverviewTab({
  latest,
  aliases,
  aliasesLoading,
  versionCount,
  sessionCount,
  onManageAliases,
  actions,
}: {
  name: string
  latest: ApiState<AgentVersion>
  aliases: AliasInfo[]
  aliasesLoading: boolean
  versionCount: number
  sessionCount: number | undefined
  onManageAliases: () => void
  actions: AliasActions
}) {
  if (latest.error) return <ErrorState error={latest.error} onRetry={latest.reload} />
  const v = latest.data
  const spec = (v?.spec ?? {}) as SpecShape
  const models = spec.models ?? []
  const tools = spec.tools ?? []
  const skills = spec.skills ?? []
  const limits = spec.limits ?? {}

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Stagger className="flex min-w-0 flex-col gap-4" gap={0.06}>
        <StaggerItem>
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
              <CardDescription>From the latest version{v ? ` (v${v.version})` : ""}.</CardDescription>
              {v ? (
                <CardAction>
                  <Button variant="ghost" size="sm" onClick={() => actions.viewSpec(v.version)}>
                    <BracesIcon data-icon="inline-start" />
                    View spec
                  </Button>
                </CardAction>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {!v ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-6 w-56" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <>
                  <section className="flex flex-col gap-2">
                    <Heading>Models</Heading>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {models.map((m, i) => (
                        <Badge key={m} variant={i === 0 ? "secondary" : "outline"} className="h-6 gap-1.5 rounded-md font-mono">
                          {m}
                          {i > 0 ? <span className="font-sans text-[10px] text-muted-foreground">fallback {i}</span> : null}
                        </Badge>
                      ))}
                      {spec.reasoning ? (
                        <Badge variant="info" className="h-6 rounded-md">
                          reasoning: {spec.reasoning}
                        </Badge>
                      ) : null}
                    </div>
                  </section>

                  {spec.instructions ? (
                    <section className="flex flex-col gap-2">
                      <Heading>Instructions</Heading>
                      <CodeBlock code={spec.instructions} wrap className="[&_pre]:max-h-48 [&_code]:font-sans [&_pre]:text-[13px]!" />
                    </section>
                  ) : null}

                  <section className="flex flex-col gap-2">
                    <Heading>Tools · {tools.length}</Heading>
                    {tools.length ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {tools.map((t) => {
                          const Icon = toolIcon(t)
                          const approval = approvalLabel(t.approval)
                          return (
                            <div key={`${t.type}:${t.name}`} className="flex items-center gap-2.5 rounded-lg p-2 ring-1 ring-foreground/8 transition-colors hover:bg-muted/40">
                              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                                <Icon className="size-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-xs font-medium">{t.name}</div>
                                <div className="truncate text-xs text-muted-foreground">{t.description || t.url || t.type}</div>
                              </div>
                              {approval ? (
                                <Badge variant="warning" className="gap-1">
                                  <ShieldCheckIcon />
                                  {approval}
                                </Badge>
                              ) : null}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No tools. The agent only talks.</p>
                    )}
                  </section>

                  {skills.length ? (
                    <section className="flex flex-col gap-2">
                      <Heading>Skills · {skills.length}</Heading>
                      <div className="flex flex-wrap gap-1.5">
                        {skills.map((s) => (
                          <Badge key={s.name} variant="outline" className="h-6 gap-1.5 rounded-md">
                            <BookOpenIcon />
                            {s.name}
                            {s.version ? <span className="font-mono text-muted-foreground">@{s.version}</span> : null}
                          </Badge>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {spec.subagents ? (
                    <section className="flex flex-col gap-2">
                      <Heading>Subagents</Heading>
                      <div className="flex items-center gap-2 text-sm">
                        <NetworkIcon className="size-4 text-muted-foreground" />
                        Up to {spec.subagents.max_concurrent ?? 3} at once, {spec.subagents.max_depth ?? 2} levels deep
                      </div>
                    </section>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </StaggerItem>
        <StaggerItem>
          <Card>
            <CardHeader>
              <CardTitle>Limits</CardTitle>
              <CardDescription>Per-run budgets enforced by the runtime.</CardDescription>
            </CardHeader>
            <CardContent>
              {!v ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-foreground/8 ring-1 ring-foreground/8 sm:grid-cols-3">
                  {LIMITS.map((l) => {
                    const n = limits[l.key]
                    return (
                      <div key={l.key} className="flex flex-col gap-0.5 bg-card p-3">
                        <span className="text-xs text-muted-foreground">{l.label}</span>
                        <span className="font-medium tabular-nums">
                          {typeof n === "number" ? l.fmt(n) : <span className="text-muted-foreground">unlimited</span>}
                        </span>
                      </div>
                    )
                  })}
                  <div className="flex flex-col gap-0.5 bg-card p-3">
                    <span className="text-xs text-muted-foreground">Sandbox</span>
                    <span className="truncate font-medium">
                      {spec.environment ? `${spec.environment.provider ?? "e2b"} · ${spec.environment.template ?? "default"}` : <span className="text-muted-foreground">none</span>}
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </StaggerItem>
      </Stagger>

      <Stagger className="flex min-w-0 flex-col gap-4" gap={0.06} delay={0.1}>
        <StaggerItem>
          <Card>
            <CardHeader>
              <CardTitle>Traffic</CardTitle>
              <CardDescription>How aliases route new sessions.</CardDescription>
              <CardAction>
                <Button variant="ghost" size="sm" onClick={onManageAliases}>
                  Manage
                  <ArrowRightIcon data-icon="inline-end" />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {aliasesLoading ? (
                <>
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </>
              ) : aliases.length ? (
                aliases.map((a, i) => (
                  <div key={a.alias} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-mono font-medium">@{a.alias}</span>
                      <span className="font-mono text-xs text-muted-foreground">{describeTarget(a.versions)}</span>
                    </div>
                    <WeightBar versions={a.versions} delay={0.15 + i * 0.1} />
                  </div>
                ))
              ) : (
                <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
                  No aliases yet. Invocations of the bare name go to <span className="font-mono">@prod</span>.
                  {actions.canWrite && v ? (
                    <Button size="sm" variant="outline" onClick={() => actions.edit({ alias: "prod", version: v.version, mode: "single" })}>
                      Promote v{v.version} to prod
                    </Button>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>
        </StaggerItem>
        <StaggerItem>
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              {!v ? (
                <Skeleton className="h-32" />
              ) : (
                <div className="flex flex-col">
                  <Row label="Hash">
                    <span className="inline-flex items-center gap-1 font-mono text-xs">
                      {v.hash.slice(0, 12)}
                      <CopyButton value={v.hash} size="icon-xs" label="Copy hash" />
                    </span>
                  </Row>
                  <Row label="Created">{formatDateTime(v.created_at)}</Row>
                  <Row label="Created by">
                    <span className="font-mono text-xs break-all">{v.created_by ?? "–"}</span>
                  </Row>
                  <Row label="Versions">{versionCount}</Row>
                  <Row label="Recent sessions">{sessionCount ?? "–"}</Row>
                </div>
              )}
            </CardContent>
          </Card>
        </StaggerItem>
      </Stagger>
    </div>
  )
}
