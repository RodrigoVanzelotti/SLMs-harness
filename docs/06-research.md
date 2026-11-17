# 06 – Research guide

## Metrics (`python -m harness report`)

Units are counted only if the model builds them. Provided units are reported separately and
never counted as model successes.

| Metric | Definition |
|---|---|
| `units_built_by_model` | Units with `type` other than `provided` |
| `done`, `escalated`, `blocked`, `pending` | Current status counts (blocked = waiting on an escalated dependency) |
| `pass_rate` | done / built (current status) |
| `pass_rate_first_attempt` | Units whose **first round** ended done on attempt 1 (any sample) / built. A unit that escalated, was reset, and then passed does not count |
| `pass_rate_first_sample` | Units whose first round passed on attempt 1, sample 1 / built. This is closest to "one-shot" ability |
| `mean_attempts_when_done`, `mean_samples_when_done` | Effort per finished unit, in its latest round. Samples count every completion requested, including parallel samples that were not evaluated |
| `milestones_passed` / `milestones_total` | Integration success |
| `repairs_succeeded`, `repairs_failed` | Milestone-driven repairs |
| `llm_calls`, `prompt_tokens`, `completion_tokens` | Cost: every completion received, including parallel samples requested but not needed. Real counts when the server reports `usage`, otherwise estimates (`token_counts_estimated`) |
| `tokens_per_done_unit`, `max_prompt_tokens` | Cost per success, and the largest prompt actually sent |
| `llm_seconds`, `wall_seconds` | Model time and total run time |
| `candidate_failures_by_stage` | Where candidates fail: extract, syntax, signature, names, imports, your commands, tests |
| `sanitize_repairs` | How many deterministic repairs were applied |

`report --all` puts every run of a project side by side, and `--json` gives machine-readable
output. For anything finer, `log.jsonl` has one event per model call and per candidate, and
`state/attempts/` has every exchange in full.

## Experiment design

**Fix the spec, vary the run config.** The spec bundle is the experimental material. Each
model or setting gets its own run config and `run_name`. Runs never share state. Start every
experiment in a new run rather than with `reset --all`: first-try metrics are computed from each
unit's first round in the run's log. For example:

```bash
python -m harness run -p P -c harness.qwen-1.5b.yaml
python -m harness run -p P -c harness.qwen-7b.yaml
python -m harness report --all -p P
```

Every `run_start` event records the full model, budget, and run settings, plus `sanitize` and
`strict_annotations`. A run's settings can always be recovered from its log.

### Ablation switches

Each switch below is one line in the run config:

| Question | Switch |
|---|---|
| Does best-of-N help, and how much N is enough? | `run.samples: 1 / 3 / 5` |
| Does feeding back the error beat a fresh retry? | `run.error_feedback: true / false` |
| How much do deterministic repairs save? | `checks.sanitize: true / false` |
| Do retries matter at all? | `run.max_attempts: 1 / 3 / 5` |
| Does sampling diversity matter? | `model.temperature`, `model.exploration_temperature` |
| How much error text is useful? | `budget.max_error_tokens: 100 / 300 / 800` |
| Does a system message help this model? | `model.system_prompt: true / false` |
| Does protecting finished work catch real regressions? | `run.regression: related / same_file / none` |
| Is the signature contract too strict? | `checks.strict_annotations` |
| Does context size limit success? | `model.context_window` (with a server configured to match) |

### Baselines

To show what the harness adds, compare against:

1. **SLM, no harness:** one prompt with the whole spec (or the original README) asking for the full project. Score it with the same tests.
2. **SLM, harness minimal:** `samples: 1`, `max_attempts: 1`, `sanitize: false`, `error_feedback: false`. This isolates the effect of decomposition alone.
3. **Large model in the same harness:** gives an upper bound for the spec. Units it can't do point at spec problems, not model limits.

### Repetitions and randomness

Sampling is random above temperature 0, so run each configuration several times. Use a
separate `run_name` for each, for example `qwen-7b-r1`, `qwen-7b-r2`, `qwen-7b-r3`, and report
the mean and spread. If the server supports seeds, set them through
`model.extra_body: {"seed": N}`. Not every server honors seeds.

## Threats to validity

| Threat | Mitigation |
|---|---|
| **Weak oracle.** Tests that pass wrong code inflate success | Check tests against the original implementation; include edge cases; use milestones |
| **Spec leakage.** Descriptions so detailed they amount to code turn "rebuild" into "transcribe" | Describe behavior, not implementation; review descriptions; report average description length |
| **Provided units.** Planner-written code counts as help | Reported separately; keep few; justify each one |
| **Token estimates.** The budget check uses characters / 3.5 | Real counts are logged when the server reports `usage`; compare `max_prompt_tokens` with the real window |
| **Server truncation.** A server with a smaller window silently cuts prompts | Configure the server's context explicitly; check `finish_reason` and the attempt files |
| **Mock versus real.** The demo uses scripted replies | Never report mock runs as results |
| **One target repository** | Repeat on targets of different size and domain before generalizing |

## Data handling

- Use synthetic or de-identified data in specs, examples, tests, and fixtures. Never use production member data.
- For internal or proprietary target repositories, use a local model server. Prompts contain spec text and code, and sending them to an external API publishes them.
- API keys go in environment variables named by `model.api_key_env`, never in config files. Checks never receive them.
- `runs/` contains every prompt and reply. Treat it like the source it was generated from. It is ignored by git by default.
