import { describe, it, expect } from "vitest";
import { parseDemandImport } from "./demand-import.adapter";
const defaults = {
  external_site: "PILOT",
  source_version: "S07",
  source_as_of: "2027-02-15T08:00:00Z",
};
const row = {
  ARTICLE: "DEMO-001",
  CONTRAT: "CADRE-1",
  NUM_CDE: "APPEL-1",
  ID_LIGNE: "10",
  ID_ECHEANCE: "1",
  UNITE: "PCE",
  "Qté/Uc": "999999",
  RUBRIQUE: "En commande ferme",
  DATE_ECHEANCE: "16/02/2027",
  QUANTITE_ECHEANCE: "5,000",
  RETARD: "12",
};
describe("Programme de livraison imprimé, retranscription contrôlée", () => {
  it("uses only dated quantities under the firm and PRV headings, keeping remaining basis", () => {
    const r = parseDemandImport({
      source: "VISION_PROGRAMME",
      defaults,
      rows: [
        row,
        {
          ...row,
          RUBRIQUE: "PRV",
          ID_ECHEANCE: "2",
          QUANTITE_ECHEANCE: "22,000",
        },
      ],
    });
    expect(r.summary.valid).toBe(2);
    expect(
      r.rows.map((x) => [
        x.kind,
        x.quantity,
        x.quantity_basis,
        x.contract_reference,
      ]),
    ).toEqual([
      ["FIRM", 5, "REMAINING", "CADRE-1"],
      ["FORECAST", 22, "REMAINING", "CADRE-1"],
    ]);
  });
  it("requires stable matching and never interprets a pack quantity, late subtotal or open label as demand", () => {
    const r = parseDemandImport({
      source: "VISION_PROGRAMME",
      defaults,
      rows: [
        {
          ...row,
          ID_ECHEANCE: "",
          QUANTITE_ECHEANCE: "",
          RUBRIQUE: "Cde ouverte",
        },
      ],
    });
    expect(r.rows).toEqual([]);
    expect(r.preview_rows[0].candidate).toMatchObject({
      external_site: "PILOT",
      article_code: "DEMO-001",
    });
    expect(r.summary.invalid).toBe(1);
  });
  it("does not turn Cde ouverte into an uncommitted forecast without a firmness column", () => {
    const r = parseDemandImport({
      source: "VISION_SYSTEMS",
      rows: [{ TYPE_CDE: "Cde ouverte" }],
    });
    expect(r.diagnostics.some((d) => d.code === "FIRMNESS_REQUIRED")).toBe(
      true,
    );
  });
  it("blocks unreviewed OCR even when the external keys are already filled",()=>{
    const r=parseDemandImport({source:"VISION_PROGRAMME",defaults,rows:[{...row,REVIEW_REQUIRED:"TRUE"}]});
    expect(r.rows).toHaveLength(0);expect(r.diagnostics.some(d=>d.code==="SOURCE_REVIEW_REQUIRED")).toBe(true);
  });
});
