"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AnimatePresence } from "motion/react"
import { PlusIcon, RocketIcon, SearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Page, PageHeader } from "@/components/page"
import { FadeIn } from "@/components/motion"
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states"
import { StatusBadge } from "@/components/status-badge"
import { useCan } from "@/components/shell/project-context"
import { CreateDeploymentDialog } from "@/components/deploy/create-deployment-dialog"
import { MotionRow, RowChevron, rowLink } from "@/components/deploy/motion-row"
import { TriggerChips } from "@/components/deploy/trigger-chip"
import { useNewDialog } from "@/components/deploy/use-new-param"
import { useApi } from "@/hooks/use-api"
import { useNow } from "@/hooks/use-client"
import type { DeploymentList } from "@/lib/api"
import { seg } from "@/lib/client"
import { formatDateTime, timeAgo } from "@/lib/format"

type Filter = "all" | "active" | "paused"

export function DeploymentsView() {
  const router = useRouter()
  const canWrite = useCan("developer")
  const now = useNow()
  const [creating, setCreating] = useNewDialog(canWrite)
  const { data, error, loading, reload } = useApi<DeploymentList>("/v1/deployments")
  const [query, setQuery] = React.useState("")
  const [filter, setFilter] = React.useState<Filter>("all")

  const all = data?.deployments ?? []
  const q = query.trim().toLowerCase()
  const rows = all.filter(
    (d) =>
      (filter === "all" || d.status === filter) &&
      (!q || [d.name, d.agent, d.alias, d.id].some((s) => s.toLowerCase().includes(q)))
  )

  const createButton = canWrite ? (
    <Button onClick={() => setCreating(true)}>
      <PlusIcon data-icon="inline-start" />
      Create deployment
    </Button>
  ) : null

  return (
    <Page>
      <PageHeader
        title="Deployments"
        description="Agent aliases made reachable through HTTP, signed webhooks, cron schedules and queues."
        actions={createButton}
      />

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {data && all.length === 0 ? (
        <EmptyState
          icon={<RocketIcon />}
          title="No deployments yet"
          description="Deploy an agent alias to give it an HTTP endpoint, a webhook URL, a schedule or a queue."
          action={createButton}
        />
      ) : !error ? (
        <FadeIn delay={0.05} className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <InputGroup className="sm:max-w-xs">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                placeholder="Search deployments"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search deployments"
              />
            </InputGroup>
            <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="active">Active</TabsTrigger>
                <TabsTrigger value="paused">Paused</TabsTrigger>
              </TabsList>
            </Tabs>
            <span className="text-xs text-muted-foreground tabular-nums sm:ml-auto">
              {data ? `${rows.length} of ${all.length}` : ""}
            </span>
          </div>

          <Card className="py-0">
            {loading && !data ? (
              <div className="p-4">
                <TableSkeleton rows={4} cols={6} />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4 text-xs text-muted-foreground">Name</TableHead>
                    <TableHead className="text-xs text-muted-foreground">Agent</TableHead>
                    <TableHead className="text-xs text-muted-foreground">Triggers</TableHead>
                    <TableHead className="text-xs text-muted-foreground">Status</TableHead>
                    <TableHead className="text-right text-xs text-muted-foreground">Concurrency</TableHead>
                    <TableHead className="text-xs text-muted-foreground">Created</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <AnimatePresence initial={false}>
                    {rows.map((d, i) => {
                      const href = `/deployments/${seg(d.name)}`
                      return (
                        <MotionRow key={d.id} index={i} {...rowLink(() => router.push(href))}>
                          <TableCell className="py-3 pl-4">
                            <Link href={href} className="font-medium hover:underline">
                              {d.name}
                            </Link>
                            <div className="font-mono text-xs text-muted-foreground">{d.id.slice(0, 16)}…</div>
                          </TableCell>
                          <TableCell>
                            <Link href={`/agents/${seg(d.agent)}`} className="font-mono text-xs hover:underline">
                              {d.agent}
                              <span className="text-muted-foreground">@{d.alias}</span>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <TriggerChips triggers={d.triggers} className="flex-nowrap" />
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={d.status} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{d.concurrency}</TableCell>
                          <TableCell className="text-xs text-muted-foreground" title={formatDateTime(d.created_at)}>
                            {now ? timeAgo(d.created_at, now) : ""}
                          </TableCell>
                          <TableCell className="pr-3">
                            <RowChevron />
                          </TableCell>
                        </MotionRow>
                      )
                    })}
                  </AnimatePresence>
                  {data && rows.length === 0 ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                        No deployments match.{" "}
                        <button
                          type="button"
                          className="underline underline-offset-3 hover:text-foreground"
                          onClick={() => {
                            setQuery("")
                            setFilter("all")
                          }}
                        >
                          Clear filters
                        </button>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )}
          </Card>
        </FadeIn>
      ) : null}

      <CreateDeploymentDialog open={creating} onOpenChange={setCreating} onCreated={() => reload()} />
    </Page>
  )
}
