"""Loads the planner's spec bundle: project.yaml, conventions, and contracts.

A unit is one black box: a function, a class, or a whole file. Its contract
(signature, description, examples, tests) is all that other units, and the
SLM working on them, ever see of it.
"""

from __future__ import annotations

import hashlib
import json
import posixpath
import re
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any

import yaml

from .errors import SpecError
from .lang import get_adapter
from .names import name_problem

KINDS = ("function", "class", "file")
TYPES = ("implement", "integrate", "provided")
_UNIT_KEYS = {
    "id", "type", "kind", "target", "signature", "description", "uses", "after",
    "imports", "examples", "tests", "notes", "code", "stub", "max_output_tokens",
}
_PROJECT_KEYS = {
    "name", "language", "digest", "conventions", "allowed_imports", "allow_stdlib",
    "source_roots", "auto_init", "packages", "milestones",
}
_MILESTONE_KEYS = {"id", "after", "tests", "description"}


@dataclass
class Unit:
    id: str
    type: str
    kind: str
    target_file: str  # posix path relative to the workspace
    target_name: str | None  # None for kind "file"
    signature: str | None
    description: str
    uses: list[str] = field(default_factory=list)
    after: list[str] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)
    examples: list[Any] = field(default_factory=list)
    tests: list[str] = field(default_factory=list)  # posix paths relative to the project root
    notes: str = ""
    code: str | None = None
    stub: str | None = None
    max_output_tokens: int | None = None
    source: str = ""

    @property
    def deps(self) -> list[str]:
        """Units that must be finished first: `uses` plus ordering-only `after`."""
        return self.uses + [uid for uid in self.after if uid not in self.uses]

    @property
    def summary(self) -> str:
        """First sentence of the description, used when listing this unit as a dependency."""
        text = " ".join(self.description.split())
        end = re.search(r"(?<=[.!?])\s", text)
        sentence = text[: end.start()] if end else text
        return sentence if len(sentence) <= 160 else sentence[:157] + "..."


@dataclass
class Milestone:
    id: str
    after: list[str]
    tests: list[str]
    description: str = ""


@dataclass
class Project:
    root: Path
    name: str
    language: str
    digest: str
    conventions: str
    allowed_imports: list[str]
    allow_stdlib: bool
    source_roots: list[str]
    auto_init: bool
    packages: list[str]
    units: dict[str, Unit]
    milestones: dict[str, Milestone]

    @property
    def spec_dir(self) -> Path:
        return self.root / "spec"

    @property
    def scaffold_dir(self) -> Path:
        return self.spec_dir / "scaffold"

    @property
    def prompts_dir(self) -> Path:
        return self.root / "prompts" / "templates"

    @cached_property
    def files(self) -> dict[str, list[Unit]]:
        """Units grouped by target file, in spec order."""
        grouped: dict[str, list[Unit]] = {}
        for unit in self.units.values():
            grouped.setdefault(unit.target_file, []).append(unit)
        return grouped


def fingerprint(unit: Unit, units: dict[str, Unit]) -> str:
    """Hash of everything that invalidates a finished unit when it changes.

    Includes the contracts (not the implementations) of the units it uses, so a
    signature change upstream sends its users back to pending.
    """
    payload = {
        "type": unit.type,
        "kind": unit.kind,
        "target": [unit.target_file, unit.target_name],
        "signature": unit.signature,
        "description": unit.description,
        "imports": unit.imports,
        "examples": unit.examples,
        "tests": unit.tests,
        "notes": unit.notes,
        "code": unit.code,
        "stub": unit.stub,
        "uses": {
            uid: [units[uid].kind, units[uid].target_file, units[uid].signature]
            for uid in unit.uses
            if uid in units
        },
    }
    blob = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:16]


