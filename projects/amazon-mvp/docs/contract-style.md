# Writing descriptions for this bundle

Everything in a contract except `description`, `examples` and `notes` is generated from the
original repository by `tools/planner/`. Those three fields are written by a person or a planner
model, and they live in `tools/planner/descriptions/*.yaml`, not in `spec/contracts/`.
`build_bundle.py` merges them into the contracts.

```yaml
# tools/planner/descriptions/<group>.yaml
sf.features.product.product-rules.variantDimensions:
  description: |
    Build the variation matrix for a product page: one entry per option name of `current` ...
  examples:
    - 'variantDimensions(mint, [mint, peach])[0].choices.map((c) => c.value) == ["Hortelã", "Pêssego"]'
  notes: |
    Values keep the order in which they first appear in `members`.
```

## Who reads it

A small model with no access to the original code, and very little room in its context. For
each unit it sees only the following:

- The digest and `spec/conventions.md`.
- The file's merged imports.
- The signatures and one-sentence summaries of the units in `uses`.
- The unit's signature.
- The description, examples and notes.

When the tests fail, it also sees the trimmed failure output. It never sees the test code, CSS,
other units' code, or the original.

So the description is the whole specification. If the tests check it, the description must
say it.

## Rules

1. **The first sentence stands alone.** It is shown to every unit that uses this one. Keep it
   under about 160 characters, and say *what the unit does*, not how.
2. **Describe behavior, not implementation:** inputs, outputs, side effects, and the order of
   effects when it is observable. Do not paste the original code. A short formula, a regular
   expression, or a single expression is fine when the tests depend on it exactly.
3. **State every edge case the tests or callers rely on.**
   - Empty input, missing optional values, ties, and rounding (money is integer minor units).
   - Limits, and what happens just past them.
   - Errors: which exception class, which `ErrorCode`, which HTTP status.
4. **Exact strings are part of the contract.** Give user-facing Portuguese text, error messages,
   cookie names, routes, query parameters and storage keys verbatim, in backticks.
5. **Markup that tests or CSS depend on is part of the contract.** For a component, list:
   - The elements it renders, in order.
   - Class names: the CSS exists already and is never shown to the model.
   - `role`, `aria-*`, `href`, `alt`, `data-*`, and the text of every button and link.
   - What is conditional, and on what.
   - State and effects, and what each event handler does.
   - Which hooks or context it uses (`useCart()`, `useRouter()`, ...).
6. **Name the dependencies to call.** The model sees their signatures, but it needs to be told
   when to use which one. For example: "load the cart with `cartClient.get()`; on a 401 ...".
7. **Services:**
   - Which Prisma models and fields they read and write.
   - What runs in one `$transaction`, and which rows are locked.
   - How conflicts are detected.
   - What is returned, mapped through which helper.
8. **Controllers:** the decorators (routes, status codes) are in the signature. Describe what
   each handler does with its input and what it returns.
9. **Keep it proportional.** A three-line helper needs one or two sentences. A large
   component may need 30 to 60 lines. Stay under about 800 words: the description is part of
   every prompt and retry for the unit.
10. **Folded helpers.** Some units contained private helpers in the original. The contract does
    not list them, and the model may write its own. Describe the behavior they gave the unit.
11. **Examples** are for pure functions. Use one to three `call == result` lines that settle
    ambiguity. Every example must be true of the original: check it with
    `tools/oracle/run-pure.cjs` or a test.
12. **Notes** are optional hints, such as "use `Intl.DateTimeFormat('pt-BR', ...)`" or "do not
    mutate the input". If a note is essential, it belongs in the description.
13. **No production data, secrets or credentials.** The original contains none. Keep it that way.

## New tests

Write a test only for a pure unit that has no `tests` in its contract, and that
`tools/oracle/run-pure.cjs` can run: no React, Next.js, Nest, zod, yaml, Prisma or module mocks.

**Where the file goes**

Put it under `tools/planner/new-tests/`, at the path it will have in the workspace:

| Code under test | Test path |
|---|---|
| Storefront | `apps/storefront/test/<module>.<unit>.new.spec.ts` |
| config-schema | `packages/config-schema/src/<module>.<unit>.new.spec.ts` |
| API | `apps/api/src/.../<module>.<unit>.new.spec.ts` |

Register it in `tools/planner/new-tests/_map.<group>.json` as `{"<unit id>": ["<workspace path>"]}`.

**What the test may use**

- Only the unit and what it depends on, directly or not. Anything else may still be a stub when
  the test runs.
- Storefront and config-schema tests import from `vitest`. API tests use the jest globals and
  import nothing for them.
- Only `describe`, `it`/`test`, `beforeEach`/`afterEach`, `expect` with common matchers, and
  `vi.fn`. No `vi.mock` and no DOM.
- Synthetic data only. Expected values come from running the original, not from reasoning.

**Check it against the original before you register it.** It must print PASS:

```bash
HARNESS_TYPESCRIPT=<path to typescript> node tools/oracle/run-pure.cjs \
  --root <original repository> --mount tools/planner/new-tests \
  tools/planner/new-tests/apps/storefront/test/<file>.new.spec.ts
```
