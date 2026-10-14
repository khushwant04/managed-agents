"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { BookOpenIcon, CheckIcon, FileArchiveIcon, FileTextIcon, SearchIcon, UploadCloudIcon, UploadIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CodeBlock } from "@/components/code-block"
import { EASE_OUT, FadeIn } from "@/components/motion"
import { Page, PageHeader } from "@/components/page"
import { EmptyState, ErrorState, TableSkeleton } from "@/components/states"
import { useCan } from "@/components/shell/project-context"
import { MotionRow } from "@/components/deploy/motion-row"
import { useNewDialog } from "@/components/deploy/use-new-param"
import { useApi } from "@/hooks/use-api"
import { useNow } from "@/hooks/use-client"
import type { SkillList } from "@/lib/api"
import { errorMessage, proxyUrl } from "@/lib/client"
import { formatBytes, formatDateTime, timeAgo } from "@/lib/format"
import { prepareSkillBundle, type PreparedBundle } from "@/lib/skill-bundle"
import { cn } from "@/lib/utils"

const MAX_BYTES = 20 * 1024 * 1024

interface Uploaded {
  name: string
  version: string
  description: string
}

export function SkillsView() {
  const canWrite = useCan("developer")
  const now = useNow()
  const { data, error, loading, reload } = useApi<SkillList>("/v1/skills")
  const [uploading, setUploading] = useNewDialog(canWrite)
  const [query, setQuery] = React.useState("")

  const all = data?.skills ?? []
  const q = query.trim().toLowerCase()
  const rows = all.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))

  const uploadButton = canWrite ? (
    <Button onClick={() => setUploading(true)}>
      <UploadIcon data-icon="inline-start" />
      Upload skill
    </Button>
  ) : null

  return (
    <Page>
      <PageHeader
        title="Skills"
        description="Reusable instructions, scripts and resources agents load on demand. Each upload is a new immutable version."
        actions={uploadButton}
      />

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {data && all.length === 0 ? (
        <EmptyState
          icon={<BookOpenIcon />}
          title="No skills yet"
          description="Upload a folder with a SKILL.md at its root, zipped or as a .tar.gz. Agents reference skills by name in their spec."
          action={uploadButton}
        />
      ) : !error ? (
        <FadeIn delay={0.05} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <InputGroup className="sm:max-w-xs">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search skills" />
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
                    <TableHead className="text-xs text-muted-foreground">Description</TableHead>
                    <TableHead className="text-right text-xs text-muted-foreground">Size</TableHead>
                    <TableHead className="pr-4 text-xs text-muted-foreground">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <AnimatePresence initial={false}>
                    {rows.map((s, i) => (
                      <MotionRow key={`${s.name}@${s.version}`} index={i}>
                        <TableCell className="py-3 pl-4">
                          <span className="flex items-center gap-2.5">
                            <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover/row:bg-primary group-hover/row:text-primary-foreground">
                              <BookOpenIcon className="size-3.5" />
                            </span>
                            <span className="font-medium">{s.name}</span>
                          </span>
                        </TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger render={<span />}>
                              <Badge variant="muted" className="font-mono">
                                {s.version.length > 12 ? `${s.version.slice(0, 12)}…` : s.version}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="font-mono">{s.version}</TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="max-w-md truncate text-muted-foreground" title={s.description}>
                          {s.description || "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{formatBytes(s.size_bytes)}</TableCell>
                        <TableCell className="pr-4 text-xs text-muted-foreground" title={formatDateTime(s.created_at)}>
                          {now ? timeAgo(s.created_at, now) : ""}
                        </TableCell>
                      </MotionRow>
                    ))}
                  </AnimatePresence>
                  {data && rows.length === 0 ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                        No skills match “{query}”.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )}
          </Card>
        </FadeIn>
      ) : null}

      <Dialog open={uploading} onOpenChange={setUploading}>
        <DialogContent className="sm:max-w-lg">
          <UploadForm onUploaded={() => reload()} />
        </DialogContent>
      </Dialog>
    </Page>
  )
}

type Picked = { file: File; prepared?: PreparedBundle; error?: string; preparing?: boolean }

