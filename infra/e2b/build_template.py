"""Build the `runhive-base` E2B sandbox template from ./Dockerfile.

Uses the E2B Template SDK (`e2b>=2`, already a dependency of
`runhive[e2b]`), which imports a single-stage Dockerfile and builds it
on E2B's infrastructure. Authenticates with `E2B_API_KEY`.

    uv run --no-project --with 'e2b>=2' python infra/e2b/build_template.py               # build + publish
    uv run --no-project --with 'e2b>=2' python infra/e2b/build_template.py --dry-run     # parse only, no API calls
    python infra/e2b/build_template.py --name runhive-base --tag v0.1.0
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--name", default=os.environ.get("E2B_TEMPLATE_NAME", "runhive-base"))
    p.add_argument(
        "--tag", action="append", default=[], help="extra tag(s), e.g. the release version"
    )
    p.add_argument("--cpu", type=int, default=int(os.environ.get("E2B_TEMPLATE_CPU", "2")))
    p.add_argument(
        "--memory-mb", type=int, default=int(os.environ.get("E2B_TEMPLATE_MEMORY_MB", "2048"))
    )
    p.add_argument("--skip-cache", action="store_true")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="parse the Dockerfile and print the template; no API calls",
    )
    args = p.parse_args(argv)

    from e2b import Template, default_build_logger

    template = Template(file_context_path=HERE).from_dockerfile(str(HERE / "Dockerfile"))

    if args.dry_run:
        print(Template.to_dockerfile(template))
        return 0

    if not os.environ.get("E2B_API_KEY"):
        print("E2B_API_KEY is not set", file=sys.stderr)
        return 2

    info = Template.build(
        template,
        args.name,
        tags=args.tag or None,
        cpu_count=args.cpu,
        memory_mb=args.memory_mb,
        skip_cache=args.skip_cache,
        on_build_logs=default_build_logger(),
    )
    print(info)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
