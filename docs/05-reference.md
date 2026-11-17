# 05 – Reference

## Directory layout

```
<project>/
  harness.yaml                     run config (any name; pass with -c)
  spec/
    project.yaml                   project settings and milestones
    conventions.md                 rules included in every prompt
    contracts/**/*.yaml|yml|json   units
    scaffold/**                    copied verbatim into the workspace
  tests/**                         oracle tests (unit and integration)
  prompts/templates/*.md           optional overrides of the default templates
  runs/<run_name>/
    workspace/                     the project being rebuilt (derived; safe to delete)
      .harness-files.json          files the last scaffold produced
    state/
      status.json                  current status of units and milestones
      log.jsonl                    append-only event history
      escalations.md               items that need a person or the planner
      accepted/<unit>.txt          accepted code of finished units
      attempts/<unit>/r<round>-<mode>[-<milestone>]-a<attempt>-s<sample>.md
      .lock                        present while an orchestrator works on the run
```

## Run config (`harness.yaml`)

Unknown keys are rejected. Every field is optional.

### `run_name`

| Field | Default | Meaning |
|---|---|---|
| `run_name` | `default` | Folder under `runs/`. Letters, digits, `.`, `_`, `-` |

### `model`

| Field | Default | Meaning |
|---|---|---|
| `backend` | `openai` | `openai` (any OpenAI-compatible server) or `mock` (scripted replies) |
| `base_url` | `http://localhost:11434/v1` | The server's base URL. The client posts to `<base_url>/chat/completions` |
| `model` | `""` | Model name the server expects. Required for `openai` |
| `api_key_env` | `null` | **Name** of the environment variable that holds the API key |
| `context_window` | `8192` | The model's context length in tokens. Must match the server |
| `max_output_tokens` | `1024` | Maximum tokens per reply. Contracts can override it per unit |
| `temperature` | `0.2` | First sample of every attempt |
| `exploration_temperature` | `0.7` | Remaining samples |
| `timeout_s` | `300` | Per request |
| `system_prompt` | `true` | `false` folds the system message into the user message |
| `extra_body` | `{}` | Passed through to the server unchanged (for example `{"seed": 1}`) |
| `mock_responses` | `null` | For `mock`: YAML file of `{unit_id: [reply, ...]}`, relative to the config file. Replies are served in order, and the last one repeats |

### `budget`

| Field | Default | Meaning |
|---|---|---|
| `chars_per_token` | `3.5` | Token estimate used by budget checks |
| `safety_margin` | `0.9` | Prompt + answer must fit in `context_window × safety_margin` |
| `max_error_tokens` | `500` | Size limit of the error text in fix prompts |

### `run`

| Field | Default | Meaning |
|---|---|---|
| `samples` | `3` | Candidates per attempt (best-of-N, judged by the tests) |
| `sampling` | `lazy` | `lazy`: request one sample at a time and stop at the first pass. `parallel`: request all at once |
| `max_attempts` | `3` | Attempts per unit before escalation |
| `error_feedback` | `true` | Retries get the previous code and error (fix prompt). `false`: a fresh implement prompt. Repairs always use feedback |
| `regression` | `related` | Extra tests per candidate. `related`: finished units in the same file plus finished dependents. `same_file`. `none` |
| `max_milestone_repairs` | `2` | Repairs per milestone before it is escalated |
| `save_attempts` | `true` | Write every prompt and reply to `state/attempts/` |

### `checks`

| Field | Default | Meaning |
|---|---|---|
| `cwd` | `{workspace}` | Working directory for checks |
| `env` | `{}` | Extra variables. List values are joined with the OS path separator. For `*PATH` variables the inherited value is appended. `PYTHONPATH` defaults to `{workspace}/<each source root>` plus `{workspace}` |
| `inherit_env` | see below | Inherited variables must match one of these names or glob patterns (case-insensitive). `["*"]` inherits everything except secrets |
| `secret_env_patterns` | see below | Variables with matching names (case-insensitive glob) are never inherited, even if `inherit_env` matches them. `model.api_key_env` is always removed |
| `sanitize` | `true` | Deterministic repairs of model output |
| `strict_annotations` | `false` | `true`: annotation mismatches fail the signature check |
| `commands` | `[]` | Extra ladder stages (see below) |
| `preflight` | `[]` | Commands that `run` executes once, in order, after the workspace is rebuilt and before the first model call. Examples: install dependencies, generate code, build shared packages. A failure stops the run (exit code 2) and shows the trimmed output |
| `tests` | pytest, see below | The test command |

