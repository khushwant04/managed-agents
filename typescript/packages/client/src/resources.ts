import type { Client } from './client.js';
import { encodeSegment } from './util.js';
import { RemoteSession } from './session.js';
import type {
  AgentCard,
  AgentSpec,
  AgentSummary,
  AgentVersion,
  AliasInfo,
  AliasResult,
  Artifact,
  Deployment,
  DeploymentCreate,
  Environment,
  InterruptResult,
  RegisterResult,
  SecretInfo,
  SecretWritten,
  Session,
  SessionEventResult,
  SessionSummary,
  VersionSummary,
  VersionWeight,
} from './types.js';

abstract class Resource {
  protected readonly c: Client;
  constructor(client: Client) {
    this.c = client;
  }
}

export interface AgentFilters {
  tag?: string;
  owner?: string;
  capability?: string;
}

/** `{ 14: 90, 15: 10 }` (version → weight) or the API's list form. */
export type AliasVersions = Record<number, number> | VersionWeight[];

export class Agents extends Resource {
  /** Register an agent definition. Re-registering an identical spec returns the existing version (`created: false`). */
  register(spec: AgentSpec): Promise<RegisterResult> {
    return this.c.call('post', '/v1/agents', { body: spec });
  }

  async versions(name: string): Promise<VersionSummary[]> {
    return (await this.c.call('get', '/v1/agents/{name}/versions', { path: { name } })).versions;
  }

  get(name: string, version: number): Promise<AgentVersion> {
    return this.c.call('get', '/v1/agents/{name}/versions/{version}', { path: { name, version } });
  }

  async search(q?: string, filters: AgentFilters = {}): Promise<AgentSummary[]> {
    const query = Object.fromEntries(Object.entries({ q, ...filters }).filter(([, v]) => v !== undefined && v !== null));
    return (await this.c.call('get', '/v1/agents', { query })).agents;
  }

  /** Point `alias` at weighted versions: `setAlias('bot', 'prod', { 14: 90, 15: 10 })`. */
  setAlias(name: string, alias: string, versions: AliasVersions): Promise<AliasResult> {
    const items: VersionWeight[] = Array.isArray(versions)
      ? versions
      : Object.entries(versions).map(([version, weight]) => ({ version: Number(version), weight: Number(weight) }));
    return this.c.call('put', '/v1/agents/{name}/aliases/{alias}', { path: { name, alias }, body: { versions: items } });
  }

  /** Send all traffic on `alias` to `version`. */
  promote(name: string, version: number, alias = 'prod'): Promise<AliasResult> {
    return this.setAlias(name, alias, { [version]: 100 });
  }

  /** Send `percent` of new sessions on `alias` to `version`; the rest stay on its current version. */
  async canary(name: string, version: number, percent: number, alias = 'prod'): Promise<AliasResult> {
    const current = (await this.aliases(name)).find((a) => a.alias === alias);
    if (!current || current.versions.length === 0) {
      throw new Error(`${name} has no alias '${alias}' yet; promote a version first`);
    }
    const base = current.versions.reduce((a, b) => ((b.weight ?? 100) > (a.weight ?? 100) ? b : a)).version;
    return this.setAlias(name, alias, { [base]: 100 - percent, [version]: percent });
  }

  /** Restore the alias's previous routing. */
  rollback(name: string, alias = 'prod'): Promise<AliasResult> {
    return this.c.call('post', '/v1/agents/{name}/aliases/{alias}/rollback', { path: { name, alias } });
  }

  async aliases(name: string): Promise<AliasInfo[]> {
    return (await this.c.call('get', '/v1/agents/{name}/aliases', { path: { name } })).aliases;
  }

  /** The agent card for `name` or `name@alias`. */
  card(target: string): Promise<AgentCard> {
    return this.c.call('get', '/v1/agents/{target}/card', { path: { target } });
  }
}

export class Deployments extends Resource {
  create(agent: string, options: DeploymentCreate = {}): Promise<Deployment> {
    const body: Record<string, unknown> = {
      agent,
      alias: options.alias ?? 'prod',
      version: options.version,
      triggers: options.triggers ?? [{ type: 'http' }],
      name: options.name,
      concurrency: options.concurrency ?? 10,
      environment: options.environment,
      secrets: options.secrets ?? [],
      budget: options.budget ?? {},
    };
    for (const k of Object.keys(body)) if (body[k] === undefined || body[k] === null) delete body[k];
    return this.c.call('post', '/v1/deployments', { body });
  }

