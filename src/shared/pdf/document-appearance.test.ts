import { describe, expect, it } from "vitest";
import { renderCerpDocument } from "./cerp-document";
import { archiveDocumentCategory, baseDocumentRenderVersion, creationDocumentCategory, documentColors, DOCUMENT_CATEGORY_ACCENTS } from "./document-appearance";

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

describe("Versioned print appearance", () => {
  it.each(Object.keys(DOCUMENT_CATEGORY_ACCENTS) as Array<keyof typeof DOCUMENT_CATEGORY_ACCENTS>)("keeps %s text legible and warning red", category => {
    const c = documentColors(category);
    expect(contrast(c.paper, c.heading)).toBeGreaterThan(7);
    expect(contrast(c.ink, c.wash)).toBeGreaterThan(7);
    expect(contrast(c.steel, c.paper)).toBeGreaterThan(4.5);
    expect(c.danger).toBe("#B90101");
  });
  it("keeps the historical archive palette unless its recorded version opts in", () => {
    for (const version of ["supplier-po-pdf-v1", "client-profile-pdf-v2", "customer-ar-pdf-v1", "of-traveler-v2", "proforma/1.1"]) {
      expect(archiveDocumentCategory(version, "commerce")).toBeUndefined();
      const next = `${version}+style-20261019`;
      expect(archiveDocumentCategory(next, "commerce")).toBe("commerce");
      expect(baseDocumentRenderVersion(next)).toBe(version);
    }
  });
  it("uses actual archive entity identifiers for production, stock and commerce", () => {
    expect(creationDocumentCategory("ordre-fabrication")).toBe("production");
    expect(creationDocumentCategory("piece-technique-version")).toBe("production");
    expect(creationDocumentCategory("stock-article")).toBe("stock");
    expect(creationDocumentCategory("bon-livraison")).toBe("commerce");
  });
  it("does not leak a palette between concurrent document renderings", async () => {
    const render = (category?: "production" | "commerce") => renderCerpDocument({
      category, documentType: "Recette", name: "Pièce fictive", code: "PDF-STYLE", status: "EXEMPLE",
      generatedAt: "19/10/2026", title: "Recette de palette", subject: "Isolation des couleurs", creationDate: new Date("2026-10-19T10:00:00Z"),
    }, ctx => { ctx.section("Données"); ctx.fieldsGrid([{ label: "Quantité", value: "40 pièces" }]); });
    const categories = ["production", "commerce", undefined] as const;
    const sequential: Buffer[] = [];
    for (const category of categories) sequential.push(await render(category));
    const concurrent = await Promise.all(categories.map(render));
    concurrent.forEach((bytes, i) => expect(bytes.equals(sequential[i])).toBe(true));
    expect(concurrent[0].equals(concurrent[1])).toBe(false);
    expect(concurrent[0].equals(concurrent[2])).toBe(false);
  });
});
