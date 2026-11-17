# SLM harness

A research project that tests whether a **small language model** (SLM) can rebuild an existing
software project from zero. A large model decomposes the work first, and a deterministic
harness manages the rest.

| Layer | Who | Does |
|---|---|---|
| Planner | A large model or a person, once | Reads the target repository and writes a **spec bundle**: contracts, tests, milestones |
| Orchestrator | **`harness/`** (plain Python, no model inside) | Orders units by dependency, builds one small prompt per unit, checks every answer, records state |
| Workers | The SLM | Writes one function, class, or file per prompt. Sees one black box at a time |

The SLM never writes files, never sees the original source, and never sees another unit's
implementation. Tests written by the planner decide whether an answer is accepted.

## Quick start

Requirements: Python 3.11+, PyYAML, pytest. TypeScript targets also need Node.js and the
`typescript` package.

```bash
# Demo with scripted model replies; no model server needed; takes a few seconds
python -m harness run    -p examples/textstats -c harness.mock.yaml
python -m harness status -p examples/textstats -c harness.mock.yaml
python -m harness report -p examples/textstats -c harness.mock.yaml

# With a real model: set model.model in examples/textstats/harness.yaml, then
python -m harness validate -p examples/textstats
python -m harness run      -p examples/textstats

# Start a new replication target
python -m harness init projects/my-target
```

## Documentation

Everything else is in [`docs/`](docs/README.md):

- [Concept](docs/01-concept.md): the research question and the design principles
- [Architecture](docs/02-architecture.md): modules, data flow, state machines, the verification ladder
- [User guide](docs/03-user-guide.md): installing, connecting a model, the day-to-day loop, troubleshooting
- [Planner guide](docs/04-planner-guide.md): writing contracts, tests, and milestones for a target repository
- [Reference](docs/05-reference.md): every config field, contract field, command, and file format
- [Research guide](docs/06-research.md): metrics, experiment design, ablations, threats to validity
- [Review and roadmap](docs/07-review-and-roadmap.md): review findings, known limits, backlog

## Repository layout

```
harness/            the orchestrator (Python package; `python -m harness`)
examples/textstats/ a complete example project: spec, tests, mock replies, run configs
projects/           spec bundles for real targets, independent of the harness
  amazon-mvp/       github.com/Alles725/amazon (TypeScript: NestJS, Next.js, Prisma)
tests/              the harness's own test suite (`python -m pytest`)
docs/               documentation
```
