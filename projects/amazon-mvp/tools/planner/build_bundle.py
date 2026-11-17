"""Planner tool: write the spec bundle from extract.cjs output.

    node tools/planner/extract.cjs <original-repo> <extract.json>
    python tools/planner/build_bundle.py <original-repo> <extract.json>

Writes spec/contracts/, spec/scaffold/, tests/ and spec/project.yaml milestones.
Re-running it is safe: descriptions, examples and notes already written in
spec/contracts/ are kept (matched by unit id), so the planner's work is never lost.
Everything else in a contract (target, signature, uses, imports, provided code)
is derived from the original again.
"""

from __future__ import annotations

import json
import math
import shutil
import sys
import time
from pathlib import Path

import yaml

PROJECT = Path(__file__).resolve().parents[2]
TODO = "TODO"
KEPT_FIELDS = ("description", "examples", "notes")  # written by the planner, never regenerated
EXTRA_SCAFFOLD = {  # files the rebuilt workspace needs that the original repository does not have
    "tools/harness-test.mjs": PROJECT / "tools" / "workspace" / "harness-test.mjs",
}
CHECK_FILES = {  # pseudo test files that harness-test.mjs turns into whole-workspace checks
    "tests/tools/checks/typecheck.check.json": {"check": "typecheck"},
    "tests/tools/checks/storefront-build.check.json": {"check": "storefront-build"},
}
E2E_PREFIX = "apps/api/test/"
# Not copied: reference screenshots of third-party pages (about 40 MB), used by no code or test.
SCAFFOLD_EXCLUDE = ("docs/reference/",)


class Literal(str):
    """A string written as a YAML block literal."""


def _literal(dumper: yaml.SafeDumper, value: Literal) -> yaml.ScalarNode:
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style="|")


yaml.SafeDumper.add_representer(Literal, _literal)


def block(text: str) -> str:
    text = text.replace("\r\n", "\n").rstrip()
    # YAML block literals cannot keep trailing spaces or tabs reliably; plain strings can.
    if "\n" in text and not any(line != line.rstrip() for line in text.split("\n")) and "\t" not in text:
        return Literal(text)
    return text


def remove_tree(path: Path) -> None:
    """shutil.rmtree, retried: on Windows a file indexer or antivirus can hold a folder for a moment."""
    for attempt in range(10):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.5)


def contract_path(rel: str) -> Path:
    stem = rel.rsplit(".", 1)[0]
    return PROJECT / "spec" / "contracts" / f"{stem}.yaml"


def max_output_tokens(replay: str) -> int:
    estimate = math.ceil(len(replay) / 3.5 * 1.4)
    return max(512, math.ceil(estimate / 256) * 256)


def load_existing() -> dict[str, dict]:
    """Planner-written fields: tools/planner/descriptions/*.yaml (the source of truth), and as a
    fallback anything already written into spec/contracts/."""
    kept: dict[str, dict] = {}
    root = PROJECT / "spec" / "contracts"
    if root.is_dir():
        for path in root.rglob("*.yaml"):
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            for unit in data.get("units", []):
                fields = {k: unit[k] for k in KEPT_FIELDS if k in unit and unit[k] not in (None, "", TODO)}
                if fields:
                    kept[unit["id"]] = fields
    descriptions = PROJECT / "tools" / "planner" / "descriptions"
    if descriptions.is_dir():
        for path in sorted(descriptions.glob("*.yaml")):
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            if not isinstance(data, dict):
                raise SystemExit(f"{path} must map unit ids to {{description, examples, notes}}.")
            for uid, fields in data.items():
                if not isinstance(fields, dict) or set(fields) - set(KEPT_FIELDS):
                    raise SystemExit(f"{path}: `{uid}` may only have {', '.join(KEPT_FIELDS)}.")
                kept[uid] = {k: v for k, v in fields.items() if v not in (None, "")}
    return kept


