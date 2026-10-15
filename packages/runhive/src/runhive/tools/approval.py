"""Tool approval policies (ADR-0014): ``never | always | {"when": <expr>}``.

``when`` expressions are a small, safe subset of Python evaluated against the
call: ``tool`` (the canonical tool name) and ``args`` (the arguments; keys can
be read as attributes). Supported: literals, ``and``/``or``/``not``,
comparisons including ``in``, indexing, ``len()`` and the string methods
``startswith``, ``endswith``, ``lower``, ``upper``. Examples::

    approval={"when": "'rm ' in args.command or args.command.startswith('git push')"}
    approval={"when": "args.amount > 100"}
"""

from __future__ import annotations

import ast
import operator
from dataclasses import dataclass
from typing import Any

_CMP = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
    ast.In: lambda a, b: a in b,
    ast.NotIn: lambda a, b: a not in b,
}
_METHODS = {"startswith", "endswith", "lower", "upper", "strip"}


class ExpressionError(ValueError):
    pass


class _Args(dict):  # attribute access for convenience: args.command
    def __getattr__(self, key: str) -> Any:
        try:
            return _wrap(self[key])
        except KeyError:
            return None


def _wrap(value: Any) -> Any:
    return _Args(value) if isinstance(value, dict) and not isinstance(value, _Args) else value


def compile_expression(source: str) -> ast.Expression:
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:
        raise ExpressionError(f"invalid approval expression {source!r}: {exc.msg}") from None
    for node in ast.walk(tree):
        allowed = (
            ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.UnaryOp, ast.Not, ast.Compare,
            ast.Constant, ast.Name, ast.Load, ast.Attribute, ast.Subscript, ast.Call,
            ast.List, ast.Tuple, ast.Set, *_CMP,
        )  # fmt: skip
        if not isinstance(node, allowed):
            raise ExpressionError(f"{type(node).__name__} is not allowed in approval expressions")
        if isinstance(node, ast.Name) and node.id not in ("args", "tool", "len", "True", "False", "None"):
            raise ExpressionError(f"unknown name {node.id!r} in approval expression")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise ExpressionError("private attributes are not allowed")
    return tree


def _eval(node: ast.AST, env: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval(node.body, env)
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        return env[node.id]
    if isinstance(node, ast.List | ast.Tuple | ast.Set):
        return [_eval(e, env) for e in node.elts]
    if isinstance(node, ast.BoolOp):
        values = (_eval(v, env) for v in node.values)
        return all(values) if isinstance(node.op, ast.And) else any(values)
    if isinstance(node, ast.UnaryOp):
        return not _eval(node.operand, env)
    if isinstance(node, ast.Compare):
        left = _eval(node.left, env)
        for op, comp in zip(node.ops, node.comparators, strict=True):
            right = _eval(comp, env)
            try:
                if not _CMP[type(op)](left, right):
                    return False
            except TypeError:
                return False
            left = right
        return True
    if isinstance(node, ast.Subscript):
        container = _eval(node.value, env)
        try:
            return _wrap(container[_eval(node.slice, env)])
        except (KeyError, IndexError, TypeError):
            return None
    if isinstance(node, ast.Attribute):
        target = _eval(node.value, env)
        if isinstance(target, _Args):
            return getattr(target, node.attr)
        if isinstance(target, str) and node.attr in _METHODS:
            return getattr(target, node.attr)
        return None
    if isinstance(node, ast.Call):
        fn = _eval(node.func, env)
        args = [_eval(a, env) for a in node.args]
        if fn is len:
            return len(args[0]) if args and args[0] is not None else 0
        if callable(fn) and getattr(fn, "__name__", "") in _METHODS:
            return fn(*args)
        return None
    raise ExpressionError(f"cannot evaluate {type(node).__name__}")


@dataclass(frozen=True)
class ApprovalPolicy:
    mode: str  # "never" | "always" | "when"
    expression: str | None = None

    def requires_approval(self, tool: str, args: dict[str, Any]) -> bool:
        if self.mode == "never":
            return False
        if self.mode == "always":
            return True
        assert self.expression is not None
        env = {"args": _Args(args), "tool": tool, "len": len, "True": True, "False": False, "None": None}
        return bool(_eval(compile_expression(self.expression), env))

    def to_json(self) -> Any:
        return {"when": self.expression} if self.mode == "when" else self.mode


def parse_approval(value: Any) -> ApprovalPolicy:
    if isinstance(value, ApprovalPolicy):
        return value
    if value in (None, "never", False):
        return ApprovalPolicy("never")
    if value in ("always", True):
        return ApprovalPolicy("always")
    if isinstance(value, dict) and isinstance(value.get("when"), str):
        compile_expression(value["when"])
        return ApprovalPolicy("when", value["when"])
    raise ValueError(f"invalid approval policy {value!r}; expected 'never', 'always' or {{'when': <expr>}}")
