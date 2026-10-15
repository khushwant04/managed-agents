"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import {
  BoxIcon,
  CloudIcon,
  ContainerIcon,
  CpuIcon,
  GlobeIcon,
  GlobeLockIcon,
  GlobeXIcon,
  LaptopIcon,
  MemoryStickIcon,
  PencilIcon,
  PlusIcon,
  TimerIcon,
  Trash2Icon,
  VariableIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EASE_OUT, Expand, Stagger, StaggerItem } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { EmptyState, ErrorState } from "@/components/states"
import { useCan } from "@/components/shell/project-context"
import { DialogScrollBody, FormSection } from "@/components/deploy/form-section"
import { useNewDialog } from "@/components/deploy/use-new-param"
import { useApi, useMutation } from "@/hooks/use-api"
import type { Environment, EnvironmentList } from "@/lib/api"
import { api } from "@/lib/client"
import { formatBytes } from "@/lib/format"
import { cn } from "@/lib/utils"

type Provider = Environment["provider"]

const PROVIDERS: { value: Provider; label: string; icon: LucideIcon; blurb: string }[] = [
  { value: "e2b", label: "E2B", icon: CloudIcon, blurb: "Managed cloud microVMs" },
  { value: "docker", label: "Docker", icon: ContainerIcon, blurb: "Containers on your hosts" },
  { value: "local", label: "Local", icon: LaptopIcon, blurb: "The worker's own machine" },
]
const PROVIDER = Object.fromEntries(PROVIDERS.map((p) => [p.value, p])) as Record<Provider, (typeof PROVIDERS)[number]>

export function EnvironmentsView() {
  const canWrite = useCan("developer")
  const { data, error, loading, reload } = useApi<EnvironmentList>("/v1/environments")
  const [newOpen, setNewOpen] = useNewDialog(canWrite)
  const [editing, setEditing] = React.useState<Environment | null>(null)
  // The form shown in the dialog; kept while it animates out.
  const [shown, setShown] = React.useState<{ key: string; env: Environment | null }>({ key: "new", env: null })
  const open = newOpen || editing !== null
  const wantKey = editing ? `edit:${editing.name}` : "new"
  if (open && wantKey !== shown.key) setShown({ key: wantKey, env: editing })

  const envs = data?.environments ?? []
  const addButton = canWrite ? (
    <Button onClick={() => setNewOpen(true)}>
      <PlusIcon data-icon="inline-start" />
      New environment
    </Button>
  ) : null

  return (
    <Page>
      <PageHeader
        title="Environments"
        description="Sandboxes that agents' tools run in: provider, template, resource limits and network access."
        actions={addButton}
      />

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {loading && !data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      ) : data && envs.length === 0 ? (
        <EmptyState
          icon={<BoxIcon />}
          title="No environments yet"
          description="Without one, tools run in the default local sandbox. Add an E2B or Docker environment for isolation."
          action={addButton}
        />
      ) : (
        <Stagger className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" gap={0.06}>
          {envs.map((env) => (
            <StaggerItem key={env.name} className="flex">
              <EnvironmentCard env={env} onEdit={canWrite ? () => setEditing(env) : undefined} />
            </StaggerItem>
          ))}
        </Stagger>
      )}

      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (o) return
          setNewOpen(false)
          setEditing(null)
        }}
      >
        <DialogContent className="gap-0 sm:max-w-xl">
          <EnvironmentForm
            key={shown.key}
            initial={shown.env}
            existing={envs.map((e) => e.name)}
            onSaved={() => {
              setNewOpen(false)
              setEditing(null)
              reload()
            }}
          />
        </DialogContent>
      </Dialog>
    </Page>
  )
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2">
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  )
}

