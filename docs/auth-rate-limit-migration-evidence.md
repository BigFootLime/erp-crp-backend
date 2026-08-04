# SEC-CERP-0005 migration validation record

- Date: 2026-08-04
- Candidate branch: `fix/gpt56-0013-rate-limit-migration-ledger`
- Base commit: `58ffacb5c9a216a60655a88042b51da33fb42bbf`
- Patch: `20260804_auth_rate_limit_buckets.sql`
- Canonical LF SHA-256: `f61120b4068a36138b1d85c0269f764061a525aab6141f99df9c93ad6c5d27a2`

## Scope and interpretation

This record covers the uncommitted candidate diff exercised in disposable local
databases named `cerp_test` and `cerp_dev`. It does **not** claim that a shared or
deployed `cerp_test` or production database was changed. The authorized release
record must append the non-destructive shared-`cerp_test` checks below before
promotion. No connection string, password, HMAC key or other secret was captured.

## Disposable database results

The candidate was exercised on PostgreSQL 16.14 and PostgreSQL 17.10. The real
repository inventory contained 127 primary SQL patches.

On a pristine `cerp_test` database for each PostgreSQL version:

- read-only preflight passed;
- `up --dry-run --only 20260804_auth_rate_limit_buckets.sql` reported 0 applied,
  127 pending, 0 checksum mismatches, and exactly one selected patch to apply;
- `up --only 20260804_auth_rate_limit_buckets.sql` applied only the selected patch;
- `status --check --only 20260804_auth_rate_limit_buckets.sql` reported 1 applied,
  126 unrelated patches still pending, 0 checksum mismatches, and selected status
  `applied`;
- the ledger contained exactly one row: the selected patch with the canonical
  checksum and non-null `applied_at`; no unrelated patch was registered;
- read-only exact verification passed;
- a second identical `up --only` invocation applied 0 patches and left the
  one-row ledger unchanged;
- exact rollback removed the table and selected ledger row together, and a
  second rollback against the fully absent state was a no-op (also replayed on
  PostgreSQL 17.10).

PostgreSQL 16 refusal checks passed as listed below. The four ACL/owner cases
were also replayed on PostgreSQL 17.10, including refusal by both read-only
verification and destructive rollback:

| Case | Expected and observed result |
|---|---|
| Target table exists without the target ledger row | Preflight refused |
| Named expiry index exists without the target ledger row | Preflight refused |
| `request_count` changed from integer to text | Exact verification refused |
| Count constraint replaced by same-named `CHECK (TRUE)` | Exact verification refused |
| Expiry index recreated on `scope` under the expected name | Exact verification refused |
| Another applied inventory file has a different checksum | Immutable `--only` refused before patch execution |
| Alternate `--patch-dir` supplied with immutable `--only` | Argument validation refused before inventory loading |
| Creator default privileges grant table rights to `PUBLIC` and `rogue_reader` | Patch produced owner `cerp_app`, removed both grants, stored exactly `cerp_app=arwd/cerp_app`, and exact verification passed |
| Owner changed from `cerp_app` to `rogue_owner` | Exact verification and rollback refused |
| `ALL` granted to `PUBLIC` after application | Exact verification and rollback refused |
| `SELECT` granted to `rogue_reader` after application | Exact verification and rollback refused |

For the accepted ACL, effective `cerp_app` ordinary table rights were confirmed
true for `SELECT`/`INSERT`/`UPDATE`/`DELETE` and false for
`TRUNCATE`/`REFERENCES`/`TRIGGER`. Ownership still gives `cerp_app` inherent
alter/drop/regrant authority; no claim is made that ACL revokes remove ownership
itself. Exact rollback succeeded on the restored contract in both PostgreSQL
versions and removed the table and target ledger row together.

Rollback concurrency was exercised only in disposable PostgreSQL 16 `cerp_dev`:

- a transaction holding the runner's `cerp_schema_migrations` advisory key kept
  rollback blocked throughout a 300 ms observation interval; after release,
  exact rollback removed both table and ledger row atomically;
- an `ACCESS SHARE` holder kept rollback's `ACCESS EXCLUSIVE` table lock blocked
  throughout a 300 ms observation interval; after release, exact rollback
  removed both table and ledger row;
- with the table initially absent, rollback was paused on the provenance row and
  another session created the target table before the fresh-snapshot recheck.
  Rollback raised the dedicated concurrent-appearance refusal and preserved both
  the newly created table (including its race-marker column) and the ledger row;
- with the rollback session default deliberately set to `REPEATABLE READ`, the
  script forced `READ COMMITTED`, observed OID 16694, waited on the original
  relation lock, and then refused a same-name replacement with OID 16707. The
  replacement table, its marker column and the ledger row were all preserved.

The PostgreSQL containers and disposable databases used for this record are
temporary validation fixtures and are removed at the end of the final gate run.

## Shared `cerp_test` evidence to append to the release record

After the authorized runner application, execute only these non-destructive
checks. Keep `DATABASE_URL` in the environment and do not echo it:

```text
npm run db:patches:status -- --check --only 20260804_auth_rate_limit_buckets.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/patches/support/20260804_auth_rate_limit_buckets.preflight.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/patches/support/20260804_auth_rate_limit_buckets.verify.sql
```

Append the command timestamp, PostgreSQL version, selected status, global
inventory summary, preflight result and verification result to the authorized
release record. The acceptance state is selected status `applied`, zero checksum
mismatches, exact verification success, and unrelated pending patches still
unregistered. These commands do not alter schema or data.
