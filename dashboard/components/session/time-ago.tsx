"use client"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useNow } from "@/hooks/use-client"
import { formatDateTime, timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Relative time ("5m ago") with the full date in a tooltip. */
export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const now = useNow()
  if (!iso) return <span className={cn("text-muted-foreground", className)}>–</span>
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={iso} className={cn("tabular-nums", className)} />}>
        {now ? timeAgo(iso, Math.max(now, Date.parse(iso))) : " "}
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(iso)}</TooltipContent>
    </Tooltip>
  )
}
