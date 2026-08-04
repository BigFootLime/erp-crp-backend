# Runbook — distributed authentication rate limits

This runbook covers `SEC-CERP-0005`. It does not authorize a production change.
Production backup, patching, deployment and secret configuration require the
existing human approval gates.

## Artifacts

- patch: `db/patches/20260804_auth_rate_limit_buckets.sql`;
- read-only preflight: `db/patches/support/20260804_auth_rate_limit_buckets.preflight.sql`;
- read-only verification: `db/patches/support/20260804_auth_rate_limit_buckets.verify.sql`;
- test-only destructive rollback: `db/patches/support/20260804_auth_rate_limit_buckets.rollback.sql`.

No SQL from these files was executed while preparing this change. The automated
evidence is static guard testing plus deterministic fake-store integration tests.

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
| `AUTH_RATE_LIMIT_REGISTER_IDENTIFIER_LIMIT` | `3` | Registration username/email threshold |
| `AUTH_RATE_LIMIT_FORGOT_WINDOW_MS` | `3600000` | Forgot-password fixed window |
| `AUTH_RATE_LIMIT_FORGOT_IP_LIMIT` | `20` | Forgot-password client-network threshold |
| `AUTH_RATE_LIMIT_FORGOT_IDENTIFIER_LIMIT` | `5` | Forgot-password identifier threshold |
| `AUTH_RATE_LIMIT_RESET_WINDOW_MS` | `900000` | Reset-token fixed window |
| `AUTH_RATE_LIMIT_RESET_IP_LIMIT` | `30` | Reset client-network threshold |
| `AUTH_RATE_LIMIT_RESET_TOKEN_LIMIT` | `10` | Reset-token threshold |

Invalid values fail application startup. Every enabled runtime outside the test
harness also fails startup when the HMAC key is absent or shorter than 32
characters; an absent or unexpected `NODE_ENV` never enables a public fallback.

## Test-first rollout

1. Confirm a current backup and recovery point for `cerp_test`.
2. Run the preflight against `cerp_test`; it performs no writes.
3. Apply the patch to `cerp_test` through the established patch process.
4. Run the read-only verify script against `cerp_test`.
5. Configure a non-production HMAC key on both test API instances.
6. Deploy the same release to both test API instances.
7. Exercise only synthetic identifiers reserved for testing. Confirm that a
   bucket consumed through instance A blocks through instance B, remains after
   restarting A, returns a numeric `Retry-After`, and expires after its window.
8. Use the deterministic injected failing store from the automated tests; do
   not stop or disconnect the shared database. Confirm `503` for
   login/register/reset and generic `200` without mail for forgot-password.
9. Confirm logs contain endpoint/outcome only and no synthetic identifier/IP.

Promotion to production repeats backup, preflight, patch and verify only after
explicit human approval. Apply the table before deploying code. Configure the
same HMAC key on both deployments, deploy the two backends in a short controlled
window, then confirm health and store-unavailable logs.

## Rollback

Preferred production rollback:

1. restore the previous application release on both backends;
2. leave `public.auth_rate_limit_buckets` in place (it is inert for old code);
3. remove new environment variables only after both old instances are healthy.

Do not run the destructive rollback script on production; it refuses any
database other than `cerp_test`. On `cerp_test`, the script may be used only
after confirming that no active test depends on the counters.

If the table patch is healthy but the new code must be disabled briefly during
an approved rollback, set `AUTH_RATE_LIMIT_ENABLED=false` on both instances,
restart them, and complete the application rollback immediately. This is a
temporary fail-open state and must not be treated as a steady configuration.

## HMAC key rotation

Rotate only through the normal secret-change procedure. Because a new key makes
new pseudonyms, drain both instances and change them together at or after the
longest configured window. Expect previous buckets to age out; never log or
export their digests.
