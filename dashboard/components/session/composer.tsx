"use client"

import * as React from "react"
import { ArrowUpIcon, CornerDownLeftIcon } from "lucide-react"
import { toast } from "sonner"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { useMutation } from "@/hooks/use-api"
import type { SessionEventBody, SessionEventResult } from "@/lib/api"
import { api, seg } from "@/lib/client"
import { isActiveStatus } from "@/lib/session-view"

/** Message box under the timeline: sends a user message, or steers the running turn. */
export function Composer({ sessionId, status, onSent }: { sessionId: string; status: string | null; onSent?: () => void }) {
  const [text, setText] = React.useState("")
  const send = useMutation()
  const running = isActiveStatus(status)

  async function submit(e?: React.FormEvent) {
    e?.preventDefault()
    const body = text.trim()
    if (!body || send.pending) return
    const message: SessionEventBody = { type: "message.user", text: body }
    const res = await send.run(() =>
      api<SessionEventResult>(`/v1/sessions/${seg(sessionId)}/events`, { method: "POST", json: message })
    )
    if (res) {
      setText("")
      toast.success(res.steered ? "Sent to the running turn" : res.resumed ? "Session resumed" : "Message sent")
      onSent?.()
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <InputGroup className="rounded-xl bg-card shadow-elevated dark:bg-card">
        <InputGroupTextarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (send.error) send.setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={running ? "Steer the running turn…" : "Send a message to the agent…"}
          aria-label="Message"
          aria-invalid={send.error ? true : undefined}
          className="max-h-48 min-h-14 px-3.5 pt-3 text-sm"
        />
        <InputGroupAddon align="block-end" className="gap-2 px-3 pb-2.5">
          <span className="hidden items-center gap-1.5 text-xs font-normal text-muted-foreground sm:flex">
            <KbdGroup>
              <Kbd>Ctrl</Kbd>
              <Kbd>
                <CornerDownLeftIcon />
              </Kbd>
            </KbdGroup>
            to send
          </span>
          <InputGroupButton
            type="submit"
            variant="default"
            size="sm"
            className="ml-auto h-7 rounded-lg px-2.5"
            disabled={!text.trim() || send.pending}
          >
            {send.pending ? <Spinner className="size-3.5" /> : <ArrowUpIcon className="size-3.5" />}
            {running ? "Steer" : "Send"}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {send.error ? (
        <p role="alert" className="px-1 text-xs text-destructive">
          {send.error}
        </p>
      ) : null}
    </form>
  )
}
