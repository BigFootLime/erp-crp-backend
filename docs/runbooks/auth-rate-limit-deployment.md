# Runbook — distributed authentication rate limits

This runbook covers the controlled deployment and rollback gates for
`SEC-CERP-0005`. Record environment-specific execution evidence in the release
log; this document does not assert the current state of any deployed environment.

## Artifacts

- patch: `db/patches/20260804_auth_rate_limit_buckets.sql`;
- read-only preflight: `db/patches/support/20260804_auth_rate_limit_buckets.preflight.sql`;
- read-only verification: `db/patches/support/20260804_auth_rate_limit_buckets.verify.sql`;
- non-production destructive rollback: `db/patches/support/20260804_auth_rate_limit_buckets.rollback.sql`;
- durable validation record: `docs/auth-rate-limit-migration-evidence.md`.

The primary patch does not self-register. Apply it only through
`npm run db:patches:up -- --only 20260804_auth_rate_limit_buckets.sql`: the runner records
`20260804_auth_rate_limit_buckets.sql`, its canonical LF SHA-256
`f61120b4068a36138b1d85c0269f764061a525aab6141f99df9c93ad6c5d27a2`,
and `applied_at` in the same transaction as the table change. The verify script
checks all three fields against that runner-owned record. A pending patch refuses
any pre-existing target table or index instead of registering a potentially
partial artifact as complete.

The table owner is deterministically `cerp_app`, matching the public-table
ownership contract on `cerp_test` and `cerp_prod`. The patch revokes `PUBLIC`,
removes any other table grants inherited from the creator's default privileges,
and records an explicit ACL containing only `SELECT`, `INSERT`, `UPDATE` and
`DELETE` for `cerp_app`, without grant option; effective `TRUNCATE`, `REFERENCES`
and `TRIGGER` are revoked. PostgreSQL table owners still retain inherent object
control, including the ability to alter/drop the table and regrant privileges;
that ownership authority is accepted only because the exact owner is
`cerp_app`. No other table or column ACL is allowed.

Runner atomicity, migration guards, registry compensation and refusal paths are
validated against disposable PostgreSQL 16 and, when available, PostgreSQL 17
databases as part of release evidence; those databases are removed afterwards.

Production execution requires an authorization recorded in the release log.
This is an explicit governance gate, not an interactive runner prompt: once the
controlled release is authorized, the commands below execute non-interactively
and do not request the same decision again.

## Required configuration

Set the same values on the atelier systemd service and the VPS Coolify service.
Secret values belong in their server-side secret stores and must never be pasted
into Git, issues, logs or evidence.

| Variable | Default | Purpose |
|---|---:|---|
| `AUTH_RATE_LIMIT_ENABLED` | `true` | Emergency feature switch; normal production value is `true` |
| `AUTH_RATE_LIMIT_STORE` | `postgres` | Only supported shared store |
| `AUTH_RATE_LIMIT_HASH_KEY` | none in production | At least 32 characters; identical on both backends |
| `TRUST_PROXY_HOPS` | `1` | Apache/Traefik hop count; `0` only for a direct local process |
| `AUTH_RATE_LIMIT_STORE_RETRY_AFTER_SECONDS` | `30` | Retry hint during store failure |
| `AUTH_RATE_LIMIT_CLEANUP_INTERVAL_MS` | `900000` | Expired-row cleanup cadence |
| `AUTH_RATE_LIMIT_RETENTION_AFTER_EXPIRY_MS` | `3600000` | Pseudonym grace period after expiry |
| `AUTH_RATE_LIMIT_LOGIN_WINDOW_MS` | `900000` | Login fixed window |
| `AUTH_RATE_LIMIT_LOGIN_IP_LIMIT` | `50` | Login client-network threshold |
| `AUTH_RATE_LIMIT_LOGIN_IDENTIFIER_LIMIT` | `10` | Login username threshold |
| `AUTH_RATE_LIMIT_REGISTER_WINDOW_MS` | `3600000` | Registration fixed window |
| `AUTH_RATE_LIMIT_REGISTER_IP_LIMIT` | `10` | Registration client-network threshold |
| `AUTH_RATE_LIMIT_REGISTER_IDENTIFIER_LIMIT` | `3` | Per-dimension registration username/email threshold |
| `AUTH_RATE_LIMIT_FORGOT_WINDOW_MS` | `3600000` | Forgot-password fixed window |
| `AUTH_RATE_LIMIT_FORGOT_IP_LIMIT` | `20` | Forgot-password client-network threshold |
| `AUTH_RATE_LIMIT_FORGOT_IDENTIFIER_LIMIT` | `5` | Per-candidate forgot-password username/email threshold |
| `AUTH_RATE_LIMIT_RESET_WINDOW_MS` | `900000` | Reset-token fixed window |
| `AUTH_RATE_LIMIT_RESET_IP_LIMIT` | `30` | Reset client-network threshold |
| `AUTH_RATE_LIMIT_RESET_TOKEN_LIMIT` | `10` | Reset-token threshold |

