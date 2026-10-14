"use client"

import * as React from "react"
import Link from "next/link"
import { AnimatePresence, motion } from "motion/react"
import { ChevronRightIcon, PlusIcon, WebhookIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { CopyButton } from "@/components/copy-button"
import { EASE_OUT, FadeIn } from "@/components/motion"
import { Page, PageHeader, Section } from "@/components/page"
import { EmptyState, ErrorState } from "@/components/states"
import { StatusBadge } from "@/components/status-badge"
import { useCan, useProject } from "@/components/shell/project-context"
import { CreateWebhookDialog } from "@/components/deploy/create-webhook-dialog"
import { SigningHelp } from "@/components/deploy/signing-help"
import { ProviderTile } from "@/components/deploy/trigger-chip"
import { useNewDialog } from "@/components/deploy/use-new-param"
import { useApi } from "@/hooks/use-api"
import type { DeploymentList } from "@/lib/api"
import { seg } from "@/lib/client"
import { PROVIDER_LABEL, webhookEndpoints, type WebhookEndpoint } from "@/lib/triggers"

export function WebhooksView() {
  const project = useProject()
  const canWrite = useCan("developer")
  const [adding, setAdding] = useNewDialog(canWrite)
  const { data, error, loading, reload } = useApi<DeploymentList>("/v1/deployments")
  const endpoints = React.useMemo(() => webhookEndpoints(data?.deployments ?? [], project.server), [data, project.server])

  const addButton = canWrite ? (
    <Button onClick={() => setAdding(true)}>
      <PlusIcon data-icon="inline-start" />
      Add webhook endpoint
    </Button>
  ) : null

  return (
    <Page>
      <PageHeader
        title="Webhooks"
        description="Receive events from GitHub, Slack, Stripe or any service and start agent sessions."
        actions={endpoints.length ? addButton : null}
      />

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {loading && !data ? (
        <Card className="gap-0 py-0">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border-b p-4 last:border-0">
              <Skeleton className="size-9 rounded-lg" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-72" />
              </div>
            </div>
          ))}
        </Card>
      ) : data && endpoints.length === 0 ? (
        <EmptyState
          icon={<WebhookIcon />}
          title="No webhook endpoints yet"
          description="Create an endpoint, paste its URL into your provider and every signed event starts a session."
          action={
            canWrite ? (
              <Button onClick={() => setAdding(true)}>
                <PlusIcon data-icon="inline-start" />
                Add webhook endpoint
              </Button>
            ) : null
          }
        />
      ) : data ? (
        <Section
          title="Endpoints"
          description="One URL per deployment; each verifies its provider's signature."
          actions={<span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">{endpoints.length} total</span>}
        >
          <Card className="gap-0 py-0">
            <AnimatePresence initial={false}>
              {endpoints.map((ep, i) => (
                <EndpointRow key={ep.key} endpoint={ep} index={i} />
              ))}
            </AnimatePresence>
          </Card>
        </Section>
      ) : null}

      <FadeIn delay={0.15}>
        <SigningHelp
          exampleUrl={
            endpoints.find((e) => e.provider === "generic")?.url ??
            `${project.server.replace(/\/+$/, "")}/v1/hooks/<deployment-id>`
          }
        />
      </FadeIn>

      <CreateWebhookDialog open={adding} onOpenChange={setAdding} onCreated={() => reload()} />
    </Page>
  )
}

function EndpointRow({ endpoint: ep, index }: { endpoint: WebhookEndpoint; index: number }) {
  const d = ep.deployment
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.35, ease: EASE_OUT, delay: Math.min(index, 10) * 0.04 }}
      className="group/ep flex flex-col gap-3 border-b p-4 transition-colors last:border-0 hover:bg-muted/30 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <ProviderTile provider={ep.provider} className="transition-colors group-hover/ep:bg-primary group-hover/ep:text-primary-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{PROVIDER_LABEL[ep.provider]}</span>
            <span className="text-muted-foreground">·</span>
            <Link href={`/deployments/${seg(d.name)}`} className="text-sm hover:underline">
              {d.name}
            </Link>
            <StatusBadge status={d.status} />
          </div>
          <div className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono text-xs text-muted-foreground">{ep.url}</code>
            <CopyButton value={ep.url} size="icon-xs" label="Copy endpoint URL" />
          </div>
          {ep.input ? (
            <div className="truncate text-xs text-muted-foreground">
              Input: <code className="font-mono text-foreground/80">{ep.input}</code>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-3 pl-12 sm:pl-0">
        <Link href={`/agents/${seg(d.agent)}`} className="font-mono text-xs hover:underline">
          {d.agent}
          <span className="text-muted-foreground">@{d.alias}</span>
        </Link>
        <Button variant="ghost" size="icon-sm" aria-label={`Open ${d.name}`} render={<Link href={`/deployments/${seg(d.name)}`} />}>
          <ChevronRightIcon className="transition-transform group-hover/ep:translate-x-0.5" />
        </Button>
      </div>
    </motion.div>
  )
}
