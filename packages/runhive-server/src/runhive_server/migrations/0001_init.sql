-- Runhive: initial schema.
-- Control plane: orgs, projects, keys, registry, aliases, deployments, secrets, audit.
-- Data plane: sessions, runs (the queue), steps (checkpoints), events, usage.

CREATE TABLE orgs (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id          text PRIMARY KEY,
    org_id      text NOT NULL REFERENCES orgs(id),
    name        text NOT NULL,
    -- allowlists for models, tools, egress domains and agent-to-agent calls; budgets; rate limits
    policy      jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name)
);

CREATE TABLE api_keys (
    id          text PRIMARY KEY,
    project_id  text NOT NULL REFERENCES projects(id),
    name        text NOT NULL,
    prefix      text NOT NULL,
    hash        text NOT NULL UNIQUE,
    role        text NOT NULL CHECK (role IN ('admin', 'developer', 'viewer')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at  timestamptz
);

-- Registry ----------------------------------------------------------------

CREATE TABLE agents (
    project_id  text NOT NULL REFERENCES projects(id),
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    tags        text[] NOT NULL DEFAULT '{}',
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, name)
);

CREATE TABLE agent_versions (
    project_id  text NOT NULL,
    name        text NOT NULL,
    version     integer NOT NULL,
    hash        text NOT NULL,
    spec        jsonb NOT NULL,
    card        jsonb NOT NULL,
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, name, version),
    UNIQUE (project_id, name, hash),
    FOREIGN KEY (project_id, name) REFERENCES agents(project_id, name)
);

CREATE TABLE aliases (
    project_id  text NOT NULL,
    name        text NOT NULL,
    alias       text NOT NULL,
    -- [{"version": 14, "weight": 90}, {"version": 15, "weight": 10}]
    versions    jsonb NOT NULL,
    updated_by  text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, name, alias),
    FOREIGN KEY (project_id, name) REFERENCES agents(project_id, name)
);

CREATE TABLE skills (
    project_id  text NOT NULL REFERENCES projects(id),
    name        text NOT NULL,
    version     text NOT NULL,
    description text NOT NULL DEFAULT '',
    bundle_key  text NOT NULL,
    size_bytes  bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, name, version)
);

CREATE TABLE environments (
    project_id  text NOT NULL REFERENCES projects(id),
    name        text NOT NULL,
    spec        jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, name)
);

CREATE TABLE secrets (
    project_id  text NOT NULL REFERENCES projects(id),
    name        text NOT NULL,
    ciphertext  bytea NOT NULL,
    nonce       bytea NOT NULL,
    wrapped_key bytea NOT NULL,
    key_id      text NOT NULL,
    version     integer NOT NULL DEFAULT 1,
    created_at  timestamptz NOT NULL DEFAULT now(),
    rotated_at  timestamptz,
    PRIMARY KEY (project_id, name)
);

CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    project_id  text NOT NULL,
    actor       text NOT NULL,
    action      text NOT NULL,
    target      text NOT NULL,
    details     jsonb NOT NULL DEFAULT '{}',
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_project_at ON audit_log (project_id, at DESC);

-- Hosting -----------------------------------------------------------------

CREATE TABLE deployments (
    id              text PRIMARY KEY,
    project_id      text NOT NULL REFERENCES projects(id),
    name            text NOT NULL,
    agent           text NOT NULL,
    alias           text NOT NULL,
    -- [{"type": "http"}, {"type": "cron", "schedule": "*/30 * * * *", "input": "..."}, ...]
    triggers        jsonb NOT NULL DEFAULT '[]',
    concurrency     integer NOT NULL DEFAULT 10,
    environment     text,
    secrets         text[] NOT NULL DEFAULT '{}',
    budget          jsonb NOT NULL DEFAULT '{}',
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'deleted')),
    webhook_secret  text NOT NULL,
    created_by      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, name),
    FOREIGN KEY (project_id, agent) REFERENCES agents(project_id, name)
);

CREATE TABLE cron_state (
    deployment_id   text NOT NULL REFERENCES deployments(id),
    trigger_index   integer NOT NULL,
    next_run_at     timestamptz NOT NULL,
    last_run_at     timestamptz,
    PRIMARY KEY (deployment_id, trigger_index)
);

