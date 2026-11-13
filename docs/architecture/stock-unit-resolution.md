# Stock unit resolution

`src/shared/stock-unit.repository.ts` owns article-unit lookup and canonical
`public.units` lookup. It accepts the caller's query client and never opens,
commits or rolls back a transaction. It has no dependency on a domain repository.
`src/shared/stock-unit.ts` remains the spelling/case adapter; it does not convert quantities.

The existing repository exports retain each caller's policy:

| Caller | Missing article unit | Unknown unit | Return value |
|---|---|---|---|
| Stock | Default `u` | 400 `UNKNOWN_UNIT`, submitted trimmed code in message | Unit ID |
| Deliveries | Default `u` | 400 `UNKNOWN_UNIT`, canonical code in message | Unit ID |
| Quality | Default `u` | 400 `UNKNOWN_UNIT`, canonical code in message | Unit ID |
| Production receipts | 422 `UNIT_REQUIRED` | 422 `UNIT_NOT_FOUND` | Unit ID and canonical code |

A supplied nonblank unit skips article lookup. Production preserves its
`LIMIT 1` article query; the other callers retain their existing query shape.
All lookups use the same supplied transaction client and propagate its errors.
`assertCanonicalArticleUnit` reuses the shared canonical lookup while retaining
its separate article-validation error contract.

The four-caller matrix in `src/__tests__/stock-unit-resolvers.test.ts` covers
historical aliases, preferred/numeric units, missing/null/blank article units,
query order, exact error messages and query failures. Existing posting,
reservation, valuation, quality, audit, outbox and transaction boundaries stay
in their domain repositories.
