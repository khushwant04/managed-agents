import * as React from "react"
import {
  CalendarClockIcon,
  CreditCardIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HashIcon,
  InboxIcon,
  WebhookIcon,
  type LucideIcon,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { describeCron } from "@/lib/cron"
import {
  PROVIDER_LABEL,
  parseTrigger,
  type Trigger,
  type TriggerType,
  type WebhookProvider,
} from "@/lib/triggers"
import { cn } from "@/lib/utils"

export const TRIGGER_ICON: Record<TriggerType, LucideIcon> = {
  http: GlobeIcon,
  webhook: WebhookIcon,
  cron: CalendarClockIcon,
  queue: InboxIcon,
}

export const PROVIDER_ICON: Record<WebhookProvider, LucideIcon> = {
  github: GitPullRequestIcon,
  slack: HashIcon,
  stripe: CreditCardIcon,
  generic: WebhookIcon,
}

/** Rounded icon tile for a webhook provider. */
export function ProviderTile({
  provider,
  className,
}: {
  provider: WebhookProvider
  className?: string
}) {
  const Icon = PROVIDER_ICON[provider]
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground ring-1 ring-foreground/8",
        className
      )}
      aria-hidden
    >
      <Icon className="size-4" />
    </div>
  )
}

function chipText(t: Trigger): React.ReactNode {
  switch (t.type) {
    case "webhook":
      return PROVIDER_LABEL[t.provider]
    case "cron":
      return <span className="font-mono">{t.schedule}</span>
    case "queue":
      return <span className="font-mono">{t.name}</span>
    default:
      return "HTTP"
  }
}

function chipHint(t: Trigger): string {
  switch (t.type) {
    case "webhook":
      return `${PROVIDER_LABEL[t.provider]} webhook`
    case "cron":
      return `${describeCron(t.schedule) ?? t.schedule}${t.timezone ? ` (${t.timezone})` : " (UTC)"}`
    case "queue":
      return `Messages posted to the "${t.name}" queue`
    default:
      return "POST /v1/deployments/{name}/invoke"
  }
}

/** A small pill for one trigger: icon + provider, schedule or queue name. */
export function TriggerChip({ trigger, className }: { trigger: Trigger; className?: string }) {
  const Icon = trigger.type === "webhook" ? PROVIDER_ICON[trigger.provider] : TRIGGER_ICON[trigger.type]
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-md bg-muted/70 px-2 text-xs text-foreground ring-1 ring-foreground/6",
              className
            )}
          />
        }
      >
        <Icon className="size-3 text-muted-foreground" />
        {chipText(trigger)}
      </TooltipTrigger>
      <TooltipContent>{chipHint(trigger)}</TooltipContent>
    </Tooltip>
  )
}

export function TriggerChips({
  triggers,
  className,
}: {
  triggers: Record<string, unknown>[]
  className?: string
}) {
  if (triggers.length === 0) return <span className="text-xs text-muted-foreground">None</span>
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {triggers.map((raw, i) => (
        <TriggerChip key={i} trigger={parseTrigger(raw)} />
      ))}
    </div>
  )
}
