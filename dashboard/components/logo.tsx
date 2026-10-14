import { cn } from "@/lib/utils"

/** The Managed Agents mark: a node graph in a rounded tile. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-button",
        className
      )}
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden>
        <circle cx="6" cy="7" r="2.25" fill="currentColor" />
        <circle cx="18" cy="7" r="2.25" fill="currentColor" opacity="0.7" />
        <circle cx="12" cy="17.5" r="2.75" fill="currentColor" />
        <path d="M7.6 8.6 10.6 15M16.4 8.6 13.4 15M8.4 7h7.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.55" />
      </svg>
    </div>
  )
}
