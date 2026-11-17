# 02 – Architecture

## Package map

| Module | Responsibility | Main entry points |
|---|---|---|
| `harness/cli.py` | Command-line interface | `main()`; commands `init`, `validate`, `scaffold`, `run`, `status`, `prompt`, `reset`, `report` |
| `harness/orchestrator.py` | The control loop; the only writer of state | `Orchestrator.run`, `sync`, `process_unit`, `check_milestones`, `reset` |
| `harness/spec.py` | Loads and type-checks the spec bundle | `load_project`, `Unit`, `Milestone`, `Project`, `fingerprint` |
| `harness/config.py` | Loads and checks the run config (`harness.yaml`) | `load_config`, `Config` and its sections |
| `harness/validate.py` | Static checks of a spec before anything runs | `validate` → `Report(errors, warnings, budgets)` |
| `harness/dag.py` | The dependency graph | `topo_order`, `levels`, `find_cycle`, `closure`, `dependents`, `ready`, `blocked` |
| `harness/prompts.py` | Builds prompts from templates; token budgets | `PromptBuilder.build`, `budget`, `estimate` |
| `harness/llm.py` | Model clients | `OpenAICompatibleClient`, `MockClient`, `make_client` |
| `harness/checks.py` | The verification ladder | `Checker.static_checks`, `dynamic_checks`, `run_command`, `env`; `Verdict` |
| `harness/text.py` | Extracting code from replies; trimming tool output | `extract_code`, `strip_reasoning`, `trim_output` |
| `harness/workspace.py` | The project being rebuilt: files, regions, stubs | `Workspace.scaffold`, `read_region`, `write_region`, `unit_at`; `safe_path` |
| `harness/state.py` | `status.json`, `log.jsonl`, `escalations.md`, `accepted/`, the run lock | `RunState` |
| `harness/report.py` | Research metrics | `summarize`, `render`, `render_table` |
| `harness/init_project.py` | Creates a project skeleton | `init_project` |
| `harness/lang/` | Everything specific to one programming language | `LanguageAdapter` protocol, `PythonAdapter`, `get_adapter` |
| `harness/templates/` | Default prompt templates | `system.md`, `implement.md`, `integrate.md`, `fix.md` |
| `harness/skeleton/` | Files `init` copies into a new project | `harness.yaml`, `project.yaml`, `conventions.md`, `gitignore` |

The only dependency is PyYAML. Python 3.11+ is required. pytest is what the default test
command uses to run the target project's tests.

## Data flow

```
spec/project.yaml ─┐
spec/contracts/*  ─┼─► load_project ─► validate ─► Orchestrator.sync ─► Workspace.scaffold
tests/            ─┘                     │              │ (spec + accepted code -> files)
harness.yaml ─────► load_config ─────────┘              ▼
                                                  run loop (dag.ready)
                                                        │
          PromptBuilder.build ◄─────────────────────────┤ one unit
                 │                                      │
                 ▼                                      │
          client.complete (SLM) ─► reply text           │
                                     │                  │
             Checker.static_checks ◄─┘                  │
                     │ pass                             │
          Workspace.write_region (candidate on disk)    │
                     │                                  │
             Checker.dynamic_checks (commands, tests)   │
                     │                                  │
        pass: accepted/, status.json = done ────────────┤
        fail: restore region; retry, or escalate ───────┘
                     │
        log.jsonl (every call and verdict), attempts/ (every prompt and reply)
```

## Unit lifecycle

```
                      spec says type: provided
   (in spec) ───────────────────────────────────────► provided   (counts as done)
       │
       ▼
   pending ──process_unit──► in_progress ──passes──► done ──────────┐
     ▲  ▲                         │                    │            │
     │  │                         │ no attempts left,  │            │ contract changed,
     │  │ crash or Ctrl+C         │ or spec problem    │ repair:    │ tests changed and
     │  └─────────(sync)──────────┤                    │ stays done │ now fail, reset,
     │                            ▼                    ▼ if it fails│ or accepted code lost
     │                        escalated ◄──────────────             │
     │                            │                                 │
     └── contract changed, tests changed, or reset ◄────────────────┘

   blocked = an unfinished unit with an escalated unit anywhere beneath it (computed, never stored)
```

