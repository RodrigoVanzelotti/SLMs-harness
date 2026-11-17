"""TypeScript adapter: signatures, stubs, sanitizing, and static checks.

Parsing is done by the TypeScript compiler itself, through a small Node.js helper
(ts_helper.cjs) that runs for the lifetime of the harness process. The helper
only parses text; it never runs the code. It needs Node.js on PATH and the
`typescript` package, found in this order: the HARNESS_TYPESCRIPT environment
variable, the project folder's node_modules, the global npm folder.
"""

from __future__ import annotations

import atexit
import fnmatch
import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..constants import STUB_MARK
from ..errors import HarnessError, SpecError

if TYPE_CHECKING:
    from ..spec import Project, Unit

HELPER = Path(__file__).with_name("ts_helper.cjs")
DECLARATIONS = ("function", "class", "variable", "interface", "type", "enum", "module")
VALUE_KINDS = ("function", "class", "variable", "enum")
TYPE_KINDS = ("interface", "type")
_CACHE_LIMIT = 4096
_FRAME_RE = re.compile(
    r"(?P<path>(?:file:///)?(?:[A-Za-z]:)?[^\s():'\"`]+?\.(?:[cm]?[jt]sx?))(?::(?P<line>\d+)(?::\d+)?|\((?P<tsc>\d+),\d+\))"
)  # `file:line:col` in stack traces, and `file(line,col)` in tsc output


def _norm(text: str | None) -> str | None:
    """Loose text form for comparing types and decorators: no whitespace, one quote style."""
    if text is None:
        return None
    text = re.sub(r"\s+", "", text).replace('"', "'").replace("`", "'")
    text = re.sub(r"[,;](?=[)\]}>])", "", text)
    return text.replace(";", ",")


def _short(text: str, limit: int = 60) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _param_list(params: list[dict[str, Any]]) -> str:
    parts = []
    for p in params:
        text = ("..." if p["rest"] else "") + p["name"] + ("?" if p["question"] else "")
        if p["type"]:
            text += f": {p['type']}"
        if p["init"] is not None:
            text += f" = {p['init']}"
        parts.append(text)
    return ", ".join(parts)


