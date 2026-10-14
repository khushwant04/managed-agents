"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowDownIcon } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EASE_OUT } from "@/components/motion"
import { PercentSlider } from "@/components/agents/percent-slider"
import { versionFill, WeightBar } from "@/components/agents/weight-bar"
import { useMutation } from "@/hooks/use-api"
import { canaryTarget, describeTarget, isValidAliasName, promoteTarget, validateTarget } from "@/lib/alias"
import type { AliasInfo, AliasResult, AliasTarget } from "@/lib/api"
import { api, seg } from "@/lib/client"
import { cn } from "@/lib/utils"

export interface AliasDraft {
  alias: string
  mode: "single" | "split"
  stable: number
  canary: number
  percent: number
}

/** A sensible starting point: the alias's current split, or `version` everywhere. */
export function draftFor(aliases: readonly AliasInfo[], versions: readonly number[], opts: { alias?: string; version?: number; mode?: "single" | "split" } = {}): AliasDraft {
  const alias = opts.alias ?? aliases.find((a) => a.alias === "prod")?.alias ?? aliases[0]?.alias ?? "prod"
  const current = aliases.find((a) => a.alias === alias)
  const latest = versions[0] ?? 1
  const currentStable = current?.versions[0]?.version
  if (opts.mode === "split" || (!opts.mode && current && current.versions.length > 1)) {
    const split = current && current.versions.length > 1 && opts.version === undefined ? current.versions : null
    if (split) return { alias, mode: "split", stable: split[0]!.version, canary: split[1]!.version, percent: split[1]!.weight ?? 10 }
    const canary = opts.version ?? latest
    const stable = [currentStable, ...versions].find((v) => v !== undefined && v !== canary) ?? canary
    return { alias, mode: "split", stable, canary, percent: 10 }
  }
  return { alias, mode: "single", stable: opts.version ?? currentStable ?? latest, canary: latest, percent: 10 }
}

