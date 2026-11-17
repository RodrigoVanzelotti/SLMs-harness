from pathlib import Path

import pytest
import yaml

from harness.errors import SpecError
from harness.spec import load_project
from harness.workspace import safe_path

from conftest import edit_contract, make_orchestrator, write_config


def test_example_spec_loads(example_project: Path):
    project = load_project(example_project)
    assert project.packages == ["textstats"]
    assert project.units["models.Stats"].type == "provided"
    assert project.units["cli.entry_point"].kind == "file"
    assert project.units["tokenize.StopWordFilter"].kind == "class"
    assert project.units["analyze.compute_stats"].summary.startswith("Tokenize the text")


def test_example_validates(example_project: Path):
    orch = make_orchestrator(example_project, write_config(example_project))
    report = orch.validate()
    assert report.errors == [] and report.warnings == []
    assert {b.unit_id for b in report.budgets} == {
        "tokenize.normalize", "tokenize.tokenize", "tokenize.StopWordFilter",
        "analyze.word_frequencies", "analyze.compute_stats", "cli.main",
    }


def test_validation_catches_bad_references_and_paths(example_project: Path):
    edit_contract(example_project, "tokenize.yaml", "tokenize.tokenize", uses=["tokenize.missing"])
    edit_contract(example_project, "tokenize.yaml", "tokenize.normalize", tests=["tests/unit/nope.py"])
    edit_contract(example_project, "analyze.yaml", "analyze.word_frequencies", target="../escape.py::word_frequencies")
    edit_contract(example_project, "tokenize.yaml", "tokenize.StopWordFilter", target="src/textstats/stop.txt::StopWordFilter")
    errors = make_orchestrator(example_project, write_config(example_project)).validate().errors
    assert any("unknown unit `tokenize.missing`" in e for e in errors)
    assert any("test path not found: tests/unit/nope.py" in e for e in errors)
    assert any("escapes" in e for e in errors)
    assert any("must target a python source file" in e for e in errors)


def test_validation_warns_about_missing_prompt_context(example_project: Path):
    edit_contract(example_project, "cli.yaml", "cli.main", uses=["analyze.compute_stats"])
    edit_contract(example_project, "analyze.yaml", "analyze.compute_stats",
                  imports=["from collections.abc import Iterable", "from textstats.models import Stats",
                           "from textstats.tokenize import StopWordFilter"])
    warnings = make_orchestrator(example_project, write_config(example_project)).validate().warnings
    assert any(w.startswith("cli.main: its prompt mentions `Stats`") for w in warnings)
    assert any(w.startswith("analyze.compute_stats: uses `tokenize.tokenize`") for w in warnings)
    assert len(warnings) == 2


def test_validation_catches_cycles(example_project: Path):
    edit_contract(example_project, "tokenize.yaml", "tokenize.normalize", uses=["analyze.compute_stats"])
    errors = make_orchestrator(example_project, write_config(example_project)).validate().errors
    assert any(e.startswith("Dependency cycle:") for e in errors)


def test_validation_enforces_the_token_budget(example_project: Path):
    config = example_project / write_config(example_project)
    data = yaml.safe_load(config.read_text(encoding="utf-8"))
    data["model"].update(context_window=1500, max_output_tokens=600)
    config.write_text(yaml.safe_dump(data), encoding="utf-8")
    errors = make_orchestrator(example_project, config.name).validate().errors
    assert errors and all("over the limit" in e for e in errors)


def test_bad_contracts_fail_to_load(example_project: Path):
    edit_contract(example_project, "tokenize.yaml", "tokenize.normalize", colour="blue")
    with pytest.raises(SpecError, match="Unknown keys"):
        load_project(example_project)


def test_scaffold_regions_and_splicing(example_project: Path):
    orch = make_orchestrator(example_project, write_config(example_project))
    orch.sync()
    ws = orch.workspace
    tokenize_file = ws.path("src/textstats/tokenize.py")
    text = tokenize_file.read_text(encoding="utf-8")
    assert "# >>> unit: tokenize.normalize" in text and "HARNESS_STUB tokenize.normalize" in text
    assert ws.path("src/textstats/__init__.py").is_file()
    assert ws.path("src/textstats/__main__.py").read_text(encoding="utf-8").startswith("import sys")

    unit = orch.project.units["tokenize.normalize"]
    ws.write_region(unit, "def normalize(text: str) -> str:\n    return text.lower()\n# >>> unit: evil")
    assert ws.read_region(unit) == "def normalize(text: str) -> str:\n    return text.lower()"
    line = tokenize_file.read_text(encoding="utf-8").splitlines().index("    return text.lower()") + 1
    assert ws.unit_at(tokenize_file, line) == "tokenize.normalize"

    # A re-scaffold writes accepted code; everything else, including unaccepted edits, gets its stub.
    ws.scaffold({"tokenize.normalize": "def normalize(text: str) -> str:\n    return text.upper()"})
    assert "text.upper()" in ws.read_region(unit)
    ws.scaffold({})
    assert "HARNESS_STUB" in ws.read_region(unit)


def test_scaffold_removes_files_the_spec_no_longer_produces(example_project: Path):
    orch = make_orchestrator(example_project, write_config(example_project))
    orch.sync()
    old = orch.workspace.path("src/textstats/cli.py")
    assert old.is_file()
    user_file = orch.workspace.path("notes.txt")
    user_file.write_text("mine", encoding="utf-8")

    path = example_project / "spec" / "contracts" / "cli.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data["units"][0]["target"] = "src/textstats/command.py::main"
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")

    orch = make_orchestrator(example_project, "harness.test.yaml")
    orch.sync()
    assert not old.exists()
    assert orch.workspace.path("src/textstats/command.py").is_file()
    assert user_file.read_text(encoding="utf-8") == "mine"  # files the harness did not create are kept


def test_safe_path_rejects_escapes(tmp_path: Path):
    with pytest.raises(SpecError):
        safe_path(tmp_path, "../outside.py")
    with pytest.raises(SpecError):
        safe_path(tmp_path, str(tmp_path / "abs.py"))
    assert safe_path(tmp_path, "src/a.py") == (tmp_path / "src" / "a.py").resolve()
