# Plan: rebuilding amazon-mvp with the SLM harness

This is the Phase A record for [github.com/Alles725/amazon](https://github.com/Alles725/amazon)
at commit `44e776b`. It covers what the target is, how it was cut into units, how the tests
were organized, how the bundle was verified, and what is still open. The
[planner guide](../../../docs/04-planner-guide.md) describes the method in general.

## 1. Inventory

| Part | What it is | Size (original) |
|---|---|---|
| `apps/api` | NestJS 10 modular monolith. Modules: auth, users (addresses, payment cards), catalog, cart, orders (checkout), reviews, lists, health. It uses PostgreSQL through Prisma, opaque server-side sessions with Argon2id passwords, a global session guard, and a uniform error filter | about 5,500 lines of source, 5 unit test files, 8 integration suites |
| `apps/storefront` | Next.js 14 App Router with React 18 and Brazilian Portuguese text. It has about 50 routes, a feature-flag gate, Amazon-style header and footer, catalog browsing, product pages with reviews, cart, checkout, orders, account pages, and long content pages | about 18,000 lines of TS/TSX, 4,600 lines of CSS, 340 images, 31 test files |
| `packages/api-contract` | The frontend/backend boundary: types, route constants and small helpers | 642 lines |
| `packages/config-schema` | YAML config with zod validation, environment overrides, and the feature registry | about 250 lines, 1 test file |
| `database` | Prisma schema, 9 migrations, seeds and demo data | about 900 lines |
| `infrastructure`, `config`, `docs`, CI | Kustomize overlays, a kind cluster, the feature flags (`features.yaml`), demo JSON, ADRs | – |

**External input and output:**
- **PostgreSQL:** the API and the seeds.
- **HTTP:** the storefront calls the API through `fetch`, server side and client side.
- **Files:** YAML config and `features.yaml`, read at startup.
- **Browser:** localStorage, for the browsing history.
- **Not used:** no other network calls, no secrets in the repository, and no real payment code. Checkout is simulated.

## 2. Feature map and milestones

Every feature that has a test suite in the original became a milestone. That suite, unchanged,
is the milestone's test. 43 milestones come from original suites, and 2 more check the whole
workspace.

| Feature | Milestones (original suite) |
|---|---|
| Authentication, sessions, account security | `api.unit.auth`, `api.e2e.auth`, `api.e2e.account`, `sf.account`, `sf.login-redirect`, `sf.account-issues` |
| Catalog and search | `api.unit.catalog-search`, `api.e2e.catalog`, `api.e2e.catalog-browse`, `api.e2e.demo-catalog`, `sf.browse`, `sf.browse-page`, `sf.home-catalog` |
| Product page and reviews | `api.unit.review-rules`, `api.e2e.reviews`, `sf.product`, `sf.product-page`, `sf.product-rules`, `sf.product-presentation`, `sf.product-content`, `sf.product-image`, `sf.product-reviews`, `sf.reviews-ui`, `sf.write-review-page`, `sf.related-products`, `sf.prime-payment-notice` |
| Cart and checkout | `api.e2e.cart`, `api.unit.checkout-quote`, `api.e2e.checkout`, `sf.cart-provider`, `sf.checkout`, `sf.pix-price` |
| Orders, help, browsing history | `sf.orders`, `sf.help`, `sf.browsing-history` |
| Header, flags, content pages | `sf.header`, `sf.features`, `sf.corporate-pages`, `sf.customer-pages`, `sf.legal-pages`, `sf.sell` |
| Configuration | `config.config` |
| Whole workspace (as in CI) | `ci.typecheck` (`tsc --noEmit` for every package), `ci.storefront-build` (`next build`) |

The 8 `api.e2e.*` milestones need PostgreSQL (`requires_env: [DATABASE_URL]`). Without it they
wait, and the run reports them as not run.

The Kubernetes manifests, Dockerfiles and the cluster smoke test are copied verbatim and not
rebuilt. Checking them needs a cluster (kind, kustomize), and the original runs no test for them
that works without one.

## 3. The unit cut

`tools/planner/extract.cjs` derives the cut with the TypeScript compiler, so `uses` and `imports`
come from symbol resolution. The rules:

| Original declaration | Becomes |
|---|---|
| A function, or a `const` arrow function | A `function` unit. Its signature is a function head, and the model may write either form |
| A class with behavior (services, controllers, guards, filters, repositories) | A `class` unit. The signature lists decorators, the constructor with injection decorators, and every non-private member |
| A constant computed with logic (API clients built as object literals, `cache(...)`-wrapped loaders, derived lists) | An implemented `declaration` unit with `export const NAME: Type` |
| An interface, a type alias, or a data constant (literals, tables, schemas, tokens, font loaders) | `provided`. Its code is copied, and its text or type is shown to the units that use it |
| A DTO class (validation and Swagger decorators) or a Nest `@Module` | `provided`: these are declarative schema and wiring |
| A private helper used by exactly one declaration | Folded into that unit. The model writes its own helpers, and the description covers their behavior |
| A file with top-level statements (`main.ts`, `openapi.ts`, seed scripts) | A `file` unit that owns the whole file |
| Index files with only re-exports, CSS, images, JSON, configs, Prisma schema and migrations, infrastructure, docs | Scaffold, copied verbatim |

**Result:** 888 units in all.

- **378 written by the model:**
  - 229 functions, 24 classes and 14 constants (`implement`).
  - 90 functions, 12 classes, 4 constants and 5 files (`integrate`).
  - By area: 301 storefront, 55 API, 15 packages, 7 database.
- **510 provided:** 235 constants and data, 199 types and interfaces, 76 DTO and module classes.

**What every unit sees in its prompt, beyond the original's direct references:**

- **Type context:** every provided type, and every class, that appears in a signature the unit
  will see, followed transitively (1,006 additions to `uses`). Each one is imported in the file
  header with `import type`, which has no effect at run time.
- **Inferred return types:** where the original left a return type to inference, the signature
  shows what the compiler infers. This was done for 83 signatures; types from packages that are
  not installed are left out.
- **Merged declarations:** a constant and a type with the same name, such as `ErrorCode`, form
  one unit, and the signature shows both.
- **The same file header:** every unit of a file gets the file's original import list in the
  original order, so CSS and polyfill imports keep their place.

**What every unit waits for, beyond what it uses:**

- **Load-time dependencies (234 `after` edges).** When a file loads, it may run implemented code.
  For example, `const shortDate = dateFormat({...})` calls `dateFormat` while the file loads, and
  so does every file that imports it for a value. Every unit of such a file waits for that code.
  Otherwise its tests would hit a stub that is not its fault.
- **Ordering edges for tests (27 `after` edges).** A test that also needs another unit (a
  sibling in the same file, or a helper its own setup calls) runs on the unit with the largest
  closure, which then waits for the rest. At most 8 such units are added, and never in a cycle.

**Shape of the graph:**
- **Depth:** 10 levels.
- **First prompts:** half are under about 1,200 tokens, and 90% under about 3,000.
- **Largest worst-case retry:** about 24,600 tokens of prompt plus answer, for `CheckoutContent`.
- **Window needed:** 2 units need more than 16k and 26 need more than 8k, so the bundle targets a 32k context window. Smaller windows need those units split first (section 8).

## 4. Tests

| Kind | Files | What they are |
|---|---|---|
| Original suites | 43 | Copied unchanged, one milestone each |
| Per-unit tests split from the originals | 96 | The cases of an original file whose reached units lie in one unit's closure (see below) |
| New per-unit tests | 49 | Written for pure units with no other test. Each one passed against the original before it was registered |
| Whole-workspace checks | 2 | `tools/checks/*.check.json`, run by `tools/harness-test.mjs` |

**How a case is assigned to a unit.** The extractor works out which units each case reaches:

- Imports, and local helpers, followed transitively.
- Setup code that runs for every case.
- Dynamic `import()` calls.
- Source files the test reads as text.

Mocked modules don't count. A case goes to a unit when that unit's closure covers everything
the case reaches. Cases in one `describe` that share `let` state stay together.

A case stays milestone-only when it reaches units through a pattern import, as in
`` import(`../app/${dir}/page`) ``. It also stays milestone-only when no single unit covers what
it reaches.

**Coverage.** 139 of the 378 model-written units have their own tests. Every model-written
unit is under `ci.typecheck`, and 313 are under `ci.storefront-build`. The 8 integration suites
are the oracle for the API services and controllers.

**The test entry point.** `tools/harness-test.mjs` takes the test files it is given and:

- Runs vitest for the storefront and config-schema, and jest for the API, with a separate integration config for `apps/api/test`.
- Rebuilds the shared packages' `dist/` when their sources changed.
- Runs `prisma migrate deploy` before the integration suites.
- Runs the two whole-workspace checks.

## 5. Descriptions

The descriptions were written by nine planner agents, one per area, following
[contract-style.md](contract-style.md). They live in `tools/planner/descriptions/*.yaml`.

- **Exact text:** every description states exactly what tests and callers depend on: Portuguese text, class names, roles, aria labels, routes, status codes, error codes, and Prisma models and queries.
- **Examples:** every example was checked against the original.
- **Prisma schema:** the model never sees it, so service descriptions name the models, fields, unique keys and raw-SQL columns they use.

## 6. Verification

`tools/verify_bundle.py` and `tools/oracle/run-pure.cjs` were run on the machine that produced the bundle:

| Check | Result |
|---|---|
| `harness validate` | 0 errors, 0 warnings |
| Offline replay (mock backend answers with the original code; static ladder only) | 378/378 units pass, 0 sanitize repairs |
| Equivalence of the replayed workspace with the original | 0 differences. The same file set. Each source file has the same declarations, import bindings, directives and side-effect import order. Copied files are byte-equal |
| Pure tests on the original repository | All pass |
| Pure tests on the replayed workspace (originals, splits, new) | 79 files ran, 0 failed. 101 need React, Nest, zod or a DOM and were skipped |
| Harness test suite | 103 tests pass, 17 of them for the TypeScript adapter |

**Not verified yet:** the full replay with installed packages (`harness.replay.yaml`). It runs
vitest, jest, `tsc`, `next build` and the integration suites against the original code inside
the harness, and it must pass before the first model run. It needs a registry that serves the
pinned packages, and PostgreSQL.

## 7. Known gaps and risks

| Gap | Effect | Mitigation |
|---|---|---|
| Some tests match source text with regular expressions, for example `<Link href="/privacy">Notificação de privacidade` in the login and register pages | A correct component written differently (wrapped text, attribute order) fails | The descriptions give the exact JSX. The cases are assigned only once the files they read are in the closure |
| Decorative SVG path data (icons, a quote mark, logos) is not reproducible from text | The look differs; no test checks it | The described size and shape is enough for the tests. Long icon sets (`ICONS`, glyphs, illustrations) are provided |
| Services are checked only by the integration suites | Weaker blame and more repairs per failure | `max_milestone_repairs: 6`. Per-service database tests are in the harness backlog |
| Units with no test of their own: 239 of the 378. Many are components whose behavior shows in a parent's suite | Errors surface at milestones | Descriptions spell out what those suites check |
| Large units: `CheckoutContent` (565 lines), `BrowseResults`, `CatalogService`, `CartContent`, `AddressesManager` | Hard for small models; needs a 32k window | Split candidates for a second iteration: extract sub-components and hooks, with their own contracts |
| Signatures for wrapped or untyped values (`ReturnType<typeof createParamDecorator>`, React `cache`) | The model relies on the description for how to build them | Each description says how |
| The integration suites order by product name | Results depend on the database collation | Use the original's `postgres:16-alpine` defaults |
| `features.spec.ts` scans every storefront source file for `features.yaml` and `process.env.FEATURE_` | A comment with that text fails the suite | The rule is in `conventions.md` |
| Tests use `getByText`, which needs exact text nodes | Splitting text across elements fails | Descriptions state the element structure where it matters |

## 8. Next iterations

1. Run the full replay with real runners and PostgreSQL, and fix any bundle bug it finds.
2. Run the smallest viable model with a 32k window, and use `report` and the escalations to find weak contracts.
3. Split the five largest units, and rerun with a 16k-window model.
4. Add per-service database tests (harness backlog item 17).
