"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client";

type Query = Record<string, string | number | boolean | null | undefined>;

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | Error | undefined;
  loading: boolean;
  reload: () => void;
  /** Replace the data locally (e.g. with a mutation's response). */
  setData: (data: T) => void;
}

/**
 * GET an API path through the proxy. `path = null` skips the request.
 * Loading is derived from which request the current result belongs to, so the
 * effect never sets state synchronously.
 */
export function useApi<T>(path: string | null, query?: Query): ApiState<T> {
  const qs = JSON.stringify(query ?? {});
  const [nonce, setNonce] = useState(0);
  const key = path ? `${path}?${qs}#${nonce}` : null;
  const [result, setResult] = useState<{ key: string | null; path: string | null; data?: T; error?: ApiError | Error }>({ key: null, path: null });

  useEffect(() => {
    if (!path || !key) return;
    const ctrl = new AbortController();
    api<T>(path, { query: JSON.parse(qs) as Query, signal: ctrl.signal }).then(
      (data) => setResult({ key, path, data }),
      (error: unknown) => {
        if (!ctrl.signal.aborted) setResult({ key, path, error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => ctrl.abort();
  }, [path, qs, key]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((data: T) => setResult((r) => ({ ...r, data, error: undefined })), []);

  // Keep showing the previous data for the same path while reloading.
  const samePath = result.path === path;
  return {
    data: samePath ? result.data : undefined,
    error: result.key === key ? result.error : undefined,
    loading: key !== null && result.key !== key,
    reload,
    setData,
  };
}

/** Run a mutation with pending/error state. */
export function useMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, error, setError, run };
}
