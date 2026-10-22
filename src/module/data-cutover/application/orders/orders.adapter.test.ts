import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ customer: vi.fn(), supplier: vi.fn() }));
vi.mock("../../../commande-client/repository/commande-client.repository", () => ({ repoCreateCommandeCutoverDraftTx: native.customer }));
vi.mock("../../../commande-fournisseur/repository/commande-fournisseur.repository", () => ({ repoCreateCommandeFournisseurTx: native.supplier }));

import { cutoverOrdersAdapter } from "./orders.adapter";
import type { ApplicationContext } from "../application.types";
import type { CutoverRow } from "../../types/data-cutover.types";
import { createCutoverBatchSchema } from "../../validators/data-cutover.validators";
import { inspectCutoverRow } from "../../domain/cutover-validation";

const row = (domain: CutoverRow["domain"], id: string, values: CutoverRow["values"]): CutoverRow => ({
  id, batch_id: "batch", domain, legacy_key: `CLIPPER:${id}`, source_id: "source", sheet: "Orders", row_number: 1,
  source_values: values, values, source_issues: [], source_notes: [], decision: "INCLUDE", review_note: "confirmed", version: 1, status: "READY", issues: [],
});
const context = (rows: CutoverRow[]): ApplicationContext => ({
  client: {} as ApplicationContext["client"], batchId: "batch", actorId: 7, sourceSystem: "CLIPPER", correlationId: "corr", operationKey: "op", rows,
  targets: new Map([
    ["CUSTOMER:C-01", { id: "001", reference: "CRP", type: "CUSTOMER" }],
    ["SUPPLIER:F-01", { id: "11111111-1111-4111-8111-111111111111", reference: "F-01", type: "SUPPLIER" }],
    ["ARTICLE:ART-1", { id: "22222222-2222-4222-8222-222222222222", reference: "ART-1", type: "ARTICLE" }],
  ]),
});
const sales = () => row("SALES_ORDER", "sales", { customerCode: "C-01", customerOrderNumber: "PO-42", orderDate: "2026-10-20", articleReference: "ART-1", quantityRemaining: "2", unit: "u", unitPrice: "26.4", vatRate: "20", currency: "EUR", plannedDueDate: "2026-11-03", orderType: "FERME", orderEvidence: "AR-42", affairNumber: "23907" });
const supplier = () => row("SUPPLIER_ORDER", "supplier", { supplierCode: "F-01", supplierOrderNumber: "BC-42", orderDate: "2026-10-18", articleReference: "ART-1", quantityRemaining: "3", unit: "u", unitPrice: "10", vatRate: "20", currency: "EUR", plannedDueDate: "2026-11-04", priceEvidence: "BC-42" });
// An internal need is not a sale: no historical commercial price or VAT is
// required, and the adapter must not manufacture either one.
const internal = () => row("INTERNAL_DEMAND", "internal", { affairNumber: "INT-42", orderDate: "2026-10-20", articleReference: "ART-1", quantityOrdered: "1", quantityCompleted: "0", quantityRemaining: "1", unit: "u", plannedDueDate: "2026-11-05" });

