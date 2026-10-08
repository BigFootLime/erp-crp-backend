# ADR-0962 — Assembly component cost sources

Assembly component withdrawals must not be valued as generic raw material.
The canonical #956 intake and #959 return now provide their own stock receipts,
physical movements and paired consumption/compensation records.

The ACTUAL and UPDATED margin readers load one source per posted component
issue line, in the existing PURCHASE category. The key remains
`stock-consumption:<line-id>` so a source cannot be duplicated by changing its
classification. Generic raw material excludes these same component movements.
The public financial formula and waterfall remain unchanged.

Valuation requires a unique matching child stock command, its parent assembly
intake, reservation, component requirement, frozen version, unit and exact
physical consumption proof. Each partial issue is independent of the mutable
latest-movement pointer. Parent/child actor and command keys must also agree.
An absent or incoherent proof stays visible with UNKNOWN reliability and null
amount. Noncanonical component scrap is also visible as unknown, never silently
dropped. A compensated original and its inverse contribute no component cost.

A physically proven issue with an applied nonnegative price has DECLARED
reliability and quantity × applied price. An absent or negative price remains
null. The reader never substitutes a supplier quote, current catalogue price,
estimated child OF margin or zero. This is not verified CUMP: the materialized
stock valuation ledger remains outstanding under ADR-0061.

Build/TypeScript/OpenAPI and two real PostgreSQL application-role plans are
checked before release. Business regression fixtures use temporary tables and
rollback only; they are prepared and deferred to final combined acceptance as
requested by the human on 7 October 2026. No schema or permissions change.
