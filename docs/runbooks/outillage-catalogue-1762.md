# Outillage catalogue private delivery #1762

This runbook delivers the private supplier catalogue, its authenticated image
excerpts, catalogue provenance, and the distinction between an uncounted item
and a physically counted zero quantity. It does not import supplier prices or
physical quantities.

## Release contents and access model

The API exposes the catalogue only through these authenticated routes:

- `GET /api/v1/outils/catalogue`
- `GET /api/v1/outils/catalogue/assets/:filename`

Both require the existing Outillage `read` capability. The bundle reports the
current user's `permissions.canConfigure`; it does not grant a write right.
Tool creation, updates, deletion, and taxonomy/reference writes require
`configure`. The stock mutation routes `/sortie`, `/retour`,
`/reapprovisionner`, `/scan/sortie`, `/scan/entree`, and `/inventaire/set`
require `operate`.

The release corpus is `selection-jmt.json` plus its `assets/` directory. Set
`CERP_TOOL_CATALOGUE_ROOT` to the private release directory when the corpus is
mounted separately. Without that variable, the runtime uses
`resources/outillage-catalogue` below its working directory; the Docker image
contains that directory at `/app/resources/outillage-catalogue`.

Keep the corpus private and read-only to the API runtime. Do not copy it to a
frontend `public` directory, a static-file directory, or a CDN. The service
allows only manifest-referenced JPG, PNG, and WebP basenames, checks resolved
paths and symlinks, and replies with private no-store headers.

## Required deployment order

1. Use the exact reviewed backend release. Keep a database backup and save the
   output of each support SQL check for the target database.
2. Run `db/patches/support/20261025_outillage_catalogue_provenance.preflight.sql`
   with the approved database operator. It stops when base tables are absent or
   legacy non-empty manufacturer/reference duplicates differ only by case or
   surrounding whitespace. Resolve those duplicates deliberately; do not
   delete or merge them automatically.
3. Apply `db/patches/20261025_outillage_catalogue_provenance.sql` using the
   release-pinned patch process. For example, the release image supports:

   ```text
   node scripts/db-patches.js status --check --only 20261025_outillage_catalogue_provenance.sql
   node scripts/db-patches.js up --only 20261025_outillage_catalogue_provenance.sql
   ```

   The operator supplies the approved database connection by the normal secure
   deployment mechanism; do not record it in a shell history or this document.
4. Run `db/patches/support/20261025_outillage_catalogue_provenance.verify.sql`.
   A successful schema verification is mandatory before exposing the new API:
   catalogue-origin creates and reads depend on the provenance table and
   `gestion_outils_stock.last_inventory_at`.
5. Deploy the backend with the private corpus available, then deploy the
   compatible frontend. Do not deploy the API before step 4. If the corpus is
   unavailable, the catalogue endpoint must remain unavailable rather than
   falling back to public files.

## Functional acceptance

Use accounts already approved for the environment and verify the following:

- An authenticated reader can retrieve the catalogue and an allowlisted image
  excerpt, while an unauthenticated request and a traversal or unknown asset
  request are refused.
- A reader cannot create a tool or mutate stock. A configured user can create
  a manual tool; an operator can perform the allowed stock operations.
- A catalogue-origin creation sends only `catalogue_source.selection_id` and
  `reference_confirmed: true`. The server resolves the source document,
  SHA-256, page, and rectangle from its private manifest. The initial stock is
  zero; a user-defined minimum threshold remains allowed.
- Before a physical count, the new tool is marked `inventory_required` and is
  excluded from stock shortage and minimum-stock totals. An inventory action,
  including a confirmed `0 -> 0` count, records `last_inventory_at`, clears
  that state, and leaves a verified physical zero distinct from an unknown
  quantity. A positive quantity received or returned before that count remains
  unavailable for tablet withdrawal; the server refuses both manual and scan
  debits with `409 INVENTORY_REQUIRED` until the count is confirmed.

## Recovery and rollback

