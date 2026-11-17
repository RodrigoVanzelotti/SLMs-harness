# amazon-mvp: spec bundle for the SLM harness

This folder holds everything the [SLM harness](../../README.md) needs to rebuild
[github.com/Alles725/amazon](https://github.com/Alles725/amazon) (commit `44e776b`) from zero,
one unit at a time, with a small language model. The target is a pnpm TypeScript monorepo:

- A NestJS API with PostgreSQL through Prisma.
- A Next.js 14 storefront with Brazilian Portuguese text.
- Shared packages, and Kubernetes manifests.

The folder is independent of the harness: the harness reads it and never changes it, and
nothing here is part of the harness.

**Status (2026-11-16):** the bundle is complete and verified offline (see
[Verification](#verification)). It has not yet run with the project's real test runners,
because their npm packages were not installed on the machine that produced it, and it has not
yet run with a real model. [docs/plan.md](docs/plan.md) explains every decision behind it.

## What is in it

```
spec/project.yaml        language, digest, import policy, 44 milestones
spec/conventions.md      rules in every prompt
spec/contracts/**        888 units: 378 written by the model, 510 provided (one YAML per source file)
spec/scaffold/**         every original file that is not a unit or a test, copied verbatim
                         (configs, CSS, images, Prisma schema and migrations, Kubernetes, docs),
                         plus tools/harness-test.mjs, the test entry point
tests/**                 the original test suites (milestones), the per-unit tests split from
                         them, new tests for code they did not cover, and two
                         whole-workspace checks (tools/checks/*.check.json)
harness.yaml             run config for a real model (OpenAI-compatible server)
harness.replay.yaml      self-check: the mock backend replays the original code
docs/plan.md             inventory, feature map, unit cut, coverage, deviations, known gaps
docs/contract-style.md   how descriptions and new tests are written
tools/planner/           extract.cjs + build_bundle.py (they generate spec/ and tests/),
                         descriptions/*.yaml and new-tests/ (the planner's written work)
tools/oracle/run-pure.cjs  runs pure-logic tests with no npm packages installed
tools/verify_bundle.py   offline checks: replay, equivalence with the original, missing descriptions
```

## Requirements

| For | You need |
|---|---|
| The harness | Python 3.11+, PyYAML, and the harness itself (`pip install -e ../..`, or run from the repository root) |
| Parsing TypeScript | Node.js 20.11+ and the `typescript` package. Run `npm install` in this folder, or set `HARNESS_TYPESCRIPT` to an installed copy |
| Running the project's tests | pnpm 9, plus access to an npm registry that serves the versions in `spec/scaffold/pnpm-lock.yaml`. The preflight runs `pnpm install --frozen-lockfile` in the workspace |
| The 8 API integration milestones | A disposable local PostgreSQL 16, and `DATABASE_URL` set in your shell |
| A real run | An OpenAI-compatible model server (Ollama, llama.cpp, vLLM, LM Studio) with a 32k context window |

A local database with no password keeps credentials out of every file and shell history:

```bash
docker run -d --name amazon-mvp-pg -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=amazon_mvp -e POSTGRES_DB=amazon_mvp \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
export DATABASE_URL="postgresql://amazon_mvp@localhost:5432/amazon_mvp?schema=public"
```

Only use a throwaway container: model-written code can see `DATABASE_URL`.

## Steps

All commands run from the repository root (`test-on-SLMs/`).

**1. Check the bundle offline** (no npm packages needed). Do this after every change to the
bundle:

```bash
python -m harness validate -p projects/amazon-mvp
python projects/amazon-mvp/tools/verify_bundle.py todo
```

**2. Replay the original code with the real test runners.** This is the planner checklist's
"the original passes the oracle tests", run inside the harness. Every unit and every
milestone should pass. A failure means a bundle bug or a flaky test, not a model problem.

```bash
git clone https://github.com/Alles725/amazon ../amazon-original && git -C ../amazon-original checkout 44e776b
node projects/amazon-mvp/tools/planner/extract.cjs ../amazon-original runs-extract.json
python projects/amazon-mvp/tools/verify_bundle.py replay --original ../amazon-original --extract runs-extract.json
python -m harness run -p projects/amazon-mvp -c harness.replay.yaml      # needs DATABASE_URL for the API milestones
```

The `verify_bundle.py replay` step writes `runs/replay-responses.yaml` (the original code as
mock replies) and does the offline static replay first.

**3. Run a model.** Start the model server, set `model.model` and `base_url` in
`harness.yaml`, then:

```bash
python -m harness validate -p projects/amazon-mvp
python -m harness run      -p projects/amazon-mvp
python -m harness status   -p projects/amazon-mvp
python -m harness report   -p projects/amazon-mvp
```

The first `run` installs the workspace's dependencies (preflight), which takes a few minutes.
To compare models, copy `harness.yaml`, change `run_name` and the model, and run with `-c`.
Each run gets its own `runs/<run_name>/`. See the [user guide](../../docs/03-user-guide.md) and
the [research guide](../../docs/06-research.md).

## Regenerating the bundle

`spec/` and `tests/` are generated. Do not edit them by hand. The written parts live in
`tools/planner/descriptions/*.yaml` (description, examples and notes per unit) and in
`tools/planner/new-tests/` (new tests, with `_map.<group>.json` saying which unit each one
belongs to).

```bash
node   projects/amazon-mvp/tools/planner/extract.cjs <original> extract.json
python projects/amazon-mvp/tools/planner/build_bundle.py <original> extract.json
```

Rebuilding never loses written descriptions, and it refuses descriptions or test maps that name
units that no longer exist. After rebuilding, repeat step 1. If code changed, repeat step 2 too.

## Verification

Done on the machine that produced the bundle (Windows 11, Node.js 24, TypeScript 5.7 for
parsing). There was no npm install, so vitest, jest, Next.js, Nest and Prisma were not
available.

| Check | Result |
|---|---|
| `harness validate` | 0 errors, 0 warnings. Every unit fits a 32k context window (largest worst-case retry prompt plus answer: about 24.6k tokens, `CheckoutContent`) |
| Offline replay: the original code of all 378 units through the static ladder | 378/378 pass, 0 sanitize repairs |
| Equivalence of the replayed workspace with the original repository | 0 differences in 248 assembled source files and 502 copied files. Checked: declarations, import bindings, the position of side-effect imports, and directives |
| Pure tests (no React, Nest, zod, DOM or module mocks) with `run-pure` | All pass on the original repository. On the replayed workspace, 79 files (original suites, per-unit splits, and all 49 new tests) pass. The 101 that need the real runners are reported as skipped, not passed |

What remains unverified until step 2 runs on a machine with the packages:

- The React, Nest and Prisma tests.
- The type-check and build milestones.
- The 8 database suites.

## Deviations from the original

- **Not copied:** `docs/reference/`, about 40 MB of reference screenshots of third-party pages, used by no code or test.
- **Added:** `tools/harness-test.mjs` (test entry point) and `tools/checks/*.check.json` (the type-check and storefront-build milestones). The workspace also has the harness's `.harness-files.json`.
- **Source files are assembled from regions.** Each unit is one region between `// >>>` and `// <<<` markers, and the imports sit in one merged header. This changes layout, not meaning: the equivalence check compares meaning.
- **Extra `import type` lines** give the model the types it sees in its dependencies' signatures. They are type-only, so they change nothing at run time.
- **Inferred return types:** where the original relied on inference, some signatures show the return type the compiler inferred.

## Safety notes

- **Not a sandbox.** Code the model writes runs as your user, through the project's test runners. It can read your files and use the network. For untrusted models, run inside a container or VM.
- **No secrets.** Checks inherit only the variables in `harness.yaml` (`inherit_env`). The only credential-like value is `DATABASE_URL`, and with trust authentication it holds no password.
- **No production data.** The original's demo catalog, reviews and orders are synthetic, and the bundle adds no other data.
