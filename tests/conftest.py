import shutil
from pathlib import Path

import pytest
import yaml

from harness.orchestrator import Orchestrator
from harness.spec import Unit

REPO = Path(__file__).resolve().parents[1]
EXAMPLE = REPO / "examples" / "textstats"


@pytest.fixture
def example_project(tmp_path: Path) -> Path:
    """A private copy of the textstats example, without any previous runs."""
    dest = tmp_path / "textstats"
    shutil.copytree(EXAMPLE, dest, ignore=shutil.ignore_patterns("runs", "__pycache__"))
    return dest


def write_mock(project: Path, overrides: dict | None = None, name: str = "mock_custom.yaml") -> str:
    """Example replies with some units replaced; returns the file name."""
    replies = yaml.safe_load((project / "mock_responses.yaml").read_text(encoding="utf-8"))
    replies.update(overrides or {})
    (project / name).write_text(yaml.safe_dump(replies, sort_keys=False), encoding="utf-8")
    return name


def write_config(project: Path, mock_file: str = "mock_responses.yaml", name: str = "harness.test.yaml",
                 commands: list | None = None, model: dict | None = None, **run: object) -> str:
    """A mock-backend run config; keyword arguments override the `run` section."""
    config = {
        "run_name": "test",
        "model": {"backend": "mock", "mock_responses": mock_file, **(model or {})},
        "run": {"samples": 1, "max_attempts": 3, **run},
        "checks": {
            "env": {
                "PYTHONPATH": ["{workspace}/src", "{workspace}"],
                "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
            },
            "commands": commands or [],
        },
    }
    (project / name).write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    return name


def edit_contract(project: Path, file: str, uid: str, **changes) -> None:
    """Change fields of one unit in spec/contracts/<file>."""
    path = project / "spec" / "contracts" / file
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    for unit in data["units"]:
        if unit["id"] == uid:
            unit.update(changes)
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


def example_reply(project: Path, uid: str) -> str:
    """The first scripted reply for a unit in the example's mock_responses.yaml."""
    replies = yaml.safe_load((project / "mock_responses.yaml").read_text(encoding="utf-8"))
    return replies[uid][0]


def make_orchestrator(project: Path, config: str, lines: list[str] | None = None) -> Orchestrator:
    sink = lines.append if lines is not None else (lambda _: None)
    return Orchestrator(project, config_file=config, echo=sink)


def make_unit(uid: str, *, uses=(), after=(), target: str = "src/pkg/mod.py", name: str | None = None,
              signature: str | None = None, **fields) -> Unit:
    name = name or uid.split(".")[-1]
    return Unit(
        id=uid, type=fields.pop("type", "implement"), kind=fields.pop("kind", "function"),
        target_file=target, target_name=name, signature=signature or f"def {name}(x: int) -> int",
        description=fields.pop("description", f"Does {name}."), uses=list(uses), after=list(after), **fields,
    )


def fenced(code: str) -> str:
    return f"```python\n{code.strip()}\n```"
