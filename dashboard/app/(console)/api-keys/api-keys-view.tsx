"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { InfoIcon, KeyRoundIcon, PlusIcon, ShieldIcon, Trash2Icon } from "lucide-react"
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
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Page, PageHeader } from "@/components/page"
import { EASE_OUT, FadeIn } from "@/components/motion"
import { CopyButton } from "@/components/copy-button"
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states"
import { useCan, useProject } from "@/components/shell/project-context"
import { useApi, useMutation } from "@/hooks/use-api"
import { useNow } from "@/hooks/use-client"
import type { AuditList } from "@/lib/api"
import { api, seg } from "@/lib/client"
import { formatDateTime, shortId, timeAgo } from "@/lib/format"
import { deriveKeys, type DerivedKey } from "@/lib/keys"
import { cn } from "@/lib/utils"
import { roleMeta } from "@/components/settings/roles"
import { CreateKeyDialog } from "./create-key-dialog"
import { KeySnippets } from "./key-snippets"
import { rememberKeyName, useKeyNames } from "./key-names"

const AUDIT_LIMIT = 1000
type Filter = "active" | "revoked" | "all"

export function ApiKeysView() {
  const isAdmin = useCan("admin")
  const project = useProject()
  const [creating, setCreating] = React.useState(false)
  const [revoking, setRevoking] = React.useState<DerivedKey | null>(null)
  const [filter, setFilter] = React.useState<Filter>("active")
  const audit = useApi<AuditList>(isAdmin ? "/v1/audit" : null, { limit: AUDIT_LIMIT })
  const names = useKeyNames()
  const now = useNow()

  const keys = React.useMemo(() => deriveKeys(audit.data?.entries ?? []), [audit.data])
  const counts = {
    active: keys.filter((k) => !k.revokedAt).length,
    revoked: keys.filter((k) => k.revokedAt).length,
    all: keys.length,
  }
  const shown = keys.filter((k) => (filter === "all" ? true : filter === "revoked" ? !!k.revokedAt : !k.revokedAt))

  return (
    <Page>
      <PageHeader
        title="API keys"
        description="Keys authenticate the SDKs, the CLI and direct HTTP calls. Each key belongs to this project and carries one role."
        actions={
          isAdmin ? (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon data-icon="inline-start" />
              Create key
            </Button>
          ) : null
        }
      />

      {!isAdmin ? (
        <FadeIn className="flex items-start gap-3 rounded-xl bg-info/8 p-4 text-sm ring-1 ring-info/20">
          <ShieldIcon className="mt-0.5 size-4 shrink-0 text-info" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">Only admins can manage API keys</p>
            <p className="text-muted-foreground">
              You&apos;re signed in to <span className="font-medium text-foreground">{project.name}</span> with a{" "}
              <span className="font-medium text-foreground">{project.role}</span> key. Ask a project admin to create or revoke keys; you can still use
              your own key with the snippets below.
            </p>
          </div>
        </FadeIn>
      ) : (
        <div className="flex flex-col gap-3">
          <FadeIn delay={0.05} className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
              <TabsList>
                {(["active", "revoked", "all"] as const).map((f) => (
                  <TabsTrigger key={f} value={f} className="px-2.5 capitalize">
                    {f}
                    <span className="text-xs text-muted-foreground tabular-nums">{audit.data ? counts[f] : ""}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <span className="text-xs text-muted-foreground">Listed from the last {AUDIT_LIMIT.toLocaleString()} audit log entries</span>
          </FadeIn>

          {audit.error ? <ErrorState error={audit.error} onRetry={audit.reload} /> : null}

          {audit.loading && !audit.data ? (
            <Card className="p-4">
              <TableSkeleton rows={4} cols={5} />
            </Card>
          ) : audit.data && keys.length === 0 ? (
            <EmptyState
              icon={<KeyRoundIcon />}
              title="No API keys yet"
              description="Create a key for each app, pipeline or teammate so you can revoke them independently."
              action={
                <Button onClick={() => setCreating(true)}>
                  <PlusIcon data-icon="inline-start" />
                  Create key
                </Button>
              }
            />
          ) : audit.data ? (
            <FadeIn delay={0.1}>
              <Card className="py-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4 text-xs font-normal text-muted-foreground">Name</TableHead>
                      <TableHead className="text-xs font-normal text-muted-foreground">Key ID</TableHead>
                      <TableHead className="text-xs font-normal text-muted-foreground">Role</TableHead>
                      <TableHead className="text-xs font-normal text-muted-foreground">Created</TableHead>
                      <TableHead className="text-xs font-normal text-muted-foreground">Last activity</TableHead>
                      <TableHead className="text-xs font-normal text-muted-foreground">Status</TableHead>
                      <TableHead className="w-12 pr-4" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <AnimatePresence initial={false}>
                      {shown.length ? (
                        shown.map((k, i) => (
                          <KeyRow key={k.id} k={k} index={i} name={names[k.id]} now={now} onRevoke={() => setRevoking(k)} />
                        ))
                      ) : (
                        <motion.tr key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                          <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                            {filter === "revoked" ? "No revoked keys." : "No active keys."}
                          </TableCell>
                        </motion.tr>
                      )}
                    </AnimatePresence>
                  </TableBody>
                </Table>
              </Card>
              <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                <InfoIcon className="mt-px size-3.5 shrink-0" />
                The API never returns a key&apos;s secret or name after creation. Names shown here are remembered by this browser for keys created in
                it; keys created elsewhere appear by ID.
              </p>
            </FadeIn>
          ) : null}
        </div>
      )}

      <FadeIn delay={0.15}>
        <KeySnippets />
      </FadeIn>

      {isAdmin ? (
        <>
          <CreateKeyDialog
            open={creating}
            onOpenChange={setCreating}
            onCreated={(key, name) => {
              rememberKeyName(key.id, name)
              setFilter((f) => (f === "revoked" ? "active" : f))
              audit.reload()
            }}
          />
          <RevokeKeyDialog
            target={revoking}
            name={revoking ? names[revoking.id] : undefined}
            onClose={() => setRevoking(null)}
            onRevoked={audit.reload}
          />
        </>
      ) : null}
    </Page>
  )
}

function RoleBadge({ role }: { role: string | null }) {
  const meta = roleMeta(role)
  if (!meta) return <span className="text-muted-foreground">–</span>
  return (
    <Badge variant={role === "admin" ? "default" : role === "developer" ? "secondary" : "outline"}>
      <meta.icon data-icon="inline-start" />
      {meta.label}
    </Badge>
  )
}

function When({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="text-muted-foreground">–</span>
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default text-muted-foreground tabular-nums" />}>
        {now ? timeAgo(iso, now) : formatDateTime(iso)}
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(iso)}</TooltipContent>
    </Tooltip>
  )
}

function KeyRow({
  k,
  index,
  name,
  now,
  onRevoke,
}: {
  k: DerivedKey
  index: number
  name: string | undefined
  now: number
  onRevoke: () => void
}) {
  const revoked = !!k.revokedAt
  return (
    <motion.tr
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: 0.35, ease: EASE_OUT, delay: Math.min(index, 10) * 0.03 }}
      className="group/row border-b transition-colors last:border-0 hover:bg-muted/50"
    >
      <TableCell className="pl-4">
        <div className="flex items-center gap-2.5">
          <div
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md ring-1 ring-foreground/10",
              revoked ? "bg-muted text-muted-foreground" : "bg-background"
            )}
          >
            <KeyRoundIcon className="size-3.5" />
          </div>
          {name ? (
            <span className={cn("font-medium", revoked && "text-muted-foreground line-through decoration-muted-foreground/50")}>{name}</span>
          ) : k.origin === "actor" ? (
            <Tooltip>
              <TooltipTrigger render={<span className="cursor-default text-muted-foreground" />}>Setup key</TooltipTrigger>
              <TooltipContent className="max-w-60">Created outside the API (at project setup or with the CLI). It shows up because it has made changes.</TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-muted-foreground">Unnamed</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <span className="font-mono text-xs" title={k.id}>
            {shortId(k.id, 12)}
          </span>
          <CopyButton value={k.id} label="Copy key ID" size="icon-xs" className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100" />
        </div>
      </TableCell>
      <TableCell>
        <RoleBadge role={k.role} />
      </TableCell>
      <TableCell>
        <When iso={k.createdAt} now={now} />
      </TableCell>
      <TableCell>
        <When iso={k.lastSeenAt} now={now} />
      </TableCell>
      <TableCell>
        {revoked ? (
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <Badge variant="destructive">Revoked</Badge>
            </TooltipTrigger>
            <TooltipContent>Revoked {formatDateTime(k.revokedAt)}</TooltipContent>
          </Tooltip>
        ) : (
          <Badge variant="success">
            <span className="size-1.5 rounded-full bg-current" />
            Active
          </Badge>
        )}
      </TableCell>
      <TableCell className="pr-4 text-right">
        {revoked ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Revoke ${name ?? k.id}`}
                  onClick={onRevoke}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                />
              }
            >
              <Trash2Icon />
            </TooltipTrigger>
            <TooltipContent>Revoke</TooltipContent>
          </Tooltip>
        )}
      </TableCell>
    </motion.tr>
  )
}

function RevokeKeyDialog({
  target,
  name,
  onClose,
  onRevoked,
}: {
  target: DerivedKey | null
  name: string | undefined
  onClose: () => void
  onRevoked: () => void
}) {
  const m = useMutation()
  // Keep showing the key while the dialog animates closed.
  const [shown, setShown] = React.useState<DerivedKey | null>(target)
  if (target && target !== shown) setShown(target)

  const revoke = async () => {
    if (!shown) return
    const ok = await m.run(async () => {
      await api(`/v1/keys/${seg(shown.id)}`, { method: "DELETE" })
      return true
    })
    if (ok) {
      toast.success(`Revoked ${name ? `“${name}”` : shortId(shown.id, 12)}`)
      onRevoked()
      onClose()
    }
  }

  return (
    <AlertDialog
      open={!!target}
      onOpenChange={(o) => {
        if (!o && !m.pending) onClose()
      }}
      onOpenChangeComplete={(o) => {
        if (!o) m.setError(null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>Revoke this key?</AlertDialogTitle>
          <AlertDialogDescription>
            Requests with <span className="font-mono text-xs text-foreground">{shown ? shortId(shown.id, 12) : ""}</span>
            {name ? <> (“{name}”)</> : null} will fail with 401 straight away. This can&apos;t be undone. If it&apos;s the key you signed in with, you&apos;ll be
            signed out.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {m.error ? <p className="text-sm text-destructive">{m.error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={revoke} disabled={m.pending}>
            {m.pending ? <Spinner data-icon="inline-start" /> : null}
            Revoke key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
