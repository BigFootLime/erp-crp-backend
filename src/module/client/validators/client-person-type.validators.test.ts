import { describe, expect, it } from "vitest";
import { clientPatchSchema, createClientSchema } from "./client.validators";

const addresses = {
  name: "Adresse", street: "1 rue Exemple", postal_code: "42000", city: "Saint-Étienne", country: "France",
};
const base = {
  status: "prospect", blocked: false, creation_date: "2026-10-26", payment_mode_ids: [],
  bill_address: addresses, delivery_address: addresses,
};

describe("client professional and individual identity", () => {
  it("keeps omitted historical/API creates professional and requires a company name", () => {
    expect(createClientSchema.safeParse({ ...base, company_name: "Atelier Exemple" }).success).toBe(true);
    expect(createClientSchema.safeParse({ ...base }).success).toBe(false);
  });
  it("accepts an explicit individual and derives the legacy display label", () => {
    const parsed = createClientSchema.parse({ ...base, customer_type: "INDIVIDUAL", individual_first_name: "Ana", individual_last_name: "Martin" });
    expect(parsed.company_name).toBe("Ana Martin");
    expect(parsed.customer_type).toBe("INDIVIDUAL");
  });
  it("requires clearing professional identifiers when changing to an individual", () => {
    expect(clientPatchSchema.safeParse({ customer_type: "INDIVIDUAL", individual_first_name: "Ana", individual_last_name: "Martin", siret: "", siren: "", vat_number: "", naf_code: "" }).success).toBe(true);
    expect(clientPatchSchema.safeParse({ customer_type: "INDIVIDUAL", individual_first_name: "Ana", individual_last_name: "Martin", siret: "12345678901234" }).success).toBe(false);
  });
});
