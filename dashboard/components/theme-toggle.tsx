"use client"

import * as React from "react"
import { flushSync } from "react-dom"
import { useTheme } from "next-themes"
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { motion } from "motion/react"
import { cn } from "@/lib/utils"
import { useHydrated } from "@/hooks/use-client"

export type ThemeChoice = "system" | "light" | "dark"

/**
 * Switch themes with a circular reveal from the point that was clicked
 * (View Transitions API), falling back to an instant switch.
 */
export function useThemeSwitch() {
  const { theme, setTheme } = useTheme()
  const switchTo = React.useCallback(
    (next: ThemeChoice, origin?: { x: number; y: number }) => {
      const doc = document as Document & {
        startViewTransition?: (cb: () => void) => unknown
      }
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      if (!doc.startViewTransition || reduce) {
        setTheme(next)
        return
      }
      const x = origin?.x ?? window.innerWidth / 2
      const y = origin?.y ?? 0
      const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
      const root = document.documentElement
      root.style.setProperty("--theme-x", `${x}px`)
      root.style.setProperty("--theme-y", `${y}px`)
      root.style.setProperty("--theme-r", `${r}px`)
      doc.startViewTransition(() => flushSync(() => setTheme(next)))
    },
    [setTheme]
  )
  return { theme: (theme ?? "system") as ThemeChoice, switchTo }
}

const OPTIONS: { value: ThemeChoice; label: string; icon: React.ElementType }[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
]

/** Segmented system/light/dark control with a sliding thumb. */
export function ThemeSegmented({ className }: { className?: string }) {
  const { theme, switchTo } = useThemeSwitch()
  // The stored theme is only known on the client.
  const current = useHydrated() ? theme : undefined
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn("inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5", className)}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = current === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={(e) => switchTo(value, { x: e.clientX, y: e.clientY })}
            className={cn(
              "relative inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              active && "text-foreground"
            )}
          >
            {active ? (
              <motion.span
                layoutId="theme-thumb"
                className="absolute inset-0 rounded-md bg-background shadow-sm dark:bg-input/50"
                transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
              />
            ) : null}
            <Icon className="relative size-3.5" />
          </button>
        )
      })}
    </div>
  )
}
