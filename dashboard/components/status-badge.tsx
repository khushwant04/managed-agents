import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type Tone = "success" | "warning" | "info" | "destructive" | "muted"

const TONES: Record<string, Tone> = {
  running: "info",
  queued: "info",
  active: "success",
  completed: "success",
  succeeded: "success",
  idle: "muted",
  waiting_input: "warning",
  approval_pending: "warning",
  paused: "warning",
  failed: "destructive",
  error: "destructive",
  terminated: "muted",
  cancelled: "muted",
  deleted: "muted",
}

const DOT: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/60",
}

/** A status pill with a colored dot; in-flight statuses pulse. */
export function StatusBadge({
  status,
  className,
}: {
  status: string | null | undefined
  className?: string
}) {
  const value = status ?? "unknown"
  const tone = TONES[value] ?? "muted"
  const live = value === "running" || value === "queued"
  return (
    <Badge variant={tone} className={cn("gap-1.5 capitalize", className)}>
      <span className="relative flex size-1.5">
        {live ? (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-60",
              DOT[tone]
            )}
          />
        ) : null}
        <span className={cn("relative inline-flex size-1.5 rounded-full", DOT[tone])} />
      </span>
      {value.replaceAll("_", " ")}
    </Badge>
  )
}
