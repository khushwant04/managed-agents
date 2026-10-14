"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { EASE_OUT } from "@/components/motion"
import { PROVIDER_ICON, TRIGGER_ICON } from "@/components/deploy/trigger-chip"
import { CRON_PRESETS, describeCron } from "@/lib/cron"
import {
  PROVIDER_LABEL,
  PROVIDERS,
  TRIGGER_LABEL,
  TRIGGER_TYPES,
  draftError,
  newDraft,
  type TriggerDraft,
  type TriggerType,
  type WebhookProvider,
} from "@/lib/triggers"
import { cn } from "@/lib/utils"

const TRIGGER_BLURB: Record<TriggerType, string> = {
  http: "Invoke over the REST API",
  webhook: "Signed events from GitHub, Slack, Stripe or anything",
  cron: "Run on a schedule",
  queue: "Start a session per queued message",
}

export const TEMPLATE_PLACEHOLDER: Record<WebhookProvider, string> = {
  github: "Review {pull_request.html_url}: {pull_request.title}",
  slack: "Reply in #{event.channel} to: {event.text}",
  stripe: "Investigate {event} for customer {data.object.customer}",
  generic: "Handle {event}: {body}",
}

export function ProviderSelect({
  id,
  value,
  onChange,
}: {
  id?: string
  value: WebhookProvider
  onChange: (p: WebhookProvider) => void
}) {
  return (
    <Select
      items={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))}
      value={value}
      onValueChange={(v) => v && onChange(v as WebhookProvider)}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PROVIDERS.map((p) => {
          const Icon = PROVIDER_ICON[p]
          return (
            <SelectItem key={p} value={p}>
              <Icon className="text-muted-foreground" />
              {PROVIDER_LABEL[p]}
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

/** Live, animated plain-English reading of a cron schedule. */
export function CronHint({ schedule, timezone }: { schedule: string; timezone?: string }) {
  const text = describeCron(schedule)
  return (
    <div className="flex min-h-5 items-center text-xs" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={text ?? "invalid"}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
          className={text ? "text-muted-foreground" : "text-destructive"}
        >
          {text ? `${text} · ${timezone?.trim() || "UTC"}` : "Not a valid 5-field schedule"}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

function TriggerRow({
  draft,
  onChange,
  onRemove,
  showErrors,
  canRemove,
}: {
  draft: TriggerDraft
  onChange: (d: TriggerDraft) => void
  onRemove: () => void
  showErrors: boolean
  canRemove: boolean
}) {
  const Icon = TRIGGER_ICON[draft.type]
  const err = showErrors ? draftError(draft) : null
  const id = `trg-${draft.key}`
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.3, ease: EASE_OUT }}
      className="-m-px overflow-hidden p-px"
    >
      <div
        className={cn(
          "flex flex-col gap-3 rounded-lg bg-card p-3 ring-1 ring-foreground/10 transition-shadow",
          err && "ring-destructive/40"
        )}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <Icon className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{TRIGGER_LABEL[draft.type]}</div>
            <div className="truncate text-xs text-muted-foreground">{TRIGGER_BLURB[draft.type]}</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${TRIGGER_LABEL[draft.type]} trigger`}
            onClick={onRemove}
            disabled={!canRemove}
          >
            <Trash2Icon />
          </Button>
        </div>

        {draft.type === "webhook" ? (
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field>
              <FieldLabel htmlFor={`${id}-provider`}>Provider</FieldLabel>
              <ProviderSelect id={`${id}-provider`} value={draft.provider} onChange={(provider) => onChange({ ...draft, provider })} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-input`}>Input template</FieldLabel>
              <Input
                id={`${id}-input`}
                className="font-mono text-xs md:text-xs"
                placeholder={TEMPLATE_PLACEHOLDER[draft.provider]}
                value={draft.input}
                onChange={(e) => onChange({ ...draft, input: e.target.value })}
              />
            </Field>
            <FieldDescription className="text-xs sm:col-span-2">
              Use <code className="font-mono">{"{event}"}</code>, <code className="font-mono">{"{body}"}</code> or dotted
              paths into the JSON body. Empty sends the event name and raw body.
            </FieldDescription>
          </div>
        ) : null}

        {draft.type === "cron" ? (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
              <Field data-invalid={!!err && !describeCron(draft.schedule)}>
                <FieldLabel htmlFor={`${id}-schedule`}>Schedule</FieldLabel>
                <Input
                  id={`${id}-schedule`}
                  className="font-mono"
                  placeholder="*/30 * * * *"
                  value={draft.schedule}
                  onChange={(e) => onChange({ ...draft, schedule: e.target.value })}
                  aria-invalid={!!err && !describeCron(draft.schedule)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-tz`}>Timezone</FieldLabel>
                <Input
                  id={`${id}-tz`}
                  placeholder="UTC"
                  value={draft.timezone}
                  onChange={(e) => onChange({ ...draft, timezone: e.target.value })}
                />
              </Field>
            </div>
            <div className="-mt-1 flex flex-col gap-2">
              <CronHint schedule={draft.schedule} timezone={draft.timezone} />
              <div className="flex flex-wrap gap-1">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.schedule}
                    type="button"
                    onClick={() => onChange({ ...draft, schedule: p.schedule })}
                    className={cn(
                      "h-6 rounded-md px-2 text-xs ring-1 ring-foreground/10 transition-colors hover:bg-muted",
                      draft.schedule.trim() === p.schedule && "bg-primary text-primary-foreground ring-primary hover:bg-primary/85"
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <Field data-invalid={!!err && !draft.input.trim()}>
              <FieldLabel htmlFor={`${id}-input`}>Input</FieldLabel>
              <Textarea
                id={`${id}-input`}
                rows={2}
                placeholder="Check error budgets and summarise anything burning."
                value={draft.input}
                onChange={(e) => onChange({ ...draft, input: e.target.value })}
                aria-invalid={!!err && !draft.input.trim()}
              />
            </Field>
          </div>
        ) : null}

        {draft.type === "queue" ? (
          <Field>
            <FieldLabel htmlFor={`${id}-queue`}>Queue name</FieldLabel>
            <Input
              id={`${id}-queue`}
              className="font-mono"
              placeholder="tickets"
              value={draft.queue}
              onChange={(e) => onChange({ ...draft, queue: e.target.value })}
              aria-invalid={!!err}
            />
            <FieldDescription className="text-xs">
              Messages posted to <code className="font-mono">/v1/queues/{draft.queue.trim() || "{name}"}/messages</code> start a session.
            </FieldDescription>
          </Field>
        ) : null}

        {draft.type === "http" ? (
          <p className="text-xs text-muted-foreground">
            Callers with a developer key can <code className="font-mono">POST /v1/deployments/{"{name}"}/invoke</code>.
          </p>
        ) : null}

        {err ? <p className="text-xs text-destructive">{err}</p> : null}
      </div>
    </motion.div>
  )
}

/** Add, edit and remove trigger rows. */
export function TriggerBuilder({
  value,
  onChange,
  showErrors = false,
}: {
  value: TriggerDraft[]
  onChange: (v: TriggerDraft[]) => void
  showErrors?: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {value.map((d) => (
          <TriggerRow
            key={d.key}
            draft={d}
            showErrors={showErrors}
            canRemove={value.length > 1}
            onChange={(next) => onChange(value.map((x) => (x.key === d.key ? next : x)))}
            onRemove={() => onChange(value.filter((x) => x.key !== d.key))}
          />
        ))}
      </AnimatePresence>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" className="self-start" />}>
          <PlusIcon data-icon="inline-start" />
          Add trigger
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">
          {TRIGGER_TYPES.map((t) => {
            const Icon = TRIGGER_ICON[t]
            return (
              <DropdownMenuItem key={t} onClick={() => onChange([...value, newDraft(t)])} className="items-start py-1.5">
                <Icon className="mt-0.5" />
                <div className="flex flex-col">
                  <span>{TRIGGER_LABEL[t]}</span>
                  <span className="text-xs text-muted-foreground">{TRIGGER_BLURB[t]}</span>
                </div>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
