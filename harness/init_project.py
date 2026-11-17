"""Creates an empty project skeleton for the planner to fill in."""

from __future__ import annotations

import shutil
from pathlib import Path

from .errors import HarnessError

PACKAGE_DIR = Path(__file__).parent
SKELETON = PACKAGE_DIR / "skeleton"
TEMPLATES = PACKAGE_DIR / "templates"
_FILES = {
    "harness.yaml": "harness.yaml",
    "project.yaml": "spec/project.yaml",
    "conventions.md": "spec/conventions.md",
    "gitignore": ".gitignore",
}
_DIRS = ("spec/contracts", "spec/scaffold", "tests/unit", "tests/integration", "prompts/templates")


def init_project(directory: Path) -> list[Path]:
    directory = Path(directory).resolve()
    if (directory / "spec").exists():
        raise HarnessError(f"{directory} already has a spec/ folder. Nothing was changed.")
    created: list[Path] = []
    for rel in _DIRS:
        path = directory / rel
        path.mkdir(parents=True, exist_ok=True)
        created.append(path)
    for source_name, rel in _FILES.items():
        target = directory / rel
        if target.exists():
            continue
        text = (SKELETON / source_name).read_text(encoding="utf-8").replace("__NAME__", directory.name)
        target.write_text(text, encoding="utf-8", newline="\n")
        created.append(target)
    for template in sorted(TEMPLATES.glob("*.md")):
        target = directory / "prompts" / "templates" / template.name
        if not target.exists():
            shutil.copyfile(template, target)
            created.append(target)
    return created
