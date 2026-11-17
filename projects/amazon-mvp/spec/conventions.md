- TypeScript in strict mode. Keep exported names, parameters, decorators and `export` keywords exactly as shown.
- Money is integer minor units (centavos). No floating-point money math; format with
  `Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })` unless told otherwise.
- User-facing text is Brazilian Portuguese and must match the description exactly (tests compare it).
- API: throw `ApiError` with an `ErrorCode` for expected failures. A module reaches another module only
  through its injected `*_API` token, never through another module's Prisma tables.
- Storefront: React function components. CSS already exists: use exactly the class names, roles and
  aria labels the description gives. `'use client'` and imports come from the file header.
- Outside `apps/storefront/src/config`, never write the text `features.yaml` or `process.env.FEATURE_`, not even
  in a comment: a test scans the sources for it.
- No console output, example usage, or tests.
