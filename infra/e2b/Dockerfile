# runhive-base: the sandbox template every session starts from (ADR-0006).
#
# Used two ways:
#   - E2B:    built into the `runhive-base` template (see README.md / build_template.py)
#   - Docker: `docker build -t runhive-base:latest infra/e2b` for the Docker
#             sandbox provider (RUNHIVE_SANDBOX_PROVIDER=docker)
#
# Keep this file single-stage and free of COPY/ADD: E2B's Dockerfile import
# supports one FROM only, ignores RUN --mount, and this keeps the template
# self-contained. Do not add CMD/ENTRYPOINT: E2B turns them into the sandbox
# start command, and the Docker provider runs `sleep <timeout>` itself.

FROM ubuntu:24.04

ARG NODE_MAJOR=24
ARG DEBIAN_FRONTEND=noninteractive

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Etc/UTC

# Base toolchain: shell, Python, git, build tools, search/JSON helpers.
# Unpinned on purpose: the template tracks Ubuntu 24.04 security updates.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget gnupg git jq ripgrep less unzip zip xz-utils \
      procps file tree sudo build-essential pkg-config \
      python3 python3-pip python3-venv python3-dev python-is-python3 \
 && rm -rf /var/lib/apt/lists/*

# Node.js LTS from NodeSource (major version pinned by NODE_MAJOR).
# (No pipes: E2B's import ignores SHELL, so pipefail can't be set.)
# hadolint ignore=DL3008
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL -o /tmp/nodesource.asc https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
 && gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg /tmp/nodesource.asc \
 && rm /tmp/nodesource.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node --version && npm --version

# Non-root `user` (E2B's default sandbox user) owning /workspace.
# Passwordless sudo mirrors E2B's stock templates so agents can apt-get install
# inside their own isolated sandbox; remove it if your agents never need root.
# uid 1000 matches DockerSandboxProvider(uid=1000), which writes files as this user;
# Ubuntu 24.04 ships an `ubuntu` user with that uid, so it is removed first.
RUN (userdel --remove ubuntu 2>/dev/null || true) \
 && (id -u user >/dev/null 2>&1 || useradd --create-home --uid 1000 --shell /bin/bash user) \
 && echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user \
 && chmod 0440 /etc/sudoers.d/user \
 && mkdir -p /workspace/inputs /workspace/outputs /workspace/skills /workspace/memory \
 && chown -R user:user /workspace

# Ubuntu 24.04's Python is "externally managed" (PEP 668), so plain `pip install`
# fails. Give agents a writable venv on PATH for both login and non-login shells
# (the Docker provider and E2B run commands through `bash -l`).
# hadolint ignore=SC2016
RUN python3 -m venv /opt/venv \
 && chown -R user:user /opt/venv \
 && printf '%s\n' \
      'export PATH="/opt/venv/bin:$PATH"' \
      'export PIP_DISABLE_PIP_VERSION_CHECK=1' \
      > /etc/profile.d/agents.sh
# PATH is spelled out rather than "/opt/venv/bin:${PATH}": E2B's Dockerfile import
# passes `${PATH}` through unexpanded, so don't rely on it.
ENV PATH=/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PIP_DISABLE_PIP_VERSION_CHECK=1

USER user
WORKDIR /workspace
