# ADR-0074 — Versioned API and signed webhook boundary

- Status: accepted
- Date: 2026-08-14
- Owner: Keenan Martin
- Scope: `/api/v1`, API documentation and outbound business webhooks

## Context

The deployed API had more than one thousand Express operations but the hand-written OpenAPI document described only three Client operations. Adding more isolated comments would keep route coverage unverifiable. CERP+ already has a durable transactional outbox used by realtime and finance workflows; adding a second business-event publisher in every repository would duplicate commit and idempotency logic.

## Decision

1. `/api/v1` remains the stable major-version boundary. The OpenAPI route inventory is generated from the actual Express mounts and route calls. Build fails when the generated inventory is stale, when a duplicate operation exists, or when a public route has no explicit security rationale.
2. The document served at `GET /api/v1/openapi.json` uses `CERP_RELEASE_VERSION` as its deployed version and includes the route-source digest. `/docs` renders the same in-memory document.
3. Detailed request/response schemas remain sourced from the Zod contracts and hand-maintained schemas where they exist. The generated structural inventory never pretends that an unknown field is required or silently removes a route.
4. Deprecation requires at least 180 days of documented notice, `Deprecation` and `Sunset` headers, an announced replacement and continued service in `/api/v1` for the notice window. A breaking contract requires `/api/v2`.
5. Outbound webhooks project only explicitly registered, minimal payloads from the existing `erp_outbox_events`. Realtime targets, user identifiers, arbitrary business payloads and document contents are never copied.
6. Subscription secrets are random, returned through an exact idempotent command response, and encrypted with AES-256-GCM. `CERP_WEBHOOK_SECRET_ENCRYPTION_KEY` is separate from PostgreSQL and JWT secrets.
7. Every delivery contains a unique delivery ID and Unix timestamp. `CERP-Webhook-Signature` is `v1=HMAC-SHA256(secret, timestamp + "." + delivery_id + "." + raw_body)`. Receivers must reject timestamps older than 300 seconds and persist each delivery ID once.
8. Delivery is at-least-once. Network errors, 408, 425, 429 and 5xx use bounded exponential retries (30 seconds to one hour, eight attempts). Terminal failures enter a dead-letter state. 401, 403, 404, 410, a private-network target or a secret decryption failure disables the subscription.
9. Administration is limited to the live database `is_superadmin` marker. Creation, modification, rotation, sandbox tests and replay use `Idempotency-Key`; secret rotation and replay are audited.
10. Production webhook targets are HTTPS and are checked both syntactically and after DNS resolution to block private, loopback, link-local and special-use networks. The selected public address is pinned into the HTTP/TLS connection to prevent DNS rebinding. Redirects are never followed. Private HTTP targets are allowed only in a non-production sandbox with an explicit flag.

## Consequences

- Route coverage becomes measurable and blocks undocumented public expansion.
- Payload schema precision is visible: structural coverage is 100%, while detailed domain schemas continue to be improved from Zod without inventing fields.
- Existing transactions remain authoritative; webhook delivery does not change business commits.
- Operators must provision one separate 32-byte encryption key before enabling delivery.
- Once webhook evidence exists, SQL rollback is refused; operational rollback disables the worker and keeps delivery/audit proof.