A unit is **ready** when everything beneath it is finished: its direct dependencies and theirs,
recursively. Checking only direct dependencies is not enough. After a reset, a finished unit
can sit on top of an unfinished one, and code built on it would call a stub. Ready units are
processed one at a time: shallowest dependency level first, then by id.

## Milestone lifecycle

```
pending ──(all units in the closure of `after` are finished)──► run integration tests
   ▲                                                            │
   │                                    pass ◄──────────────────┤
   │                                     ▼                      │ fail
   │                                    done                    ▼
   │                                     │       stub reached? ──► escalated (spec problem)
   │                                     │       pick suspect (traceback -> unit region,
   │                                     │         else the milestone's own units)
   │                                     │       repairs left and untried suspect?
   │                                     │         yes -> repair that unit, re-run tests
   │                                     │         no  -> escalated
   └── its basis changed: its tests, or the accepted code of any unit beneath it
```

- **Closure** means the listed units plus everything they depend on. A milestone only runs when all of it is finished, so integration tests never meet a stub of a unit that should exist.
- **Basis** is a hash of the milestone's test files plus the accepted code of every unit in its closure. A passed or escalated milestone keeps that status only while its basis is unchanged. An escalated milestone is therefore **not** retried (with model calls) on every run; it is retried only after something it depends on changes, or after `reset --escalated`.
- **A repair cannot break a milestone that already passed.** The repaired unit must pass its own tests, the failing milestone's tests, *and* the tests of every passed milestone that covers it. If two milestones ask for incompatible behavior, the repair fails and the second milestone escalates. Without this rule, the milestones could undo each other forever while the run still reported success.

## What `sync` does

`sync` runs at the start of `run`, `scaffold`, and `reset`. It reconciles state with the
current spec, then regenerates the workspace.

| Condition | Effect |
|---|---|
| Unit is `type: provided` | status `provided`. Its code is written verbatim |
| Unit was `in_progress` (interrupted run) | → `pending` |
| Finished or escalated unit whose **fingerprint** changed (its contract, or the signatures of units it uses) | → `pending` |
| Escalated unit whose **test files changed** | → `pending` (retried) |
| Finished unit whose **test files changed** | Queued for re-verification at the start of `run`. If its accepted code still passes, nothing else happens. If not → `pending`, rebuilt |
| Finished unit with no accepted code (deleted) | Falls back to the code in the workspace. If that is missing too → `pending` |
| Unit removed from the spec | Its state and accepted code are dropped |
| Milestone whose closure is not finished, or whose basis (tests + accepted code beneath it) changed | → `pending` |
| Workspace | Rebuilt from spec + accepted code. Files an earlier scaffold produced that the spec no longer produces are deleted (tracked in `.harness-files.json`) |

After `sync`, `run` imports every module of the workspace once in a subprocess (the **import
check**). If the scaffold cannot be imported, the run stops with exit code 2 before any model
call, because every test would fail. Typical causes are a circular import between modules, a
missing `imports` line, a broken provided unit, or a package that isn't installed.

The fingerprint deliberately excludes the conventions, the digest, and the prompt templates.
Those are prompt context, not part of the contract, so changing them doesn't throw away
finished work. To rebuild after changing them, use `reset`.

## The verification ladder

Cheap checks run first. The first failure stops the ladder, and its message, trimmed to
`budget.max_error_tokens`, becomes the error in the next fix prompt.

