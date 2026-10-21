# PDF module appearance - 19 October 2026

Work package: `PDF-MODULE-STYLE-20261019`. Proposed issue: Harmonize PDF appearance with ERP module colors without changing document geometry. Local branch: `feature/pdf-module-style-20261019`, based on `origin/dev` (`2ced5cc9`). Integration and deployment belong to the release coordinator; this task does not publish or migrate anything.

## Acceptance contract

- Keep every OF field, section, box position, width, height, fold mark, page break and body font metric. The user's follow-up explicitly requests softly rounded corners: new panels use a 6 pt radius within the existing bounds, while data-grid lines stay straight.
- Preserve the official CRP logo and semantic warnings/watermarks.
- Production #0f766e; Commerce #2563eb; Quality #b45309; Stock #6d28d9; Tools #c1121f; System #4b5560.
- Keep archived PDF bytes and historical OF rendering stable. New OF appearance has a new renderer version; the technical footer version is the only expected textual difference in before/after OF comparisons.
- Use isolated synthetic fixtures, render before/after, compare text/coordinates/page counts/images/vector geometry, inspect color and grayscale output.
- No business changes, database writes, authentication changes or new external dependencies.

## Exhaustive producer inventory

| Family | Producer (relative to src/) | Treatment |
| --- | --- | --- |
| OF and routing | module/production/services/of-document-render.ts | Production; new template 1.8, historical 1.2–1.7 preserved |
| Preparation / new index / improvement | module/production/services/workshop-support-paper.ts | Production; all form boxes and writing areas preserved |
| Self-inspection paper form | module/production/services/self-inspection-workshop.ts | Quality; blank handwriting columns preserved |
| Technical sheet / traveler | shared/authoritative-documents/current-technical-document-pdf.ts | Production; versioned appearance |
| Creation receipts: client, supplier, order, OF, PT, affair, stock, delivery | shared/authoritative-documents/internal-creation-snapshot-pdf.ts | Explicit entity mapping: Commerce / Production / Stock; warning remains red |
| Consolidated client profile | module/client/services/client-profile-pdf.ts | Commerce |
| Supplier PO | module/commande-fournisseur/services/commande-fournisseur-official-pdf.ts | Commerce |
| Quote | module/devis/services/devis-official-pdf.ts | Commerce |
| Customer AR | module/commande-client/services/commande-ar.service.ts | Commerce |
| BL, simple / compiled pack / shipped archive | module/livraisons/services/bon-livraison-document.ts | Commerce; same shared producer for every path |
| Certificate of conformity | module/livraisons/services/pack-pdf.service.ts | Quality |
| Invoice / credit note / deposit invoice | module/facturation/services/finance-document-render.ts | Commerce; exact issued bytes remain authoritative |
| Proforma | module/facturation/services/proforma-document.ts | Commerce; exact issued bytes remain authoritative |
| As-built dossier | module/asbuilt/services/asbuilt-pdf.service.ts | Quality; existing warning severity colors preserved |
| PT documentary dossier | module/pieces-techniques/services/piece-document-dossier-pdf.service.ts | Production; existing warning severity colors preserved |
| Payroll time recap | module/temps-deplacements/services/temps-deplacements-exports.ts | System; CSV unchanged |
| Project status | module/project-office/services/project-office-status.service.ts | System; Markdown unchanged |
| Packaging labels | module/stock/services/finished-packaging.service.ts | Preserved monochrome; dimensions and barcode quiet zones unchanged |
| Approved plans / compiled manufacturing pack | module/production/services/workshop-pack-pdf.ts | Source pages and copy marking preserved; receives new constituent PDFs |

Frontend React PDF producers, all Commerce: `modules/clients/pdf/fiche-client-pdf.tsx`, `modules/fournisseurs/pdf/fiche-fournisseur-pdf.tsx`, `modules/affaires/pdf/fiche-affaire-pdf.tsx`, `modules/commande-client/pdf/commande-client-pdf.tsx`, `modules/commande-fournisseur/pdf/bon-commande-fournisseur-pdf.tsx`, `modules/devis/pdf/devis-pdf.tsx`. They use `design-system/pdf/document-kit.tsx`; its print palette is separate from runtime UI tokens.

Identification HTML labels, stock-lot/material-bar printers and Brother raster paths remain monochrome industrial outputs. `electron/fabrication-printer.ts` prints the server PDF and has no separate document layout. There is no additional standalone generated Tools/Metrology PDF template in the searched source tree; uploaded certificates and source drawings are retained. The Tools color is available in the shared palette for a future actual producer. No new export or fictional coverage is claimed.

