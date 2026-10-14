/**
 * Public types. Everything here is derived from the generated OpenAPI types in
 * `./generated/schema.ts` (run `npm run generate` after the server's API changes).
 */
import type { components, operations, paths } from './generated/schema.js';

export type { components, operations, paths };

/** Every named schema of the API: `Schemas['Session']`, `Schemas['Deployment']`, ... */
export type Schemas = components['schemas'];

type WireEvent = Schemas['Event'];

/** The normalized event types (ADR-0008), e.g. `"message.agent.delta"`. */
export type EventType = WireEvent['type'];

/** Session lifecycle states carried by `session.status` events. */
export type SessionStatus = 'queued' | 'running' | 'waiting_input' | 'approval_pending' | 'idle' | 'failed' | 'terminated';

/** Why a run stopped (`run.finished` payloads, `Run.stop_reason`). */
export type RunStopReason = 'end_turn' | 'needs_input' | 'approval_pending' | 'budget' | 'interrupted' | 'error';

/**
 * A session event: `{id, session_id, run_id, seq, type, ts, model, payload}` plus
 * `text`, a convenience equal to `payload.text ?? ''` (as `Event.text` in Python),
 * useful for `message.agent.delta` and `thinking.delta`.
 */
export type Event = Required<WireEvent> & {
  readonly text: string;
};

export type AgentSummary = Schemas['AgentSummary'];
export type AgentVersion = Schemas['AgentVersion'];
export type VersionSummary = Schemas['VersionSummary'];
export type VersionWeight = Schemas['VersionWeight'];
export type AliasInfo = Schemas['AliasInfo'];
export type AliasResult = Schemas['AliasResult'];
export type RegisterResult = Schemas['RegisterResult'];
export type Deployment = Schemas['Deployment'];
export type InvokeAccepted = Schemas['InvokeAccepted'];
export type InvokeResult = Schemas['InvokeResult'];
export type Session = Schemas['Session'];
export type SessionSummary = Schemas['SessionSummary'];
export type SessionEventResult = Schemas['SessionEventResult'];
export type InterruptResult = Schemas['InterruptResult'];
export type Run = Schemas['Run'];
export type Artifact = Schemas['Artifact'];
export type SecretInfo = Schemas['SecretInfo'];
export type SecretWritten = Schemas['SecretWritten'];
export type Environment = Schemas['Environment'];

/** The agent card returned by `GET /v1/agents/{target}/card` (an open object in the spec). */
export type AgentCard = operations['agent_card_v1_agents__target__card_get']['responses'][200]['content']['application/json'];

/**
 * An agent definition for `client.agents.register()`.
 *
 * The server accepts it as an open JSON object (`AgentSpec` in the Python SDK), so
 * only the commonly used fields are typed here; anything else is passed through.
 */
export interface AgentSpec {
  name: string;
  models: string[];
  description?: string;
  instructions?: string;
  tools?: Record<string, unknown>[];
  skills?: Record<string, unknown>[];
  subagents?: unknown;
  reasoning?: unknown;
  model_options?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  environment?: string | Record<string, unknown> | null;
  input_schema?: Record<string, unknown> | null;
  tags?: string[];
  [key: string]: unknown;
}

/** Body of `POST /v1/deployments` (an open object in the spec). */
export interface DeploymentCreate {
  /** Alias to route to. Default `"prod"`. */
  alias?: string;
  version?: number;
  /** Default `[{ type: 'http' }]`. */
  triggers?: Record<string, unknown>[];
  name?: string;
  /** Default 10. */
  concurrency?: number;
  environment?: string;
  secrets?: string[];
  budget?: Record<string, unknown>;
}
