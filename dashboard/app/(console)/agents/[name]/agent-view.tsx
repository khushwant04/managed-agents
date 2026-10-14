"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowLeftIcon, BotIcon, FlaskConicalIcon, RocketIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Spinner } from "@/components/ui/spinner"
import { BackLink, Page } from "@/components/page"
import { FadeIn } from "@/components/motion"
import { AgentArt } from "@/components/agent-art"
import { EmptyState, ErrorState } from "@/components/states"
import { useCan } from "@/components/shell/project-context"
import { AliasDialog, draftFor, type AliasDraft } from "@/components/agents/alias-dialog"
import { useApi, useMutation } from "@/hooks/use-api"
import { describeTarget } from "@/lib/alias"
import type { AgentVersion, AliasList, AliasResult, SessionList, VersionList } from "@/lib/api"
import { api, ApiError, seg } from "@/lib/client"
import { OverviewTab } from "./overview-tab"
import { VersionsTab } from "./versions-tab"
import { AliasesTab } from "./aliases-tab"
import { SessionsTab } from "./sessions-tab"
import { SpecSheet } from "./spec-sheet"

type Tab = "overview" | "versions" | "aliases" | "sessions"

export interface AliasActions {
  canWrite: boolean
  /** Open the promote / canary dialog. */
  edit: (opts: { alias?: string; version?: number; mode?: "single" | "split" }) => void
  rollback: (alias: string) => void
  viewSpec: (version: number) => void
}

function Count({ n }: { n: number | undefined }) {
  if (n === undefined) return null
  return <span className="rounded-full bg-muted px-1.5 text-[11px] leading-4 text-muted-foreground tabular-nums">{n}</span>
}

