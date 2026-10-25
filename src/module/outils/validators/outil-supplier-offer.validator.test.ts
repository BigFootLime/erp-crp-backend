import { describe, expect, it } from "vitest";
import { linkToolSupplierOfferSchema, reapprovisionnementSchema } from "./outil.validator";
const supplier="c8318b1e-e3a0-488a-bb75-92fc55dfc858";
describe("supplier offer and actual receipt contracts", () => {
  it("accepts a documented manual supplier link without inventing PDF evidence", () => {
    const parsed=linkToolSupplierOfferSchema.parse({catalogue_id:supplier,source:{kind:"MANUAL",note:"Distributeur confirmé par l’atelier"}});
    expect(parsed.source).toEqual({kind:"MANUAL",note:"Distributeur confirmé par l’atelier"});
    expect(linkToolSupplierOfferSchema.safeParse({catalogue_id:supplier,source:{kind:"MANUAL",note:""}}).success).toBe(false);
  });
  it("requires real receipt evidence and never coerces a legacy number into a master UUID", () => {
    const receipt={id_outil:1,quantite:2,prix_unitaire_ht:12.5,fournisseur_id:supplier,purchased_at:"2026-10-25",devise:"CHF",unite:"piece",reception_ref:"BL-42",idempotency_key:"receipt-test-42"};
    expect(reapprovisionnementSchema.parse(receipt)).toMatchObject({devise:"CHF",fournisseur_id:supplier});
    expect(reapprovisionnementSchema.safeParse({...receipt,fournisseur_id:12}).success).toBe(false);
    expect(reapprovisionnementSchema.safeParse({...receipt,purchased_at:undefined}).success).toBe(false);
    expect(reapprovisionnementSchema.safeParse({...receipt,quantite:1.2}).success).toBe(false);
  });
});