Existing uploaded plans/certificates, compiled PDF attachments, archived official bytes, raw thermal commands and CSV/XLSX/DOCX exports are not restyled.

## Compatibility and integration

- Keep Helvetica / Helvetica-Bold (and existing oblique) at exactly the existing sizes and spacing. Replacing them by the UI font would risk line wrapping and change positions; the explicit geometry constraint takes priority.
- OF 1.8 has the new Production palette and rounded panels. Recorded 1.7 uses the same historical read-model fields and renderer with its original colors and rectangular contours. SHA regressions cover 1.4, 1.5, 1.6 and 1.7. The only normalized text in the geometry comparison is `gabarit of-ordre-fabrication/1.8` versus `1.7` in the technical footer.
- Newly queued non-OF documents record the suffix `+style-20261019` in the existing opaque `renderVersion`. A pending historical archive without that suffix renders with the historical palette. Existing archived bytes are never overwritten. Technical-sheet/traveler validators still validate the underlying renderer version.
- Repository edits only change renderer-version constants, not SQL, quantities, validation, idempotency keys, numbering, permissions or source snapshots. Financial issuers still archive their exact emitted bytes. Replays return existing editions through the existing idempotency workflow.
- No schema migration, package-version bump, external font/dependency, secret or database write. Nothing has been pushed or deployed by this lot. Frontend and backend commits must be integrated together by the release coordinator.
- Rollback: preserve this renderer compatibility when rolling back issuance; old binaries cannot render new suffixed queued editions. Drain/pause the PDF outbox before a binary rollback or retain these renderers. Existing final PDFs remain readable independently.

## Evidence and limits

Proof root on the task host: `C:/Users/KeenanMARTIN/Documents/Github/cerp-pdf-style-20261019/proofs`.

- Initial baseline captures were generated from dev `2ced5cc9` (backend) and `edb096f5` (frontend). `backend-before/after`, `frontend-before/after`, and `reports-before/after` compare those real renderers. `archives-before/after` separately compares the retained legacy renderer against the new version using the exact same frozen synthetic snapshot.
- `geometry-comparison.json`: 169 paired captures, including 28 empty PDFKit measurement objects; **141 actual PDFs / 326 pages**, zero unexpected differences in text, font metrics, glyph coordinates, page size/count and embedded image pixels/coordinates. The requested rounded contours affect 145 pages: PDFKit panel outer bounds remain identical; React-PDF border arcs extend inward by at most 6 pt, without changing their other bounds or drawing attributes. Grid lines stay fixed. Additional after-only capture is the explicit 1.7 regression. `geometry-square-comparison.json` retains the earlier strict vector comparison before this explicit follow-up.
- `visual-review-manifest.json` and `visual/*-comparaison.png`: representative families shown before / after color / after grayscale. Titles, rounded boxes, tables and warnings inspected, including OF pages 2/5 and 5/5, dense self-inspection page 4/4 and long customer-order page 3/3. Small legal text retains its original dimensions and has stronger color contrast. The pre-existing unsupported arrow glyph in the payroll date separator is unchanged, outside this zero-text-change patch. Sample figures are existing synthetic renderer fixtures, not newly calculated business examples.
- Color contrast tests cover every category. White heading text and body text on wash exceed 7:1; secondary text on paper exceeds 4.5:1. Concurrent-render test prevents palette leakage across documents.
- Targeted rendering suite: 187 backend tests, 37 frontend PDF tests; secondary reports 6 tests; appearance/archive tests 12. Frontend typecheck, scoped ESLint and build pass. Backend build passes. Final full backend suite: **8,418 passed, 0 failed, 261 skipped** (8,679 discovered), recorded in `backend-full-tests-final.json`. The first full run exposed three assertions expecting the previous render-version constants; those assertions now require the new version. Historical-render tests remain unchanged or strengthened, and no failing test was disabled.
- These checks qualify this presentation patch on fixtures. They do not constitute the postponed full ERP business recipe, physical Brother/A4 print qualification, native APK/Electron acceptance, or a deployment.

Reproduce geometry checks with `python scripts/pdf-style-compare.py <proof-root> --rounded-corners` (pdfplumber required). Omitting the switch requires exact vector contours as well. Capture real PDFKit output with `CERP_PDF_CAPTURE=<output-directory>` and `vitest --config vitest.pdf-style.config.ts`. Replay proof fixtures use `CERP_PDF_REPLAY_PROOFS=<proof-root>`.

Local work package only; no authenticated Project Office write has been performed. The coordinator should attach this evidence to the actual delivery task. Report sections: 6, 10, 12, 13, 16.
