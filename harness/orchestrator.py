"""The orchestrator: plain code that drives the SLM through the task graph.

It is the only writer of state. For each ready unit it builds a small prompt,
samples the SLM, runs the verification ladder, splices passing code into the
workspace, and records the outcome. Failures come back as fix prompts; units
that keep failing are escalated and their dependents are blocked. Milestones
run integration tests once their units are done and send failures back to the
unit that most likely caused them.
"""

from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Callable, Sequence

from . import dag
from .checks import Checker, Verdict
from .config import load_config
from .errors import HarnessError, SpecError
from .lang import get_adapter
from .llm import Client, Completion, make_client
from .names import name_problem
from .prompts import PromptBuilder
from .spec import Milestone, Unit, fingerprint, load_project
from .state import RunState
from .text import estimate_tokens
from .validate import Report, validate
from .workspace import Workspace


def _wait_all(calls: list[Callable[[], Completion]]) -> list[Completion]:
    """Run model requests in daemon threads and wait in short steps.

    A blocking HTTP read in the main thread would delay Ctrl+C until the server
    answers (minutes, with long timeouts). Daemon threads also never keep the
    process alive after the run has been interrupted.
    """
    results: list[Completion | None] = [None] * len(calls)
    errors: list[BaseException | None] = [None] * len(calls)

    def work(index: int, call: Callable[[], Completion]) -> None:
        try:
            results[index] = call()
        except BaseException as exc:  # re-raised in the main thread below
            errors[index] = exc

    threads = [threading.Thread(target=work, args=(i, c), daemon=True) for i, c in enumerate(calls)]
    for thread in threads:
        thread.start()
    for thread in threads:
        while thread.is_alive():
            thread.join(0.2)
    for error in errors:
        if error is not None:
            raise error
    return [r for r in results if r is not None]


