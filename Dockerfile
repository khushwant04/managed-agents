# syntax=docker/dockerfile:1.7
#
# Server image: gateway, worker, scheduler and migrations from one image.
#
#   docker build -t managed-agents-server .                          # default target
#   docker build --target with-docker-cli -t managed-agents-server:docker .
#
#   docker run --rm -p 8080:8080 -e DATABASE_URL=... managed-agents-server            # serve
#   docker run --rm -e DATABASE_URL=... managed-agents-server worker
#   docker run --rm -e DATABASE_URL=... managed-agents-server migrate
#
# Installs the workspace packages `managed-agents[e2b]` and
# `managed-agents-server[s3]` from uv.lock (no dev dependencies, no CLI).
# The `with-docker-cli` target adds the `docker` CLI for workers that use the
# Docker sandbox provider (local development only; see docker-compose.yml).

ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.11.32
ARG DOCKER_CLI_VERSION=28

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv
FROM docker:${DOCKER_CLI_VERSION}-cli AS dockercli

# ---------------------------------------------------------------------------
# Build: resolve from the lockfile into /opt/venv
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim-bookworm AS builder

COPY --from=uv /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /src

# Selection shared by both sync steps. `--package` is repeated so the `e2b`
# extra of managed-agents and the `s3` extra of managed-agents-server both apply.
ARG UV_SYNC_ARGS="--frozen --no-dev --package managed-agents-server --package managed-agents --extra s3 --extra e2b"

# 1. Third-party dependencies only (cached until uv.lock changes).
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync ${UV_SYNC_ARGS} --no-install-workspace

# 2. The workspace packages themselves, installed as regular (non-editable) wheels.
COPY pyproject.toml uv.lock ./
COPY packages/agents/pyproject.toml packages/agents/README.md packages/agents/
COPY packages/agents/src packages/agents/src
COPY packages/agents-server/pyproject.toml packages/agents-server/
COPY packages/agents-server/src packages/agents-server/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync ${UV_SYNC_ARGS} --no-editable

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="managed-agents-server" \
      org.opencontainers.image.description="Gateway, registry, router, scheduler and runtime workers for managed agents." \
      org.opencontainers.image.source="https://github.com/khushwant04/managed-agents"

RUN groupadd --system --gid 10001 agents \
 && useradd --system --uid 10001 --gid agents --home-dir /home/agents --create-home --shell /usr/sbin/nologin agents

COPY --from=builder --chown=root:root /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AGENTS_BLOB_URL=file:///home/agents/blobs \
    AGENTS_HEALTHCHECK_URL=http://127.0.0.1:8080/healthz

USER agents
WORKDIR /home/agents

EXPOSE 8080

# Only meaningful for `serve` / `all`; compose disables it for worker and scheduler.
# The slim image has no curl, so use the Python stdlib.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(os.environ['AGENTS_HEALTHCHECK_URL'], timeout=4)" || exit 1

ENTRYPOINT ["agents-server"]
CMD ["serve"]

# ---------------------------------------------------------------------------
# Optional: runtime + docker CLI, for workers using AGENTS_SANDBOX_PROVIDER=docker
# ---------------------------------------------------------------------------
FROM runtime AS with-docker-cli
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

# ---------------------------------------------------------------------------
# Default target (keep last)
# ---------------------------------------------------------------------------
FROM runtime AS final
