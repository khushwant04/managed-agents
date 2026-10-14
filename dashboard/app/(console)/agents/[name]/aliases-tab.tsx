"use client"

import * as React from "react"
import { GitBranchIcon, PencilIcon, PlusIcon, Undo2Icon, SplitIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Stagger, StaggerItem } from "@/components/motion"
import { CopyButton } from "@/components/copy-button"
import { EmptyState, ErrorState } from "@/components/states"
import { WeightBar } from "@/components/agents/weight-bar"
import { useNow } from "@/hooks/use-client"
import { describeTarget } from "@/lib/alias"
import type { AliasInfo } from "@/lib/api"
import { formatDateTime, timeAgo } from "@/lib/format"
import type { AliasActions } from "./agent-view"

export function AliasesTab({
  name,
  aliases,
  loading,
  error,
  onRetry,
  hasVersions,
  actions,
}: {
  name: string
  aliases: AliasInfo[]
  loading: boolean
  error: Error | undefined
  onRetry: () => void
  hasVersions: boolean
  actions: AliasActions
}) {
  const now = useNow()
  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-44 rounded-xl" />
      </div>
    )
  }
  if (!aliases.length) {
    return (
      <EmptyState
        icon={<GitBranchIcon />}
        title="No aliases yet"
        description="Aliases like prod and canary give callers a stable name while you move traffic between versions."
        action={
          actions.canWrite && hasVersions ? (
            <Button onClick={() => actions.edit({ alias: "prod", mode: "single" })}>
              <PlusIcon data-icon="inline-start" />
              Create prod alias
            </Button>
          ) : null
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Invoke <span className="font-mono text-foreground">{name}@alias</span>; a bare <span className="font-mono text-foreground">{name}</span> means @prod.
        </p>
        {actions.canWrite ? (
          <Button variant="outline" size="sm" onClick={() => actions.edit({ alias: "", mode: "single" })}>
            <PlusIcon data-icon="inline-start" />
            New alias
          </Button>
        ) : null}
      </div>
      <Stagger className="grid gap-4 md:grid-cols-2" gap={0.06}>
        {aliases.map((a, i) => {
          const split = a.versions.length > 1
          return (
            <StaggerItem key={a.alias} className="flex">
              <Card className="flex-1">
                <CardHeader>
                  <CardTitle className="flex items-center gap-1 font-mono text-sm">
                    {name}@{a.alias}
                    <CopyButton value={`${name}@${a.alias}`} size="icon-xs" label="Copy target" />
                  </CardTitle>
                  <CardAction>
                    <Badge variant={split ? "warning" : "success"}>{split ? "split" : "single"}</Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="font-heading text-xl font-semibold tracking-tight tabular-nums">{describeTarget(a.versions)}</div>
                  <WeightBar versions={a.versions} delay={0.1 + i * 0.08} />
                  <p className="text-xs text-muted-foreground" title={formatDateTime(a.updated_at)}>
                    Updated {now ? timeAgo(a.updated_at, now) : ""}
                    {a.updated_by ? <> by <span className="font-mono">{a.updated_by.replace(/^key:/, "").slice(0, 16)}</span></> : null}
                  </p>
                </CardContent>
                {actions.canWrite ? (
                  <CardFooter className="mt-auto gap-2 border-t bg-muted/30 py-3">
                    <Button variant="outline" size="sm" onClick={() => actions.edit({ alias: a.alias, mode: "single" })}>
                      <PencilIcon data-icon="inline-start" />
                      Set version
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => actions.edit({ alias: a.alias, mode: "split" })}>
                      <SplitIcon data-icon="inline-start" />
                      Canary
                    </Button>
                    <Button variant="ghost" size="sm" className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => actions.rollback(a.alias)}>
                      <Undo2Icon data-icon="inline-start" />
                      Roll back
                    </Button>
                  </CardFooter>
                ) : null}
              </Card>
            </StaggerItem>
          )
        })}
      </Stagger>
    </div>
  )
}
