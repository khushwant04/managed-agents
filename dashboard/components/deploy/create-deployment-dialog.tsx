"use client"

import * as React from "react"
import Link from "next/link"
import { LockKeyholeIcon, RocketIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Expand } from "@/components/motion"
import {
  AgentTargetFields,
  EMPTY_TARGET,
  targetError,
  targetPayload,
  type TargetValue,
} from "@/components/deploy/agent-target-fields"
import { DialogScrollBody, FormSection } from "@/components/deploy/form-section"
import { SecretInput } from "@/components/deploy/secret-input"
import { TriggerBuilder } from "@/components/deploy/trigger-builder"
import { WebhookReveal } from "@/components/deploy/webhook-reveal"
import { useProject } from "@/components/shell/project-context"
import { useApi, useMutation } from "@/hooks/use-api"
import type {
  Deployment,
  DeploymentCreate,
  EnvironmentList,
  SecretList,
} from "@/lib/api"
import { api, seg } from "@/lib/client"
import {
  draftError,
  draftToTrigger,
  newDraft,
  suggestName,
  type TriggerDraft,
} from "@/lib/triggers"
import { cn } from "@/lib/utils"

const DEFAULT_ENV = "__default__"
const WINDOWS = ["1 day", "7 days", "30 days"]

export function CreateDeploymentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (d: Deployment) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 sm:max-w-2xl">
        <CreateDeploymentForm
          onCreated={onCreated}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function CreateDeploymentForm({
  onCreated,
  onDone,
}: {
  onCreated?: (d: Deployment) => void
  onDone: () => void
}) {
  const project = useProject()
  const environments = useApi<EnvironmentList>("/v1/environments")
  const secrets = useApi<SecretList>("/v1/secrets")
  const mutation = useMutation()

  const [target, setTarget] = React.useState<TargetValue>(EMPTY_TARGET)
  const [name, setName] = React.useState("")
  const [triggers, setTriggers] = React.useState<TriggerDraft[]>(() => [
    newDraft("http"),
  ])
  const [concurrency, setConcurrency] = React.useState("10")
  const [environment, setEnvironment] = React.useState(DEFAULT_ENV)
  const [picked, setPicked] = React.useState<string[]>([])
  const [maxTokens, setMaxTokens] = React.useState("")
  const [budgetWindow, setBudgetWindow] = React.useState("30 days")
  const [webhookSecret, setWebhookSecret] = React.useState("")
  const [submitted, setSubmitted] = React.useState(false)
  const [created, setCreated] = React.useState<Deployment | null>(null)

  const hasWebhook = triggers.some((t) => t.type === "webhook")
  const suggested =
    target.agent && target.alias
      ? suggestName(target.agent, target.alias)
      : "my-deployment"
  const conc = Number(concurrency)
  const concError =
    !Number.isInteger(conc) || conc < 1 || conc > 1000
      ? "between 1 and 1000"
      : null
  const budgetError =
    maxTokens && !(Number.isInteger(Number(maxTokens)) && Number(maxTokens) > 0)
      ? "a positive whole number"
      : null
  const invalid =
    !!targetError(target) ||
    triggers.some((t) => draftError(t)) ||
    !!concError ||
    !!budgetError ||
    triggers.length === 0

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    if (invalid) return
    const body: DeploymentCreate = {
      ...targetPayload(target),
      name: name.trim() || null,
      triggers: triggers.map(draftToTrigger),
      concurrency: conc,
      environment: environment === DEFAULT_ENV ? null : environment,
      secrets: picked,
      budget: maxTokens
        ? { max_tokens: Number(maxTokens), window: budgetWindow }
        : {},
      webhook_secret:
        hasWebhook && webhookSecret.trim() ? webhookSecret.trim() : null,
    }
    const dep = await mutation.run(() =>
      api<Deployment>("/v1/deployments", { method: "POST", json: body })
    )
    if (!dep) return
    onCreated?.(dep)
    toast.success(`Deployed ${dep.name}`, {
      description: `${dep.agent}@${dep.alias}`,
    })
    if (dep.triggers.some((t) => t.type === "webhook")) setCreated(dep)
    else onDone()
  }

  if (created) {
    return (
      <>
        <DialogHeader className="pb-4">
          <DialogTitle>Deployment created</DialogTitle>
          <DialogDescription>
            Webhook deliveries start sessions as soon as they are signed
            correctly.
          </DialogDescription>
        </DialogHeader>
        <WebhookReveal
          name={created.name}
          url={`${project.server.replace(/\/+$/, "")}/v1/hooks/${created.id}`}
          secret={created.webhook_secret}
        />
        <DialogFooter className="mt-4">
          <Button
            variant="outline"
            render={<Link href={`/deployments/${seg(created.name)}`} />}
          >
            View deployment
          </Button>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </>
    )
  }

  const envItems = [
    { value: DEFAULT_ENV, label: "Default (local)" },
    ...(environments.data?.environments ?? []).map((e) => ({
      value: e.name,
      label: e.name,
    })),
  ]

  return (
    <form onSubmit={submit} className="contents" noValidate>
      <DialogHeader className="pb-4">
        <DialogTitle>Create deployment</DialogTitle>
        <DialogDescription>
          Make an agent alias reachable through HTTP, webhooks, cron schedules
          and queues.
        </DialogDescription>
      </DialogHeader>

      <DialogScrollBody className="flex flex-col gap-6">
        <FormSection
          title="Target"
          description="Sessions run whichever version the alias points to at the time."
        >
          <AgentTargetFields
            value={target}
            onChange={setTarget}
            showErrors={submitted}
          />
          <Field>
            <FieldLabel htmlFor="dep-name">Name</FieldLabel>
            <Input
              id="dep-name"
              className="font-mono"
              placeholder={suggested}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <FieldDescription className="text-xs">
              Unique in the project. Defaults to {suggested}.
            </FieldDescription>
          </Field>
        </FormSection>

        <FormSection title="Triggers" description="What starts a session.">
          <div className="flex flex-col">
            <TriggerBuilder
              value={triggers}
              onChange={setTriggers}
              showErrors={submitted}
            />
            <Expand open={hasWebhook}>
              <Field className="pt-4">
                <FieldLabel htmlFor="dep-webhook-secret">
                  Webhook signing secret
                </FieldLabel>
                <SecretInput
                  id="dep-webhook-secret"
                  placeholder="Generate one for me"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                />
                <FieldDescription className="text-xs">
                  Use the secret configured at your provider, or leave empty to
                  generate one. It is shown once after creating.
                </FieldDescription>
              </Field>
            </Expand>
          </div>
        </FormSection>

        <FormSection title="Runtime">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field data-invalid={submitted && !!concError}>
              <FieldLabel htmlFor="dep-concurrency">Concurrency</FieldLabel>
              <Input
                id="dep-concurrency"
                type="number"
                min={1}
                max={1000}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                aria-invalid={submitted && !!concError}
              />
              <FieldDescription className="text-xs">
                {submitted && concError
                  ? `Concurrency must be ${concError}.`
                  : "Sessions running at once before new ones are refused."}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="dep-env">Environment</FieldLabel>
              <Select
                items={envItems}
                value={environment}
                onValueChange={(v) =>
                  setEnvironment(v ? String(v) : DEFAULT_ENV)
                }
              >
                <SelectTrigger id="dep-env" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {envItems.map((e) => (
                    <SelectItem key={e.value} value={e.value}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription className="text-xs">
                Sandbox the agent&apos;s tools run in.
              </FieldDescription>
            </Field>
          </div>
        </FormSection>

        <FormSection
          title="Secrets"
          description="Exposed to the agent's tools as environment variables."
          aside={
            picked.length ? (
              <span className="text-xs text-muted-foreground">
                {picked.length} selected
              </span>
            ) : null
          }
        >
          {secrets.data?.secrets.length ? (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {secrets.data.secrets.map((s) => {
                const checked = picked.includes(s.name)
                return (
                  <label
                    key={s.name}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 ring-1 ring-foreground/10 transition-colors hover:bg-muted/50",
                      checked && "bg-muted/60 ring-foreground/20"
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(c) =>
                        setPicked((p) =>
                          c ? [...p, s.name] : p.filter((x) => x !== s.name)
                        )
                      }
                    />
                    <LockKeyholeIcon className="size-3.5 text-muted-foreground" />
                    <span className="truncate font-mono text-xs">{s.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      v{s.version}
                    </span>
                  </label>
                )
              })}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
              {secrets.loading ? (
                "Loading secrets…"
              ) : (
                <>
                  No secrets yet. Add them on the{" "}
                  <Link
                    href="/secrets"
                    className="underline underline-offset-3 hover:text-foreground"
                  >
                    Secrets
                  </Link>{" "}
                  page.
                </>
              )}
            </p>
          )}
        </FormSection>

        <FormSection
          title="Budget"
          description="Refuse new runs once this deployment has used its token budget."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field data-invalid={!!budgetError}>
              <FieldLabel htmlFor="dep-budget">Max tokens</FieldLabel>
              <Input
                id="dep-budget"
                type="number"
                min={1}
                placeholder="No limit"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                aria-invalid={!!budgetError}
              />
              {budgetError ? (
                <FieldDescription className="text-xs text-destructive">
                  Use {budgetError}.
                </FieldDescription>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="dep-window">Window</FieldLabel>
              <Select
                items={WINDOWS.map((w) => ({
                  value: w,
                  label: `Rolling ${w}`,
                }))}
                value={budgetWindow}
                onValueChange={(v) => v && setBudgetWindow(String(v))}
                disabled={!maxTokens}
              >
                <SelectTrigger id="dep-window" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WINDOWS.map((w) => (
                    <SelectItem key={w} value={w}>
                      Rolling {w}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </FormSection>
      </DialogScrollBody>

      <DialogFooter className="mt-0 border-t-0 sm:items-center">
        {mutation.error ? (
          <p className="mr-auto text-sm text-destructive" role="alert">
            {mutation.error}
          </p>
        ) : null}
        {submitted && invalid && !mutation.error ? (
          <p className="mr-auto text-sm text-destructive">
            Fix the highlighted fields.
          </p>
        ) : null}
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button type="submit" disabled={mutation.pending}>
          {mutation.pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RocketIcon data-icon="inline-start" />
          )}
          Deploy
        </Button>
      </DialogFooter>
    </form>
  )
}
