import { describe, expect, it } from "vitest";

import {
  normalizeSuperPdpSupplierInvoice,
  supplierInvoiceRequestHash,
} from "../module/supplier-invoices/supplier-invoice.domain";
import type { SuperPdpProviderInvoice } from "../module/facturation/electronic-invoicing/providers/super-pdp/super-pdp.client";

function providerInvoice(overrides: Record<string, unknown> = {}): SuperPdpProviderInvoice {
  return {
    id: 675,
    company_id: 91,
    created_at: "2026-08-27T08:00:00.000Z",
    direction: "in",
    en_invoice: {
      number: "FF-2026-0042",
      issue_date: "2026-08-26",
      payment_due_date: "2026-09-25",
      type_code: 380,
      currency_code: "EUR",
      purchase_order_reference: "BCF-2026-0012",
      seller: {
        name: "Fournisseur Démonstration",
        electronic_address: { scheme: "0225", value: "12345678900011" },
        legal_registration_identifier: { scheme: "0002", value: "123 456 789" },
        vat_identifier: "FR32123456789",
      },
      buyer: { name: "Croix Rousse Précision" },
      totals: {
        total_without_vat: "100.00",
        total_vat_amount: { value: "20.00" },
        total_with_vat: "120.00",
        amount_due_for_payment: "120.00",
      },
      vat_break_down: [{
        vat_category_code: "S",
        vat_category_rate: "20",
        vat_category_taxable_amount: "100",
        vat_category_tax_amount: "20",
      }],
      lines: [{
        identifier: "1",
        invoiced_quantity: "2",
        invoiced_quantity_code: "C62",
        net_amount: "100",
        referenced_purchase_order_line_reference: "10",
        item_information: {
          name: "Matière première",
          buyer_identifier: "MAT-001",
          seller_identifier: "FOU-001",
        },
        price_details: { item_net_price: "50" },
        vat_information: { vat_category_code: "S", vat_category_rate: "20" },
      }],
      additional_supporting_documents: [{
        key: "BL",
        document_reference: "BL-42",
        attached_document: {
          document: Buffer.from("preuve fournisseur", "utf8").toString("base64"),
          filename: "bl-42.txt",
          mime_code: "text/plain",
        },
      }],
    },
    ...overrides,
  } as SuperPdpProviderInvoice;
}

describe("supplier invoice domain", () => {
  it("normalizes an inbound EN16931 invoice without losing routing or purchase evidence", () => {
    const result = normalizeSuperPdpSupplierInvoice(providerInvoice());

    expect(result).toMatchObject({
      providerInvoiceId: "675",
      documentType: "INVOICE",
      legalNumber: "FF-2026-0042",
      currency: "EUR",
      purchaseOrderReference: "BCF-2026-0012",
      totalWithoutVat: 100,
      totalVat: 20,
      totalWithVat: 120,
      supplierSirens: ["123456789"],
      supplierElectronicAddress: { scheme: "0225", value: "12345678900011" },
    });
    expect(result.lines[0]).toMatchObject({
      purchaseOrderLineReference: "10",
      articleBuyerReference: "MAT-001",
      quantity: 2,
      unitPrice: 50,
    });
    expect(result.attachments[0]?.content.toString("utf8")).toBe("preuve fournisseur");
  });

  it("classifies provider credit-note codes and refuses inconsistent totals", () => {
    const credit = providerInvoice();
    credit.en_invoice!.type_code = 381;
    expect(normalizeSuperPdpSupplierInvoice(credit).documentType).toBe("CREDIT_NOTE");

    const invalid = providerInvoice();
    invalid.en_invoice!.totals.total_with_vat = "119.90";
    expect(() => normalizeSuperPdpSupplierInvoice(invalid)).toThrowError(/totaux HT, TVA et TTC/);
  });

  it("preserves the German supplier identity and intra-EU tax evidence for e-reporting", () => {
    const german = providerInvoice();
    german.en_invoice!.seller = {
      name: "Werkzeugbau München GmbH",
      vat_identifier: "DE123456789",
      legal_registration_identifier: { scheme: "0204", value: "HRB 123456" },
      postal_address: { street_name: "Werkstraße 1", city_name: "München", post_code: "80331", country_code: "DE" },
    };
    german.en_invoice!.process_control = { business_process_type: "B1" };
    german.en_invoice!.totals.total_vat_amount = { value: "0.00" };
    german.en_invoice!.totals.total_with_vat = "100.00";
    german.en_invoice!.totals.amount_due_for_payment = "100.00";
    german.en_invoice!.vat_break_down = [{
      vat_category_code: "K",
      vat_category_rate: "0",
      vat_category_taxable_amount: "100",
      vat_category_tax_amount: "0",
    }];

    const result = normalizeSuperPdpSupplierInvoice(german);
    expect(result.sellerSnapshot).toMatchObject({
      vat_identifier: "DE123456789",
      postal_address: { country_code: "DE" },
    });
    expect(result.sourceSnapshot).toMatchObject({ process_control: { business_process_type: "B1" } });
    expect(result.vatBreakdown).toEqual([{ category: "K", rate: 0, taxable_amount: 100, tax_amount: 0 }]);
  });

  it("hashes idempotent command payloads independently from object key order", () => {
    expect(supplierInvoiceRequestHash({ expected_version: 3, mode: "AUTO" }))
      .toBe(supplierInvoiceRequestHash({ mode: "AUTO", expected_version: 3 }));
  });
});
