# 07 – Review and roadmap

This page records the full review of the harness (2026-11-16): what was checked, what was
found and fixed, which practices the code follows, its known limits, and a prioritized
improvement backlog.

## How the review was done

1. **Line-by-line re-read** of every module in `harness/`, the templates, the skeleton, the example project, and the test suite. Each design decision was checked against what the code actually does.
2. **An independent review** by a separate reviewer, given the code and the README but none of the conclusions from step 1, so it was not anchored on them. Each finding was reproduced with a script before it was reported, and each one was checked again against the code before it was fixed.
3. **Every fix is covered by a test.** For four central fixes, the fix was undone in a scratch copy to confirm that its test then fails: repairs protecting passed milestones, transitive readiness, regression tests waiting for their own dependencies, and the environment allowlist. The suite grew from 43 to 86 tests, and all of them pass.
4. **Static checks:** all modules import cleanly with warnings treated as errors, and a scan for unused imports found none. A third-party linter (`ruff`) could not be downloaded in this environment, so it was not run.

## Findings from the line-by-line review (all fixed)

| # | Area | Finding | Consequence before the fix | Fix |
|---|---|---|---|---|
| 1 | Integrity | The workspace was the only record of accepted code | A crash while a **repair** candidate was being tested left that unverified code in place, with the unit still marked done | Accepted code is stored in `state/accepted/`. The workspace is rebuilt from spec + accepted code on every sync, and deleting it loses nothing |
| 2 | Regression | A rebuilt or repaired unit was only checked against same-file neighbors | A repair or rebuild could break units that depend on it, with no test run to notice | `run.regression: related` (now the default) also runs the tests of finished dependents |
| 3 | Planner loop | Changes to test files were ignored | After the planner fixed a test, finished units were never re-checked and escalated units stayed stuck | Test content is hashed. Finished units are re-verified (rebuilt only if they now fail), escalated units are retried, and milestones re-run |
| 4 | Security | Checks inherited the full environment | Model-written code could read API keys from environment variables | First a name denylist; later replaced by an allowlist (independent review, R3) |
| 5 | Workspace | Files of renamed or removed units stayed in the workspace | Stale modules stayed importable and could mask errors | `.harness-files.json` manifest. Files the harness produced earlier and no longer produces are deleted. Hand-made files are kept |
| 6 | Milestones | A repaired unit didn't re-trigger other milestones that cover it | A milestone could stay "passed" against code that had since changed | Superseded by the stricter rule in R1: repairs must keep passed milestones passing |
| 7 | Defaults | No `PYTHONPATH` unless the config set it | A minimal run config failed every test with `ModuleNotFoundError` | The default import path comes from `source_roots` |
| 8 | Example spec | `cli.main` used `compute_stats` (which returns `Stats`) without `models.Stats` in `uses` | The model would have to guess the field names | Example fixed. `validate` now warns about this pattern |
| 9 | Validation | Several planner mistakes were not detected before a run | Wasted model calls and confusing failures | New checks: function/class targets must be source files; cross-file functions need an import (warning); classes mentioned in a prompt must be in `uses` (warning); milestone coverage counts the whole dependency closure |
| 10 | Model client | Dropped connections were not retried; list-form message content was not handled | A raw traceback ended the run; some servers' replies were read as empty | Both handled |
| 11 | State files | A damaged `status.json` raised a raw traceback; a half-written log line broke `report` | Confusing errors; `report` could not run while `run` was writing | A clear error for `status.json`; incomplete log lines are skipped |
| 12 | Config | Negative temperatures, zero timeouts, and similar values were accepted | Undefined behavior later in the run | Value checks; later also type checks (R12) |
| 13 | Research | Sanitizing and error feedback could not be switched off; settings were only partly logged | Their effect could not be measured, and runs were hard to reproduce | `checks.sanitize` and `run.error_feedback` switches; `run_start` logs every setting that affects results |
| 14 | Usability | `status` didn't say why a unit was escalated or blocked | Teammates had to open `escalations.md` | A note column (reason and stage, or what a blocked unit waits on) |
| 15 | Metrics | No cost-per-success figure | Hard to compare cost-effectiveness across models | `tokens_per_done_unit` and `max_prompt_tokens` |
| 16 | Tests | No tests for the CLI, configured command checks, `file` units built by the model, `system_prompt: false`, damaged state, or environment filtering | Regressions there would go unnoticed | Tests added for each |
| 17 | Skeleton | After the `PYTHONPATH` change, `checks.env:` in the `init` skeleton had only comments under it, which YAML reads as null | Every new project would crash at its first check | Skeleton fixed. Empty keys now mean "use the default", and the new type checks report real type errors |