function VersionSelect({ id, value, versions, onChange }: { id: string; value: number; versions: readonly number[]; onChange: (v: number) => void }) {
  return (
    <Select value={String(value)} onValueChange={(v) => v && onChange(Number(v))}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue>
          {(v: string) => (
            <span className="flex items-center gap-2">
              <span className={cn("size-2 rounded-full", versionFill(Number(v)))} />v{v}
              {Number(v) === versions[0] ? <span className="text-xs text-muted-foreground">latest</span> : null}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {versions.map((v) => (
          <SelectItem key={v} value={String(v)}>
            <span className={cn("size-2 rounded-full", versionFill(v))} />v{v}
            {v === versions[0] ? <span className="text-xs text-muted-foreground">latest</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function AliasForm({
  name,
  versions,
  aliases,
  initial,
  onDone,
  onCancel,
}: {
  name: string
  versions: readonly number[]
  aliases: readonly AliasInfo[]
  initial: AliasDraft
  onDone: (r: AliasResult) => void
  onCancel: () => void
}) {
  const [d, setD] = React.useState(initial)
  const set = (patch: Partial<AliasDraft>) => setD((prev) => ({ ...prev, ...patch }))
  const { pending, error, run } = useMutation()

  const current = aliases.find((a) => a.alias === d.alias)
  let target: AliasTarget | null = null
  let problem: string | null = null
  try {
    if (!isValidAliasName(d.alias)) throw new Error("Alias names use letters, digits, - and _.")
    if (d.mode === "split" && d.stable === d.canary) throw new Error("Pick two different versions for a split.")
    target = d.mode === "single" ? promoteTarget(d.stable) : canaryTarget(d.stable, d.canary, d.percent)
    problem = validateTarget(target)
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e)
  }
  const unchanged = !!target && !!current && describeTarget(current.versions) === describeTarget(target.versions)

  async function submit() {
    if (!target || problem) return
    const t = target
    const r = await run(() => api<AliasResult>(`/v1/agents/${seg(name)}/aliases/${seg(d.alias)}`, { method: "PUT", json: t }))
    if (!r) return
    toast.success(`${name}@${r.alias} → ${describeTarget(r.versions)}`, {
      description: "New sessions route by the new weights; running sessions keep their version.",
    })
    onDone(r)
  }

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="alias-name">Alias</FieldLabel>
          <Input
            id="alias-name"
            value={d.alias}
            onChange={(e) => set({ alias: e.target.value.trim() })}
            aria-invalid={!isValidAliasName(d.alias) || undefined}
            className="font-mono"
            autoComplete="off"
          />
          {aliases.length ? (
            <div className="flex flex-wrap gap-1">
              {aliases.map((a) => (
                <button
                  key={a.alias}
                  type="button"
                  onClick={() => set({ alias: a.alias })}
                  className={cn(
                    "rounded-md px-2 py-0.5 font-mono text-xs ring-1 ring-foreground/10 transition-colors",
                    a.alias === d.alias ? "bg-primary text-primary-foreground ring-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {a.alias}
                </button>
              ))}
            </div>
          ) : null}
        </Field>

        <Tabs value={d.mode} onValueChange={(v) => set({ mode: v as AliasDraft["mode"] })}>
          <TabsList className="w-full">
            <TabsTrigger value="single">Single version</TabsTrigger>
            <TabsTrigger value="split" disabled={versions.length < 2}>
              Canary split
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className={cn("grid gap-3", d.mode === "split" && "grid-cols-2")}>
          <Field>
            <FieldLabel htmlFor="alias-stable">{d.mode === "split" ? "Stable" : "Version"}</FieldLabel>
            <VersionSelect id="alias-stable" value={d.stable} versions={versions} onChange={(v) => set({ stable: v })} />
          </Field>
          <AnimatePresence initial={false}>
            {d.mode === "split" ? (
              <motion.div
                key="canary"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.25, ease: EASE_OUT }}
              >
                <Field>
                  <FieldLabel htmlFor="alias-canary">Canary</FieldLabel>
                  <VersionSelect id="alias-canary" value={d.canary} versions={versions} onChange={(v) => set({ canary: v })} />
                </Field>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <AnimatePresence initial={false}>
          {d.mode === "split" ? (
            <motion.div
              key="weight"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3, ease: EASE_OUT }}
              className="overflow-hidden"
            >
              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="alias-percent">Canary share</FieldLabel>
                  <div className="flex items-center gap-1">
                    <Input
                      id="alias-percent"
                      type="number"
                      min={0}
                      max={100}
                      value={d.percent}
                      onChange={(e) => set({ percent: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) })}
                      className="h-7 w-16 text-right tabular-nums"
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>
                <PercentSlider
                  value={d.percent}
                  onValueChange={(v) => set({ percent: v })}
                  aria-label="Canary share"
                  indicatorClassName={versionFill(d.canary)}
                />
                <FieldDescription className="text-xs">
                  {100 - d.percent}% of new sessions stay on v{d.stable}; {d.percent}% try v{d.canary}. Sessions stick to the version they started on.
                </FieldDescription>
              </Field>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3 ring-1 ring-foreground/6">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Now</span>
            <span className="font-mono">{current ? describeTarget(current.versions) : "new alias"}</span>
          </div>
          {current ? <WeightBar versions={current.versions} legend={false} /> : <div className="h-1.5 rounded-full bg-muted" />}
          <ArrowDownIcon className="mx-auto size-3.5 text-muted-foreground" />
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">After</span>
            <span className="font-mono font-medium">{target && !problem ? describeTarget(target.versions) : "–"}</span>
          </div>
          {target && !problem ? <WeightBar versions={target.versions} legend={false} /> : <div className="h-1.5 rounded-full bg-muted" />}
        </div>

        {problem || error ? <FieldError>{problem ?? error}</FieldError> : null}
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !!problem || unchanged}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {unchanged ? "No change" : current ? "Move alias" : "Create alias"}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Point an alias at one version or split it between two (promote / canary). */
export function AliasDialog({
  name,
  versions,
  aliases,
  draft,
  onOpenChange,
  onDone,
  title,
}: {
  name: string
  versions: readonly number[]
  aliases: readonly AliasInfo[]
  /** The starting values; null closes the dialog. */
  draft: AliasDraft | null
  onOpenChange: (open: boolean) => void
  onDone: (r: AliasResult) => void
  title?: string
}) {
  // Keep the last draft while the dialog animates closed.
  const [last, setLast] = React.useState(draft)
  if (draft && draft !== last) setLast(draft)
  const shown = draft ?? last
  return (
    <Dialog open={draft !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title ?? (shown?.mode === "split" ? "Canary release" : "Promote version")}</DialogTitle>
          <DialogDescription>
            Route new sessions on <span className="font-mono text-foreground">{name}@{shown?.alias || "alias"}</span>.
          </DialogDescription>
        </DialogHeader>
        {shown ? (
          <AliasForm
            key={JSON.stringify(shown)}
            name={name}
            versions={versions}
            aliases={aliases}
            initial={shown}
            onCancel={() => onOpenChange(false)}
            onDone={onDone}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
