"use client"

import * as React from "react"
import Link from "next/link"
import { motion } from "motion/react"
import { WebhookIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
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
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { AgentTargetFields, EMPTY_TARGET, targetError, targetPayload, type TargetValue } from "@/components/deploy/agent-target-fields"
import { DialogScrollBody } from "@/components/deploy/form-section"
import { SecretInput } from "@/components/deploy/secret-input"
import { TEMPLATE_PLACEHOLDER } from "@/components/deploy/trigger-builder"
import { PROVIDER_ICON } from "@/components/deploy/trigger-chip"
import { WebhookReveal } from "@/components/deploy/webhook-reveal"
import { useProject } from "@/components/shell/project-context"
import { useMutation } from "@/hooks/use-api"
import type { Deployment, DeploymentCreate } from "@/lib/api"
import { api, seg } from "@/lib/client"
import { PROVIDER_LABEL, PROVIDER_SIGNING, PROVIDERS, suggestName, type WebhookProvider } from "@/lib/triggers"
import { cn } from "@/lib/utils"

const SECRET_HINT: Record<WebhookProvider, string> = {
  github: "Choose any secret and paste the same value into GitHub, or leave empty to generate one.",
  slack: "Paste your Slack app's signing secret (Basic Information → App Credentials).",
  stripe: "Paste the endpoint's signing secret (whsec_…) after creating it in Stripe, or generate one here and update later.",
  generic: "Leave empty to generate one; sign requests with it as shown below.",
}

/** A focused flow: one deployment with a single webhook trigger. */
export function CreateWebhookDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated?: (d: Deployment) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 sm:max-w-lg">
        <WebhookForm onCreated={onCreated} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function WebhookForm({ onCreated, onDone }: { onCreated?: (d: Deployment) => void; onDone: () => void }) {
  const project = useProject()
  const mutation = useMutation()
  const [target, setTarget] = React.useState<TargetValue>(EMPTY_TARGET)
  const [provider, setProvider] = React.useState<WebhookProvider>("github")
  const [name, setName] = React.useState("")
  const [secret, setSecret] = React.useState("")
  const [template, setTemplate] = React.useState("")
  const [submitted, setSubmitted] = React.useState(false)
  const [created, setCreated] = React.useState<Deployment | null>(null)

  const suggested = target.agent ? suggestName(target.agent, provider) : `my-agent-${provider}`

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    if (targetError(target)) return
    const body: DeploymentCreate = {
      ...targetPayload(target),
      name: name.trim() || suggested,
      triggers: [template.trim() ? { type: "webhook", provider, input: template } : { type: "webhook", provider }],
      concurrency: 10,
      secrets: [],
      budget: {},
      webhook_secret: secret.trim() || null,
    }
    const dep = await mutation.run(() => api<Deployment>("/v1/deployments", { method: "POST", json: body }))
    if (!dep) return
    setCreated(dep)
    onCreated?.(dep)
    toast.success(`${PROVIDER_LABEL[provider]} endpoint created`, { description: dep.name })
  }

  if (created) {
    return (
      <>
        <DialogHeader className="pb-4">
          <DialogTitle>Webhook endpoint ready</DialogTitle>
          <DialogDescription>{PROVIDER_SIGNING[provider].setup}</DialogDescription>
        </DialogHeader>
        <WebhookReveal
          name={created.name}
          url={`${project.server.replace(/\/+$/, "")}/v1/hooks/${created.id}`}
          secret={created.webhook_secret}
        />
        <DialogFooter className="mt-4">
          <Button variant="outline" render={<Link href={`/deployments/${seg(created.name)}`} />}>
            View deployment
          </Button>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <form onSubmit={submit} className="contents" noValidate>
      <DialogHeader className="pb-4">
        <DialogTitle>Add webhook endpoint</DialogTitle>
        <DialogDescription>Signed events from the provider start a session of the agent.</DialogDescription>
      </DialogHeader>
      <DialogScrollBody className="flex flex-col gap-5">
        <Field>
          <FieldLabel>Provider</FieldLabel>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Provider">
            {PROVIDERS.map((p) => {
              const Icon = PROVIDER_ICON[p]
              const active = p === provider
              return (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setProvider(p)}
                  className={cn(
                    "relative flex flex-col items-center gap-1.5 rounded-lg px-2 py-3 text-xs font-medium ring-1 ring-foreground/10 transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
                    active ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="provider-active"
                      transition={{ type: "spring", stiffness: 500, damping: 38 }}
                      className="absolute inset-0 rounded-lg bg-muted/70 ring-1 ring-foreground/25"
                    />
                  ) : null}
                  <Icon className="relative size-4" />
                  <span className="relative">{PROVIDER_LABEL[p]}</span>
                </button>
              )
            })}
          </div>
        </Field>

        <AgentTargetFields value={target} onChange={setTarget} showErrors={submitted} />

        <Field>
          <FieldLabel htmlFor="wh-name">Deployment name</FieldLabel>
          <Input id="wh-name" className="font-mono" placeholder={suggested} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field>
          <FieldLabel htmlFor="wh-secret">Signing secret</FieldLabel>
          <SecretInput id="wh-secret" placeholder="Generate one for me" value={secret} onChange={(e) => setSecret(e.target.value)} />
          <FieldDescription className="text-xs">{SECRET_HINT[provider]}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="wh-template">Input template</FieldLabel>
          <Input
            id="wh-template"
            className="font-mono text-xs md:text-xs"
            placeholder={TEMPLATE_PLACEHOLDER[provider]}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
          <FieldDescription className="text-xs">
            Optional. <code className="font-mono">{"{event}"}</code>, <code className="font-mono">{"{body}"}</code> and
            dotted JSON paths are filled in from each delivery.
          </FieldDescription>
        </Field>
      </DialogScrollBody>
      <DialogFooter className="mt-0 border-t-0">
        {mutation.error ? <p className="mr-auto self-center text-sm text-destructive" role="alert">{mutation.error}</p> : null}
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={mutation.pending}>
          {mutation.pending ? <Spinner data-icon="inline-start" /> : <WebhookIcon data-icon="inline-start" />}
          Create endpoint
        </Button>
      </DialogFooter>
    </form>
  )
}