describe("cutoverOrdersAdapter", () => {
  beforeEach(() => { native.customer.mockReset(); native.supplier.mockReset(); native.customer.mockResolvedValue({ id: 31, numero: "CMD-31" }); native.supplier.mockResolvedValue({ id: "supplier-31", code: "BCF-31" }); });

  it("creates customer, supplier and internal drafts through native writers with no supplier side effects", async () => {
    const applied = await cutoverOrdersAdapter.apply(context([sales(), supplier(), internal()]));
    expect(native.customer).toHaveBeenCalledTimes(2);
    expect(native.customer.mock.calls[0][1]).toMatchObject({ client_id: "001", code_client: "PO-42", save_intent: "DRAFT", total_ht: 52.8, total_ttc: 63.36 });
    expect(native.customer.mock.calls[1][1]).toMatchObject({
      order_type: "INTERNE", save_intent: "DRAFT", date_commande: "2026-10-20", total_ht: 0, total_ttc: 0,
      lignes: [expect.objectContaining({ prix_unitaire_ht: 0, taux_tva: 0 })],
    });
    expect(native.customer.mock.calls[1][1]).not.toHaveProperty("client_id");
    expect(native.supplier).toHaveBeenCalledWith(expect.objectContaining({ origine: "AUTRE", devise: "EUR" }), expect.anything(), expect.anything(), { sideEffects: "none" });
    expect(applied.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowId: "sales", domain: "SALES_ORDER", targetType: "COMMANDE_CLIENT" }),
      expect.objectContaining({ rowId: "supplier", domain: "SUPPLIER_ORDER", targetType: "COMMANDE_FOURNISSEUR" }),
      expect.objectContaining({ rowId: "internal", domain: "INTERNAL_DEMAND", targetType: "BESOIN_INTERNE" }),
    ]));
  });

  it("blocks CADRE_RELEASE and non-EUR customer orders before a native write", async () => {
    const release = row("SALES_ORDER", "release", { ...sales().values, orderType: "CADRE_RELEASE", contractTargetId: "33333333-3333-4333-8333-333333333333" });
    expect((await cutoverOrdersAdapter.inspect(context([release])))[0]?.code).toBe("CUTOVER_ORDER_CONTRACT_RELEASE_UNAVAILABLE");
    const foreign = row("SALES_ORDER", "foreign", { ...sales().values, currency: "USD" });
    expect((await cutoverOrdersAdapter.inspect(context([foreign])))[0]?.code).toBe("CUTOVER_ORDER_CURRENCY_UNSUPPORTED");
    expect(native.customer).not.toHaveBeenCalled();
  });

  it("accepts explicitly selected native targets when the historical codes differ", async () => {
    const source = sales();
    source.values = { ...source.values, customerCode: "OLD-CLIENT", articleReference: "OLD-ARTICLE", customerTargetId: "001", articleTargetId: "22222222-2222-4222-8222-222222222222" };
    const fixture = context([source]);
    fixture.targets = new Map([
      ["CUSTOMER:001", { id: "001", reference: "CLI-001", type: "CUSTOMER" }],
      ["ARTICLE:22222222-2222-4222-8222-222222222222", { id: "22222222-2222-4222-8222-222222222222", reference: "ART-NATIVE", type: "ARTICLE" }],
    ]);
    await expect(cutoverOrdersAdapter.inspect(fixture)).resolves.toEqual([]);
    await cutoverOrdersAdapter.apply(fixture);
    expect(native.customer.mock.calls[0][1]).toMatchObject({ client_id: "001", lignes: [expect.objectContaining({ article_id: "22222222-2222-4222-8222-222222222222" })] });
  });

  it("rejects an explicit target absent from the verified map and groups aliases by the real customer", async () => {
    const source = sales();
    source.values = { ...source.values, customerTargetId: "999" };
    expect((await cutoverOrdersAdapter.inspect(context([source])))[0]?.code).toBe("CUTOVER_ORDER_TARGET_UNCONFIRMED");
    expect(native.customer).not.toHaveBeenCalled();
    const first = sales(), second = sales();
    second.values = { ...second.values, customerCode: "ANOTHER-OLD-CODE" };
    const map = context([]).targets;
    map.set("CUSTOMER:ANOTHER-OLD-CODE", { id: "001", reference: "CRP", type: "CUSTOMER" });
    expect(cutoverOrdersAdapter.groupKey(first, map)).toBe(cutoverOrdersAdapter.groupKey(second, map));
  });

  it("accepts a complete internal demand without commercial fields through batch and row validation", () => {
    const values = internal().values;
    const batch = createCutoverBatchSchema.parse({
      name: "Internal demand fixture",
      source_system: "CLIPPER_EXCEL",
      sources: [{ id: "source", name: "internal.xlsx", sha256: "a".repeat(64), snapshot_at: "2026-10-20T08:00:00Z" }],
      rows: [{ domain: "INTERNAL_DEMAND", legacy_key: "CLIPPER:internal", source_id: "source", sheet: "Internal", row_number: 1, values }],
    });
    const source = batch.rows[0]!;
    const inspected = inspectCutoverRow({
      id: "00000000-0000-4000-8000-000000000001", batch_id: "00000000-0000-4000-8000-000000000002",
      domain: source.domain, legacy_key: source.legacy_key, source_id: source.source_id, sheet: source.sheet, row_number: source.row_number,
      source_values: source.values, values: source.values, source_issues: [], source_notes: [], decision: "INCLUDE", review_note: "confirmed", version: 1,
    }, { allowedUnits: ["u"] });
    expect(inspected.status).toBe("READY");
    expect(inspected.issues).toEqual([]);
  });
});

