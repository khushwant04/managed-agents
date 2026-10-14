"use client"

import * as React from "react"
import type { ApiEvent, InvokeAccepted } from "@/lib/api"
import { api, onUnauthenticated, proxyUrl, seg } from "@/lib/client"
import { eventFromMessage, SSEParser } from "@/lib/sse"
import { applyEvents, emptyTimeline, type TimelineState } from "@/lib/timeline"

export type RunPhase = "idle" | "starting" | "streaming" | "settled" | "error"

export interface RunState {
  phase: RunPhase
  target: string | null
  input: string
  accepted: InvokeAccepted | null
  timeline: TimelineState
  error: string | null
  stopping: boolean
}

const IDLE: RunState = {
  phase: "idle",
  target: null,
  input: "",
  accepted: null,
  timeline: emptyTimeline(),
  error: null,
  stopping: false,
}

const FLUSH_MS = 40
const MAX_RETRIES = 4

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(t)
      resolve()
    })
  })
}

/**
 * Invoke an agent asynchronously, then follow its session stream until the
 * run settles. Events are batched into the timeline view model.
 */
export function useAgentRun() {
  const [state, setState] = React.useState<RunState>(IDLE)
  const ctrl = React.useRef<AbortController | null>(null)

  React.useEffect(() => () => ctrl.current?.abort(), [])

  const follow = React.useCallback(async (sessionId: string, signal: AbortSignal) => {
    let lastSeq = 0
    let pending: ApiEvent[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      const batch = pending
      pending = []
      if (!batch.length || signal.aborted) return
      setState((s) => ({ ...s, timeline: applyEvents(s.timeline, batch) }))
    }

    for (let attempt = 0; attempt <= MAX_RETRIES && !signal.aborted; attempt++) {
      try {
        const res = await fetch(proxyUrl(`/v1/sessions/${seg(sessionId)}/stream`, { after: lastSeq, until_settled: true }), {
          headers: { Accept: "text/event-stream" },
          cache: "no-store",
          signal,
        })
        if (res.status === 401) {
          onUnauthenticated()
          return
        }
        if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`)
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        const parser = new SSEParser()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          for (const msg of parser.feed(value)) {
            const ev = eventFromMessage(msg)
            if (!ev) continue
            lastSeq = Math.max(lastSeq, ev.seq)
            pending.push(ev)
          }
          timer ??= setTimeout(flush, FLUSH_MS)
        }
        if (timer) clearTimeout(timer)
        flush()
        // until_settled closes the stream once the run is done.
        setState((s) => (s.accepted?.session_id === sessionId ? { ...s, phase: "settled", stopping: false } : s))
        return
      } catch (e) {
        if (signal.aborted) return
        if (attempt === MAX_RETRIES) {
          if (timer) clearTimeout(timer)
          flush()
          setState((s) => ({ ...s, phase: "error", error: e instanceof Error ? e.message : String(e), stopping: false }))
          return
        }
        await sleep(400 * 2 ** attempt, signal)
      }
    }
  }, [])

  const run = React.useCallback(
    async (target: string, input: string) => {
      ctrl.current?.abort()
      const c = new AbortController()
      ctrl.current = c
      setState({ ...IDLE, phase: "starting", target, input, timeline: emptyTimeline() })
      let accepted: InvokeAccepted
      try {
        accepted = await api<InvokeAccepted>(`/v1/agents/${seg(target)}/invoke`, {
          method: "POST",
          json: { input, mode: "async" },
          signal: c.signal,
        })
      } catch (e) {
        if (c.signal.aborted) return
        setState((s) => ({ ...s, phase: "error", error: e instanceof Error ? e.message : String(e) }))
        return
      }
      if (c.signal.aborted) return
      setState((s) => ({ ...s, phase: "streaming", accepted }))
      await follow(accepted.session_id, c.signal)
    },
    [follow]
  )

  const stop = React.useCallback(async () => {
    const id = state.accepted?.session_id
    if (!id) {
      ctrl.current?.abort()
      setState(IDLE)
      return
    }
    setState((s) => ({ ...s, stopping: true }))
    try {
      await api(`/v1/sessions/${seg(id)}/interrupt`, { method: "POST" })
    } catch (e) {
      setState((s) => ({ ...s, stopping: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [state.accepted])

  const reset = React.useCallback(() => {
    ctrl.current?.abort()
    setState(IDLE)
  }, [])

  return { state, run, stop, reset }
}
