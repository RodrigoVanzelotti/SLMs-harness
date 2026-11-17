# 04 – Planner guide

The planner turns a target repository into a **spec bundle**: `spec/` plus `tests/`. A
small model will build the project from this bundle alone, so the bundle decides most of the
outcome. Every field is defined in the [reference](05-reference.md).

## What the planner produces

```
spec/project.yaml        name, one-paragraph digest, import policy, milestones
spec/conventions.md      <= ~200 tokens of rules every unit follows
spec/contracts/*.yaml    one contract per unit
spec/scaffold/**         files copied verbatim (pyproject.toml, conftest.py, fixtures, data)
tests/unit/**            the oracle for each unit
tests/integration/**     the oracle for each milestone
```

## Procedure

1. **Inventory the target.** Language and version, dependencies, entry points (CLI, API, jobs), file sizes, external input/output (files, network, databases, environment variables).
2. **Map the features.** List what the project visibly does: commands, endpoints, pipelines. Each important feature becomes a **milestone** with an integration test.
3. **Build the dependency graph** from imports and calls.
4. **Cut the units** (rules below). Start with the shared foundation: data models, error types, constants. Push input/output to thin `integrate` units at the edges, so the core stays pure and easy to test.
5. **Write the contracts:** signature, description, examples, `uses`, `imports`.
6. **Write the oracle tests.** Ideally, run the original code on sample inputs and record its outputs (characterization tests). Check that the original implementation passes your tests. If it fails one, the test is wrong.
7. **Run `validate`** until there are no errors. Treat every warning as a probable gap in a prompt.
8. **Read a few prompts** with `python -m harness prompt UNIT`. Ask: could I write this unit from this text alone?
9. **Review gate:** a person reviews the unit list and the dependency graph before any run. The cut decides more of the outcome than anything else.

## Cutting units

A unit is the right size when all of these hold:

- **It fits:** `validate` shows the worst-case fix prompt plus the answer within `context_window × safety_margin`. As a guide, aim for about 20–80 lines of output.
- **It stands alone:** its contract makes sense without reading another unit's code.
- **It can be tested on its own** with its declared `uses` and nothing else.
- **It is describable** in about 3–10 lines of description and 1–3 examples.

Signs a unit is too big:

- The description lists many steps.
- The examples need long setup.
- The model keeps failing at `tests` with different errors each time.

Split such a unit into helpers with their own contracts, and make the original unit an
`integrate` unit that calls them.

Ways to choose a unit type and kind:

| Situation | Use |
|---|---|
| Pure logic | `implement` function or class |
| Glue code that calls several units (CLI `main`, request handler, pipeline runner) | `type: integrate` |
| Trivial definitions (dataclasses, enums, constants) or code the model cannot produce | `type: provided` with `code:` (counted separately in reports) |
| A data or config file (JSON, YAML, TOML) | `kind: file` (a plain path as target, no `::name`) |
| Shared fixtures, `conftest.py`, `pyproject.toml`, sample data | `spec/scaffold/`, copied verbatim, never shown to the model |

## Writing contracts

**Ids** become file names. Use `module.name` style. Ids must not differ from each other only by
case, and must not start with a Windows device name such as `con` or `nul` (`validate` rejects
both).

```yaml
units:
  - id: analyze.compute_stats                      # unique; also the attempts/ folder name
    target: src/textstats/analyze.py::compute_stats
    signature: "def compute_stats(text: str, top_n: int = 3, stop_words: Iterable[str] = ()) -> Stats"
    uses: [tokenize.tokenize, tokenize.StopWordFilter, analyze.word_frequencies, models.Stats]
    imports:                                        # merged into the file header
      - from collections.abc import Iterable
      - from textstats.models import Stats
      - from textstats.tokenize import StopWordFilter, tokenize
    description: |
      Tokenize the text, remove stop words with StopWordFilter, then count word frequencies.
      total_words is the number of words left after filtering; unique_words is the number of distinct words.
      top_words holds the top_n most frequent words as (word, count) pairs, sorted by count
      (highest first) and then alphabetically when counts are equal.
    examples:
      - 'compute_stats("b a b c", top_n=2) == Stats(total_words=4, unique_words=3, top_words=[("b", 2), ("a", 1)])'
    tests: [tests/unit/test_compute_stats.py]
```

**Signature**
- For functions, one `def` line.
- For classes, a skeleton with `...` bodies. Include every public method, and the fields for dataclasses.
- Decorators belong in the signature if they matter (`@property`, `@dataclass`, `@staticmethod`).

**Description**
- The first sentence is the summary other units see when they use this one, so make it stand on its own.
- Describe behavior, not implementation. State edge cases explicitly: empty input, ties, errors and their exception types.

**Examples**
- Short and exact. `call == result` strings work well.
- An example costs tokens in every prompt for this unit, so pick the ones that settle ambiguity.

**`uses`**
- Every unit this one calls *or whose type it needs to understand*. The model sees their signatures and summaries, and nothing else.
- If a signature it will see mentions a project class, add that class to `uses`. `validate` warns when you forget.

**`after`**
- Ordering without showing the unit in the prompt. Rarely needed.

**`imports`**
- Every import the code needs, for names from other files or the standard library.
- The model is told these already exist. A function from another file that no import provides triggers a `validate` warning.
- Every assembled Python file starts with `from __future__ import annotations`, so signatures may name a class defined later in the file, or the class itself. Provided code must not contain its own `from __future__` imports.
- Avoid circular imports between modules. `run` imports the whole scaffold once before any model call and stops if that fails.

