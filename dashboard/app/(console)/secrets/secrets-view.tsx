"use client"

import * as React from "react"
import { AnimatePresence } from "motion/react"
import { InfoIcon, LockKeyholeIcon, PlusIcon, RefreshCwIcon, SearchIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react"
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
import { Card } from "@/components/ui/card"
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Expand, FadeIn } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states"
import { useCan } from "@/components/shell/project-context"
import { MotionRow } from "@/components/deploy/motion-row"
import { SecretInput } from "@/components/deploy/secret-input"
import { useNewDialog } from "@/components/deploy/use-new-param"
import { useApi, useMutation } from "@/hooks/use-api"
import { useNow } from "@/hooks/use-client"
import type { SecretList, SecretWritten } from "@/lib/api"
import { api, seg } from "@/lib/client"
import { formatDateTime, timeAgo } from "@/lib/format"

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

type Editing = { mode: "add" } | { mode: "rotate"; name: string }

export function SecretsView() {
  const canAdmin = useCan("admin")
  const now = useNow()
  const { data, error, loading, reload } = useApi<SecretList>("/v1/secrets")
  const [newOpen, setNewOpen] = useNewDialog(canAdmin)
  const [rotating, setRotating] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const del = useMutation()

  const all = data?.secrets ?? []
  const rows = all.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()))
  const editing: Editing | null = rotating ? { mode: "rotate", name: rotating } : newOpen ? { mode: "add" } : null
  // Keep rendering the last form while the dialog animates out.
  const [shown, setShown] = React.useState<Editing>({ mode: "add" })
  const editKey = editing ? (editing.mode === "rotate" ? `rotate:${editing.name}` : "add") : null
  const shownKey = shown.mode === "rotate" ? `rotate:${shown.name}` : "add"
  if (editing && editKey !== shownKey) setShown(editing)
  const ago = (iso: string) => (now ? timeAgo(iso, now) : "")

  async function remove() {
    if (!deleting) return
    const ok = await del.run(() => api<void>(`/v1/secrets/${seg(deleting)}`, { method: "DELETE" }).then(() => true))
    if (ok) {
      toast.success(`Deleted ${deleting}`)
      setDeleting(null)
      reload()
    }
  }

  const addButton = canAdmin ? (
    <Button onClick={() => setNewOpen(true)}>
      <PlusIcon data-icon="inline-start" />
      Add secret
    </Button>
  ) : null

  return (
    <Page>
      <PageHeader
        title="Secrets"
        description="Encrypted values that deployments expose to their agents' tools. Values are write-only: once saved they are never shown again, only rotated."
        actions={addButton}
      />

      {!canAdmin ? (
        <FadeIn className="flex items-center gap-2 rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground ring-1 ring-foreground/6">
          <InfoIcon className="size-4 shrink-0" />
          Only admins can add, rotate or delete secrets.
        </FadeIn>
      ) : null}

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {data && all.length === 0 ? (
        <EmptyState
          icon={<LockKeyholeIcon />}
          title="No secrets yet"
          description="Store API tokens and credentials here, then attach them to deployments."
          action={addButton}
        />
      ) : !error ? (
        <FadeIn delay={0.05} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <InputGroup className="sm:max-w-xs">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput placeholder="Search secrets" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search secrets" />
            </InputGroup>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">{data ? `${rows.length} of ${all.length}` : ""}</span>
          </div>
          <Card className="py-0">
            {loading && !data ? (
              <div className="p-4">
                <TableSkeleton rows={3} cols={5} />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4 text-xs text-muted-foreground">Name</TableHead>
                    <TableHead className="text-xs text-muted-foreground">Version</TableHead>
                    <TableHead className="text-xs text-muted-foreground">Key ID</TableHead>
                    <TableHead className="text-xs text-muted-foreground">Created</TableHead>
                    <TableHead className="text-xs text-muted-foreground">Rotated</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <AnimatePresence initial={false}>
                    {rows.map((s, i) => (
                      <MotionRow key={s.name} index={i}>
                        <TableCell className="py-3 pl-4">
                          <span className="flex items-center gap-2.5">
                            <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                              <LockKeyholeIcon className="size-3.5" />
                            </span>
                            <span className="font-mono text-xs font-medium">{s.name}</span>
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="muted" className="tabular-nums">
                            v{s.version}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{s.key_id}</TableCell>
                        <TableCell className="text-xs text-muted-foreground" title={formatDateTime(s.created_at)}>
                          {ago(s.created_at)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground" title={s.rotated_at ? formatDateTime(s.rotated_at) : undefined}>
                          {s.rotated_at ? ago(s.rotated_at) : "Never"}
                        </TableCell>
                        <TableCell className="pr-3 text-right">
                          {canAdmin ? (
                            <span className="inline-flex items-center gap-0.5 opacity-70 transition-opacity group-hover/row:opacity-100">
                              <Tooltip>
                                <TooltipTrigger
                                  render={<Button variant="ghost" size="icon-sm" aria-label={`Rotate ${s.name}`} onClick={() => setRotating(s.name)} />}
                                >
                                  <RefreshCwIcon />
                                </TooltipTrigger>
                                <TooltipContent>Rotate</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      aria-label={`Delete ${s.name}`}
                                      className="hover:bg-destructive/10 hover:text-destructive"
                                      onClick={() => setDeleting(s.name)}
                                    />
                                  }
                                >
                                  <Trash2Icon />
                                </TooltipTrigger>
                                <TooltipContent>Delete</TooltipContent>
                              </Tooltip>
                            </span>
                          ) : null}
                        </TableCell>
                      </MotionRow>
                    ))}
                  </AnimatePresence>
                  {data && rows.length === 0 ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                        No secrets match “{query}”.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )}
          </Card>
        </FadeIn>
      ) : null}

      <Dialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (o) return
          setRotating(null)
          setNewOpen(false)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <SecretForm
            key={shownKey}
            editing={shown}
            existing={all.map((s) => s.name)}
            onSaved={() => {
              setRotating(null)
              setNewOpen(false)
              reload()
            }}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && !del.pending && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2Icon />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete {deleting}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deployments that reference it lose access on their next session. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {del.error ? <p className="text-sm text-destructive">{del.error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={del.pending} onClick={() => void remove()}>
              {del.pending ? <Spinner data-icon="inline-start" /> : null}
              Delete secret
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}

function SecretForm({ editing, existing, onSaved }: { editing: Editing; existing: string[]; onSaved: () => void }) {
  const rotate = editing.mode === "rotate"
  const [name, setName] = React.useState(rotate ? editing.name : "")
  const [value, setValue] = React.useState("")
  const [touched, setTouched] = React.useState(false)
  const mutation = useMutation()
  const nameError = touched && !NAME_RE.test(name) ? "Start with a letter or _, then letters, digits or _ (max 128)." : null
  const willRotate = !rotate && existing.includes(name)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!NAME_RE.test(name) || !value) return
    const res = await mutation.run(() => api<SecretWritten>("/v1/secrets", { method: "POST", json: { name, value } }))
    if (res) {
      toast.success(res.version > 1 ? `Rotated ${res.name} to v${res.version}` : `Saved ${res.name}`)
      onSaved()
    }
  }

  return (
    <form onSubmit={submit} className="contents" noValidate>
      <DialogHeader>
        <DialogTitle>{rotate ? `Rotate ${editing.name}` : "Add secret"}</DialogTitle>
        <DialogDescription>
          {rotate
            ? "The new value replaces the current one for new sessions; the version number goes up."
            : "Encrypted at rest. You won't be able to view the value again."}
        </DialogDescription>
      </DialogHeader>
      <Field data-invalid={!!nameError}>
        <FieldLabel htmlFor="secret-name">Name</FieldLabel>
        <Input
          id="secret-name"
          className="font-mono"
          placeholder="GITHUB_TOKEN"
          value={name}
          readOnly={rotate}
          autoFocus={!rotate}
          onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, "_"))}
          onBlur={() => setTouched(true)}
          aria-invalid={!!nameError}
        />
        <FieldDescription className="text-xs">{nameError ?? "Exposed to tools as an environment variable of the same name."}</FieldDescription>
      </Field>
      <Expand open={willRotate}>
        <p className="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning ring-1 ring-warning/20">
          <RefreshCwIcon className="size-3.5 shrink-0" />
          {name} already exists; saving rotates it.
        </p>
      </Expand>
      <Field>
        <FieldLabel htmlFor="secret-value">Value</FieldLabel>
        <SecretInput
          id="secret-value"
          placeholder="Paste the secret value"
          value={value}
          autoFocus={rotate}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={touched && !value}
        />
        <FieldDescription className="flex items-center gap-1.5 text-xs">
          <ShieldCheckIcon className="size-3.5" />
          Write-only. Sent once over the proxy and never displayed again.
        </FieldDescription>
      </Field>
      {mutation.error ? <p className="text-sm text-destructive" role="alert">{mutation.error}</p> : null}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={mutation.pending || !value || !name}>
          {mutation.pending ? <Spinner data-icon="inline-start" /> : rotate ? <RefreshCwIcon data-icon="inline-start" /> : <LockKeyholeIcon data-icon="inline-start" />}
          {rotate || willRotate ? "Rotate secret" : "Save secret"}
        </Button>
      </DialogFooter>
    </form>
  )
}