| # | Stage | Checks | Where |
|---|---|---|---|
| 1 | `extract` | The reply contains code. Reasoning (`<think>`) is removed. Prefers the last fenced block that *defines* the target, then the largest block. A reply with no fences counts only if it defines the target | memory |
| 2 | `syntax` | The code compiles (Python `compile`). Data files are parsed as JSON, YAML, or TOML by extension | memory |
| – | *sanitize* | Never fails, only repairs: removes top-level calls such as `print(...)`, `if __name__ == "__main__":` blocks, top-level `assert`, `from __future__` imports, and re-definitions of names the file already has (header imports, other units' targets). Can be turned off with `checks.sanitize: false` | memory |
| 3 | `signature` | Target defined at top level. Same parameters (names, kinds, order), same defaults, required decorators. For classes: bases, fields, every listed method. Annotation differences are warnings unless `strict_annotations` | memory |
| 4 | `names` | New top-level names don't collide with names defined by other units in the same file | memory and file read |
| 5 | `imports` | Every import is allowed: the standard library (if `allow_stdlib`), `allowed_imports`, and the project's own packages | memory |
| 6 | *commands* | Each `checks.commands` entry (for example a linter) runs on the target file with the candidate spliced in | disk, subprocess |
| 7 | `tests` | The unit's tests, plus **regression** tests (see below), plus milestone tests during a repair | disk, subprocess |

After each failed candidate the region is restored to its previous content: the stub, or the old
code during a repair.

**What the model is told after a failure:**

- The next attempt's fix prompt contains the previous code and the trimmed error.
- If the reply had no code at all, the fix prompt says so; the attempt does not just repeat the same prompt.
- If sanitize changed the answer before it failed, the error lists what was removed, so the model can see why the tested code differs from its reply.
- Lone surrogates and similar characters are replaced before anything is saved.
- An unexpected exception while analyzing a reply turns into a failed candidate (logged as `candidate_error`) instead of ending the run.

**Regression** (`run.regression`):

- `related` (the default) adds the tests of finished units in the same file and of finished units that depend on this one.
- `same_file` adds only the same-file units.
- `none` adds nothing.

Dependents only exist while a unit is being rebuilt (after a reset, a contract change, or a
re-verification failure) or repaired. Then their tests protect what was already built. A related
unit's tests are included only if everything *it* depends on, apart from the unit being built,
is finished. Otherwise those tests would hit a stub, and the failure would be blamed on the
wrong unit.

**Spec problems:** the test output can show a stub mark (`HARNESS_STUB <unit id>`) for another
unit.

- If the candidate's code names that unit, the model used something it was not given. This is reported as an ordinary error and retried.
- Otherwise, if the stub is **outside the dependency closure** of the unit being built, the contract is missing a link. The unit is escalated at once, without retries. (Everything inside the closure is finished before a unit runs, so a stub can only be reached outside it.)

## Prompt anatomy

Each prompt is built from `prompts/templates/<name>.md` in the project, or falls back to
`harness/templates/`, using `string.Template`.

```
[system]  role + "reply with one code block"
[user]    Project: <digest>
          Conventions: <conventions.md>
          You are writing code for <target file>
          Imports already at the top of that file: <header>
          Existing code you can use: <signature + one-sentence summary + location of each `uses` unit>
          <task: the exact signature to write>
          What it must do: <description>
          Examples: ...           Notes: ...
          [fix only] Previous answer: <code>   Problem: <trimmed error>
          Rules: output format, keep signature, allowed imports, no example usage
```

Only **direct** `uses` are shown, and only their contracts. The template used depends on the
attempt and the unit type:

- `implement` for normal units.
- `integrate` for `type: integrate` units, which are glue code.
- `fix` for attempts after the first (when `run.error_feedback` is on) and for repairs.

**Budget rule** (checked by `validate` for every unit):

```
worst-case fix prompt (previous code at max_output_tokens + error at max_error_tokens)
  + max_output_tokens  <=  context_window × safety_margin
```

Tokens are estimated as characters / `chars_per_token`, plus 8 tokens per message for chat
formatting. Real token counts are logged when the server reports `usage`.

## The workspace

`runs/<run>/workspace/` holds the project being rebuilt. Source files are assembled from marked
regions:

```python
# Assembled by the SLM harness. Each marked region is one unit from spec/contracts.
# >>> header
from __future__ import annotations          # always: signatures may name classes defined later
from textstats.models import Stats          # union of the `imports` of the units in this file
# <<< header


# >>> unit: analyze.compute_stats
def compute_stats(text: str, top_n: int = 3) -> Stats:
    raise NotImplementedError('HARNESS_STUB analyze.compute_stats')   # until the unit is done
# <<< unit: analyze.compute_stats
```

- Regions appear in dependency order inside each file.
- A `file` unit owns its whole file, with no markers.
- Files under `spec/scaffold/` are copied verbatim. Missing `__init__.py` files are created when `auto_init` is on.
- Marker-looking lines in model output are dropped, so a reply cannot corrupt the region structure.
- **The workspace is a derived artifact.** It is a pure function of spec + `state/accepted/`, so deleting it loses nothing. The next `scaffold` or `run` recreates it.

## Failure handling

| Event | What happens |
|---|---|
| Ctrl+C | Handled at once, even during a slow model request (requests run in background threads). The current region is restored, the unit goes back to `pending`, a running check's process tree is killed, and the run exits with code 130 |
| Process killed or crashes mid-check | On the next sync, an `in_progress` unit goes back to `pending`. Every region is rewritten from accepted code, so a half-checked candidate is never kept |
| Model server unreachable or HTTP error | Up to 3 tries with backoff (2 s, then 4 s) for connection errors, dropped connections, and HTTP 408, 429, 500, 502, 503, 504. Other HTTP errors stop at once. Then the region is restored, the run stops, and the exit code is 3. No attempts are spent |
| A check's executable is missing | The run stops with a clear error and exit code 2. No attempts are spent |
| Check timeout | The whole process tree is killed (`taskkill /T` on Windows, the process group on POSIX), including processes the code under test started. Output goes to a temporary file, not a pipe, so a leftover process cannot keep the harness waiting. The candidate fails with "timed out; look for an infinite loop" plus the output so far |
| A second orchestrator on the same run | Refused by `state/.lock`. A lock left by a process that no longer exists on this machine (after a hard kill) is removed automatically |
| `status.json` damaged | A clear error naming the file |
| A half-written line in `log.jsonl` | Skipped when reading |

## Security model

The harness runs **model-written code** inside test subprocesses with your user account's
permissions. It is **not a sandbox.** The mitigations are:

- The model never gets a shell or file access. It only returns text.
- All paths in the spec are resolved inside the workspace or project. `..` and absolute paths are rejected (`safe_path`). Deleting a stale file is limited to paths inside the workspace.
- Checks get an **allowlisted** environment. They inherit only variables matching `checks.inherit_env`: OS basics, `PATH`, temp and home folders, `PYTHON*`, locale. Variables matching `checks.secret_env_patterns`, and `model.api_key_env`, are always removed. Cloud keys, tokens, database URLs, and agent sockets are not passed on.
- API keys are read from an environment variable named in the config, never stored in files, and never logged.
- The import policy rejects unexpected packages. This is a quality check, not a security boundary: code can still use `__import__` or `subprocess`.

**What this does not protect against:** the code under test still runs as your user. It can read
files your account can read (for example `~/.aws`, `.netrc`, SSH keys), and it can use the
network. For untrusted or very capable models, run the harness inside a container or VM with no
credentials, no access to your home folder, and no network beyond the model server.

## Extension points

- **Prompt templates:** override any of `system.md`, `implement.md`, `integrate.md`, `fix.md` in `prompts/templates/`. The variables are listed in the [reference](05-reference.md#prompt-template-variables).
- **Extra checks:** `checks.commands` in the run config (linters, type checkers). Each one becomes a ladder stage named after the check.
- **Another language:** implement the `LanguageAdapter` protocol (`harness/lang/__init__.py`) and register it in `_ADAPTERS`. The orchestrator, state, prompts, DAG, and region splicing don't depend on the language. The adapter supplies:
  - Signature parsing, stub rendering, and the file header.
  - The syntax check, sanitizing, the signature check, and defined names.
  - The import policy, traceback location, and package init files.
  - The environment for checks.