Invalid values fail application startup. Every enabled runtime outside the test
harness also fails startup when the HMAC key is absent or shorter than 32
characters; an absent or unexpected `NODE_ENV` never enables a public fallback.

## Test-first rollout

1. Confirm a current backup and recovery point for `cerp_test`.
2. Run the preflight against `cerp_test`; it performs no writes.
3. Run `npm run db:patches:up -- --dry-run --only 20260804_auth_rate_limit_buckets.sql`.
   Review the complete inventory/checksum output and the selected pending/applied
   status.
4. Apply only with
   `npm run db:patches:up -- --only 20260804_auth_rate_limit_buckets.sql`.
   Do not execute the primary patch directly with `psql`, because that bypasses
   the registry and immutable selector.
5. Run the read-only verify script against `cerp_test`.
6. Configure a non-production HMAC key on both test API instances.
7. Deploy the same release to both test API instances.
8. Exercise only synthetic identifiers reserved for testing. Confirm that a
   bucket consumed through instance A blocks through instance B, remains after
   restarting A, returns a numeric `Retry-After`, and expires after its window.
9. Use the deterministic injected failing store from the automated tests; do
   not stop or disconnect the shared database. Confirm `503` for
   login/register/reset and generic `200` without mail for forgot-password.
10. Confirm logs contain endpoint/outcome only and no synthetic identifier/IP.

Promotion to production repeats backup, preflight, patch and verify through the
controlled release workflow. Apply the table before deploying code. Configure
the same HMAC key on both deployments, deploy the two backends in a short
controlled window, then confirm health and store-unavailable logs. Patch
application uses the same immutable `--only 20260804_auth_rate_limit_buckets.sql`
selector as `cerp_test`; an unscoped apply command is not part of this runbook.

## Durable, non-destructive `cerp_test` evidence

After application, capture these read-only checks in the authorized release
record without printing `DATABASE_URL` or secret values:

```text
npm run db:patches:status -- --check --only 20260804_auth_rate_limit_buckets.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/patches/support/20260804_auth_rate_limit_buckets.preflight.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/patches/support/20260804_auth_rate_limit_buckets.verify.sql
```

The selected status must be `applied`, while unrelated pending patches remain
pending and unregistered. Preflight and verify perform no schema/data writes;
verify checks exact columns, types, nullability, defaults, normalized CHECK
expressions, indexes, triggers, RLS/policies, owner, explicit table/column ACL,
ledger SHA-256 and `applied_at`.
The repository validation record linked above captures the reproducible
disposable-database proof; the release log is the durable evidence for the
specific deployed `cerp_test` execution.

## Rollback

Preferred production rollback:

1. restore the previous application release on both backends;
2. leave `public.auth_rate_limit_buckets` in place (it is inert for old code);
3. remove new environment variables only after both old instances are healthy.

Do not run the destructive rollback script on production; it refuses any
database other than `cerp_dev` or `cerp_test`. On those databases, the script
may be used only after confirming that no active test depends on the counters.
When it actually drops the patch table, it removes the matching runner-owned
registry entry in the same transaction. If the table is already absent, the
rollback is a no-op only when its ledger entry and named index are also absent.
Any one-sided artifact/ledger state, mismatched ledger entry, or
altered/additional table structure aborts before `DROP TABLE` and preserves the
existing state. Rollback forces `READ COMMITTED`, takes the runner's advisory
transaction lock, pins the initially observed table OID, and requires an
`ACCESS EXCLUSIVE` lock on that exact relation before structural inspection; a
concurrent create or same-name replacement is refused and preserved.

If the table patch is healthy but the new code must be disabled briefly during
an approved rollback, set `AUTH_RATE_LIMIT_ENABLED=false` on both instances,
restart them, and complete the application rollback immediately. This is a
temporary fail-open state and must not be treated as a steady configuration.

## HMAC key rotation

Rotate only through the normal secret-change procedure. Because a new key makes
new pseudonyms, drain both instances and change them together at or after the
longest configured window. Expect previous buckets to age out; never log or
export their digests.
