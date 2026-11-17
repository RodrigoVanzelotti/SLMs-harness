"""The verification ladder. Cheap checks run first; the first failure stops it.

    extract -> syntax -> (sanitize) -> signature -> names -> imports    in memory
    -> configured commands (lint, type check) -> tests                  on disk

Every failure produces a short, trimmed message that goes into the fix prompt.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING, Sequence

import yaml

from . import dag
from .config import CommandCheck
from .constants import STUB_MARK
from .errors import HarnessError
from .text import extract_code, trim_output

if TYPE_CHECKING:
    from .config import Config
    from .spec import Project, Unit
    from .workspace import Workspace

STATIC_STAGES = ("extract", "syntax", "signature", "names", "imports")
_STUB_RE = re.compile(rf"{STUB_MARK} ([A-Za-z0-9_][A-Za-z0-9_.\-]*)")


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kill a process and everything it started, then reap it."""
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)  # the check runs in its own session
        except OSError:
            pass
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        pass


@dataclass
class Verdict:
    ok: bool
    stage: str  # failing stage, or the last stage when ok
    rank: int  # how far the candidate got; higher is better
    code: str | None = None
    error: str = ""
    notes: list[str] = field(default_factory=list)
    repairs: list[str] = field(default_factory=list)  # what sanitize removed
    spec_problem: str | None = None  # set when retrying cannot help
    seconds: float = 0.0


def data_syntax_error(target_file: str, content: str) -> str | None:
    suffix = Path(target_file).suffix.lower()
    try:
        if suffix == ".json":
            json.loads(content)
        elif suffix in (".yaml", ".yml"):
            yaml.safe_load(content)
        elif suffix == ".toml":
            tomllib.loads(content)
    except Exception as exc:  # each parser raises its own error type
        return f"{suffix[1:].upper()} parse error: {exc}"
    return None


