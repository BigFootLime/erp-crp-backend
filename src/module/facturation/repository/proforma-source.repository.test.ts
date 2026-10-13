import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertProformaOrderSource, proformaOrderSourceRevision, readProformaOrderSources, type ProformaOrderSource } from "./proforma-source.repository";

const source: ProformaOrderSource = { allocation_id: 12, commande_id: "10", commande_ligne_id: "20", livraison_affaire_id: "30",
  client_id: "CUSTOMER-A", client_blocked: false, order_type: "FERME", affaire_status: "OUVERTE", delivery_address_id: "ADDRESS-A", contract_id: null,
  article_id: "ARTICLE-A", piece_technique_version_id: "VERSION-A", code_piece: "PART-A", designation: "Pièce recette", quantity: "100.000", unit: "u",
  unit_price_ex_tax: "10.0000", discount_percent: "0.0000", global_discount_percent: "0.0000", tax_rate_percent: "20.0000", billing_shares: [] };

describe("proforma source of truth", () => {
  it("reads canonical order/allocation evidence and acquires source locks only for a write command", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...source, allocation_id: "12" }] });
    const tx = { query } as unknown as Pick<PoolClient, "query">;
    expect(await readProformaOrderSources(tx, [12], true)).toEqual([source]);
    expect(query.mock.calls[0][0]).toContain("line.prix_unitaire_ht");
    expect(query.mock.calls[0][0]).toContain("command.remise_globale");
    expect(query.mock.calls[0][0]).toContain("FOR UPDATE OF allocation,command,line,affaire");
    expect(query.mock.calls[0][1]).toEqual([[12]]);
    await readProformaOrderSources(tx, [12], false);
    expect(query.mock.calls[1][0]).not.toContain("FOR UPDATE");
  });
  it("rejects invalid or duplicated source IDs before SQL", async () => {
    const query = vi.fn(); const tx = { query } as unknown as Pick<PoolClient, "query">;
    await expect(readProformaOrderSources(tx, [12, 12], false)).rejects.toMatchObject({ code: "PROFORMA_AFFAIRS_INVALID" });
    await expect(readProformaOrderSources(tx, [Number.MAX_SAFE_INTEGER + 1], false)).rejects.toMatchObject({ code: "PROFORMA_AFFAIRS_INVALID" });
    expect(query).not.toHaveBeenCalled();
  });
  it("blocks missing sources and missing pricing instead of inventing a price", async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pick<PoolClient, "query">;
    await expect(readProformaOrderSources(tx, [12], false)).rejects.toMatchObject({ code: "PROFORMA_AFFAIR_NOT_FOUND" });
    expect(() => assertProformaOrderSource({ ...source, unit_price_ex_tax: null }, "CUSTOMER-A")).toThrow("Complétez le prix et la TVA");
  });
  it("blocks another physical customer, blocked customers and internal orders", () => {
    expect(() => assertProformaOrderSource(source, "CUSTOMER-B")).toThrow("client sélectionné");
    expect(() => assertProformaOrderSource({ ...source, client_blocked: true }, "CUSTOMER-A")).toThrow("bloqué");
    expect(() => assertProformaOrderSource({ ...source, order_type: "INTERNE" }, "CUSTOMER-A")).toThrow("proforma client");
  });
  it("a quantity, price, tax, party or contract change invalidates the commercial source", () => {
    const hash = proformaOrderSourceRevision(source, "EUR");
    for (const edit of [{ quantity: "101.000" }, { unit_price_ex_tax: "11.0000" }, { tax_rate_percent: "5.5000" },
      { global_discount_percent: "10.0000" }, { contract_id: "CONTRACT-B" },
      { billing_shares: [{ id: "SHARE-B", billed_client_id: "COMPANY-B", quantity: "100.000" }] }]) {
      expect(proformaOrderSourceRevision({ ...source, ...edit }, "EUR")).not.toBe(hash);
    }
  });
  it("normalizing a default billing share does not invalidate a payment due to an internal row ID", () => {
    expect(proformaOrderSourceRevision({ ...source, billing_shares: [{ id: "NEW-SHARE", billed_client_id: "CUSTOMER-A", quantity: "100.000" }] }, "EUR"))
      .toBe(proformaOrderSourceRevision(source, "EUR"));
  });
  it("source hashes ignore the input ordering of billing shares", () => {
    const billing_shares = [{ id: "A", billed_client_id: "COMPANY-A", quantity: "30.000" }, { id: "B", billed_client_id: "COMPANY-B", quantity: "70.000" }];
    expect(proformaOrderSourceRevision({ ...source, billing_shares }, "EUR"))
      .toBe(proformaOrderSourceRevision({ ...source, billing_shares: [...billing_shares].reverse() }, "EUR"));
  });
});
