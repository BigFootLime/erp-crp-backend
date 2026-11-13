# EC material referentials backport — 2026-11-12

- Candidate runtime: `2.0.33-403f96675943-matiere-backport-0fca2b3a`.
- Adapter SHA-256: `1b63fbb242a51566fda02c71c6aee24407262f3e828172528a94bff966b49efa`.
- Scope: only the material-referential compatibility router and the `/auth/access-profile` augmenter; native Stock handlers and access-control files were not replaced.
- The approved `stock_sous_etats.etat_id` nullable migration and its standalone-code partial index were applied idempotently to EC test and production after a scoped row backup.
- EC test (18111) was cut over before EC production (18110). Both services were healthy after restart and their unauthenticated referential endpoints returned 401.

The systemd unit backups and the test schema-row snapshot are retained in the isolated EC data mount. This record contains no credentials or database connection details.
