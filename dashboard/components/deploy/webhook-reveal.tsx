"use client"

import * as React from "react"
import { motion } from "motion/react"
import { CheckIcon, ShieldAlertIcon } from "lucide-react"
import { CopyButton } from "@/components/copy-button"
import { EASE_OUT } from "@/components/motion"
import { cn } from "@/lib/utils"

/** A labelled, monospace, copyable value. */
export function CopyField({
  label,
  value,
  masked,
  className,
}: {
  label: React.ReactNode
  value: string
  masked?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex min-w-0 items-center gap-1 rounded-lg bg-muted/60 py-1 pr-1 pl-3 ring-1 ring-foreground/8">
        <code className={cn("min-w-0 flex-1 truncate font-mono text-xs", masked && "blur-[3px] transition-[filter] hover:blur-none")}>
          {value}
        </code>
        <CopyButton value={value} size="icon-xs" label={`Copy ${typeof label === "string" ? label.toLowerCase() : "value"}`} />
      </div>
    </div>
  )
}

/** Shown once after creating a deployment with a webhook trigger: the URL and its signing secret. */
export function WebhookReveal({
  name,
  url,
  secret,
}: {
  name: string
  url: string
  secret?: string | null
}) {
  return (
    <div className="flex flex-col gap-4">
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 380, damping: 22 }}
        className="flex size-10 items-center justify-center rounded-full bg-success/12 text-success"
      >
        <CheckIcon className="size-5" />
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE_OUT, delay: 0.08 }}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{name}</span> is live. Point your provider at this URL and sign
          deliveries with the secret.
        </p>
        <CopyField label="Endpoint URL" value={url} />
        {secret ? <CopyField label="Signing secret" value={secret} masked /> : null}
        {secret ? (
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-xs text-warning ring-1 ring-warning/20">
            <ShieldAlertIcon className="mt-px size-3.5 shrink-0" />
            <span>Copy the secret now. It is stored encrypted and never shown again.</span>
          </div>
        ) : null}
      </motion.div>
    </div>
  )
}
