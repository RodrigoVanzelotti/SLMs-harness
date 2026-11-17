"""End-to-end runs of the textstats example with scripted (mock) model replies."""

import shutil
from pathlib import Path

import pytest
import yaml

from harness.errors import LockError
from harness.report import summarize

from conftest import example_reply, fenced, make_orchestrator, write_config, write_mock

WRONG_FREQUENCIES = fenced("def word_frequencies(words: list[str]) -> dict[str, int]:\n    return {}")
CORRECT_FREQUENCIES = fenced(
    "def word_frequencies(words: list[str]) -> dict[str, int]:\n"
    "    counts: dict[str, int] = {}\n"
    "    for word in words:\n"
    "        counts[word] = counts.get(word, 0) + 1\n"
    "    return counts"
)


def test_full_run(example_project: Path):
    lines: list[str] = []
    orch = make_orchestrator(example_project, write_config(example_project), lines)
    assert orch.run() == 0

    entries = orch.state.data["units"]
    built = [u for u, unit in orch.project.units.items() if unit.type != "provided"]
    assert all(entries[u]["status"] == "done" for u in built)
    assert entries["tokenize.tokenize"]["attempts"] == 2  # first reply fails, the fix prompt succeeds
    assert orch.state.milestone("m1_cli")["status"] == "done"

    # Sanitize removed the copied Stats class and the stray print().
    analyze = orch.workspace.path("src/textstats/analyze.py").read_text(encoding="utf-8")
    assert "class Stats" not in analyze
    assert "print(" not in orch.workspace.read_region(orch.project.units["tokenize.StopWordFilter"])

    # The retry used the fix prompt, which carries the previous code and the test failure.
    fix = (orch.state.attempts_dir / "tokenize.tokenize" / "r1-implement-a2-s1.md").read_text(encoding="utf-8")
    assert "- prompt: fix" in fix and "Previous answer:" in fix and "At index 2 diff" in fix

    summary = summarize(orch.project, orch.state, orch.run_name)
    assert summary["done"] == 6 and summary["pass_rate"] == 1.0
    assert summary["pass_rate_first_attempt"] == round(5 / 6, 3)
    assert summary["candidate_failures_by_stage"] == {"tests": 1}
    assert summary["sanitize_repairs"] == 2 and summary["llm_calls"] == 7

    # A second run has nothing left to do and makes no model calls.
    assert make_orchestrator(example_project, "harness.test.yaml").run() == 0
    assert summarize(orch.project, orch.state, orch.run_name)["llm_calls"] == 7


def test_escalation_blocks_dependents_and_restores_the_stub(example_project: Path):
    mock = write_mock(example_project, {"analyze.word_frequencies": [WRONG_FREQUENCIES]})
    orch = make_orchestrator(example_project, write_config(example_project, mock))
    assert orch.run() == 1

    counts = orch.counts()
    assert counts["escalated"] == 1 and counts["blocked"] == 2  # compute_stats and cli.main
    assert orch.state.unit("analyze.word_frequencies")["attempts"] == 3
    assert "HARNESS_STUB" in orch.workspace.read_region(orch.project.units["analyze.word_frequencies"])
    assert orch.state.milestone("m1_cli")["status"] == "pending"
    escalations = orch.state.escalations_path.read_text(encoding="utf-8")
    assert "## analyze.word_frequencies" in escalations and "failed 3 attempt(s)" in escalations

    # After the cause is fixed, resetting the escalated unit lets the run finish.
    write_mock(example_project, {"analyze.word_frequencies": [CORRECT_FREQUENCIES]}, name=mock)
    orch = make_orchestrator(example_project, "harness.test.yaml")
    assert orch.reset(escalated=True) == ["analyze.word_frequencies"]
    assert orch.run() == 0
    assert orch.state.milestone("m1_cli")["status"] == "done"


