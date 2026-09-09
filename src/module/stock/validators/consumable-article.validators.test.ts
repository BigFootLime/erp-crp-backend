import { describe,expect,it } from "vitest";
import { createArticleSchema, updateArticleSchema, articleSupplierConditionSchema } from "./stock.validators";
import { createCatalogueSchema, updateCatalogueSchema } from "../../fournisseurs/validators/fournisseurs.validators";

const supplier="b012d23c-0a99-4874-811c-28b217c38345";
describe("consumable article contracts",()=>{
  it("accepts an independent CRP reference and supplier pack without a technical piece",()=>{
    const result=createArticleSchema.parse({body:{designation:"Cartons",article_category:"achat",article_categories:["consommable"],
      family_code:"CONS",internal_reference:"CRP-CARTON",stock_managed:true,lot_tracking:true,consumption_mode:"GLOBAL_PACK",purchase_pack_qty:100,
      receipt_quality_required:false,supplier_conditions:[{supplier_id:supplier,prix_unitaire:null,lot_achat:100,unite:"u",preferred:true}]}});
    expect(result.body.internal_reference).toBe("CRP-CARTON");
    expect(result.body.supplier_conditions?.[0].prix_unitaire).toBeNull();
  });
  it("does not silently change a supplier quality policy or pricing basis on an article edit",()=>{
    const patch=articleSupplierConditionSchema.parse({supplier_id:supplier,prix_unitaire:2});
    expect(patch).not.toHaveProperty("requiert_controle_reception");
    expect(patch).not.toHaveProperty("pricing_basis");
  });
  it("keeps old article payloads free of new defaults",()=>{
    const patch=updateArticleSchema.parse({body:{expected_row_version:1,designation:"Nouvelle désignation"}}).body;
    expect(patch).not.toHaveProperty("consumption_mode");
    expect(patch).not.toHaveProperty("receipt_quality_required");
    expect(patch).not.toHaveProperty("supplier_conditions");
  });
  it("rejects zero packaging and carries explicit supplier units",()=>{
    const body={type:"CONSOMMABLE",designation:"Carton",unite:"palette",unite_stock:"u",coef_conversion:100,lot_achat:1};
    expect(createCatalogueSchema.parse({body}).body.coef_conversion).toBe(100);
    expect(updateCatalogueSchema.safeParse({body:{lot_achat:0}}).success).toBe(false);
    expect(updateCatalogueSchema.safeParse({body:{coef_conversion:0}}).success).toBe(false);
  });
});
