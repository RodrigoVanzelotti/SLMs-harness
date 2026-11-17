"""Language adapters. Everything language-specific sits behind this interface.

Only Python is implemented. Adding a language means writing one adapter that
can parse signatures, render stubs, and run the static checks for it.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from ..errors import SpecError
from .python import PythonAdapter

if TYPE_CHECKING:
    import re

    from ..spec import Project, Unit


class LanguageAdapter(Protocol):
    name: str
    display_name: str
    fence: str
    comment_prefix: str
    source_suffixes: tuple[str, ...]

    def infer_kind(self, signature: str, where: str) -> str: ...
    def check_contract(self, unit: Unit) -> list[str]: ...
    def definition_pattern(self, name: str) -> re.Pattern[str]: ...
    def render_stub(self, unit: Unit) -> str: ...
    def render_header(self, imports: list[str]) -> str: ...
    def header_names(self, imports: list[str]) -> set[str]: ...
    def syntax_error(self, code: str) -> str | None: ...
    def sanitize(self, code: str, unit: Unit, reserved: set[str]) -> tuple[str, list[str]]: ...
    def signature_check(self, code: str, unit: Unit, strict: bool) -> tuple[list[str], list[str]]: ...
    def defined_names(self, code: str) -> set[str]: ...
    def import_errors(self, code: str, allow_stdlib: bool, allowed: set[str], internal: set[str]) -> list[str]: ...
    def locate(self, output: str, cwd: Path) -> list[tuple[Path, int]]: ...
    def init_files(self, project: Project) -> list[str]: ...
    def module_names(self, project: Project) -> list[str]: ...
    def check_env(self, project: Project, workspace: Path, base: dict[str, str]) -> dict[str, str]: ...


_ADAPTERS = {"python": PythonAdapter}


def get_adapter(language: str) -> LanguageAdapter:
    try:
        return _ADAPTERS[language.lower()]()
    except KeyError:
        available = ", ".join(sorted(_ADAPTERS))
        raise SpecError(f"Unsupported language `{language}`. Available: {available}.") from None
