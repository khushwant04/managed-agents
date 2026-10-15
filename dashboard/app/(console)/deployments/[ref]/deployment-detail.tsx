"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion } from "motion/react"
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  LockKeyholeIcon,
  PauseIcon,
  PlayIcon,
  SendIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CodeBlock } from "@/components/code-block"
import { CopyButton } from "@/components/copy-button"
import { FadeIn, Stagger, StaggerItem } from "@/components/motion"
import { BackLink, Page, PageHeader } from "@/components/page"
import { ErrorState } from "@/components/states"
import { StatusBadge } from "@/components/status-badge"
import { useCan, useProject } from "@/components/shell/project-context"
import { PROVIDER_ICON, TRIGGER_ICON } from "@/components/deploy/trigger-chip"
import { CopyField } from "@/components/deploy/webhook-reveal"
import { useApi, useMutation } from "@/hooks/use-api"
import { useNow } from "@/hooks/use-client"
import type { Deployment, DeploymentUpdate, InvokeAccepted, SessionList } from "@/lib/api"
import { api, seg } from "@/lib/client"
import { describeCron } from "@/lib/cron"
import { compactNumber, formatDateTime, formatNumber, shortId, timeAgo } from "@/lib/format"
import { PROVIDER_LABEL, parseTrigger, type Trigger } from "@/lib/triggers"

