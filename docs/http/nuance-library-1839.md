# Nuance library — #1839

Prepared on consolidated ERP 2.0.84 sources (`dc11aaa1` backend / `c029b872` frontend). This document records local implementation, not deployment or production approval. Project Office local record: `STOCK-NUANCE-LIBRARY-20261113`; authenticated API reconciliation remains pending.

## API and ownership

Existing authenticated endpoints remain `GET/POST /api/v1/stock/matiere-nuances` and `PATCH /api/v1/stock/matiere-nuances/:id`. Existing module/company access, audit logging and transaction ownership remain unchanged. No new realtime event or cache prefix is introduced.

Each row adds nullable `norme_fr`, `norme_en`, `norme_werkstoff`, `norme_usa` (trimmed, maximum 40 characters), `designation_principale` (`FR`, `EN`, `WERKSTOFF`, `USA`, or historical `LEGACY`) and derived `libelle`. `designation` remains the optional description; `densite` remains kg/m³ on the API and converted at the legacy persistence boundary.

```json
{
  "norme_en": "EN-DEMO",
  "norme_werkstoff": "1.4404",
  "norme_usa": "USA-DEMO",
  "designation_principale": "WERKSTOFF",
  "densite": 8000,
  "etat_ids": [],
  "is_active": true
}
```

POST requires at least one nonempty standard. The title must reference a populated field; when omitted, the first supplied standard is selected. `code` is optional on POST and generated with the existing workshop-code normalizer from the selected designation. PATCH validates the merged identity while holding the row lock. Omitting a field preserves it; `null` clears an optional designation only if the resulting identity is valid. An unchanged historical `code` is never renormalized. A classified row's code cannot be renamed; changing its display title preserves article identifiers and historical documents.

Legacy rows with no classified standards may receive metadata-only edits. The first standard edit classifies the existing row in place; it must leave at least one populated standard. `LEGACY` is not accepted for new rows. Code-only new creation from old clients is deliberately rejected with 400 rather than guessing a standard. Old clients must update before creating new nuances.

GET searches all four designations as well as workshop code/description. Responses retain `items/total`; POST returns 201 and PATCH returns 200 or 404. Validation errors use 400; uniqueness conflicts use 409 (`DUPLICATE_NUANCE` on creation, existing `DUPLICATE_REFERENTIAL_CODE` on update). The OpenAPI enrichment documents these same endpoints without changing route registration.

## Migration and integrity

Patch: `db/patches/20261113_stock_nuance_library.sql`. It depends on the existing `stock_nuances` table from `20260331_stock_matiere_premiere_referentials.sql`; filename ordering places it after the current 2.0.84 patches. Existing deployed patches are unchanged.

The migration adds four nullable fields and defaults existing rows to `LEGACY`. It never invents equivalences, deletes/merges nuances, rewrites workshop codes, changes density, or updates article/state foreign keys. Normalized uniqueness indexes apply per standard and to workshop codes, including inactive rows. A serialized cross-check prevents a new standard alias duplicating an unclassified historical code. Identical spelling across distinct standards is not itself evidence of equivalence.

Before production, obtain separate authorization, freeze the source pair and take/verify the normal database backup. Run `support/20261113_stock_nuance_library.preflight.sql` read-only and retain its counts. Any existing normalized collision must be reviewed; the migration aborts atomically and retains every original ID. Do not silently merge traceable rows.

Apply first to a restored isolated test database, then deploy the API and frontend together after validation. Execute `support/20261113_stock_nuance_library.verify.sql`: compare nuance/article-link counts, check the five indexes, and require zero orphan links. Validate actual runtime read/create/edit, tenant context and audit. No production backup, preflight, migration or deployment was performed in this task.

The compatibility adapter `src/compat/material-referentials-backport.ts` is not mounted in this native source. It is an EC composite-runtime compatibility boundary rather than an alternative native implementation: do not mount it ahead of these native routes in this source assembly. The captured EC `dist/routes/v1.routes.js` does require it, adds the access-profile augmentation at `/auth`, and mounts its router at `/stock` before the module-access gate; the acceptance harness also parses it. It remains retained by the lifecycle guard under the audited deployment documentation and user instruction until reviewed target-runtime evidence resolves that boundary. Native route availability alone is not retirement evidence.

## Rollback

Prefer reverting the UI/API pair while retaining the additive schema and all equivalence data. The older UI can read existing codes; old code-only creation will remain blocked by the guard. `support/20261113_stock_nuance_library.rollback.sql` intentionally performs read-only inventory and does not drop columns/indexes. If full older creation behavior is required, ship a reviewed compatibility fix; do not remove integrity checks or user-entered correspondences ad hoc. A full database restore requires separate approval and the tested backup procedure.

## Evidence and limits

`node scripts/tests/nuance-library-postgres.mjs` starts a disposable PostgreSQL 17.10 container with no network and synthetic tables, ignores all database environment URLs, replays the migration, checks historical IDs/links/density, inactive and normalized duplicates, primary-title constraints and concurrent inserts, then stops only its own container. This validates real PostgreSQL behavior; it does not claim a full production-schema rehearsal.

Vitest covers domain validation, routes/transactions/audit, Stock regressions and the OpenAPI contract. Frontend checks cover the actual Stock module and ten fixture-browser cases (desktop/mobile, light/dark, keyboard, duplicate and read-only paths), with screenshots. Data in browser fixtures is demonstration-only. No personal-data field, permission broadening, dependency or production setting is introduced.
