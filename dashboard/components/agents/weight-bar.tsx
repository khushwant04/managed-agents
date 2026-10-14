"use client"

import { motion } from "motion/react"
import { EASE_OUT } from "@/components/motion"
import { weightOf } from "@/lib/alias"
import type { VersionWeight } from "@/lib/api"
import { cn } from "@/lib/utils"

const FILLS = ["bg-info", "bg-success", "bg-warning", "bg-chart-2", "bg-chart-4"]

/** A stable colour per version number, so v2 looks the same in every bar. */
export function versionFill(version: number): string {
  return FILLS[(version - 1) % FILLS.length]!
}

/** Traffic split as a segmented bar whose segments grow in. */
export function WeightBar({
  versions,
  className,
  legend = true,
  delay = 0,
}: {
  versions: readonly VersionWeight[]
  className?: string
  legend?: boolean
  delay?: number
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div
        className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={versions.map((v) => `v${v.version} ${weightOf(v)}%`).join(", ")}
      >
        {versions.map((v, i) => (
          <motion.div
            key={v.version}
            className={cn("h-full rounded-full", versionFill(v.version))}
            initial={{ width: 0 }}
            animate={{ width: `${weightOf(v)}%` }}
            transition={{ duration: 0.7, ease: EASE_OUT, delay: delay + i * 0.08 }}
          />
        ))}
      </div>
      {legend ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {versions.map((v) => (
            <span key={v.version} className="inline-flex items-center gap-1.5 tabular-nums">
              <span className={cn("size-1.5 rounded-full", versionFill(v.version))} />
              <span className="font-medium text-foreground">v{v.version}</span>
              {weightOf(v)}%
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
