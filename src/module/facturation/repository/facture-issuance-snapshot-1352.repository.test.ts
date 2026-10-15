import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  archive: vi.fn(),
  advanceClearing: vi.fn(),
  acquireReceipt: vi.fn(),
  allocateLegalNumber: vi.fn(),
  requireIssuer: vi.fn(),
  insertEvent: vi.fn(),
  insertOutbox: vi.fn(),
  insertAudit: vi.fn(),
  saveReceipt: vi.fn(),
  listIssuedCommandes: vi.fn(),
  syncCommande: vi.fn(),
  readAffairs: vi.fn(),
  readUrgencyCharges: vi.fn(),
  readDepositSources: vi.fn(),
  readPrepaymentReceipts: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect },
}));
vi.mock("../../../shared/authoritative-documents/authoritative-document.repository", () => ({
  repoQueueAuthoritativePdf: mocks.archive,
}));
vi.mock("./advance-clearing.repository", () => ({
  freezeAdvanceClearing: mocks.advanceClearing,
}));
vi.mock("./workflow.repository.shared", () => ({
  acquireFinanceIdempotency: mocks.acquireReceipt,
  allocateLegalNumber: mocks.allocateLegalNumber,
  requireFinanceIssuerSnapshotAt: mocks.requireIssuer,
  insertFinanceEvent: mocks.insertEvent,
  insertFinanceOutbox: mocks.insertOutbox,
  insertGlobalFinanceAudit: mocks.insertAudit,
  saveFinanceReceipt: mocks.saveReceipt,
  newCorrelationId: () => "11111111-1111-4111-8111-111111111111",
}));
vi.mock("../../commande-client/repository/commande-fulfillment.repository", () => ({
  listIssuedInvoiceCommandeIds: mocks.listIssuedCommandes,
  syncCommandeAfterInvoiceIssue: mocks.syncCommande,
}));
vi.mock("./proforma-final-invoice.repository", () => ({
  bindProformaFinalInvoiceSourceTx: vi.fn(),
  proformaBilledPartySourceWhere: vi.fn(() => "FALSE"),
  readProformaFinalInvoiceAffairs: mocks.readAffairs,
}));
vi.mock("./facture-urgency-charges.repository", () => ({
  bindInvoiceUrgencyChargeTx: vi.fn(),
  readInvoiceUrgencyChargesTx: mocks.readUrgencyCharges,
}));
vi.mock("./proforma-deposit-invoice.repository", () => ({
  bindProformaDepositInvoiceSourceTx: vi.fn(),
  buildProformaDepositInvoiceLine: vi.fn(),
  readProformaDepositInvoiceSources: mocks.readDepositSources,
}));
vi.mock("./final-invoice-prepayments.repository", () => ({
  bindFinalInvoicePrepayments: vi.fn(),
  readFinalInvoicePrepaymentReceipts: mocks.readPrepaymentReceipts,
}));

import {
  repoIssueFacture,
  repoPreviewFacture,
} from "./facture-workflow.repository";

const actor = { userId: 7, requestId: "request-1352", path: "/factures/workflow/1/issue" };
const input = {
  client_id: "CLIENT-1352",
  currency: "EUR",
  sources: [],
  global_discount_percent: "0",
  due_dates: [{ due_date: "2026-10-15", label: "Échéance" }],
  regulatory: {
    billing_frame_code: "B1" as const,
    operation_category: "GOODS" as const,
    transaction_scope: "FR_PRIVATE_B2B" as const,
  },
  internal_comment: null,
  customer_text: null,
};

