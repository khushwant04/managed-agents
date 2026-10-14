import type { Metadata } from "next"
import { AgentView } from "./agent-view"

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const { name } = await params
  return { title: decodeURIComponent(name) }
}

export default async function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  return <AgentView name={decodeURIComponent(name)} />
}
