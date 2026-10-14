"use client"

import * as React from "react"

/**
 * The API doesn't return key names after creation (the audit log only records
 * the role), so this browser remembers the names of keys created here.
 */
const STORAGE_KEY = "ma.api-key-names"
const EVENT = "ma:api-key-names"

function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange)
  window.addEventListener(EVENT, onChange)
  return () => {
    window.removeEventListener("storage", onChange)
    window.removeEventListener(EVENT, onChange)
  }
}

export function rememberKeyName(id: string, name: string) {
  try {
    const all = JSON.parse(read() ?? "{}") as Record<string, string>
    all[id] = name
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Storage blocked: names just won't be remembered.
  }
  window.dispatchEvent(new Event(EVENT))
}

export function useKeyNames(): Record<string, string> {
  const raw = React.useSyncExternalStore(subscribe, read, () => null)
  return React.useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(raw ?? "{}")
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
    } catch {
      return {}
    }
  }, [raw])
}
