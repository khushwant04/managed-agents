import { cn } from "@/lib/utils"
import { CopyButton } from "@/components/copy-button"

/** Monospace block with a copy button, for snippets, specs and payloads. */
export function CodeBlock({
  code,
  className,
  label,
  wrap = false,
}: {
  code: string
  className?: string
  label?: React.ReactNode
  wrap?: boolean
}) {
  return (
    <div
      className={cn(
        "group/code relative overflow-hidden rounded-lg bg-muted/50 ring-1 ring-foreground/8",
        className
      )}
    >
      {label ? (
        <div className="flex h-9 items-center justify-between border-b px-3 text-xs text-muted-foreground">
          {label}
          <CopyButton value={code} size="icon-xs" />
        </div>
      ) : (
        <CopyButton
          value={code}
          size="icon-xs"
          className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
        />
      )}
      <pre
        className={cn(
          "max-h-[32rem] overflow-auto p-3 font-mono text-xs leading-relaxed",
          wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre"
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}