def load_project(root: Path) -> Project:
    root = Path(root).resolve()
    project_file = root / "spec" / "project.yaml"
    if not project_file.is_file():
        raise SpecError(
            f"Not a harness project: {project_file} is missing. "
            "Create one with `python -m harness init <dir>`."
        )
    raw = _load_yaml(project_file)
    if not isinstance(raw, dict):
        raise SpecError(f"{project_file} must be a mapping.")
    _reject_unknown(raw, _PROJECT_KEYS, "spec/project.yaml")
    language = str(raw.get("language") or "python")
    adapter = get_adapter(language)

    conventions = ""
    conventions_name = raw.get("conventions")
    conventions_path = root / "spec" / str(conventions_name or "conventions.md")
    if conventions_path.is_file():
        conventions = conventions_path.read_text(encoding="utf-8").strip()
    elif conventions_name:
        raise SpecError(f"Conventions file not found: {conventions_path}")

    units: dict[str, Unit] = {}
    folded: dict[str, str] = {}  # lower-case id -> id; ids name files, and file systems may ignore case
    contracts_dir = root / "spec" / "contracts"
    if contracts_dir.is_dir():
        paths = sorted(
            p for p in contracts_dir.rglob("*")
            if p.is_file() and p.suffix.lower() in (".yaml", ".yml", ".json")
        )
        for path in paths:
            rel = path.relative_to(root).as_posix()
            for index, item in enumerate(_unit_items(_load_yaml(path), rel), start=1):
                unit = _parse_unit(item, f"{rel} (unit {index})", adapter)
                other = folded.get(unit.id.lower())
                if other is not None:
                    same = "Duplicate unit id" if other == unit.id else f"Unit id `{unit.id}` differs only by case from"
                    raise SpecError(f"{same} `{other}` ({rel}; first defined in {units[other].source}).")
                units[unit.id] = unit
                folded[unit.id.lower()] = unit.id

    milestones: dict[str, Milestone] = {}
    for index, item in enumerate(_as_list(raw.get("milestones"), "milestones"), start=1):
        where = f"spec/project.yaml milestone {index}"
        if not isinstance(item, dict):
            raise SpecError(f"{where} must be a mapping.")
        _reject_unknown(item, _MILESTONE_KEYS, where)
        mid = _required_str(item, "id", where)
        problem = name_problem(mid)
        if problem:
            raise SpecError(f"{where}: id `{mid}` {problem}.")
        if mid.lower() in {m.lower() for m in milestones}:
            raise SpecError(f"Duplicate milestone id `{mid}` (ids are compared ignoring case).")
        milestones[mid] = Milestone(
            id=mid,
            after=_str_list(item, "after", where),
            tests=[_normalize_path(t) for t in _str_list(item, "tests", where)],
            description=str(item.get("description") or ""),
        )

    where = "spec/project.yaml"
    source_roots = _str_list(raw, "source_roots", where) if "source_roots" in raw else ["src"]
    packages = _str_list(raw, "packages", where) or _derive_packages(units, source_roots)
    return Project(
        root=root,
        name=str(raw.get("name") or root.name),
        language=language,
        digest=str(raw.get("digest") or "").strip(),
        conventions=conventions,
        allowed_imports=_str_list(raw, "allowed_imports", where),
        allow_stdlib=_bool(raw, "allow_stdlib", True, where),
        source_roots=source_roots,
        auto_init=_bool(raw, "auto_init", True, where),
        packages=packages,
        units=units,
        milestones=milestones,
    )


def _normalize_path(path: str) -> str:
    """`./src//a.py` -> `src/a.py`. Paths that leave their folder keep their `..` so validation reports them."""
    text = path.replace("\\", "/").strip()
    return posixpath.normpath(text) if text else text


