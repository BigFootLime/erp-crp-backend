# U11 — Delivery-detail read model

`delivery-detail-read.repository.ts` owns the complete read aggregate returned by
`repoGetLivraisonDetail`: delivery header, ordered lines, allocation provenance,
documents, proof list, and event history. The historic
`livraisons.repository.ts` export remains the compatibility boundary for callers.

The detail owner resolves the imported PostgreSQL pool when the read is invoked,
acquires and releases its own read client, and retains the original query order.
Optional and absent related rows still map to `null` or empty collections exactly
as before. Invalid frozen intercompany destinations continue to fail with the
same domain error.

`getHeader` and the frozen intercompany-address mapper are shared from the detail
owner because writes need the identical header shape and validation. Transactional
write paths remain in the facade: they retain lock timing, capability checks,
cache invalidation, events, and outbox ownership. This extraction introduces no
endpoint, schema, authorization, deployment, or production-data change.