**`notes`**
- Extra hints, such as "use `re.findall`" or "do not sort in place".
- Use them sparingly. If a note is essential, it probably belongs in the description.

The fingerprint includes everything in the contract plus the signatures of the units it uses.
Editing any of it sends the unit, and units that depend on a changed signature, back to pending.

## Writing tests (the oracle)

The tests are the only judge, so their quality limits the whole experiment.

- **Behavior from the original project.** Derive the expected values by running the original code where possible, not by reasoning about what it "should" do.
- **One test file per unit** (or per small group), listed in that unit's `tests`. Each unit's tests may only use that unit and what it depends on, directly or not. Anything else may still be a stub when the tests run, and the harness reports that as a spec problem.
- **Test files must compile.** `validate` compiles every listed test file and reports syntax errors as spec errors, so they never use up model attempts.
- **Deterministic and fast.** No network, no clock or random values without seeding, no dependence on test order. Every candidate runs these tests, and so does every later unit in the same file.
- **Messages that teach.** The trimmed failure output goes back to the model, so plain `assert result == expected` with small inputs gives the clearest error.
- **Synthetic data only.** Never put production or member data in tests, examples, or fixtures.
- **Integration tests per milestone.** Exercise real entry points, for example `subprocess.run([sys.executable, "-m", "pkg", ...])`. List the top-level units in `after`; everything beneath them is included automatically.

When you change a test file later, the harness reacts on the next run:

- **Finished units** are re-checked against their accepted code, and rebuilt only if they now fail.
- **Escalated units** are retried.
- **Milestones** run again.

## Project-level fields

- **`digest`:** one or two sentences about what the project is. It goes into every prompt, so keep it under about 100 tokens.
- **`conventions.md`:** short rules for every unit. Examples: Python version, type hints, which exception types to raise, the helper naming rule (`_` prefix), no printing. Keep it under about 200 tokens.
- **`allow_stdlib` / `allowed_imports`:** the import policy. Allow third-party packages only if the workspace environment has them installed.
- **`source_roots`** (default `[src]`) and **`packages`** (derived): where packages live, and what counts as the project's own imports.

## Common mistakes and how they show up

| Mistake | Symptom | Caught by |
|---|---|---|
| Missing dependency in `uses` | "The tests reached X, which is not implemented yet" | The run escalates at once |
| A class in a signature but not in `uses` | The model guesses field names; `tests` failures | `validate` warning |
| A function from another file without an import | `NameError` in tests | `validate` warning |
| A unit too large for the model | Repeated, varying test failures; cut-off replies | `validate` budget error, or escalations |
| A test that exercises other units | Spec-problem escalation | The run |
| A wrong test (it disagrees with the original) | The unit can never pass | Check tests against the original before running |
| A vague description | Plausible but wrong behavior | Read the prompt (`harness prompt`); add examples |
| A milestone that needs units not in its closure | Milestone escalated: "not implemented yet" | The run |
| Two milestones that require incompatible behavior | The second milestone escalates after its repair fails | The run (repairs must keep passed milestones passing) |
| A circular import, or a broken provided unit | "The scaffolded workspace cannot be imported" | The import check before the first model call |
| A syntax error in a test file | `validate` error | `validate` |
| Ids that differ only by case | Load error | Spec loader |

## A prompt for the large model doing the planning

Give the large model access to the target repository, the [reference](05-reference.md), and
`examples/textstats` as a pattern. Then ask, in stages, with a person reviewing between stages:

```text
You are planning a clean-room rebuild of the repository at <path or URL> by a small language
model with a <N>-token context window. Work in stages and stop after each stage for review.

Stage 1 - Inventory and feature map: languages, dependencies, entry points, external I/O,
and a list of user-visible features (each will become a milestone with an integration test).

Stage 2 - Unit cut: propose units (functions, small classes, data files) with id, target
path::name, one-sentence summary, `uses`, and type (implement / integrate / provided).
Keep each unit to roughly 20-80 lines. Put shared data models first. Keep I/O in thin
integrate units. Show the dependency graph by level.

Stage 3 - Contracts: write spec/contracts/*.yaml following the reference exactly. Signatures
must be valid Python. Descriptions describe behavior and edge cases; the first sentence must
stand alone. Add every project class that appears in a signature to `uses`. Add imports for
every name from another file.

Stage 4 - Oracle tests: for each unit, a small deterministic pytest file that uses only that
unit and its `uses`. Derive expected values by running the original code where possible.
Integration tests per milestone. No network; synthetic data only.

Stage 5 - Run `python -m harness validate -p <project>` and fix every error and warning.
Report the budget table.
```

## Checklist before the first run

- [ ] `validate` shows 0 errors and 0 warnings, or each remaining warning is understood.
- [ ] Every unit fits the budget for the model you plan to use.
- [ ] The original implementation passes the oracle tests, where that is possible.
- [ ] Each test file uses only its unit and that unit's `uses`.
- [ ] Milestones cover the main features.
- [ ] Provided units are few, and you know why each one exists.
- [ ] A person reviewed the unit cut and the dependency graph.
- [ ] No production data, secrets, or credentials anywhere in `spec/` or `tests/`.
