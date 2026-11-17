"""Static validation of a spec bundle before anything runs."""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from . import dag
from .errors import SpecError
from .prompts import Budget
from .text import estimate_tokens
from .workspace import safe_path

if TYPE_CHECKING:
    from .config import Config
    from .prompts import PromptBuilder
    from .spec import Project


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    budgets: list[Budget] = field(default_factory=list)


def validate(project: Project, config: Config, adapter, prompts: PromptBuilder) -> Report:
    report = Report()
    error, warn = report.errors.append, report.warnings.append
    units = project.units
    if not units:
        error("No units found in spec/contracts.")

    for unit in units.values():
        for dep in unit.deps:
            if dep == unit.id:
                error(f"{unit.id}: depends on itself.")
            elif dep not in units:
                error(f"{unit.id}: depends on unknown unit `{dep}`.")
    cycle = dag.find_cycle(units)
    if cycle:
        error("Dependency cycle: " + " -> ".join(cycle))

    sandbox = project.root / "runs" / "_validate"
    for unit in units.values():
        try:
            safe_path(sandbox, unit.target_file)
        except SpecError as exc:
            error(f"{unit.id}: {exc}")
        if unit.kind != "file" and Path(unit.target_file).suffix.lower() not in adapter.source_suffixes:
            error(f"{unit.id}: {unit.kind} units must target a {project.language} source file, not {unit.target_file}.")
        for test in unit.tests:
            _check_test_path(project, adapter, test, unit.id, error)
        report.errors.extend(adapter.check_contract(unit))
    _check_prompt_context(project, adapter, warn)

    folded: dict[str, str] = {}
    for rel in project.files:
        other = folded.setdefault(rel.lower(), rel)
        if other != rel:
            error(f"{rel} and {other} differ only by case; on Windows and macOS they are the same file.")
    for rel, file_units in project.files.items():
        if any(u.kind == "file" for u in file_units) and len(file_units) > 1:
            error(f"{rel}: a `file` unit must be the only unit targeting its file.")
        names = [u.target_name for u in file_units if u.target_name]
        for name in sorted({n for n in names if names.count(n) > 1}):
            error(f"{rel}: more than one unit defines `{name}`.")
        header_problems = getattr(adapter, "header_problems", None)
        if header_problems is not None and file_units[0].kind != "file":
            for problem in header_problems([line for u in file_units for line in u.imports]):
                error(f"{rel}: the merged imports conflict: {problem}")

    covered: set[str] = set()
    for milestone in project.milestones.values():
        covered |= dag.closure(units, milestone.after)
    for unit in units.values():
        if unit.type != "provided" and not unit.tests and unit.id not in covered:
            warn(f"{unit.id}: no tests and no milestone; only static checks will verify it.")
    for milestone in project.milestones.values():
        if not milestone.tests:
            error(f"milestone {milestone.id}: needs at least one test path.")
        for uid in milestone.after:
            if uid not in units:
                error(f"milestone {milestone.id}: unknown unit `{uid}`.")
        for test in milestone.tests:
            _check_test_path(project, adapter, test, f"milestone {milestone.id}", error)

    scaffold_files: set[str] = set()
    if project.scaffold_dir.is_dir():
        for source in project.scaffold_dir.rglob("*"):
            rel = source.relative_to(project.scaffold_dir).as_posix()
            if source.is_file():
                scaffold_files.add(rel)
                if rel in project.files:
                    error(f"spec/scaffold/{rel} collides with a unit target of the same path.")
    if project.tests_in_workspace:
        listed = [t for u in units.values() for t in u.tests] + [t for m in project.milestones.values() for t in m.tests]
        for test in sorted(set(listed)):
            if project.workspace_test_path(test) is None:
                error(f"{test}: with tests_in_workspace, every test path must be inside tests/.")
        if project.tests_dir.is_dir():
            for source in project.tests_dir.rglob("*"):
                rel = source.relative_to(project.tests_dir).as_posix()
                if source.is_file() and (rel in project.files or rel in scaffold_files):
                    error(f"tests/{rel} would be copied over {'a unit target' if rel in project.files else 'spec/scaffold/' + rel}.")

    cpt = config.budget.chars_per_token
    if estimate_tokens(project.conventions, cpt) > 300:
        warn("spec/conventions.md is over ~300 tokens; it is included in every prompt.")
    if estimate_tokens(project.digest, cpt) > 150:
        warn("The project digest is over ~150 tokens; it is included in every prompt.")
    if config.model.backend == "openai" and not config.model.model:
        error(f"{config.path.name}: model.model is empty.")
    for check in [*config.checks.commands, *config.checks.preflight, config.checks.tests]:
        exe = check.command[0]
        if "{" not in exe and shutil.which(exe) is None:
            warn(f"Check `{check.name}`: `{exe}` was not found on PATH.")

    if not report.errors:  # prompts need valid references
        for unit in units.values():
            if unit.type == "provided":
                continue
            budget = prompts.budget(unit)
            report.budgets.append(budget)
            if not budget.ok:
                error(
                    f"{unit.id}: the worst-case fix prompt is ~{budget.fix_prompt_tokens} tokens plus "
                    f"{budget.output_tokens} for the answer, over the limit of {budget.limit}. "
                    "Split the unit, shorten its contract, or raise the limits."
                )
    return report


