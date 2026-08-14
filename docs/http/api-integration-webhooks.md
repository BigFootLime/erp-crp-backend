# CERP+ API v1 and signed webhooks integration guide

## Contract and version

- OpenAPI JSON: `GET /api/v1/openapi.json`
- Interactive reference: `GET /docs`
- API prefix: `/api/v1`
- Authentication: `Authorization: Bearer <JWT>` except the explicitly documented public operations
- Correlation: clients may send `X-Request-Id` or `X-Correlation-Id`; the API returns both correlation headers
- Deployed version: `info.version` equals `CERP_RELEASE_VERSION`

The generated `x-cerp-route-coverage` block reports the actual Express-operation count, documented count, percentage and source SHA. `pnpm openapi:check` fails when routes and the committed inventory diverge.
The build also parses and validates the complete OpenAPI 3.0.3 document. Webhook management responses are checked against their Zod output contracts before they leave the API.

## Pagination, filters and errors

Domain lists keep their existing filters. When cursor pagination is provided, use `cursor` and a `limit` from 1 to 200; do not derive business completeness from an omitted or null field. Error bodies contain a machine code when available and the response carries `X-Request-Id`. `401` means authentication is absent or expired; `403` means the live account/module/capability decision refused access; `409` covers concurrency, transition and idempotency conflicts; `422` means a business prerequisite is missing.

`429` responses must be retried only after `Retry-After`. Authentication and signed inbound provider endpoints have application-level rate limits. Other routes may also be limited by the reverse proxy; a client must not assume unlimited throughput.

## Idempotent commands

Operations marked `x-cerp-idempotency: required` require a UUID in `Idempotency-Key`. Retry the exact same body with the same key after a network ambiguity. Reusing a key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.

## Webhook administration

The following routes require the live superadmin marker:

- `GET /api/v1/admin/webhooks/readiness`
- `GET /api/v1/admin/webhooks/events`
- `GET|POST /api/v1/admin/webhooks/subscriptions`
- `GET|PATCH /api/v1/admin/webhooks/subscriptions/{id}`
- `POST /api/v1/admin/webhooks/subscriptions/{id}/rotate-secret`
- `POST /api/v1/admin/webhooks/subscriptions/{id}/test`
- `GET /api/v1/admin/webhooks/deliveries`
- `POST /api/v1/admin/webhooks/deliveries/{id}/replay`

The secret is returned only by creation or rotation and by an exact idempotent replay of that command. Lists and audit events never expose it. Store it in a secret manager, not in application logs or source control.

## Delivery verification

Headers:

```text
CERP-Webhook-Id: <unique delivery UUID>
CERP-Webhook-Timestamp: <Unix seconds>
CERP-Webhook-Event: erp.invoice.issued.v1
CERP-Webhook-Secret-Version: 1
CERP-Webhook-Signature: v1=<hex HMAC-SHA256>
```

Verification procedure:

1. Read the request body as raw bytes.
2. Reject a timestamp more than 300 seconds from the receiver clock.
3. Build `<timestamp>.<delivery-id>.<raw-body>` without reformatting JSON.
4. Compute HMAC-SHA256 with the subscription secret and compare in constant time.
5. Atomically record `CERP-Webhook-Id`; if it already exists, return the original success without repeating the business effect.
6. Return a 2xx only after the receiver's idempotency receipt is durable.

Example Node.js verification:

```js
import crypto from "node:crypto";

export function verify(secret, timestamp, deliveryId, rawBody, header) {
  const expected = `v1=${crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`), rawBody]))
    .digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(header);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
```

## Retry and dead-letter behavior

Transient network errors, 408, 425, 429 and 5xx responses retry after 30, 60, 120, 240, 480, 960, 1920 and at most 3600 seconds. Eight unsuccessful attempts end in `DEAD_LETTER`. HTTP 401, 403, 404 or 410 disables the subscription. The administration API can replay a terminal delivery only after the subscription is active; replay itself is idempotent and audited.

Production destinations must use HTTPS. CERP+ resolves the destination, rejects private and special-use address space, and pins the accepted address into the TLS connection; redirects are not followed.

## Sandbox

Use the isolated E2E environment, never production:

```powershell
$env:NODE_ENV = "test"
$env:CERP_WEBHOOK_SANDBOX_ALLOW_PRIVATE_HOSTS = "1"
$env:CERP_WEBHOOK_SECRET_ENCRYPTION_KEY = "<32-byte base64 key generated for this disposable run>"
```

Create a subscription pointing to a disposable local receiver, then call `/subscriptions/{id}/test`. The event type is `erp.webhook.test.v1`; no production business event is fabricated. The private-host flag is ignored in production.

## Compatibility and support

Event names are versioned (`.v1`). Additive payload fields require a documented contract update; removing or changing a field requires a new event version. API breaking changes require `/api/v2`. CERP+ supports delivery and auditable replay, not arbitrary transformation code in the ERP.
