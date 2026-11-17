"""Python adapter: signatures, stubs, sanitizing, and static checks."""

from __future__ import annotations

import ast
import copy
import os
import re
import sys
import textwrap
from pathlib import Path
from typing import TYPE_CHECKING

from ..constants import STUB_MARK
from ..errors import SpecError

if TYPE_CHECKING:
    from ..spec import Project, Unit

FUTURE_ANNOTATIONS = "from __future__ import annotations"
DEF_TYPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
FUNC_TYPES = (ast.FunctionDef, ast.AsyncFunctionDef)
_TRACE_RES = (
    re.compile(r'^\s*File "(?P<path>[^"]+)", line (?P<line>\d+)'),  # standard / --tb=native
    re.compile(r"^(?P<path>(?:[A-Za-z]:)?[^:\s][^:]*?\.py):(?P<line>\d+):"),  # pytest --tb=short
)


def _src(node: ast.AST | None) -> str | None:
    return ast.unparse(node) if node is not None else None


def _norm_default(src: str | None) -> str | None:
    return None if src is None else re.sub(r"\s+", "", src)


def _norm_annotation(src: str | None) -> str | None:
    if src is None:
        return None
    return re.sub(r"\s+", "", src).replace("typing.", "").replace("'", "").replace('"', "")


def _parse_snippet(text: str) -> ast.Module:
    """Parse a signature, tolerating a missing trailing colon or body."""
    text = textwrap.dedent(text).strip("\n").rstrip()
    error: SyntaxError | None = None
    for candidate in (text, text + "\n    ...", text + ":\n    ..."):
        try:
            return ast.parse(candidate)
        except SyntaxError as exc:
            error = error or exc
    raise error  # type: ignore[misc]


def _is_ellipsis(stmt: ast.stmt) -> bool:
    return isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant) and stmt.value.value is Ellipsis


def _is_main_guard(node: ast.stmt) -> bool:
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    test = node.test
    return (
        isinstance(test.left, ast.Name)
        and test.left.id == "__name__"
        and len(test.comparators) == 1
        and isinstance(test.comparators[0], ast.Constant)
        and test.comparators[0].value == "__main__"
    )


def _target_names(target: ast.expr) -> set[str]:
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, (ast.Tuple, ast.List)):
        return set().union(*(_target_names(e) for e in target.elts)) if target.elts else set()
    if isinstance(target, ast.Starred):
        return _target_names(target.value)
    return set()


def _assigned_names(node: ast.stmt) -> set[str]:
    if isinstance(node, ast.Assign):
        return set().union(*(_target_names(t) for t in node.targets))
    if isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        return _target_names(node.target)
    return set()


def _decorators(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> set[str]:
    return {re.sub(r"\s+", "", ast.unparse(d)) for d in node.decorator_list}


def _params(args: ast.arguments) -> list[tuple[str, str, str | None, str | None]]:
    """(kind, name, default source, annotation source) for every parameter, in order."""
    out = []
    positional = list(args.posonlyargs) + list(args.args)
    defaults: list[ast.expr | None] = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    for index, (arg, default) in enumerate(zip(positional, defaults)):
        kind = "positional-only" if index < len(args.posonlyargs) else "positional"
        out.append((kind, arg.arg, _src(default), _src(arg.annotation)))
    if args.vararg:
        out.append(("*args", args.vararg.arg, None, _src(args.vararg.annotation)))
    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        out.append(("keyword-only", arg.arg, _src(default), _src(arg.annotation)))
    if args.kwarg:
        out.append(("**kwargs", args.kwarg.arg, None, _src(args.kwarg.annotation)))
    return out


def _compare_functions(expected, actual, label: str, strict: bool) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    soft = errors if strict else warnings
    want_async = isinstance(expected, ast.AsyncFunctionDef)
    if want_async != isinstance(actual, ast.AsyncFunctionDef):
        errors.append(f"`{label}` must be defined with `{'async def' if want_async else 'def'}`.")
    want, got = _params(expected.args), _params(actual.args)
    if [(k, n) for k, n, _, _ in want] != [(k, n) for k, n, _, _ in got]:
        errors.append(
            f"`{label}` must take ({ast.unparse(expected.args)}), but yours takes ({ast.unparse(actual.args)})."
        )
    else:
        for (_, name, want_default, want_ann), (_, _, got_default, got_ann) in zip(want, got):
            if _norm_default(want_default) != _norm_default(got_default):
                if want_default is None:
                    errors.append(f"Parameter `{name}` of `{label}` must not have a default value.")
                else:
                    errors.append(f"Parameter `{name}` of `{label}` must default to `{want_default}`.")
            if want_ann is not None and _norm_annotation(want_ann) != _norm_annotation(got_ann):
                soft.append(f"Parameter `{name}` of `{label}` should be annotated `{want_ann}`.")
    want_return = _src(expected.returns)
    if want_return is not None and _norm_annotation(want_return) != _norm_annotation(_src(actual.returns)):
        soft.append(f"`{label}` should be annotated to return `{want_return}`.")
    missing = _decorators(expected) - _decorators(actual)
    if missing:
        errors.append(f"`{label}` must keep the decorator(s): {', '.join('@' + d for d in sorted(missing))}.")
    return errors, warnings


def _compare_classes(expected: ast.ClassDef, actual: ast.ClassDef, strict: bool) -> tuple[list[str], list[str]]:
    name = expected.name
    errors: list[str] = []
    warnings: list[str] = []
    want_bases = [_norm_default(_src(b)) for b in expected.bases]
    got_bases = [_norm_default(_src(b)) for b in actual.bases]
    if want_bases != got_bases and not (not want_bases and got_bases == ["object"]):
        listed = ", ".join(ast.unparse(b) for b in expected.bases)
        errors.append(f"`{name}` must inherit from {listed}." if listed else f"`{name}` must not inherit from another class.")
    missing = _decorators(expected) - _decorators(actual)
    if missing:
        errors.append(f"`{name}` must keep the decorator(s): {', '.join('@' + d for d in sorted(missing))}.")

    def fields(node: ast.ClassDef) -> list[str]:
        return [s.target.id for s in node.body if isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name)]

    absent = [f for f in fields(expected) if f not in set(fields(actual))]
    if absent:
        errors.append(f"`{name}` must declare the field(s): {', '.join(absent)}.")
    methods = {s.name: s for s in actual.body if isinstance(s, FUNC_TYPES)}
    for method in (s for s in expected.body if isinstance(s, FUNC_TYPES)):
        found = methods.get(method.name)
        if found is None:
            errors.append(f"`{name}` must define the method `{method.name}`.")
            continue
        more_errors, more_warnings = _compare_functions(method, found, f"{name}.{method.name}", strict)
        errors += more_errors
        warnings += more_warnings
    return errors, warnings


