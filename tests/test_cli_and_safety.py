"""The command-line interface, environment filtering for checks, and damaged state files."""

import os
from pathlib import Path

import pytest
import yaml

from harness.cli import main
from harness.errors import HarnessError
from harness.state import RunState

from conftest import make_orchestrator, write_config


def test_cli_commands_on_the_example(example_project: Path, capsys):
    project, config = str(example_project), write_config(example_project)
    assert main(["validate", "-p", project, "-c", config]) == 0
    out = capsys.readouterr().out
    assert "0 error(s), 0 warning(s)" in out and "Estimated tokens per unit" in out

    assert main(["prompt", "analyze.compute_stats", "-p", project, "-c", config]) == 0
    out = capsys.readouterr().out
    assert "Write this function:" in out and "class Stats:" in out

    assert main(["prompt", "analyze.compute_stats", "--fix", "-p", project, "-c", config]) == 0
    assert "<previous code>" in capsys.readouterr().out

    assert main(["run", "-p", project, "-c", config]) == 0
    capsys.readouterr()
    assert main(["status", "-p", project, "-c", config]) == 0
    out = capsys.readouterr().out
    assert "Milestones: 1/1 passed." in out and "attempts" in out

    assert main(["report", "--all", "-p", project]) == 0
    assert "test" in capsys.readouterr().out
    assert main(["report", "--json", "-p", project, "-c", config]) == 0
    assert '"pass_rate": 1.0' in capsys.readouterr().out

    assert main(["reset", "-p", project, "-c", config]) == 2  # nothing named
    assert main(["prompt", "no.such.unit", "-p", project, "-c", config]) == 2
    assert main(["run", "--unit", "no.such.unit", "-p", project, "-c", config]) == 2


def test_cli_init_creates_a_skeleton_once(tmp_path: Path, capsys):
    target = tmp_path / "new-target"
    assert main(["init", str(target)]) == 0
    for rel in ("harness.yaml", "spec/project.yaml", "spec/conventions.md", "prompts/templates/fix.md", ".gitignore"):
        assert (target / rel).is_file(), rel
    assert "name: new-target" in (target / "spec" / "project.yaml").read_text(encoding="utf-8")
    assert main(["init", str(target)]) == 2  # never overwrites
    assert main(["validate", "-p", str(target)]) == 1  # no units yet, no model name
    out = capsys.readouterr().out
    assert "No units found" in out and "model.model is empty" in out


def test_checks_only_inherit_allowed_variables(example_project: Path, monkeypatch):
    leaks = ("MY_SERVICE_TOKEN", "DB_PASSWORD", "AZURE_OPENAI_KEY", "GITHUB_PAT", "DATABASE_URL",
             "AWS_ACCESS_KEY_ID", "SSH_AUTH_SOCK", "PYTHON_API_KEY", "SLM_KEY")
    for name in leaks:
        monkeypatch.setenv(name, "do-not-leak")
    config = write_config(example_project, model={"api_key_env": "SLM_KEY"})
    env = make_orchestrator(example_project, config).checker.env()
    assert not set(leaks) & set(env)
    assert "PATH" in {key.upper() for key in env}
    assert env["PYTHONDONTWRITEBYTECODE"] == "1"
    assert env["PYTHONPATH"].startswith(str((example_project / "runs" / "test" / "workspace").resolve()))

    # Explicit settings still work, and inherit_env: ["*"] inherits everything except secrets.
    path = example_project / config
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data["checks"]["inherit_env"] = ["*"]
    data["checks"]["env"]["EXTRA"] = "set-by-config"
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    env = make_orchestrator(example_project, config).checker.env()
    assert env["EXTRA"] == "set-by-config" and env["DATABASE_URL"] == "do-not-leak"
    assert not {"MY_SERVICE_TOKEN", "DB_PASSWORD", "PYTHON_API_KEY", "SLM_KEY"} & set(env)


def test_import_path_defaults_to_the_source_roots(example_project: Path):
    path = example_project / write_config(example_project)
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data["checks"]["env"] = {}
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    orch = make_orchestrator(example_project, path.name)
    workspace = orch.workspace.root.resolve()
    parts = orch.checker.env()["PYTHONPATH"].split(os.pathsep)
    assert parts[:2] == [str(workspace / "src"), str(workspace)]


def test_prompt_without_a_system_message(example_project: Path):
    config = write_config(example_project, model={"system_prompt": False})
    orch = make_orchestrator(example_project, config)
    messages = orch.prompts.build(orch.project.units["tokenize.normalize"])
    assert [m["role"] for m in messages] == ["user"]
    assert messages[0]["content"].startswith("You are a careful Python programmer")


def test_damaged_state_files(tmp_path: Path):
    state = RunState(tmp_path)
    state.log("first", n=1)
    with state.log_path.open("a", encoding="utf-8") as fh:
        fh.write('{"ts": "2026-01-01", "event": "half-writ')  # a line still being written
    assert [e["event"] for e in state.events()] == ["first"]

    state.save()
    state.status_path.write_text("{broken", encoding="utf-8")
    with pytest.raises(HarnessError, match="not valid JSON"):
        RunState(tmp_path)


def test_config_values_are_checked(example_project: Path):
    path = example_project / write_config(example_project)
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data["run"]["regression"] = "everything"
    data["model"]["timeout_s"] = 0
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    with pytest.raises(HarnessError) as info:
        make_orchestrator(example_project, path.name)
    assert "run.regression" in str(info.value) and "timeout_s" in str(info.value)