def test_milestone_failure_is_repaired(example_project: Path):
    replies = yaml.safe_load((example_project / "mock_responses.yaml").read_text(encoding="utf-8"))
    correct = replies["cli.main"][0]
    ignores_stop_words = correct.replace(", stop_words=args.stop_words", "")
    assert ignores_stop_words != correct
    mock = write_mock(example_project, {"cli.main": [ignores_stop_words, correct]})
    orch = make_orchestrator(example_project, write_config(example_project, mock))
    assert orch.run() == 0

    assert orch.state.milestone("m1_cli")["status"] == "done"
    assert orch.state.milestone("m1_cli")["tried"] == ["cli.main"]
    assert orch.state.unit("cli.main")["repairs"] == 1
    summary = summarize(orch.project, orch.state, orch.run_name)
    assert summary["repairs_succeeded"] == 1 and summary["milestones_passed"] == 1


def test_undeclared_dependency_is_escalated_as_a_spec_problem(example_project: Path):
    test_file = example_project / "tests" / "unit" / "test_normalize.py"
    test_file.write_text(
        test_file.read_text(encoding="utf-8")
        + "\n\ndef test_uses_tokenize_too():\n"
        + "    from textstats.tokenize import tokenize\n"
        + "    assert tokenize('A') == ['a']\n",
        encoding="utf-8",
    )
    orch = make_orchestrator(example_project, write_config(example_project))
    assert orch.run() == 1
    entry = orch.state.unit("tokenize.normalize")
    assert entry["status"] == "escalated" and entry["attempts"] == 1  # no retries: the spec is wrong
    assert "tokenize.tokenize" in entry["reason"] and "`uses` or `after`" in entry["reason"]


def test_best_of_n_sampling(example_project: Path):
    wrong = fenced("def normalize(text: str) -> str:\n    return text")
    mock = write_mock(example_project, {"tokenize.normalize": [wrong]})
    lines: list[str] = []
    orch = make_orchestrator(
        example_project, write_config(example_project, mock, samples=3, sampling="parallel"), lines
    )
    # Every sample is wrong, so the unit escalates after 3 attempts of 3 samples each.
    assert orch.run(only=["tokenize.normalize"]) == 1
    entry = orch.state.unit("tokenize.normalize")
    assert entry["status"] == "escalated" and entry["attempts"] == 3
    assert sum("sample 3" in line for line in lines) == 3

    # Lazy sampling stops at the first passing sample: here the second one.
    good = yaml.safe_load((example_project / "mock_responses.yaml").read_text(encoding="utf-8"))
    write_mock(example_project, {"tokenize.normalize": [wrong, good["tokenize.normalize"][0]]}, name=mock)
    orch = make_orchestrator(example_project, write_config(example_project, mock, samples=3, sampling="lazy"))
    orch.reset(["tokenize.normalize"])
    assert orch.run(only=["tokenize.normalize"]) == 0
    entry = orch.state.unit("tokenize.normalize")
    assert entry["status"] == "done" and entry["attempts"] == 1 and entry["samples"] == 2


def test_changed_contract_goes_back_to_pending(example_project: Path):
    orch = make_orchestrator(example_project, write_config(example_project))
    assert orch.run() == 0
    path = example_project / "spec" / "contracts" / "analyze.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data["units"][0]["description"] += " Empty input gives an empty dict."
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")

    orch = make_orchestrator(example_project, "harness.test.yaml")
    orch.sync()
    assert orch.state.status("analyze.word_frequencies") == "pending"
    assert orch.state.status("analyze.compute_stats") == "done"  # its contract did not change
    assert "HARNESS_STUB" in orch.workspace.read_region(orch.project.units["analyze.word_frequencies"])
    assert orch.state.milestone("m1_cli")["status"] == "pending"


def test_workspace_is_rebuilt_from_accepted_code(example_project: Path):
    config = write_config(example_project)
    assert make_orchestrator(example_project, config).run() == 0
    orch = make_orchestrator(example_project, config)
    unit = orch.project.units["tokenize.normalize"]
    accepted = orch.workspace.read_region(unit)

    # A candidate left on disk by a crash is replaced by the accepted code on the next sync.
    orch.workspace.write_region(unit, "def normalize(text: str) -> str:\n    return 'half-written candidate'")
    orch.sync()
    assert orch.workspace.read_region(unit) == accepted

    # Deleting the whole workspace loses nothing.
    shutil.rmtree(orch.workspace.root)
    orch.sync()
    assert orch.workspace.read_region(unit) == accepted
    assert make_orchestrator(example_project, config).run() == 0


