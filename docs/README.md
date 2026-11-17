# Documentation

This folder documents the **SLM harness** research project. The project tests whether a small
language model (SLM) can rebuild an existing software project from zero when a large model
decomposes the work first and a deterministic harness manages the rest.

| Document | Read it to |
|---|---|
| [01 – Concept](01-concept.md) | Understand the research question, why small models need this structure, and the design principles |
| [02 – Architecture](02-architecture.md) | Learn how the harness works inside: modules, data flow, state machines, the verification ladder |
| [03 – User guide](03-user-guide.md) | Install it, run the demo, connect a real model, and work through a day-to-day run |
| [04 – Planner guide](04-planner-guide.md) | Write a spec bundle (contracts, tests, milestones) for a new target repository |
| [05 – Reference](05-reference.md) | Look up every config field, contract field, command, file format, and log event |
| [06 – Research guide](06-research.md) | Design experiments, compare models, run ablations, and read the metrics |
| [07 – Review and roadmap](07-review-and-roadmap.md) | See what the code review found and fixed, known limits, and the improvement backlog |

## Suggested reading order

- **New to the project:** 01 → 03 (quick start) → 02.
- **Preparing a new target repository:** 04, with 05 open beside it.
- **Running experiments:** 03 → 06.
- **Changing the harness code:** 02 → 07, then the tests in `tests/`.

## The project in one paragraph

A **planner** (a large model or a person) reads the target repository once. It writes a
**spec bundle**: one contract per unit (a function, a class, or a file), tests that act as the
judge, and milestones (integration tests). The **orchestrator** in `harness/` is plain Python
with no model inside. It orders the units by dependency and gives the SLM one small prompt per
unit. It checks every answer with a ladder of checks that ends in the unit's tests, then pastes
code that passes into the workspace and records everything in state files. The SLM never writes
files, never sees the original source, and never sees another unit's implementation.
