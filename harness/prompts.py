"""Builds the prompt for one unit: templates + contract + dependency signatures.

Only direct dependencies are shown, and only their contracts (signature and
summary), never their implementations. That keeps every prompt small and
treats each unit as a black box.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from string import Template
from typing import TYPE_CHECKING

from .errors import SpecError
from .text import estimate_tokens

if TYPE_CHECKING:
    from .config import Config
    from .spec import Project, Unit

DEFAULT_TEMPLATES = Path(__file__).parent / "templates"
TEMPLATE_NAMES = ("system", "implement", "integrate", "fix")
MESSAGE_OVERHEAD_TOKENS = 8  # chat-template tokens around each message
_FENCES = {
    ".py": "python", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".md": "markdown", ".sh": "bash", ".js": "javascript", ".ts": "typescript", ".tsx": "tsx",
    ".mjs": "javascript", ".cjs": "javascript", ".prisma": "prisma",
    ".html": "html", ".css": "css", ".sql": "sql", ".ini": "ini", ".cfg": "ini",
}


@dataclass
class Budget:
    unit_id: str
    prompt_tokens: int
    fix_prompt_tokens: int  # worst case: previous code and error at their maximum size
    output_tokens: int
    limit: int

    @property
    def ok(self) -> bool:
        return self.fix_prompt_tokens + self.output_tokens <= self.limit


def _render(template: Template, values: dict[str, str]) -> str:
    text = template.safe_substitute(values)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


class PromptBuilder:
    def __init__(self, project: Project, config: Config, adapter):
        self.project = project
        self.config = config
        self.adapter = adapter
        self.templates = {name: self._load(name) for name in TEMPLATE_NAMES}

    def _load(self, name: str) -> Template:
        for base in (self.project.prompts_dir, DEFAULT_TEMPLATES):
            path = base / f"{name}.md"
            if path.is_file():
                return Template(path.read_text(encoding="utf-8"))
        raise SpecError(f"Prompt template `{name}.md` not found.")

    def fence(self, unit: Unit) -> str:
        if unit.kind != "file":
            return self.adapter.fence
        return _FENCES.get(Path(unit.target_file).suffix.lower(), "")

    def variables(self, unit: Unit) -> dict[str, str]:
        fence = self.fence(unit)
        header = ""
        if unit.kind != "file":
            imports = [line for u in self.project.files[unit.target_file] for line in u.imports]
            header = self.adapter.render_header(imports)
        if unit.kind == "file":
            task = f"Write the complete contents of the file `{unit.target_file}`."
            output_rule = f"exactly one ```{fence} code block containing the complete file"
        else:
            intro = {
                "class": "Write this class, with every method shown:",
                "declaration": "Write this declaration, with the value described below:",
            }.get(unit.kind, "Write this function:")
            task = f"{intro}\n```{fence}\n{(unit.signature or '').strip()}\n```"
            output_rule = (
                f"exactly one ```{fence} code block containing `{unit.target_name}` "
                "and any small helpers it needs"
            )
        return {
            "language": self.project.language,
            "language_name": self.adapter.display_name,
            "fence": fence,
            "project_name": self.project.name,
            "project_digest": self.project.digest or self.project.name,
            "conventions": self.project.conventions or "(none)",
            "unit_id": unit.id,
            "target_file": unit.target_file,
            "target_name": unit.target_name or unit.target_file,
            "task": task,
            "description": unit.description,
            "examples": self._examples(unit),
            "notes": f"Notes:\n{unit.notes}" if unit.notes else "",
            "file_imports": header or "(none)",
            "dependencies": self._dependencies(unit),
            "allowed_imports": self._allowed_imports(),
            "output_rule": output_rule,
        }

    def build(self, unit: Unit, mode: str = "implement", previous_code: str | None = None,
              error: str | None = None) -> list[dict[str, str]]:
        values = self.variables(unit)
        values["previous_code"] = (previous_code or "").strip("\n")
        values["error"] = (error or "").strip()
        name = "fix" if mode == "fix" else ("integrate" if unit.type == "integrate" else "implement")
        system = _render(self.templates["system"], values)
        user = _render(self.templates[name], values)
        if self.config.model.system_prompt:
            return [{"role": "system", "content": system}, {"role": "user", "content": user}]
        return [{"role": "user", "content": f"{system}\n\n{user}"}]

    def estimate(self, messages: list[dict[str, str]]) -> int:
        cpt = self.config.budget.chars_per_token
        return sum(estimate_tokens(m["content"], cpt) + MESSAGE_OVERHEAD_TOKENS for m in messages)

    def budget(self, unit: Unit) -> Budget:
        cpt = self.config.budget.chars_per_token
        output = unit.max_output_tokens or self.config.model.max_output_tokens
        filler_code = "x" * int(output * cpt)
        filler_error = "x" * int(self.config.budget.max_error_tokens * cpt)
        return Budget(
            unit_id=unit.id,
            prompt_tokens=self.estimate(self.build(unit)),
            fix_prompt_tokens=self.estimate(self.build(unit, "fix", filler_code, filler_error)),
            output_tokens=output,
            limit=int(self.config.model.context_window * self.config.budget.safety_margin),
        )

    # -- sections

    def _examples(self, unit: Unit) -> str:
        if not unit.examples:
            return ""
        lines = ["Examples:"]
        for example in unit.examples:
            if isinstance(example, dict) and ("input" in example or "output" in example):
                lines.append(f"- {example.get('input', '')} -> {example.get('output', '')}")
            elif isinstance(example, dict):
                lines.append("- " + "; ".join(f"{k}: {v}" for k, v in example.items()))
            else:
                lines.append(f"- {str(example).strip()}")
        return "\n".join(lines)

    def _dependencies(self, unit: Unit) -> str:
        code_parts: list[str] = []
        file_parts: list[str] = []
        for dep_id in unit.uses:
            dep = self.project.units.get(dep_id)
            if dep is None:
                continue
            if dep.kind == "file":
                file_parts.append(f"- `{dep.target_file}`: {dep.summary}")
                continue
            where = "this file" if dep.target_file == unit.target_file else dep.target_file
            summary = f"{dep.summary} " if dep.summary else ""
            code_parts.append(f"{self.adapter.comment_prefix} {summary}[{where}]\n{(dep.signature or '').strip()}")
        sections = []
        if code_parts:
            sections.append(f"```{self.adapter.fence}\n" + "\n\n".join(code_parts) + "\n```")
        sections += file_parts
        return "\n".join(sections) or "(none)"

    def _allowed_imports(self) -> str:
        stdlib = getattr(self.adapter, "stdlib_name", "the standard library")
        parts = ([stdlib] if self.project.allow_stdlib else []) + list(self.project.allowed_imports)
        parts.append("this project's own modules")
        return ", ".join(parts)