class _Helper:
    """The Node.js process that parses TypeScript for the adapter."""

    def __init__(self, search: list[Path]):
        self.search = search
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()
        self.next_id = 0
        self.info: dict[str, Any] | None = None

    def _start(self) -> None:
        node = shutil.which("node")
        if node is None:
            raise HarnessError("The TypeScript adapter needs Node.js. Install it and make sure `node` is on PATH.")
        env = dict(os.environ)
        env["HARNESS_TS_SEARCH"] = os.pathsep.join(str(p) for p in self.search)
        self.proc = subprocess.Popen(
            [node, str(HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=env, text=True, encoding="utf-8", bufsize=1,
        )
        atexit.register(self.close)

    def call(self, op: str, **payload: Any) -> Any:
        with self.lock:
            for attempt in (1, 2):  # a crashed helper is restarted once
                if self.proc is None or self.proc.poll() is not None:
                    self._start()
                assert self.proc is not None and self.proc.stdin and self.proc.stdout
                self.next_id += 1
                request = json.dumps({"id": self.next_id, "op": op, **payload})
                try:
                    self.proc.stdin.write(request + "\n")
                    self.proc.stdin.flush()
                    line = self.proc.stdout.readline()
                except (BrokenPipeError, OSError):
                    line = ""
                if not line:
                    self.close()
                    if attempt == 2:
                        raise HarnessError("The TypeScript helper stopped unexpectedly.")
                    continue
                response = json.loads(line)
                if response.get("ok"):
                    return response["result"]
                if response.get("setup"):
                    raise HarnessError(response["error"])
                raise HarnessError(f"The TypeScript helper failed on `{op}`: {response.get('error')}")
        raise HarnessError("The TypeScript helper stopped unexpectedly.")

    def close(self) -> None:
        proc, self.proc = self.proc, None
        if proc is not None and proc.poll() is None:
            try:
                proc.stdin.close()  # type: ignore[union-attr]
                proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                proc.kill()


class TypeScriptAdapter:
    name = "typescript"
    display_name = "TypeScript"
    fence = "typescript"
    comment_prefix = "//"
    source_suffixes = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
    stdlib_name = "Node.js built-in modules (node:*)"

    def __init__(self, root: Path | None = None):
        search = [Path(root)] if root is not None else []
        self._helper = _Helper(search + [Path.cwd()])
        self._cache: dict[tuple[str, str, str], Any] = {}

    # -- helper access

    def _cached(self, op: str, code: str, path: str, **extra: Any) -> Any:
        key = (op, path, code + "\0" + json.dumps(extra, sort_keys=True))
        if key not in self._cache:
            if len(self._cache) >= _CACHE_LIMIT:
                self._cache.clear()
            self._cache[key] = self._helper.call(op, code=code, path=path, **extra)
        return self._cache[key]

    def _analyze(self, code: str, path: str = "") -> dict[str, Any]:
        return self._cached("analyze", code, path or "answer.ts")

    def builtins(self) -> set[str]:
        if self._helper.info is None:
            self._helper.info = self._helper.call("hello")
        return set(self._helper.info["builtins"])

    @staticmethod
    def _declarations(analysis: dict[str, Any], name: str | None = None) -> list[dict[str, Any]]:
        found = [s for s in analysis["statements"] if s["kind"] in DECLARATIONS]
        return found if name is None else [s for s in found if name in s["names"]]

    # -- contracts

    def _signature_decl(self, signature: str, where: str, name: str | None = None) -> dict[str, Any]:
        analysis = self._analyze(signature, "signature.ts")
        if analysis["diagnostics"]:
            first = analysis["diagnostics"][0]
            raise SpecError(f"{where}: cannot parse the signature: {first['message']} (line {first['line']}).")
        decls = self._declarations(analysis)
        names = {n for d in decls for n in d["names"]}
        values = [d for d in decls if d["kind"] in VALUE_KINDS]
        # Several declarations of one name are allowed when TypeScript merges them: a const and a
        # type, or an interface and a class. The value declaration is the one the unit implements.
        if not decls or len(names) != 1 or any(len(d["names"]) != 1 for d in decls) or len(values) > 1:
            raise SpecError(f"{where}: the signature must contain exactly one declaration (function, class, const, type, ...).")
        decl = values[0] if values else decls[0]
        if name is not None and decl["names"][0] != name:
            raise SpecError(f"{where}: the signature declares `{decl['names'][0]}` but the target name is `{name}`.")
        return decl

    def _expected(self, unit: Unit) -> dict[str, Any]:
        return self._signature_decl(unit.signature or "", unit.id, unit.target_name)

    def infer_kind(self, signature: str, where: str) -> str:
        decl = self._signature_decl(signature, where)
        if decl["kind"] == "function":
            return "function"
        if decl["kind"] == "class":
            return "class"
        return "declaration"

    def check_contract(self, unit: Unit) -> list[str]:
        errors: list[str] = []
        if unit.kind in ("function", "class", "declaration"):
            try:
                decl = self._expected(unit)
                expected_kinds = {"function": ("function",), "class": ("class",)}.get(
                    unit.kind, ("variable", "interface", "type", "enum", "module"))
                if decl["kind"] not in expected_kinds:
                    errors.append(f"{unit.id}: kind is `{unit.kind}` but the signature declares a {decl['kind']}.")
                elif unit.kind == "declaration" and unit.type != "provided":
                    if decl["kind"] != "variable":
                        errors.append(f"{unit.id}: types, interfaces and enums are written by the planner; make it `provided`.")
                    elif decl["hasInit"]:
                        errors.append(f"{unit.id}: the signature of a constant must not contain its value; write `export const NAME: Type`.")
                    elif not decl["type"]:
                        errors.append(f"{unit.id}: give the constant a type in the signature, e.g. `export const NAME: Type`.")
            except SpecError as exc:
                errors.append(str(exc))
        if unit.code is not None and Path(unit.target_file).suffix.lower() in self.source_suffixes:
            problem = self.syntax_error(unit.code, unit.target_file)
            if problem:
                errors.append(f"{unit.id}: provided code does not parse: {problem}")
            elif unit.target_name and unit.target_name not in self.defined_names(unit.code, unit.target_file):
                errors.append(f"{unit.id}: provided code does not define `{unit.target_name}`.")
        for line in unit.imports:
            problem = self._import_line_problem(line)
            if problem:
                errors.append(f"{unit.id}: {problem}: {line!r}.")
        return errors

    def _import_line_problem(self, line: str) -> str | None:
        analysis = self._analyze(line.strip(), "header.ts")
        if analysis["diagnostics"]:
            return "cannot parse import"
        statements = analysis["statements"]
        if len(statements) != 1 or statements[0]["kind"] not in ("import", "export", "directive"):
            return "each `imports` entry must be one import, one `export ... from`, or a directive like 'use client'"
        if statements[0]["kind"] == "export" and not statements[0]["module"] and not statements[0]["named"]:
            return "an `imports` entry cannot export a declaration"
        return None

    def header_problems(self, imports: list[str]) -> list[str]:
        """Names bound twice by the merged header (a TypeScript error, and a crash at run time)."""
        owners: dict[str, str] = {}
        problems: list[str] = []
        for line in dict.fromkeys(i.strip() for i in imports if i.strip()):
            if self._import_line_problem(line):
                continue
            statement = self._analyze(line, "header.ts")["statements"][0]
            if statement["kind"] != "import":
                continue
            for item in self._bindings(statement):
                source = f"{item['module']}:{item['imported']}"
                if owners.setdefault(item["local"], source) != source:
                    problems.append(f"`{item['local']}` is imported from two different places ({owners[item['local']]} and {source}).")
        return problems

    def is_type_only(self, signature: str) -> bool:
        """True for a signature that declares only a type (interface or type alias): no import is needed to use it."""
        decls = self._declarations(self._analyze(signature, "signature.ts"))
        return len(decls) == 1 and decls[0]["kind"] in TYPE_KINDS

    def type_names(self, signature: str) -> set[str]:
        """Names a signature uses as types (not decorator arguments or default values)."""
        return set(self._cached("typeNames", signature, "signature.ts")["names"])

    def definition_pattern(self, name: str) -> re.Pattern[str]:
        return re.compile(
            r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?"
            rf"(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+{re.escape(name)}\b",
            re.M,
        )

    # -- files

    def render_stub(self, unit: Unit) -> str:
        self._expected(unit)
        result = self._cached("stub", (unit.signature or "").strip(), "signature.ts",
                              message=f"{STUB_MARK} {unit.id}")
        return result["text"]

    @staticmethod
    def _bindings(statement: dict[str, Any]) -> list[dict[str, Any]]:
        module = statement["module"]
        items = []
        if statement["defaultName"]:
            items.append({"local": statement["defaultName"], "imported": "default", "module": module})
        if statement["namespaceName"]:
            items.append({"local": statement["namespaceName"], "imported": "*", "module": module})
        for named in statement["named"]:
            items.append({"local": named["local"], "imported": named["imported"], "module": module})
        return items

    def render_header(self, imports: list[str]) -> str:
        """Directives first, then the units' imports merged per module, then re-exports.

        Merging matters: two lines that bind the same name would be a duplicate
        declaration. A name stays type-only only if every line imports it as a type.
        Lines that do not parse are kept as written; validate reports them.
        """
        directives: list[str] = []
        groups: dict[str, dict[str, Any]] = {}
        exports: list[str] = []
        unparsed: list[str] = []
        for raw in imports:
            line = raw.strip()
            if not line:
                continue
            if self._import_line_problem(line):
                if line not in unparsed:
                    unparsed.append(line)
                continue
            statement = self._analyze(line, "header.ts")["statements"][0]
            if statement["kind"] == "directive":
                text = f"'{statement['value']}';"
                if text not in directives:
                    directives.append(text)
                continue
            if statement["kind"] == "export":
                text = line if line.endswith(";") else line + ";"
                if text not in exports:
                    exports.append(text)
                continue
            group = groups.setdefault(statement["module"], {"default": None, "namespace": None, "named": {}, "side": False})
            whole_type = statement["typeOnly"]
            group["side"] = group["side"] or statement["sideEffect"]
            for key, value in (("default", statement["defaultName"]), ("namespace", statement["namespaceName"])):
                if value:
                    old = group[key]
                    group[key] = (value, (old[1] if old else True) and whole_type)
            for named in statement["named"]:
                is_type = whole_type or named["typeOnly"]
                old = group["named"].get(named["local"])
                group["named"][named["local"]] = (named["imported"], (old[1] if old else True) and is_type)
        lines = list(directives)
        for module, group in groups.items():
            quoted = "'" + module.replace("'", "\\'") + "'"
            default, named = group["default"], group["named"]
            all_types = bool(named or default) and all(t for _, t in named.values()) and (default is None or default[1])
            keyword = "import type" if all_types and not (default and named) else "import"
            clauses = []
            if default:
                clauses.append(default[0])
            if named:
                parts = []
                for local, (imported, is_type) in named.items():
                    text = imported if imported == local else f"{imported} as {local}"
                    parts.append(("type " if is_type and keyword == "import" else "") + text)
                clauses.append("{ " + ", ".join(parts) + " }")
            if clauses:
                lines.append(f"{keyword} {', '.join(clauses)} from {quoted};")
            if group["namespace"]:
                ns, ns_type = group["namespace"]
                lines.append(f"{'import type' if ns_type else 'import'} * as {ns} from {quoted};")
            if not clauses and not group["namespace"] and group["side"]:
                lines.append(f"import {quoted};")
        return "\n".join(lines + exports + unparsed)

    def header_names(self, imports: list[str]) -> set[str]:
        names: set[str] = set()
        for line in imports:
            line = line.strip()
            if not line or self._import_line_problem(line):
                continue
            statement = self._analyze(line, "header.ts")["statements"][0]
            if statement["kind"] == "import":
                names |= set(statement["names"])
        return names

    def init_files(self, project: Project) -> list[str]:
        return []

    def module_names(self, project: Project) -> list[str]:
        return []  # no import check; use checks.preflight to load the workspace before a run

    def check_env(self, project: Project, workspace: Path, base: dict[str, str]) -> dict[str, str]:
        """Plain, non-interactive tool output: no colors, no watch mode."""
        return {"FORCE_COLOR": "0", "NO_COLOR": "1", "CI": "1"}

    # -- checks on a candidate

    def syntax_error(self, code: str, path: str = "") -> str | None:
        problems = self._analyze(code, path)["diagnostics"][:3]
        if not problems:
            return None
        lines = []
        for d in problems:
            lines.append(f"SyntaxError: {d['message']} (line {d['line']})" + (f"\n    {d['text']}" if d["text"] else ""))
        return "\n".join(lines)

    def sanitize(self, code: str, unit: Unit, reserved: set[str]) -> tuple[str, list[str]]:
        """Remove top-level code that would break the file or clash with existing names.

        Small models often add example usage, a 'use client' directive, imports that
        the file header already has, or a copy of a dependency they were shown.
        """
        code = code.replace("\r\n", "\n").replace("\r", "\n")
        analysis = self._analyze(code, unit.target_file)
        lines = code.split("\n")
        target = unit.target_name
        target_exported = any(
            target in s["names"] and (s["exported"] or s["default"]) for s in self._declarations(analysis))
        kept: set[int] = set()
        drops: list[tuple[range, str]] = []
        replacements: dict[int, tuple[range, str]] = {}
        for statement in analysis["statements"]:
            span = range(statement["start"], statement["end"] + 1)
            reason = None
            kind = statement["kind"]
            if kind == "directive":
                reason = f"removed the '{statement['value']}' directive (file-level directives belong in the file header)"
            elif kind == "expression":
                reason = f"removed the top-level statement `{_short(statement['text'])}`"
            elif kind == "import" and statement["names"]:
                clashing = [n for n in statement["names"] if n in reserved]
                if clashing and len(clashing) == len(statement["names"]):
                    reason = f"removed an import of {', '.join(f'`{n}`' for n in clashing)} (the file header already imports it)"
                elif clashing:
                    rest = dict(statement, named=[n for n in statement["named"] if n["local"] not in reserved],
                                defaultName=None if statement["defaultName"] in reserved else statement["defaultName"],
                                namespaceName=None if statement["namespaceName"] in reserved else statement["namespaceName"])
                    rewritten = self.render_header([self._import_text(rest)])
                    replacements[statement["start"]] = (span, rewritten)
                    drops.append((span, f"removed {', '.join(f'`{n}`' for n in clashing)} from an import (the file header already imports it)"))
                    continue
            elif kind in DECLARATIONS and statement["names"]:
                clashing = sorted(set(statement["names"]) & reserved)
                if clashing and target not in statement["names"]:
                    reason = f"removed a redefinition of `{clashing[0]}` (it already exists)"
            elif kind == "export" and not statement["module"] and target_exported:
                if statement["named"] and all(n["local"] == target for n in statement["named"]):
                    reason = f"removed `{_short(statement['text'])}` (`{target}` is already exported)"
            elif kind == "export-assignment" and target_exported and statement["identifier"] == target:
                reason = f"removed `{_short(statement['text'])}` (`{target}` is already exported)"
            if reason:
                drops.append((span, reason))
            else:
                kept.update(span)
        removed: set[int] = set()
        notes: list[str] = []
        inserted: dict[int, str] = {}
        for span, reason in drops:
            if kept.intersection(span):  # shares a line with code we keep; leave it alone
                continue
            removed.update(span)
            notes.append(reason)
            if span.start in replacements:
                inserted[span.start] = replacements[span.start][1]
        if not removed:
            return code, []
        out: list[str] = []
        for number, line in enumerate(lines, start=1):
            if number in inserted:
                out.append(inserted[number])
            if number not in removed:
                out.append(line)
        return "\n".join(out).strip("\n"), notes

    @staticmethod
    def _import_text(statement: dict[str, Any]) -> str:
        keyword = "import type" if statement["typeOnly"] else "import"
        clauses = []
        if statement["defaultName"]:
            clauses.append(statement["defaultName"])
        if statement["named"]:
            parts = [("type " if n["typeOnly"] else "") + (n["imported"] if n["imported"] == n["local"]
                     else f"{n['imported']} as {n['local']}") for n in statement["named"]]
            clauses.append("{ " + ", ".join(parts) + " }")
        if statement["namespaceName"]:
            clauses.append(f"* as {statement['namespaceName']}")
        module = "'" + statement["module"].replace("'", "\\'") + "'"
        if not clauses:
            return f"import {module};"
        return f"{keyword} {', '.join(clauses)} from {module};"

    def signature_check(self, code: str, unit: Unit, strict: bool) -> tuple[list[str], list[str]]:
        expected = self._expected(unit)
        analysis = self._analyze(code, unit.target_file)
        name = unit.target_name or ""
        found = self._declarations(analysis, name)
        if not found:
            return [f"Your code must declare `{name}` at the top level, not inside another function or block."], []
        actual = found[-1]
        warnings = [f"`{name}` is declared more than once; the last declaration counts."] if len(found) > 1 else []
        errors: list[str] = []
        soft = errors if strict else warnings

        exported, default = actual["exported"], actual["default"]
        for s in analysis["statements"]:
            if s["kind"] == "export" and not s["module"]:
                for item in s["named"]:
                    if item["local"] == name:
                        exported = True
                        default = default or item["exported"] == "default"
            elif s["kind"] == "export-assignment" and s["identifier"] == name:
                exported = default = True
        if expected["default"] and not default:
            errors.append(f"`{name}` must be the default export: write `export default` before it.")
        elif expected["exported"] and not exported:
            errors.append(f"`{name}` must be exported: write `export` before it.")

        if unit.kind == "function":
            fn = actual if actual["kind"] == "function" else (actual.get("fn") if actual["kind"] == "variable" else None)
            if fn is None:
                return errors + [f"`{name}` must be a function."], warnings
            more_errors, more_soft = self._compare_functions(expected, fn, name)
            errors += more_errors
            soft += more_soft
        elif unit.kind == "class":
            if actual["kind"] != "class":
                return errors + [f"`{name}` must be a class."], warnings
            more_errors, more_soft = self._compare_classes(expected, actual, name)
            errors += more_errors
            soft += more_soft
        else:
            want_type = expected["kind"] in TYPE_KINDS
            if want_type and actual["kind"] not in TYPE_KINDS:
                errors.append(f"`{name}` must be a type or an interface.")
            elif not want_type and actual["kind"] not in VALUE_KINDS:
                errors.append(f"`{name}` must be a value (a const), not a type.")
            elif expected.get("type") and _norm(expected["type"]) != _norm(actual.get("type")):
                soft.append(f"`{name}` should be declared with the type `{expected['type']}`.")
        return errors, warnings

    @staticmethod
    def _compare_functions(expected: dict[str, Any], actual: dict[str, Any], label: str) -> tuple[list[str], list[str]]:
        errors: list[str] = []
        soft: list[str] = []
        returns = expected.get("returnType") or ""
        if expected["async"] and not actual["async"]:
            errors.append(f"`{label}` must be `async`.")
        elif actual["async"] and not expected["async"] and returns and not returns.startswith("Promise"):
            errors.append(f"`{label}` must not be `async`.")
        if expected["generator"] != actual["generator"]:
            errors.append(f"`{label}` must {'' if expected['generator'] else 'not '}be a generator function.")
        want, got = expected["params"], actual["params"]
        shape = lambda ps: [(p["rest"], p["name"] if p["identifier"] else None) for p in ps]  # noqa: E731
        same_names = len(want) == len(got) and all(
            w[0] == g[0] and (w[1] is None or g[1] is None or w[1] == g[1]) for w, g in zip(shape(want), shape(got)))
        if not same_names:
            errors.append(f"`{label}` must take ({_param_list(want)}), but yours takes ({_param_list(got)}).")
        else:
            for w, g in zip(want, got):
                pname = w["name"] if w["identifier"] else "the destructured parameter"
                if w["init"] is not None and _norm(w["init"]) != _norm(g["init"]):
                    errors.append(f"Parameter `{pname}` of `{label}` must default to `{w['init']}`.")
                elif w["optional"] and not g["optional"] and not w["rest"]:
                    errors.append(f"Parameter `{pname}` of `{label}` must be optional.")
                elif not w["optional"] and g["optional"]:
                    errors.append(f"Parameter `{pname}` of `{label}` must not be optional or have a default value.")
                missing = sorted({_norm(d) for d in w["decorators"]} - {_norm(d) for d in g["decorators"]})
                if missing:
                    shown = [d for d in w["decorators"] if _norm(d) in missing]
                    errors.append(f"Parameter `{pname}` of `{label}` must keep the decorator(s): {', '.join('@' + d for d in shown)}.")
                if w["modifiers"] and not g["modifiers"]:
                    errors.append(f"Parameter `{pname}` of `{label}` must be a parameter property: `{' '.join(w['modifiers'])} {pname}`.")
                if w["type"] and _norm(w["type"]) != _norm(g["type"]):
                    soft.append(f"Parameter `{pname}` of `{label}` should be annotated `{w['type']}`.")
        if returns and _norm(returns) != _norm(actual.get("returnType")):
            soft.append(f"`{label}` should be annotated to return `{returns}`.")
        return errors, soft

    def _compare_classes(self, expected: dict[str, Any], actual: dict[str, Any], name: str) -> tuple[list[str], list[str]]:
        errors: list[str] = []
        soft: list[str] = []
        if _norm(expected["extends"]) != _norm(actual["extends"]):
            errors.append(f"`{name}` must extend `{expected['extends']}`." if expected["extends"]
                          else f"`{name}` must not extend another class.")
        missing_impl = [i for i in expected["implements"] if _norm(i) not in {_norm(x) for x in actual["implements"]}]
        if missing_impl:
            soft.append(f"`{name}` should implement {', '.join(f'`{i}`' for i in missing_impl)}.")
        if expected["abstract"] != actual["abstract"]:
            errors.append(f"`{name}` must {'' if expected['abstract'] else 'not '}be abstract.")
        missing = [d for d in expected["decorators"] if _norm(d) not in {_norm(x) for x in actual["decorators"]}]
        if missing:
            errors.append(f"`{name}` must keep the decorator(s): {', '.join('@' + d for d in missing)}.")
        compatible = {"method": ("method",), "constructor": ("constructor",), "get": ("get", "property"),
                      "set": ("set",), "property": ("property", "get")}
        for member in expected["members"]:
            if member["kind"] not in compatible:
                continue
            label = f"{name}.{member['name']}"
            match = [m for m in actual["members"] if m["name"] == member["name"]
                     and m["kind"] in compatible[member["kind"]] and m["static"] == member["static"]]
            if not match:
                what = {"constructor": "a constructor", "property": f"the property `{member['name']}`",
                        "get": f"the getter `{member['name']}`", "set": f"the setter `{member['name']}`"}
                errors.append(f"`{name}` must define {what.get(member['kind'], 'the method `' + member['name'] + '`')}"
                              + (" (static)" if member["static"] else "") + ".")
                continue
            found = match[-1]
            gone = [d for d in member["decorators"] if _norm(d) not in {_norm(x) for x in found["decorators"]}]
            if gone:
                errors.append(f"`{label}` must keep the decorator(s): {', '.join('@' + d for d in gone)}.")
            if member["kind"] in ("method", "constructor", "get", "set") and found["kind"] == member["kind"]:
                more_errors, more_soft = self._compare_functions(member, found, label)
                errors += more_errors
                soft += more_soft
            elif member["kind"] == "property" and member.get("type") and found["kind"] == "property":
                if _norm(member["type"]) != _norm(found.get("type")):
                    soft.append(f"`{label}` should have the type `{member['type']}`.")
        return errors, soft

    def defined_names(self, code: str, path: str = "") -> set[str]:
        """Top-level names a piece of code declares (not imports)."""
        try:
            analysis = self._analyze(code, path)
        except HarnessError:
            return set()
        names: set[str] = set()
        for statement in self._declarations(analysis):
            names |= set(statement["names"])
        return names

    def import_errors(self, code: str, allow_stdlib: bool, allowed: set[str], internal: set[str],
                      path: str = "") -> list[str]:
        builtins = self.builtins()
        bad: list[str] = []
        for item in self._analyze(code, path)["modules"]:
            spec = item["specifier"]
            if spec.startswith((".", "/")):
                continue
            if spec.startswith("node:") or spec.split("/")[0] in builtins:
                if allow_stdlib:
                    continue
            elif any(self._matches(spec, entry) for entry in internal | allowed):
                continue
            if spec not in bad:
                bad.append(spec)
        if not bad:
            return []
        options = (["Node.js built-in modules"] if allow_stdlib else []) + sorted(allowed)
        if internal:
            options.append("this project's packages (" + ", ".join(sorted(internal)) + ")")
        listed = ", ".join(f"`{m}`" for m in bad)
        return [f"Importing {listed} is not allowed. You may import: {', '.join(options) or 'nothing'}."]

    @staticmethod
    def _matches(spec: str, entry: str) -> bool:
        """`react` allows `react` and `react/jsx-runtime`; `@nestjs/*` allows every @nestjs package; `@/` allows `@/x`."""
        if entry.endswith("/") and spec.startswith(entry):
            return True
        if spec == entry or spec.startswith(entry + "/"):
            return True
        package = "/".join(spec.split("/")[:2]) if spec.startswith("@") else spec.split("/")[0]
        return fnmatch.fnmatchcase(package, entry) or fnmatch.fnmatchcase(spec, entry)

    def locate(self, output: str, cwd: Path) -> list[tuple[Path, int]]:
        """(file, line) for every stack frame in tool output, outermost first.

        JavaScript prints stacks innermost first, so each stack is reversed to
        match the order the orchestrator expects.
        """
        frames: list[tuple[Path, int]] = []
        for line in output.splitlines():
            for match in _FRAME_RE.finditer(line):
                raw = match.group("path")
                if raw.startswith("file:///"):
                    raw = raw[len("file:///"):] if re.match(r"file:///[A-Za-z]:", raw) else raw[len("file://"):]
                if "node_modules" in raw.replace("\\", "/").split("/") or raw.startswith("node:"):
                    continue
                path = Path(raw)
                line_no = int(match.group("line") or match.group("tsc"))
                frames.append((path if path.is_absolute() else cwd / path, line_no))
        return list(reversed(frames))