Rollback is intentionally safe only before any catalogue provenance has been
captured. Run
`db/patches/support/20261025_outillage_catalogue_provenance.rollback.sql` only
after confirming the provenance table is empty. The script refuses to remove
the table when it contains operational evidence.

If rollback is refused, stop the rollback and keep the schema and evidence.
Investigate or roll forward with a new reviewed migration; never force-drop
the provenance table or its inventory timestamp. The rollback removes the
catalogue provenance table, `last_inventory_at`, and the manufacturer/reference
unique index only when the guard permits it. It does not alter legacy tools.

## Local evidence and limits

The targeted backend command passed 76 tests:

```text
node node_modules/vitest/vitest.mjs run --config vitest.config.ts src/module/outils/routes/outil-catalogue.routes.test.ts src/module/outils/services/outil-catalogue.service.test.ts src/module/outils/validators/outil-catalogue-provenance.validator.test.ts src/__tests__/outillage-upload-ownership.test.ts
```

The reproducible SQL proof is outside this repository at
`../sql-validation/validate.mjs`; its recorded result is
`../sql-validation/evidence.json`. It runs the actual patch, preflight,
verification, and rollback SQL against ephemeral PostgreSQL WASM (PGlite).
It covers patch idempotence, duplicate rejection, provenance constraints,
pending versus inventoried zero, exclusion of a positive pending balance until
physical count, protected populated rollback, empty rollback, and legacy
duplicate abort without deletion.

No native PostgreSQL server or parallel-session concurrency test was run for
this delivery. No production migration, deployment, or production data action
is authorized by this runbook.

## Test-only supplier and price extension (2026-10-25)

The subsequent user confirmation permits the ten catalogue brands as initial
direct-purchase suppliers in `cerp_test`; distributors will be linked per tool
later. Canonical `fournisseurs` UUIDs own supplier identity. Legacy integer
Outillage supplier IDs remain distinct and must never receive a coerced UUID.
Tool and manufacturer master links are additive to the legacy relationships.

The two files under `db/test-only-patches/20261025_outillage_*` are excluded
from standard production migrations and each checks `current_database()`.
Back up and verify `cerp_test` before applying them. Do not apply these patches
or import data into production or the managed test template. Reads remain
compatible when optional master-link tables are absent; new receipt writes
fail with an explicit schema-unavailable response before stock changes.

The private maintenance tools `import-direct-suppliers-test.js` and
`import-indicative-prices-test.js` default to dry-run. The first accepts a
reviewed explicit brand mapping and uses canonical supplier/catalogue services.
The second requires the absolute evidence dataset path and SHA-256; apply also
requires `CERP_TOOL_INDICATIVE_PRICE_TEST_IMPORT=true`. Both verify the database
name independently and use the existing inactive, non-superadmin import actor.
Replays reuse stable supplier keys and immutable price-evidence keys.

The 1,674 printed JANIN/MAGAFOR prices retain EUR/piece, source document/hash,
PDF page, rectangle and its bottom-left coordinate convention. Unknown tariff
dates and tax treatment remain unknown. They live in the indicative-evidence
table, separately from canonical current offers and actual purchases. Linking
a manually entered supplier catalogue item records `source_kind=MANUAL` and a
required note, without fabricated PDF evidence.

`POST /outils/reapprovisionner` now requires the canonical supplier UUID,
confirmed quantity, HT price, currency, unit, receipt date, receipt reference
and idempotency key. A transaction-scoped actor/key lock serializes replay;
stock, movement, actual purchase evidence and audit share the transaction. A
tool still pending its first inventory is refused. Supplier-order drafts do
not call this endpoint or change stock. Actual price history and the variation
report compare only identical tool/supplier/currency/unit groups, with an
earlier purchase available as the period baseline and no percentage for a
zero preceding price.

Additional local PostgreSQL 18 evidence uses an isolated `cerp_test` cluster,
not the shared database. It covers UUID foreign keys, source constraints,
duplicate receipt references, the pre-period price baseline, refusal before
inventory and stock rollback when actual-price insertion fails. Module tests
and receipt-service orchestration tests complement these SQL checks.