def test_changed_tests_are_reverified_and_failing_units_rebuilt(example_project: Path):
    case_insensitive = fenced(
        "def word_frequencies(words: list[str]) -> dict[str, int]:\n"
        "    counts: dict[str, int] = {}\n"
        "    for word in words:\n"
        "        counts[word.lower()] = counts.get(word.lower(), 0) + 1\n"
        "    return counts"
    )
    mock = write_mock(example_project, {"analyze.word_frequencies": [CORRECT_FREQUENCIES, case_insensitive]})
    config = write_config(example_project, mock)
    assert make_orchestrator(example_project, config).run() == 0
    test_file = example_project / "tests" / "unit" / "test_word_frequencies.py"

    # A new test that the accepted code already passes: re-verified without a model call.
    test_file.write_text(test_file.read_text(encoding="utf-8")
                         + "\n\ndef test_single():\n    assert word_frequencies(['x']) == {'x': 1}\n", encoding="utf-8")
    lines: list[str] = []
    orch = make_orchestrator(example_project, config, lines)
    calls = summarize(orch.project, orch.state, orch.run_name)["llm_calls"]
    assert orch.run() == 0
    assert any("still passes" in line for line in lines)
    assert summarize(orch.project, orch.state, orch.run_name)["llm_calls"] == calls

    # A changed test that the accepted code fails: the unit is rebuilt and the milestone runs again.
    test_file.write_text(test_file.read_text(encoding="utf-8").replace('{"A": 1, "a": 1}', '{"a": 2}'),
                         encoding="utf-8")
    lines.clear()
    orch = make_orchestrator(example_project, config, lines)
    assert orch.run() == 0
    assert any("fails them; rebuilding it" in line for line in lines)
    assert orch.state.unit("analyze.word_frequencies")["attempts"] == 2
    assert "word.lower()" in orch.workspace.read_region(orch.project.units["analyze.word_frequencies"])
    assert any("[milestone m1_cli] passed" in line for line in lines)


def test_escalated_unit_is_retried_when_its_tests_change(example_project: Path):
    mock = write_mock(example_project, {"analyze.word_frequencies": [WRONG_FREQUENCIES]})
    config = write_config(example_project, mock)
    assert make_orchestrator(example_project, config).run() == 1
    test_file = example_project / "tests" / "unit" / "test_word_frequencies.py"
    test_file.write_text(test_file.read_text(encoding="utf-8") + "\n# clarified by the planner\n", encoding="utf-8")
    orch = make_orchestrator(example_project, config)
    orch.sync()
    assert orch.state.status("analyze.word_frequencies") == "pending"


def test_rebuilt_unit_must_pass_its_dependents_tests(example_project: Path):
    config = write_config(example_project)
    assert make_orchestrator(example_project, config).run() == 0

    # Passes normalize's own tests, but keeps '-' and so breaks tokenize's tests.
    keeps_dashes = fenced(
        "def normalize(text: str) -> str:\n"
        "    return \"\".join(ch if ch.isalnum() or ch in \"'-\" else \" \" for ch in text.lower())"
    )
    mock = write_mock(example_project, {"tokenize.normalize": [keeps_dashes, example_reply(example_project, "tokenize.normalize")]})
    orch = make_orchestrator(example_project, write_config(example_project, mock))
    orch.reset(["tokenize.normalize"])
    assert orch.state.status("tokenize.tokenize") == "done"  # dependents keep their code
    assert orch.run() == 0
    assert orch.state.unit("tokenize.normalize")["attempts"] == 2
    first = (orch.state.attempts_dir / "tokenize.normalize" / "r2-implement-a1-s1.md").read_text(encoding="utf-8")
    assert "fail at tests" in first and "test_tokenize" in first


