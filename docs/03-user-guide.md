# 03 – User guide

All commands run from the repository root (`test-on-SLMs/`) with `python -m harness ...`.
Every command except `init` accepts:

- `-p/--project DIR`: the project folder (default `.`).
- `-c/--config FILE`: the run config, relative to the project (default `harness.yaml`).
- `-r/--run NAME`: the run name (default: `run_name` in the config).

## 1. Install

Requirements: Python 3.11+, PyYAML, and pytest (used to run the target project's tests).

```bash
python -m pip install pyyaml pytest
# optional: install the package so `slm-harness` works from anywhere
python -m pip install -e .
```

## 2. Run the demo (no model needed)

```bash
python -m harness validate -p examples/textstats -c harness.mock.yaml
python -m harness run      -p examples/textstats -c harness.mock.yaml
python -m harness status   -p examples/textstats -c harness.mock.yaml
python -m harness report   -p examples/textstats -c harness.mock.yaml
```

The mock backend replays the scripted replies in `examples/textstats/mock_responses.yaml`. The
run takes a few seconds and shows the whole loop:

- `tokenize.tokenize` fails its tests on the first try, and the fix prompt corrects it.
- `tokenize.StopWordFilter` and `analyze.compute_stats` contain a stray `print(...)` and a re-declared dependency. Sanitizing removes both.
- Milestone `m1_cli` runs the package end to end with `python -m textstats`.

Look at what the model "saw" in `examples/textstats/runs/mock/state/attempts/<unit>/*.md`. Each
file holds the full prompt, the reply, the sanitize notes, and the error.

## 3. Connect a real small model

Any server that exposes the OpenAI chat-completions API works. Set `model.base_url` and
`model.model` in the run config:

| Server | Typical `base_url` | Notes |
|---|---|---|
| Ollama | `http://localhost:11434/v1` | `model` is the Ollama model tag. Set the server's context length to match `context_window`. Default context lengths are often smaller than you expect |
| llama.cpp `llama-server` | `http://localhost:8080/v1` | Start it with a context size (`-c`) at least as large as `context_window` |
| vLLM | `http://localhost:8000/v1` | `model` is the served model name |
| LM Studio | `http://localhost:1234/v1` | Enable the local server and load the model first |

Before running against a real model, check these:

1. **Context length:** `model.context_window` must match what the server actually uses. A server with a smaller window may silently cut long prompts, and the results will look like model failures.
2. **Output length:** `model.max_output_tokens` (default 1024) caps each reply. If replies get cut off, `finish_reason: length` shows in the attempt files, and the fix prompt tells the model to write shorter code.
3. **API keys:** if the server needs one, put the *name* of an environment variable in `model.api_key_env` and set that variable in your shell. Never put the key itself in a file. Checks never see that variable.
4. **Isolation:** checks run model-written code as your user. They get a reduced environment with no secrets, but they can still read your files and use the network. For anything beyond a trusted local experiment, run the harness in a container or VM.
5. **Reasoning models:** `<think>...</think>` sections are removed automatically. Increase `max_output_tokens` if the model reasons at length before answering.
6. **Server-specific options** go in `model.extra_body`, which is passed through unchanged. Example: `{"seed": 1}` for servers that support seeded sampling.

Then:

```bash
python -m harness validate -p examples/textstats            # uses harness.yaml
python -m harness run      -p examples/textstats
```

**Data handling:**

- If the target repository is internal or proprietary, use a **local** model server. Sending code to an external API publishes it outside your control.
- Specs and tests should use synthetic or de-identified data, **never production member data**.

## 4. Start a new replication target

```bash
python -m harness init projects/my-target
```

This creates:

```
projects/my-target/
  harness.yaml            # run config (every option documented inline)
  spec/project.yaml       # name, digest, import policy, milestones
  spec/conventions.md     # short rules included in every prompt
  spec/contracts/         # one YAML file per module or group of units
  spec/scaffold/          # files copied verbatim into the workspace
  tests/unit/  tests/integration/
  prompts/templates/      # copies of the default prompts, safe to edit
  .gitignore              # ignores runs/
```

Writing the spec is the planner's job. See the [planner guide](04-planner-guide.md).

## 5. The day-to-day loop

```bash
python -m harness validate -p P            # 1. errors, warnings, token budget per unit
python -m harness prompt UNIT -p P         # 2. read the exact prompt a unit will get
python -m harness run -p P                 # 3. build until done or blocked
python -m harness status -p P              # 4. where things stand
python -m harness report -p P              # 5. metrics
```

**Reading `validate`:**

- **Errors** stop a run. Examples: unknown dependency, cycle, missing test file, a unit over the token budget.
- **Warnings** point at likely context gaps. Examples: a unit uses a function that no import brings into its file; a prompt mentions a project class that is not in `uses`; a unit has no tests.
- The budget table shows each unit's normal prompt, its worst-case fix prompt, and the limit.

**Reading `run` output:**

```
[tokenize.tokenize] implementing
  attempt 1 sample 1: fail at tests
  attempt 2 sample 1: pass
[tokenize.tokenize] done (attempt 2, 2 sample(s))
[milestone m1_cli] passed
Units: 6/6 done, 0 escalated, 0 blocked, 0 pending (2 provided). Milestones: 1/1 passed.
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Nothing failed |
| 1 | Units or milestones escalated or blocked |
| 2 | Invalid spec or config |
| 3 | Model server error |
| 130 | Interrupted (progress is saved) |

**Partial runs:**

- `--max-units N` stops after N units.
- `--unit ID` (repeatable) builds only those units. Everything beneath them must already be done. If it isn't, the run says what each requested unit is waiting on and exits with code 1.

Runs can stop and continue at any time. Run `run` again to resume. Ctrl+C takes effect at once,
even during a slow model request.

**Before the first model call**, `run` imports every module of the scaffolded workspace once. If
that fails (a circular import, a missing `imports` line, a broken provided unit, or a missing
package), the run stops with exit code 2 and shows the import error, so no model calls are
wasted on a workspace that cannot work.

## 6. Handling escalations

An escalated unit failed all its attempts, or has a spec problem. `status` shows the reason
and the furthest stage it reached. `runs/<run>/state/escalations.md` has the last error, and
`state/attempts/<unit>/` has every candidate.

Typical causes and fixes:

| Symptom (furthest stage, message) | Likely cause | Fix |
|---|---|---|
| `extract` / `syntax` repeatedly | The model ignores the output format, or the reply is cut off | Raise `max_output_tokens`; shorten the unit; edit `system.md` / `implement.md` |
| `signature` repeatedly | The contract signature is unusual, or the model keeps renaming things | Simplify the signature; add a note; check that the planner's signature is valid Python |
| `names` | The helper names clash with other units in the file | Ask for prefixed helpers in `conventions.md`, or split the file |
| `imports` | The model needs a package you didn't allow | Add it to `allowed_imports`, or tell it in `notes` which standard module to use |
| `tests` with wrong values | The description is ambiguous, or the unit is too large | Add examples, clarify the description, split the unit |
| "The tests reached X, which is not implemented yet" | **Spec problem**: a missing `uses`/`after` | Add the dependency to the contract |
| Milestone escalated, "not implemented yet" | The milestone tests exercise a unit outside its `after` closure | Add the unit to the milestone's `after` |
| Milestone escalated after a repair failed, while another milestone passed | The two milestones may ask for incompatible behavior. Repairs must keep every passed milestone passing | Check both milestones' tests against the original project; fix whichever is wrong |

An escalated milestone stays escalated until something it depends on changes: its test files, or
the accepted code of a unit beneath it. Then it runs again automatically. Re-running with nothing
changed costs no model calls.

The harness picks up the fix automatically:

- **Changing a contract** sends the unit back to pending.
- **Changing its test files** retries an escalated unit.
- After changing anything else (for example the prompt templates or `conventions.md`), use `python -m harness reset --escalated -p P`.

If the model cannot do a unit at all, the planner can write it as a **provided** unit (`code:`).
It then counts as provided, not as model-built, and is reported that way.

## 7. Comparing models and settings

Use one run config per model or setting, each with its own `run_name`:

```bash
python -m harness run -p P -c harness.qwen-3b.yaml     # run_name: qwen-3b
python -m harness run -p P -c harness.phi-mini.yaml    # run_name: phi-mini
python -m harness report --all -p P                    # side-by-side table
python -m harness report --json -p P -c harness.qwen-3b.yaml
```

Each run has its own workspace and state under `runs/<run_name>/`, so runs never interfere.
See the [research guide](06-research.md) for experiment design and ablations.

## 8. Resetting

```bash
python -m harness reset UNIT [UNIT ...] -p P     # rebuild specific units
python -m harness reset --escalated -p P          # retry every escalated unit and milestone
python -m harness reset --all -p P                # start the run over (logs and attempts are kept)
```

A reset unit's dependents keep their code. While the unit is rebuilt, their tests run as
regression tests (with `run.regression: related`). To discard a run completely, delete
`runs/<run_name>/`.

## 9. Troubleshooting

| Problem | What to do |
|---|---|
| `This run is locked` | Another orchestrator is running on the same run. Locks left by a process that no longer exists on this machine are removed automatically. If the lock came from another machine (shared folder) and nothing is running, delete `runs/<run>/state/.lock` |
| `The scaffolded workspace cannot be imported` | Read the import error shown. Fix the circular import, the missing `imports` line, or the broken provided unit, or install the package |
| Every unit fails at `tests` with `ModuleNotFoundError` | `checks.env.PYTHONPATH` doesn't point at your source root. The default is `{workspace}/src` and `{workspace}` |
| Test runs are slow | pytest loads every installed plugin at startup. Set `PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1"` in `checks.env` if your tests don't need plugins (this took startup from about 2.7 s to 0.4 s on the development machine) |
| `Could not reach the model server` (exit code 3) | Check that the server is running and that `base_url` ends in `/v1` (or wherever its chat-completions route lives). Local URLs never go through a proxy |
| Replies cut off | Raise `max_output_tokens`; check `finish_reason` in the attempt files |
| `validate` reports a unit over budget | Split the unit, shorten its description and examples, lower `max_error_tokens`, or use a model with a larger context |
| A test needs an environment variable that checks don't receive | Checks only inherit variables matching `checks.inherit_env` (OS basics, `PATH`, temp/home, `PYTHON*`, locale), and never those matching `checks.secret_env_patterns`. Set the value explicitly in `checks.env` (preferred), or add its name to `inherit_env` |
| Every test fails with a missing Windows variable or "cannot find" errors | A tool needs a variable outside the default allowlist. Add its name to `checks.inherit_env` |
| Stale files in the workspace | Files the harness produced earlier are removed automatically when the spec stops producing them. Files you created by hand are never touched |
