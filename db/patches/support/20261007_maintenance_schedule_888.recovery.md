# Maintenance calendar 888 recovery

Additive schema only. The patch books no machines and creates no business fixture.
Before applying: canonical backup and Test/Production database dumps, expected pending patch and checksum verification.
Apply through the existing patch runner, then run the verify support file and compile runtime queries as `cerp_app`.

Rollback the application to the preserved image/release if necessary, retaining these additive tables.
Never delete a published rule, revision, occurrence, canonical availability pair or audit entry.
The rollback SQL is a rehearsal ending in ROLLBACK and refuses any published history.
For a wrong future calendar, preview an explicit change/disable: only future PLANNED generated slots may be cancelled, with immutable revisions and canonical audit.
Started slots and past history remain. Repair actual execution through the existing maintenance workflow.
An uncertain publish must be retried with the exact payload and Idempotency-Key to recover its transaction receipt.
