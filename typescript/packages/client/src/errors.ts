/**
 * Errors raised by the client. Mirrors `agents.client.APIError` in the Python SDK.
 */

function describe(body: unknown): string {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    const message = b.message || b.detail || b.error;
    if (message === undefined || message === null || message === '') return 'request failed';
    return typeof message === 'string' ? message : JSON.stringify(message);
  }
  if (typeof body === 'string') return body;
  return body === undefined || body === null ? 'request failed' : JSON.stringify(body);
}

/**
 * A non-2xx response from the server.
 *
 * `body` is the parsed JSON body when the response was JSON, otherwise its text.
 * The server answers errors as `{"error": code, "message": text}`,
 * `{"error": "invalid_definition", "problems": [...]}` for agent definitions that
 * fail validation, or FastAPI's `{"detail": ...}`.
 */
export class APIError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const problems = problemsOf(body);
    super(`${status}: ${describe(body)}` + (problems.length ? ` (${problems.join('; ')})` : ''));
    this.name = 'APIError';
    this.status = status;
    this.body = body;
  }

  /** Validation problems reported by the server (agent definitions), or `[]`. */
  get problems(): string[] {
    return problemsOf(this.body);
  }

  /** The machine-readable error code (`not_found`, `conflict`, ...) when the server sent one. */
  get code(): string | undefined {
    const b = this.body;
    if (b !== null && typeof b === 'object' && typeof (b as Record<string, unknown>).error === 'string') {
      return (b as Record<string, string>).error;
    }
    return undefined;
  }
}

function problemsOf(body: unknown): string[] {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const p = (body as Record<string, unknown>).problems;
    if (Array.isArray(p)) return p.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  }
  return [];
}
