"use client"

import * as React from "react"

const EVENT = "ma:stored-choice"
/** Fallback when storage is blocked, so the choice still holds for this page view. */
const memory = new Map<string, string>()

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null
  } catch {
    return memory.get(key) ?? null
  }
}

/**
 * A small enum preference remembered in localStorage (per browser). Falls back
 * to `initial` on the server, during hydration and when storage is blocked.
 */
export function useStoredChoice<T extends string>(
  key: string,
  options: readonly T[],
  initial: T
): [T, (v: T) => void] {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const handler = (e: Event) => {
        if (e instanceof StorageEvent ? e.key === key : (e as CustomEvent<string>).detail === key) onChange()
      }
      window.addEventListener("storage", handler)
      window.addEventListener(EVENT, handler)
      return () => {
        window.removeEventListener("storage", handler)
        window.removeEventListener(EVENT, handler)
      }
    },
    [key]
  )
  const raw = React.useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null
  )
  const value = raw !== null && (options as readonly string[]).includes(raw) ? (raw as T) : initial
  const set = React.useCallback(
    (v: T) => {
      memory.set(key, v)
      try {
        window.localStorage.setItem(key, v)
      } catch {
        // storage blocked: the in-memory copy still applies
      }
      window.dispatchEvent(new CustomEvent(EVENT, { detail: key }))
    },
    [key]
  )
  return [value, set]
}
