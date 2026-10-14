"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowDownIcon } from "lucide-react"
import { EASE_OUT } from "@/components/motion"

/** How close (px) the end of the timeline must be to the viewport bottom to count as "at the bottom". */
const SLACK = 220

/**
 * Keeps the window scrolled to the end of a growing timeline. Place the
 * returned `setAnchor` as the ref of an element after the last item. `atBottom` is null until the
 * reader scrolls; until then `followByDefault` decides (e.g. a running session).
 */
export function useFollow({ active, followByDefault, tick }: { active: boolean; followByDefault: boolean; tick: unknown }) {
  // A callback ref kept in state, so the returned values are plain render data.
  const [node, setAnchor] = React.useState<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = React.useState<boolean | null>(null)
  const following = active && (atBottom ?? followByDefault)

  React.useEffect(() => {
    if (!node) return
    const onScroll = () => setAtBottom(node.getBoundingClientRect().top - window.innerHeight < SLACK)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [node])

  React.useEffect(() => {
    if (following) node?.scrollIntoView({ block: "end", behavior: "smooth" })
  }, [following, node, tick])

  const jump = React.useCallback(() => {
    setAtBottom(true)
    node?.scrollIntoView({ block: "end", behavior: "smooth" })
  }, [node])

  // The pill only matters while something is in flight (a running session, a playing replay).
  return { setAnchor, following, showJump: active && followByDefault && atBottom === false, jump }
}

/** Floating "Jump to latest" pill, shown while the reader is scrolled up. */
export function JumpToLatest({ show, onClick }: { show: boolean; onClick: () => void }) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.button
          type="button"
          onClick={onClick}
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.96 }}
          transition={{ duration: 0.25, ease: EASE_OUT }}
          className="pointer-events-auto mx-auto flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-elevated transition-colors hover:bg-foreground/90"
        >
          <ArrowDownIcon className="size-3.5" />
          Jump to latest
        </motion.button>
      ) : null}
    </AnimatePresence>
  )
}
