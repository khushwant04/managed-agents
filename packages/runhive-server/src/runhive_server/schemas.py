"""Response models for the v1 API; they define the OpenAPI spec the TypeScript client is generated from."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict

from runhive.events import Event
from runhive.sandbox.base import Environment

from .registry import VersionWeight


class _Model(BaseModel):
    model_config = ConfigDict(extra="allow")


class RegisterResult(_Model):
    name: str
    version: int
    hash: str
    created: bool
    card: dict[str, Any]


class AgentSummary(_Model):
    name: str
    description: str
    tags: list[str]
    created_by: str | None = None
    latest_version: int
    card: dict[str, Any]


class AgentList(_Model):
    agents: list[AgentSummary]


class VersionSummary(_Model):
    version: int
    hash: str
    card: dict[str, Any]
    created_by: str | None = None
    created_at: datetime


class VersionList(_Model):
    name: str
    versions: list[VersionSummary]


class AgentVersion(_Model):
    name: str
    version: int
    hash: str
    spec: dict[str, Any]
    card: dict[str, Any]
    created_by: str | None = None
    created_at: datetime


class AliasInfo(_Model):
    alias: str
    versions: list[VersionWeight]
    updated_by: str | None = None
    updated_at: datetime


class AliasList(_Model):
    name: str
    aliases: list[AliasInfo]


class AliasResult(_Model):
    name: str
    alias: str
    versions: list[VersionWeight]


class InvokeAccepted(_Model):
    session_id: str
    run_id: str
    agent: str
    alias: str | None = None
    version: int


class InvokeResult(InvokeAccepted):
    status: str
    stop_reason: str | None = None
    output: str | None = None
    error: str | None = None
    usage: dict[str, Any] = {}


class Deployment(_Model):
    id: str
    project_id: str
    name: str
    agent: str
    alias: str
    triggers: list[dict[str, Any]]
    concurrency: int
    environment: str | None = None
    secrets: list[str]
    budget: dict[str, Any]
    status: str
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime
    webhook_url: str | None = None
    webhook_secret: str | None = None
    """Returned once, when the deployment is created."""


class DeploymentList(_Model):
    deployments: list[Deployment]


class QueueStarted(_Model):
    deployment: str
    session_id: str
    run_id: str


class QueueResult(_Model):
    started: list[QueueStarted]


class Run(_Model):
    id: str
    status: str
    stop_reason: str | None = None
    output: str | None = None
    error: str | None = None
    usage: dict[str, Any] = {}
    model: str | None = None
    enqueued_at: datetime | None = None
    finished_at: datetime | None = None


class SessionSummary(_Model):
    id: str
    agent: str
    alias: str | None = None
    version: int
    status: str
    deployment_id: str | None = None
    parent_session_id: str | None = None
    created_at: datetime
    last_active_at: datetime


class SessionList(_Model):
    sessions: list[SessionSummary]


class Session(SessionSummary):
    project_id: str
    depth: int
    sandbox_state: str
    metadata: dict[str, Any]
    active_run: dict[str, Any] | None = None
    last_run: Run | None = None


class SessionEventResult(_Model):
    run_id: str
    steered: bool | None = None
    resumed: bool | None = None


class EventList(_Model):
    events: list[Event]


class InterruptResult(_Model):
    interrupted: bool
    run_id: str | None = None


class Artifact(_Model):
    id: str
    path: str
    size_bytes: int
    content_type: str | None = None
    run_id: str | None = None
    created_at: datetime


class ArtifactList(_Model):
    artifacts: list[Artifact]


class SecretWritten(_Model):
    name: str
    version: int


class SecretInfo(_Model):
    name: str
    version: int
    key_id: str
    created_at: datetime
    rotated_at: datetime | None = None


class SecretList(_Model):
    secrets: list[SecretInfo]


class EnvironmentList(_Model):
    environments: list[Environment]


class SkillUploaded(_Model):
    name: str
    version: str
    description: str


class SkillInfo(SkillUploaded):
    size_bytes: int
    created_at: datetime


class SkillList(_Model):
    skills: list[SkillInfo]


class Project(_Model):
    id: str
    name: str
    policy: dict[str, Any]
    created_at: datetime
    role: str


class PolicyResult(_Model):
    policy: dict[str, Any]


class KeyCreated(_Model):
    id: str
    key: str
    role: str


class UsageRow(_Model):
    day: datetime
    model: str | None = None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    sandbox_seconds: float
    tool_calls: int
    runs: int


class UsageList(_Model):
    usage: list[UsageRow]


class AuditEntry(_Model):
    actor: str
    action: str
    target: str
    details: dict[str, Any]
    at: datetime


class AuditList(_Model):
    entries: list[AuditEntry]


class ErrorBody(_Model):
    error: str
    message: str | None = None
    problems: list[str] | None = None


class DeploymentCreate(BaseModel):
    agent: str
    alias: str = "prod"
    version: int | None = None
    """Point the alias at this version first (creates the alias if needed)."""
    triggers: list[dict[str, Any]] | None = None
    name: str | None = None
    concurrency: int = 10
    environment: str | None = None
    secrets: list[str] = []
    budget: dict[str, Any] = {}
    webhook_secret: str | None = None


class DeploymentUpdate(BaseModel):
    status: str | None = None
    triggers: list[dict[str, Any]] | None = None
    concurrency: int | None = None
    environment: str | None = None
    secrets: list[str] | None = None
    budget: dict[str, Any] | None = None
    version: int | None = None
