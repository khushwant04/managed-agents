"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { motion } from "motion/react"
import { ActivityIcon, ArrowRightIcon, ChevronRightIcon, FlaskConicalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EASE_OUT } from "@/components/motion"
import { StatusBadge } from "@/components/status-badge"
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states"
import { useNow } from "@/hooks/use-client"
import type { ApiState } from "@/hooks/use-api"
import type { SessionList } from "@/lib/api"
import { seg } from "@/lib/client"
import { formatDateTime, shortId, timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

const HEAD = "text-xs font-normal text-muted-foreground"

export function SessionsTab({ name, state }: { name: string; state: ApiState<SessionList> }) {
  const router = useRouter()
  const now = useNow()
  const ago = (iso: string) => (now ? timeAgo(iso, now) : "")

  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />
  if (!state.data) {
    return (
      <Card className="p-4">
        <TableSkeleton rows={4} cols={5} />
      </Card>
    )
  }
  const sessions = state.data.sessions
  if (!sessions.length) {
    return (
      <EmptyState
        icon={<ActivityIcon />}
        title="No sessions yet"
        description={`Every invocation of ${name} opens a session with a full event timeline.`}
        action={
          <Button render={<Link href={`/playground?agent=${seg(name)}`} />}>
            <FlaskConicalIcon data-icon="inline-start" />
            Run it in the playground
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, "pl-4")}>Session</TableHead>
              <TableHead className={HEAD}>Route</TableHead>
              <TableHead className={HEAD}>Status</TableHead>
              <TableHead className={HEAD}>Started</TableHead>
              <TableHead className={HEAD}>Last active</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s, i) => (
              <motion.tr
                key={s.id}
                data-slot="table-row"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: EASE_OUT, delay: Math.min(i, 12) * 0.03 }}
                onClick={() => router.push(`/sessions/${seg(s.id)}`)}
                className="group/row cursor-pointer border-b transition-colors hover:bg-muted/50"
              >
                <TableCell className="py-2.5 pl-4">
                  <Link
                    href={`/sessions/${seg(s.id)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-mono text-xs hover:underline"
                    title={s.id}
                  >
                    {shortId(s.id, 12)}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {s.alias ? <span>@{s.alias}</span> : <span className="text-muted-foreground">direct</span>}
                  <span className="text-muted-foreground"> · v{s.version}</span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={s.status} />
                </TableCell>
                <TableCell className="text-muted-foreground" title={formatDateTime(s.created_at)}>
                  {ago(s.created_at)}
                </TableCell>
                <TableCell className="text-muted-foreground" title={formatDateTime(s.last_active_at)}>
                  {ago(s.last_active_at)}
                </TableCell>
                <TableCell className="pr-3">
                  <ChevronRightIcon className="size-4 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover/row:translate-x-0 group-hover/row:opacity-100" />
                </TableCell>
              </motion.tr>
            ))}
          </TableBody>
        </Table>
      </Card>
      <Button variant="ghost" size="sm" className="self-end" render={<Link href={`/sessions?agent=${seg(name)}`} />}>
        All sessions for {name}
        <ArrowRightIcon data-icon="inline-end" />
      </Button>
    </div>
  )
}