The default `inherit_env` is:

- **OS:** `PATH`, `PATHEXT`, `SYSTEMROOT`, `SYSTEMDRIVE`, `WINDIR`, `COMSPEC`, `OS`, `NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE`.
- **Folders:** `TEMP`, `TMP`, `TMPDIR`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `PROGRAMFILES`, `PROGRAMFILES(X86)`, `PROGRAMW6432`, `COMMONPROGRAMFILES`, `COMMONPROGRAMFILES(X86)`.
- **User and locale:** `USERNAME`, `USER`, `LOGNAME`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `TERM`, `SHELL`.
- **Python:** `PYTHON*`, `VIRTUAL_ENV`, `CONDA_PREFIX`, `PYTEST_*`.

The default `secret_env_patterns` are: `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*PASSWD*`,
`*API_KEY*`, `*APIKEY*`, `*CREDENTIAL*`, `*PRIVATE_KEY*`, `*CONNECTION_STRING*`.

Every config value is type-checked; a wrong type is an error. A key left empty in YAML (only
comments under it) means "use the default".

A command check (an entry of `commands` or `preflight`, or `tests`) has these fields:

| Field | Default | Meaning |
|---|---|---|
| `name` | required (`tests` for the test command) | The stage name in logs. It must not reuse a built-in stage name |
| `command` | required | List of arguments. Placeholders: `{python}` (the harness's interpreter), `{workspace}`, `{project}`, `{file}` (the unit's target file), and `{tests}`. An element that is exactly `{tests}` expands to all test paths |
| `timeout_s` | `120` | A timeout counts as a failure |
| `extensions` | `[]` | Only run for target files with these suffixes. Empty means all |

The default test command is:

```yaml
["{python}", "-m", "pytest", "{tests}", "-x", "-q", "--tb=short", "--no-header", "-p", "no:cacheprovider"]
```

A check passes when the command exits with code 0.

## Project file (`spec/project.yaml`)

| Field | Default | Meaning |
|---|---|---|
| `name` | folder name | Project name |
| `language` | `python` | Selects the language adapter |
| `digest` | name | One or two sentences, in every prompt (warning above about 150 tokens) |
| `conventions` | `conventions.md` | File under `spec/`, in every prompt (warning above about 300 tokens) |
| `allow_stdlib` | `true` | Allow standard-library imports |
| `allowed_imports` | `[]` | Allowed third-party top-level modules |
| `source_roots` | `[src]` | Package roots inside the workspace |
| `packages` | derived | The project's own top-level packages (always importable). Derived from targets under `source_roots` |
| `auto_init` | `true` | Create missing `__init__.py` files (Python) |
| `tests_in_workspace` | `false` | Copy `tests/<path>` to `<workspace>/<path>` on every scaffold, and run tests from there. Before each run, the test files are copied again, in case code under test changed them. With this on, every test path must start with `tests/`, and no test file may land on a scaffold file or a unit target. Use it for test runners that resolve imports relative to the test file, such as vitest and jest |
| `milestones` | `[]` | A list of milestone entries (below) |

A milestone entry has these fields:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique id |
| `after` | no | Units that must be finished, together with everything they depend on |
| `tests` | yes | Integration test paths, relative to the project |
| `description` | no | For people |
| `requires_env` | no | Variables the tests need, for example `DATABASE_URL`. If one is missing from the check environment (after `inherit_env` and `checks.env`), the milestone is not run. It stays pending, is logged as `milestone_skipped`, and `run` exits with 1 |

## Contracts (`spec/contracts/**`)

A file can hold one unit (a mapping), a list of units, or `units: [ ... ]`. Files load in
sorted path order. Unknown keys are rejected.

Ids (unit, milestone, and run names) become file and folder names, so they must work on every
platform:

