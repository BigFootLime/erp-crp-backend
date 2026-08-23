import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { buildShippedDeliveryArtifactInput, renderShippedDeliveryOfficialPdf } from "./delivery-authoritative-document";

describe("#624 shipped delivery authoritative renderer", () => {
  it("renders a real PDF solely from the frozen SHIPPED snapshot", async () => {
    const bytes = await renderShippedDeliveryOfficialPdf({ archive: {
      id: "11111111-1111-4111-8111-111111111111", entityType: "bon-livraison", entityId: "22222222-2222-4222-8222-222222222222",
      documentKind: "DELIVERY_NOTE_SHIPPED", documentVersion: 1, renderVersion: "delivery-note-shipped-v1", idempotencyKey: "delivery:test:shipped:v1",
      title: "BL expédié", originalName: "bon-livraison-BL-0001-expedie.pdf", sourceRevision: "1:test", snapshotSha256: "a".repeat(64),
      pdfSha256: null, pdfSizeBytes: null, gedDocumentId: null, gedVersionId: null, archivedAt: null, createdAt: "2026-08-23T00:00:00.000Z", actorUserId: 1,
      sourceSnapshot: { type: "DELIVERY_NOTE_SHIPPED_SNAPSHOT", numero: "BL-0001", statut: "SHIPPED", client_name: "Client Démo", commande_numero: "CMD-1", affaire_reference: null, address_label: "12 rue Exemple\n75000 Paris", date_creation: "2026-08-23", date_expedition: "2026-08-23", transporteur: "CERP", tracking_number: "TRK-1", commentaire_client: "Livraison contrôlée", updated_at: "2026-08-23T00:00:00.000Z", issuer: { company_name: "CERP Historique", siret: "12345678900012" }, lines: [{ ordre: 1, designation: "Pièce A", code_piece: "A-01", quantite: 2, unite: "u", delai_client: null, lot_codes: ["LOT-01"] }] },
    } });
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);
    if (process.env.CERP_PDF_PREVIEW === "1") {
      const target = path.resolve(process.cwd(), "outputs/pdf-preview/delivery-note-shipped-624.pdf");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
  });
});

describe("#624 shipped delivery source snapshot", () => {
  it("freezes issuer legal identity in the transaction instead of letting the worker read live settings", async () => {
    const query = async (sql: string) => {
      if (sql.includes("FROM public.bon_livraison bl")) {
        return { rows: [{
          numero: "BL-0001", statut: "SHIPPED", client_name: "Client Démo", commande_numero: null,
          affaire_reference: null, address_label: null, date_creation: "2026-08-23", date_expedition: "2026-08-23",
          transporteur: null, tracking_number: null, commentaire_client: null, updated_at: "2026-08-23T10:00:00.000Z",
        }] };
      }
      if (sql.includes("FROM public.bon_livraison_ligne line")) return { rows: [] };
      if (sql.includes("to_regprocedure")) return { rows: [{ function_name: "fn_finance_issuer_snapshot(uuid,date)" }] };
      if (sql.includes("fn_finance_issuer_snapshot")) {
        return { rows: [{ party: { company_name: "CERP Historique", siret: "12345678900012", legal_mentions_version: 4 } }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    };

    const input = await buildShippedDeliveryArtifactInput(
      { query } as never,
      { deliveryId: "22222222-2222-4222-8222-222222222222", actorUserId: 7, sourceRevision: "2:correlation" }
    );

    expect(input.sourceSnapshot).toMatchObject({
      type: "DELIVERY_NOTE_SHIPPED_SNAPSHOT",
      issuer: { company_name: "CERP Historique", siret: "12345678900012", legal_mentions_version: 4 },
    });
  });
});