  async list(): Promise<Deployment[]> {
    return (await this.c.call('get', '/v1/deployments')).deployments;
  }

  /** `ref` is a deployment id or name. */
  get(ref: string): Promise<Deployment> {
    return this.c.call('get', '/v1/deployments/{ref}', { path: { ref } });
  }

  update(ref: string, changes: Partial<DeploymentCreate> & { status?: 'active' | 'paused'; [key: string]: unknown }): Promise<Deployment> {
    return this.c.call('patch', '/v1/deployments/{ref}', { path: { ref }, body: changes });
  }

  pause(ref: string): Promise<Deployment> {
    return this.update(ref, { status: 'paused' });
  }

  resume(ref: string): Promise<Deployment> {
    return this.update(ref, { status: 'active' });
  }

  delete(ref: string): Promise<void> {
    return this.c.call('delete', '/v1/deployments/{ref}', { path: { ref } });
  }

  invoke(ref: string, options: { input: string; metadata?: Record<string, unknown>; signal?: AbortSignal } | string): Promise<RemoteSession> {
    const o = typeof options === 'string' ? { input: options } : options;
    return this.c.invoke('', { ...o, deployment: ref });
  }
}

export class Sessions extends Resource {
  get(sessionId: string): Promise<Session> {
    return this.c.call('get', '/v1/sessions/{session_id}', { path: { session_id: sessionId } });
  }

  async list(options: { agent?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    const query: { limit: number; agent?: string } = { limit: options.limit ?? 50 };
    if (options.agent) query.agent = options.agent;
    return (await this.c.call('get', '/v1/sessions', { query })).sessions;
  }

  /** A handle on an existing session, to follow or steer it. */
  attach(sessionId: string): RemoteSession {
    return new RemoteSession(this.c, sessionId);
  }

  /** Send a user message (steers a running run, or starts a new one). */
  send(sessionId: string, text: string): Promise<SessionEventResult> {
    return this.c.call('post', '/v1/sessions/{session_id}/events', { path: { session_id: sessionId }, body: { type: 'message.user', text } });
  }

  /** Decide a pending tool approval. */
  approve(sessionId: string, callId: string, approved = true, reason?: string): Promise<SessionEventResult> {
    return this.c.call('post', '/v1/sessions/{session_id}/events', {
      path: { session_id: sessionId },
      body: { type: 'tool.approval.decided', call_id: callId, approved, reason: reason ?? null },
    });
  }

  deny(sessionId: string, callId: string, reason?: string): Promise<SessionEventResult> {
    return this.approve(sessionId, callId, false, reason);
  }

  interrupt(sessionId: string): Promise<InterruptResult> {
    return this.c.call('post', '/v1/sessions/{session_id}/interrupt', { path: { session_id: sessionId } });
  }

  terminate(sessionId: string): Promise<void> {
    return this.c.call('delete', '/v1/sessions/{session_id}', { path: { session_id: sessionId } });
  }

  async artifacts(sessionId: string): Promise<Artifact[]> {
    return (await this.c.call('get', '/v1/sessions/{session_id}/artifacts', { path: { session_id: sessionId } })).artifacts;
  }

  /** The artifact's bytes, whatever its content type. */
  async download(sessionId: string, artifactId: string): Promise<Uint8Array> {
    const data = await this.c.request<Uint8Array | undefined>(
      'GET',
      `/v1/sessions/${encodeSegment(sessionId)}/artifacts/${encodeSegment(artifactId)}`,
      { raw: true, headers: { Accept: '*/*' } },
    );
    return data ?? new Uint8Array();
  }
}

export class Secrets extends Resource {
  set(name: string, value: string): Promise<SecretWritten> {
    return this.c.call('post', '/v1/secrets', { body: { name, value } });
  }

  async list(): Promise<SecretInfo[]> {
    return (await this.c.call('get', '/v1/secrets')).secrets;
  }

  delete(name: string): Promise<void> {
    return this.c.call('delete', '/v1/secrets/{name}', { path: { name } });
  }
}

export class Environments extends Resource {
  /** Create or replace a sandbox environment. */
  put(name: string, spec: Omit<Partial<Environment>, 'name'> = {}): Promise<Environment> {
    return this.c.call('post', '/v1/environments', { body: { name, ...spec } });
  }

  async list(): Promise<Environment[]> {
    return (await this.c.call('get', '/v1/environments')).environments;
  }
}