A related fix from the first build session: milestones originally waited only for their direct
`after` units. If a deeper dependency went back to pending, a milestone could stay "passed" or
run against a stub. Milestones now wait for the whole dependency closure.

## Independent review findings (all fixed)

The reviewer reported 15 findings and reproduced each one. All 15 were confirmed against the
code before being fixed. Tests are in `tests/test_review_findings.py` unless noted.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R1 | High | **Milestones could undo each other.** A repair for one milestone could break another that had passed, and the run still exited 0. Invalidation also reset the repair budget, so the two milestones could swap forever | A repair must pass the tests of every *passed* milestone that covers the unit. Incompatible milestones now escalate instead of oscillating. Milestones that are pending but ready count as failures in the exit code |
| R2 | High | **False "spec problem" escalations, and readiness that ignored indirect dependencies.** Regression tests of related units could reach stubs further down, and the current unit was blamed. A unit above an escalated unit could run when the unit in between was finished | `ready()` and `blocked()` use the full dependency closure. Regression tests are included only when their own dependencies are finished. A spec problem is reported only for stubs outside the unit's closure |
| R3 | High | **Secrets still reached checks.** A name denylist let `AZURE_OPENAI_KEY`, `GITHUB_PAT`, `DATABASE_URL`, `AWS_ACCESS_KEY_ID`, and `SSH_AUTH_SOCK` through | Checks inherit only an **allowlist** (`checks.inherit_env`: OS basics, PATH, temp/home, `PYTHON*`, locale), with the denylist applied on top. The docs now say plainly what is *not* protected (file and network access) and recommend a container (`test_cli_and_safety.py`) |
| R4 | Medium | **Unit ids that differ only by case** overwrote each other's accepted code on Windows and macOS. A Windows device name such as `nul` as an id crashed | Unit and milestone ids are checked for case collisions. Those ids and run names are checked for device names and unsafe characters. Targets that differ only by case are a validation error |
| R5 | Medium | **Timeouts were not enforced on Windows** when the code under test started a process: the harness waited on pipes held by the grandchild | Output goes to a temporary file instead of pipes. On timeout, or on Ctrl+C, the whole process tree is killed |
| R6 | Medium | **Unusual replies could crash a run.** `splitlines()` splits on form feeds and ` `, which Python's line numbering does not, so sanitize removed the wrong lines. A lone surrogate crashed the writing of attempt files | Splitting is on `\n` only, everywhere (extraction, sanitize, workspace). Replies are made UTF-8-safe on receipt. An exception while analyzing a reply becomes a failed candidate (`candidate_error`) instead of ending the run |
| R7 | Medium | **Metrics were wrong.** Parallel samples that were requested but not needed were not counted. pass@1 used the latest round, so a reset turned a failure into a "first-attempt pass" | Every completion received is logged and saved (unneeded ones are marked "not evaluated"). First-try metrics use each unit's first round |
| R8 | Medium | **Self-referencing or forward annotations broke the stub file** (NameError at import), and sanitize stripped a correct `from __future__ import annotations` | Every assembled Python file starts with `from __future__ import annotations`. An import check of the whole scaffold runs before the first model call |
| R9 | Medium | **Escalated milestones were retried (with model calls) on every run**, even when nothing had changed | Milestones store a *basis* hash (test files + accepted code beneath them). They are re-run only when it changes |
| R10 | Medium | **Some failures never reached the model.** A reply without code led to the same prompt again. Sanitize removals were not explained. A syntax error in a planner's test file used up the attempts | A fix prompt is sent even without code. Errors list what sanitize removed. `validate` compiles every test file |
| R11 | Low | **Ctrl+C waited for the model request in progress**, which could take minutes | Requests run in daemon threads, and the main thread waits in 0.2 s steps |
| R12 | Low | **Config types were not checked.** `extensions: ".py"` silently disabled a check, and `command: "pytest -q"` became single-letter arguments | Every value is checked against the dataclass annotations |
| R13 | Low | **Target paths were not normalized.** `./src/a.py` and `src/a.py` were treated as two files | Paths are normalized with `posixpath.normpath` |
| R14 | Low | **Silent edits by sanitize:** it collapsed blank lines inside string literals. A fence inside a docstring ended code extraction early | Blank lines are no longer collapsed. A block closes only at a bare fence indented no deeper than its opening fence |
| R15 | Low | **Minor robustness:** an empty mock entry gave a raw TypeError; `run --unit X` with unfinished dependencies did nothing and exited 0; a lock left by a killed process had to be deleted by hand | Clear config error; a message about what X waits on plus exit code 1; a stale lock (dead process on the same host) is removed automatically |

