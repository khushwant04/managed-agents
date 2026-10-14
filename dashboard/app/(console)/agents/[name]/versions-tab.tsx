"use client"

import * as React from "react"
import Link from "next/link"
import { motion } from "motion/react"
import { BracesIcon, FlaskConicalIcon, MoreHorizontalIcon, RocketIcon, SplitIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EASE_OUT } from "@/components/motion"
import { CopyButton } from "@/components/copy-button"
import { TableSkeleton } from "@/components/states"
import { versionFill } from "@/components/agents/weight-bar"
import { useNow } from "@/hooks/use-client"
import { aliasesForVersion } from "@/lib/alias"
import type { AliasInfo, VersionSummary } from "@/lib/api"
import { seg } from "@/lib/client"
import { formatDateTime, timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { AliasActions } from "./agent-view"

const HEAD = "text-xs font-normal text-muted-foreground"

/** "key:key_a5cf5b7ad613…" → "key_a5cf5b7a…". */
function shortActor(actor: string | null | undefined): string {
  if (!actor) return "–"
  const v = actor.replace(/^key:/, "")
  return v.length > 16 ? `${v.slice(0, 12)}…` : v
}

export function VersionsTab({
  name,
  versions,
  loading,
  aliases,
  actions,
}: {
  name: string
  versions: VersionSummary[]
  loading: boolean
  aliases: AliasInfo[]
  actions: AliasActions
}) {
  const now = useNow()
  const latest = versions[0]?.version

  if (loading) {
    return (
      <Card className="p-4">
        <TableSkeleton rows={3} cols={5} />
      </Card>
    )
  }

  return (
    <Card className="py-0">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn(HEAD, "pl-4")}>Version</TableHead>
            <TableHead className={HEAD}>Hash</TableHead>
            <TableHead className={HEAD}>Serving</TableHead>
            <TableHead className={HEAD}>Created by</TableHead>
            <TableHead className={HEAD}>Created</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((v, i) => {
            const serving = aliasesForVersion(aliases, v.version)
            return (
              <motion.tr
                key={v.version}
                data-slot="table-row"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: EASE_OUT, delay: Math.min(i, 12) * 0.035 }}
                onClick={() => actions.viewSpec(v.version)}
                className="group/row cursor-pointer border-b transition-colors hover:bg-muted/50"
              >
                <TableCell className="py-2.5 pl-4">
                  <span className="inline-flex items-center gap-2">
                    <span className={cn("size-2 rounded-full", versionFill(v.version))} />
                    <span className="font-mono font-medium">v{v.version}</span>
                    {v.version === latest ? <Badge variant="muted">latest</Badge> : null}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-0.5 font-mono text-xs text-muted-foreground" title={v.hash}>
                    {v.hash.slice(0, 12)}
                    <span onClick={(e) => e.stopPropagation()} className="opacity-0 transition-opacity group-hover/row:opacity-100">
                      <CopyButton value={v.hash} size="icon-xs" label="Copy hash" />
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {serving.length ? (
                      serving.map((a) => (
                        <Badge key={a.alias} variant="info" className="font-mono">
                          @{a.alias}
                          {a.weight !== 100 ? <span className="opacity-70">{a.weight}%</span> : null}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">–</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground" title={v.created_by ?? undefined}>
                  {shortActor(v.created_by)}
                </TableCell>
                <TableCell className="text-muted-foreground" title={formatDateTime(v.created_at)}>
                  {now ? timeAgo(v.created_at, now) : ""}
                </TableCell>
                <TableCell className="pr-3 text-right" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for v${v.version}`} />}>
                      <MoreHorizontalIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={() => actions.viewSpec(v.version)}>
                        <BracesIcon />
                        View spec
                      </DropdownMenuItem>
                      <DropdownMenuItem render={<Link href={`/playground?agent=${seg(name)}&target=${v.version}`} />}>
                        <FlaskConicalIcon />
                        Run in playground
                      </DropdownMenuItem>
                      {actions.canWrite ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => actions.edit({ version: v.version, mode: "single" })}>
                            <RocketIcon />
                            Promote to alias…
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={versions.length < 2}
                            onClick={() => actions.edit({ version: v.version, mode: "split" })}
                          >
                            <SplitIcon />
                            Canary…
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </motion.tr>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}
