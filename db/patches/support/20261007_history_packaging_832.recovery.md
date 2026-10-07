# Recovery — history and packaging 832

Before applying, obtain a verified full backup and fresh custom-format dumps of Test and Production, then run the schema-only preflight/apply/verify and SQL compilation. The deployment migration ledger applies the patch once per database.

For a binary rollback, retain all new tables, columns, grants and increased time precision. The previous application ignores these additive fields. Do not delete document references, label print history or packaging decisions and do not reduce numeric precision. Repair forward when needed. Database restoration is a separate incident procedure using the verified dump and backup, never an automatic rollback.
