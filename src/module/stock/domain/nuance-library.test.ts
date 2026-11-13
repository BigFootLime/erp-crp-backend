import { describe, expect, it } from "vitest";
import { nuanceIdentity, resolveNuanceIdentity } from "./nuance-library";
import { createMatiereNuanceSchema, updateMatiereNuanceSchema } from "../validators/stock.validators";

describe("nuance library identity", () => {
  it.each(["norme_fr", "norme_en", "norme_werkstoff", "norme_usa"])("accepts %s alone and chooses its title", key => {
    const parsed = createMatiereNuanceSchema.parse({ body: { [key]: "  Test 123  " } }).body;
    const result = resolveNuanceIdentity(parsed);
    expect(result.libelle).toBe("Test 123");
    expect(result[key as "norme_fr"]).toBe("Test 123");
  });
  it.each([{}, { code: "316L" }, { norme_fr: "  " }, { norme_fr: "---" }, { norme_en: "x".repeat(41) }, { norme_usa: "316L", designation_principale: "EN" }, { norme_usa: "316L", designation_principale: "LEGACY" }])("rejects invalid new identity %j", body => {
    expect(createMatiereNuanceSchema.safeParse({ body }).success).toBe(false);
  });
  it("does not infer a standard for historical entries", () => {
    expect(nuanceIdentity({ code: "1.4404" })).toEqual({ norme_fr: null, norme_en: null, norme_werkstoff: null, norme_usa: null, designation_principale: "LEGACY", libelle: "1.4404" });
  });
  it("classifies an old identity without changing its workshop code", () => {
    expect(resolveNuanceIdentity({ norme_werkstoff: "1.4404", norme_usa: "316L", designation_principale: "USA" }, { code: "OLD", designation_principale: "LEGACY" })).toMatchObject({ designation_principale: "USA", libelle: "316L", norme_werkstoff: "1.4404" });
  });
  it("retains unclassified identity for metadata-only historical edits", () => {
    expect(resolveNuanceIdentity({ designation: "Updated" }, { code: "OLD", designation_principale: "LEGACY" }).libelle).toBe("OLD");
  });
  it("switches title while retaining all correspondences", () => {
    const old = { code: "OLD", norme_en: "EN-TEST", norme_usa: "USA-TEST", designation_principale: "EN" };
    expect(resolveNuanceIdentity({ designation_principale: "USA" }, old)).toMatchObject({ norme_en: "EN-TEST", norme_usa: "USA-TEST", libelle: "USA-TEST" });
    expect(() => resolveNuanceIdentity({ norme_en: null }, old)).toThrow(/principale/);
    expect(() => resolveNuanceIdentity({ norme_en: null, norme_usa: null }, old)).toThrow(/au moins une/);
  });
  it("rejects an empty PATCH and unknown fields", () => {
    expect(updateMatiereNuanceSchema.safeParse({ body: {} }).success).toBe(false);
    expect(updateMatiereNuanceSchema.safeParse({ body: { bypass: true } }).success).toBe(false);
    expect(updateMatiereNuanceSchema.safeParse({ body: { designation_principale: "USA" } }).success).toBe(true);
  });
});
