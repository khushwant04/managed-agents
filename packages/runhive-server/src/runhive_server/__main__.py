"""``runhive-server``: run the gateway, workers and scheduler.

    runhive-server migrate
    runhive-server bootstrap --org acme --project default      # prints an admin key
    runhive-server serve --host 0.0.0.0 --port 8080              # gateway (API + SSE/WS)
    runhive-server worker                                        # runtime worker
    runhive-server scheduler                                     # cron, idle reaper, partitions
    runhive-server all                                           # everything in one process (development)
    runhive-server openapi > openapi.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys

from .config import Settings


async def _with_services(fn, settings: Settings) -> None:  # type: ignore[no-untyped-def]
    from .services import Services

    services = await Services.start(settings)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover
            pass
    try:
        await fn(services, stop)
    finally:
        await services.stop()


async def _worker(services, stop) -> None:  # type: ignore[no-untyped-def]
    import os

    from prometheus_client import start_http_server

    port = int(os.environ.get("RUNHIVE_METRICS_PORT", "9090"))
    if port:
        start_http_server(port)  # workers have no API; Prometheus scrapes this port
    await services.worker().run_forever(stop, poll_interval=services.settings.poll_interval, hub=services.hub)


async def _scheduler(services, stop) -> None:  # type: ignore[no-untyped-def]
    from .scheduler import Scheduler

    await Scheduler(services.platform, idle_pause_seconds=services.settings.idle_pause_seconds).run_forever(stop)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="runhive-server")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    b = sub.add_parser("bootstrap")
    b.add_argument("--org", default="default")
    b.add_argument("--project", default="default")
    s = sub.add_parser("serve")
    s.add_argument("--host", default="0.0.0.0")
    s.add_argument("--port", type=int, default=8080)
    sub.add_parser("worker")
    sub.add_parser("scheduler")
    a = sub.add_parser("all")
    a.add_argument("--host", default="0.0.0.0")
    a.add_argument("--port", type=int, default=8080)
    sub.add_parser("openapi")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings()

    if args.cmd == "openapi":
        from .api import create_app

        json.dump(create_app(services=_OpenAPIOnly()).openapi(), sys.stdout, indent=2)  # type: ignore[arg-type]
        print()
        return
    if args.cmd == "migrate":
        from .db import create_pool, migrate

        async def run() -> None:
            pool = await create_pool(settings.database_url)
            print("\n".join(await migrate(pool)) or "up to date")
            await pool.close()

        asyncio.run(run())
        return
    if args.cmd == "bootstrap":
        from .auth import create_key, create_org_project
        from .db import create_pool, migrate

        async def run() -> None:
            pool = await create_pool(settings.database_url)
            await migrate(pool)
            _, project_id = await create_org_project(pool, args.org, args.project)
            _, key = await create_key(pool, project_id, "admin", "admin")
            await pool.close()
            print(f"project: {project_id}\nadmin key: {key}")

        asyncio.run(run())
        return
    if args.cmd == "worker":
        asyncio.run(_with_services(_worker, settings))
        return
    if args.cmd == "scheduler":
        asyncio.run(_with_services(_scheduler, settings))
        return
    import uvicorn

    from .api import create_app

    if args.cmd == "serve":
        uvicorn.run(create_app(), host=args.host, port=args.port, proxy_headers=True, timeout_keep_alive=75)
        return

    async def everything(services, stop) -> None:  # type: ignore[no-untyped-def]
        config = uvicorn.Config(create_app(services), host=args.host, port=args.port, proxy_headers=True)
        server = uvicorn.Server(config)
        tasks = [asyncio.create_task(_worker(services, stop)), asyncio.create_task(_scheduler(services, stop))]
        await server.serve()
        stop.set()
        await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(_with_services(everything, settings))


class _OpenAPIOnly:
    """Just enough of ``Services`` to build the app for schema export."""

    class settings:  # noqa: N801
        rate_limit_per_minute = 60
        public_url = ""


if __name__ == "__main__":
    main()
