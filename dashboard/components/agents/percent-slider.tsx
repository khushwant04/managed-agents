"use client"

import { Slider } from "@base-ui/react/slider"
import { cn } from "@/lib/utils"

/** 0–100 slider in the console style (track, filled indicator, round thumb). */
export function PercentSlider({
  value,
  onValueChange,
  className,
  "aria-label": ariaLabel,
  indicatorClassName,
}: {
  value: number
  onValueChange: (v: number) => void
  className?: string
  "aria-label"?: string
  indicatorClassName?: string
}) {
  return (
    <Slider.Root
      value={value}
      onValueChange={(v) => onValueChange(Array.isArray(v) ? (v[0] ?? 0) : v)}
      min={0}
      max={100}
      step={1}
      className={cn("w-full touch-none select-none", className)}
    >
      <Slider.Control className="flex h-5 w-full items-center">
        <Slider.Track className="relative h-1.5 w-full rounded-full bg-muted">
          <Slider.Indicator className={cn("rounded-full bg-primary", indicatorClassName)} />
          <Slider.Thumb
            aria-label={ariaLabel}
            className="size-4 rounded-full bg-background shadow-card ring-1 ring-foreground/20 transition-[box-shadow,scale] duration-150 outline-none hover:ring-foreground/40 focus-visible:ring-3 focus-visible:ring-ring/50 data-dragging:scale-110"
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  )
}
