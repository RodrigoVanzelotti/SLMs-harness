"""Run configuration (harness.yaml): model endpoint, budgets, and checks.

The spec in spec/ says what to build. This file says how a run executes, so
the same spec can be run against several models and compared.
"""

from __future__ import annotations

import types
import typing
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

import yaml

from .errors import ConfigError
from .names import name_problem

DEFAULT_TEST_COMMAND = [
    "{python}", "-m", "pytest", "{tests}",
    "-x", "-q", "--tb=short", "--no-header", "-p", "no:cacheprovider",
]


@dataclass
class ModelConfig:
    backend: str = "openai"  # "openai" (any OpenAI-compatible server) or "mock"
    base_url: str = "http://localhost:11434/v1"
    model: str = ""
    api_key_env: str | None = None  # name of the environment variable, never the key itself
    context_window: int = 8192
    max_output_tokens: int = 1024
    temperature: float = 0.2
    exploration_temperature: float = 0.7
    timeout_s: float = 300.0
    system_prompt: bool = True
    extra_body: dict[str, Any] = field(default_factory=dict)
    mock_responses: str | None = None


@dataclass
class BudgetConfig:
    chars_per_token: float = 3.5
    safety_margin: float = 0.9
    max_error_tokens: int = 500


@dataclass
class RunConfig:
    samples: int = 3
    sampling: str = "lazy"  # "lazy": one request at a time; "parallel": all samples at once
    max_attempts: int = 3
    error_feedback: bool = True  # retries get the previous code and error; false: a fresh prompt each time
    regression: str = "related"  # "related" (same file + dependents), "same_file", or "none"
    max_milestone_repairs: int = 2
    save_attempts: bool = True


@dataclass
class CommandCheck:
    name: str
    command: list[str]
    timeout_s: float = 120.0
    extensions: list[str] = field(default_factory=list)  # empty: applies to every file


# Checks run model-written code, so they inherit only what a process needs to start and find
# its tools. Anything else (cloud keys, tokens, database URLs, agent sockets) stays out.
DEFAULT_INHERIT_ENV = [
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "OS",
    "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
    "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
    "USERNAME", "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_*", "TZ", "TERM", "SHELL",
    "PYTHON*", "VIRTUAL_ENV", "CONDA_PREFIX", "PYTEST_*",
]
# A second filter on top of the allowlist (for example PYTHON_API_KEY would match PYTHON*).
DEFAULT_SECRET_PATTERNS = [
    "*TOKEN*", "*SECRET*", "*PASSWORD*", "*PASSWD*", "*API_KEY*", "*APIKEY*",
    "*CREDENTIAL*", "*PRIVATE_KEY*", "*CONNECTION_STRING*",
]


@dataclass
class ChecksConfig:
    cwd: str = "{workspace}"
    env: dict[str, Any] = field(default_factory=dict)
    # Inherited variables must match one of these patterns (["*"] inherits everything) and none
    # of secret_env_patterns. model.api_key_env is always removed. checks.env is added afterwards.
    inherit_env: list[str] = field(default_factory=lambda: list(DEFAULT_INHERIT_ENV))
    secret_env_patterns: list[str] = field(default_factory=lambda: list(DEFAULT_SECRET_PATTERNS))
    sanitize: bool = True  # deterministic repairs of model output before the signature check
    strict_annotations: bool = False
    commands: list[CommandCheck] = field(default_factory=list)
    # Run once by `run`, after the workspace is built and before the first model call
    # (for example: install dependencies, generate code, load every module). A failure stops the run.
    preflight: list[CommandCheck] = field(default_factory=list)
    tests: CommandCheck = field(
        default_factory=lambda: CommandCheck("tests", list(DEFAULT_TEST_COMMAND))
    )


@dataclass
class Config:
    path: Path
    run_name: str = "default"
    model: ModelConfig = field(default_factory=ModelConfig)
    budget: BudgetConfig = field(default_factory=BudgetConfig)
    run: RunConfig = field(default_factory=RunConfig)
    checks: ChecksConfig = field(default_factory=ChecksConfig)

    @property
    def base_dir(self) -> Path:
        return self.path.parent


def _matches(value: Any, hint: Any) -> bool:
    """True if a YAML value fits a dataclass annotation (str, int, float, bool, unions, lists, dicts)."""
    if hint is Any:
        return True
    origin = typing.get_origin(hint)
    if origin in (typing.Union, types.UnionType):
        return any(_matches(value, arg) for arg in typing.get_args(hint))
    if hint is type(None):
        return value is None
    if origin is list:
        (item,) = typing.get_args(hint) or (Any,)
        return isinstance(value, list) and all(_matches(v, item) for v in value)
    if origin is dict or hint is dict:
        return isinstance(value, dict)
    if hint is bool:
        return isinstance(value, bool)
    if hint is int:
        return isinstance(value, int) and not isinstance(value, bool)
    if hint is float:
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if hint is str:
        return isinstance(value, str)
    return True  # nested sections are checked on their own


def _describe(hint: Any) -> str:
    return str(hint).replace("typing.", "").replace("<class '", "").replace("'>", "")


