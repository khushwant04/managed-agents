import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type Variant = "success" | "destructive" | "info" | "warning" | "muted"

const VERBS: Record<string, Variant> = {
  create: "success",
  register: "success",
  write: "success",
  upload: "success",
  put: "success",
  delete: "destructive",
  revoke: "destructive",
  update: "info",
  move: "info",
  policy: "info",
  read: "warning",
}

/** Badge tone for an audit action like `key.revoke` (by its verb) or `tool.approval` (by outcome). */
export function actionVariant(action: string, details?: Record<string, unknown>): Variant {
  if (action === "tool.approval") return details?.approved === false ? "destructive" : "success"
  const verb = action.split(".").at(-1) ?? action
  return VERBS[verb] ?? "muted"
}

export function ActionBadge({
  action,
  details,
  className,
}: {
  action: string
  details?: Record<string, unknown>
  className?: string
}) {
  return (
    <Badge variant={actionVariant(action, details)} className={cn("rounded-md font-mono text-[11px]", className)}>
      {action}
    </Badge>
  )
}
