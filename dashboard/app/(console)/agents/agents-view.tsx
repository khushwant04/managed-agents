"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { AnimatePresence, motion } from "motion/react"
import { BotIcon, ChevronRightIcon, LayoutGridIcon, PlusIcon, SearchIcon, TableIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Page, PageHeader } from "@/components/page"
import { EASE_OUT, FadeIn } from "@/components/motion"
import { AgentCard } from "@/components/agent-card"
import { AgentArt } from "@/components/agent-art"
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states"
import { useCan } from "@/components/shell/project-context"
import { exampleSpec, RegisterAgentDialog } from "@/components/agents/register-agent-dialog"
import { useStoredChoice } from "@/components/agents/use-stored-choice"
import { useApi } from "@/hooks/use-api"
import type { AgentList, AgentSummary } from "@/lib/api"
import { seg } from "@/lib/client"

const VIEWS = ["grid", "table"] as const
type View = (typeof VIEWS)[number]

function matches(a: AgentSummary, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    a.name.toLowerCase().includes(needle) ||
    a.description.toLowerCase().includes(needle) ||
    a.tags.some((t) => t.toLowerCase().includes(needle))
  )
}

/** "key:key_a5cf…" → "key_a5cf…" for compact owner cells. */
function owner(createdBy: string | null | undefined): string {
  if (!createdBy) return "–"
  const v = createdBy.replace(/^key:/, "")
  return v.length > 16 ? `${v.slice(0, 12)}…` : v
}

export function AgentsView() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const canWrite = useCan("developer")
  const { data, error, loading, reload } = useApi<AgentList>("/v1/agents")
  const [view, setView] = useStoredChoice<View>("agents.view", VIEWS, "grid")
  const [query, setQuery] = React.useState("")
  const [dialogOpen, setDialogOpen] = React.useState(false)

  const wantsNew = params.get("new") === "1" && canWrite
  const registerOpen = dialogOpen || wantsNew

  const agents = React.useMemo(() => data?.agents ?? [], [data])
  const shown = React.useMemo(() => agents.filter((a) => matches(a, query.trim())), [agents, query])
  const defaultModel = "claude-opus-5-5"

  function setRegisterOpen(open: boolean) {
    setDialogOpen(open)
    if (!open && wantsNew) router.replace(pathname, { scroll: false })
  }

  const registerButton = canWrite ? (
    <Button onClick={() => setRegisterOpen(true)}>
      <PlusIcon data-icon="inline-start" />
      Register agent
    </Button>
  ) : null

  return (
    <Page>
      <PageHeader
        title="Agents"
        description="Versioned agent definitions. Each registration is immutable; aliases route traffic between versions."
        actions={
          <>
            <Button variant="outline" render={<Link href="/playground" />}>
              Open playground
            </Button>
            {registerButton}
          </>
        }
      />

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {!error && data && agents.length === 0 ? (
        <EmptyState
          icon={<BotIcon />}
          title="No agents yet"
          description="Register a spec here, push one with `runhive apply`, or start from a template in the playground."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {registerButton}
              <Button variant="outline" render={<Link href="/playground" />}>
                Browse templates
              </Button>
            </div>
          }
        />
      ) : !error ? (
        <div className="flex flex-col gap-4">
          <FadeIn delay={0.05} className="flex flex-wrap items-center gap-2">
            <InputGroup className="w-full sm:w-80">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                placeholder="Search name, description or tag"
                aria-label="Search agents"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              />
              {query ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                    <XIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[view]}
              onValueChange={(v) => v[0] && setView(v[0] as View)}
              aria-label="Layout"
            >
              <Tooltip>
                <TooltipTrigger render={<ToggleGroupItem value="grid" aria-label="Card grid" />}>
                  <LayoutGridIcon />
                </TooltipTrigger>
                <TooltipContent>Cards</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<ToggleGroupItem value="table" aria-label="Table" />}>
                  <TableIcon />
                </TooltipTrigger>
                <TooltipContent>Table</TooltipContent>
              </Tooltip>
            </ToggleGroup>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {data ? (query ? `${shown.length} of ${agents.length}` : `${agents.length} agent${agents.length === 1 ? "" : "s"}`) : null}
            </span>
          </FadeIn>

          {loading && !data ? (
            view === "grid" ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-52 rounded-xl" />
                ))}
              </div>
            ) : (
              <Card className="p-4">
                <TableSkeleton rows={5} cols={5} />
              </Card>
            )
          ) : shown.length === 0 ? (
            <FadeIn className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-14 text-center">
              <SearchIcon className="size-5 text-muted-foreground" />
              <p className="text-sm font-medium">No agents match “{query.trim()}”</p>
              <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </FadeIn>
          ) : view === "grid" ? (
            <AgentGrid agents={shown} />
          ) : (
            <AgentTable agents={shown} onOpen={(name) => router.push(`/agents/${seg(name)}`)} />
          )}
        </div>
      ) : null}

      {canWrite ? (
        <RegisterAgentDialog
          open={registerOpen}
          onOpenChange={setRegisterOpen}
          initialSpec={exampleSpec(defaultModel)}
          onRegistered={(r) => {
            setDialogOpen(false)
            reload()
            router.push(`/agents/${seg(r.name)}`)
          }}
        />
      ) : null}
    </Page>
  )
}

function AgentGrid({ agents }: { agents: AgentSummary[] }) {
  return (
    <motion.div layout className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <AnimatePresence mode="popLayout" initial>
        {agents.map((a, i) => (
          <motion.div
            key={a.name}
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT, delay: Math.min(i, 10) * 0.04 } }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
            className="flex"
          >
            <AgentCard agent={a} className="flex-1" />
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  )
}

function AgentTable({ agents, onOpen }: { agents: AgentSummary[]; onOpen: (name: string) => void }) {
  return (
    <FadeIn y={4}>
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4 text-xs font-normal text-muted-foreground">Name</TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground">Description</TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground">Tags</TableHead>
              <TableHead className="text-right text-xs font-normal text-muted-foreground">Latest</TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground">Owner</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.map((a, i) => (
              <motion.tr
                key={a.name}
                data-slot="table-row"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: EASE_OUT, delay: Math.min(i, 12) * 0.03 }}
                onClick={() => onOpen(a.name)}
                className="group/row cursor-pointer border-b transition-colors hover:bg-muted/50"
              >
                <TableCell className="py-2.5 pl-4">
                  <div className="flex items-center gap-2.5">
                    <AgentArt name={a.name} className="size-7 shrink-0 rounded-md ring-1 ring-foreground/10" />
                    <Link
                      href={`/agents/${seg(a.name)}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium outline-none hover:underline focus-visible:underline"
                    >
                      {a.name}
                    </Link>
                  </div>
                </TableCell>
                <TableCell className="max-w-80 truncate text-muted-foreground">{a.description || "–"}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {a.tags.slice(0, 3).map((t) => (
                      <Badge key={t} variant="outline" className="h-5 rounded-md text-[11px] font-normal">
                        {t}
                      </Badge>
                    ))}
                    {a.tags.length > 3 ? <Badge variant="muted">+{a.tags.length - 3}</Badge> : null}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">v{a.latest_version}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground" title={a.created_by ?? undefined}>
                  {owner(a.created_by)}
                </TableCell>
                <TableCell className="pr-3">
                  <ChevronRightIcon className="size-4 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover/row:translate-x-0 group-hover/row:opacity-100" />
                </TableCell>
              </motion.tr>
            ))}
          </TableBody>
        </Table>
      </Card>
    </FadeIn>
  )
}
