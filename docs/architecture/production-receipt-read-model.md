# Production receipt read model

Issue #1509 / U11 moves the two read-only production receipt projections to
`production-receipts.read-model.repository.ts`. The existing
`production-receipts.repository.ts` remains the public facade: it re-exports
`repoGetOfReceiptContext`, `repoGetOfTraceability` and their public result
types, so the production service, controller and HTTP routes retain their
existing imports and contracts.

The read model owns the exact existing SQL, row mapping and parameter order for
receipt context and traceability. Its shared
`resolveArticleForPieceTechnique` helper accepts the caller's query client and
is also used by the receipt command. It opens no transaction and neither
commits nor rolls back one. The two read projections continue to use the
existing pool exactly as before.

This is a structural extraction only: no endpoint, schema, authorization,
Quality rule, stock movement, reservation, audit or realtime behavior changes.
The transaction-capable Stock → Production → receipt-lane → Stock cycle remains
open for a later U11 command-unit increment. The oversized order and delivery
repositories are also outside this increment.

The historical production route regression preserves the receipt-context and
traceability HTTP/RBAC seam. The production receipt contract and realtime
producer regressions remain part of the focused verification. AST comparison
records the moved types, resolver and query bodies as unchanged; evidence is
stored outside source control with the U11 qualification output.
