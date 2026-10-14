import type { Metadata } from "next";
import { SessionView } from "./session-view";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return { title: `Session ${decodeURIComponent((await params).id).slice(0, 16)}` };
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = decodeURIComponent(id);
  // Keyed so navigating between sessions (e.g. to a subagent) starts a fresh stream.
  return <SessionView key={sessionId} sessionId={sessionId} />;
}
