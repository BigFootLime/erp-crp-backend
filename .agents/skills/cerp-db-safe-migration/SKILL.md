---
name: cerp-db-safe-migration
description: Prepare or review a CERP PostgreSQL schema change in the backend repository. Use for SQL patch proposals, data integrity checks and rehearsals in an isolated database.
---

# CERP database patch review

Read `AGENTS.md`, `docs/database-patches.md`, the release runbook in `docs/runbooks/database-upgrade-sol06.md` and the relevant files in `db/patches/`. Verify the schema assumptions against the patch history and the backend queries that will consume the change.

Prefer an additive patch compatible with current readers and writers. Preserve existing data, referential integrity and audit history. Explain locking or backfill implications, prerequisites, verification and rollback limits. Use the repository's existing patch and supporting-script conventions. Include a rehearsal on an explicitly isolated PostgreSQL instance when the task authorizes one.

Keep preparation, rehearsal and production application distinct. Production changes require explicit authorization for the specific operation. Never include credentials, production data or connection details in the resulting patch or report.
