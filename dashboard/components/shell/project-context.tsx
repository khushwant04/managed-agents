"use client"

import * as React from "react"

export interface ProjectInfo {
  id: string
  name: string
  role: string
  /** The API server this dashboard is signed in to. */
  server: string
}

const ProjectContext = React.createContext<ProjectInfo | null>(null)

export function ProjectProvider({
  project,
  children,
}: {
  project: ProjectInfo
  children: React.ReactNode
}) {
  return <ProjectContext.Provider value={project}>{children}</ProjectContext.Provider>
}

/** The signed-in project (from the session cookie; no network call). */
export function useProject(): ProjectInfo {
  const p = React.useContext(ProjectContext)
  if (!p) throw new Error("useProject must be used inside the console layout")
  return p
}

const RANK: Record<string, number> = { viewer: 0, developer: 1, admin: 2 }

/** Whether the signed-in key's role is at least `role`. */
export function useCan(role: "viewer" | "developer" | "admin"): boolean {
  return (RANK[useProject().role] ?? 0) >= (RANK[role] ?? 0)
}

/** Sign out through the auth route, then go to the sign-in page. */
export async function signOut() {
  await fetch("/api/auth/signout", { method: "POST", headers: { Accept: "application/json" } }).catch(() => undefined)
  // A full load drops every client cache along with the session.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/signin")
}
