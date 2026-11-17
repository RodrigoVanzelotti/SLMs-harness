"""Regression tests for the independent review (docs/07-review-and-roadmap.md). Each test reproduces
the scenario of one finding and checks the fixed behavior."""

import _thread
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import yaml

from harness import dag
from harness.config import CommandCheck
from harness.errors import ConfigError, LockError, SpecError
from harness.llm import Completion, MockClient
from harness.report import summarize
from harness.spec import load_project
from harness.state import RunState

from conftest import edit_contract, example_reply, fenced, make_orchestrator, write_config, write_mock

WRONG_FREQUENCIES = fenced("def word_frequencies(words: list[str]) -> dict[str, int]:\n    return {}")
CORRECT_FREQUENCIES = fenced(
    "def word_frequencies(words: list[str]) -> dict[str, int]:\n"
    "    counts: dict[str, int] = {}\n"
    "    for word in words:\n"
    "        counts[word] = counts.get(word, 0) + 1\n"
    "    return counts"
)


class ScriptedClient:
    """Serves fixed replies in order (the last one repeats), with any characters the test needs."""

    def __init__(self, replies: list[str]):
        self.replies = list(replies)

    def complete(self, messages, *, temperature, max_tokens, tag=None):
        text = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        return Completion(text=text, finish_reason="stop")


def llm_calls_since_last_reset(orch, unit: str | None = None) -> list[dict]:
    events = orch.state.events()
    start = max((i for i, e in enumerate(events) if e["event"] == "reset"), default=-1) + 1
    return [e for e in events[start:] if e["event"] == "llm_call" and (unit is None or e["unit"] == unit)]


# 1. Milestones must not undo each other, and an escalated milestone is not retried for free.
def test_conflicting_milestones_do_not_undo_each_other(example_project: Path):
    (example_project / "tests" / "integration" / "test_cli_indent.py").write_text(
        "import json\nimport subprocess\nimport sys\n\n\n"
        "def test_output_is_indented(tmp_path):\n"
        "    path = tmp_path / 'in.txt'\n"
        "    path.write_text('a b a', encoding='utf-8')\n"
        "    proc = subprocess.run([sys.executable, '-m', 'textstats', str(path)], capture_output=True, text=True)\n"
        "    assert proc.stdout.startswith('{\\n'), proc.stdout\n"
        "    assert json.loads(proc.stdout)['total_words'] == 3\n",
        encoding="utf-8",
    )
    project_file = example_project / "spec" / "project.yaml"
    data = yaml.safe_load(project_file.read_text(encoding="utf-8"))
    data["milestones"].append({"id": "m2_indent", "after": ["cli.main"], "tests": ["tests/integration/test_cli_indent.py"]})
    project_file.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")

    correct = example_reply(example_project, "cli.main")
    indented_without_stop_words = (correct.replace(", stop_words=args.stop_words", "")
                                   .replace("json.dumps(result)", "json.dumps(result, indent=2)"))
    mock = write_mock(example_project, {"cli.main": [correct, indented_without_stop_words]})
    config = write_config(example_project, mock)
    orch = make_orchestrator(example_project, config)
    assert orch.run() == 1

    # The repair for m2 also had to pass m1's tests; it could not, so m2 escalated and m1 stayed passed.
    assert orch.state.milestone("m1_cli")["status"] == "done"
    assert orch.state.milestone("m2_indent")["status"] == "escalated"
    kept = orch.workspace.read_region(orch.project.units["cli.main"])
    assert "stop_words=args.stop_words" in kept and "indent=2" not in kept  # the failed repair kept the old code
    assert orch.state.load_accepted("cli.main") == kept

    # Nothing changed, so the next run makes no model calls and still reports the failure.
    calls = len(llm_calls_since_last_reset(orch))
    orch = make_orchestrator(example_project, config)
    assert orch.run() == 1
    assert len(llm_calls_since_last_reset(orch)) == calls
    assert orch.state.milestone("m1_cli")["status"] == "done"


