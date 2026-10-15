import { cn } from "@/lib/utils"

/** The Runhive mark: a hexagon cell with three linked agents inside. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-button",
        className
      )}
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden>
        <path
          d="M12 2.75 19.8 7.25v9.5L12 21.25 4.2 16.75v-9.5L12 2.75Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          opacity="0.55"
        />
        <path d="M9 10.2 12 15.4M15 10.2 12 15.4M9 10.2h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.6" />
        <circle cx="9" cy="10.2" r="1.7" fill="currentColor" />
        <circle cx="15" cy="10.2" r="1.7" fill="currentColor" />
        <circle cx="12" cy="15.4" r="1.9" fill="currentColor" />
      </svg>
    </div>
  )
}
