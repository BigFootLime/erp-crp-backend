import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../config/database", () => ({ default: { query: vi.fn() } }));
import { repoLoadElectronicInvoiceSource } from "./electronic-invoice.repository";

const regulatory = {
  specVersion: "DGFiP-FE-V3.2-2026-04-30", billingFrameCatalogVersion: "AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30",
  billingFrameCode: "B1", operationCategory: "GOODS", transactionScope: "FR_PRIVATE_B2B", buyerSiren: "987654321", deliveryAddress: null,
  sellerElectronicAddress: {scheme:"0225",value:"123456789",directoryEntryId:"fixture-seller",verifiedAt:"2026-08-18T10:00:00Z"},
  buyerElectronicAddress: {scheme:"0225",value:"987654321",directoryEntryId:"fixture-buyer",verifiedAt:"2026-08-18T10:00:00Z"},
};
const frozenLine = {source_line_id:"original-line",designation:"Barre",quantity:"3000.000",unit:"mm",unit_price_ex_tax:"0.0250",
  discount_percent:"0.0000",tax_rate_percent:"20.0000",total_ex_tax:"75.00",total_incl_tax:"90.00"};
const roundedRow = {id:1,description:"Barre",quantity:"3000.000",unit:"mm",unit_price_ex_tax:"0.0300",discount_percent:"0.0000",
  vat_rate:"20.0000",total_ex_tax:"75.00",total_incl_tax:"90.00"};
const row = {id:1,numero:"FIXTURE-F-1",date_emission:"2026-08-18",date_echeance:null,currency:"EUR",document_status:"ISSUED",
  issuer_snapshot:{siren:"123456789",vat_number:"FR00123456789",company_name:"Émetteur fictif",address_line_1:"1 rue Exemple",postal_code:"69001",city:"Lyon",country:"FR"},
  client_snapshot:{siret:"98765432100011",company_name:"Client fictif",billing_address:{street:"2 rue Exemple",postal_code:"69001",city:"Lyon",country:"FR"}},
  regulatory_snapshot:regulatory,total_ht:"75.00",total_tax:"15.00",total_ttc:"90.00",lines:[roundedRow]};
const load = (snapshot:unknown) => repoLoadElectronicInvoiceSource(1,{query:vi.fn().mockResolvedValue({rows:[{...row,immutable_snapshot:snapshot}]})} as unknown as PoolClient);

describe("issued invoice source retains the fiscal record", () => {
  it("exports the issued 0.0250 price when historical SQL rows contain 0.0300",async()=>{
    const snapshot={lines:[frozenLine]};
    const source=await load(snapshot);
    expect(source.lines[0]).toMatchObject({quantity:"3000.000",unit_price_ex_tax:"0.0250",total_ex_tax:"75.00",total_incl_tax:"90.00"});
    expect(source.taxBreakdown?.entries).toMatchObject([{taxable_amount:"75.00",tax_amount:"15.00"}]);
    expect(snapshot.lines[0]).toEqual(frozenLine);
  });
  it("retains older invoices with no snapshot lines without rewriting their prices",async()=>{
    expect((await load({legacy:true})).lines).toEqual([roundedRow]);
  });
  it.each([null,{},[null],[]])("refuses present invalid or empty frozen lines instead of using current rows (%j)",async(lines)=>{
    await expect(load({lines})).rejects.toMatchObject({code:lines instanceof Array&&lines.length===0?"EINVOICE_REQUIRED_DATA_MISSING":"EINVOICE_ISSUED_LINES_INVALID"});
  });
});