function EnvironmentCard({ env, onEdit }: { env: Environment; onEdit?: () => void }) {
  const p = PROVIDER[env.provider] ?? PROVIDER.local
  const hosts = env.allowed_hosts ?? []
  const vars = Object.keys(env.env ?? {})
  const net = !env.allow_internet
    ? { icon: GlobeXIcon, text: "No internet access", tone: "text-muted-foreground" }
    : hosts.length
      ? { icon: GlobeLockIcon, text: `Restricted to ${hosts.length} host${hosts.length === 1 ? "" : "s"}`, tone: "text-info" }
      : { icon: GlobeIcon, text: "Open internet access", tone: "text-success" }

  return (
    <Card className="card-interactive group/env flex-1">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted ring-1 ring-foreground/8 transition-colors duration-300 group-hover/env:bg-primary group-hover/env:text-primary-foreground">
            <p.icon className="size-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate font-mono text-sm">{env.name}</CardTitle>
            <CardDescription className="truncate font-mono text-xs">{env.template}</CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant="outline">{p.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="grid grid-cols-3 gap-2">
          <Stat icon={TimerIcon} label="Timeout" value={humanSeconds(env.timeout_s)} />
          <Stat icon={CpuIcon} label="CPU" value={env.cpu ? `${env.cpu} vCPU` : "Default"} />
          <Stat icon={MemoryStickIcon} label="Memory" value={env.memory_mb ? formatBytes(env.memory_mb * 1024 * 1024) : "Default"} />
        </div>
        <div className={cn("flex items-center gap-1.5 text-xs", net.tone)}>
          <net.icon className="size-3.5" />
          {net.text}
        </div>
        {env.allow_internet && hosts.length ? (
          <div className="flex flex-wrap gap-1">
            {hosts.map((h) => (
              <Badge key={h} variant="muted" className="font-mono">
                {h}
              </Badge>
            ))}
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="justify-between border-t bg-muted/30 py-2.5 text-xs text-muted-foreground">
        {vars.length ? (
          <Tooltip>
            <TooltipTrigger render={<span className="flex items-center gap-1.5" />}>
              <VariableIcon className="size-3.5" />
              {vars.length} env var{vars.length === 1 ? "" : "s"}
            </TooltipTrigger>
            <TooltipContent className="font-mono">{vars.join(", ")}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="flex items-center gap-1.5">
            <VariableIcon className="size-3.5" />
            No env vars
          </span>
        )}
        {onEdit ? (
          <Button variant="ghost" size="xs" onClick={onEdit}>
            <PencilIcon data-icon="inline-start" />
            Edit
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  )
}

interface EnvRow {
  key: number
  name: string
  value: string
}

let rowSeq = 0

/** 900 → "15 min", 3600 → "1 h", 5400 → "1 h 30 min", 45 → "45 s". */
function humanSeconds(total: number): string {
  if (total < 60) return `${total} s`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts = [h ? `${h} h` : "", m ? `${m} min` : "", s && !h ? `${s} s` : ""].filter(Boolean)
  return parts.join(" ")
}

function EnvironmentForm({
  initial,
  existing,
  onSaved,
}: {
  initial: Environment | null
  existing: string[]
  onSaved: () => void
}) {
  const editing = initial !== null
  const [name, setName] = React.useState(initial?.name ?? "")
  const [provider, setProvider] = React.useState<Provider>(initial?.provider ?? "e2b")
  const [template, setTemplate] = React.useState(initial?.template ?? "runhive-base")
  const [timeout, setTimeoutS] = React.useState(String(initial?.timeout_s ?? 3600))
  const [cpu, setCpu] = React.useState(initial?.cpu ? String(initial.cpu) : "")
  const [memory, setMemory] = React.useState(initial?.memory_mb ? String(initial.memory_mb) : "")
  const [internet, setInternet] = React.useState(initial?.allow_internet ?? true)
  const [hosts, setHosts] = React.useState<string[]>(initial?.allowed_hosts ?? [])
  const [hostDraft, setHostDraft] = React.useState("")
  const [vars, setVars] = React.useState<EnvRow[]>(() =>
    Object.entries(initial?.env ?? {}).map(([k, v]) => ({ key: ++rowSeq, name: k, value: v }))
  )
  const [submitted, setSubmitted] = React.useState(false)
  const mutation = useMutation()

  const positiveInt = (s: string, optional: boolean) => (optional && !s ? true : /^\d+$/.test(s) && Number(s) > 0)
  const errors = {
    name: !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name) ? "Letters, digits, - _ and ., starting with a letter or digit." : null,
    template: !template.trim() ? "Required." : null,
    timeout: !positiveInt(timeout, false) ? "Seconds, a positive whole number." : null,
    cpu: !positiveInt(cpu, true) ? "Whole vCPUs." : null,
    memory: !positiveInt(memory, true) ? "Megabytes, a whole number." : null,
    vars: vars.some((v) => v.name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) ? "Variable names use letters, digits and _." : null,
  }
  const show = (k: keyof typeof errors) => (submitted ? errors[k] : null)
  const overwrites = !editing && existing.includes(name)

  function addHost(raw: string) {
    const next = raw
      .split(/[\s,]+/)
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h && !hosts.includes(h))
    if (next.length) setHosts([...hosts, ...new Set(next)])
    setHostDraft("")
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    if (Object.values(errors).some(Boolean)) return
    const pending = hostDraft.trim() ? [...hosts, hostDraft.trim().toLowerCase()] : hosts
    const body: Environment = {
      name,
      provider,
      template: template.trim(),
      timeout_s: Number(timeout),
      cpu: cpu ? Number(cpu) : null,
      memory_mb: memory ? Number(memory) : null,
      allow_internet: internet,
      allowed_hosts: internet ? pending : [],
      env: Object.fromEntries(vars.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value])),
    }
    const res = await mutation.run(() => api<Environment>("/v1/environments", { method: "POST", json: body }))
    if (res) {
      toast.success(editing || overwrites ? `Updated ${res.name}` : `Created ${res.name}`)
      onSaved()
    }
  }

  return (
    <form onSubmit={submit} className="contents" noValidate>
      <DialogHeader className="pb-4">
        <DialogTitle>{editing ? `Edit ${initial.name}` : "New environment"}</DialogTitle>
        <DialogDescription>Deployments pick an environment by name; changes apply to new sessions.</DialogDescription>
      </DialogHeader>
      <DialogScrollBody className="flex flex-col gap-6">
        <FormSection title="Sandbox">
          <Field data-invalid={!!show("name")}>
            <FieldLabel htmlFor="env-name">Name</FieldLabel>
            <Input
              id="env-name"
              className="font-mono"
              placeholder="python-sandbox"
              value={name}
              readOnly={editing}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!show("name")}
            />
            {show("name") ? (
              <FieldDescription className="text-xs text-destructive">{show("name")}</FieldDescription>
            ) : overwrites ? (
              <FieldDescription className="text-xs text-warning">An environment named {name} exists; saving replaces it.</FieldDescription>
            ) : null}
          </Field>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Provider">
            {PROVIDERS.map((p) => {
              const active = p.value === provider
              return (
                <button
                  key={p.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setProvider(p.value)}
                  className={cn(
                    "relative flex flex-col items-start gap-1 rounded-lg p-3 text-left ring-1 ring-foreground/10 transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
                    active ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="env-provider"
                      transition={{ type: "spring", stiffness: 500, damping: 38 }}
                      className="absolute inset-0 rounded-lg bg-muted/70 ring-1 ring-foreground/25"
                    />
                  ) : null}
                  <p.icon className="relative size-4" />
                  <span className="relative text-sm font-medium">{p.label}</span>
                  <span className="relative hidden text-xs text-muted-foreground sm:block">{p.blurb}</span>
                </button>
              )
            })}
          </div>
          <Field data-invalid={!!show("template")}>
            <FieldLabel htmlFor="env-template">{provider === "docker" ? "Image" : "Template"}</FieldLabel>
            <Input
              id="env-template"
              className="font-mono"
              placeholder={provider === "docker" ? "python:3.12-slim" : "runhive-base"}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              aria-invalid={!!show("template")}
            />
          </Field>
        </FormSection>

        <FormSection title="Limits">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field data-invalid={!!show("timeout")}>
              <FieldLabel htmlFor="env-timeout">Timeout (s)</FieldLabel>
              <Input id="env-timeout" type="number" min={1} value={timeout} onChange={(e) => setTimeoutS(e.target.value)} aria-invalid={!!show("timeout")} />
              <FieldDescription className="text-xs">
                {show("timeout") ?? (positiveInt(timeout, false) ? humanSeconds(Number(timeout)) : "")}
              </FieldDescription>
            </Field>
            <Field data-invalid={!!show("cpu")}>
              <FieldLabel htmlFor="env-cpu">CPU</FieldLabel>
              <Input id="env-cpu" type="number" min={1} placeholder="Default" value={cpu} onChange={(e) => setCpu(e.target.value)} aria-invalid={!!show("cpu")} />
              <FieldDescription className="text-xs">{show("cpu") ?? "vCPUs"}</FieldDescription>
            </Field>
            <Field data-invalid={!!show("memory")}>
              <FieldLabel htmlFor="env-memory">Memory (MB)</FieldLabel>
              <Input id="env-memory" type="number" min={1} placeholder="Default" value={memory} onChange={(e) => setMemory(e.target.value)} aria-invalid={!!show("memory")} />
              <FieldDescription className="text-xs">
                {show("memory") ?? (memory && positiveInt(memory, false) ? formatBytes(Number(memory) * 1024 * 1024) : "Megabytes")}
              </FieldDescription>
            </Field>
          </div>
        </FormSection>

        <FormSection title="Network">
          <Field orientation="horizontal" className="items-center justify-between rounded-lg px-3 py-2.5 ring-1 ring-foreground/10">
            <div className="flex flex-col gap-0.5">
              <FieldLabel htmlFor="env-internet">Internet access</FieldLabel>
              <FieldDescription className="text-xs">
                {internet ? "Outbound traffic allowed (optionally only to the hosts below)." : "The sandbox has no network."}
              </FieldDescription>
            </div>
            <Switch id="env-internet" checked={internet} onCheckedChange={setInternet} />
          </Field>
          <Expand open={internet}>
            <Field>
              <FieldLabel htmlFor="env-hosts">Allowed hosts</FieldLabel>
              <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input px-1.5 py-1 transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
                <AnimatePresence initial={false}>
                  {hosts.map((h) => (
                    <motion.span
                      key={h}
                      layout
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.15 }}
                      className="inline-flex h-6 items-center gap-1 rounded-md bg-muted pr-0.5 pl-2 font-mono text-xs"
                    >
                      {h}
                      <button
                        type="button"
                        aria-label={`Remove ${h}`}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                        onClick={() => setHosts(hosts.filter((x) => x !== h))}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </motion.span>
                  ))}
                </AnimatePresence>
                <input
                  id="env-hosts"
                  className="h-6 min-w-32 flex-1 bg-transparent px-1 font-mono text-xs outline-none placeholder:text-muted-foreground"
                  placeholder={hosts.length ? "Add another…" : "api.github.com"}
                  value={hostDraft}
                  onChange={(e) => setHostDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault()
                      addHost(hostDraft)
                    } else if (e.key === "Backspace" && !hostDraft && hosts.length) setHosts(hosts.slice(0, -1))
                  }}
                  onBlur={() => hostDraft.trim() && addHost(hostDraft)}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text")
                    if (/[\s,]/.test(text)) {
                      e.preventDefault()
                      addHost(text)
                    }
                  }}
                />
              </div>
              <FieldDescription className="text-xs">Press Enter to add. Leave empty to allow any host.</FieldDescription>
            </Field>
          </Expand>
        </FormSection>

        <FormSection
          title="Environment variables"
          description="Plain, non-secret values. Secrets are attached to deployments instead."
          aside={
            <Button type="button" variant="outline" size="xs" onClick={() => setVars([...vars, { key: ++rowSeq, name: "", value: "" }])}>
              <PlusIcon data-icon="inline-start" />
              Add
            </Button>
          }
        >
          {vars.length === 0 ? <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">No variables.</p> : null}
          <AnimatePresence initial={false}>
            {vars.map((v) => (
              <motion.div
                key={v.key}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25, ease: EASE_OUT }}
                className="-my-1.5 overflow-hidden py-1.5"
              >
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Variable name"
                    className="w-2/5 font-mono text-xs md:text-xs"
                    placeholder="LOG_LEVEL"
                    value={v.name}
                    onChange={(e) => setVars(vars.map((x) => (x.key === v.key ? { ...x, name: e.target.value } : x)))}
                  />
                  <Input
                    aria-label="Variable value"
                    className="flex-1 font-mono text-xs md:text-xs"
                    placeholder="info"
                    value={v.value}
                    onChange={(e) => setVars(vars.map((x) => (x.key === v.key ? { ...x, value: e.target.value } : x)))}
                  />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove variable" onClick={() => setVars(vars.filter((x) => x.key !== v.key))}>
                    <Trash2Icon />
                  </Button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {show("vars") ? <p className="text-xs text-destructive">{show("vars")}</p> : null}
        </FormSection>
      </DialogScrollBody>
      <DialogFooter className="mt-0 border-t-0">
        {mutation.error ? <p className="mr-auto self-center text-sm text-destructive" role="alert">{mutation.error}</p> : null}
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={mutation.pending}>
          {mutation.pending ? <Spinner data-icon="inline-start" /> : null}
          {editing ? "Save changes" : "Create environment"}
        </Button>
      </DialogFooter>
    </form>
  )
}
