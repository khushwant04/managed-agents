"use client"

import * as React from "react"
import { motion } from "motion/react"
import { ChevronFirstIcon, ChevronLastIcon, PauseIcon, PlayIcon, RotateCcwIcon, StepBackIcon, StepForwardIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EASE_OUT } from "@/components/motion"
import { EmptyState } from "@/components/states"
import { JumpToLatest, useFollow } from "@/components/session/follow"
import { Timeline } from "@/components/session/timeline"
import type { ApiEvent } from "@/lib/api"
import { formatDuration, formatTime } from "@/lib/format"
import { nextDelay, recordedOffsetMs, REPLAY_SPEEDS, replaySessionReducer, startReplay, type ReplayAction } from "@/lib/replay"
import { timesBySeq } from "@/lib/session-view"
import { cn } from "@/lib/utils"

/** Re-plays a recorded snapshot of events with a transport bar above the timeline. */
export function ReplayPanel({
  events,
  sessionId,
  agent,
  onExit,
}: {
  events: ApiEvent[]
  sessionId: string
  agent: string | undefined
  onExit: () => void
}) {
  const [state, dispatch] = React.useReducer(replaySessionReducer, events, (evs) => {
    // Start playing straight away: the reader asked for a replay.
    const s = startReplay(evs)
    return replaySessionReducer(s, { type: "play" })
  })
  const { replay, cache } = state
  const total = events.length

  React.useEffect(() => {
    if (!replay.playing) return
    const t = setTimeout(() => dispatch({ type: "tick" }), nextDelay(events, replay.cursor, replay.speed))
    return () => clearTimeout(t)
  }, [replay.playing, replay.cursor, replay.speed, events])

  const times = React.useMemo(() => timesBySeq(events), [events])
  const { setAnchor, showJump, jump } = useFollow({ active: replay.playing, followByDefault: true, tick: cache.timeline.items })

  return (
    <div className="flex flex-col gap-4">
      <TransportBar
        cursor={replay.cursor}
        total={total}
        playing={replay.playing}
        speed={replay.speed}
        events={events}
        dispatch={dispatch}
        onExit={onExit}
      />
      {cache.timeline.items.length === 0 ? (
        <EmptyState
          icon={<PlayIcon />}
          title="Ready to replay"
          description="Press play or step forward to re-run the recorded events."
        />
      ) : (
        <Timeline
          items={cache.timeline.items}
          sessionId={sessionId}
          agent={agent}
          times={times}
          live={replay.cursor < total}
          highlightLast={replay.cursor < total}
        />
      )}
      <div ref={setAnchor} className="scroll-mb-8" />
      <div className="pointer-events-none sticky bottom-6 flex justify-center">
        <JumpToLatest show={showJump} onClick={jump} />
      </div>
    </div>
  )
}

function TransportBar({
  cursor,
  total,
  playing,
  speed,
  events,
  dispatch,
  onExit,
}: {
  cursor: number
  total: number
  playing: boolean
  speed: number
  events: ApiEvent[]
  dispatch: React.Dispatch<ReplayAction>
  onExit: () => void
}) {
  const current = cursor > 0 ? events[cursor - 1] : undefined
  const elapsed = recordedOffsetMs(events, cursor)
  const duration = recordedOffsetMs(events, total)
  const pct = total ? (cursor / total) * 100 : 0
  const atEnd = cursor >= total

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE_OUT }}
      role="group"
      aria-label="Replay controls"
      className="sticky top-14 z-10 flex flex-col gap-2.5 rounded-xl bg-card/90 p-3 shadow-elevated ring-1 ring-foreground/10 backdrop-blur-md"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <IconButton label="Go to start" onClick={() => dispatch({ type: "start" })} disabled={cursor === 0}>
          <ChevronFirstIcon />
        </IconButton>
        <IconButton label="Step back" onClick={() => dispatch({ type: "step", delta: -1 })} disabled={cursor === 0}>
          <StepBackIcon />
        </IconButton>
        <Button size="icon" className="rounded-full" onClick={() => dispatch({ type: "toggle" })} aria-label={playing ? "Pause" : atEnd ? "Replay from start" : "Play"}>
          {playing ? <PauseIcon className="fill-current" /> : atEnd ? <RotateCcwIcon /> : <PlayIcon className="fill-current" />}
        </Button>
        <IconButton label="Step forward" onClick={() => dispatch({ type: "step", delta: 1 })} disabled={atEnd}>
          <StepForwardIcon />
        </IconButton>
        <IconButton label="Go to end" onClick={() => dispatch({ type: "end" })} disabled={atEnd}>
          <ChevronLastIcon />
        </IconButton>
        <div className="ml-1 hidden min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground sm:block">
          {current ? (
            <>
              <span className="text-foreground">#{current.seq}</span> {current.type} · {formatTime(current.ts)}
            </>
          ) : (
            "Not started"
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Select value={String(speed)} onValueChange={(v) => v && dispatch({ type: "speed", speed: Number(v) })}>
            <SelectTrigger size="sm" className="w-20" aria-label="Playback speed">
              <SelectValue>{(v: string) => `${v}×`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {REPLAY_SPEEDS.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}×
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={onExit}>
            <XIcon data-icon="inline-start" />
            Exit replay
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{formatDuration(elapsed)}</span>
        <div className="group/scrub relative flex h-4 flex-1 items-center">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full bg-primary", playing && "transition-[width] duration-150 ease-linear")} style={{ width: `${pct}%` }} />
          </div>
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background shadow-sm ring-2 ring-primary transition-transform group-hover/scrub:scale-110",
              playing && "transition-[left,transform] duration-150 ease-linear"
            )}
            style={{ left: `${pct}%` }}
          />
          <input
            type="range"
            min={0}
            max={total}
            step={1}
            value={cursor}
            onChange={(e) => dispatch({ type: "seek", cursor: Number(e.target.value) })}
            aria-label="Position in recording"
            aria-valuetext={`Event ${cursor} of ${total}`}
            className="absolute inset-0 w-full cursor-pointer opacity-0"
          />
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {cursor}/{total} · {formatDuration(duration)}
        </span>
      </div>
    </motion.div>
  )
}

function IconButton({
  label,
  children,
  ...props
}: { label: string; children: React.ReactNode } & Omit<React.ComponentProps<typeof Button>, "children">) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} {...props} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
