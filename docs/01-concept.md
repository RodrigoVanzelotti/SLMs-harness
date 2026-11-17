# 01 – Concept

## Research question

Can a small language model (roughly 1–8B parameters, a small context window, limited reasoning)
rebuild an existing software project from zero? The condition is that a large model decomposes
the work first and a deterministic harness manages it.

Secondary questions:

- How far does an SLM get: which share of units, and which milestones?
- What does it cost in model calls, tokens, and time?
- Which harness features matter most? Candidates are best-of-N sampling, error feedback, automatic repairs of model output, and regression tests.
- Where does the approach break? Is it unit size, missing context, weak tests, or integration?

## Why small models need this structure

| SLM limitation | What goes wrong without help | How the design compensates |
|---|---|---|
| Small context window | It cannot hold the project, or even a large file | Work is cut into **black-box units**. A prompt holds one contract plus the *signatures* of the units it uses. Each unit has an enforced token budget |
| Weak long-horizon planning | It loses track of what is done, repeats work, and drifts | A large model plans **once**. The orchestrator that walks the plan is **plain code** |
| Weak self-assessment | It reports success when the code is wrong | **Independent tests** written by the planner decide. The model's opinion of its own work is never asked |
| Output format drift | Prose, example usage, `__main__` blocks, re-declared dependencies | The model only returns text. The harness extracts the code, **sanitizes** it deterministically, and splices it into one marked region |
| Invented APIs and packages | Imports that don't exist, calls to functions that were never defined | Dependency signatures are given explicitly. An **import policy** check rejects unknown packages |
| Cheap but noisy | Any single answer is unreliable | **Best-of-N** sampling with tests as the judge, and **retries with error feedback** |

## The three layers

```
┌──────────────────────────────────────────────┐
│ PLANNER: large model or person, once         │  reads the original repository
│   -> spec bundle: contracts, tests,          │
│      milestones (spec/ and tests/)           │
└───────────────────────┬──────────────────────┘
                        │ files (read-only for the harness)
┌───────────────────────▼──────────────────────┐
│ ORCHESTRATOR: harness/, plain Python         │  orders units, builds prompts,
│   only writer of state                       │  checks answers, records outcomes
└───────────────────────┬──────────────────────┘
                        │ one small prompt per call
┌───────────────────────▼──────────────────────┐
│ WORKERS: the SLM, stateless                  │  implementer, fixer, repairer
│   sees one black box at a time               │  (roles = prompt templates)
└──────────────────────────────────────────────┘
```

The original idea was "mini agents that communicate through centralized files". The design maps
it like this:

- **Mini agents are roles, not processes.** There are three: *implementer* (the implement and integrate prompts), *fixer* (the fix prompt, with the previous code and the error), and *repairer* (a fix prompt seeded with an integration-test failure). Each is the same SLM with a different template.
- **Agents talk only through files**, a "blackboard" pattern:
  - The spec feeds the prompts.
  - Answers are turned into verdicts, which go into `status.json` and `log.jsonl`.
  - Failures go into `escalations.md`, for a person or the planner.
- **The orchestrator is the single writer.** Workers return text. They never edit state directly, so a malformed answer cannot corrupt the shared files, and parallel samples cannot race.

## Design principles

1. **The orchestrator is code, not a model.** Scheduling, dependency tracking, retries, and bookkeeping follow fixed rules, so code does them reliably and repeatably.
2. **A unit is a black box: a contract plus tests.** Other units see only its contract (signature and a one-sentence summary). They never see its implementation. This keeps prompts small and makes units replaceable.
3. **The planner writes the tests, not the SLM.** A model that writes both the code and its tests tends to make them agree with each other. The tests are the ground truth that all roles share.
4. **Clean room.** The SLM never sees the original source, only the specs. This keeps context small and makes the result mean something: the SLM rebuilt the project, it didn't copy it.
5. **Budgets are enforced.** `validate` computes the worst-case prompt for every unit, including the retry prompt with the previous code and error at full size. It fails units that would not fit.
6. **Workers are stateless.** Everything the system knows is in files, so a run can stop at any point and continue later.
7. **The workspace is derived, never trusted.** On every sync, the code being rebuilt is regenerated from the spec plus the accepted code of finished units. A crash in the middle of a check cannot leave unverified code behind.
8. **Spec problems fail fast.** If a test reaches a unit the contract didn't declare, retrying cannot help, so the unit is escalated at once with a precise message.
9. **Everything is recorded.** Every prompt, reply, check result, and setting is saved, so every number in a report can be traced back to the exact exchange that produced it.

## Phases

**Phase A, planning** (large model, once per target repository). Details are in the
[planner guide](04-planner-guide.md).

1. Inventory: languages, dependencies, entry points, external input/output.
2. Feature map: what the project visibly does. These become milestones.
3. Dependency graph, then the unit cut (about one function or small class per unit).
4. Contracts, oracle tests (ideally checked against the original code), and milestones.
5. `validate` (references, cycles, budgets), then a **review gate** with a person before Phase B.

**Phase B, execution** (harness plus SLM). Details are in the [user guide](03-user-guide.md)
and the [architecture](02-architecture.md). `python -m harness run` walks the dependency graph
until every unit is done, escalated, or blocked.

**Phase C, analysis and iteration.** Details are in the [research guide](06-research.md).

- `report` and `report --all` give metrics and comparisons across models.
- Ablations work by changing only the run config.
- Escalations go back to the planner. Fixing a contract or a test automatically sends the affected units back for another try.

## Current status (2026-11-16)

- The harness, an example project (`examples/textstats`), and a test suite (86 tests) are complete. All tests pass.
- It has been through a line-by-line review and an independent review. All 32 findings are fixed and covered by tests. See [07](07-review-and-roadmap.md).
- It has been verified with the scripted mock backend and against a fake OpenAI-compatible server. **It has not yet been run against a real SLM.** No model server was installed on the development machine.
- **Next step:** Phase A for the target repository, once the link is shared.

## Glossary

| Term | Meaning |
|---|---|
| Unit | One black box: a function, a class, or a whole file |
| Contract | A unit's specification: target, signature, description, examples, tests, dependencies |
| Spec bundle | `spec/` plus `tests/`. Everything the planner produces |
| Provided unit | A unit whose code the planner wrote (no model call). Typically trivial data models |
| Candidate | One model reply for one unit |
| Sample | One candidate within an attempt. Best-of-N means N samples per attempt |
| Attempt | One prompt, sampled up to N times. Attempt 2 and later use the fix prompt |
| Round | One pass of `process_unit` over a unit. A unit gets a new round after a reset or for a repair |
| Verdict | The result of the ladder for one candidate: pass, or the stage it failed at and why |
| Verification ladder | extract → syntax → sanitize → signature → names → imports → configured commands → tests |
| Sanitize | Deterministic repairs of model output, such as removing `print(...)` or a re-declared dependency |
| Escalated | A unit that failed all its attempts, or that has a spec problem. It needs a person or the planner |
| Blocked | A unit that cannot run because something it depends on escalated |
| Milestone | Integration tests that run once their units, and everything beneath them, are finished |
| Repair | Re-prompting a finished unit with a milestone failure. A failed repair keeps the old code |
| Accepted code | The code that passed for a finished unit, stored in `state/accepted/` |
| Workspace | `runs/<run>/workspace/`, the project being rebuilt. Regenerated on every sync |
| Run | One named experiment: `runs/<run_name>/` with its own workspace and state |
