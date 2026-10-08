# ADR 1004 — Documented opening values

Status: incremental backend implementation. The Stock projector remains PREPARED.

Opening quantities were frozen at capture boundary #977. Existing catalogue prices, a recent purchase order or current stock quantities cannot reconstruct their historical value. The previous initialisation deliberately kept any nonzero opening value unknown.

Stock now owns immutable `stock_valuation_opening_bases`. A financial approver declares a total EUR value, selects an active document already attached to the article and confirms the exact candidate and document hashes. Quantity, company ownership, unit and currency are supplied from frozen observations. Amount is the sole monetary input; this explicit approval is always DECLARED, never automatically VERIFIED. The amount is not extracted or inferred from the document contents.

The SQL candidate checks every bounded observation for the article: SHA, identity, unit spelling, quantity precision, depreciation, child/level links, company/client partition and unexplained remainders. LEVEL includes BATCH; client quantities are subtracted once. Negative, empty, excessive or broken quantities cannot receive an opening basis. Reservations do not reduce stock value. No unit conversion or FX is performed.

The approval transaction locks the projector control before the document; the database insertion guard obtains the same control lock. Approval is allowed only while PREPARED, uninitialised, sequence zero, and before any entry for the article. The request UUID and actor-bound hash make exact retries idempotent. A unique scope prevents conflicting duplicate approvals. Document rows/link are locked and their SHA retained with the actor and amount in the immutable proof. The proof contains no storage path.

During a future explicitly approved activation, the existing Stock opening writer can use a matching base in the same transaction as its opening entry and balance. Its original prohibition on caller-supplied opening prices remains. The SQL entry guard retains all existing checks and admits only a company DECLARED opening whose exact quantity, value, unit, currency, opening identifiers and SHA match the preserved basis. Missing or invalid bases retain UNKNOWN. Client-owned stock never consumes a company base. A projected opening requires a separate financial correction; it cannot be overwritten.

No activation endpoint, replay, real value approval, catalogue rewrite or physical Stock mutation is part of this increment. User-facing Stock/Margins views and late financial corrections remain subsequent work. Existing documents may be archived later; the declaration retains the document ID/hash and its captured name. The declaration remains a human approval, not a verified accounting source.

Validation: strict TypeScript/OpenAPI build and actual DDL + nine PREPARE/EXPLAIN queries in ROLLBACK on Test and Production. The first build caught an inferred proof-union typing error, fixed before promotion. Prepared adapter/validator fixtures and the PostgreSQL recipe are NOT RUN, per the requested final combined acceptance. These mocked fixtures do not prove database guards, rollback or concurrency.
