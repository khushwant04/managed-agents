"""Throwaway managed-agents server for the TypeScript integration tests.

Starts a private Postgres cluster (initdb/pg_ctl, as the ``postgres`` user when run
as root), migrates it, bootstraps the admin key ``ak_it_admin``, registers a model
``scripted`` that answers every request with "pong", runs a worker (local sandbox)
and serves the API with uvicorn. Everything is removed on exit (Ctrl-C / SIGTERM).

    .venv/bin/python typescript/scripts/it-server.py --port 8765 &
    AGENTS_IT_BASE_URL=http://127.0.0.1:8765 AGENTS_IT_API_KEY=ak_it_admin \\
        npm --prefix typescript run test:integration

Set ``TEST_DATABASE_URL`` to use an existing Postgres instead of starting one.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import glob
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from typing import Any

import asyncpg
import uvicorn

from agents.adapters import AdapterRegistry
from agents.sandbox.local import LocalSandboxProvider
from agents.testing import ScriptedAdapter, text
from agents_server.api import create_app
from agents_server.auth import bootstrap
from agents_server.blobs import FileBlobStore
from agents_server.config import Settings
from agents_server.db import create_pool, migrate
from agents_server.services import Services

ADMIN_KEY = "ak_it_admin"


class PongAdapter(ScriptedAdapter):
    """A ``ScriptedAdapter`` that never runs out: every model call answers "pong"."""

    def __init__(self) -> None:
        super().__init__([])

    async def stream(self, req: Any) -> AsyncIterator[Any]:
        self.turns = [text("pong")]
        async for delta in super().stream(req):
            yield delta


class _Server(uvicorn.Server):
    """Leaves SIGINT/SIGTERM to ``serve()`` so shutdown always cleans up."""

    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        yield


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _pg_bin() -> str:
    found = shutil.which("pg_ctl")
    if found:
        return os.path.dirname(found)
    candidates = sorted(glob.glob("/usr/lib/postgresql/*/bin/pg_ctl"))
    if not candidates:
        sys.exit("no Postgres binaries found: install PostgreSQL or set TEST_DATABASE_URL")
    return os.path.dirname(candidates[-1])


@contextmanager
def postgres() -> Iterator[str]:
    """Yield a server URL; a throwaway cluster unless ``TEST_DATABASE_URL`` is set."""
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        yield url
        return
    bindir = _pg_bin()
    as_root = os.geteuid() == 0
    prefix = ["runuser", "-u", "postgres", "--"] if as_root else []
    data = tempfile.mkdtemp(prefix="agents-it-pg-")
    if as_root:
        shutil.chown(data, "postgres", "postgres")
    port = _free_port()
    subprocess.run(
        [*prefix, f"{bindir}/initdb", "-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            *prefix,
            f"{bindir}/pg_ctl",
            "-D",
            data,
            "-l",
            f"{data}/log",
            "-w",
            "-o",
            f"-p {port} -k {data} -c listen_addresses=127.0.0.1 -c fsync=off",
            "start",
        ],
        check=True,
        capture_output=True,
    )
    try:
        yield f"postgresql://postgres@127.0.0.1:{port}/postgres"
    finally:
        subprocess.run(
            [*prefix, f"{bindir}/pg_ctl", "-D", data, "-m", "immediate", "stop"],
            capture_output=True,
        )
        shutil.rmtree(data, ignore_errors=True)


async def serve(server_url: str, host: str, port: int) -> None:
    name = f"it_{uuid.uuid4().hex[:12]}"
    admin = await asyncpg.connect(server_url)
    await admin.execute(f'CREATE DATABASE "{name}"')
    await admin.close()
    dsn = f"{server_url.rsplit('/', 1)[0]}/{name}"
    blobs_dir = tempfile.mkdtemp(prefix="agents-it-blobs-")
    pool = await create_pool(dsn, max_size=20)
    await migrate(pool)
    adapters = AdapterRegistry()
    adapters.register("scripted", PongAdapter())
    settings = Settings(
        database_url=dsn,
        master_key=base64.b64encode(os.urandom(32)).decode(),
        blob_url=f"file://{blobs_dir}",
        sandbox_provider="local",
        lease_seconds=5,
        public_url=f"http://{host}:{port}",
    )
    services = await Services.start(
        settings, pool=pool, adapters=adapters, blobs=FileBlobStore(blobs_dir), run_migrations=False
    )
    await bootstrap(pool, ADMIN_KEY)
    sandboxes = LocalSandboxProvider()
    stop = asyncio.Event()
    worker = services.worker(worker_id="w-it", sandboxes=lambda e: sandboxes)
    worker_task = asyncio.create_task(
        worker.run_forever(stop, poll_interval=0.05, hub=services.hub)
    )
    server = _Server(
        uvicorn.Config(
            create_app(services), host=host, port=port, log_level="warning", timeout_keep_alive=75
        )
    )
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: setattr(server, "should_exit", True))
    print(f"it-server ready on http://{host}:{port} (api key {ADMIN_KEY})", flush=True)
    try:
        await server.serve()
    finally:
        stop.set()
        await asyncio.wait_for(worker_task, 10)
        await services.stop()
        print("it-server stopped", flush=True)
        admin = await asyncpg.connect(server_url)
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await admin.close()
        shutil.rmtree(blobs_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with postgres() as url:
        asyncio.run(serve(url, args.host, args.port))


if __name__ == "__main__":
    main()
