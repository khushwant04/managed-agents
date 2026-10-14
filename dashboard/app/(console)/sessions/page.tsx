import type { Metadata } from "next"
import { SessionsView } from "./sessions-view"

export const metadata: Metadata = { title: "Sessions" }

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string; status?: string; q?: string }>
}) {
  const { agent, status, q } = await searchParams
  return <SessionsView initialAgent={agent ?? ""} initialStatus={status ?? "all"} initialQuery={q ?? ""} />
}
