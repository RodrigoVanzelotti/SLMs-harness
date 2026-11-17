"""The project being rebuilt: file assembly, unit regions, and stubs.

Source files are assembled from regions between marker comments:

    # >>> header
    import re
    # <<< header

    # >>> unit: tokenize.normalize
    def normalize(text: str) -> str:
        ...
    # <<< unit: tokenize.normalize

The SLM only ever produces the text of one region; the harness splices it in.
Units of kind "file" own their whole file instead.

With `tests_in_workspace`, the project's tests/ tree is copied into the workspace
(`tests/apps/web/x.test.ts` -> `apps/web/x.test.ts`), for test runners that resolve
imports relative to the test file.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Sequence

from . import dag
from .errors import HarnessError, SpecError
from .text import split_lines

if TYPE_CHECKING:
    from .spec import Project, Unit

HEADER = "header"
MANIFEST = ".harness-files.json"  # files the last scaffold produced, so stale ones can be removed


def safe_path(base: Path, rel: str) -> Path:
    """Resolve `rel` under `base`, refusing absolute paths and paths that escape it."""
    if Path(rel).is_absolute() or Path(rel).drive:
        raise SpecError(f"Path must be relative: {rel}")
    base = base.resolve()
    path = (base / rel).resolve()
    if path != base and base not in path.parents:
        raise SpecError(f"Path escapes its directory: {rel}")
    return path


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


class Workspace:
    def __init__(self, project: Project, adapter, root: Path):
        self.project = project
        self.adapter = adapter
        self.root = Path(root)
        prefix = re.escape(adapter.comment_prefix)
        self._marker_re = re.compile(rf"^\s*{prefix} (>>>|<<<) (header|unit: (\S+))\s*$")

    def path(self, rel: str) -> Path:
        return safe_path(self.root, rel)

    def test_path(self, rel: str) -> Path:
        """Where a test path (relative to the project) is run from."""
        mapped = self.project.workspace_test_path(rel)
        return self.path(mapped) if mapped is not None else self.project.root / rel

    def restore_tests(self, paths: Sequence[Path]) -> None:
        """Copy test files into the workspace again, in case code under test changed them."""
        if not self.project.tests_in_workspace:
            return
        root = self.root.resolve()
        for path in paths:
            try:
                rel = Path(path).resolve().relative_to(root)
            except ValueError:
                continue
            source = self.project.tests_dir / rel
            files = [p for p in source.rglob("*") if p.is_file()] if source.is_dir() else [source]
            for file in files:
                if file.is_file():
                    target = self.path((rel / file.relative_to(source)).as_posix() if source.is_dir() else rel.as_posix())
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(file, target)

    def _marker(self, direction: str, key: str) -> str:
        label = HEADER if key == HEADER else f"unit: {key}"
        return f"{self.adapter.comment_prefix} {direction} {label}"

    def _scan(self, lines: list[str]) -> dict[str, tuple[int, int]]:
        """Region key -> (first content line index, closing marker index), 0-based."""
        found: dict[str, tuple[int, int]] = {}
        open_key: str | None = None
        start = 0
        for index, line in enumerate(lines):
            match = self._marker_re.match(line)
            if not match:
                continue
            key = match.group(3) or HEADER
            if match.group(1) == ">>>":
                open_key, start = key, index + 1
            elif key == open_key:
                found[key] = (start, index)
                open_key = None
        return found

    def _lines(self, rel: str) -> list[str] | None:
        path = self.path(rel)
        if not path.is_file():
            return None
        lines = split_lines(path.read_text(encoding="utf-8"))
        if lines and lines[-1] == "":  # the final newline
            lines.pop()
        return lines

    def regions(self, rel: str) -> dict[str, str]:
        lines = self._lines(rel)
        if lines is None:
            return {}
        return {key: "\n".join(lines[s:e]) for key, (s, e) in self._scan(lines).items()}

    def read_region(self, unit: Unit) -> str | None:
        if unit.kind == "file":
            path = self.path(unit.target_file)
            return path.read_text(encoding="utf-8") if path.is_file() else None
        return self.regions(unit.target_file).get(unit.id)

    def write_region(self, unit: Unit, content: str) -> None:
        if unit.kind == "file":
            _write(self.path(unit.target_file), content if content.endswith("\n") or not content else content + "\n")
            return
        lines = self._lines(unit.target_file)
        if lines is None:
            raise HarnessError(f"{unit.target_file} is missing from the workspace. Run `scaffold` first.")
        span = self._scan(lines).get(unit.id)
        if span is None:
            raise HarnessError(f"The region for `{unit.id}` is missing in {unit.target_file}. Run `scaffold`.")
        body = self._body_lines(content)
        lines[span[0]: span[1]] = body
        _write(self.path(unit.target_file), "\n".join(lines) + "\n")

    def _body_lines(self, content: str) -> list[str]:
        """Region content as lines, without marker-looking lines (they would break the file's structure)."""
        text = content.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
        return [line for line in split_lines(text) if not self._marker_re.match(line)] if text else []

    def stub(self, unit: Unit) -> str:
        """Initial content of a unit: provided code, a file stub, or a NotImplementedError stub."""
        if unit.type == "provided":
            return (unit.code or "").strip("\n")
        if unit.kind == "file":
            return unit.stub or ""
        return self.adapter.render_stub(unit)

    def unit_at(self, path: Path, line: int) -> str | None:
        """Which unit owns a (file, 1-based line) location, if any."""
        try:
            rel = Path(path).resolve().relative_to(self.root.resolve()).as_posix()
        except ValueError:
            return None
        units = self.project.files.get(rel)
        if not units:
            return None
        if units[0].kind == "file":
            return units[0].id
        lines = self._lines(rel) or []
        for key, (start, end) in self._scan(lines).items():
            if key != HEADER and start < line <= end:
                return key
        return None

    def scaffold(self, accepted: dict[str, str]) -> list[str]:
        """Rebuild the workspace from the spec and the accepted code.

        Units in `accepted` get that code; every other unit gets its stub (or its
        provided code). Whatever is on disk is never trusted, so a crash in the
        middle of a check cannot leave unverified code behind. Files that an
        earlier scaffold produced but the spec no longer does are removed.
        Returns notes about anything removed.
        """
        notes: list[str] = []
        produced: list[str] = []
        self.root.mkdir(parents=True, exist_ok=True)
        scaffold_dir = self.project.scaffold_dir
        if scaffold_dir.is_dir():
            for source in sorted(scaffold_dir.rglob("*")):
                if source.is_file():
                    rel = source.relative_to(scaffold_dir).as_posix()
                    target = self.path(rel)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
                    produced.append(rel)
        tests_dir = self.project.tests_dir
        if self.project.tests_in_workspace and tests_dir.is_dir():
            for source in sorted(tests_dir.rglob("*")):
                if source.is_file():
                    rel = source.relative_to(tests_dir).as_posix()
                    target = self.path(rel)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
                    produced.append(rel)

        order = {uid: i for i, uid in enumerate(dag.topo_order(self.project.units))}
        for rel, units in self.project.files.items():
            units = sorted(units, key=lambda u: order[u.id])
            produced.append(rel)
            if units[0].kind == "file":
                self.write_region(units[0], self._content(units[0], accepted))
                continue
            existing = self.regions(rel)
            header = self.adapter.render_header([line for u in units for line in u.imports])
            parts = [
                f"{self.adapter.comment_prefix} Assembled by the SLM harness. Each marked region is one unit from spec/contracts.",
                self._marker(">>>", HEADER),
                *([header] if header else []),
                self._marker("<<<", HEADER),
            ]
            for unit in units:
                body = "\n".join(self._body_lines(self._content(unit, accepted)))
                parts += ["", "", self._marker(">>>", unit.id), body, self._marker("<<<", unit.id)]
            for key in sorted(set(existing) - {u.id for u in units} - {HEADER}):
                notes.append(f"Removed the region `{key}` from {rel}; it is no longer in the spec.")
            _write(self.path(rel), "\n".join(parts) + "\n")

        for rel in self.adapter.init_files(self.project):
            path = self.path(rel)
            if not path.exists():
                _write(path, "")
            produced.append(rel)

        for rel in sorted(set(self._read_manifest()) - set(produced)):
            try:
                path = self.path(rel)
            except SpecError:  # a damaged manifest entry; never delete outside the workspace
                continue
            if path.is_file():
                path.unlink()
                notes.append(f"Removed {rel}; the spec no longer produces it.")
        _write(self.root / MANIFEST, json.dumps(sorted(set(produced)), indent=2) + "\n")
        return notes

    def _content(self, unit: Unit, accepted: dict[str, str]) -> str:
        if unit.type != "provided" and unit.id in accepted:
            return accepted[unit.id]
        return self.stub(unit)

    def _read_manifest(self) -> list[str]:
        path = self.root / MANIFEST
        if not path.is_file():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
        return [item for item in data if isinstance(item, str)] if isinstance(data, list) else []
