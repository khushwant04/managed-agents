"use client"

import * as React from "react"
import { motion, type HTMLMotionProps } from "motion/react"
import { ChevronRightIcon } from "lucide-react"
import { EASE_OUT } from "@/components/motion"
import { cn } from "@/lib/utils"

/** A table row that fades in with a small per-index delay (capped), like TableRow otherwise. */
export function MotionRow({
  index = 0,
  className,
  ...props
}: HTMLMotionProps<"tr"> & { index?: number }) {
  return (
    <motion.tr
      data-slot="table-row"
      layout="position"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: EASE_OUT, delay: Math.min(index, 12) * 0.03 }}
      className={cn(
        "group/row border-b transition-colors duration-200 hover:bg-muted/50",
        props.onClick ? "cursor-pointer" : "",
        className
      )}
      {...props}
    />
  )
}

/** Trailing chevron that appears when its row is hovered. */
export function RowChevron() {
  return (
    <ChevronRightIcon className="size-4 -translate-x-1 text-muted-foreground opacity-0 transition-[opacity,transform] duration-200 group-hover/row:translate-x-0 group-hover/row:opacity-100" />
  )
}

/** Keyboard + mouse navigation props for a clickable row (links inside still work). */
export function rowLink(go: () => void) {
  return {
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("a,button,[role=checkbox],[role=menuitem]")) return
      go()
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && e.target === e.currentTarget) go()
    },
    tabIndex: 0,
  }
}
