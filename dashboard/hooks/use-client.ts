import * as React from "react"

const noop = () => () => {}

/** False during server rendering and hydration, true afterwards. */
export function useHydrated(): boolean {
  return React.useSyncExternalStore(noop, () => true, () => false)
}

function subscribeMinute(onChange: () => void) {
  const id = setInterval(onChange, 30_000)
  return () => clearInterval(id)
}

/** Wall-clock time rounded to the minute (0 on the server), re-rendering as minutes pass. */
export function useNow(): number {
  return React.useSyncExternalStore(
    subscribeMinute,
    () => Math.floor(Date.now() / 60_000) * 60_000,
    () => 0
  )
}
