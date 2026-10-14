import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main">
      <h1>Not found</h1>
      <p className="muted">That page doesn&apos;t exist.</p>
      <Link href="/agents">Back to agents</Link>
    </main>
  );
}
