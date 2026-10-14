"""Function tools: ``@tool``-decorated Python functions.

Run locally, a function tool is called in-process. Hosted, it is called as an
HMAC-signed webhook at ``url`` through the tool gateway, or run as a script in
the sandbox (ADR-0009).
"""

from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Callable
from typing import Any, get_type_hints

from pydantic import BaseModel, create_model

from ..types import ToolSpec
from .approval import ApprovalPolicy, parse_approval


class FunctionTool:
    def __init__(
        self,
        fn: Callable[..., Any] | None,
        spec: ToolSpec,
        *,
        url: str | None = None,
        approval: ApprovalPolicy | None = None,
        secrets: list[str] | None = None,
        model: type[BaseModel] | None = None,
        single_model_arg: bool = False,
    ) -> None:
        self.fn = fn
        self.spec = spec
        self.url = url
        self.approval = approval or parse_approval("never")
        self.secrets = secrets or []
        self._model = model
        self._single_model_arg = single_model_arg

    @property
    def name(self) -> str:
        return self.spec.name

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        if self.fn is None:
            raise TypeError(f"tool {self.name!r} has no local implementation")
        return self.fn(*args, **kwargs)

    def ref(self) -> dict[str, Any]:
        """The serializable part stored in an agent version."""
        ref: dict[str, Any] = {
            "type": "function",
            "name": self.spec.name,
            "description": self.spec.description,
            "input_schema": self.spec.input_schema,
            "approval": self.approval.to_json(),
        }
        if self.url:
            ref["url"] = self.url
        if self.secrets:
            ref["secrets"] = self.secrets
        return ref

    async def invoke(self, arguments: dict[str, Any]) -> str:
        if self.fn is None:
            raise RuntimeError(f"tool {self.name!r} has no local implementation; it must be called by webhook")
        if self._model is not None:
            parsed = self._model.model_validate(arguments)
            call_args: tuple[Any, ...] = (parsed,) if self._single_model_arg else ()
            call_kwargs = {} if self._single_model_arg else dict(parsed)
        else:
            call_args, call_kwargs = (), arguments
        if inspect.iscoroutinefunction(self.fn):
            result = await self.fn(*call_args, **call_kwargs)
        else:
            result = await asyncio.to_thread(self.fn, *call_args, **call_kwargs)
        return to_text(result)


def to_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, BaseModel):
        return result.model_dump_json()
    return json.dumps(result, default=_default, ensure_ascii=False)


def _default(obj: Any) -> Any:
    if isinstance(obj, BaseModel):
        return obj.model_dump(mode="json")
    return str(obj)


def tool(
    fn: Callable[..., Any] | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
    url: str | None = None,
    approval: Any = "never",
    secrets: list[str] | None = None,
) -> Any:
    """Turn a function into a tool. Its schema comes from the type hints.

    A function taking a single Pydantic model receives the validated model;
    otherwise each parameter becomes a property of the input schema.
    """

    def wrap(f: Callable[..., Any]) -> FunctionTool:
        hints = get_type_hints(f)
        params = [p for p in inspect.signature(f).parameters.values() if p.name not in ("self", "cls")]
        single = (
            len(params) == 1
            and isinstance(hints.get(params[0].name), type)
            and issubclass(hints[params[0].name], BaseModel)
        )
        if single:
            model: type[BaseModel] = hints[params[0].name]
        else:
            fields: dict[str, Any] = {
                p.name: (hints.get(p.name, Any), ... if p.default is inspect.Parameter.empty else p.default)
                for p in params
            }
            model = create_model(f"{f.__name__}_args", **fields)
        schema = model.model_json_schema()
        schema.pop("title", None)
        spec = ToolSpec(
            name=name or f.__name__,
            description=(description or inspect.getdoc(f) or "").strip(),
            input_schema=schema,
        )
        return FunctionTool(
            f,
            spec,
            url=url,
            approval=parse_approval(approval),
            secrets=secrets,
            model=model,
            single_model_arg=single,
        )

    return wrap(fn) if fn is not None else wrap
