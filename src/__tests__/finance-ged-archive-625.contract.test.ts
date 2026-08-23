import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { queueCreationPdfArchive } from "../shared/authoritative-documents/authoritative-document.service";

const root = process.cwd();
const factureWriter = fs.readFileSync(path.join(root, "src/module/facturation/services/finance-document.service.ts"), "utf8");
const avoirWriter = fs.readFileSync(path.join(root, "src/module/facturation/services/avoir-document.service.ts"), "utf8");
const factureIssue = fs.readFileSync(path.join(root, "src/module/facturation/repository/facture-workflow.repository.ts"), "utf8");
const avoirIssue = fs.readFileSync(path.join(root, "src/module/facturation/repository/avoir-workflow.repository.ts"), "utf8");
const factureController = fs.readFileSync(path.join(root, "src/module/facturation/controllers/factures.controller.ts"), "utf8");
const avoirController = fs.readFileSync(path.join(root, "src/module/facturation/controllers/avoirs.controller.ts"), "utf8");
const legalArchiveService = fs.readFileSync(path.join(root, "src/module/facturation/services/finance-legal-archive.service.ts"), "utf8");
const patch = fs.readFileSync(path.join(root, "db/patches/20260823_finance_ged_archive_625.sql"), "utf8");

describe("#625 finance legal GED bridge", () => {
  it("makes both legal writers hand the exact rendered Buffer to the transactional archive intent", () => {
    for (const source of [factureWriter, avoirWriter]) {
      expect(source).toContain("pdfBytes: Buffer.from(pdf)");
      expect(source).toContain('createHash("sha256").update(pdf).digest("hex")');
    }
    for (const source of [factureIssue, avoirIssue]) {
      expect(source).toContain("queueCreationPdfArchive(client");
      expect(source).toContain("exactPdfBytes: artifact.pdfBytes");
      expect(source).toContain("authoritative_archive_id: legalArchive.id");
    }
  });

  it("persists the byte payload and immutable checksum as one idempotent request under a concurrency replay", async () => {
    const pdf = Buffer.from("%PDF-1.7\nexact-issued-finance-bytes\n%%EOF");
    const sha = crypto.createHash("sha256").update(pdf).digest("hex");
    const snapshotSha = crypto.createHash("sha256").update('{"legal_number":"F-1"}').digest("hex");
    const stored = {
      id: "11111111-1111-4111-8111-111111111111", entity_type: "facture", entity_id: "f-1", document_kind: "FINANCE_INVOICE_LEGAL_PDF",
      document_version: 1, render_version: "finance-legal-issued-v1", idempotency_key: "finance:facture:f-1:legal:F-1:v1", title: "Facture légale F-1", original_name: "Facture_F-1_v1.pdf",
      source_snapshot: { legal_number: "F-1" }, source_revision: `F-1:${sha}`, snapshot_sha256: snapshotSha,
      exact_pdf_bytes: pdf, exact_pdf_sha256: sha, exact_pdf_size_bytes: String(pdf.byteLength), pdf_sha256: null, pdf_size_bytes: null,
      ged_document_id: null, ged_version_id: null, archived_at: null, created_at: "2026-08-23T00:00:00.000Z", created_by: 7,
    };
    let inserted = false;
    const tx = { query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO public.authoritative_pdf_archives")) { if (!inserted) { inserted = true; return { rows: [stored] }; } return { rows: [] }; }
      if (sql.includes("SELECT") && sql.includes("idempotency_key")) return { rows: [stored] };
      return { rows: [] };
    }) };
    const request = { entityType: "facture", entityId: "f-1", documentKind: "FINANCE_INVOICE_LEGAL_PDF", documentVersion: 1, renderVersion: "finance-legal-issued-v1", idempotencyKey: "finance:facture:f-1:legal:F-1:v1", title: "Facture légale F-1", originalName: "Facture_F-1_v1.pdf", sourceRevision: `F-1:${sha}`, sourceSnapshot: { legal_number: "F-1" }, exactPdfBytes: pdf, actorUserId: 7 } as const;
    const [first, replay] = await Promise.all([queueCreationPdfArchive(tx, request), queueCreationPdfArchive(tx, request)]);
    expect(first.id).toBe(replay.id);
    expect(first.exactPdfSha256).toBe(sha);
    expect(Buffer.from(first.exactPdfBytes ?? []).equals(pdf)).toBe(true);
    expect(tx.query.mock.calls.filter(([sql]) => String(sql).includes("authoritative_pdf_archive_outbox"))).toHaveLength(2);
  });

  it("makes the migration retain the bytes, size/checksum pair and immutable source identity", () => {
    expect(patch).toContain("exact_pdf_bytes bytea");
    expect(patch).toContain("exact_pdf_sha256");
    expect(patch).toContain("exact_pdf_size_bytes");
    expect(patch).toContain("exact_pdf_size_bytes = octet_length(exact_pdf_bytes)");
    expect(patch).toContain("NEW.exact_pdf_bytes IS DISTINCT FROM OLD.exact_pdf_bytes");
    expect(patch).toContain("FINANCE_GED_ARCHIVE_612_PREREQUISITE_MISSING");
  });

  it("prevents the legacy legal PDF readers from regenerating an issued document", () => {
    for (const source of [factureController, avoirController]) {
      expect(source).toContain('readLatestFinanceLegalArchive');
      expect(source).toContain('statut === "ISSUED"');
    }
    expect(legalArchiveService).toContain('OFFICIAL_DOCUMENT_NOT_READY');
  });
});
