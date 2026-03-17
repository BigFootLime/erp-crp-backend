import { describe, expect, it } from "vitest";

import { createClientSchema } from "../module/client/validators/client.validators";

function makeValidPayload() {
  return {
    company_name: "Client de test",
    client_code: "",
    email: "contact@example.com",
    phone: "0123456789",
    website_url: "https://example.com",
    siret: "12345678901234",
    vat_number: "FR40123456789",
    naf_code: "2562B",
    status: "client" as const,
    blocked: false,
    reason: "",
    creation_date: "2026-03-17",
    payment_mode_ids: [],
    biller_id: undefined,
    bank: {
      bank_name: "Banque de test",
      iban: "FR1420041010050500013M02606",
      bic: "PSSTFRPPMON",
    },
    observations: "",
    provided_documents_id: undefined,
    bill_address: {
      name: "Facturation",
      street: "1 rue de Lyon",
      house_number: "",
      postal_code: "69001",
      city: "Lyon",
      country: "France",
    },
    delivery_address: {
      name: "Livraison",
      street: "2 rue de Marseille",
      house_number: "",
      postal_code: "69002",
      city: "Lyon",
      country: "France",
    },
    primary_contact: undefined,
    quality_level: undefined,
    quality_levels: [],
    contacts: [],
  };
}

describe("createClientSchema", () => {
  it("drops fully blank optional contacts while keeping the rest of the payload valid", () => {
    const parsed = createClientSchema.parse({
      ...makeValidPayload(),
      primary_contact: {
        first_name: "",
        last_name: "",
        email: "",
        phone_personal: "",
        role: "",
        civility: "",
      },
      contacts: [
        {
          first_name: "",
          last_name: "",
          email: "",
          phone_personal: "",
          role: "",
          civility: "",
        },
      ],
    });

    expect(parsed.client_code).toBeUndefined();
    expect(parsed.primary_contact).toBeUndefined();
    expect(parsed.contacts).toEqual([]);
  });

  it("rejects a client code that does not match CLI-001", () => {
    const parsed = createClientSchema.safeParse({
      ...makeValidPayload(),
      client_code: "CLI-12",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["client_code"],
          message: "Le code client doit être au format CLI-001.",
        }),
      ])
    );
  });

  it("returns explicit French messages for missing required address fields", () => {
    const parsed = createClientSchema.safeParse({
      ...makeValidPayload(),
      bill_address: {
        ...makeValidPayload().bill_address,
        street: "",
        postal_code: "",
        city: "",
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["bill_address", "street"], message: "Rue requise" }),
        expect.objectContaining({ path: ["bill_address", "postal_code"], message: "Code postal requis" }),
        expect.objectContaining({ path: ["bill_address", "city"], message: "Ville requise" }),
      ])
    );
  });
});
