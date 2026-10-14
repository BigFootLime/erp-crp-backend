# Shared company canonical schema regression

The deployed canonical `factureur` table uses `creation_date` and
`modification_date` (nullable timestamp without time zone, default
`CURRENT_TIMESTAMP`), and nullable varchar `created_by` / `modified_by`.
It has no `created_at` or `updated_at`. Those names in the old synthetic
bootstrap concealed SQLSTATE 42703 in the initial setup company list.

The repository now reads the canonical modification date under the unchanged
API field `expected_updated_at`, locks and compares that value before updates,
and writes canonical dates. Company projection preserves the creation date and
uses the canonical modification date. Legal mention timestamps remain unchanged.
No runtime database migration is required.

Qualification: `node scripts/managed-tests/check-directory-sessions.cjs` —
36 checks passed on 2026-10-14. The real private HTTP authority runs as
`cerp_directory_app`; the company update projection also runs as `cerp_app`.
The owned loopback PostgreSQL fixtures use the canonical biller column names,
types, defaults and nullability above, without synthetic timestamp aliases.
Only synthetic profiles and companies are used.

Regression checks cover an empty company list, creation and replay without
duplicates, the public optimistic concurrency field, update and replay,
rejection of a stale edit with 409, preservation of the creation date and legal
history, and propagation to a second Test with the same company UUID.

The existing synthetic template lacks some historical business ACLs. The
fixture helper grants the specific profile/company permissions used by this
projection, only on fresh owned Test fixtures. This qualification does not
certify the complete production ACL catalogue, real antivirus operation or the
full ERP business recipe. Production and online Test are untouched by it.

Aggregate evidence: `evidence/shared-directory-sessions-1568.json`.

Additional verification on this change: `npm run build` passed; full
`npm run test:run` passed (710 files, 7,790 tests; 31 files / 254 tests
skipped by their existing environment requirements).
