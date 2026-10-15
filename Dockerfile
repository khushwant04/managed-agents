# syntax=docker/dockerfile:1.7
#
# Server image: gateway, worker, scheduler and migrations from one image.
#
#   docker build -t runhive-server .                          # default target
#   docker build --target with-docker-cli -t runhive-server:docker .
#
#   docker run --rm -p 8080:8080 -e DATABASE_URL=... runhive-server            # serve
#   docker run --rm -e DATABASE_URL=... runhive-server worker
#   docker run --rm -e DATABASE_URL=... runhive-server migrate
#
# Installs the workspace packages `runhive[e2b]` and
# `runhive-server[s3]` from uv.lock (no dev dependencies, no CLI).
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
# extra of runhive and the `s3` extra of runhive-server both apply. The CLI is
# included so `runhive e2b check` and friends run inside the containers.
ARG UV_SYNC_ARGS="--frozen --no-dev --package runhive-server --package runhive --package runhive-cli --extra s3 --extra e2b"

# 1. Third-party dependencies only (cached until uv.lock changes).
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync ${UV_SYNC_ARGS} --no-install-workspace

# 2. The workspace packages themselves, installed as regular (non-editable) wheels.
COPY pyproject.toml uv.lock ./
COPY packages/runhive/pyproject.toml packages/runhive/README.md packages/runhive/
COPY packages/runhive/src packages/runhive/src
COPY packages/runhive-server/pyproject.toml packages/runhive-server/
COPY packages/runhive-server/src packages/runhive-server/src
COPY packages/runhive-cli/pyproject.toml packages/runhive-cli/
COPY packages/runhive-cli/src packages/runhive-cli/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync ${UV_SYNC_ARGS} --no-editable

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="runhive-server" \
      org.opencontainers.image.description="Gateway, registry, router, scheduler and runtime workers for Runhive." \
      org.opencontainers.image.source="https://github.com/khushwant04/managed-agents"

RUN groupadd --system --gid 10001 runhive \
 && useradd --system --uid 10001 --gid runhive --home-dir /home/runhive --create-home --shell /usr/sbin/nologin runhive

COPY --from=builder --chown=root:root /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    RUNHIVE_BLOB_URL=file:///home/runhive/blobs \
    RUNHIVE_HEALTHCHECK_URL=http://127.0.0.1:8080/healthz

USER runhive
WORKDIR /home/runhive

EXPOSE 8080

# Only meaningful for `serve` / `all`; compose disables it for worker and scheduler.
# The slim image has no curl, so use the Python stdlib.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(os.environ['RUNHIVE_HEALTHCHECK_URL'], timeout=4)" || exit 1

ENTRYPOINT ["runhive-server"]
CMD ["serve"]

# ---------------------------------------------------------------------------
# Optional: runtime + docker CLI, for workers using RUNHIVE_SANDBOX_PROVIDER=docker
# ---------------------------------------------------------------------------
FROM runtime AS with-docker-cli
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

# ---------------------------------------------------------------------------
# Default target (keep last)
# ---------------------------------------------------------------------------
FROM runtime AS final
