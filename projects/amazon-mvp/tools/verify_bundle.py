"""Self-checks of the spec bundle against the original repository.

    python tools/verify_bundle.py replay   --original <repo> --extract <extract.json>
    python tools/verify_bundle.py equivalence --original <repo>
    python tools/verify_bundle.py todo

replay       Runs the harness offline with the mock backend answering every unit with the
             original code and a test command that always passes. Every unit must pass the
             static ladder (extract, syntax, sanitize, signature, names, imports) with no
             sanitize repairs. Writes runs/replay-offline/.
equivalence  Compares the replayed workspace with the original repository: the same files,
             every source file with the same top-level declarations, imports and directives
             (merged and reordered by the harness, but meaning the same). Run `replay` first.
todo         Lists units whose description is still TODO.

The full replay with real tests (harness.replay.yaml) needs installed dependencies and,
for the API milestones, PostgreSQL; see README.md.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

PROJECT = Path(__file__).resolve().parents[1]
OFFLINE_RUN = "replay-offline"
FENCES = {".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript"}
EXTRA_WORKSPACE = ("tools/harness-test.mjs", "tools/checks/", ".harness-files.json")
SKIPPED_ORIGINAL = ("docs/reference/", ".git/")


def harness_module():
    try:
        import harness  # noqa: F401
    except ImportError:
        # Not installed: use a checkout that contains this project (projects/<name>/ inside test-on-SLMs).
        home = next((p for p in PROJECT.parents if (p / "harness" / "__init__.py").is_file()), None)
        if home is None:
            sys.exit("The harness is not importable. Install it: pip install -e <path to test-on-SLMs>.")
        sys.path.insert(0, str(home))
    from harness.lang.typescript import TypeScriptAdapter
    return TypeScriptAdapter(PROJECT)


def write_responses(extract_file: Path, out: Path) -> int:
    data = json.loads(extract_file.read_text(encoding="utf-8"))
    replies = {}
    for unit in data["units"]:
        if unit["type"] == "provided":
            continue
        fence = FENCES.get(Path(unit["rel"]).suffix, "")
        replies[unit["id"]] = f"```{fence}\n{unit['replay'].rstrip()}\n```"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(yaml.safe_dump(replies, allow_unicode=True, width=1000), encoding="utf-8")
    return len(replies)


def replay(original: Path, extract_file: Path) -> int:
    runs = PROJECT / "runs"
    count = write_responses(extract_file, runs / "replay-responses.yaml")
    base = yaml.safe_load((PROJECT / "harness.replay.yaml").read_text(encoding="utf-8"))
    base["run_name"] = OFFLINE_RUN
    base["model"]["mock_responses"] = "replay-responses.yaml"  # relative to this config's folder (runs/)
    base["checks"]["preflight"] = []
    base["checks"]["tests"] = {"command": [sys.executable, "-c", "pass"], "timeout_s": 60}
    config = runs / "replay-offline.yaml"
    config.write_text(yaml.safe_dump(base, sort_keys=False), encoding="utf-8")
    print(f"Replaying {count} units offline (static checks only)...")
    subprocess.run([sys.executable, "-m", "harness", "reset", "-p", str(PROJECT), "-c", "runs/replay-offline.yaml",
                    "--all"], check=False, capture_output=True)
    result = subprocess.run([sys.executable, "-m", "harness", "run", "-p", str(PROJECT), "-c",
                             "runs/replay-offline.yaml"], text=True, capture_output=True, encoding="utf-8")
    tail = "\n".join(result.stdout.strip().splitlines()[-5:])
    print(tail)
    log = runs / OFFLINE_RUN / "state" / "log.jsonl"
    events = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]
    run_start = max(i for i, e in enumerate(events) if e.get("event") == "run_start")
    events = events[run_start:]
    failed = [e for e in events if e.get("event") == "candidate" and not e.get("ok")]
    repaired = [e for e in events if e.get("event") == "candidate" and e.get("sanitized")]
    escalated = [e for e in events if e.get("event") == "unit_escalated"]
    for e in failed[:20]:
        attempt = runs / OFFLINE_RUN / "state" / e.get("file", "")
        text = attempt.read_text(encoding="utf-8") if attempt.is_file() else ""
        error = text.split("## error", 1)[1].strip() if "## error" in text else ""
        print(f"FAILED {e.get('unit')}: {e.get('stage')}: {error[:400]}")
    for e in repaired[:20]:
        print(f"REPAIRED {e.get('unit')}: {e.get('sanitized')}")
    print(f"candidates failed: {len(failed)}, sanitize repairs: {len(repaired)}, escalated: {len(escalated)}, "
          f"exit code: {result.returncode}")
    if result.returncode not in (0, 1) and result.stderr:
        print(result.stderr[-2000:])
    return 0 if not failed and not repaired and not escalated and result.returncode == 0 else 1


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _summary(adapter, code: str, rel: str) -> dict:
    analysis = adapter._analyze(code, rel)
    decls: list[str] = []
    imports: dict[str, str] = {}
    order: list[str] = []  # modules in import order
    type_imports: set[str] = set()
    directives: list[str] = []
    exports: list[str] = []
    for s in analysis["statements"]:
        if s["kind"] == "import":
            if s["module"] not in order:
                order.append(s["module"])
            if s["sideEffect"]:
                imports[f"<side-effect {s['module']}>"] = s["module"]
            for name, imported in ([(s["defaultName"], "default")] if s["defaultName"] else []) + (
                    [(s["namespaceName"], "*")] if s["namespaceName"] else []) + [
                    (n["local"], n["imported"]) for n in s["named"]]:
                imports[name] = f"{s['module']}:{imported}"
                if s["typeOnly"] or any(n["local"] == name and n["typeOnly"] for n in s["named"]):
                    type_imports.add(name)
        elif s["kind"] == "directive":
            directives.append(s["value"])
        elif s["kind"] == "export":
            exports.append(_normalize(s["text"]))
        else:
            decls.append(_normalize(s["text"]))
    return {"decls": sorted(decls), "imports": imports, "type_imports": type_imports, "order": order,
            "directives": sorted(set(directives)), "exports": sorted(exports)}


def equivalence(original: Path) -> int:
    adapter = harness_module()
    workspace = PROJECT / "runs" / OFFLINE_RUN / "workspace"
    if not workspace.is_dir():
        sys.exit("Run `verify_bundle.py replay` first.")
    project = yaml.safe_load((PROJECT / "spec" / "project.yaml").read_text(encoding="utf-8"))
    del project
    unit_files: set[str] = set()
    for path in (PROJECT / "spec" / "contracts").rglob("*.yaml"):
        for unit in (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("units", []):
            unit_files.add(unit["target"].split("::")[0])

    def listing(root: Path, skip: tuple[str, ...]) -> set[str]:
        out = set()
        for p in root.rglob("*"):
            if p.is_file():
                rel = p.relative_to(root).as_posix()
                if not rel.startswith(skip) and "/node_modules/" not in f"/{rel}" and not rel.startswith("node_modules/"):
                    out.add(rel)
        return out

    original_files = listing(original, SKIPPED_ORIGINAL)
    workspace_files = listing(workspace, ())
    split_tests = {p.relative_to(PROJECT / "tests").as_posix() for pattern in ("*.unit.*", "*.new.*")
                   for p in (PROJECT / "tests").rglob(pattern)}
    extra = {f for f in workspace_files if f.startswith(EXTRA_WORKSPACE)} | split_tests
    problems: list[str] = []
    for rel in sorted(original_files - workspace_files):
        problems.append(f"missing from the workspace: {rel}")
    for rel in sorted(workspace_files - original_files - extra):
        problems.append(f"not in the original: {rel}")
    checked = 0
    for rel in sorted(original_files & workspace_files):
        a, b = original / rel, workspace / rel
        if rel not in unit_files:
            if a.read_bytes() != b.read_bytes():
                problems.append(f"differs from the original (copied file): {rel}")
            continue
        checked += 1
        want = _summary(adapter, a.read_text(encoding="utf-8"), rel)
        got = _summary(adapter, b.read_text(encoding="utf-8"), rel)
        if want["decls"] != got["decls"]:
            lost = [d[:100] for d in want["decls"] if d not in got["decls"]]
            gained = [d[:100] for d in got["decls"] if d not in want["decls"]]
            problems.append(f"{rel}: declarations differ; missing {lost[:3]}, extra {gained[:3]}")
        for name, source in want["imports"].items():
            if name.startswith("<side-effect") and name not in got["imports"]:
                problems.append(f"{rel}: lost the side-effect import of {source}")
            elif not name.startswith("<side-effect") and got["imports"].get(name) != source:
                # An original import nothing uses is dropped by the cut; that is not a change in meaning.
                if name in got["imports"] or re.search(rf"\b{re.escape(name)}\b", "\n".join(want["decls"])):
                    problems.append(f"{rel}: `{name}` should come from {source}, got {got['imports'].get(name)}")
        for name in set(got["imports"]) - set(want["imports"]):
            if name not in got["type_imports"] and not name.startswith("<side-effect"):
                problems.append(f"{rel}: extra value import `{name}` from {got['imports'][name]}")
        side = [v for k, v in want["imports"].items() if k.startswith("<side-effect")]
        for module in side:  # a side-effect import keeps its place relative to the other imports
            if module not in got["order"]:
                continue
            before_want = set(want["order"][: want["order"].index(module)])
            before_got = set(got["order"][: got["order"].index(module)])
            moved = sorted(m for m in set(want["order"]) & set(got["order"]) if (m in before_want) != (m in before_got))
            if moved:
                problems.append(f"{rel}: the side-effect import of {module} moved relative to {', '.join(moved[:3])}")
        if want["directives"] != got["directives"]:
            problems.append(f"{rel}: directives {want['directives']} became {got['directives']}")
        for export in want["exports"]:
            if export not in got["exports"]:
                problems.append(f"{rel}: lost `{export}`")
    for p in problems[:60]:
        print(p)
    print(f"compared {checked} assembled source files and {len(original_files & workspace_files) - checked} copied "
          f"files; {len(problems)} difference(s)")
    return 1 if problems else 0


def todo() -> int:
    missing = []
    for path in sorted((PROJECT / "spec" / "contracts").rglob("*.yaml")):
        for unit in (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("units", []):
            if unit["type"] != "provided" and str(unit.get("description", "")).strip() in ("", "TODO"):
                missing.append(unit["id"])
    for uid in missing:
        print(uid)
    print(f"{len(missing)} unit(s) without a description")
    return 1 if missing else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["replay", "equivalence", "todo"])
    parser.add_argument("--original", type=Path)
    parser.add_argument("--extract", type=Path)
    args = parser.parse_args()
    if args.command == "replay":
        if not args.original or not args.extract:
            parser.error("replay needs --original and --extract")
        return replay(args.original.resolve(), args.extract.resolve())
    if args.command == "equivalence":
        if not args.original:
            parser.error("equivalence needs --original")
        return equivalence(args.original.resolve())
    return todo()


if __name__ == "__main__":
    sys.exit(main())
