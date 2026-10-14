/**
 * Types for the Managed Agents REST API, taken from the generated OpenAPI
 * definitions in `api-types.ts` (run `npm run generate` after the spec changes).
 */
import type { components, paths } from "./api-types";

export type { components, paths };

type Schemas = components["schemas"];

export type AgentSummary = Schemas["AgentSummary"];
export type AgentList = Schemas["AgentList"];
export type AgentVersion = Schemas["AgentVersion"];
export type VersionSummary = Schemas["VersionSummary"];
export type VersionList = Schemas["VersionList"];
export type AliasInfo = Schemas["AliasInfo"];
export type AliasList = Schemas["AliasList"];
export type AliasResult = Schemas["AliasResult"];
export type AliasTarget = Schemas["AliasTarget"];
export type VersionWeight = Schemas["VersionWeight"];
export type Deployment = Schemas["Deployment"];
export type DeploymentList = Schemas["DeploymentList"];
export type Session = Schemas["Session"];
export type SessionSummary = Schemas["SessionSummary"];
export type SessionList = Schemas["SessionList"];
export type SessionEventBody = Schemas["SessionEventBody"];
export type SessionEventResult = Schemas["SessionEventResult"];
export type InterruptResult = Schemas["InterruptResult"];
export type ApiEvent = Schemas["Event"];
export type EventList = Schemas["EventList"];
export type EventType = ApiEvent["type"];
export type Artifact = Schemas["Artifact"];
export type ArtifactList = Schemas["ArtifactList"];
export type Project = Schemas["Project"];
export type UsageRow = Schemas["UsageRow"];
export type UsageList = Schemas["UsageList"];
export type AuditEntry = Schemas["AuditEntry"];
export type AuditList = Schemas["AuditList"];
export type Run = Schemas["Run"];

/** Every event type the server can emit, in schema order. */
export const EVENT_TYPES: readonly EventType[] = [
  "session.status",
  "route.resolved",
  "run.started",
  "run.finished",
  "message.user",
  "message.agent.delta",
  "message.agent.done",
  "thinking.delta",
  "tool.call",
  "tool.result",
  "tool.approval.requested",
  "tool.approval.decided",
  "subagent.started",
  "subagent.finished",
  "artifact.created",
  "error",
];

/** Session statuses in which no run is in flight. */
export const SETTLED_STATUSES = new Set(["idle", "waiting_input", "approval_pending", "failed", "terminated"]);

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}