def test_configured_command_check_runs_before_tests(example_project: Path):
    with_todo = fenced(
        "def normalize(text: str) -> str:\n"
        "    # TODO handle more cases\n"
        "    return \"\".join(ch if ch.isalnum() or ch == \"'\" else \" \" for ch in text.lower())"
    )
    mock = write_mock(example_project, {"tokenize.normalize": [with_todo, example_reply(example_project, "tokenize.normalize")]})
    command = {
        "name": "no-todo",
        "command": ["{python}", "-c",
                    "import sys; t = open(sys.argv[1], encoding='utf-8').read(); "
                    "print('TODO found') if 'TODO' in t else None; sys.exit('TODO' in t)", "{file}"],
        "extensions": [".py"],
    }
    orch = make_orchestrator(example_project, write_config(example_project, mock, commands=[command]))
    assert orch.run(only=["tokenize.normalize"]) == 0
    assert orch.state.unit("tokenize.normalize")["attempts"] == 2
    fix = (orch.state.attempts_dir / "tokenize.normalize" / "r1-implement-a2-s1.md").read_text(encoding="utf-8")
    assert "`no-todo` found problems:\nTODO found" in fix


def test_data_file_unit_built_by_the_model(example_project: Path):
    (example_project / "spec" / "contracts" / "defaults.yaml").write_text(
        "id: config.defaults\n"
        "target: src/textstats/defaults.json\n"
        "description: 'Default settings: a JSON object with \"top\" set to 3 and \"stop_words\" set to an empty list.'\n"
        "tests: [tests/unit/test_defaults.py]\n",
        encoding="utf-8",
    )
    (example_project / "tests" / "unit" / "test_defaults.py").write_text(
        "import json\nfrom pathlib import Path\n\nimport textstats\n\n\n"
        "def test_defaults():\n"
        "    path = Path(textstats.__file__).parent / 'defaults.json'\n"
        "    assert json.loads(path.read_text(encoding='utf-8')) == {'top': 3, 'stop_words': []}\n",
        encoding="utf-8",
    )
    mock = write_mock(example_project, {"config.defaults": [
        '```json\n{"top": 3,}\n```',
        'Fixed:\n```json\n{"top": 3, "stop_words": []}\n```',
    ]})
    orch = make_orchestrator(example_project, write_config(example_project, mock))
    assert orch.run(only=["config.defaults"]) == 0
    assert orch.state.unit("config.defaults")["attempts"] == 2
    stages = [e["stage"] for e in orch.state.events() if e["event"] == "candidate" and not e["ok"]]
    assert stages == ["syntax"]
    assert orch.workspace.path("src/textstats/defaults.json").read_text(encoding="utf-8").strip() == \
        '{"top": 3, "stop_words": []}'


def test_ablation_switches(example_project: Path):
    # Without error feedback, the retry gets a fresh implement prompt instead of a fix prompt.
    orch = make_orchestrator(example_project, write_config(example_project, error_feedback=False))
    assert orch.run(only=["tokenize.normalize", "tokenize.tokenize"]) == 0
    retry = (orch.state.attempts_dir / "tokenize.tokenize" / "r1-implement-a2-s1.md").read_text(encoding="utf-8")
    assert "- prompt: implement" in retry and "Previous answer:" not in retry
    settings = [e for e in orch.state.events() if e["event"] == "run_start"][-1]["settings"]
    assert settings["run"]["error_feedback"] is False and settings["sanitize"] is True

    # Without sanitizing, compute_stats keeps its copy of Stats, which shadows the real class.
    shutil.rmtree(example_project / "runs")
    path = example_project / write_config(example_project, name="harness.nosan.yaml")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data["checks"]["sanitize"] = False
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    orch = make_orchestrator(example_project, "harness.nosan.yaml")
    assert orch.run() == 1
    assert orch.state.status("analyze.compute_stats") == "escalated"
    assert summarize(orch.project, orch.state, orch.run_name)["sanitize_repairs"] == 0


def test_interrupted_unit_is_recovered_and_runs_are_locked(example_project: Path):
    orch = make_orchestrator(example_project, write_config(example_project))
    orch.state.update_unit("tokenize.normalize", status="in_progress")
    orch.sync()
    assert orch.state.status("tokenize.normalize") == "pending"
    with orch.state.lock():
        with pytest.raises(LockError):
            make_orchestrator(example_project, "harness.test.yaml").run()
