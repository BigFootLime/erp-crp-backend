import { describe, expect, it, vi } from "vitest";
import { svcRenderAsbuiltPdf } from "../module/asbuilt/services/asbuilt-pdf.service";
import { renderPieceDocumentDossierPdf } from "../module/pieces-techniques/services/piece-document-dossier-pdf.service";
import { buildPayrollPdf } from "../module/temps-deplacements/services/temps-deplacements-exports";
import { statusReportToPdf } from "../module/project-office/services/project-office-status.service";

vi.mock("../config/database", () => ({ default: {
  query: () => { throw new Error("PDF fixtures must not access a database"); },
  connect: () => { throw new Error("PDF fixtures must not access a database"); },
} }));

const at = new Date("2026-10-19T10:00:00.000Z");
function pdf(bytes: Buffer, multiPage = false) {
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(1000);
  if (multiPage) expect((bytes.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
}

describe("Secondary PDF families / immutable layout fixtures", () => {
  it.each([1, 30])("as-built with %i linked OFs and coverage warnings", async count => {
    const preview = {
      lot: { lot_code: "LOT-STYLE-001", article_code: "PT-STYLE-001", article_designation: "Bague de démonstration", supplier_lot_code: null },
      ofs: Array.from({ length: count }, (_, i) => ({ numero: `OF-STYLE-${i + 1}`, statut: "TERMINE", piece_code: count > 1 ? "PT-STYLE-001 — Bague de démonstration avec définition technique figée et suivi des pièces usinées" : "PT-STYLE-001" })),
      bon_livraisons: [{ numero: "BL-STYLE-001", statut: "SHIPPED", reception_date_signature: null }],
      non_conformities: [], pack_versions: [],
      checks: { open_non_conformities: 0, overdue_non_conformities: 0 },
      coverage_warnings: [{ level: "danger", message: "Certificat fictif manquant." }, { level: "warning", message: "Périmètre de démonstration." }],
    } as Parameters<typeof svcRenderAsbuiltPdf>[0]["preview"];
    pdf(await svcRenderAsbuiltPdf({ preview, version: 1, generatedAt: at, signataireLabel: "Recette PDF", commentaire: null }), count > 1);
  });
  it.each([1, 20])("technical documentary dossier with %i slots", async count => {
    const dossier = {
      generated_at: at.toISOString(),
      piece: { code_piece: "PT-STYLE-001", designation: "Bague de démonstration", client_id: null, piece_critique: false },
      version: { indice: "A", statut: "PUBLIE", requirements_frozen_at: at.toISOString() },
      policy: { label: "Pièce standard", value: "STANDARD", frozen: true, diverged_from_client: true },
      policy_infrastructure_ready: true, not_required_reason: null,
      summary: { required_total: count, present_total: count, missing_total: 0, obsolete_total: 0, complete: true },
      slots: Array.from({ length: count }, (_, i) => ({ state: "PRESENT", document_type_label: `Plan de démonstration ${i + 1}`, required: true,
        state_detail: "Document applicable", reason_label: null,
        document: { original_name: `plan-style-${i + 1}.pdf`, mime_type: "application/pdf", created_at: at.toISOString() } })),
    } as unknown as Parameters<typeof renderPieceDocumentDossierPdf>[0]["dossier"];
    pdf(await renderPieceDocumentDossierPdf({ dossier, generatedBy: "Recette PDF", generatedAt: at }), count > 1);
  });
  it("payroll recap with two pages", async () => {
    pdf(await buildPayrollPdf({ periodStart: "2026-10-01", periodEnd: "2026-10-31" }, Array.from({ length: 60 }, (_, i) => ({
      matricule: `DEMO-${i + 1}`, name: "Démonstration", surname: "PDF", week_start: "2026-10-05", week_end: "2026-10-11",
      worked_minutes: 2400, contract_minutes: 2100, overtime_25_minutes: 300, overtime_50_minutes: 0, absence_minutes: 0,
    }))), true);
  });
  it("project status with empty and populated sections", async () => {
    const report = {
      generated_at: at.toISOString(), project: { name: "Démonstration PDF", code: "PDF-STYLE", status: "ACTIVE" }, health: "GREEN",
      stats: { wp_total: 3, wp_open: 2, wp_late: 1, wp_blocked: 0, wp_done: 1, risks_open: 0, actions_open: 1 },
      late_work_packages: [{ code: "WP-01", title: "Vérifier les impressions", due_date: "2026-10-18" }],
      milestones: [{ name: "Validation des documents", due_date: "2026-10-20", status: "PLANNED" }],
      risks_open: [], actions_open: [{ title: "Comparer les coordonnées", source_type: "AUDIT", status: "OPEN" }], recent_activity: [],
    } as unknown as Parameters<typeof statusReportToPdf>[0];
    pdf(await statusReportToPdf(report));
  });
});
