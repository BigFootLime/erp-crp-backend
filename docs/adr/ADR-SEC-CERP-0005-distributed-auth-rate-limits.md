# ADR SEC-CERP-0005 — Distributed authentication rate limits

- Status: accepted
- Date: 2026-08-04
- Scope: `login`, `register`, `forgot-password`, `reset-password`

## Context

The CERP API runs as two independent processes: one on the atelier host and one
in the VPS Coolify deployment. Both use the same PostgreSQL source of truth over
the documented local/WireGuard paths. The previous login and password-reset
limits were four process-local `Map` objects. Their counters disappeared on
restart and were not shared between the two deployments. Registration and reset
token submission had no equivalent guard.

No shared Redis service is part of the verified deployment. Introducing one
only for authentication throttling would add an unowned availability and secret
management boundary. PostgreSQL is already shared, backed up and reachable by
both API instances.

## Decision

Use a PostgreSQL fixed-window counter store behind the `AuthRateLimitStore`
interface. Every request consumes all applicable subjects in one atomic
`INSERT ... ON CONFLICT ... DO UPDATE` statement. PostgreSQL's
`statement_timestamp()` defines window expiry and `Retry-After`, avoiding
application-clock skew between replicas.

The subjects are:

| Endpoint | Subjects | Default window and thresholds |
|---|---|---|
| login | client network, NFKC/uppercase username | IP 50 / 15 min; username 10 / 15 min |
| register | client network, NFKC/uppercase username, NFKC/lowercase email | IP 10 / 60 min; username and email each 3 / 60 min |
| forgot-password | client network plus both username and email canonical candidates | IP 20 / 60 min; username and email candidates each 5 / 60 min |
| reset-password | client network, exact opaque reset token | IP 30 / 15 min; token 10 / 15 min |

Before storage, each subject is transformed as
`HMAC-SHA256(secret, "v1\0<scope>\0<normalized-subject>")`. The table receives
only the scope and 64-character digest. It never receives a raw IP, username,
email or reset token. Rate-limit logs contain only endpoint, outcome, policy,
request ID, retry duration and a sanitized error class; they do not contain a
subject or digest.

Username canonicalization is shared with validation and account lookup:
`NFKC`, trim, then Unicode uppercase. Email uses `NFKC`, trim, then lowercase,
matching writes and `LOWER(email)` lookup. Forgot-password always consumes both
canonical candidates without classifying or looking up the input first. Reset
tokens are opaque and are never trimmed, normalized or case-folded.

IPv4 addresses use their canonical address. IPv4-mapped IPv6 collapses to the
same IPv4 subject. Native IPv6 uses a canonical `/64` network subject so textual
variants and privacy addresses within the same client network cannot bypass the
limit. Express trusts one proxy hop by default, matching both Apache and
Traefik paths. `TRUST_PROXY_HOPS` is bounded and must match the deployed path;
the right-most trusted address is used, not an attacker-controlled left-most
`X-Forwarded-For` value.

## Failure policy

| Endpoint | Store unavailable | Quota exceeded |
|---|---|---|
| login | fail closed, generic `503`, `Retry-After` | generic `429`, `Retry-After` |
| register | fail closed, generic `503`, `Retry-After` | generic `429`, `Retry-After` |
| reset-password | fail closed, generic `503`, `Retry-After` | generic `429`, `Retry-After` |
| forgot-password | suppress reset work, preserve generic `200` and minimum response time | same generic `200`; suppress reset work |

The forgot-password behavior prevents account enumeration and avoids sending
mail when abuse controls cannot make a reliable decision. The other endpoints
fail closed because bypassing their guard during a shared-store incident would
re-open brute force or automated account creation.

## Retention and observability

Expired rows are deleted by an unreferenced periodic maintenance timer after a
short configurable grace period. Only HMAC pseudonyms are retained. Store
failure, cleanup failure and blocked-request events are structured and contain
no subject values. Normal allowed requests add no rate-limit log noise.

## Alternatives considered

- Process-local memory: rejected because it fails restart and multi-replica
  requirements.
- Redis: rejected for now because it is not part of the verified infrastructure.
- Reusing `auth_login_logs`: rejected because it covers neither registration nor
  reset requests, retains personal audit data, and cannot provide one atomic
  counter contract across all endpoints.
- Fail-open fallback: rejected for normal operation. The explicit emergency
  disable switch exists only as a short rollback aid under human supervision.

## Consequences

The table patch must be applied before the new release is enabled. A PostgreSQL
incident now makes login, registration and reset submission temporarily
unavailable by design; forgot-password remains indistinguishable to callers but
does no work. Both API deployments must use the same HMAC key. Coordinated key
rotation resets the effective buckets and therefore must occur only at a
documented window boundary.

No frontend contract change is required: existing successful responses remain
unchanged and the frontend already handles HTTP errors generically.