export function AgentView({ name }: { name: string }) {
  const base = `/v1/agents/${seg(name)}`
  const canWrite = useCan("developer")
  const versions = useApi<VersionList>(`${base}/versions`)
  const aliases = useApi<AliasList>(`${base}/aliases`)
  const sessions = useApi<SessionList>("/v1/sessions", { agent: name, limit: 50 })

  const versionList = React.useMemo(
    () => [...(versions.data?.versions ?? [])].sort((a, b) => b.version - a.version),
    [versions.data]
  )
  const versionNums = React.useMemo(() => versionList.map((v) => v.version), [versionList])
  const latestNum = versionNums[0]
  const latest = useApi<AgentVersion>(latestNum ? `${base}/versions/${latestNum}` : null)
  const aliasList = React.useMemo(() => aliases.data?.aliases ?? [], [aliases.data])

  const [tab, setTab] = React.useState<Tab>("overview")
  const [aliasDraft, setAliasDraft] = React.useState<AliasDraft | null>(null)
  const [rollbackAlias, setRollbackAlias] = React.useState<string | null>(null)
  const [specVersion, setSpecVersion] = React.useState<number | null>(null)
  const rollback = useMutation()

  const actions: AliasActions = {
    canWrite,
    edit: (opts) => setAliasDraft(draftFor(aliasList, versionNums, opts)),
    rollback: (alias) => {
      rollback.setError(null)
      setRollbackAlias(alias)
    },
    viewSpec: setSpecVersion,
  }

  async function confirmRollback() {
    if (!rollbackAlias) return
    const r = await rollback.run(() => api<AliasResult>(`${base}/aliases/${seg(rollbackAlias)}/rollback`, { method: "POST" }))
    if (!r) return
    toast.success(`Rolled back ${name}@${r.alias}`, { description: `Now routes to ${describeTarget(r.versions)}.` })
    setRollbackAlias(null)
    aliases.reload()
  }

  const notFound = versions.error instanceof ApiError && versions.error.status === 404
  if (notFound) {
    return (
      <Page>
        <EmptyState
          icon={<BotIcon />}
          title={`No agent named “${name}”`}
          description="It may have been registered in another project, or the name is misspelled."
          action={
            <Button variant="outline" render={<Link href="/agents" />}>
              <ArrowLeftIcon data-icon="inline-start" />
              All agents
            </Button>
          }
        />
      </Page>
    )
  }

  const spec = (latest.data?.spec ?? null) as Record<string, unknown> | null
  const description = (spec?.description as string | undefined) ?? ""
  const tags = Array.isArray(spec?.tags) ? (spec.tags as string[]) : []
  const loadingHead = !versions.data && !versions.error

  return (
    <Page className="gap-6">
      <BackLink href="/agents">Agents</BackLink>
      <FadeIn y={4} className="flex flex-col">
        <div className="relative overflow-hidden rounded-xl ring-1 ring-foreground/10">
          <AgentArt name={name} className="h-24 md:h-32" />
        </div>
        <div className="flex flex-col gap-4 px-1 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 items-end gap-4">
            <div className="-mt-8 shrink-0 rounded-2xl bg-background p-1 shadow-card ring-1 ring-foreground/10 md:-mt-10">
              <div className="relative size-14 overflow-hidden rounded-xl md:size-16">
                <AgentArt name={name} className="absolute inset-0 scale-150" />
                <span className="absolute inset-0 flex items-center justify-center font-heading text-2xl font-semibold text-white uppercase drop-shadow-sm">
                  {name.slice(0, 1)}
                </span>
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-1 pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate font-heading text-2xl font-semibold tracking-tight">{name}</h1>
                {latestNum ? (
                  <Badge variant="secondary" className="font-mono">
                    v{latestNum} latest
                  </Badge>
                ) : loadingHead ? (
                  <Skeleton className="h-5 w-16 rounded-full" />
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="outline" render={<Link href={`/playground?agent=${seg(name)}`} />}>
              <FlaskConicalIcon data-icon="inline-start" />
              Open in playground
            </Button>
            {canWrite ? (
              <Button
                disabled={!latestNum}
                onClick={() => actions.edit({ version: latestNum, mode: "single" })}
              >
                <RocketIcon data-icon="inline-start" />
                Promote
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 px-1">
          {latest.data || latest.error ? (
            <p className="max-w-3xl text-sm text-muted-foreground">{description || "No description."}</p>
          ) : (
            <Skeleton className="h-4 w-80 max-w-full" />
          )}
          {tags.length ? (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <Badge key={t} variant="outline" className="h-5 rounded-md text-[11px] font-normal">
                  {t}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </FadeIn>

      {versions.error ? <ErrorState error={versions.error} onRetry={versions.reload} /> : null}

      <FadeIn delay={0.08}>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-5">
          <div className="-mx-4 overflow-x-auto border-b px-4 md:mx-0 md:px-0">
            <TabsList variant="line" className="h-9">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="versions">
                Versions <Count n={versions.data ? versionList.length : undefined} />
              </TabsTrigger>
              <TabsTrigger value="aliases">
                Aliases <Count n={aliases.data ? aliasList.length : undefined} />
              </TabsTrigger>
              <TabsTrigger value="sessions">
                Sessions <Count n={sessions.data?.sessions.length} />
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="overview">
            <OverviewTab
              name={name}
              latest={latest}
              aliases={aliasList}
              aliasesLoading={aliases.loading && !aliases.data}
              versionCount={versionList.length}
              sessionCount={sessions.data?.sessions.length}
              onManageAliases={() => setTab("aliases")}
              actions={actions}
            />
          </TabsContent>
          <TabsContent value="versions">
            <VersionsTab name={name} versions={versionList} loading={versions.loading && !versions.data} aliases={aliasList} actions={actions} />
          </TabsContent>
          <TabsContent value="aliases">
            <AliasesTab
              name={name}
              aliases={aliasList}
              loading={aliases.loading && !aliases.data}
              error={aliases.error}
              onRetry={aliases.reload}
              hasVersions={versionList.length > 0}
              actions={actions}
            />
          </TabsContent>
          <TabsContent value="sessions">
            <SessionsTab name={name} state={sessions} />
          </TabsContent>
        </Tabs>
      </FadeIn>

      <AliasDialog
        name={name}
        versions={versionNums}
        aliases={aliasList}
        draft={aliasDraft}
        onOpenChange={(open) => !open && setAliasDraft(null)}
        onDone={() => {
          setAliasDraft(null)
          aliases.reload()
        }}
      />

      <SpecSheet name={name} version={specVersion} onClose={() => setSpecVersion(null)} aliases={aliasList} actions={actions} />

      <AlertDialog open={rollbackAlias !== null} onOpenChange={(open) => !open && setRollbackAlias(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Roll back <span className="font-mono">{name}@{rollbackAlias}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The alias goes back to its previous target (it currently routes to{" "}
              {describeTarget(aliasList.find((a) => a.alias === rollbackAlias)?.versions ?? [])}). New sessions follow
              immediately; running sessions keep their version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rollback.error ? <p className="text-sm text-destructive">{rollback.error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={rollback.pending} onClick={() => void confirmRollback()}>
              {rollback.pending ? <Spinner data-icon="inline-start" /> : null}
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}
