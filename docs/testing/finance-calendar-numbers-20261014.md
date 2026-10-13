# Finance dates and displayed numbers — 14 October 2026

An invoice issued at 01:10 in Paris carried the previous UTC day. Invoice preview, draft creation and invoice/credit-note issue now use the existing Europe/Paris calendar helper. Legal issuer resolution, numbering and frozen snapshots receive the same issue date. Existing issued documents are not rewritten.

Financial PDFs use existing exact-decimal presentation helpers: storage quantity12.000 prints12, rate20.0000 prints20%, significant fractional digits remain intact. No tax or total is recomputed and no frozen snapshot is changed.

Validation:136 targeted tests,7653 tests across688 files,254 tests/31 files skipped; strict build passed. The PDF is rendered and read back in tests, including significant fractional precision and unchanged source snapshot. The existing calendar tests cover summer/winter and the year boundary. A compiled draft preview at2026-10-13T23:10Z displays14/10/2026,12 and20% and was visually inspected.

No schema or API changes. VPS and HYPERBOX2 deployment require the verified fresh Test/Prod recovery point. The already issued test PDF remains immutable. Subsequent actual invoice/credit-note replay, compact document headers, paper/tablet self-inspection and the overall business recipe remain open.
