"use client"

import * as React from "react"
import Link from "next/link"
import { AnimatePresence, motion } from "motion/react"
import {
  ArrowLeftIcon,
  CircleStopIcon,
  CornerLeftUpIcon,
  HistoryIcon,
  MessagesSquareIcon,
  OctagonXIcon,
  PauseIcon,
  RocketIcon,
  SearchXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AgentArt } from "@/components/agent-art"
import { CopyButton } from "@/components/copy-button"
import { EASE_OUT, FadeIn } from "@/components/motion"
import { BackLink, Page } from "@/components/page"
import { EmptyState, ErrorState } from "@/components/states"
import { StatusBadge } from "@/components/status-badge"
import { Composer } from "@/components/session/composer"
import { JumpToLatest, useFollow } from "@/components/session/follow"
import { ReplayPanel } from "@/components/session/replay"
import { SidePanel } from "@/components/session/side-panel"
import { TimeAgo } from "@/components/session/time-ago"
import { QUIET_KINDS, Timeline, type Decide } from "@/components/session/timeline"
import { useSessionEvents, type Connection } from "@/components/session/use-session-events"
import { useCan } from "@/components/shell/project-context"
import { useApi, useMutation } from "@/hooks/use-api"
import { SETTLED_STATUSES, type ApiEvent, type ArtifactList, type Deployment, type InterruptResult, type Session, type SessionEventBody, type SessionEventResult } from "@/lib/api"
import { api, ApiError, seg } from "@/lib/client"
import { shortId } from "@/lib/format"
import { canInterrupt, canSendMessage, canTerminate, isActiveStatus, timesBySeq } from "@/lib/session-view"
import { cn } from "@/lib/utils"