def _section(cls, data: Any, where: str):
    if data is None:
        return cls()
    if not isinstance(data, dict):
        raise ConfigError(f"{where} must be a mapping.")
    unknown = set(data) - {f.name for f in fields(cls)}
    if unknown:
        raise ConfigError(f"Unknown keys in {where}: {', '.join(sorted(unknown))}.")
    hints = typing.get_type_hints(cls)
    values = {}
    for key, value in data.items():
        if value is None and not _matches(None, hints[key]):
            continue  # `key:` with nothing (or only comments) under it means "use the default"
        if not _matches(value, hints[key]):
            raise ConfigError(f"{where}.{key} must be {_describe(hints[key])}, not {value!r}.")
        values[key] = value
    try:
        return cls(**values)
    except TypeError as exc:
        raise ConfigError(f"{where}: {exc}") from None


def _command(data: Any, where: str, default_name: str | None = None) -> CommandCheck:
    if not isinstance(data, dict):
        raise ConfigError(f"{where} must be a mapping with `name` and `command`.")
    data = dict(data)
    if default_name:
        data.setdefault("name", default_name)
    check = _section(CommandCheck, data, where)
    if not check.command:
        raise ConfigError(f"{where}.command must be a non-empty list of strings.")
    return check


def load_config(path: Path) -> Config:
    path = Path(path)
    if not path.is_file():
        raise ConfigError(f"Config file not found: {path}")
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path} is not valid YAML: {exc}") from None
    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must be a mapping.")
    unknown = set(raw) - {"run_name", "model", "budget", "run", "checks"}
    if unknown:
        raise ConfigError(f"Unknown keys in {path.name}: {', '.join(sorted(unknown))}.")

    if not isinstance(raw.get("checks") or {}, dict):
        raise ConfigError("checks must be a mapping.")
    checks_raw = dict(raw.get("checks") or {})
    commands_raw = checks_raw.pop("commands", None) or []
    if not isinstance(commands_raw, list):
        raise ConfigError("checks.commands must be a list.")
    preflight_raw = checks_raw.pop("preflight", None) or []
    if not isinstance(preflight_raw, list):
        raise ConfigError("checks.preflight must be a list.")
    tests_raw = checks_raw.pop("tests", None)
    checks = _section(ChecksConfig, checks_raw, "checks")
    checks.commands = [_command(item, f"checks.commands[{i}]") for i, item in enumerate(commands_raw)]
    checks.preflight = [_command(item, f"checks.preflight[{i}]", default_name=f"preflight-{i + 1}")
                        for i, item in enumerate(preflight_raw)]
    if tests_raw is not None:
        checks.tests = _command(tests_raw, "checks.tests", default_name="tests")

    run_name = raw.get("run_name", "default")
    if not isinstance(run_name, (str, int)) or isinstance(run_name, bool):
        raise ConfigError(f"run_name must be text, not {run_name!r}.")
    config = Config(
        path=path.resolve(),
        run_name=str(run_name),
        model=_section(ModelConfig, raw.get("model"), "model"),
        budget=_section(BudgetConfig, raw.get("budget"), "budget"),
        run=_section(RunConfig, raw.get("run"), "run"),
        checks=checks,
    )
    _check_values(config)
    return config


def _check_values(config: Config) -> None:
    problems = []
    name = name_problem(config.run_name)
    if name:
        problems.append(f"run_name {name}.")
    if config.model.backend not in ("openai", "mock"):
        problems.append("model.backend must be `openai` or `mock`.")
    if not 0 < config.model.max_output_tokens < config.model.context_window:
        problems.append("model.max_output_tokens must be positive and smaller than model.context_window.")
    if config.model.temperature < 0 or config.model.exploration_temperature < 0:
        problems.append("model temperatures must not be negative.")
    if config.model.timeout_s <= 0:
        problems.append("model.timeout_s must be positive.")
    if not 0 < config.budget.safety_margin <= 1:
        problems.append("budget.safety_margin must be between 0 and 1.")
    if config.budget.chars_per_token <= 0 or config.budget.max_error_tokens < 1:
        problems.append("budget.chars_per_token and budget.max_error_tokens must be positive.")
    if config.run.samples < 1 or config.run.max_attempts < 1 or config.run.max_milestone_repairs < 0:
        problems.append("run.samples and run.max_attempts must be at least 1; run.max_milestone_repairs at least 0.")
    if config.run.sampling not in ("lazy", "parallel"):
        problems.append("run.sampling must be `lazy` or `parallel`.")
    if config.run.regression not in ("related", "same_file", "none"):
        problems.append("run.regression must be `related`, `same_file`, or `none`.")
    if any(check.timeout_s <= 0 for check in [*config.checks.commands, *config.checks.preflight, config.checks.tests]):
        problems.append("check timeouts must be positive.")
    names = [check.name for check in config.checks.commands]
    builtin = {"extract", "syntax", "signature", "names", "imports", "tests"}
    if len(set(names)) != len(names) or builtin & set(names):
        problems.append(
            "checks.commands names must be unique and must not reuse a built-in stage name "
            f"({', '.join(sorted(builtin))})."
        )
    if problems:
        raise ConfigError(f"{config.path.name}: " + " ".join(problems))