def _parse_unit(item: Any, where: str, adapter) -> Unit:
    if not isinstance(item, dict):
        raise SpecError(f"{where} must be a mapping.")
    _reject_unknown(item, _UNIT_KEYS, where)
    uid = _required_str(item, "id", where)
    where = f"{where} `{uid}`"
    problem = name_problem(uid)
    if problem:
        raise SpecError(f"{where}: id {problem}.")

    target = _required_str(item, "target", where).replace("\\", "/")
    if "::" in target:
        target_file, target_name = (part.strip() for part in target.split("::", 1))
        if not target_file or not target_name:
            raise SpecError(f"{where}: target must look like `path/to/file.py::name`.")
    else:
        target_file, target_name = target.strip(), None
    target_file = _normalize_path(target_file)

    signature = _optional_str(item, "signature", where)
    code = _optional_str(item, "code", where)
    kind = item.get("kind")
    if kind is None:
        if target_name is None:
            kind = "file"
        elif signature:
            kind = adapter.infer_kind(signature, where)
        else:
            raise SpecError(f"{where}: function and class units need a `signature`.")
    if kind not in KINDS:
        raise SpecError(f"{where}: kind must be one of {', '.join(KINDS)}.")
    if kind == "file" and target_name:
        raise SpecError(f"{where}: file units take a plain path as target, without `::name`.")
    if kind != "file" and not target_name:
        raise SpecError(f"{where}: {kind} units need a target like `path/to/file.py::name`.")
    if kind != "file" and not signature:
        raise SpecError(f"{where}: {kind} units need a `signature`.")

    unit_type = item.get("type") or ("provided" if code is not None else "implement")
    if unit_type not in TYPES:
        raise SpecError(f"{where}: type must be one of {', '.join(TYPES)}.")
    if unit_type == "provided" and code is None:
        raise SpecError(f"{where}: provided units need `code`.")
    if code is not None and unit_type != "provided":
        raise SpecError(f"{where}: only provided units may contain `code`.")
    description = (_optional_str(item, "description", where) or "").strip()
    if not description and unit_type != "provided":
        raise SpecError(f"{where}: `description` is required.")

    max_output = item.get("max_output_tokens")
    if max_output is not None and (not isinstance(max_output, int) or max_output < 1):
        raise SpecError(f"{where}: max_output_tokens must be a positive integer.")
    examples = item.get("examples") or []
    if not isinstance(examples, list):
        examples = [examples]

    return Unit(
        id=uid,
        type=unit_type,
        kind=kind,
        target_file=target_file,
        target_name=target_name,
        signature=signature,
        description=description,
        uses=_str_list(item, "uses", where),
        after=_str_list(item, "after", where),
        imports=_str_list(item, "imports", where),
        examples=examples,
        tests=[_normalize_path(t) for t in _str_list(item, "tests", where)],
        notes=(_optional_str(item, "notes", where) or "").strip(),
        code=code,
        stub=_optional_str(item, "stub", where),
        max_output_tokens=max_output,
        source=where,
    )


def _derive_packages(units: dict[str, Unit], source_roots: list[str]) -> list[str]:
    """Top-level importable names the project defines, e.g. `textstats`."""
    roots = [[p for p in r.replace("\\", "/").split("/") if p not in ("", ".")] for r in source_roots]
    found: list[str] = []
    for unit in units.values():
        if not unit.target_file.endswith(".py"):
            continue
        parts = unit.target_file.split("/")
        for root_parts in roots:
            if root_parts and parts[: len(root_parts)] == root_parts and len(parts) > len(root_parts):
                parts = parts[len(root_parts):]
                break
        name = parts[0][:-3] if len(parts) == 1 else parts[0]
        if name.isidentifier() and name not in found:
            found.append(name)
    return found


def _load_yaml(path: Path) -> Any:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise SpecError(f"{path} is not valid YAML: {exc}") from None


def _unit_items(data: Any, where: str) -> list[Any]:
    if data is None:
        return []
    if isinstance(data, dict) and "units" in data:
        return _as_list(data["units"], f"{where} units")
    if isinstance(data, dict):
        return [data]
    if isinstance(data, list):
        return data
    raise SpecError(f"{where} must contain a unit mapping, a list of units, or `units: [...]`.")


def _reject_unknown(data: dict, allowed: set[str], where: str) -> None:
    unknown = set(data) - allowed
    if unknown:
        raise SpecError(f"Unknown keys in {where}: {', '.join(sorted(map(str, unknown)))}.")


def _required_str(data: dict, key: str, where: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SpecError(f"{where}: `{key}` is required and must be text.")
    return value.strip()


def _optional_str(data: dict, key: str, where: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise SpecError(f"{where}: `{key}` must be text.")
    return value


def _bool(data: dict, key: str, default: bool, where: str) -> bool:
    value = data.get(key, default)
    if not isinstance(value, bool):
        raise SpecError(f"{where}: `{key}` must be true or false.")
    return value


def _str_list(data: dict, key: str, where: str) -> list[str]:
    value = data.get(key)
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return list(value)
    raise SpecError(f"{where}: `{key}` must be a list of text values.")


def _as_list(value: Any, where: str) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise SpecError(f"{where} must be a list.")
    return value