# 2a. Regression tests whose own dependencies are unfinished are skipped, not blamed on the unit.
def test_regression_tests_wait_for_their_own_dependencies(example_project: Path):
    config = write_config(example_project)
    assert make_orchestrator(example_project, config).run() == 0
    orch = make_orchestrator(example_project, config)
    orch.reset(["tokenize.tokenize", "analyze.word_frequencies"])
    assert orch.run() == 0
    assert not [e for e in orch.state.events() if e["event"] == "unit_escalated"]
    assert orch.state.unit("analyze.word_frequencies")["attempts"] == 1


# 2b. A unit above an escalated one is blocked even if the unit in between is finished.
def test_units_above_an_escalated_unit_are_blocked(example_project: Path):
    assert make_orchestrator(example_project, write_config(example_project)).run() == 0
    wrong = fenced("def tokenize(text: str) -> list[str]:\n    return []")
    orch = make_orchestrator(example_project, write_config(example_project, write_mock(example_project, {"tokenize.tokenize": [wrong]})))
    orch.reset(["tokenize.tokenize", "cli.main"])
    assert orch.run() == 1
    assert orch.state.status("tokenize.tokenize") == "escalated"
    assert orch.state.status("analyze.compute_stats") == "done"
    assert "cli.main" in dag.blocked(orch.project.units, orch.statuses())
    assert llm_calls_since_last_reset(orch, "cli.main") == []


# 3. is covered by test_cli_and_safety.test_checks_only_inherit_allowed_variables.


# 4. Ids become file names, so ids that only differ by case, or are Windows device names, are rejected.
def test_case_colliding_and_device_ids_are_rejected(example_project: Path):
    edit_contract(example_project, "tokenize.yaml", "tokenize.StopWordFilter", id="tokenize.Normalize")
    with pytest.raises(SpecError, match="differs only by case"):
        load_project(example_project)
    edit_contract(example_project, "tokenize.yaml", "tokenize.Normalize", id="nul")
    with pytest.raises(SpecError, match="reserves for devices"):
        load_project(example_project)


# 5. A timeout kills processes started by the code under test, instead of waiting for them.
def test_timeouts_kill_processes_started_by_the_code_under_test(example_project: Path):
    orch = make_orchestrator(example_project, write_config(example_project))
    script = ("import subprocess, sys, time; "
              "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); time.sleep(60)")
    started = time.monotonic()
    ok, output = orch.checker.run_command(CommandCheck("slow", ["{python}", "-c", script], timeout_s=2))
    assert not ok and output.startswith("Timed out after 2s")
    assert time.monotonic() - started < 15


# 6. Unusual characters in a reply make a candidate fail; they never crash the run.
def test_unusual_replies_fail_without_crashing(example_project: Path, monkeypatch):
    replies = [
        "def normalize(text: str) -> str:\n    return '\ud83d'\n",  # lone surrogate: cannot be saved as UTF-8
        'def normalize(text: str) -> str:\n    s = "a\x0cb"\n'       # form feed inside a string, plus a stray print
        "    return \"\".join(ch if ch.isalnum() or ch == \"'\" else \" \" for ch in text.lower())\n\nprint()\n",
    ]
    monkeypatch.setattr("harness.orchestrator.make_client", lambda config: ScriptedClient(replies))
    orch = make_orchestrator(example_project, write_config(example_project))
    assert orch.run(only=["tokenize.normalize"]) == 0
    assert orch.state.unit("tokenize.normalize")["attempts"] == 2
    assert '"a\x0cb"' in orch.workspace.read_region(orch.project.units["tokenize.normalize"])

    # A failure inside the harness's own analysis becomes a failed candidate and is logged.
    original = orch.checker.static_checks
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("analysis bug")
        return original(*args, **kwargs)

    orch = make_orchestrator(example_project, "harness.test.yaml")
    monkeypatch.setattr(orch.checker, "static_checks", flaky)
    monkeypatch.setattr("harness.orchestrator.make_client", lambda config: ScriptedClient([replies[1]]))
    orch.reset(["tokenize.normalize"])
    assert orch.run(only=["tokenize.normalize"]) == 0
    assert any(e["event"] == "candidate_error" for e in orch.state.events())