function UploadForm({ onUploaded }: { onUploaded: () => void }) {
  const [picked, setPicked] = React.useState<Picked | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState<Uploaded | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const depth = React.useRef(0)

  async function choose(file: File | undefined) {
    if (!file) return
    setError(null)
    if (file.size > MAX_BYTES) {
      setPicked({ file, error: `Bundles are limited to 20 MB (this one is ${formatBytes(file.size)}).` })
      return
    }
    setPicked({ file, preparing: true })
    try {
      const prepared = await prepareSkillBundle(new Uint8Array(await file.arrayBuffer()))
      setPicked({ file, prepared })
    } catch (e) {
      setPicked({ file, error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault()
    if (!picked?.prepared) return
    setPending(true)
    setError(null)
    try {
      // The API takes a gzipped tarball; zips were repacked in prepareSkillBundle.
      const res = await fetch(proxyUrl("/v1/skills"), {
        method: "POST",
        body: picked.prepared.body as BodyInit,
        headers: { "Content-Type": "application/gzip", Accept: "application/json" },
        credentials: "same-origin",
      })
      const text = await res.text()
      let body: unknown = text
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        /* keep text */
      }
      if (!res.ok) throw new Error(errorMessage(res.status, body))
      const skill = body as Uploaded
      setDone(skill)
      onUploaded()
      toast.success(`Uploaded ${skill.name}`, { description: `version ${skill.version.slice(0, 12)}` })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  if (done) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Skill uploaded</DialogTitle>
          <DialogDescription>Reference it from an agent spec by name.</DialogDescription>
        </DialogHeader>
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 rounded-lg bg-success/8 p-3 ring-1 ring-success/20"
        >
          <motion.div
            initial={{ scale: 0.5 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 20 }}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
          >
            <CheckIcon className="size-4" />
          </motion.div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{done.name}</div>
            <code className="block truncate font-mono text-xs text-muted-foreground">{done.version}</code>
            {done.description ? <p className="mt-1 text-xs text-muted-foreground">{done.description}</p> : null}
          </div>
        </motion.div>
        <CodeBlock code={`skills:\n  - name: ${done.name}\n    version: ${done.version}`} label="agent.yaml" />
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </>
    )
  }

  const prepared = picked?.prepared
  return (
    <form onSubmit={upload} className="contents">
      <DialogHeader>
        <DialogTitle>Upload skill</DialogTitle>
        <DialogDescription>
          A .zip (or .tar.gz) of the skill folder with <code className="font-mono">SKILL.md</code> at its root. Its front
          matter supplies the name and description.
        </DialogDescription>
      </DialogHeader>

      <motion.label
        htmlFor="skill-file"
        animate={dragging ? { scale: 1.015 } : { scale: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 28 }}
        onDragEnter={(e) => {
          e.preventDefault()
          depth.current += 1
          setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          depth.current -= 1
          if (depth.current <= 0) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          depth.current = 0
          setDragging(false)
          void choose(e.dataTransfer.files[0])
        }}
        className={cn(
          "relative isolate flex cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-dashed px-6 py-10 text-center transition-colors duration-200",
          dragging ? "border-foreground/40 bg-muted/70" : "hover:border-foreground/25 hover:bg-muted/40"
        )}
      >
        <div className="bg-grid absolute inset-0 -z-10 opacity-60" aria-hidden />
        <motion.div
          animate={dragging ? { y: -4, scale: 1.08 } : { y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 18 }}
          className="flex size-10 items-center justify-center rounded-xl bg-background shadow-card ring-1 ring-foreground/10"
        >
          <UploadCloudIcon className="size-5" />
        </motion.div>
        <div className="text-sm font-medium">{dragging ? "Drop to add" : "Drop a bundle here, or click to browse"}</div>
        <div className="text-xs text-muted-foreground">.zip or .tar.gz · up to 20 MB</div>
        <input
          ref={inputRef}
          id="skill-file"
          type="file"
          accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
          className="sr-only"
          onChange={(e) => void choose(e.target.files?.[0])}
        />
      </motion.label>

      <AnimatePresence initial={false}>
        {picked ? (
          <motion.div
            key={picked.file.name + picked.file.size}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div
              className={cn(
                "flex flex-col gap-2 rounded-lg p-3 ring-1",
                picked.error ? "bg-destructive/6 ring-destructive/20" : "ring-foreground/10"
              )}
            >
              <div className="flex items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <FileArchiveIcon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{picked.file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(picked.file.size)}
                    {prepared?.converted ? ` · repacked as .tar.gz (${formatBytes(prepared.body.length)})` : ""}
                  </div>
                </div>
                {picked.preparing ? <Spinner className="text-muted-foreground" /> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove file"
                  onClick={() => {
                    setPicked(null)
                    if (inputRef.current) inputRef.current.value = ""
                  }}
                >
                  <XIcon />
                </Button>
              </div>
              {picked.error ? <p className="text-xs text-destructive">{picked.error}</p> : null}
              {prepared?.files ? (
                <ul className="flex max-h-28 flex-col gap-0.5 overflow-y-auto pl-11 text-xs text-muted-foreground">
                  {prepared.files.slice(0, 50).map((f) => (
                    <li key={f} className={cn("flex items-center gap-1.5 font-mono", f === "SKILL.md" && "text-foreground")}>
                      <FileTextIcon className="size-3 shrink-0" />
                      <span className="truncate">{f}</span>
                    </li>
                  ))}
                  {prepared.files.length > 50 ? <li>…and {prepared.files.length - 50} more</li> : null}
                </ul>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={!prepared || pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
          Upload
        </Button>
      </DialogFooter>
    </form>
  )
}
