# Treatment dossiers per material origin (#1269)

The actual Test recipe generated one treatment purchase order for 20 machined pieces, split into 18 + 2 by material origin. The historical `UNIQUE(of_operation_id)` rejected the second dossier with PostgreSQL 23505. The first dossier and its custody are retained.

The additive patch removes only this operation uniqueness. A supplier line still has one immutable dossier. Creation holds the existing line/operation advisory locks; identical retries return that dossier and incompatible input gives a useful 409. Net ordered quantity excludes cancellations. Dispatch is capped both per dossier and cumulatively over all dossiers of the operation. No stock entry, implicit unit conversion, ledger rewrite or new permission is introduced.

Validation performed:

- 43 focused tests across the custody HTTP/audit, package policy, procurement and preparation suites.
- Strict backend build, generated OpenAPI inventory and production-data boundary.
- 14 real HTTP/PostgreSQL checks on an owned restored `subcontract_origin_1269` fixture: 18 + 2 creation on the same operation; concurrent retry; changed input conflict; supplier-line uniqueness; wrong origin; wrong unit; dispatch 18 + 2; cumulative over-dispatch refusal; dispatch replay; immutable custody; return quarantine gate; independent board projection.
- Migration applied twice, verify script returned three true invariants; fixture database removed. Live Test/Prod not modified by these tests.

Before live migration, preserve a verified VPS backup. Run the additive patch with the canonical migration runner and verify it in Test and Prod. Reopen the existing BCF1304 UI and create its second dossier, dispatch its actual second origin and continue physical receipt/quality. These UI acceptance steps remain pending until deployment.

Rollback restores the old uniqueness only if no operation has multiple dossiers. It refuses instead of deleting or merging real traceability rows. In practice retain this additive schema when rolling back application code after real multi-origin dossiers exist.

Separate issues: #1270 official supplier PDF remains the creation draft; #1268 paid-proforma scopes are not yet modeled. Neither is claimed fixed by #1269.
