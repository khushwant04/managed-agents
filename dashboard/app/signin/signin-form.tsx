"use client";

import { useState, type FormEvent } from "react";

export function SignInForm({ defaultUrl, allowed, next }: { defaultUrl: string; allowed: string[]; next: string }) {
  const [apiKey, setApiKey] = useState("");
  const [serverUrl, setServerUrl] = useState(defaultUrl);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, serverUrl: serverUrl === defaultUrl ? "" : serverUrl }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `sign-in failed (${res.status})`);
        return;
      }
      window.location.assign(next);
    } catch {
      setError("could not reach the dashboard server");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {error ? (
        <div className="banner error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="api-key">API key</label>
        <input
          id="api-key"
          name="api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="ak_…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoFocus
        />
      </div>
      <div className="field">
        <label htmlFor="server-url">
          Server <span className="hint">{allowed.length > 1 ? "(one of the servers this dashboard allows)" : "(set by AGENTS_API_URL)"}</span>
        </label>
        {allowed.length > 1 ? (
          <select id="server-url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)}>
            {allowed.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        ) : (
          <input id="server-url" type="url" value={serverUrl} readOnly aria-readonly="true" />
        )}
      </div>
      <button type="submit" className="btn btn-primary" disabled={pending || !apiKey.trim()}>
        {pending ? "Checking key…" : "Sign in"}
      </button>
    </form>
  );
}
