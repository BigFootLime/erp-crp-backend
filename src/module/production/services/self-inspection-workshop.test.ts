import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { renderSelfInspectionPdf, type SelfInspectionSnapshot } from "./self-inspection-pdf";
import { inspectionRequirement, inspectionSampling } from "./self-inspection-workshop";

function pdfText(bytes: Buffer): string {
  let from = 0, result = "";
  while ((from = bytes.indexOf("stream\n", from)) >= 0) {
    from += 7;
    const end = bytes.indexOf("endstream", from);
    if (end < 0) break;
    try {
      const stream = inflateSync(bytes.subarray(from, end)).toString("latin1");
      result += [...stream.matchAll(/<([a-f0-9\s]+)>/gi)].map(match => Buffer.from(match[1].replace(/\s/g, ""), "hex").toString("latin1")).join("");
    } catch { /* Raster streams are not text. */ }
    from = end + 9;
  }
  return result.replace(/\s/g, "");
}

export function fixtureInspection(count = 3): SelfInspectionSnapshot {
  return {
    of: { id: 95, numero: "OF-RECETTE-001238", quantite_lancee: 20 },
    version: { indice: "A" }, plan: { code: "PC-RECETTE", version: 2, label: "Contrôle axes fictifs" },
    identity: { client_code: "CLI-1210", reference: "RF261009-AXE", designation: "Axe de recette - Ø35 mm", affairs: ["AF-RECETTE-187"] },
    generated_at: "2026-10-14T00:00:00Z", layout_version: "self-inspection/2.0", source_hash: "a".repeat(64),
    characteristics: Array.from({length: count}, (_, index) => ({ characteristic_key: `COTE-${index + 1}`, label: `Cote ${index + 1} - diamètre`,
      value_kind: "NUMERIC", nominal: "35.00000", tolerance_min: "-0.02000", tolerance_max: "0.01500", unit: "mm", sampling_rule: "ALL",
      measured_value: "123.456789", instrument_id: "SECRET-INSTRUMENT", result: "CONFORME", visa: "XX" })),
  };
}

describe("Workshop self-inspection paper evidence", () => {
  it("prints expected precision, never measured values, result, visa or a technical hash", async () => {
    const fixture = fixtureInspection(), before = structuredClone(fixture);
    const bytes = await renderSelfInspectionPdf(fixture), text = pdfText(bytes);
    expect(bytes.subarray(0,5).toString()).toBe("%PDF-");
    expect(text).toContain("CLI-1210");
    expect(text).toContain("AF-RECETTE-187");
    expect(text).toContain("RF261009-AXE");
    expect(text).toContain("20pièces");
    expect(text).toContain("35mm");
    expect(text).toContain("-0,02/0,015mm");
    expect(text).toContain("100%");
    expect(text).toContain("N°instrument");
    expect(text).toContain("Visa");
    expect(text).not.toContain("123,456789");
    expect(text).not.toContain("123.456789");
    expect(text).not.toContain("SECRET-INSTRUMENT");
    expect(text).not.toContain("CONFORME");
    expect(text).not.toContain("XX");
    expect(text).not.toContain(fixture.source_hash);
    expect(text).not.toContain("Éditéle");
    expect(fixture).toEqual(before);
    expect(bytes.toString('latin1')).toContain('/BaseFont /Helvetica-Bold');
  });
  it("keeps all requirements and repeats headings across a dense multi-page sheet", async () => {
    const bytes = await renderSelfInspectionPdf(fixtureInspection(32));
    const text = pdfText(bytes);
    for (let index=1;index<=32;index++) expect(text).toContain(`Cote${index}-diamètre`);
    expect(text.match(/N°instrument/g)?.length).toBeGreaterThan(1);
    expect(text).toContain("Opérationetvisa");
    expect(text).toContain("libérationqualitérestedistincte");
    const pages = bytes.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(2);
    expect(text).toContain(`Page${pages}/${pages}`);
  });
  it("keeps very long instructions through explicit continuation without losing the tail", async () => {
    const input=fixtureInspection(1);
    input.characteristics[0].method='Vérifier selon instruction '.repeat(140)+'FIN-CONSIGNE';
    const text=pdfText(await renderSelfInspectionPdf(input));
    expect(text).toContain('Suite-COTE-1');
    expect(text).toContain('FIN-CONSIGNE');
    expect(text).toContain('Opérationetvisa');
  });
  it("uses existing sampling rules and keeps absent expected values absent", () => {
    expect(inspectionSampling({sampling_rule:'FIRST_ARTICLE'})).toBe('Première pièce');
    expect(inspectionSampling({sampling_rule:'PERCENT',sampling_value:'12.500'})).toBe('12,5 %');
    expect(inspectionSampling({sampling_rule:'FIXED',sampling_value:3})).toBe('3 pièce(s)');
    expect(inspectionSampling({sampling_rule:'LOT'})).toBe('Par lot');
    expect(inspectionRequirement({label:'Limite',nominal:null,tolerance_min:0,tolerance_max:1})).toContain('Limites : 0 / 1');
    expect(inspectionRequirement({label:'Aspect',value_kind:'BOOLEAN',expected_boolean:false})).toContain('Attendu : Non');
    expect(inspectionRequirement({label:'Classe',value_kind:'ENUM',allowed_values:['A','B']})).toContain('A / B');
    expect(inspectionRequirement({label:'Plan absent'})).not.toContain('Nominal');
  });
  it("prints the French generation date at the UTC midnight boundary", async () => {
    const input=fixtureInspection(1);
    input.generated_at='2026-10-13T23:30:00Z';
    expect(pdfText(await renderSelfInspectionPdf(input))).toContain('14/10/2026');
  });
  it("does not suggest a missing delivery affair for anticipated internal manufacture", async () => {
    const input=fixtureInspection(1);
    input.identity={...input.identity!,scope:'INTERNAL',affairs:[]};
    const text=pdfText(await renderSelfInspectionPdf(input));
    expect(text).toContain('Fabricationinterne');
    expect(text).not.toContain('Nonrenseigné');
  });
});
