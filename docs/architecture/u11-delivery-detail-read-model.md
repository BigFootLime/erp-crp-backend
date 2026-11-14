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

`delivery-header.repository.ts` owns the stable header row shape, row mappers,
header lock query, and frozen intercompany-address validation shared by detail
reads and transactional writes. The write facade depends only on this lower-level
owner; it does not import the volatile aggregate reader. Transactional write
paths retain their lock timing, capability checks, cache invalidation, events,
and outbox ownership. This extraction introduces no endpoint, schema,
authorization, deployment, or production-data change.