function queryResult(sql: unknown) {
  const query = String(sql);
  if (query.includes("FROM public.finance_billing_policies")) {
    return { rows: [{ policy_version: "policy-1352", legal_entity_code: "CRP", eligible_delivery_statuses: ["SHIPPED"], require_distinct_issuer: false, active: true }] };
  }
  if (query.includes("buyer_siren") && query.includes("FROM public.clients c")) {
    return { rows: [{
      buyer_siren: "123456789",
      buyer_electronic_address: { scheme: "0002", value: "buyer-1352", verified_at: "2026-10-01T00:00:00.000Z" },
      seller_electronic_address: { scheme: "0002", value: "seller-1352", verified_at: "2026-10-01T00:00:00.000Z" },
      delivery_address: null,
    }] };
  }
  if (query.includes("FROM public.facture") && query.includes("FOR UPDATE")) {
    return { rows: [{ id: 1, uuid: "22222222-2222-4222-8222-222222222222", statut: "APPROVED", row_version: 3, preview_hash: currentPreviewHash, created_by: 7, approved_by: 7, legal_entity_code: "CRP", draft_reference: "DFT-1352", client_snapshot: { company_name: "Client" }, issuer_snapshot: { company_name: "Issuer" }, currency: "EUR", commentaires: null, customer_text: null }] };
  }
  if (query.includes("SELECT client_id, currency, remise_globale")) {
    return { rows: [{ client_id: input.client_id, currency: input.currency, remise_globale: input.global_discount_percent, commentaires: null, customer_text: null, billing_frame_code: "B1", operation_category: "GOODS", transaction_scope: "FR_PRIVATE_B2B" }] };
  }
  if (query.includes("FROM public.facture_source_allocations") && query.includes("ORDER BY facture_ligne_id, id")) return { rows: [] };
  if (query.includes("FROM public.facture_echeance")) return { rows: [{ due_date: "2026-10-15", amount: "0.00", label: "Échéance", amount_autofilled: true }] };
  if (query.includes("FROM public.facture_source_allocations source") && query.includes("source_type = 'DELIVERY_LINE'")) return { rows: [] };
  if (query.includes("UPDATE public.facture\n        SET numero")) return { rows: [{ row_version: 4 }] };
  return { rows: [] };
}

let currentPreviewHash = "";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  mocks.clientQuery.mockImplementation(async (sql: unknown) => queryResult(sql));
  mocks.acquireReceipt.mockResolvedValue({ idempotencyKey: "issue-1352", requestHash: "a".repeat(64), replay: null });
  mocks.allocateLegalNumber.mockResolvedValue({ legalNumber: "F-1352", periodKey: "2026", sequenceValue: 1 });
  mocks.requireIssuer.mockResolvedValue({ company_name: "Issuer", siren: "123456789", vat_number: "FR00123456789", address_line_1: "1 rue Test", postal_code: "69001", city: "Lyon", country: "FR", legal_form: "SAS", rcs_city: "Lyon", capital_amount: "1.00", late_penalty_rate: "1.00", recovery_fee_amount: "40.00" });
  mocks.listIssuedCommandes.mockResolvedValue([]);
  mocks.readAffairs.mockResolvedValue([]);
  mocks.readUrgencyCharges.mockResolvedValue([]);
  mocks.readDepositSources.mockResolvedValue([]);
  mocks.readPrepaymentReceipts.mockResolvedValue([]);
  mocks.archive.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" });
});

async function issueWithAdvanceClearing(value: unknown) {
  mocks.advanceClearing.mockResolvedValue(value);
  const preview = await repoPreviewFacture(input);
  currentPreviewHash = preview.preview_hash;
  const pdfBytes = Buffer.from("%PDF-1.7\\nEOF");
  const result = await repoIssueFacture({
    factureId: 1,
    input: { expected_version: 3, preview_hash: preview.preview_hash, confirm: true },
    actor,
    idempotencyKey: "issue-1352",
    writeDocument: vi.fn().mockResolvedValue({
      documentId: "44444444-4444-4444-8444-444444444444",
      fileName: "Facture_F-1352_v1.pdf",
      checksumSha256: "b".repeat(64),
      fileSizeBytes: 12,
      pdfBytes,
      cleanup: vi.fn(),
    }),
  });
  return {
    snapshot: mocks.archive.mock.calls.at(-1)?.[1]?.sourceSnapshot as Record<string, unknown>,
    result,
    pdfBytes,
  };
}

describe("#1352 issued invoice JSON snapshots", () => {
  it("archives an invoice without an advance clearing property when no payment exists", async () => {
    const { snapshot, result, pdfBytes } = await issueWithAdvanceClearing(undefined);

    expect(mocks.archive).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toHaveProperty("advance_clearing");
    expect(mocks.archive.mock.calls[0]?.[1]).toMatchObject({ exactPdfBytes: pdfBytes });
    expect(result).toMatchObject({ legal_number: "F-1352" });
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).trim() === "COMMIT")).toBe(true);
  });

  it("preserves a frozen advance clearing snapshot in the canonical archive", async () => {
    const advanceClearing = { version: 1, amount_incl_tax: "10.00", entries: [{ deposit_invoice_id: 9, tax_rate: "20.00", amount_ex_tax: "8.33", tax_amount: "1.67", amount_incl_tax: "10.00" }] };
    const { snapshot } = await issueWithAdvanceClearing(advanceClearing);

    expect(mocks.archive).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({ advance_clearing: advanceClearing });
  });
});
