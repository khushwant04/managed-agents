/**
 * Errors raised by the client. Mirrors `agents.client.APIError` in the Python SDK.
 */
import type { ErrorBody } from './types.js';

function asErrorBody(body: unknown): ErrorBody | undefined {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && typeof (body as { error?: unknown }).error === 'string') {
    return body as ErrorBody;
  }
  return undefined;
}

/**
 * A non-2xx response from the server.
 *
 * The server answers every error with an `ErrorBody` (`{error, message?, problems?}`),
 * available typed as `error`. `body` is the raw parsed body: the `ErrorBody`, or the
 * response text when something in between (a proxy, a load balancer) answered instead.
 */
export class APIError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** The server's error body, when the response carried one. */
  readonly error: ErrorBody | undefined;

  constructor(status: number, body: unknown) {
    const error = asErrorBody(body);
    const problems = error?.problems ?? [];
    const detail = error ? error.message || error.error : typeof body === 'string' ? body : JSON.stringify(body);
    super(`${status}: ${detail || 'request failed'}` + (problems.length ? ` (${problems.join('; ')})` : ''));
    this.name = 'APIError';
    this.status = status;
    this.body = body;
    this.error = error;
  }

  /** Validation problems (agent definitions, request bodies), or `[]`. */
  get problems(): string[] {
    return this.error?.problems ?? [];
  }

  /** The machine-readable error code: `not_found`, `conflict`, `invalid_definition`, ... */
  get code(): string | undefined {
    return this.error?.error;
  }
}