- They may contain only letters, digits, `.`, `_`, and `-`, and must not start with `.` or `-` or end with `.`.
- They must not start with a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`).
- Unit ids must not differ from another unit id only by case, and the same applies to milestone ids. Run names are not compared: on Windows and macOS, `Test` and `test` are the same `runs/` folder, so keep run names distinct beyond case.

Target and test paths are normalized (`./src//a.py` becomes `src/a.py`). Two targets that differ
only by case are an error.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique. Letters, digits, `.`, `_`, `-` |
| `target` | yes | `path/file.py::name` (function, class or declaration), or a plain path (whole file). Relative to the workspace |
| `kind` | no | `function`, `class`, `declaration` (a constant, type, interface or enum), or `file`. Inferred from `target` and `signature` |
| `type` | no | `implement` (default), `integrate`, or `provided` (implied by `code`) |
| `signature` | function, class, declaration | Python: a `def` line, a class skeleton with `...` bodies, or `NAME: type`. TypeScript: a function head without a body, a class with body-less members, `export const NAME: Type`, or a full `interface`/`type` |
| `description` | yes, unless provided | Behavior and edge cases. The first sentence is the summary shown to dependents |
| `uses` | no | Units shown in the prompt as signature + summary. They are built first |
| `after` | no | Built first, but not shown |
| `imports` | no | Import lines merged into the file header |
| `examples` | no | Strings, or `{input, output}` mappings |
| `tests` | no | Test files or folders for this unit |
| `notes` | no | Extra hints in the prompt |
| `code` | provided only | Code written verbatim, with no model call |
| `stub` | no | Initial content of a `file` unit |
| `max_output_tokens` | no | Per-unit override of `model.max_output_tokens` |

## Commands

| Command | Options | Purpose |
|---|---|---|
| `init DIR` | – | Create a project skeleton. Refuses if `DIR/spec` exists |
| `validate` | – | Errors, warnings, and a token budget table. Exit code 1 if there are errors |
| `scaffold` | – | Sync state and rebuild the workspace |
| `run` | `--unit ID` (repeatable), `--max-units N` | Build units |
| `status` | – | Units by level with status, attempts, and notes; milestones; summary |
| `prompt UNIT` | `--fix` | Print the exact prompt and token estimates |
| `reset [UNIT ...]` | `--escalated`, `--all` | Send units back to pending. Logs and attempt files are kept |
| `report` | `--all`, `--json` | Metrics for one run, or a table of all runs |

Common options: `-p/--project` (default `.`), `-c/--config` (default `harness.yaml`), and
`-r/--run` (default: `run_name` from the config).

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success. For `run`: nothing escalated or blocked |
| 1 | `run`: units or milestones escalated or blocked, or a unit named with `--unit` could not be built. `validate`: errors found |
| 2 | Invalid spec, invalid config, a scaffold that cannot be imported, or a usage error |
| 3 | Model server error |
| 130 | Interrupted |

## Prompt template variables

Templates use `string.Template` syntax: `$name` or `${name}`. Write a literal `$` as `$$`.

| Variable | Content |
|---|---|
| `$project_name`, `$project_digest` | From `project.yaml` |
| `$conventions` | `conventions.md` (or `(none)`) |
| `$language`, `$language_name`, `$fence` | For example `python`, `Python`, and the code-fence tag (by file extension for `file` units) |
| `$unit_id`, `$target_file`, `$target_name` | The unit being written |
| `$task` | "Write this function/class:" plus the signature, or "Write the complete contents of ..." |
| `$description`, `$examples`, `$notes` | From the contract. `$examples` and `$notes` are empty if unset |
| `$file_imports` | The file header (imports of every unit in the target file) |
| `$dependencies` | Signature, summary, and location of each `uses` unit |
| `$allowed_imports` | The import policy in words |
| `$output_rule` | The required reply format |
| `$previous_code`, `$error` | Fix template only |

## `status.json`

```json
{
  "units": {
    "<unit id>": {
      "status": "pending | in_progress | done | escalated | provided",
      "attempts": 2, "samples": 2, "rounds": 1, "repairs": 0,
      "fingerprint": "<16 hex>", "tests_hash": "<16 hex>",
      "last_stage": null, "last_error": null, "reason": null,
      "updated_at": "2026-11-16T20:40:12+00:00"
    }
  },
  "milestones": {
    "<milestone id>": {"status": "pending | done | escalated", "repairs": 0, "tried": [],
                       "basis": "<16 hex>", "reason": null, "last_error": null}
  }
}
```

- `samples` is the number of completions requested for the unit. In parallel mode, that is every sample of every attempt.
- A milestone's `basis` is the hash of its test files and of the accepted code of every unit beneath it.
- `.lock` holds `{"pid", "host", "since"}`.

`blocked` is never stored. It is computed from the dependency graph.

## `log.jsonl` events

Each line is one JSON object with `ts` (UTC) and `event`.

