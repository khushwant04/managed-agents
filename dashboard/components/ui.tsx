"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/client";
import { formatDateTime, toDisplay } from "@/lib/format";

const STATUS_TONE: Record<string, string> = {
  running: "info",
  queued: "info",
  active: "ok",
  idle: "ok",
  end_turn: "ok",
  approval_pending: "warn",
  waiting_input: "warn",
  needs_input: "warn",
  paused: "warn",
  budget: "warn",
  interrupted: "warn",
  failed: "danger",
  error: "danger",
  terminated: "",
  deleted: "",
};

export function StatusBadge({ status, live = false }: { status: string | null | undefined; live?: boolean }) {
  const s = status ?? "unknown";
  const tone = STATUS_TONE[s] ?? "";
  return (
    <span className={`badge ${tone} ${live ? "live" : ""}`}>
      <span className="dot" aria-hidden="true" />
      {s.replace(/_/g, " ")}
    </span>
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  const status = error instanceof ApiError ? error.status : undefined;
  return (
    <div className="banner error row" role="alert">
      <span>
        {status ? <strong>{status}: </strong> : null}
        {msg}
      </span>
      {onRetry ? (
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </>
      ) : null}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="muted" role="status" aria-live="polite">
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Time({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="muted">–</span>;
  return (
    <time dateTime={iso} title={iso} className="nowrap">
      {formatDateTime(iso)}
    </time>
  );
}

export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  return (
    <pre className="json" aria-label={label} tabIndex={0}>
      {toDisplay(value)}
    </pre>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable (insecure context) */
        }
      }}
    >
      {copied ? "Copied" : label}
      <span className="visually-hidden" aria-live="polite">
        {copied ? "copied to clipboard" : ""}
      </span>
    </button>
  );
}

export function WeightBar({ versions }: { versions: { version: number; weight?: number }[] }) {
  return (
    <div className="weights" role="img" aria-label={versions.map((v) => `version ${v.version}: ${v.weight ?? 100}%`).join(", ")}>
      {versions.map((v) => (
        <span key={v.version} style={{ width: `${v.weight ?? 100}%` }} title={`v${v.version} ${v.weight ?? 100}%`} />
      ))}
    </div>
  );
}

export function PageHead({ title, description, crumbs, actions }: { title: ReactNode; description?: ReactNode; crumbs?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumbs ? <nav className="crumbs" aria-label="Breadcrumb">{crumbs}</nav> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}
