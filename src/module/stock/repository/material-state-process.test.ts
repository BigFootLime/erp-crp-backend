import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMaterialArticleCode, computeMaterialCodePreviewHash } from "../../../shared/codes/material-article-code";
import { repoPreviewMaterialArticleCode, resolveMaterialCodeInput } from "./stock-material-referentials.repository";

const query = vi.hoisted(() => vi.fn());
vi.mock("../../../config/database", () => ({ default: { query } }));

describe("Material state/process resolution", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("stock_nuances")) return { rows: [{ code: "316L" }], rowCount: 1 };
      if (sql.includes("stock_etats")) return { rows: [{ code: "H9" }], rowCount: 1 };
      if (sql.includes("stock_sous_etats")) return { rows: [{ code: "LAMINE" }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  it.each([
    { etat_id: null, sous_etat_id: null, code: "MP-RO-316L-20", queries: 1 },
    { etat_id: 7, sous_etat_id: null, code: "MP-RO-316L-H9-20", queries: 2 },
    { etat_id: null, sous_etat_id: 11, code: "MP-RO-316L-LAMINE-20", queries: 2 },
    { etat_id: 7, sous_etat_id: 11, code: "MP-RO-316L-H9-LAMINE-20", queries: 3 },
  ])("uses the same resolved identity for preview and creation: $code", async ({ etat_id, sous_etat_id, code, queries }) => {
    const request = { family_code: "RO", nuance_id: 9, etat_id, sous_etat_id, dimensions: { diametre_mm: 20 } };
    const input = await resolveMaterialCodeInput({ query } as Parameters<typeof resolveMaterialCodeInput>[0], request);
    expect(query).toHaveBeenCalledTimes(queries);
    const creation = buildMaterialArticleCode(input);
    const preview = await repoPreviewMaterialArticleCode(request);
    expect(creation.code).toBe(code);
    expect(preview).toMatchObject(creation);
    expect(preview.preview_hash).toBe(computeMaterialCodePreviewHash({ input, code: creation.code, designation: creation.designation }));
  });

  it("keeps rejecting an unknown selected state or process", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(resolveMaterialCodeInput({ query } as Parameters<typeof resolveMaterialCodeInput>[0], { family_code: "RO", etat_id: 99 }))
      .rejects.toThrow(/État introuvable/);
    await expect(resolveMaterialCodeInput({ query } as Parameters<typeof resolveMaterialCodeInput>[0], { family_code: "RO", sous_etat_id: 99 }))
      .rejects.toThrow(/Procédé introuvable/);
  });
});
