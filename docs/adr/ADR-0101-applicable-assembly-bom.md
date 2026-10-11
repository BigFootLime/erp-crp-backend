# Applicable assembly BOM scope (#1161)

Status: accepted for implementation; actual business recipe replay pending.

## Problem

In the Base Test assembly recipe, generation included two unversioned BOM rows.
Preparation evaluation and draft-child synchronization selected only rows with
the exact parent version. Normal approval therefore froze an empty structure
and cancelled both existing draft sub-orders and their component requirements.
The BOM rows still existed; no manufacturing or stock movements had occurred.

## Decision

Use one static SQL predicate in technical-sheet generation, recursive generation,
snapshot creation, current-definition comparison, preparation evaluation,
draft-child reconciliation and purchased-component preview. Keep the existing
technical-sheet policy: select the exact parent piece and revision. Unversioned
rows are compatible only while that parent piece has no version-scoped BOM rows.
An empty selected revision must not inherit components from another index.

Preserve each occurrence and quantity; no merge by child/article identity.
Commercial purchased BOM requirements are attributed to the selected parent
revision and repeated parent/version selections are read once. Purchase-line
selection remains unchanged.

This fixes reading, without rewriting BOM identities, historical snapshots,
version-copy semantics, reservations, quantities or statuses in a migration.
Normal preparation approval/review still invalidates stale evidence. Frozen
orders remain immutable; modifying engaged or reserved children remains refused.
The affected already-frozen recipe must use an authorized business revision,
not a direct SQL repair or automatic resurrection of cancelled children.

## Validation

An opt-in PostgreSQL test database named `assembly_bom_scope_1161` executes the
actual recursive reader, reconciliation transaction queries and purchased BOM
preview. Cases cover two preserved legacy sub-orders, idempotence, frozen child
evidence, exact/obsolete/empty revisions, distinct occurrences, independent
parent scopes and reservation/engagement refusal. It never connects to a live ERP
database. Strict build and real Base Test replay remain explicit release gates.