CREATE TABLE sessions (
    id                  text PRIMARY KEY,
    project_id          text NOT NULL REFERENCES projects(id),
    deployment_id       text REFERENCES deployments(id),
    agent               text NOT NULL,
    alias               text,
    version             integer NOT NULL,
    status              text NOT NULL DEFAULT 'queued',
    parent_session_id   text REFERENCES sessions(id),
    depth               integer NOT NULL DEFAULT 0,
    sandbox             jsonb,
    sandbox_state       text NOT NULL DEFAULT 'none' CHECK (sandbox_state IN ('none', 'running', 'paused', 'destroyed')),
    last_seq            bigint NOT NULL DEFAULT 0,
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_by          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    last_active_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_project_created ON sessions (project_id, created_at DESC);
CREATE INDEX sessions_idle ON sessions (last_active_at) WHERE sandbox_state = 'running';

-- The run queue: claimed with FOR UPDATE SKIP LOCKED; a worker holds a lease and heartbeats it.
CREATE TABLE runs (
    id              text PRIMARY KEY,
    session_id      text NOT NULL REFERENCES sessions(id),
    project_id      text NOT NULL,
    status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'waiting', 'finished', 'cancelled')),
    stop_reason     text,
    input           jsonb NOT NULL DEFAULT '[]',
    trigger         jsonb NOT NULL DEFAULT '{}',
    model           text,
    worker_id       text,
    lease_until     timestamptz,
    attempts        integer NOT NULL DEFAULT 0,
    usage           jsonb NOT NULL DEFAULT '{}',
    output          text,
    error           text,
    cancel_requested boolean NOT NULL DEFAULT false,
    enqueued_at     timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    finished_at     timestamptz
);
CREATE INDEX runs_claimable ON runs (enqueued_at) WHERE status IN ('queued', 'running');
CREATE INDEX runs_session ON runs (session_id, enqueued_at);

CREATE TABLE steps (
    id              text PRIMARY KEY,
    seq             bigserial,
    session_id      text NOT NULL,
    run_id          text NOT NULL REFERENCES runs(id),
    key             text NOT NULL,
    type            text NOT NULL,
    status          text NOT NULL DEFAULT 'begun',
    input           jsonb NOT NULL DEFAULT '{}',
    output          jsonb,
    error           text,
    attempts        integer NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    UNIQUE (run_id, key)
);
CREATE INDEX steps_session_seq ON steps (session_id, seq) WHERE status = 'completed';

-- Mid-run input, consumed by the worker at the next step boundary.
CREATE TABLE steering (
    id          bigserial PRIMARY KEY,
    session_id  text NOT NULL,
    run_id      text NOT NULL,
    message     jsonb NOT NULL,
    consumed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX steering_pending ON steering (run_id) WHERE consumed_at IS NULL;

-- Session events, partitioned by day. seq is monotonic per session (sessions.last_seq).
CREATE TABLE events (
    id          text NOT NULL,
    session_id  text NOT NULL,
    run_id      text,
    seq         bigint NOT NULL,
    type        text NOT NULL,
    ts          timestamptz NOT NULL DEFAULT now(),
    model       text,
    payload     jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (session_id, seq, ts)
) PARTITION BY RANGE (ts);
CREATE TABLE events_default PARTITION OF events DEFAULT;

CREATE TABLE usage_records (
    id              bigserial PRIMARY KEY,
    project_id      text NOT NULL,
    deployment_id   text,
    session_id      text NOT NULL,
    run_id          text NOT NULL,
    model           text,
    input_tokens    bigint NOT NULL DEFAULT 0,
    output_tokens   bigint NOT NULL DEFAULT 0,
    cache_read_tokens bigint NOT NULL DEFAULT 0,
    cache_write_tokens bigint NOT NULL DEFAULT 0,
    sandbox_seconds double precision NOT NULL DEFAULT 0,
    tool_calls      integer NOT NULL DEFAULT 0,
    at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_project_at ON usage_records (project_id, at);

CREATE TABLE artifacts (
    id          text PRIMARY KEY,
    session_id  text NOT NULL REFERENCES sessions(id),
    run_id      text,
    path        text NOT NULL,
    size_bytes  bigint NOT NULL,
    object_key  text NOT NULL,
    content_type text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, path)
);

CREATE TABLE memory_files (
    project_id  text NOT NULL,
    agent       text NOT NULL,
    path        text NOT NULL,
    content     bytea NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, agent, path)
);
