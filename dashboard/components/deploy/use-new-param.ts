"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

/**
 * Open state for a page's create dialog that also opens on `?new=1` (the ⌘K
 * actions link there). Closing drops the query so a refresh doesn't reopen it.
 */
export function useNewDialog(allowed: boolean): [boolean, (open: boolean) => void] {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = React.useState(false)
  const wantsNew = allowed && params.get("new") === "1"

  const change = React.useCallback(
    (next: boolean) => {
      setOpen(next)
      if (!next && params.get("new") !== null) router.replace(pathname, { scroll: false })
    },
    [params, pathname, router]
  )
  return [open || wantsNew, change]
}