export function DeploymentDetail({ deploymentRef }: { deploymentRef: string }) {
  const router = useRouter()
  const project = useProject()
  const canWrite = useCan("developer")
  const path = `/v1/deployments/${seg(deploymentRef)}`
  const { data: d, error, reload, setData } = useApi<Deployment>(path)
  const sessions = useApi<SessionList>(d ? "/v1/sessions" : null, { limit: 500 })
  const status = useMutation()
  const del = useMutation()
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [invoking, setInvoking] = React.useState(false)

  const server = project.server.replace(/\/+$/, "")
  const triggers = (d?.triggers ?? []).map(parseTrigger)
  const hasHttp = triggers.some((t) => t.type === "http")
  const mySessions = (sessions.data?.sessions ?? []).filter((s) => d && s.deployment_id === d.id)

  async function setStatus(next: "active" | "paused") {
    const change: DeploymentUpdate = { status: next }
    const updated = await status.run(() =>
      api<Deployment>(path, { method: "PATCH", json: change }).catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : String(e))
        throw e
      })
    )
    if (updated) {
      setData(updated)
      toast.success(next === "paused" ? `Paused ${updated.name}` : `Resumed ${updated.name}`, {
        description: next === "paused" ? "Triggers stop starting new sessions." : "Triggers start sessions again.",
      })
    }
  }

  async function remove() {
    const ok = await del.run(() => api<void>(path, { method: "DELETE" }).then(() => true))
    if (ok) {
      toast.success(`Deleted ${d?.name ?? deploymentRef}`)
      setConfirmDelete(false)
      router.push("/deployments")
    }
  }

  if (error && !d) {
    return (
      <Page>
        <PageHeader eyebrow="Deployment" title={deploymentRef} />
        <ErrorState error={error} onRetry={reload} />
        <Button variant="outline" className="self-start" render={<Link href="/deployments" />}>
          Back to deployments
        </Button>
      </Page>
    )
  }

  if (!d) {
    return (
      <Page>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </Page>
    )
  }

  const paused = d.status === "paused"

  return (
    <Page>
      <BackLink href="/deployments">Deployments</BackLink>
      <PageHeader
        eyebrow="Deployment"
        title={
          <span className="flex items-center gap-3">
            <span className="truncate">{d.name}</span>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={d.status}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.18 }}
                className="inline-flex"
              >
                <StatusBadge status={d.status} />
              </motion.span>
            </AnimatePresence>
          </span>
        }
        description={
          <>
            Serves{" "}
            <Link href={`/agents/${seg(d.agent)}`} className="font-mono text-xs text-foreground hover:underline">
              {d.agent}@{d.alias}
            </Link>{" "}
            with {d.triggers.length} trigger{d.triggers.length === 1 ? "" : "s"}.
          </>
        }
        actions={
          canWrite ? (
            <>
              {hasHttp ? (
                <Button onClick={() => setInvoking(true)} disabled={paused}>
                  <ZapIcon data-icon="inline-start" />
                  Invoke now
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => void setStatus(paused ? "active" : "paused")} disabled={status.pending}>
                {status.pending ? <Spinner data-icon="inline-start" /> : paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2Icon data-icon="inline-start" />
                Delete
              </Button>
            </>
          ) : null
        }
      />

      <AnimatePresence initial={false}>
        {paused ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm text-warning ring-1 ring-warning/20">
              <PauseIcon className="size-4 shrink-0" />
              Paused: triggers don&apos;t start new sessions. Sessions already running continue.
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="grid items-start gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Stagger className="flex min-w-0 flex-col gap-4" gap={0.06}>
          <StaggerItem>
            <Card>
              <CardHeader>
                <CardTitle>Triggers</CardTitle>
                <CardDescription>What starts a session of this deployment.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col divide-y">
                {triggers.length === 0 ? <p className="text-sm text-muted-foreground">No triggers.</p> : null}
                {triggers.map((t, i) => (
                  <TriggerDetail key={i} trigger={t} deployment={d} server={server} />
                ))}
              </CardContent>
            </Card>
          </StaggerItem>

          {hasHttp ? (
            <StaggerItem>
              <InvokeCard deployment={d} server={server} />
            </StaggerItem>
          ) : null}

          <StaggerItem>
            <RecentSessions sessions={mySessions} loading={sessions.loading && !sessions.data} />
          </StaggerItem>
        </Stagger>

        <FadeIn delay={0.1} className="min-w-0">
          <ConfigCard deployment={d} />
        </FadeIn>
      </div>

      <InvokeDialog
        open={invoking}
        onOpenChange={setInvoking}
        deployment={d}
        onInvoked={() => sessions.reload()}
      />

      <AlertDialog open={confirmDelete} onOpenChange={(o) => !del.pending && setConfirmDelete(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2Icon />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete {d.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its HTTP endpoint, webhook URL, schedules and queue subscriptions stop working immediately. Past sessions are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {del.error ? <p className="text-sm text-destructive">{del.error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()} disabled={del.pending}>
              {del.pending ? <Spinner data-icon="inline-start" /> : null}
              Delete deployment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}

function IconTile({ icon: Icon }: { icon: React.ElementType }) {
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted ring-1 ring-foreground/6">
      <Icon className="size-4" />
    </div>
  )
}

function TriggerDetail({ trigger: t, deployment: d, server }: { trigger: Trigger; deployment: Deployment; server: string }) {
  const icon = t.type === "webhook" ? PROVIDER_ICON[t.provider] : TRIGGER_ICON[t.type]
  return (
    <div className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <IconTile icon={icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {t.type === "http" ? (
          <>
            <div>
              <div className="text-sm font-medium">HTTP</div>
              <div className="text-xs text-muted-foreground">Invoke over the REST API with a developer key.</div>
            </div>
            <code className="truncate font-mono text-xs text-muted-foreground">
              POST /v1/deployments/{d.name}/invoke
            </code>
          </>
        ) : null}
        {t.type === "webhook" ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{PROVIDER_LABEL[t.provider]} webhook</div>
                <div className="text-xs text-muted-foreground">Signed deliveries start a session.</div>
              </div>
              <Button variant="ghost" size="xs" render={<Link href="/webhooks" />}>
                Signing help
                <ArrowUpRightIcon data-icon="inline-end" />
              </Button>
            </div>
            <CopyField label="Endpoint URL" value={`${server}/v1/hooks/${d.id}`} />
            <div className="text-xs text-muted-foreground">
              Input template:{" "}
              {t.input ? <code className="font-mono text-foreground">{t.input}</code> : "event name and raw body"}
            </div>
          </>
        ) : null}
        {t.type === "cron" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{describeCron(t.schedule) ?? "Schedule"}</span>
              <Badge variant="muted" className="font-mono">
                {t.schedule}
              </Badge>
              <span className="text-xs text-muted-foreground">{t.timezone ?? "UTC"}</span>
            </div>
            <blockquote className="rounded-md border-l-2 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t.input}</blockquote>
          </>
        ) : null}
        {t.type === "queue" ? (
          <>
            <div>
              <div className="text-sm font-medium">
                Queue <span className="font-mono">{t.name}</span>
              </div>
              <div className="text-xs text-muted-foreground">Each message posted to the queue starts a session.</div>
            </div>
            <code className="truncate font-mono text-xs text-muted-foreground">POST /v1/queues/{t.name}/messages</code>
          </>
        ) : null}
      </div>
    </div>
  )
}

type Mode = "sync" | "async" | "stream"

function InvokeCard({ deployment: d, server }: { deployment: Deployment; server: string }) {
  const [mode, setMode] = React.useState<Mode>("sync")
  const url = `${server}/v1/deployments/${seg(d.name)}/invoke`
  const curl = [
    `curl${mode === "stream" ? " -N" : ""} -X POST ${url} \\`,
    `  -H "Authorization: Bearer $RUNHIVE_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"input": "Hello!", "mode": "${mode}"}'`,
  ].join("\n")
  const hint: Record<Mode, string> = {
    sync: "Waits for the run and returns its output (up to wait_timeout seconds).",
    async: "Returns 202 with the session and run ids straight away.",
    stream: "Streams the session's events as server-sent events.",
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoke endpoint</CardTitle>
        <CardDescription className="flex min-w-0 items-center gap-1">
          <code className="truncate font-mono text-xs">{url}</code>
          <CopyButton value={url} size="icon-xs" label="Copy endpoint" />
        </CardDescription>
        <CardAction>
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList>
              <TabsTrigger value="sync">Sync</TabsTrigger>
              <TabsTrigger value="async">Async</TabsTrigger>
              <TabsTrigger value="stream">Stream</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <CodeBlock code={curl} label="cURL" />
        <p className="text-xs text-muted-foreground">{hint[mode]}</p>
      </CardContent>
    </Card>
  )
}

function RecentSessions({ sessions, loading }: { sessions: SessionList["sessions"]; loading: boolean }) {
  const now = useNow()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent sessions</CardTitle>
        <CardDescription>Sessions this deployment&apos;s triggers started.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" render={<Link href="/sessions" />}>
            All sessions
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col">
        {loading ? (
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="my-1.5 h-8" />)
        ) : sessions.length ? (
          <AnimatePresence initial={false}>
            {sessions.slice(0, 8).map((s) => (
              <motion.div key={s.id} layout initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
                <Link
                  href={`/sessions/${encodeURIComponent(s.id)}`}
                  className="group/s -mx-2 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-200 hover:bg-muted/60"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="font-mono text-xs">{shortId(s.id, 12)}</span>
                    <span className="text-xs text-muted-foreground">
                      v{s.version} · {now ? timeAgo(s.created_at, now) : ""}
                    </span>
                  </div>
                  <StatusBadge status={s.status} />
                  <ArrowRightIcon className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/s:opacity-100" />
                </Link>
              </motion.div>
            ))}
          </AnimatePresence>
        ) : (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            No sessions yet. They show up here as triggers fire.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  )
}

function ConfigCard({ deployment: d }: { deployment: Deployment }) {
  const maxTokens = typeof d.budget?.max_tokens === "number" ? d.budget.max_tokens : null
  const budgetWindow = typeof d.budget?.window === "string" ? d.budget.window : "30 days"
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col divide-y">
          <Row label="Deployment ID">
            <span className="flex items-center gap-1">
              <code className="truncate font-mono text-xs">{d.id}</code>
              <CopyButton value={d.id} size="icon-xs" label="Copy ID" />
            </span>
          </Row>
          <Row label="Agent">
            <Link href={`/agents/${seg(d.agent)}`} className="font-mono text-xs hover:underline">
              {d.agent}@{d.alias}
            </Link>
          </Row>
          <Row label="Concurrency">
            <span className="tabular-nums">{d.concurrency}</span>{" "}
            <span className="text-muted-foreground">sessions at once</span>
          </Row>
          <Row label="Environment">
            {d.environment ? (
              <Link href="/environments" className="font-mono text-xs hover:underline">
                {d.environment}
              </Link>
            ) : (
              <span className="text-muted-foreground">Default</span>
            )}
          </Row>
          <Row label="Secrets">
            {d.secrets.length ? (
              <span className="flex flex-wrap gap-1">
                {d.secrets.map((s) => (
                  <Badge key={s} variant="muted" className="font-mono">
                    <LockKeyholeIcon data-icon="inline-start" />
                    {s}
                  </Badge>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </Row>
          <Row label="Token budget">
            {maxTokens ? (
              <Tooltip>
                <TooltipTrigger render={<span className="tabular-nums" />}>
                  {compactNumber(maxTokens)} <span className="text-muted-foreground">per rolling {budgetWindow}</span>
                </TooltipTrigger>
                <TooltipContent>{formatNumber(maxTokens)} tokens</TooltipContent>
              </Tooltip>
            ) : (
              <span className="text-muted-foreground">No limit</span>
            )}
          </Row>
          <Row label="Created">
            {formatDateTime(d.created_at)}
            {d.created_by ? <div className="truncate font-mono text-xs text-muted-foreground">by {d.created_by}</div> : null}
          </Row>
          <Row label="Updated">{formatDateTime(d.updated_at)}</Row>
        </dl>
      </CardContent>
    </Card>
  )
}

function InvokeDialog({
  open,
  onOpenChange,
  deployment: d,
  onInvoked,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  deployment: Deployment
  onInvoked: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <InvokeForm deployment={d} onInvoked={onInvoked} />
      </DialogContent>
    </Dialog>
  )
}

function InvokeForm({ deployment: d, onInvoked }: { deployment: Deployment; onInvoked: () => void }) {
  const [input, setInput] = React.useState("")
  const [result, setResult] = React.useState<InvokeAccepted | null>(null)
  const mutation = useMutation()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim()) return
    const res = await mutation.run(() =>
      api<InvokeAccepted>(`/v1/deployments/${seg(d.name)}/invoke`, { method: "POST", json: { input, mode: "async" } })
    )
    if (res) {
      setResult(res)
      onInvoked()
      toast.success("Session started", { description: shortId(res.session_id, 12) })
    }
  }

  if (result) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Session started</DialogTitle>
          <DialogDescription>
            {result.agent}@{result.alias ?? d.alias} · v{result.version}
          </DialogDescription>
        </DialogHeader>
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-3 rounded-lg bg-success/8 p-3 ring-1 ring-success/20"
        >
          <motion.div
            initial={{ scale: 0.5 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 20 }}
            className="flex size-8 items-center justify-center rounded-full bg-success/15 text-success"
          >
            <CheckIcon className="size-4" />
          </motion.div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Running in the background</div>
            <code className="block truncate font-mono text-xs text-muted-foreground">{result.session_id}</code>
          </div>
          <CopyButton value={result.session_id} size="icon-xs" label="Copy session ID" />
        </motion.div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          <Button render={<Link href={`/sessions/${encodeURIComponent(result.session_id)}`} />}>
            Open session
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle>Invoke {d.name}</DialogTitle>
        <DialogDescription>
          Starts a session of {d.agent}@{d.alias} through the deployment&apos;s HTTP trigger.
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="invoke-input">Input</FieldLabel>
        <Textarea
          id="invoke-input"
          rows={5}
          autoFocus
          placeholder="What should the agent do?"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
          }}
        />
        <FieldDescription className="text-xs">⌘/Ctrl + Enter to send. Runs asynchronously; follow it in the session view.</FieldDescription>
      </Field>
      {mutation.error ? <p className="text-sm text-destructive" role="alert">{mutation.error}</p> : null}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={mutation.pending || !input.trim()}>
          {mutation.pending ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
          Invoke
        </Button>
      </DialogFooter>
    </form>
  )
}