def unit_entry(unit: dict, kept: dict) -> dict:
    entry: dict = {"id": unit["id"], "type": unit["type"], "kind": unit["kind"], "target": unit["target"]}
    if unit["signature"]:
        entry["signature"] = block(unit["signature"])
    if unit["type"] == "provided":
        deps = unit["valueUses"]  # only what must exist first; types never order provided code
    else:
        deps = unit["uses"]
    if deps:
        entry["uses"] = deps
    if unit["after"]:
        entry["after"] = unit["after"]
    if unit["imports"]:
        entry["imports"] = unit["imports"]
    previous = kept.get(unit["id"], {})
    if unit["type"] == "provided":
        summary = previous.get("description") or (unit["doc"].split("\n\n")[0] if unit["doc"] else "")
        if summary:
            entry["description"] = block(" ".join(summary.split()) if "\n" not in summary.strip() else summary)
        entry["code"] = block(unit["replay"])
        return entry
    entry["description"] = block(previous.get("description") or TODO)
    for key in ("examples", "notes"):
        if previous.get(key):
            entry[key] = previous[key] if key == "examples" else block(previous[key])
    if unit["tests"]:
        entry["tests"] = [f"tests/{t}" for t in unit["tests"]]
    entry["max_output_tokens"] = max_output_tokens(unit["replay"])
    return entry


def closure(units: dict[str, dict], roots: list[str]) -> set[str]:
    out: set[str] = set()
    stack = list(roots)
    while stack:
        uid = stack.pop()
        if uid in out or uid not in units:
            continue
        out.add(uid)
        unit = units[uid]
        stack += (unit["valueUses"] if unit["type"] == "provided" else unit["uses"]) + unit["after"]
    return out


def milestone_id(test_rel: str) -> str:
    stem = test_rel.rsplit("/", 1)[-1].split(".")[0]
    if test_rel.startswith(E2E_PREFIX):
        return f"api.e2e.{stem}"
    if test_rel.startswith("apps/api/"):
        return f"api.unit.{stem}"
    if test_rel.startswith("apps/storefront/"):
        return f"sf.{stem}"
    return f"config.{stem}"