def _check_prompt_context(project: Project, adapter, warn) -> None:
    """Warn about context the model will need but will not get.

    1. A unit uses a function from another file that no import brings into its file.
       (Classes are skipped: reading attributes of an instance needs no import.)
    2. A signature it will see mentions a project class that is not in its `uses`,
       so the model never sees that class's fields or methods.
    """
    units = project.units
    classes: dict[str, list[str]] = {}  # classes and other declarations (types, interfaces) by name
    for unit in units.values():
        if unit.kind in ("class", "declaration") and unit.target_name:
            classes.setdefault(unit.target_name, []).append(unit.id)
    for unit in units.values():
        if unit.type == "provided" or unit.kind == "file":
            continue
        imported = adapter.header_names([line for u in project.files[unit.target_file] for line in u.imports])
        is_type_only = getattr(adapter, "is_type_only", None)  # types need no import to be described
        for dep_id in unit.uses:
            dep = units.get(dep_id)
            if dep is None or dep.kind not in ("function", "declaration") or dep.target_file == unit.target_file:
                continue
            if dep.kind == "declaration" and is_type_only is not None and is_type_only(dep.signature or ""):
                continue
            if dep.target_name not in imported:
                warn(
                    f"{unit.id}: uses `{dep_id}` from {dep.target_file}, but no `imports` line in "
                    f"{unit.target_file} provides `{dep.target_name}`."
                )
        signatures = [unit.signature or ""] + [units[d].signature or "" for d in unit.uses if d in units]
        type_names = getattr(adapter, "type_names", None)  # adapters that can tell types from values
        if type_names is not None:
            mentioned = set().union(*(type_names(sig) for sig in signatures if sig))
        else:
            mentioned = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", "\n".join(signatures)))
        for name in sorted(mentioned & set(classes)):
            owners = classes[name]  # several files may define the same name (`Props`); any of them will do
            if unit.id in owners or any(owner in unit.uses for owner in owners):
                continue
            warn(
                f"{unit.id}: its prompt mentions `{name}` but `{owners[0]}` is not in `uses`, "
                "so the model will not see its definition."
            )


def _check_test_path(project: Project, adapter, test: str, owner: str, error) -> None:
    """The test path exists inside the project, and its source files parse.

    A syntax error in a test is a planner mistake; without this check it would
    look like a model failure and use up every attempt.
    """
    try:
        path = safe_path(project.root, test)
    except SpecError as exc:
        error(f"{owner}: {exc}")
        return
    if not path.exists():
        error(f"{owner}: test path not found: {test}")
        return
    suffixes = set(adapter.source_suffixes)
    files = sorted(p for p in path.rglob("*") if p.suffix in suffixes) if path.is_dir() else (
        [path] if path.suffix in suffixes else [])
    for file in files:
        rel = file.relative_to(project.root).as_posix()
        try:
            problem = adapter.syntax_error(file.read_text(encoding="utf-8"), rel)
        except UnicodeDecodeError:
            problem = "it is not UTF-8 text"
        if problem:
            error(f"{owner}: test file {rel} does not compile: {problem}")
