# Direct grouped physical-bar receipt (#1250)

Expected supplier lines now propose physical geometry from the existing purchase
conversion/article. The grouped command accepts measured groups per supplier lot
and validates all portions before creating official receipt lines. It passes the
groups to the canonical stock receipt transaction; no alternate stock ledger is
introduced and no migration is added.

Direct standard stock managed in mm requires geometry when the article is marked
as a bar to cut. Quality-pending receipts remain physical intake first; geometry
belongs to the later accepted stock step. Conflicting global/per-portion groups
and geometry on non-stock/deferred lines are rejected explicitly.

Validation: seven new boundary cases plus 22 existing bar-receipt cases pass.
TypeScript passes. Full PostgreSQL qualification is opt-in on an isolated migrated
database: missing groups roll back official lines; two supplier lots retain 3000 mm
versus two 1500 mm bars; replay must create neither duplicate receipt nor stock.
The actual outcome and evidence are recorded in the external recipe journal.

Coordinated release: web #1511, Android #30 and preceding physical-bar migrations
#1246/#1248. No live database writes were used for this code validation.
