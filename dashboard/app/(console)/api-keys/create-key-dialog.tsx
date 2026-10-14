"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { CheckIcon, KeyRoundIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { CopyButton } from "@/components/copy-button"
import { EASE_OUT } from "@/components/motion"
import { ROLES, type Role } from "@/components/settings/roles"
import { useMutation } from "@/hooks/use-api"
import type { KeyCreated } from "@/lib/api"
import { api } from "@/lib/client"

const slide = {
  initial: (dir: number) => ({ opacity: 0, x: dir * 24, filter: "blur(2px)" }),
  animate: { opacity: 1, x: 0, filter: "blur(0px)" },
  exit: (dir: number) => ({ opacity: 0, x: dir * -24, filter: "blur(2px)" }),
}

/** Create a key, then reveal it exactly once. */
export function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (key: KeyCreated, name: string) => void
}) {
  const [name, setName] = React.useState("")
  const [role, setRole] = React.useState<Role>("developer")
  const [created, setCreated] = React.useState<KeyCreated | null>(null)
  const [copied, setCopied] = React.useState(false)
  const m = useMutation()

  const reset = () => {
    setName("")
    setRole("developer")
    setCreated(null)
    setCopied(false)
    m.setError(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      m.setError("Give the key a name so you can recognise it later.")
      return
    }
    const res = await m.run(() => api<KeyCreated>("/v1/keys", { method: "POST", json: { name: trimmed, role } }))
    if (res) {
      setCreated(res)
      onCreated(res, trimmed)
      toast.success(`Created ${res.role} key “${trimmed}”`)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(o) => {
        if (!o) reset()
      }}
      // Don't lose a freshly revealed key to a stray click outside.
      disablePointerDismissal={!!created}
    >
      <DialogContent className="overflow-hidden sm:max-w-lg">
        <AnimatePresence mode="wait" initial={false} custom={created ? 1 : -1}>
          {created ? (
            <motion.div
              key="reveal"
              custom={1}
              variants={slide}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: 0.28, ease: EASE_OUT }}
              className="grid min-w-0 gap-4"
            >
              <DialogHeader>
                <motion.div
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", bounce: 0.45, duration: 0.5, delay: 0.1 }}
                  className="mb-1 flex size-10 items-center justify-center rounded-xl bg-success/12 text-success"
                >
                  <CheckIcon className="size-5" />
                </motion.div>
                <DialogTitle>Save your API key</DialogTitle>
                <DialogDescription>
                  “{name.trim()}” has the <span className="font-medium text-foreground">{created.role}</span> role. Copy it now and store it somewhere safe.
                </DialogDescription>
              </DialogHeader>

              <div className="flex items-center gap-2 rounded-lg bg-muted/60 p-1 pl-3 ring-1 ring-foreground/10">
                <code className="min-w-0 flex-1 py-1 font-mono text-xs leading-relaxed break-all select-all">
                  {created.key}
                </code>
                <span onClickCapture={() => setCopied(true)}>
                  <CopyButton value={created.key} label="Copy key" size="sm" variant="outline" />
                </span>
              </div>

              <div role="note" className="flex items-start gap-2.5 rounded-lg bg-warning/10 p-3 text-xs ring-1 ring-warning/25">
                <TriangleAlertIcon className="mt-px size-4 shrink-0 text-warning" />
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">You won&apos;t be able to see this key again.</span> If you lose it, revoke it and create a
                  new one. Keep it out of source control and client-side code.
                </p>
              </div>

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Key ID</dt>
                <dd className="font-mono">{created.id}</dd>
              </dl>

              <DialogFooter>
                <Button onClick={() => onOpenChange(false)} variant={copied ? "default" : "outline"}>
                  {copied ? "Done" : "I've saved my key"}
                </Button>
              </DialogFooter>
            </motion.div>
          ) : (
            <motion.form
              key="form"
              custom={-1}
              variants={slide}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: 0.28, ease: EASE_OUT }}
              onSubmit={submit}
              className="grid min-w-0 gap-4"
            >
              <DialogHeader>
                <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-muted ring-1 ring-foreground/10">
                  <KeyRoundIcon className="size-4" />
                </div>
                <DialogTitle>Create API key</DialogTitle>
                <DialogDescription>Keys authenticate the SDKs, the CLI and direct HTTP calls to this project.</DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <Field data-invalid={m.error && !name.trim() ? true : undefined}>
                  <FieldLabel htmlFor="key-name">Name</FieldLabel>
                  <Input
                    id="key-name"
                    autoFocus
                    autoComplete="off"
                    placeholder="e.g. ci-pipeline"
                    value={name}
                    maxLength={100}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Role</FieldLabel>
                  <RadioGroup value={role} onValueChange={(v) => setRole(v as Role)} aria-label="Role">
                    {ROLES.map((r) => (
                      <FieldLabel key={r.value} htmlFor={`role-${r.value}`}>
                        <Field orientation="horizontal">
                          <r.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <FieldContent>
                            <FieldTitle>{r.label}</FieldTitle>
                            <FieldDescription className="text-xs">{r.description}</FieldDescription>
                          </FieldContent>
                          <RadioGroupItem value={r.value} id={`role-${r.value}`} />
                        </Field>
                      </FieldLabel>
                    ))}
                  </RadioGroup>
                </Field>
                {m.error ? <FieldError>{m.error}</FieldError> : null}
              </FieldGroup>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={m.pending}>
                  {m.pending ? <Spinner data-icon="inline-start" /> : null}
                  Create key
                </Button>
              </DialogFooter>
            </motion.form>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  )
}