The reviewer also confirmed these as working correctly:

- Path containment.
- No execution of model output in the harness process.
- Region splicing bounds.
- Traceback attribution with Windows paths.
- Signature-change propagation.
- Python 3.11 compatibility.
- UTF-8 BOM handling.
- Atomic state writes.
- Thread safety of parallel sampling.

## Changes for the first real target (TypeScript, 2026-11-16)

The first target, [github.com/Alles725/amazon](https://github.com/Alles725/amazon), is a
TypeScript monorepo, so the harness needed a second adapter. These changes are general; none of
them is specific to that project.

| Change | Why |
|---|---|
| `TypeScriptAdapter` with a Node.js helper around the TypeScript compiler | Parsing TypeScript correctly (generics, JSX, decorators) needs the real parser. One long-lived process keeps each call around a millisecond |
| Unit kind `declaration` | TypeScript projects are full of exported constants, types and interfaces that are neither functions nor classes |
| `tests_in_workspace` | vitest and jest resolve imports from the test file's location, so the tests must sit inside the workspace. They are copied again before every run, so code under test cannot change its own judge |
| `checks.preflight` | Replaces the Python import check for other languages: install and build before the first model call, and fail with the output instead of burning attempts |
| Milestone `requires_env` | Integration suites that need a database should wait, not fail and trigger repairs of correct code |
| Header merge per module, directives first, original order kept | Two units importing from one module must not bind a name twice, and CSS or polyfill imports must keep their place |
| `validate` asks the adapter for type names and type-only declarations | Without this, names inside decorators and constructor parameters flooded the prompt-context warnings |

**Tests added:** 17, covering the following. 103 tests pass in total.

- Stubs and contracts.
- Header merging.
- Every sanitize repair.
- Function, class and declaration signature checks.
- The import policy and stack-frame parsing.
- A TypeScript project end to end, run with Node's own type stripping:
  - A retry with feedback.
  - Sanitizing.
  - A milestone.
  - Preflight success and failure.
  - `requires_env`.
  - A spec problem from an undeclared stub.

## Practices the code follows

- **Deterministic control, probabilistic workers.** All decisions are made by code with fixed rules. The model only proposes text.
- **Single writer.** Only the orchestrator writes state. `status.json` is written atomically (temporary file, then `os.replace`, with a retry for Windows file locks). The log is append-only.
- **Derived artifacts.** The workspace is a pure function of spec + accepted code. Milestone results are tied to a basis hash of exactly what they tested.
- **Fail fast with a reason.** Spec problems, broken scaffolds, and uncompilable tests stop work before model calls are spent, and every escalation names the stage, the reason, the contract, and where the candidates are.
- **Least privilege by default.** No shell or file access for the model, path containment for every spec path, an allowlisted environment for checks, and keys never stored or logged.
- **Strict input checking.** Unknown keys are rejected, and values are type- and range-checked, so typos fail loudly instead of being ignored.
- **Observability.** Every prompt, reply, verdict, and setting is recorded, including samples that were paid for but not needed.
- **Small surface.** One runtime dependency (PyYAML). The standard library is used for HTTP, hashing, threads, and subprocesses.
- **Language isolation.** Everything language-specific sits behind one adapter protocol (Python and TypeScript).
- **Tested behavior.** End-to-end tests drive real runs through the mock backend. The HTTP client is tested against a local fake server. Key fixes were checked by undoing them and confirming that their tests fail.

## Known limits

| Limit | Effect | Notes |
|---|---|---|
| Not yet run against a real SLM | Behavior with real model output is unverified | Verified only with scripted replies and a fake server |
| Two languages | Python and TypeScript have adapters; others need one | The rest of the harness doesn't depend on the language |
| TypeScript signatures are compared as text | Two equivalent types written differently (`Array<T>` and `T[]`) count as a mismatch | Type mismatches are warnings unless `strict_annotations`. Decorators, parameters, exports and members are compared structurally |
| No in-process import check for TypeScript | A broken scaffold is only caught by the first tests | Use `checks.preflight` to install and load the workspace |
| One unit at a time | Wall time grows linearly with the number of units | Samples within an attempt can run in parallel |
| Not a sandbox | Model-written code runs as your user and can read your files and use the network | The environment is allowlisted. Use a container or VM for untrusted models |
| Token counts are estimated for budgets | A unit can exceed the real window if text tokenizes poorly | Real counts are logged when the server reports them; calibrate `chars_per_token` |
| Milestone blame is heuristic | A repair may target the wrong unit | Bounded by `max_milestone_repairs`; each unit is tried at most once per milestone |
| Tests are trusted | A wrong test makes a unit impossible, and a weak test accepts wrong code | Check tests against the original implementation (planner guide) |
| `names` check is strict | Two units in one file can't both define the same module-level helper or constant | Use prefixed helper names (conventions) or separate files |
| Sanitize drops every top-level call | A unit that legitimately needs a module-level side effect (for example a registration call) loses it | Put such code in a `provided` unit or the scaffold, or set `checks.sanitize: false` |
| Process-tree kill relies on `taskkill /T` on Windows | A process started *after* its parent exited can escape | A Windows Job Object would close this gap (backlog) |
| The import check needs the harness's interpreter | It is skipped when `checks.tests.command` uses another interpreter | Run the harness from the target project's environment when possible |
| Stale-lock detection is per machine | A lock from another machine (shared folder) must still be removed by hand | The lock records the host for this reason |
| Developed and tested on Windows 11 / Python 3.13 | Other platforms are untested | POSIX paths (process groups, `os.kill(pid, 0)`) are written but not exercised |

## Improvement backlog

### Priority 1: before or at the first real experiments

1. **Smoke test with a real server** (Ollama or llama.cpp) on `examples/textstats`. Compare the logged real token counts with the estimates and calibrate `chars_per_token`.
2. **Check oracle tests against the original implementation:** an optional mode that runs the oracle tests against the target repository's own code before Phase B. Tests that fail there are wrong.
3. **Escalation triage summary:** group escalations by stage and reason in `report`, so the planner sees which kind of spec fix is needed most.
4. **Run the suite on Linux or macOS** to exercise the POSIX code paths.

### Priority 2: scale and robustness

5. **Parallel units:** process independent ready units concurrently, each in its own copy of the workspace, merging accepted code.
6. **Sandboxed checks:** an optional runner that executes checks in a container with no network, no credentials, and no access to the home folder.
7. **Windows Job Objects** for checks, so no descendant process can survive a timeout.
8. **Constrained output:** use server-side grammar or JSON-schema decoding where available (llama.cpp, vLLM) to remove the `extract` and `syntax` failure classes.
9. **Per-model prompt variants:** allow the run config to point at its own template folder, so prompts can be tuned per model family without changing the spec.
10. **Extraction and sanitize fuzzing:** property-based tests on random replies (fences, encodings, nesting) to find crashes before real models do.

### Priority 3: convenience and reach

11. **`show UNIT` command:** accepted code, last error, attempt history, and dependents in one view.
12. **HTML report** across runs, with charts of pass rate, cost, and failure stages.
13. **More language adapters** (Go, Java), following the `LanguageAdapter` protocol. TypeScript is done.
14. **Unit-split suggestions:** when a unit escalates at `tests` with varying errors, point the planner at it as a likely candidate for splitting.
15. **Semantic TypeScript signature checks:** compare types with the type checker instead of as text.
16. **Generic planner tooling:** move the extract, split and replay tools of `projects/amazon-mvp/tools/` into the harness, configurable per repository.
17. **Per-unit database tests:** services in database-backed projects are verified only by integration milestones today. Per-service tests against a disposable database would give each one its own oracle.