export function SessionView({ sessionId }: { sessionId: string }) {
  const base = `/v1/sessions/${seg(sessionId)}`
  const canWrite = useCan("developer")
  const { events, timeline, connection, error: streamError } = useSessionEvents(sessionId)

  // The extra query values are cache keys the API ignores: details are refetched
  // when the streamed status changes, artifacts when new ones are announced.
  const session = useApi<Session>(base, { v: timeline.status ?? "" })
  const artifactEvents = React.useMemo(() => timeline.items.filter((i) => i.kind === "artifact").length, [timeline.items])
  const artifacts = useApi<ArtifactList>(`${base}/artifacts`, { n: artifactEvents })
  const s = session.data
  const deployment = useApi<Deployment>(s?.deployment_id ? `/v1/deployments/${seg(s.deployment_id)}` : null)

  const status = timeline.status ?? s?.status ?? null
  // Until the details load, the routed agent from the event log names the speaker.
  const route = timeline.items.find((i) => i.kind === "route")
  const agentName = s?.agent ?? (route?.kind === "route" ? route.agent : undefined)
  const settled = status !== null && SETTLED_STATUSES.has(status)
  const live = connection === "live"
  const [replayEvents, setReplayEvents] = React.useState<ApiEvent[] | null>(null)
  const [showSystem, setShowSystem] = React.useState(true)

  const times = React.useMemo(() => timesBySeq(events), [events])
  const items = React.useMemo(
    () => (showSystem ? timeline.items : timeline.items.filter((i) => !QUIET_KINDS.has(i.kind))),
    [timeline.items, showSystem]
  )
  const { setAnchor, showJump, jump } = useFollow({ active: live && !replayEvents, followByDefault: isActiveStatus(status), tick: timeline.items })

  const onDecide = React.useCallback<Decide>(
    async (callId, approved, reason) => {
      const decision: SessionEventBody = { type: "tool.approval.decided", call_id: callId, approved, reason: reason.trim() || null }
      await api<SessionEventResult>(`${base}/events`, { method: "POST", json: decision })
      toast.success(approved ? "Tool call approved" : "Tool call denied")
    },
    [base]
  )

  const notFound = session.error instanceof ApiError && session.error.status === 404
  if (notFound) {
    return (
      <Page>
        <EmptyState
          icon={<SearchXIcon />}
          title="Session not found"
          description={`No session ${shortId(sessionId, 14)} in this project. It may belong to another project or have been removed.`}
          action={
            <Button variant="outline" render={<Link href="/sessions" />}>
              <ArrowLeftIcon data-icon="inline-start" />
              All sessions
            </Button>
          }
        />
      </Page>
    )
  }

  return (
    <Page className="max-w-7xl">
      <BackLink href="/sessions">Sessions</BackLink>
      <Header
        sessionId={sessionId}
        session={s}
        deployment={deployment.data}
        status={status}
        connection={connection}
        replaying={replayEvents !== null}
        canWrite={canWrite}
        replayDisabled={!settled || events.length === 0}
        onReplay={() => setReplayEvents(replayEvents ? null : events)}
        onChanged={session.reload}
      />

      {session.error ? <ErrorState error={session.error} onRetry={session.reload} /> : null}
      <AnimatePresence>
        {streamError ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div role="status" className="flex items-center gap-2 rounded-xl bg-warning/8 px-3.5 py-2.5 text-sm ring-1 ring-warning/25">
              <TriangleAlertIcon className="size-4 text-warning" />
              <span className="text-muted-foreground">{streamError}</span>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
        <section aria-label="Conversation" className="flex min-w-0 flex-col">
          {replayEvents ? (
            <ReplayPanel events={replayEvents} sessionId={sessionId} agent={agentName} onExit={() => setReplayEvents(null)} />
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between gap-3 border-b pb-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <MessagesSquareIcon className="size-4 text-muted-foreground" />
                  Timeline
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">{timeline.count} events</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="show-system" size="sm" checked={showSystem} onCheckedChange={setShowSystem} />
                  <Label htmlFor="show-system" className="cursor-pointer text-xs font-normal text-muted-foreground">
                    System events
                  </Label>
                </div>
              </div>
              {connection === "loading" ? (
                <TimelineSkeleton />
              ) : timeline.items.length === 0 ? (
                <EmptyState
                  icon={<HistoryIcon />}
                  title="No events yet"
                  description={live ? "Waiting for the first event. This page updates live." : "This session has no recorded events."}
                />
              ) : (
                <Timeline
                  items={items}
                  sessionId={sessionId}
                  agent={agentName}
                  live={live}
                  times={times}
                  onDecide={canWrite ? onDecide : undefined}
                />
              )}
              <div ref={setAnchor} className="scroll-mb-40" />
              <div className="pointer-events-none sticky bottom-0 z-10 mt-4 flex flex-col gap-3 bg-linear-to-t from-background from-60% to-transparent pt-6 pb-4">
                <div className="flex justify-center">
                  <JumpToLatest show={showJump} onClick={jump} />
                </div>
                {canWrite && canSendMessage(status) ? (
                  <div className="pointer-events-auto">
                    <Composer sessionId={sessionId} status={status} onSent={jump} />
                  </div>
                ) : status === "terminated" ? (
                  <p className="pointer-events-auto text-center text-xs text-muted-foreground">This session was terminated and no longer accepts messages.</p>
                ) : !canWrite && status ? (
                  <p className="pointer-events-auto text-center text-xs text-muted-foreground">Read-only: a developer key is needed to message this session.</p>
                ) : null}
              </div>
            </>
          )}
        </section>

        <FadeIn delay={0.1} className="lg:sticky lg:top-6">
          <SidePanel
            sessionId={sessionId}
            session={s}
            deployment={deployment.data}
            status={status}
            timeline={timeline}
            events={events}
            artifacts={artifacts.data}
            artifactsError={artifacts.error}
            onReloadArtifacts={artifacts.reload}
          />
        </FadeIn>
      </div>
    </Page>
  )
}

const CONNECTION: Record<Connection | "replay", { label: string; dot: string; text: string }> = {
  loading: { label: "Loading", dot: "bg-muted-foreground/60", text: "text-muted-foreground" },
  connecting: { label: "Connecting", dot: "bg-muted-foreground/60 animate-pulse", text: "text-muted-foreground" },
  live: { label: "Live", dot: "bg-success", text: "text-success" },
  reconnecting: { label: "Reconnecting", dot: "bg-warning animate-pulse", text: "text-warning" },
  error: { label: "Offline", dot: "bg-destructive", text: "text-destructive" },
  replay: { label: "Replay", dot: "bg-info", text: "text-info" },
}

function ConnectionPill({ connection, replaying }: { connection: Connection; replaying: boolean }) {
  const key = replaying ? "replay" : connection
  const c = CONNECTION[key]
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={key}
        role="status"
        aria-live="polite"
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        transition={{ duration: 0.2, ease: EASE_OUT }}
        className={cn("inline-flex items-center gap-1.5 text-xs font-medium", c.text)}
      >
        <span className="relative flex size-1.5">
          {key === "live" ? <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", c.dot)} /> : null}
          <span className={cn("relative inline-flex size-1.5 rounded-full", c.dot)} />
        </span>
        {c.label}
      </motion.span>
    </AnimatePresence>
  )
}

function Header({
  sessionId,
  session: s,
  deployment,
  status,
  connection,
  replaying,
  canWrite,
  replayDisabled,
  onReplay,
  onChanged,
}: {
  sessionId: string
  session: Session | undefined
  deployment: Deployment | undefined
  status: string | null
  connection: Connection
  replaying: boolean
  canWrite: boolean
  replayDisabled: boolean
  onReplay: () => void
  onChanged: () => void
}) {
  const interrupt = useMutation()
  const terminate = useMutation()
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const base = `/v1/sessions/${seg(sessionId)}`

  async function doInterrupt() {
    const res = await interrupt.run(() => api<InterruptResult>(`${base}/interrupt`, { method: "POST" }))
    if (res) {
      toast.success(res.interrupted ? "Run interrupted" : "Nothing was running")
      onChanged()
    } else toast.error("Could not interrupt the run")
  }

  async function doTerminate() {
    const res = await terminate.run(async () => {
      await api<unknown>(base, { method: "DELETE" })
      return true
    })
    if (res) {
      setConfirmOpen(false)
      toast.success("Session terminated")
      onChanged()
    }
  }

  return (
    <FadeIn y={4} className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 items-start gap-3.5">
        {s ? (
          <AgentArt name={s.agent} className="size-11 shrink-0 rounded-xl ring-1 ring-foreground/10" />
        ) : (
          <Skeleton className="size-11 shrink-0 rounded-xl" />
        )}
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              {s ? (
                <>
                  <Link href={`/agents/${seg(s.agent)}`} className="underline-offset-4 hover:underline">
                    {s.agent}
                  </Link>
                  <span className="font-normal text-muted-foreground">
                    {s.alias ? `@${s.alias}` : ""} · v{s.version}
                  </span>
                </>
              ) : (
                <Skeleton className="h-8 w-64" />
              )}
            </h1>
            {status ? <StatusBadge status={status} /> : null}
            <ConnectionPill connection={connection} replaying={replaying} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-0.5">
              <span className="font-mono">{sessionId}</span>
              <CopyButton value={sessionId} size="icon-xs" label="Copy session id" />
            </span>
            {s ? (
              <>
                <span>
                  Created <TimeAgo iso={s.created_at} className="text-foreground/80" />
                </span>
                <span>
                  Last active <TimeAgo iso={s.last_active_at} className="text-foreground/80" />
                </span>
                {s.deployment_id ? (
                  <Link href={`/deployments/${seg(s.deployment_id)}`} className="flex items-center gap-1 transition-colors hover:text-foreground">
                    <RocketIcon className="size-3.5" />
                    {deployment?.name ?? shortId(s.deployment_id)}
                  </Link>
                ) : null}
                {s.parent_session_id ? (
                  <Link href={`/sessions/${seg(s.parent_session_id)}`} className="flex items-center gap-1 transition-colors hover:text-foreground">
                    <CornerLeftUpIcon className="size-3.5" />
                    Subagent of <span className="font-mono">{shortId(s.parent_session_id)}</span>
                  </Link>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <span tabIndex={replayDisabled && !replaying ? 0 : undefined}>
                <Button variant={replaying ? "secondary" : "outline"} onClick={onReplay} disabled={replayDisabled && !replaying}>
                  <HistoryIcon data-icon="inline-start" />
                  {replaying ? "Exit replay" : "Replay"}
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {replaying ? "Back to the live view" : replayDisabled ? "Available once the session has settled" : "Step through the recorded events"}
          </TooltipContent>
        </Tooltip>
        {canWrite ? (
          <>
            <Button variant="outline" onClick={doInterrupt} disabled={!canInterrupt(status) || interrupt.pending}>
              {interrupt.pending ? <Spinner data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
              Interrupt
            </Button>
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogTrigger render={<Button variant="destructive" disabled={!canTerminate(status)} />}>
                <CircleStopIcon data-icon="inline-start" />
                Terminate
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogMedia className="bg-destructive/10 text-destructive">
                    <OctagonXIcon />
                  </AlertDialogMedia>
                  <AlertDialogTitle>Terminate this session?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Any running turn is stopped and the sandbox is released. The history stays available, but the session can no longer receive messages.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                {terminate.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {terminate.error}
                  </p>
                ) : null}
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <Button variant="destructive" onClick={doTerminate} disabled={terminate.pending}>
                    {terminate.pending ? <Spinner data-icon="inline-start" /> : null}
                    Terminate session
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
      </div>
    </FadeIn>
  )
}

function TimelineSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-label="Loading events">
      {[72, 48, 88, 60].map((w, i) => (
        <div key={i} className={cn("flex flex-col gap-2", i % 2 === 0 && "items-end")}>
          <Skeleton className="h-3 w-20" style={{ animationDelay: `${i * 80}ms` }} />
          <Skeleton className="h-12 rounded-xl" style={{ width: `${w}%`, animationDelay: `${i * 80}ms` }} />
        </div>
      ))}
    </div>
  )
}
