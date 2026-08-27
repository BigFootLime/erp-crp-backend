import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { query: mocks.poolQuery, connect: mocks.connect },
}));

import {
  repoCreateFactureDraft,
  repoIssueFacture,
  repoListEligibleFactureSources,
  repoPreviewFacture,
} from "./facture-workflow.repository";

const previewInput = {
  client_id: "C01",
  currency: "EUR",
  sources: [{
    source_type: "DELIVERY_LINE" as const,
    source_id: "11111111-1111-4111-8111-111111111111",
    source_line_id: "22222222-2222-4222-8222-222222222222",
    quantity: "1.000",
  }],
  global_discount_percent: "0",
  due_dates: [{ due_date: "2026-09-03", label: "Échéance" }],
  regulatory: {
    billing_frame_code: "B1" as const,
    operation_category: "GOODS" as const,
    transaction_scope: "FR_PRIVATE_B2B" as const,
  },
  internal_comment: null,
  customer_text: null,
};

const actor = { userId: 7, requestId: "request-1", path: "/factures" };

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.connect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.release.mockReset();
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
});

describe("commande INTERNE non facturable", () => {
  it("exclut systématiquement les BL internes de la liste des sources", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });

    await expect(repoListEligibleFactureSources({ page: 1, pageSize: 25 })).resolves.toEqual({
      items: [], total: 0, policy_active: false,
    });

    const sourceQueries = mocks.poolQuery.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("bon_livraison"));
    expect(sourceQueries).toHaveLength(2);
    expect(sourceQueries.every((sql) => sql.includes("COALESCE(upper(cc.order_type), '') <> 'INTERNE'"))).toBe(true);
  });

  it("rend une source interne introuvable en preview puis bloque la création sans écriture", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    const preview = await repoPreviewFacture(previewInput);
    expect(preview.lines).toEqual([]);
    expect(preview.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SOURCE_NOT_FOUND", source_line_id: previewInput.sources[0].source_line_id }),
    ]));

    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("FROM public.finance_command_receipts")) return { rows: [] };
      return { rows: [] };
    });
    await expect(repoCreateFactureDraft({
      input: { ...previewInput, preview_hash: preview.preview_hash },
      actor,
      idempotencyKey: "internal-order-create-001",
    })).rejects.toMatchObject({ status: 422, code: "FACTURE_PREVIEW_BLOCKED" });

    expect(mocks.clientQuery.mock.calls.some(([sql]) => /^\s*INSERT INTO public\.facture\s*\(/.test(String(sql)))).toBe(false);
  });

  it("refuse l'émission d'un ancien brouillon directement relié à une commande interne", async () => {
    const writeDocument = vi.fn();
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("FROM public.finance_command_receipts")) return { rows: [] };
      if (query.includes("FROM public.facture") && query.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: 41,
            uuid: "33333333-3333-4333-8333-333333333333",
            statut: "APPROVED",
            row_version: 3,
            preview_hash: "a".repeat(64),
            created_by: 6,
            approved_by: 8,
            legal_entity_code: "CRP",
            draft_reference: "DFT-41",
            client_snapshot: {},
            issuer_snapshot: {},
            currency: "EUR",
            commentaires: null,
            customer_text: null,
          }],
        };
      }
      if (query.includes("upper(COALESCE(linked_commande.order_type, '')) = 'INTERNE'")) {
        return { rows: [{ blocked: true }] };
      }
      return { rows: [] };
    });

    await expect(repoIssueFacture({
      factureId: 41,
      input: { expected_version: 3, preview_hash: "a".repeat(64), confirm: true },
      actor,
      idempotencyKey: "internal-order-issue-001",
      writeDocument,
    })).rejects.toMatchObject({ status: 409, code: "INTERNAL_ORDER_NOT_BILLABLE" });

    expect(writeDocument).not.toHaveBeenCalled();
    const internalGuardSql = String(mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("upper(COALESCE(linked_commande.order_type, '')) = 'INTERNE'")
    )?.[0] ?? "");
    expect(internalGuardSql).toContain("FROM public.facture_source_allocations source");
    expect(internalGuardSql).toContain("JOIN public.bon_livraison delivery");
    expect(internalGuardSql).toContain("upper(COALESCE(commande.order_type, '')) = 'INTERNE'");
    expect(mocks.clientQuery.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT)\s/i.test(String(sql)))).toBe(false);
  });
});