class Checker:
    def __init__(self, project: Project, config: Config, adapter, workspace: Workspace):
        self.project = project
        self.config = config
        self.adapter = adapter
        self.workspace = workspace
        self.stages = list(STATIC_STAGES) + [c.name for c in config.checks.commands] + ["tests"]
        self.allowed = set(project.allowed_imports)
        self.internal = set(project.packages)

    def rank(self, stage: str) -> int:
        return self.stages.index(stage)

    # -- running commands

    def _expand(self, value: str, file: Path | None = None) -> str:
        return (
            value.replace("{python}", sys.executable)
            .replace("{workspace}", str(self.workspace.root.resolve()))
            .replace("{project}", str(self.project.root))
            .replace("{file}", str(file) if file else "")
        )

    @property
    def cwd(self) -> Path:
        return Path(self._expand(self.config.checks.cwd))

    def inherits(self, name: str) -> bool:
        """Whether checks may see an inherited environment variable (they run model-written code)."""
        upper = name.upper()
        if self.config.model.api_key_env and upper == self.config.model.api_key_env.upper():
            return False
        if any(fnmatch.fnmatchcase(upper, p.upper()) for p in self.config.checks.secret_env_patterns):
            return False
        return any(fnmatch.fnmatchcase(upper, p.upper()) for p in self.config.checks.inherit_env)

    def env(self) -> dict[str, str]:
        """Allowed inherited variables, then language defaults, then checks.env."""
        env = {key: value for key, value in os.environ.items() if self.inherits(key)}
        env.update(self.adapter.check_env(self.project, self.workspace.root.resolve(), env))
        for key, value in self.config.checks.env.items():
            if isinstance(value, list):
                parts = [self._expand(str(v)) for v in value]
                if env.get(key) and key.upper().endswith("PATH"):
                    parts.append(env[key])
                env[key] = os.pathsep.join(parts)
            else:
                env[key] = self._expand(str(value))
        return env

    def run_command(self, check: CommandCheck, file: Path | None = None,
                    tests: Sequence[Path] = ()) -> tuple[bool, str]:
        """Run a check and return (passed, output).

        Output goes to a temporary file instead of pipes, and a timeout kills the
        whole process tree. With pipes, a process started by the code under test
        could keep the harness waiting long after the timeout.
        """
        argv: list[str] = []
        for part in check.command:
            if part == "{tests}":
                argv.extend(str(t) for t in tests)
            else:
                argv.append(self._expand(part, file))
        self.cwd.mkdir(parents=True, exist_ok=True)
        env = self.env()
        with tempfile.TemporaryDirectory(prefix="harness-check-", ignore_cleanup_errors=True) as tmp:
            with (Path(tmp) / "output.txt").open("w+b") as out:
                try:
                    proc = subprocess.Popen(
                        argv, cwd=self.cwd, env=env, stdin=subprocess.DEVNULL, stdout=out,
                        stderr=subprocess.STDOUT, start_new_session=os.name != "nt",
                    )
                except FileNotFoundError:
                    raise HarnessError(
                        f"The `{check.name}` check could not start `{argv[0]}`. "
                        "Install it or change the run config."
                    ) from None
                try:
                    code = proc.wait(timeout=check.timeout_s)
                    timed_out = False
                except subprocess.TimeoutExpired:
                    _kill_tree(proc)
                    timed_out = True
                except BaseException:  # Ctrl+C: do not leave the check running
                    _kill_tree(proc)
                    raise
                out.seek(0)
                output = out.read().decode("utf-8", errors="replace").strip()
        if timed_out:
            return False, (
                f"Timed out after {check.timeout_s:.0f}s. Look for an infinite loop or very slow code."
                + (f"\nOutput so far:\n{output}" if output else "")
            )
        return code == 0, output

    def run_tests(self, tests: Sequence[Path]) -> tuple[bool, str]:
        return self.run_command(self.config.checks.tests, tests=tests)

    def import_check(self) -> tuple[bool, str]:
        """Import every module of the workspace once, so a broken scaffold is caught before any model call.

        Skipped (returns ok) when the test command does not use the harness's own interpreter,
        since the target project's dependencies may only exist in that other environment.
        """
        modules = self.adapter.module_names(self.project)
        if not modules or self.config.checks.tests.command[0] != "{python}":
            return True, ""
        script = "import importlib, sys\nfor name in sys.argv[1:]:\n    importlib.import_module(name)"
        check = CommandCheck("import", ["{python}", "-c", script, *modules],
                             timeout_s=self.config.checks.tests.timeout_s)
        return self.run_command(check)

    def trim(self, text: str) -> str:
        return trim_output(
            text, self.config.budget.max_error_tokens, self.config.budget.chars_per_token,
            strip_paths=(self.workspace.root.resolve(), self.project.root),
        )

    @staticmethod
    def stub_ids(output: str) -> list[str]:
        """Units whose stub was reached, according to tool output."""
        return sorted(set(_STUB_RE.findall(output)))

    # -- the ladder

    def reserved_names(self, unit: Unit) -> set[str]:
        """Names the file already provides: header imports and the other units' targets."""
        file_units = self.project.files[unit.target_file]
        imports = [line for u in file_units for line in u.imports]
        others = {u.target_name for u in file_units if u.target_name and u.id != unit.id}
        return self.adapter.header_names(imports) | others

    def other_names(self, unit: Unit) -> set[str]:
        names: set[str] = set()
        for other in self.project.files[unit.target_file]:
            if other.id != unit.id:
                names |= self.adapter.defined_names(self.workspace.read_region(other) or "")
        return names

    def static_checks(self, unit: Unit, reply: str, finish_reason: str | None = None) -> Verdict:
        """Checks that need no files: extraction, syntax, signature, names, imports."""
        started = time.monotonic()
        cut_off = finish_reason == "length"

        def fail(stage: str, error: str, code: str | None = None, repairs=(), notes=()) -> Verdict:
            if cut_off:
                error += "\nYour reply was cut off because it was too long. Write shorter code."
            return Verdict(False, stage, self.rank(stage), code, with_repairs(error, repairs), list(notes),
                           list(repairs), seconds=time.monotonic() - started)

        prefer = self.adapter.definition_pattern(unit.target_name) if unit.target_name else None
        code = extract_code(reply, prefer)
        if code is None:
            return fail("extract", "Your reply did not contain a code block.")
        try:
            code.encode("utf-8")
        except UnicodeEncodeError:
            return fail("syntax", "Your code contains characters that cannot be saved as UTF-8.")
        is_source = Path(unit.target_file).suffix.lower() in self.adapter.source_suffixes
        problem = self.adapter.syntax_error(code) if is_source else data_syntax_error(unit.target_file, code)
        if problem:
            return fail("syntax", problem, code)

        repairs: list[str] = []
        notes: list[str] = []
        if unit.kind != "file":
            if self.config.checks.sanitize:
                code, repairs = self.adapter.sanitize(code, unit, self.reserved_names(unit))
            errors, notes = self.adapter.signature_check(code, unit, self.config.checks.strict_annotations)
            if errors:
                return fail("signature", "\n".join(errors), code, repairs, notes)
            clash = sorted(
                n for n in self.adapter.defined_names(code) & self.other_names(unit)
                if not (n.startswith("__") and n.endswith("__"))
            )
            if clash:
                listed = ", ".join(f"`{n}`" for n in clash)
                example = f"_{unit.target_name}_{clash[0].lstrip('_')}"
                return fail(
                    "names",
                    f"{listed} already exists elsewhere in this file. Rename your helper, for example to `{example}`.",
                    code, repairs, notes,
                )
        if is_source:
            errors = self.adapter.import_errors(code, self.project.allow_stdlib, self.allowed, self.internal)
            if errors:
                return fail("imports", "\n".join(errors), code, repairs, notes)
        return Verdict(True, "imports", self.rank("imports"), code, "", list(notes), list(repairs),
                       seconds=time.monotonic() - started)

    def dynamic_checks(self, unit: Unit, verdict: Verdict, tests: Sequence[Path]) -> Verdict:
        """Checks that need the candidate on disk: configured commands, then tests."""
        started = time.monotonic()
        target = self.workspace.path(unit.target_file)

        def finish(ok: bool, stage: str, error: str = "", spec_problem: str | None = None,
                   notes: Sequence[str] = ()) -> Verdict:
            return replace(
                verdict, ok=ok, stage=stage, rank=len(self.stages) if ok else self.rank(stage),
                error=with_repairs(error, verdict.repairs) if error else error,
                spec_problem=spec_problem, notes=verdict.notes + list(notes),
                seconds=verdict.seconds + time.monotonic() - started,
            )

        for check in self.config.checks.commands:
            if check.extensions and target.suffix.lower() not in {e.lower() for e in check.extensions}:
                continue
            ok, output = self.run_command(check, file=target)
            if not ok:
                return finish(False, check.name, f"`{check.name}` found problems:\n{self.trim(output)}")
        if not tests:
            return finish(True, "tests", notes=["No tests cover this unit; only static checks ran."])
        ok, output = self.run_command(self.config.checks.tests, file=target, tests=tests)
        if ok:
            return finish(True, "tests")

        error = f"Tests failed:\n{self.trim(output)}"
        spec_problem = None
        units = self.project.units
        reached = [uid for uid in self.stub_ids(output) if uid != unit.id and uid in units]
        if reached:
            called = [
                uid for uid in reached
                if units[uid].target_name
                and re.search(rf"\b{re.escape(units[uid].target_name)}\b", verdict.code or "")
            ]
            # Everything this unit depends on is finished before it runs, so a stub can only be
            # reached if it is outside the unit's dependency closure: the spec is missing a link.
            outside = [uid for uid in reached if uid not in dag.closure(units, [unit.id])]
            if called:
                names = ", ".join(f"`{units[uid].target_name}`" for uid in called)
                error += f"\nYour code uses {names}, which is not available yet. Do not use it."
            elif outside:
                listed = ", ".join(f"`{uid}`" for uid in outside)
                spec_problem = (
                    f"The tests reached {listed}, which is not implemented yet and is not a dependency of "
                    f"`{unit.id}`. Add it to `uses` or `after` of the unit whose tests reach it."
                )
        return finish(False, "tests", error, spec_problem)


def with_repairs(error: str, repairs: Sequence[str]) -> str:
    """Tell the model what sanitize changed, so it can see why its tested code differs from its reply."""
    if not repairs:
        return error
    return error + "\nBefore the checks, the harness changed your answer: " + "; ".join(repairs) + "."
