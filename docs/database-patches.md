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
`po_evidence_type.VSM` enum value remains because PostgreSQL cannot safely
remove enum values in a transactional rollback.
