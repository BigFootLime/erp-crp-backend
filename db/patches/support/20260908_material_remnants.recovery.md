# Material remnants recovery

Run the preflight and a verified `pg_dump -Fc` before applying this additive patch, then verify as `cerp_app` and record the exact UTF-8 SHA-256 in the migration ledger. Activate on `cerp_test` first.

Keep the tables, signed source quantities, deferred declaration foreign key, immutable proofs and genealogy when rolling back an application release. Do not delete business history or restore a backup over newer transactions. Once measured debits exist, an older application cannot interpret their yield adjustment: disable new material debit actions until a compatible version is restored. Existing stock entries remain canonical. Corrections must use linked compensations, never edits to posted entries. Production activation requires the normal reviewed release gate.
