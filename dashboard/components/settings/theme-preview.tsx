"use client"

import * as React from "react"
import { motion } from "motion/react"
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { useThemeSwitch, type ThemeChoice } from "@/components/theme-toggle"
import { useHydrated } from "@/hooks/use-client"
import { cn } from "@/lib/utils"

/**
 * The light theme's tokens (mirrors `:root` in app/globals.css) so the Light
 * preview stays light while the page is dark. The Dark preview uses `.dark`.
 */
const LIGHT_TOKENS = {
  "--background": "oklch(1 0 0)",
  "--foreground": "oklch(0.145 0 0)",
  "--card": "oklch(1 0 0)",
  "--muted": "oklch(0.97 0 0)",
  "--primary": "oklch(0.205 0 0)",
  "--sidebar": "oklch(0.985 0 0)",
  "--border": "oklch(0.922 0 0)",
  "--chart-1": "oklch(0.87 0 0)",
  "--chart-2": "oklch(0.556 0 0)",
} as React.CSSProperties

const BARS = [38, 62, 46, 80, 56, 92, 70]

/** A tiny console: sidebar, header and a card with a bar chart. */
function MiniConsole({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div className={cn("absolute inset-0 flex bg-sidebar p-1.5 text-foreground", className)} style={style} aria-hidden>
      <div className="flex w-[26%] flex-col gap-1.5 p-1.5">
        <div className="mb-1 flex items-center gap-1">
          <span className="size-2.5 rounded-[3px] bg-primary" />
          <span className="h-1.5 w-8 rounded-full bg-foreground/70" />
        </div>
        {[70, 85, 60, 75, 55].map((w, i) => (
          <span
            key={i}
            className={cn("h-1.5 rounded-full", i === 1 ? "bg-foreground/60" : "bg-foreground/15")}
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 rounded-md bg-background p-2 ring-1 ring-border">
        <div className="flex items-center justify-between">
          <span className="h-2 w-12 rounded-full bg-foreground/80" />
          <span className="h-2.5 w-6 rounded-[3px] bg-primary" />
        </div>
        <div className="grid grid-cols-3 gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1 rounded-[4px] bg-card p-1 ring-1 ring-border">
              <span className="h-1 w-3/5 rounded-full bg-foreground/25" />
              <span className="h-1.5 w-2/5 rounded-full bg-foreground/70" />
            </div>
          ))}
        </div>
        <div className="flex flex-1 items-end gap-[3px] rounded-[4px] bg-card p-1.5 ring-1 ring-border">
          {BARS.map((h, i) => (
            <span key={i} className="flex flex-1 flex-col justify-end gap-px" style={{ height: `${h}%` }}>
              <span className="flex-[2] rounded-t-[2px] bg-foreground/85" />
              <span className="flex-[3] bg-chart-2" />
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

const OPTIONS: { value: ThemeChoice; label: string; hint: string; icon: React.ElementType }[] = [
  { value: "system", label: "System", hint: "Match your device", icon: MonitorIcon },
  { value: "light", label: "Light", hint: "Bright and crisp", icon: SunIcon },
  { value: "dark", label: "Dark", hint: "Easy on the eyes", icon: MoonIcon },
]

function Preview({ value }: { value: ThemeChoice }) {
  if (value === "light") return <MiniConsole style={LIGHT_TOKENS} />
  if (value === "dark") return <MiniConsole className="dark" />
  return (
    <>
      <MiniConsole style={LIGHT_TOKENS} />
      <MiniConsole className="dark" style={{ clipPath: "polygon(58% 0, 100% 0, 100% 100%, 42% 100%)" }} />
    </>
  )
}

/** Three large selectable previews; picking one reveals the theme from the click point. */
export function ThemePreviewCards() {
  const { theme, switchTo } = useThemeSwitch()
  const hydrated = useHydrated()
  const current = hydrated ? theme : undefined

  return (
    <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
      {OPTIONS.map((o) => {
        const active = current === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={(e) => switchTo(o.value, { x: e.clientX, y: e.clientY })}
            className={cn(
              "group/theme relative flex flex-col gap-2.5 rounded-xl p-1.5 pb-3 text-left ring-1 ring-foreground/10 transition-[box-shadow,transform,background-color] duration-300 ease-(--ease-out-quint) outline-none hover:-translate-y-0.5 hover:shadow-card-hover focus-visible:ring-3 focus-visible:ring-ring/50",
              active && "bg-muted/50"
            )}
          >
            {active ? (
              <motion.span
                layoutId="theme-card-ring"
                className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-foreground"
                transition={{ type: "spring", bounce: 0.18, duration: 0.45 }}
              />
            ) : null}
            <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg ring-1 ring-foreground/10">
              <Preview value={o.value} />
            </div>
            <div className="flex items-center gap-2 px-1.5">
              <o.icon className="size-4 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.hint}</span>
              </div>
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full ring-1 transition-colors duration-200",
                  active ? "bg-foreground text-background ring-foreground" : "ring-foreground/20"
                )}
              >
                {active ? (
                  <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", bounce: 0.5, duration: 0.4 }}>
                    <CheckIcon className="size-3" strokeWidth={3} />
                  </motion.span>
                ) : null}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
