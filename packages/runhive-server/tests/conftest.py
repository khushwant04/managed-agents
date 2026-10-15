"""Postgres for server tests.

Uses ``TEST_DATABASE_URL`` when set (a server where the user may create
databases). Otherwise starts a throwaway cluster with the local Postgres
binaries (as the ``postgres`` user when running as root). Each test gets a
fresh, migrated database.
"""

from __future__ import annotations

import asyncio
import glob
import os
import shutil
import socket
import subprocess
import tempfile
import uuid
from collections.abc import AsyncIterator, Iterator

import asyncpg
import pytest

from runhive_server.db import create_pool, migrate


def _pg_bin() -> str | None:
    found = shutil.which("pg_ctl")
    if found:
        return os.path.dirname(found)
    candidates = sorted(glob.glob("/usr/lib/postgresql/*/bin/pg_ctl"))
    return os.path.dirname(candidates[-1]) if candidates else None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def pg_server() -> Iterator[str]:
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        yield url
        return
    bindir = _pg_bin()
    if bindir is None:
        pytest.skip("no Postgres available: set TEST_DATABASE_URL or install PostgreSQL")
    as_root = os.geteuid() == 0
    prefix = ["runuser", "-u", "postgres", "--"] if as_root else []
    data = tempfile.mkdtemp(prefix="agents-pg-")
    if as_root:
        shutil.chown(data, "postgres", "postgres")
    port = _free_port()
    subprocess.run([*prefix, f"{bindir}/initdb", "-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"], check=True, capture_output=True)
    subprocess.run(
        [*prefix, f"{bindir}/pg_ctl", "-D", data, "-l", f"{data}/log", "-w", "-o", f"-p {port} -k {data} -c listen_addresses=127.0.0.1 -c fsync=off", "start"],
        check=True,
        capture_output=True,
    )
    try:
        yield f"postgresql://postgres@127.0.0.1:{port}/postgres"
    finally:
        subprocess.run([*prefix, f"{bindir}/pg_ctl", "-D", data, "-m", "immediate", "stop"], capture_output=True)
        shutil.rmtree(data, ignore_errors=True)


@pytest.fixture
async def dsn(pg_server: str) -> AsyncIterator[str]:
    name = f"t_{uuid.uuid4().hex[:12]}"
    admin = await asyncpg.connect(pg_server)
    await admin.execute(f'CREATE DATABASE "{name}"')
    await admin.close()
    base = pg_server.rsplit("/", 1)[0]
    yield f"{base}/{name}"
    admin = await asyncpg.connect(pg_server)
    await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    await admin.close()


@pytest.fixture
async def pool(dsn: str) -> AsyncIterator[asyncpg.Pool]:
    p = await create_pool(dsn, max_size=20)
    await migrate(p)
    yield p
    await asyncio.wait_for(p.close(), 10)
