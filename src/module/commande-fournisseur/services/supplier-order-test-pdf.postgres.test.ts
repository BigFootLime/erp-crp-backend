import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import { queueFrozenCommercialPdfArchive, readOfficialPdfBytes } from "../../../shared/authoritative-documents/authoritative-document.service";
import type { AuditContext } from "../repository/commande-fournisseur.repository";
import { canResumeSupplierOrderTestPdf, resumeSupplierOrderTestPdf } from "./supplier-order-test-pdf.service";

const isolated = process.env.CERP_BCF_PDF_PG_TEST === "1" &&
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.DATABASE_URL === "postgresql://postgres@127.0.0.1:50325/cerp_test";

describe("Supplier order PDF recovery boundary", () => {
  it("allows only the common Test runtime with workers off and explicit test routing", () => {
    const env = { CERP_COMPANY_ENVIRONMENT: "cerp_test", CERP_BACKGROUND_WORKERS: "off", CERP_EMAIL_TEST_MODE: "1" };
    expect(canResumeSupplierOrderTestPdf(env)).toBe(true);
    expect(canResumeSupplierOrderTestPdf({ ...env, CERP_BACKGROUND_WORKERS: "leader" })).toBe(false);
    expect(canResumeSupplierOrderTestPdf({ ...env, CERP_COMPANY_ENVIRONMENT: "cerp_test_demo" })).toBe(false);
    expect(canResumeSupplierOrderTestPdf({ ...env, CERP_COMPANY_ENVIRONMENT: "cerp_prod" })).toBe(false);
    expect(canResumeSupplierOrderTestPdf({ ...env, CERP_EMAIL_TEST_MODE: "" })).toBe(false);
  });
});

describe.runIf(isolated)("Current supplier order PDF in PostgreSQL", () => {
  afterAll(() => pool.end());
  it("claims and renders only the approved edition, replays safely, and leaves dispatch untouched", async () => {
    const supplier = randomUUID();
    const order = randomUUID();
    const freeze = randomUUID();
    await pool.query("INSERT INTO public.fournisseurs(id,code,nom) VALUES($1,$2,'Fournisseur de recette')",
      [supplier, `T-${supplier.slice(0, 8)}`]);
    await pool.query("INSERT INTO public.commande_fournisseur(id,code,fournisseur_id,statut,version_document) VALUES($1,$2,$3,'APPROUVEE',1)",
      [order, `BCF-${order}`, supplier]);
    await pool.query("INSERT INTO public.commande_fournisseur_document(id,commande_id,version,titre,payload,sha256) VALUES($1,$2,1,'Recette','{}',$3)",
      [freeze, order, createHash("sha256").update("{}").digest("hex")]);

    const queue = (documentVersion: number, frozen: string) => queueFrozenCommercialPdfArchive(pool, {
      entityType: "commande-fournisseur", entityId: order, documentKind: "SUPPLIER_PURCHASE_ORDER",
      documentVersion, renderVersion: "supplier-po-pdf-v1", idempotencyKey: randomUUID(), title: "Bon de recette",
      originalName: `bcf-test-v${documentVersion}.pdf`, sourceRevision: `fixture-${documentVersion}`, actorUserId: null,
      sourceSnapshot: {
        type: "SUPPLIER_PURCHASE_ORDER", code: "BCF-RECETTE", status: "APPROUVEE", issued_at: "2026-11-27",
        supplier: { name: "Fournisseur de recette", code: "FOU-RECETTE" }, issuer: { name: "Atelier de recette" },
        currency: "EUR", totals: { total_ht: "0", total_discount: "0", total_vat: "0", freight_ht: "0", total_ttc: "0" },
        lines: [], general_terms: null, frozen_document: { id: frozen, version: 1 },
      },
    });
    const older = await queue(1, randomUUID());
    const audit = { user_id: 1, role: "Directeur" } as AuditContext;
    await expect(resumeSupplierOrderTestPdf(order, audit)).rejects.toMatchObject({ code: "SUPPLIER_EMAIL_CURRENT_PDF_NOT_FOUND" });
    const current = await queue(2, freeze);
    await expect(resumeSupplierOrderTestPdf(order, { ...audit, role: "Employee" }))
      .rejects.toMatchObject({ code: "FORBIDDEN_TRANSITION" });
    expect(await Promise.all([resumeSupplierOrderTestPdf(order, audit), resumeSupplierOrderTestPdf(order, audit)]))
      .toEqual([{ started: true }, { started: false }]);
    const read = () => pool.query<{ status: string; attempt_count: number; archive_id: string }>(
      "SELECT status,attempt_count,archive_id::text FROM public.authoritative_pdf_archive_outbox WHERE archive_id=ANY($1::uuid[]) ORDER BY archive_id=$2::uuid DESC",
      [[current.id, older.id], current.id],
    ).then(result => result.rows);
    await expect.poll(read, { timeout: 8_000 }).toEqual([
      { archive_id: current.id, status: "ARCHIVED", attempt_count: 1 },
      { archive_id: older.id, status: "PENDING", attempt_count: 0 },
    ]);
    expect(await resumeSupplierOrderTestPdf(order, audit)).toEqual({ started: false });
    expect((await pool.query("SELECT 1 FROM public.authoritative_pdf_archives WHERE entity_id=$1", [order])).rowCount).toBe(2);
    expect((await pool.query("SELECT 1 FROM public.supplier_order_email_dispatch WHERE order_id=$1", [order])).rowCount).toBe(0);
    const pdf = await readOfficialPdfBytes({ entityType: "commande-fournisseur", entityId: order,
      documentKind: "SUPPLIER_PURCHASE_ORDER", archiveId: current.id, actorUserId: null, eventType: "AUTHORITATIVE_PDF_PREVIEWED" });
    expect(pdf.bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(createHash("sha256").update(pdf.bytes).digest("hex")).toBe(pdf.sha256);
  });
});
