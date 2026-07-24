# Database Patches

CERP stores SQL patch files in `db/patches/`. The local-first production
database is PostgreSQL on HYPERBOX2, database `cerp_prod`.

Do not make schema changes directly on the VPS. The VPS must not become a
second writable database.

## Commands

Show patch status:

```bash
npm run db:patches:status
```

Preview pending patches without changing the database:

```bash
npm run db:patches:up -- --dry-run
```

Apply pending patches to the local database:

```bash
npm run db:patches:up
```

Record the current patch set as already applied without executing SQL:

```bash
npm run db:patches:baseline -- --dry-run
npm run db:patches:baseline
```

Use `baseline` only after confirming the restored database already contains the
schema represented by the current patch files.

## Rules

- Before any database change, download or retrieve the latest SQL backup from
  the VPS/Coolify backup system first.
- Keep a local PostgreSQL backup as an additional safety net, but do not treat
  it as a replacement for the VPS/Coolify backup requested for CERP DB work.
- Prefer additive SQL changes.
- Do not edit a patch file after it has been applied; add a new patch instead.
- Review `checksum-mismatch` results before continuing.
- Keep passwords and `DATABASE_URL` out of Git, logs, and tickets.

## Issue #55 - Recursive Fabrication Tree

Patch `20260624_recursive_fabrication_tree_of_hierarchy.sql` adds only new
structures for recursive OF generation:

- `of_generation_batches` tracks one recursive generation batch from a command
  line.
- `ordres_fabrication` gains parent/root/generation metadata for OF trees.
- `of_structure_snapshot` freezes the fabrication tree context at generation
  time.
- `of_operations.source_piece_operation_id` links copied OF operations back to
  the source routing operation.

This patch does not rename or remove historical tables. The technical table
`pieces_techniques_nomenclature` remains the manufactured parent/child
structure, while `pieces_techniques_achats` remains the purchase/procurement
structure.

## Issue #141 - Codification, versions techniques et VSM

Patch `20260713_codification_versions_of_vsm.sql` is additive and must be
applied to `cerp_test` before any production decision. It adds:

- the external-index/internal-revision separation and immutability triggers on
  `piece_technique_versions`;
- an applicable-version reference and SHA-256 technical snapshot for each OF;
- controlled VSM/document evidence metadata for Project Office.

Run `db/patches/support/20260713_codification_versions_of_vsm.verify.sql`
after application.

Before `cerp_test` and again before `cerp_prod`, run the read-only
`db/patches/support/20260713_codification_versions_of_vsm.preflight.sql`.
It reports missing/ambiguous client-plan-index mappings, old index collisions,
OFs already in use, migration state and sequence counters. It never updates
data and no automatic mapping is permitted for an ambiguous row.

Project Office evidence requires `CERP_DOCUMENTS_ROOT` in production. It must
be an explicit persistent, shared mount available to every application
instance; the API refuses evidence storage when production lacks that setting.
The companion rollback script is deliberately guarded and refuses to remove
post-migration technical versions/metadata, code allocations, quality-control
references, retained OF snapshots, or Project Office evidence. The additive
The VSM file category is enforced by the dedicated
`project_evidence_files_category_check` table constraint. The patch deliberately
does not alter the historical `po_evidence_type` enum, which can be owned by the
administrative PostgreSQL role while runtime patches are executed by `cerp_app`.

## Issue #165 - Parc machines

Patch `20260722_machine_park_165.sql` is additive and idempotent. It reserves the central `MCH` scope, makes unknown hourly rates nullable with explicit provenance, adds a legacy alias, enforces code immutability, records creation idempotency, links machine unavailability to canonical `planning_events`, and adds maintenance plans/events plus document metadata/removal fields.

Before any application, run `db/patches/support/20260722_machine_park_165.preflight.sql`. Apply only to `cerp_test` after an approved backup, then run `20260722_machine_park_165.verify.sql`. The guarded rollback refuses to drop structures once machine-park business rows exist and intentionally preserves rate provenance/code immutability where reverting would lose traceability. No #165 script is authorized to write `cerp_prod` without a later human production decision.

## Issue #223 - Réceptions de production

Patch `20260723_production_receipts_223.sql` adds an immutable, actor-scoped
idempotency ledger (`of_receipts`), explicit lot links on stock batches and
reservations, and the read model `v_stock_lot_availability`. Physical on-hand,
quarantine, blocked, reserved and available quantities remain distinct.

Run the matching `preflight` and `verify` scripts from `db/patches/support`.
The rollback is restricted to `cerp_test` and refuses to continue once a
receipt or lot-level reservation exists. Validation on 2026-07-23 used the
isolated `cerp_test` clone first. After explicit human approval, production was
backed up to `cerp_prod_pre_223_20260723_145750.backup` (SHA-256
`9a037c37563e1bbc57fa34b7e8c3fd2aaa1cca09e0b994628e5f0d4e9ab83dc1`),
then the patch was applied, verified and recorded in
`public.cerp_schema_migrations`.

## Issue #225 - Stock, lots, mouvements, magasins et inventaires

Patch `20260723_stock_traceability_225.sql` extends the existing stock ledger
with actor-scoped immutable command receipts, correlated reversals/transfers,
quality-aware availability, source-backed reservations, lot genealogy and
versioned inventory snapshots/count events. Posted and cancelled industrial
evidence cannot be rewritten.

Run `20260723_stock_traceability_225.preflight.sql` before applying the patch
and `20260723_stock_traceability_225.verify.sql` afterwards. The #225 support
scripts are restricted to `cerp_test`; the guarded rollback refuses to drop
structures once #225 evidence exists. Patch application itself remains under
the migration runner, backup policy and explicit human environment gate. The
preflight also checks the cross-module users, units, warehouses, locations,
orders, OF, BL, affairs, lot and batch prerequisites inherited from the active
schema.

No `DATABASE_URL` for `cerp_test` was configured in the #225 workspace on
2026-07-23, so the patch was not applied or registered on any database.
`cerp_prod` was not modified.