class Orchestrator:
    def __init__(self, project_root: Path, config_file: str = "harness.yaml",
                 run_name: str | None = None, echo: Callable[[str], None] = print):
        self.root = Path(project_root).resolve()
        self.config = load_config(self.root / config_file)
        self.project = load_project(self.root)
        self.adapter = get_adapter(self.project.language)
        self.run_name = run_name or self.config.run_name
        problem = name_problem(self.run_name)
        if problem:
            raise HarnessError(f"Run name `{self.run_name}` {problem}.")
        self.run_dir = self.root / "runs" / self.run_name
        self.state = RunState(self.run_dir)
        self.workspace = Workspace(self.project, self.adapter, self.run_dir / "workspace")
        self.prompts = PromptBuilder(self.project, self.config, self.adapter)
        self.checker = Checker(self.project, self.config, self.adapter, self.workspace)
        self.echo = echo
        self.client: Client | None = None
        self._active: tuple[Unit, str, str] | None = None  # (unit, fallback content, mode)
        self._reverify: list[str] = []  # finished units whose tests changed; filled by sync()
        self._env_noted: set[str] = set()  # milestones already reported as missing an environment variable

    # -- setup

    def validate(self) -> Report:
        return validate(self.project, self.config, self.adapter, self.prompts)

    def require_valid(self) -> None:
        report = self.validate()
        for warning in report.warnings:
            self.echo(f"warning: {warning}")
        if report.errors:
            raise SpecError("The spec is invalid:\n  " + "\n  ".join(report.errors))

    def statuses(self) -> dict[str, str]:
        return self.state.statuses(self.project.units)

    def tests_hash(self, paths: Sequence[str]) -> str:
        """Hash of the content of test files (directories included), to notice when tests change."""
        digest = hashlib.sha256()
        for rel in sorted(paths):
            path = self.project.root / rel
            files = sorted(p for p in path.rglob("*") if p.is_file()) if path.is_dir() else [path]
            for file in files:
                digest.update(file.relative_to(self.project.root).as_posix().encode())
                digest.update(file.read_bytes() if file.is_file() else b"<missing>")
        return digest.hexdigest()[:16]

    def sync(self) -> None:
        """Bring state and workspace in line with the current spec.

        Units whose contract changed go back to pending; escalated units whose
        tests changed are retried; finished units whose tests changed are queued
        for re-verification at the start of the next run.
        """
        units = self.project.units
        self._reverify = []
        for uid in [uid for uid in self.state.data["units"] if uid not in units]:
            del self.state.data["units"][uid]
            self.state.drop_accepted(uid)
            self.state.log("unit_removed", unit=uid)
        for uid, unit in units.items():
            entry = self.state.unit(uid)
            current = fingerprint(unit, units)
            tests = self.tests_hash(unit.tests)
            if unit.type == "provided":
                entry.update(status="provided", fingerprint=current)
            elif entry["status"] == "provided":
                entry.update(status="pending", attempts=0)
            elif entry["status"] == "in_progress":  # left over from an interrupted run
                entry["status"] = "pending"
                self.state.log("unit_recovered", unit=uid)
            elif entry["status"] in ("done", "escalated") and entry.get("fingerprint") != current:
                self.echo(f"[{uid}] contract changed; it goes back to pending")
                entry.update(status="pending", attempts=0)
                self.state.log("unit_stale", unit=uid)
            elif entry["status"] == "escalated" and entry.get("tests_hash") != tests:
                self.echo(f"[{uid}] tests changed; the escalated unit will be retried")
                entry.update(status="pending", attempts=0)
                self.state.log("unit_retry_tests_changed", unit=uid)
            elif entry["status"] == "done" and entry.get("tests_hash") != tests:
                self._reverify.append(uid)

        accepted: dict[str, str] = {}
        for uid, unit in units.items():
            if self.state.status(uid) != "done":
                continue
            code = self.state.load_accepted(uid)
            if code is None:  # older state, or accepted/ was deleted: fall back to the workspace
                code = self.workspace.read_region(unit)
                if code is not None:
                    self.state.save_accepted(uid, code)
            if code is None:
                self.echo(f"[{uid}] its accepted code is missing; it goes back to pending")
                self.state.unit(uid).update(status="pending", attempts=0)
                self.state.log("unit_lost", unit=uid)
            else:
                accepted[uid] = code

        for mid, milestone in self.project.milestones.items():
            entry = self.state.milestone(mid)
            if entry["status"] == "pending":
                continue
            if not self._milestone_ready(milestone) or entry.get("basis") != self.milestone_basis(milestone):
                entry.update(status="pending", repairs=0, tried=[])
        self.state.save()
        for note in self.workspace.scaffold(accepted):
            self.echo(note)

    def milestone_basis(self, milestone: Milestone) -> str:
        """Hash of what a milestone result depends on: its tests and the code of every unit beneath it.

        A passed or escalated milestone stays that way only while this is unchanged.
        """
        digest = hashlib.sha256(self.tests_hash(milestone.tests).encode())
        for uid in sorted(dag.closure(self.project.units, milestone.after)):
            unit = self.project.units[uid]
            code = unit.code if unit.type == "provided" else self.state.load_accepted(uid)
            digest.update(uid.encode())
            digest.update((code or "<none>").encode("utf-8", "backslashreplace"))
        return digest.hexdigest()[:16]

    def _reverify_units(self) -> None:
        """Re-run the tests of finished units whose tests changed; rebuild the ones that now fail."""
        for uid in [u for u in dag.topo_order(self.project.units) if u in self._reverify]:
            unit = self.project.units[uid]
            if self.state.status(uid) != "done":
                continue
            tests = [self.workspace.test_path(t) for t in unit.tests]  # its own tests only
            self.workspace.restore_tests(tests)
            ok, _ = self.checker.run_tests(tests) if tests else (True, "")
            self.state.log("unit_reverified", unit=uid, ok=ok)
            if ok:
                self.state.update_unit(uid, tests_hash=self.tests_hash(unit.tests))
                self.echo(f"[{uid}] tests changed; the accepted code still passes")
            else:
                self.echo(f"[{uid}] tests changed and the accepted code fails them; rebuilding it")
                self.state.update_unit(uid, status="pending", attempts=0)
                self.state.drop_accepted(uid)
                self.workspace.write_region(unit, self.workspace.stub(unit))
                self._invalidate_milestones(uid)
        self._reverify = []

    def _invalidate_milestones(self, uid: str) -> None:
        """Send finished milestones that cover `uid` back to pending so they run again."""
        for mid, milestone in self.project.milestones.items():
            if self.state.milestone(mid)["status"] == "pending":
                continue
            if uid in dag.closure(self.project.units, milestone.after):
                self.state.update_milestone(mid, status="pending", repairs=0, tried=[])

    # -- main loop

    def run(self, only: Sequence[str] | None = None, max_units: int | None = None) -> int:
        """Build units until everything is done, blocked, or a limit is reached.

        Returns 0 when nothing failed, 1 when units or milestones were escalated
        or blocked, and 130 when interrupted.
        """
        self.require_valid()
        unknown = sorted(set(only or ()) - set(self.project.units))
        if unknown:
            raise HarnessError(f"Unknown unit(s): {', '.join(unknown)}")
        with self.state.lock():
            self.sync()
            self.require_importable()
            self.client = make_client(self.config)
            model = self.config.model
            self.state.log(
                "run_start", run=self.run_name, config=self.config.path.name, backend=model.backend,
                model=model.model or model.mock_responses, context_window=model.context_window,
                samples=self.config.run.samples, max_attempts=self.config.run.max_attempts,
                settings={  # everything that affects results, for reproducing an experiment
                    "model": asdict(model), "budget": asdict(self.config.budget), "run": asdict(self.config.run),
                    "sanitize": self.config.checks.sanitize,
                    "strict_annotations": self.config.checks.strict_annotations,
                },
            )
            started = time.monotonic()
            processed = 0
            try:
                self._reverify_units()
                while True:
                    self.check_milestones()
                    if max_units is not None and processed >= max_units:
                        break
                    ready = dag.ready(self.project.units, self.statuses())
                    if only:
                        ready = [uid for uid in ready if uid in only]
                    if not ready:
                        break
                    self.process_unit(self.project.units[ready[0]])
                    processed += 1
            except KeyboardInterrupt:
                self._abandon_active()
                self.echo("Interrupted. Progress is saved; run again to continue.")
                return 130
            except BaseException:
                self._abandon_active()
                raise
            finally:
                self.state.log("run_end", duration_s=round(time.monotonic() - started, 2), **self.counts())
        self.echo(self.summary_line())
        counts = self.counts()
        failed_milestones = [
            mid for mid, m in self.project.milestones.items()
            if self.state.milestone(mid)["status"] == "escalated"
            or (self.state.milestone(mid)["status"] == "pending" and self._milestone_ready(m))
        ]
        not_built = [uid for uid in (only or ()) if self.state.status(uid) not in dag.DONE]
        for uid in not_built:
            waiting = sorted(d for d in dag.closure(self.project.units, [uid]) - {uid}
                             if self.state.status(d) not in dag.DONE)
            self.echo(f"[{uid}] was not built" + (f"; it is waiting on: {', '.join(waiting)}" if waiting else ""))
        return 1 if counts["escalated"] or counts["blocked"] or failed_milestones or not_built else 0

    def require_importable(self) -> None:
        """Stop before any model call if the scaffolded workspace cannot even be imported.

        Runs the Python import check (when it applies), then every checks.preflight command.
        """
        ok, output = self.checker.import_check()
        if not ok:
            raise SpecError(
                "The scaffolded workspace cannot be imported, so every test would fail. Common causes: a "
                "circular import between modules, a missing `imports` line, a broken provided unit, or a "
                f"third-party package that is not installed.\n{self.checker.trim(output)}"
            )
        if self.config.checks.preflight:
            self.echo(f"Running {len(self.config.checks.preflight)} preflight command(s)")
        ok, name, output = self.checker.preflight()
        self.state.log("preflight", ok=ok, failed=name or None)
        if not ok:
            raise HarnessError(
                f"The preflight command `{name}` failed, so the run stopped before any model call.\n"
                f"{self.checker.trim(output)}"
            )

    def process_unit(self, unit: Unit, *, mode: str = "implement", extra_tests: Sequence[str] = (),
                     seed: Verdict | None = None, label: str | None = None) -> bool:
        """Work on one unit until it passes or runs out of attempts.

        mode "implement" starts from the stub; mode "repair" starts from the
        current code plus a failure (`seed`) and keeps that code if it fails.
        """
        repair = mode == "repair"
        fallback = (self.workspace.read_region(unit) or "") if repair else self.workspace.stub(unit)
        self._active = (unit, fallback, mode)
        entry = self.state.unit(unit.id)
        rounds = entry.get("rounds", 0) + 1
        self.state.update_unit(unit.id, rounds=rounds, **({} if repair else {"status": "in_progress"}))
        tests = self.test_paths(unit, extra_tests)
        self.echo(f"[{unit.id}] {'repairing for milestone ' + str(label) if repair else 'implementing'}")

        best = seed
        samples_used = 0
        attempts = self.config.run.max_attempts
        for attempt in range(1, attempts + 1):
            use_fix = best is not None and (repair or self.config.run.error_feedback)
            prompt_kind = "fix" if use_fix else "implement"
            messages = self.prompts.build(
                unit, prompt_kind,
                previous_code=(best.code or "(your reply contained no usable code)") if use_fix else None,
                error=best.error if use_fix else None,
            )
            prefix = f"r{rounds}-{mode}" + (f"-{label}" if label else "") + f"-a{attempt}"
            verdict, used = self._attempt(unit, mode, prompt_kind, attempt, prefix, messages, tests, fallback)
            samples_used += used
            if verdict.ok:
                self._passed(unit, mode, attempt, samples_used, label)
                return True
            if verdict.spec_problem:
                self._failed(unit, mode, verdict, attempt, label, verdict.spec_problem)
                return False
            if best is None or verdict.rank >= best.rank:
                best = verdict
        self._failed(unit, mode, best, attempts, label, f"failed {attempts} attempt(s)")
        return False

    def _attempt(self, unit: Unit, mode: str, prompt_kind: str, attempt: int, prefix: str,
                 messages: list[dict[str, str]], tests: list[Path], fallback: str) -> tuple[Verdict, int]:
        """One prompt, up to `samples` candidates. Returns the best verdict and samples used."""
        cfg = self.config
        count = cfg.run.samples
        temperatures = [cfg.model.temperature] + [cfg.model.exploration_temperature] * (count - 1)
        max_tokens = unit.max_output_tokens or cfg.model.max_output_tokens
        assert self.client is not None
        client = self.client

        def request(temperature: float) -> Callable[[], Completion]:
            return lambda: client.complete(messages, temperature=temperature, max_tokens=max_tokens, tag=unit.id)

        def receive(index: int, completion: Completion) -> Completion:
            # Lone surrogates and similar cannot be saved as UTF-8; make the text safe once, here.
            completion.text = completion.text.encode("utf-8", "replace").decode("utf-8")
            self._log_call(unit, mode, prompt_kind, attempt, index + 1, temperatures[index], messages, completion)
            return completion

        parallel = cfg.run.sampling == "parallel" and count > 1
        if parallel:
            completions = [receive(i, c) for i, c in enumerate(_wait_all([request(t) for t in temperatures]))]
            get = completions.__getitem__
        else:
            def get(index: int) -> Completion:
                return receive(index, _wait_all([request(temperatures[index])])[0])

        best: Verdict | None = None
        for index in range(count):
            completion = get(index)
            verdict = self._evaluate(unit, completion, tests, fallback)
            self._record(unit, mode, prompt_kind, attempt, index + 1, f"{prefix}-s{index + 1}",
                         temperatures[index], messages, completion, verdict)
            if verdict.ok or verdict.spec_problem:
                if parallel:  # the remaining samples were already paid for; keep them for analysis
                    for rest in range(index + 1, count):
                        self._record(unit, mode, prompt_kind, attempt, rest + 1, f"{prefix}-s{rest + 1}",
                                     temperatures[rest], messages, completions[rest], None)
                return verdict, (count if parallel else index + 1)
            if best is None or verdict.rank >= best.rank:
                best = verdict
        assert best is not None
        return best, count

    def _evaluate(self, unit: Unit, completion: Completion, tests: list[Path], fallback: str) -> Verdict:
        try:
            verdict = self.checker.static_checks(unit, completion.text, completion.finish_reason)
        except Exception as exc:  # a reply that trips up the analysis must fail, not end the run
            self.state.log("candidate_error", unit=unit.id, error=f"{type(exc).__name__}: {exc}")
            return Verdict(False, "syntax", self.checker.rank("syntax"), None,
                           f"Your code could not be analyzed ({type(exc).__name__}). Write simpler, standard code.")
        if not verdict.ok:
            return verdict
        self.workspace.write_region(unit, verdict.code or "")
        self.workspace.restore_tests(tests)
        passed = False
        try:
            verdict = self.checker.dynamic_checks(unit, verdict, tests)
            passed = verdict.ok
            return verdict
        finally:
            if not passed:
                self.workspace.write_region(unit, fallback)

    def _log_call(self, unit: Unit, mode: str, prompt_kind: str, attempt: int, sample: int,
                  temperature: float, messages: list[dict[str, str]], completion: Completion) -> None:
        """One event per completion received, whether or not it is evaluated (this is what was paid for)."""
        estimated = completion.prompt_tokens is None or completion.completion_tokens is None
        self.state.log(
            "llm_call", unit=unit.id, mode=mode, prompt=prompt_kind, attempt=attempt, sample=sample,
            temperature=temperature,
            prompt_tokens=completion.prompt_tokens or self.prompts.estimate(messages),
            completion_tokens=completion.completion_tokens
            or estimate_tokens(completion.text, self.config.budget.chars_per_token),
            estimated=estimated, latency_s=round(completion.latency_s, 3),
            finish_reason=completion.finish_reason,
        )

    def _record(self, unit: Unit, mode: str, prompt_kind: str, attempt: int, sample: int, name: str,
                temperature: float, messages: list[dict[str, str]], completion: Completion,
                verdict: Verdict | None) -> None:
        """Log a candidate's verdict and save the full exchange. verdict None: received, not evaluated."""
        if verdict is None:
            result = "not evaluated (an earlier sample passed)"
        else:
            self.state.log(
                "candidate", unit=unit.id, mode=mode, attempt=attempt, sample=sample, ok=verdict.ok,
                stage=verdict.stage, rank=verdict.rank, sanitized=verdict.repairs,
                check_s=round(verdict.seconds, 3), file=f"attempts/{unit.id}/{name}.md",
            )
            result = "pass" if verdict.ok else f"fail at {verdict.stage}"
            extra = f" (sanitize: {len(verdict.repairs)} fix(es))" if verdict.repairs else ""
            self.echo(f"  attempt {attempt} sample {sample}: {result}{extra}")
        if not self.config.run.save_attempts:
            return
        verdict = verdict or Verdict(False, "", 0)
        parts = [
            f"# {unit.id} / {name}", "",
            f"- mode: {mode}", f"- prompt: {prompt_kind}", f"- temperature: {temperature}",
            f"- finish_reason: {completion.finish_reason}", f"- result: {result}", "",
        ]
        for message in messages:
            parts += [f"## {message['role']}", "", message["content"], ""]
        parts += ["## reply", "", completion.text, ""]
        if verdict.repairs:
            parts += ["## sanitize", "", *[f"- {r}" for r in verdict.repairs], ""]
        if verdict.notes:
            parts += ["## notes", "", *[f"- {n}" for n in verdict.notes], ""]
        if verdict.error:
            parts += ["## error", "", "```text", verdict.error, "```", ""]
        path = self.state.attempts_dir / unit.id / f"{name}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(parts), encoding="utf-8", errors="backslashreplace")

    def _passed(self, unit: Unit, mode: str, attempt: int, samples: int, label: str | None) -> None:
        current = fingerprint(unit, self.project.units)
        self.state.save_accepted(unit.id, self.workspace.read_region(unit) or "")
        if mode == "repair":
            repairs = self.state.unit(unit.id).get("repairs", 0) + 1
            self.state.update_unit(unit.id, repairs=repairs, fingerprint=current)
            self.state.log("unit_repaired", unit=unit.id, milestone=label, attempts=attempt, samples=samples)
            self.echo(f"[{unit.id}] repaired")
        else:
            self.state.update_unit(unit.id, status="done", attempts=attempt, samples=samples,
                                   fingerprint=current, tests_hash=self.tests_hash(unit.tests),
                                   last_stage=None, last_error=None, reason=None)
            self.state.log("unit_done", unit=unit.id, attempts=attempt, samples=samples)
            self.echo(f"[{unit.id}] done (attempt {attempt}, {samples} sample(s))")
        self._active = None

    def _failed(self, unit: Unit, mode: str, verdict: Verdict | None, attempts: int,
                label: str | None, reason: str) -> None:
        stage = verdict.stage if verdict else "unknown"
        error = verdict.error if verdict else ""
        if mode == "repair":
            self.state.log("repair_failed", unit=unit.id, milestone=label, stage=stage, reason=reason)
            self.echo(f"[{unit.id}] repair failed ({reason}); the previous version stays")
            title = f"{unit.id} (repair for milestone {label})"
        else:
            self.state.update_unit(unit.id, status="escalated", attempts=attempts, last_stage=stage,
                                   last_error=error, reason=reason,
                                   fingerprint=fingerprint(unit, self.project.units),
                                   tests_hash=self.tests_hash(unit.tests))
            self.state.log("unit_escalated", unit=unit.id, stage=stage, reason=reason)
            self.echo(f"[{unit.id}] escalated: {reason}; furthest stage: {stage}")
            title = unit.id
        self.state.note_escalation(
            title,
            [f"reason: {reason}", f"furthest stage: {stage}",
             f"contract: {unit.source}", f"candidates: state/attempts/{unit.id}/"],
            error,
        )
        self._active = None

    def _abandon_active(self) -> None:
        if self._active is None:
            return
        unit, fallback, mode = self._active
        try:
            self.workspace.write_region(unit, fallback)
        except HarnessError:
            pass
        if mode != "repair":
            self.state.update_unit(unit.id, status="pending")
        self._active = None

    def test_paths(self, unit: Unit, extra: Sequence[str] = ()) -> list[Path]:
        """The unit's tests, regression tests of finished related units, and any extra tests.

        Regression "same_file" adds the tests of finished units in the same file;
        "related" also adds those of finished units that depend on this one (they
        exist when a unit is rebuilt after a reset, a contract change, or a repair).
        """
        units = self.project.units
        rels = list(unit.tests)
        mode = self.config.run.regression
        if mode != "none":
            related = [other.id for other in self.project.files[unit.target_file] if other.id != unit.id]
            if mode == "related":
                related += sorted(dag.dependents(units, unit.id))
            for uid in related:
                # Only units whose own dependencies are all finished (apart from this one): otherwise
                # their tests would reach a stub, and the failure would wrongly be blamed on this unit.
                beneath = dag.closure(units, [uid]) - {uid, unit.id}
                if self.state.status(uid) in dag.DONE and all(self.state.status(d) in dag.DONE for d in beneath):
                    rels += units[uid].tests
        rels += list(extra)
        seen: list[str] = []
        for rel in rels:
            if rel not in seen:
                seen.append(rel)
        return [self.workspace.test_path(rel) for rel in seen]

    # -- milestones

    def _milestone_ready(self, milestone: Milestone) -> bool:
        """True when the milestone's units and everything beneath them are finished."""
        return all(
            self.state.status(uid) in dag.DONE
            for uid in dag.closure(self.project.units, milestone.after)
        )

    def missing_env(self, milestone: Milestone) -> list[str]:
        """Variables the milestone needs (requires_env) that the check environment does not have."""
        if not milestone.requires_env:
            return []
        env = {key.upper() for key, value in self.checker.env().items() if value}
        return [name for name in milestone.requires_env if name.upper() not in env]

    def check_milestones(self) -> None:
        for milestone in self.project.milestones.values():
            if self.state.milestone(milestone.id)["status"] != "pending" or not self._milestone_ready(milestone):
                continue
            missing = self.missing_env(milestone)
            if missing:
                if milestone.id not in self._env_noted:
                    self._env_noted.add(milestone.id)
                    self.state.log("milestone_skipped", milestone=milestone.id, missing_env=missing)
                    self.echo(f"[milestone {milestone.id}] not run: it needs {', '.join(missing)}, "
                              "which the check environment does not have")
                continue
            self._run_milestone(milestone)

    def _run_milestone(self, milestone: Milestone) -> None:
        tests = [self.workspace.test_path(t) for t in milestone.tests]
        while True:
            self.workspace.restore_tests(tests)
            ok, output = self.checker.run_tests(tests)
            self.state.log("milestone", milestone=milestone.id, ok=ok)
            if ok:
                self.state.update_milestone(milestone.id, status="done", basis=self.milestone_basis(milestone))
                self.echo(f"[milestone {milestone.id}] passed")
                return
            self.echo(f"[milestone {milestone.id}] integration tests failed")
            entry = self.state.milestone(milestone.id)
            trimmed = self.checker.trim(output)
            unreached = [uid for uid in self.checker.stub_ids(output) if uid in self.project.units]
            suspects = [uid for uid in self._suspects(milestone, output) if uid not in entry["tried"]]
            if unreached:
                reason = (f"tests reached {', '.join(unreached)}, which is not implemented yet; "
                          "add it to the milestone's `after` list")
            elif not suspects:
                reason = "the failure could not be traced to a unit that has not been tried"
            elif entry["repairs"] >= self.config.run.max_milestone_repairs:
                reason = "no repair attempts left"
            else:
                uid = suspects[0]
                self.state.update_milestone(milestone.id, repairs=entry["repairs"] + 1,
                                            tried=entry["tried"] + [uid])
                unit = self.project.units[uid]
                # A repair must not break milestones that already passed with this unit's code.
                protected = [
                    other for mid, other in self.project.milestones.items()
                    if mid != milestone.id and self.state.milestone(mid)["status"] == "done"
                    and uid in dag.closure(self.project.units, other.after)
                ]
                seed = Verdict(False, "tests", self.checker.rank("tests"),
                               code=self.workspace.read_region(unit),
                               error=f"Integration tests failed:\n{trimmed}")
                extra = list(milestone.tests) + [t for other in protected for t in other.tests]
                if self.process_unit(unit, mode="repair", extra_tests=extra, seed=seed, label=milestone.id):
                    for other in protected:  # they passed again with the new code
                        self.state.update_milestone(other.id, basis=self.milestone_basis(other))
                continue
            self.state.update_milestone(milestone.id, status="escalated", reason=reason, last_error=trimmed,
                                        basis=self.milestone_basis(milestone))
            self.state.log("milestone_escalated", milestone=milestone.id, reason=reason)
            self.state.note_escalation(f"milestone {milestone.id}", [f"reason: {reason}"], trimmed)
            self.echo(f"[milestone {milestone.id}] escalated: {reason}")
            return

    def _suspects(self, milestone: Milestone, output: str) -> list[str]:
        """Units to blame for an integration failure, most likely first.

        Traceback frames inside unit regions come first (innermost first). If no
        frame points into a unit, the milestone's own units are the suspects.
        """
        def eligible(uid: str) -> bool:
            return self.project.units[uid].type != "provided" and self.state.status(uid) == "done"

        found: list[str] = []
        for path, line in reversed(self.adapter.locate(output, self.checker.cwd)):
            uid = self.workspace.unit_at(path, line)
            if uid and uid not in found and uid in self.project.units and eligible(uid):
                found.append(uid)
        return found or [uid for uid in milestone.after if eligible(uid)]

    # -- reporting and maintenance

    def counts(self) -> dict[str, int]:
        statuses = self.statuses()
        blocked = dag.blocked(self.project.units, statuses)
        counts = {"done": 0, "provided": 0, "escalated": 0, "blocked": len(blocked), "pending": 0}
        for uid, status in statuses.items():
            if uid not in blocked:
                counts[status if status in counts else "pending"] += 1
        return counts

    def summary_line(self) -> str:
        c = self.counts()
        built = len(self.project.units) - c["provided"]
        passed = sum(self.state.milestone(m)["status"] == "done" for m in self.project.milestones)
        return (f"Units: {c['done']}/{built} done, {c['escalated']} escalated, {c['blocked']} blocked, "
                f"{c['pending']} pending ({c['provided']} provided). "
                f"Milestones: {passed}/{len(self.project.milestones)} passed.")

    def status_rows(self) -> list[tuple[str, str, str, str, str, int, str]]:
        """(unit, kind, type, status, attempts, level, note) sorted by dependency level."""
        units = self.project.units
        statuses = self.statuses()
        blocked = dag.blocked(units, statuses)
        depth = dag.levels(units)
        rows = []
        for uid in sorted(units, key=lambda u: (depth[u], u)):
            entry = self.state.data["units"].get(uid, {})
            attempts = entry.get("attempts") or "-"
            status = "blocked" if uid in blocked else statuses[uid]
            note = ""
            if status == "escalated":
                note = f"{entry.get('reason', '')} (stage: {entry.get('last_stage', '?')})"
            elif status == "blocked":
                waiting = [d for d in units[uid].deps if statuses.get(d) == "escalated" or d in blocked]
                note = "waiting on " + ", ".join(waiting)
            elif entry.get("repairs"):
                note = f"repaired {entry['repairs']}x"
            rows.append((uid, units[uid].kind, units[uid].type, status, str(attempts), depth[uid], note))
        return rows

    def reset(self, unit_ids: Sequence[str] = (), escalated: bool = False, everything: bool = False) -> list[str]:
        """Send units (and milestones) back to pending. Logs and attempt files are kept."""
        units = self.project.units
        unknown = sorted(set(unit_ids) - set(units))
        if unknown:
            raise HarnessError(f"Unknown unit(s): {', '.join(unknown)}")
        with self.state.lock():
            targets = set(units) if everything else set(unit_ids)
            if escalated:
                targets |= {uid for uid in units if self.state.status(uid) == "escalated"}
            targets = {uid for uid in targets if units[uid].type != "provided"}
            for uid in targets:
                rounds = self.state.unit(uid).get("rounds", 0)
                self.state.data["units"][uid] = {"status": "pending", "attempts": 0, "rounds": rounds}
                self.state.drop_accepted(uid)
            for mid, milestone in self.project.milestones.items():
                entry = self.state.milestone(mid)
                below = dag.closure(units, milestone.after)
                if everything or (escalated and entry["status"] == "escalated") or targets & below:
                    self.state.data["milestones"][mid] = {"status": "pending", "repairs": 0, "tried": []}
            self.state.save()
            self.state.log("reset", units=sorted(targets))
            self.sync()
        return sorted(targets)