def _short(text: str, limit: int = 60) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 3] + "..."


class PythonAdapter:
    name = "python"
    display_name = "Python"
    fence = "python"
    comment_prefix = "#"
    source_suffixes = (".py",)

    # -- contracts

    def _signature_node(self, signature: str, where: str, name: str | None = None):
        try:
            module = _parse_snippet(signature)
        except SyntaxError:
            raise SpecError(
                f"{where}: cannot parse the signature. Write a `def ...` line, or a class "
                "skeleton whose method bodies are `...`."
            ) from None
        defs = [n for n in module.body if isinstance(n, DEF_TYPES)]
        if len(defs) != 1:
            raise SpecError(f"{where}: the signature must contain exactly one def or class.")
        if name is not None and defs[0].name != name:
            raise SpecError(f"{where}: the signature defines `{defs[0].name}` but the target name is `{name}`.")
        return defs[0]

    def _expected(self, unit: Unit):
        return self._signature_node(unit.signature or "", unit.id, unit.target_name)

    def infer_kind(self, signature: str, where: str) -> str:
        node = self._signature_node(signature, where)
        return "class" if isinstance(node, ast.ClassDef) else "function"

    def check_contract(self, unit: Unit) -> list[str]:
        errors: list[str] = []
        if unit.kind in ("function", "class"):
            try:
                node = self._expected(unit)
                if (unit.kind == "class") != isinstance(node, ast.ClassDef):
                    errors.append(f"{unit.id}: kind is `{unit.kind}` but the signature does not define a {unit.kind}.")
            except SpecError as exc:
                errors.append(str(exc))
        if unit.code is not None and unit.target_file.endswith(".py"):
            problem = self.syntax_error(unit.code)
            if problem:
                errors.append(f"{unit.id}: provided code does not compile: {problem}")
            elif unit.target_name and unit.target_name not in self.defined_names(unit.code):
                errors.append(f"{unit.id}: provided code does not define `{unit.target_name}`.")
            elif unit.kind != "file" and re.search(r"^\s*from\s+__future__\s+import", unit.code, re.M):
                errors.append(
                    f"{unit.id}: provided code must not contain `from __future__` imports; the file "
                    "header already has `from __future__ import annotations`."
                )
        for line in unit.imports:
            try:
                tree = ast.parse(line.strip())
            except SyntaxError:
                errors.append(f"{unit.id}: cannot parse import {line!r}.")
                continue
            if len(tree.body) != 1 or not isinstance(tree.body[0], (ast.Import, ast.ImportFrom)):
                errors.append(f"{unit.id}: each `imports` entry must be one import statement: {line!r}.")
        return errors

    def definition_pattern(self, name: str) -> re.Pattern[str]:
        return re.compile(rf"^\s*(?:async\s+def|def|class)\s+{re.escape(name)}\b", re.M)

    # -- files

    def render_stub(self, unit: Unit) -> str:
        node = copy.deepcopy(self._expected(unit))
        stub = ast.parse(f"raise NotImplementedError({f'{STUB_MARK} {unit.id}'!r})").body[0]
        if isinstance(node, ast.ClassDef):
            body = []
            for stmt in node.body:
                if isinstance(stmt, FUNC_TYPES):
                    stmt.body = [copy.deepcopy(stub)]
                    body.append(stmt)
                elif not _is_ellipsis(stmt):
                    body.append(stmt)
            node.body = body or [ast.Pass()]
        else:
            node.body = [stub]
        return ast.unparse(ast.fix_missing_locations(node))

    def render_header(self, imports: list[str]) -> str:
        """The file header: `from __future__ import annotations`, then the units' imports.

        Postponed annotations are always on, so a signature may name a class that is
        defined later in the file (or the class itself) without breaking the import.
        """
        lines: list[str] = [FUTURE_ANNOTATIONS]
        for line in imports:
            line = line.strip()
            if line and line not in lines:
                lines.append(line)
        future = [line for line in lines if line.startswith("from __future__")]
        return "\n".join(future + [line for line in lines if line not in future])

    def module_names(self, project: Project) -> list[str]:
        """Importable module names of the project's Python files (never `__main__`)."""
        roots = [tuple(p for p in r.replace("\\", "/").split("/") if p not in ("", ".")) for r in project.source_roots]
        names: list[str] = []
        for target in sorted({u.target_file for u in project.units.values()}):
            if not target.endswith(".py"):
                continue
            parts = target[:-3].split("/")
            base = next((len(r) for r in roots if r and tuple(parts[: len(r)]) == r), 0)
            parts = parts[base:]
            if parts and parts[-1] == "__init__":
                parts = parts[:-1]
            if parts and parts[-1] != "__main__" and all(p.isidentifier() for p in parts):
                names.append(".".join(parts))
        return names

    def header_names(self, imports: list[str]) -> set[str]:
        names: set[str] = set()
        for line in imports:
            try:
                tree = ast.parse(line.strip())
            except SyntaxError:
                continue
            for node in tree.body:
                if isinstance(node, ast.Import):
                    names |= {alias.asname or alias.name.split(".")[0] for alias in node.names}
                elif isinstance(node, ast.ImportFrom):
                    names |= {alias.asname or alias.name for alias in node.names if alias.name != "*"}
        return names

    def init_files(self, project: Project) -> list[str]:
        """__init__.py files needed so every target module is importable."""
        if not project.auto_init:
            return []
        roots = [tuple(p for p in r.replace("\\", "/").split("/") if p not in ("", ".")) for r in project.source_roots]
        targets = {unit.target_file for unit in project.units.values()}
        found: list[str] = []
        for target in sorted(targets):
            if not target.endswith(".py"):
                continue
            parts = target.split("/")[:-1]
            base = next((len(r) for r in roots if r and tuple(parts[: len(r)]) == r), 0)
            for depth in range(base + 1, len(parts) + 1):
                init = "/".join(parts[:depth] + ["__init__.py"])
                if init not in targets and init not in found:
                    found.append(init)
        return found

    def check_env(self, project: Project, workspace: Path, base: dict[str, str]) -> dict[str, str]:
        """Environment for checks: import path from source_roots, UTF-8, and no .pyc files.

        .pyc files are disabled because candidates are rewritten faster than the
        mtime-based cache check can notice, which would run stale code.
        """
        roots = [workspace / r for r in project.source_roots if r not in ("", ".")] + [workspace]
        paths = [str(p) for p in roots] + ([base["PYTHONPATH"]] if base.get("PYTHONPATH") else [])
        return {
            "PYTHONPATH": os.pathsep.join(paths),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONIOENCODING": "utf-8",
        }

    # -- checks on a candidate

    def syntax_error(self, code: str) -> str | None:
        try:
            compile(code, "<answer>", "exec", dont_inherit=True)
        except SyntaxError as exc:
            message = f"{type(exc).__name__}: {exc.msg} (line {exc.lineno})"
            if exc.text and exc.text.strip():
                message += f"\n    {exc.text.strip()}"
            return message
        except ValueError as exc:
            return f"Invalid source: {exc}"
        return None

    def sanitize(self, code: str, unit: Unit, reserved: set[str]) -> tuple[str, list[str]]:
        """Remove top-level code that would break the file or shadow existing names.

        Small models often add example usage, a __main__ block, or a copy of a
        dependency they were shown. Removing those is deterministic and saves a
        retry. Returns the cleaned code and a note for each removal.
        """
        # Split exactly where Python counts lines. str.splitlines() also splits on form feeds,
        #   and others, which would shift line numbers and remove the wrong lines.
        code = code.replace("\r\n", "\n").replace("\r", "\n")
        tree = ast.parse(code)
        kept: set[int] = set()
        drops: list[tuple[range, str]] = []
        for node in tree.body:
            start = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
            span = range(start, (node.end_lineno or node.lineno) + 1)
            reason = self._drop_reason(node, unit, reserved)
            if reason:
                drops.append((span, reason))
            else:
                kept.update(span)
        removed: set[int] = set()
        notes: list[str] = []
        for span, reason in drops:
            if kept.intersection(span):  # shares a line with code we keep; leave it alone
                continue
            removed.update(span)
            notes.append(reason)
        if not removed:
            return code, []
        # Blank lines are kept as they are: collapsing them could change string literals.
        lines = [line for number, line in enumerate(code.split("\n"), start=1) if number not in removed]
        return "\n".join(lines).strip("\n"), notes

    @staticmethod
    def _drop_reason(node: ast.stmt, unit: Unit, reserved: set[str]) -> str | None:
        if isinstance(node, ast.ImportFrom) and node.module == "__future__":
            return "removed a `from __future__` import (the file header already has `from __future__ import annotations`)"
        if _is_main_guard(node):
            return 'removed the `if __name__ == "__main__":` block'
        if isinstance(node, ast.Expr) and not isinstance(node.value, ast.Constant):
            return f"removed the top-level statement `{_short(ast.unparse(node))}`"
        if isinstance(node, ast.Assert):
            return f"removed the top-level `{_short(ast.unparse(node))}`"
        if isinstance(node, DEF_TYPES) and node.name != unit.target_name and node.name in reserved:
            return f"removed a redefinition of `{node.name}` (it already exists)"
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            clashing = sorted(_assigned_names(node) & reserved)
            if clashing:
                return f"removed a redefinition of `{clashing[0]}` (it already exists)"
        return None

    def signature_check(self, code: str, unit: Unit, strict: bool) -> tuple[list[str], list[str]]:
        expected = self._expected(unit)
        tree = ast.parse(code)
        found = [n for n in tree.body if isinstance(n, DEF_TYPES) and n.name == unit.target_name]
        if not found:
            return [f"Your code must define `{unit.target_name}` at the top level, not inside another function or class."], []
        actual = found[-1]
        warnings = [f"`{unit.target_name}` is defined more than once; the last definition counts."] if len(found) > 1 else []
        if isinstance(expected, ast.ClassDef) != isinstance(actual, ast.ClassDef):
            want = "a class" if isinstance(expected, ast.ClassDef) else "a function"
            return [f"`{unit.target_name}` must be {want}."], warnings
        if isinstance(expected, ast.ClassDef):
            errors, more = _compare_classes(expected, actual, strict)
        else:
            errors, more = _compare_functions(expected, actual, unit.target_name or "", strict)
        return errors, warnings + more

    def defined_names(self, code: str) -> set[str]:
        """Top-level names a piece of code binds (functions, classes, variables; not imports)."""
        try:
            tree = ast.parse(code)
        except SyntaxError:
            return set()
        names: set[str] = set()
        for node in tree.body:
            if isinstance(node, DEF_TYPES):
                names.add(node.name)
            else:
                names |= _assigned_names(node)
        return names

    def import_errors(self, code: str, allow_stdlib: bool, allowed: set[str], internal: set[str]) -> list[str]:
        bad: list[str] = []
        for node in ast.walk(ast.parse(code)):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
                modules = [node.module]
            else:
                continue
            for module in modules:
                top = module.split(".")[0]
                if top in internal or top in allowed or top == "__future__":
                    continue
                if allow_stdlib and top in sys.stdlib_module_names:
                    continue
                if module not in bad:
                    bad.append(module)
        if not bad:
            return []
        options = (["the Python standard library"] if allow_stdlib else []) + sorted(allowed)
        if internal:
            options.append("this project's packages (" + ", ".join(sorted(internal)) + ")")
        listed = ", ".join(f"`{m}`" for m in bad)
        return [f"Importing {listed} is not allowed. You may import: {', '.join(options) or 'nothing'}."]

    def locate(self, output: str, cwd: Path) -> list[tuple[Path, int]]:
        """(file, line) for every traceback frame in tool output, outermost first."""
        frames: list[tuple[Path, int]] = []
        for line in output.splitlines():
            for pattern in _TRACE_RES:
                match = pattern.match(line)
                if match:
                    path = Path(match.group("path"))
                    frames.append((path if path.is_absolute() else cwd / path, int(match.group("line"))))
                    break
        return frames
