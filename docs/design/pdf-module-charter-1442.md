# PDF222 — Shared module document charter

All newly generated ERP data PDFs use the OF / Client document grammar: official CRP logo, a clear title and reference, Inter Regular/Bold embedded in the file, measured sections and tables, repeated identity on continuation pages, reserved legal footer and page count. Status flags and watermarks remain semantic, independent of the module accent.

| Module | Accent |
|---|---|
| Commerce (including finance and deliveries) | `#2563EB` |
| Production / technical pieces | `#0F766E` |
| Quality / as-built | `#B45309` |
| Stock | `#6D28D9` |
| Tools | `#C1121F` |
| System / project office / payroll export | `#4B5560` |

## Inventory and implementation

`shared/pdf/cerp-document.ts` is the common PDFKit engine. Explicit module identities cover Client profiles, quotations, customer ARs, supplier orders, invoices/credit notes, proformas, delivery notes, delivery packs, current technical sheets, OFs, workshop support sheets and self-inspection supports. Internal creation snapshots use the archive entity's module through `document-theme.ts`.

Previously separate PDFKit writers now use `raw-document-body.ts`: technical document dossiers, as-built dossiers and Project Office reports. Payroll PDFs use the common table engine. Finished packaging labels embed Inter and carry the Stock accent while retaining their 283.46 × 170.08 pt physical dimensions and QR contents.

The workshop pack assembler imports approved source plans and existing PDF pages. It preserves source drawings, their geometry and original content; it does not restyle external documents. Its copy-control overlays and existing watermark policy remain active. Original files uploaded to the GED are likewise outside the generated-data styling policy.

The frontend `design-system/pdf/document-kit.tsx` covers all six local React PDF templates: Client, Supplier, quotation, customer order, supplier order and business case. Inter assets are bundled locally, with conservative actual font widths for long tokens. Electron and Android consume the same generated documents; they do not have separate PDF templates.

## Immutable archives and renderer identity

New queued render jobs store the explicit `+module-v1` presentation suffix in `render_version`. Producers still receive their supported base renderer version. AsyncLocalStorage isolates the selected presentation across concurrent jobs. Historic queued/failed jobs without this suffix retain their previous presentation. Existing archived bytes, snapshots, hashes and GED links are never rewritten.

An old idempotency key returns its accepted old archive. Comparing base renderer versions permits this replay across the presentation rollout, while a real renderer version difference or changed snapshot/source still conflicts. Exact-byte archives do not receive the suffix: their supplied bytes are authoritative. New finance issuance uses `finance-legal-issued-v2`; existing invoices and credit notes are not reissued for appearance.

New OF payloads carry `documentCharter: module-v1`, included in the snapshot identity. Historical payloads without it retain their original font and layout. The OF business template version remains independent of this presentation identity.

New technical sheet snapshots resolve `clients.client_code` through the relation, instead of printing the internal client key. The internal version UUID remains available for traceability in the source identity but is not a displayed business field.

A requested presentation reissue creates an explicit new archive edition with a reason and a new idempotency key. A creation receipt's original factual snapshot is retained in a presentation edition; it must never be reconstructed from current mutable entity data. The original receipt remains accessible.

## Verification

- Targeted archive, renderer, OF, worker and as-built tests: 73 passed, including concurrent presentation isolation, legacy rendering and idempotent replay.
- Real server and headless Chromium React PDF renderings: embedded Inter confirmed, A4 geometry, six module colors, long tables, continuation pages and draft watermarks inspected.
- Frontend format/logo tests, TypeScript checks, targeted ESLint and production data boundaries validated.
- Local operation evidence: PDF222. Project Office API authentication was unavailable; no server task update is claimed.

Coordinated read-only with the user-designated Audit ISO/RGPD and Refont chats. No approval, antivirus, authorization, financial calculation or business status rule is relaxed by this presentation change.
