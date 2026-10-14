import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./proforma-source.repository", async importActual => ({ ...(await importActual<typeof import("./proforma-source.repository")>()), readProformaOrderSources: mocks.read }));
import { buildProformaPreview } from "./proforma-preview.repository";
import type { ProformaOrderSource } from "./proforma-source.repository";

const source: ProformaOrderSource = { allocation_id: 12, commande_id: "10", commande_ligne_id: "20", livraison_affaire_id: "30",
  client_id: "CUSTOMER", currency: "EUR", client_blocked: false, order_type: "FERME", affaire_status: "OUVERTE", delivery_address_id: "ADDRESS-A",
  contract_id: null, article_id: "PART", piece_technique_version_id: "VERSION", code_piece: "PART-A", designation: "Pièce recette",
  quantity: "100.000", unit: "u", unit_price_ex_tax: "10.0000", discount_percent: "0.0000", global_discount_percent: "0.0000", tax_rate_percent: "20.0000", billing_shares: [] };
const selection = { client_id: "CUSTOMER", currency: "EUR", affairs: [{ allocation_id: 12, billing_parts: [
  { billed_client_id: "COMPANY-A", quantity: "30" }, { billed_client_id: "COMPANY-B", quantity: "70" },
] }] };
const parties = ["CUSTOMER", "COMPANY-A", "COMPANY-B"].map(id => ({ snapshot: {
  client_id: id, client_code: id, company_name: id, blocked: false, billing_address: { city: "Ville recette" },
} }));
const query = vi.fn(); const tx = { query } as unknown as Pick<PoolClient, "query">;
beforeEach(() => { mocks.read.mockReset().mockResolvedValue([source]); query.mockReset().mockResolvedValue({ rows: parties }); });

describe("authoritative proforma previews", () => {
  it("calculates separate billed companies from source prices and does not persist preview data", async () => {
    const result = await buildProformaPreview(tx, selection, false);
    expect(result.company_totals).toEqual([
      { billed_client_id: "COMPANY-A", company_name: "COMPANY-A", total_ex_tax: "300.00", tax_amount: "60.00", total_incl_tax: "360.00" },
      { billed_client_id: "COMPANY-B", company_name: "COMPANY-B", total_ex_tax: "700.00", tax_amount: "140.00", total_incl_tax: "840.00" },
    ]);
    expect(query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
  });
  it("normalizes company ordering before issuing a preview hash", async () => {
    const first = await buildProformaPreview(tx, selection, false);
    const second = await buildProformaPreview(tx, { ...selection, affairs: [{ ...selection.affairs[0]!, billing_parts: [...selection.affairs[0]!.billing_parts].reverse() }] }, false);
    expect(first.preview_hash).toBe(second.preview_hash);
  });
  it("a changed source price or global discount invalidates the confirmed preview", async () => {
    const first = await buildProformaPreview(tx, selection, false);
    mocks.read.mockResolvedValue([{ ...source, global_discount_percent: "10.0000" }]);
    const changed = await buildProformaPreview(tx, selection, false);
    expect(changed.preview_hash).not.toBe(first.preview_hash);
    expect(changed.company_totals[0]?.total_incl_tax).toBe("324.00");
  });
  it("does not reinterpret EUR prices as another currency", async () => {
    await expect(buildProformaPreview(tx, { ...selection, currency: "USD" }, false)).rejects.toMatchObject({ code: "PROFORMA_ORDER_CURRENCY_MISMATCH" });
  });
  it("reveals an existing BL before draft creation", async () => {
    mocks.read.mockResolvedValue([{ ...source, has_active_delivery: true }]);
    await expect(buildProformaPreview(tx, selection, false)).rejects.toMatchObject({ code: "PROFORMA_AFFAIR_DELIVERY_EXISTS" });
  });
  it("does not create competing proformas for the same affair", async () => {
    mocks.read.mockResolvedValue([{ ...source, bound_proforma_id: "PF-OTHER", bound_proforma_status: "DRAFT" }]);
    await expect(buildProformaPreview(tx, selection, false)).rejects.toMatchObject({ code: "PROFORMA_AFFAIR_ALREADY_BOUND" });
    await expect(buildProformaPreview(tx, selection, false, "PF-OTHER")).resolves.toHaveProperty("preview_hash");
  });
  it("blocks missing or blocked billed companies", async () => {
    query.mockResolvedValueOnce({ rows: parties.slice(0, 2) });
    await expect(buildProformaPreview(tx, selection, false)).rejects.toMatchObject({ code: "PROFORMA_BILLED_COMPANY_NOT_FOUND" });
    query.mockResolvedValueOnce({ rows: parties.map(row => ({ snapshot: { ...row.snapshot, blocked: row.snapshot.client_id === "COMPANY-B" } })) });
    await expect(buildProformaPreview(tx, selection, false)).rejects.toMatchObject({ code: "PROFORMA_BILLED_COMPANY_BLOCKED" });
  });
  it("binding and stock/delivery metadata are excluded from the frozen financial preview", async () => {
    const first = await buildProformaPreview(tx, selection, false);
    mocks.read.mockResolvedValue([{ ...source, terms_version: 3, prepayment_requirement: "PROFORMA", bound_proforma_id: "OWN", bound_proforma_status: "DRAFT",
      bound_proforma_reference:"PF-2026-001",bound_proforma_source_revision:"b".repeat(64),has_active_delivery: false }]);
    const second = await buildProformaPreview(tx, selection, false, "OWN");
    expect(first.preview_hash).toBe(second.preview_hash);
    expect(second.affairs[0]!.source_snapshot).not.toHaveProperty("bound_proforma_reference");
    expect(second.affairs[0]!.source_snapshot).not.toHaveProperty("bound_proforma_source_revision");
  });
});
