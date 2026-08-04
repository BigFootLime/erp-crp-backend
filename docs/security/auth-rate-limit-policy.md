# Authentication rate-limit policy

This policy implements `SEC-CERP-0005`. The architectural rationale is in
[`../adr/ADR-SEC-CERP-0005-distributed-auth-rate-limits.md`](../adr/ADR-SEC-CERP-0005-distributed-auth-rate-limits.md).

## Control map

The previous process-local counters were:

- login by IP: 10 requests per 15 minutes;
- login by username: 10 requests per 15 minutes;
- forgot-password by IP: 5 requests per 60 minutes;
- forgot-password by username/email: 5 requests per 60 minutes.

They were removed. The distributed policy preserves the username protection,
raises the shared-IP login ceiling to avoid locking a legitimate NAT population,
and adds registration and reset-token controls. Exact defaults and environment
overrides are defined in `src/config/auth-rate-limit.ts`.

## Privacy properties

- The application HMACs every subject before calling the repository.
- PostgreSQL stores no raw IP, email, username or reset token in the rate table.
- Rate-limit operational logs contain no subject and no HMAC digest.
- Native IPv6 is minimized to a `/64` network before HMAC.
- Usernames use the account contract (`NFKC`, trim, Unicode uppercase) and
  emails use `NFKC`, trim and lowercase before HMAC.
- Reset tokens remain exact opaque byte-for-byte strings; they are never
  trimmed, normalized or case-folded.
- Expired pseudonyms are removed by periodic maintenance; the default grace
  period is one hour after expiry.
- The HMAC key is a server-side secret and must be identical on both backends.

The existing security audit records are a separate, access-controlled purpose
and are not reused as a throttling store.

## Anti-enumeration contract

`forgot-password` always returns status `200` with:

```json
{"message":"Si ce compte existe, un lien de réinitialisation a été envoyé."}
```

The minimum response time remains 600 ms whether validation fails, a bucket is
blocked, the shared store is unavailable, or the account does not exist. A
blocked/degraded request does not query the account or send an email.

Every syntactically supplied forgot-password identifier consumes both a
username-canonical bucket and an email-canonical bucket, plus the client
network bucket. This happens before validation and without a database lookup or
input-shape branch, so the bucket set and response do not reveal whether the
value resembles or matches an account of either type.

The other endpoints use generic `429` or `503` messages. A response never states
which subject reached a threshold and never confirms whether an identifier or
token exists.

## Operator signals

Structured event types:

- `auth_rate_limit` with outcome `blocked`;
- `auth_rate_limit` with outcome `store_unavailable` and the configured policy;
- `auth_rate_limit_cleanup_failed`.

Alert on sustained `store_unavailable`, on cleanup failures across two
intervals, or on a sharp rise of blocked requests. Do not add subject values,
headers or database error messages to these logs.
