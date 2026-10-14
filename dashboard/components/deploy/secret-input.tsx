"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"

/** Password-type input with a show/hide toggle. */
export function SecretInput({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  const [shown, setShown] = React.useState(false)
  return (
    <InputGroup className={className}>
      <InputGroupInput
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        {...props}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={shown ? "Hide value" : "Show value"}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={shown ? "hide" : "show"}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.15 }}
              className="inline-flex"
            >
              {shown ? <EyeOffIcon /> : <EyeIcon />}
            </motion.span>
          </AnimatePresence>
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