| Event | Fields |
|---|---|
| `run_start` | `run`, `config`, `backend`, `model`, `context_window`, `samples`, `max_attempts`, `settings` (model, budget, and run sections; `sanitize`; `strict_annotations`) |
| `run_end` | `duration_s`, `done`, `provided`, `escalated`, `blocked`, `pending` |
| `llm_call` | One per completion received, including parallel samples that were not evaluated. Fields: `unit`, `mode` (implement/repair), `prompt` (implement/fix), `attempt`, `sample`, `temperature`, `prompt_tokens`, `completion_tokens`, `estimated`, `latency_s`, `finish_reason` |
| `candidate` | One per evaluated completion: `unit`, `mode`, `attempt`, `sample`, `ok`, `stage`, `rank`, `sanitized` (list of repairs), `check_s`, `file` |
| `candidate_error` | `unit`, `error`. The harness's own analysis of a reply raised an exception. The candidate counts as failed |
| `unit_done` | `unit`, `attempts`, `samples` |
| `unit_escalated` | `unit`, `stage`, `reason` |
| `unit_repaired` / `repair_failed` | `unit`, `milestone`, and `attempts`, `samples` or `stage`, `reason` |
| `milestone` | `milestone`, `ok` |
| `milestone_escalated` | `milestone`, `reason` |
| `milestone_skipped` | `milestone`, `missing_env`. Logged once per run |
| `preflight` | `ok`, `failed` (the failing command's name, or null) |
| `unit_stale` | `unit`. The contract changed |
| `unit_retry_tests_changed` | `unit`. An escalated unit's tests changed |
| `unit_reverified` | `unit`, `ok`. A finished unit's tests changed |
| `unit_recovered` | `unit`. It was `in_progress` after an interruption |
| `unit_lost` | `unit`. A finished unit with no accepted code |
| `unit_removed` | `unit`. No longer in the spec |
| `reset` | `units` |

## Attempt files

`state/attempts/<unit>/r<round>-<mode>[-<milestone>]-a<attempt>-s<sample>.md` contains:

- A header: mode, prompt kind, temperature, `finish_reason`, and the result.
- Every message sent (`## system`, `## user`).
- The raw reply (`## reply`).
- The repairs sanitize made (`## sanitize`).
- Warnings (`## notes`).
- The trimmed error (`## error`).

Rounds increase after resets and for repairs, so files are never overwritten.

## Language adapters

`language` in `project.yaml` selects the adapter. The adapter decides how signatures are
read, how stubs look, and which deterministic repairs and static checks run.

| | Python | TypeScript |
|---|---|---|
| Parser | `ast` (in process) | The TypeScript compiler, in a Node.js helper (`harness/lang/ts_helper.cjs`) that runs for the whole harness process. It only parses; it never runs code |
| Requires | – | Node.js on `PATH`, and the `typescript` package. It is found through `HARNESS_TYPESCRIPT` (a path; if set, it must work), then the project folder's `node_modules`, then the global npm folder |
| Region markers | `# >>> unit: id` | `// >>> unit: id` |
| File header | `from __future__ import annotations`, then the merged imports | Directives (`'use client'`), then the imports merged per module (a name stays type-only only if every line imports it as a type), then `export ... from` lines. `imports` entries may be imports, `export ... from` lines, local `export { name }` lists, or a directive |
| Stubs | `raise NotImplementedError("HARNESS_STUB id")` | Function and method bodies `throw new Error("HARNESS_STUB id")`. A constant gets a Proxy that throws on first use |
| Kinds | `function`, `class`, `file`; `declaration` only as `provided` | `function` (a function declaration, or a `const` arrow function), `class`, `declaration` (`provided` for types and interfaces; implemented constants need `export const NAME: Type`), `file` |
| Sanitize removes | `from __future__` imports, `__main__` blocks, top-level expressions and asserts, redefinitions | Directives, top-level expressions such as `console.log(...)`, imports of names the header already has (rewritten when partly new), redefinitions, and `export { target }` or `export default target` when the target is already exported |
| Signature check | Parameters, defaults, `async`, decorators, base classes, fields, methods | Export and default export, `async`, generators, parameters (names, optional, defaults, rest), class decorators, `extends`, members (static, parameter properties, method and parameter decorators). Types are soft unless `strict_annotations` |
| Import policy | Top-level module names; the standard library | Package names (`@scope/pkg`) or patterns (`@nestjs/*`); prefixes ending in `/` (such as `@/`); `node:` modules and Node.js built-ins as the standard library; relative imports always allowed |
| Stack frames for milestone blame | Python tracebacks | `at ... (file:line:col)`, vitest `❯ file:line:col`, and `file(line,col)` from `tsc` |
| Check environment | `PYTHONPATH`, `PYTHONDONTWRITEBYTECODE`, `PYTHONIOENCODING` | `FORCE_COLOR=0`, `NO_COLOR=1`, `CI=1` |

