"""Skills: versioned folders of instructions and scripts (ADR-0013).

A skill is a folder with a ``SKILL.md`` whose YAML front matter gives its
``name`` and ``description``. At session start it is copied to
``/workspace/skills/<name>``; the system prompt lists each skill's name and
description, and the model opens ``SKILL.md`` only when it needs it.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import yaml

from .sandbox.base import FileSpec
from .spec import SkillRef

MAX_SKILL_BYTES = 20 * 1024 * 1024


class SkillError(ValueError):
    pass


class Skill:
    def __init__(self, name: str, description: str, files: dict[str, bytes]) -> None:
        self.name = name
        self.description = description
        self.files = files

    @classmethod
    def from_path(cls, path: str | Path) -> Skill:
        root = Path(path)
        manifest = root / "SKILL.md"
        if not manifest.is_file():
            raise SkillError(f"{root} has no SKILL.md")
        meta = parse_front_matter(manifest.read_text())
        name = meta.get("name") or root.name
        description = meta.get("description") or ""
        files: dict[str, bytes] = {}
        total = 0
        for p in sorted(root.rglob("*")):
            if p.is_file() and not any(part.startswith(".") for part in p.relative_to(root).parts):
                data = p.read_bytes()
                total += len(data)
                if total > MAX_SKILL_BYTES:
                    raise SkillError(f"skill {name!r} is larger than {MAX_SKILL_BYTES} bytes")
                files[str(p.relative_to(root))] = data
        return cls(name, description, files)

    @property
    def version(self) -> str:
        h = hashlib.sha256()
        for rel in sorted(self.files):
            h.update(rel.encode() + b"\0" + self.files[rel] + b"\0")
        return h.hexdigest()[:16]

    def ref(self, path: str | None = None) -> SkillRef:
        return SkillRef(name=self.name, version=self.version, description=self.description, path=path)

    def sandbox_files(self) -> list[FileSpec]:
        return [FileSpec(path=f"/workspace/skills/{self.name}/{rel}", content=data) for rel, data in self.files.items()]


def parse_front_matter(text: str) -> dict[str, str]:
    if not text.startswith("---"):
        return {}
    try:
        _, block, _ = text.split("---", 2)
    except ValueError:
        return {}
    data = yaml.safe_load(block) or {}
    return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}


def skills_prompt(skills: list[SkillRef]) -> str:
    if not skills:
        return ""
    lines = [
        "## Skills",
        "Skills are folders of instructions and scripts in /workspace/skills. When a task matches a "
        "skill, read its SKILL.md with the files tool before starting.",
        "",
    ]
    lines += [f"- {s.name} (/workspace/skills/{s.name}/SKILL.md): {s.description}" for s in skills]
    return "\n".join(lines)
