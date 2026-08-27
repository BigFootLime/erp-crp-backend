import { describe, expect, it } from "vitest";

import {
  buildInvoiceRegulatorySnapshot,
  EINVOICE_BILLING_FRAME_CATALOG_VERSION,
  EINVOICE_BILLING_FRAMES,
  parseInvoiceRegulatorySnapshot,
} from "./electronic-invoice-regulatory.domain";

const address = (value: string) => ({
  scheme: "0225",
  value,
  directory_entry_id: `directory-${value}`,
  verified_at: "2026-08-27T08:00:00.000Z",
});

describe("electronic invoice regulatory data", () => {
  it("pins the complete qualified BT-23 catalogue and enforces its operation category", () => {
    expect(Object.keys(EINVOICE_BILLING_FRAMES)).toEqual([
      "B1", "S1", "M1", "B2", "S2", "M2", "B4", "S4", "M4", "S5", "S6", "B7", "S7",
    ]);
    expect(() =>
      buildInvoiceRegulatorySnapshot({
        billingFrameCode: "B1",
        operationCategory: "SERVICES",
        transactionScope: "FR_PRIVATE_B2B",
        sellerElectronicAddress: address("seller"),
        buyerElectronicAddress: address("buyer"),
        buyerSiren: "987654321",
        deliveryAddress: null,
      })
    ).toThrowError(/catégorie d'opération/i);
  });

  it("keeps legal and electronic identifiers distinct and requires directory verification", () => {
    const snapshot = buildInvoiceRegulatorySnapshot({
      billingFrameCode: "S5",
      operationCategory: "SERVICES",
      transactionScope: "FR_PRIVATE_B2B",
      sellerElectronicAddress: address("seller-routing"),
      buyerElectronicAddress: address("buyer-routing"),
      buyerSiren: "987654321",
      deliveryAddress: { city: "Lyon", country: "FR" },
    });
    expect(snapshot.billingFrameCatalogVersion).toBe(EINVOICE_BILLING_FRAME_CATALOG_VERSION);
    expect(snapshot.sellerElectronicAddress.value).toBe("seller-routing");
    expect(snapshot.buyerElectronicAddress?.value).toBe("buyer-routing");
    expect(() =>
      buildInvoiceRegulatorySnapshot({
        billingFrameCode: "S1",
        operationCategory: "SERVICES",
        transactionScope: "FR_PRIVATE_B2B",
        sellerElectronicAddress: { scheme: "0225", value: "seller" },
        buyerElectronicAddress: address("buyer"),
        buyerSiren: "987654321",
        deliveryAddress: null,
      })
    ).toThrowError(/vérifiée dans l'annuaire/i);
  });

  it("fails closed for historical invoices without a regulatory snapshot", () => {
    expect(() => parseInvoiceRegulatorySnapshot(null)).toThrowError(/facture historique/i);
    expect(() => parseInvoiceRegulatorySnapshot({})).toThrowError(/cadre de facturation/i);
  });

  it("allows a foreign B2B snapshot without inventing a French buyer routing address", () => {
    const snapshot = buildInvoiceRegulatorySnapshot({
      billingFrameCode: "B1",
      operationCategory: "GOODS",
      transactionScope: "FOREIGN_B2B",
      sellerElectronicAddress: address("seller-routing"),
      buyerElectronicAddress: {},
      buyerSiren: "",
      deliveryAddress: { city: "Genève", country: "CH" },
    });
    expect(snapshot.buyerElectronicAddress).toBeNull();
    expect(snapshot.buyerSiren).toBeNull();
  });
});
