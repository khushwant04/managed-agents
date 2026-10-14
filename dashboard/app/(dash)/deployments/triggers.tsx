/** One-line descriptions of deployment triggers. */
export function describeTrigger(t: Record<string, unknown>): string {
  const type = String(t.type ?? "?");
  switch (type) {
    case "cron":
      return `cron ${String(t.schedule ?? "")}${t.timezone ? ` (${String(t.timezone)})` : ""}`;
    case "webhook":
      return `webhook${t.provider ? ` · ${String(t.provider)}` : ""}`;
    case "queue":
      return `queue ${String(t.name ?? "")}`;
    default:
      return type;
  }
}

export function TriggerBadges({ triggers }: { triggers: Record<string, unknown>[] }) {
  if (triggers.length === 0) return <span className="muted">none</span>;
  return (
    <div className="row">
      {triggers.map((t, i) => (
        <span key={i} className="badge">
          {describeTrigger(t)}
        </span>
      ))}
    </div>
  );
}