# 7a. Every request that was paid for is counted, even when an earlier parallel sample passed.
def test_parallel_samples_are_all_counted(example_project: Path):
    orch = make_orchestrator(example_project, write_config(example_project, samples=3, sampling="parallel"))
    assert orch.run(only=["tokenize.normalize"]) == 0
    assert summarize(orch.project, orch.state, orch.run_name)["llm_calls"] == 3
    files = sorted((orch.state.attempts_dir / "tokenize.normalize").glob("*.md"))
    assert len(files) == 3
    assert sum("not evaluated" in f.read_text(encoding="utf-8") for f in files) == 2


# 7b. First-try metrics use the first round, so a reset does not turn a failure into a first-try pass.
def test_first_try_metrics_ignore_later_rounds(example_project: Path):
    mock = write_mock(example_project, {"analyze.word_frequencies": [WRONG_FREQUENCIES]})
    assert make_orchestrator(example_project, write_config(example_project, mock)).run() == 1
    write_mock(example_project, {"analyze.word_frequencies": [CORRECT_FREQUENCIES]}, name=mock)
    orch = make_orchestrator(example_project, "harness.test.yaml")
    orch.reset(["analyze.word_frequencies"])
    assert orch.run() == 0
    summary = summarize(orch.project, orch.state, orch.run_name)
    assert summary["pass_rate"] == 1.0
    # word_frequencies failed its first round and tokenize needed 2 attempts: 4 of 6 on the first try.
    assert summary["pass_rate_first_attempt"] == round(4 / 6, 3)


# 8. Signatures may name classes defined later (or themselves); a broken scaffold stops the run early.
def test_scaffold_import_check(example_project: Path):
    (example_project / "spec" / "contracts" / "graph.yaml").write_text(
        "id: graph.Node\n"
        "target: src/textstats/graph.py::Node\n"
        "signature: |\n"
        "  class Node:\n"
        "      def child(self, value: int) -> Node: ...\n"
        "description: A tree node.\n",
        encoding="utf-8",
    )
    orch = make_orchestrator(example_project, write_config(example_project))
    orch.sync()
    assert orch.checker.import_check() == (True, "")

    edit_contract(example_project, "models.yaml", "models.Stats",
                  code="@dataclass\nclass Stats:\n    total_words: int\n\nraise RuntimeError('broken on import')\n")
    orch = make_orchestrator(example_project, "harness.test.yaml")
    with pytest.raises(SpecError, match="cannot be imported"):
        orch.run()
    assert not [e for e in orch.state.events() if e["event"] == "llm_call"]


# 10. A reply with no code, and code changed by sanitize, both come back to the model with an explanation.
def test_failures_are_explained_to_the_model(example_project: Path):
    wrong_with_print = fenced("def normalize(text: str) -> str:\n    return text\n\nprint(normalize('A'))")
    mock = write_mock(example_project, {"tokenize.normalize": [
        "You should lowercase the text and replace punctuation.",
        wrong_with_print,
        example_reply(example_project, "tokenize.normalize"),
    ]})
    orch = make_orchestrator(example_project, write_config(example_project, mock))
    assert orch.run(only=["tokenize.normalize"]) == 0
    folder = orch.state.attempts_dir / "tokenize.normalize"
    second = (folder / "r1-implement-a2-s1.md").read_text(encoding="utf-8")
    assert "- prompt: fix" in second and "did not contain a code block" in second
    third = (folder / "r1-implement-a3-s1.md").read_text(encoding="utf-8")
    assert "the harness changed your answer: removed the top-level statement `print(normalize('A'))`" in third


def test_test_files_that_do_not_compile_are_spec_errors(example_project: Path):
    (example_project / "tests" / "unit" / "test_normalize.py").write_text("def test_broken(:\n", encoding="utf-8")
    errors = make_orchestrator(example_project, write_config(example_project)).validate().errors
    assert any("tests/unit/test_normalize.py does not compile" in e for e in errors)