def main(original: Path, extract_file: Path) -> None:
    data = json.loads(extract_file.read_text(encoding="utf-8"))
    units = {u["id"]: u for u in data["units"]}
    kept = load_existing()
    # Unit tests the planner wrote (in tools/planner/new-tests/, workspace layout) for code the
    # original suites do not cover: {unit id: [workspace path, ...]}.
    for mapping_file in sorted((PROJECT / "tools" / "planner" / "new-tests").glob("_map.*.json")):
        for uid, rels in json.loads(mapping_file.read_text(encoding="utf-8")).items():
            if uid not in units:
                raise SystemExit(f"{mapping_file.name} names an unknown unit: {uid}")
            for rel in rels:
                if not (PROJECT / "tools" / "planner" / "new-tests" / rel).is_file():
                    raise SystemExit(f"{mapping_file.name}: {rel} does not exist under tools/planner/new-tests/.")
            units[uid]["tests"] = units[uid]["tests"] + [r for r in rels if r not in units[uid]["tests"]]
    unknown = sorted(uid for uid in kept if uid not in units)
    if unknown:
        raise SystemExit(f"Descriptions for unknown units: {', '.join(unknown[:10])}")

    # Contracts: one YAML per original source file, units in source order.
    contracts = PROJECT / "spec" / "contracts"
    if contracts.is_dir():
        remove_tree(contracts)
    by_file: dict[str, list[dict]] = {}
    for unit in data["units"]:
        by_file.setdefault(unit["rel"], []).append(unit)
    for rel, file_units in by_file.items():
        path = contract_path(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        body = {"units": [unit_entry(u, kept) for u in file_units]}
        text = f"# Contracts for {rel}. Generated by tools/planner; edit descriptions, examples and notes only.\n"
        text += yaml.safe_dump(body, sort_keys=False, allow_unicode=True, width=110)
        path.write_text(text, encoding="utf-8", newline="\n")

    # Scaffold: every original file that is neither a unit target nor a test, copied verbatim.
    scaffold = PROJECT / "spec" / "scaffold"
    if scaffold.is_dir():
        remove_tree(scaffold)
    for rel in data["scaffold"]:
        if rel.startswith(SCAFFOLD_EXCLUDE):
            continue
        target = scaffold / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original / rel, target)
    for rel, source in EXTRA_SCAFFOLD.items():
        target = scaffold / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)

    # Tests: the original suites (milestones), the per-unit splits, and whole-workspace checks.
    tests = PROJECT / "tests"
    if tests.is_dir():
        remove_tree(tests)
    for rel in data["testFiles"] + data["testHelpers"]:
        target = tests / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original / rel, target)
    for split in data["splitFiles"]:
        target = tests / split["rel"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(split["text"], encoding="utf-8", newline="\n")
    for rel, payload in CHECK_FILES.items():
        target = PROJECT / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8", newline="\n")
    new_tests = PROJECT / "tools" / "planner" / "new-tests"
    if new_tests.is_dir():  # unit tests the planner wrote for code the original tests do not cover
        for source in new_tests.rglob("*"):
            if source.is_file() and not source.name.startswith("_map."):
                target = tests / source.relative_to(new_tests)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)

    # Milestones: one per original test file, then whole-workspace checks over every unit.
    milestones = []
    for m in data["milestones"]:
        if not m["after"]:
            continue
        entry = {
            "id": milestone_id(m["test"]),
            "description": f"Original test suite {m['test']} ({m['cases']} tests).",
            "after": m["after"],
            "tests": [f"tests/{m['test']}"],
        }
        if m["e2e"]:
            entry["requires_env"] = ["DATABASE_URL"]
        milestones.append(entry)
    implemented = [uid for uid, u in units.items() if u["type"] != "provided"]
    covered: set[str] = set()
    tops = []
    for uid in sorted(implemented, key=lambda i: -len(closure(units, [i]))):
        if uid not in covered:
            tops.append(uid)
            covered |= closure(units, [uid])
    storefront = [uid for uid in tops if units[uid]["rel"].startswith("apps/storefront/")]
    milestones.append({
        "id": "ci.typecheck",
        "description": "tsc --noEmit for every workspace package, as in the original CI.",
        "after": sorted(tops),
        "tests": ["tests/tools/checks/typecheck.check.json"],
    })
    milestones.append({
        "id": "ci.storefront-build",
        "description": "next build of the storefront (compiles every page and prerenders the static ones).",
        "after": sorted(storefront),
        "tests": ["tests/tools/checks/storefront-build.check.json"],
    })
    project_file = PROJECT / "spec" / "project.yaml"
    project = yaml.safe_load(project_file.read_text(encoding="utf-8"))
    project["milestones"] = milestones
    header = project_file.read_text(encoding="utf-8").split("\nname:", 1)[0]
    project_file.write_text(header + "\n" + yaml.safe_dump(project, sort_keys=False, allow_unicode=True, width=110),
                            encoding="utf-8", newline="\n")

    report = {
        "units": len(units),
        "written_by_model": len(implemented),
        "provided": len(units) - len(implemented),
        "with_unit_tests": sum(1 for uid in implemented if units[uid]["tests"]),
        "todo_descriptions": sum(1 for uid in implemented if not kept.get(uid, {}).get("description")
                                 or kept[uid]["description"] == TODO),
        "milestones": len(milestones),
        "scaffold_files": sum(1 for r in data["scaffold"] if not r.startswith(SCAFFOLD_EXCLUDE)) + len(EXTRA_SCAFFOLD),
        "test_files": len(data["testFiles"]) + len(data["splitFiles"]),
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
