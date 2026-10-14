import type { Metadata } from "next";
import { AgentDetail } from "./agent-detail";

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  return { title: decodeURIComponent((await params).name) };
}

export default async function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <AgentDetail name={decodeURIComponent(name)} />;
}