# 11. Ctrl+C during a slow model request stops at once and restores the unit.
def test_ctrl_c_during_a_model_request(example_project: Path, monkeypatch):
    requested = threading.Event()

    class SlowClient:
        def complete(self, messages, **kwargs):
            requested.set()
            time.sleep(5)
            return Completion(text="")

    monkeypatch.setattr("harness.orchestrator.make_client", lambda config: SlowClient())
    orch = make_orchestrator(example_project, write_config(example_project))
    threading.Thread(target=lambda: requested.wait(30) and _thread.interrupt_main(), daemon=True).start()
    started = time.monotonic()
    assert orch.run(only=["tokenize.normalize"]) == 130
    assert time.monotonic() - started < 4
    assert orch.state.status("tokenize.normalize") == "pending"
    assert "HARNESS_STUB" in orch.workspace.read_region(orch.project.units["tokenize.normalize"])
    assert not orch.state.lock_path.exists()


# 12. Config values must have the right type.
@pytest.mark.parametrize("section, key, value, message", [
    ("run", "samples", "3", "run.samples must be int"),
    ("run", "max_attempts", 2.5, "run.max_attempts must be int"),
    ("model", "system_prompt", "no", "model.system_prompt must be bool"),
    ("checks", "commands", [{"name": "lint", "command": "ruff check"}], "checks.commands[0].command must be list[str]"),
    ("checks", "commands", [{"name": "lint", "command": ["ruff"], "extensions": ".py"}], "extensions must be list[str]"),
])
def test_config_types_are_checked(example_project: Path, section, key, value, message):
    path = example_project / write_config(example_project)
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data[section][key] = value
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    with pytest.raises(ConfigError, match=message.replace("[", r"\[").replace("]", r"\]")):
        make_orchestrator(example_project, path.name)


# 13. Target paths are normalized, so `./src/...` and `src/...` are the same file.
def test_target_paths_are_normalized(example_project: Path):
    edit_contract(example_project, "analyze.yaml", "analyze.compute_stats",
                  target="./src//textstats/analyze.py::compute_stats")
    project = load_project(example_project)
    assert project.units["analyze.compute_stats"].target_file == "src/textstats/analyze.py"
    assert make_orchestrator(example_project, write_config(example_project)).validate().errors == []


# 15. Small robustness items.
def test_requested_unit_that_cannot_be_built_is_reported(example_project: Path):
    lines: list[str] = []
    orch = make_orchestrator(example_project, write_config(example_project), lines)
    assert orch.run(only=["cli.main"]) == 1
    assert any(line.startswith("[cli.main] was not built; it is waiting on:") for line in lines)


def test_empty_mock_entries_are_config_errors(tmp_path: Path):
    path = tmp_path / "mock.yaml"
    path.write_text("tokenize.normalize: []\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="non-empty list"):
        MockClient(path)


def test_stale_lock_from_a_dead_process_is_removed(tmp_path: Path):
    dead = subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"], capture_output=True, text=True)
    state = RunState(tmp_path)
    state.dir.mkdir(parents=True)
    state.lock_path.write_text(json.dumps({"pid": int(dead.stdout), "host": socket.gethostname()}), encoding="utf-8")
    with state.lock():
        pass
    state.lock_path.write_text(json.dumps({"pid": os.getpid(), "host": socket.gethostname()}), encoding="utf-8")
    with pytest.raises(LockError):
        with state.lock():
            pass


# Coverage gaps named by the review: the names stage and the cut-off hint.
def test_names_stage_and_cut_off_hint(example_project: Path):
    orch = make_orchestrator(example_project, write_config(example_project))
    orch.sync()
    units = orch.project.units
    orch.workspace.write_region(units["tokenize.normalize"],
                                "def _strip(word):\n    return word\n\ndef normalize(text: str) -> str:\n    return text")
    reply = fenced("def _strip(word):\n    return word.strip(\"'\")\n\n"
                   "def tokenize(text: str) -> list[str]:\n    return [_strip(w) for w in normalize(text).split()]")
    verdict = orch.checker.static_checks(units["tokenize.tokenize"], reply)
    assert verdict.stage == "names" and "`_strip` already exists" in verdict.error
    cut = orch.checker.static_checks(units["tokenize.tokenize"],
                                     "```python\ndef tokenize(text: str) -> list[str]:\n    return [w for w in", "length")
    assert cut.stage == "syntax" and "cut off" in cut.error
