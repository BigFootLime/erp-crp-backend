import { describe, expect, it, vi } from "vitest";

import { outilCatalogueImportRepository } from "./outil-catalogue-import.repository";

describe("catalogue import repository guards", () => {
  it("refuses every database name except the shared cerp_test target", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ database: "cerp_prod" }] });
    await expect(outilCatalogueImportRepository.assertTestDatabase({ query } as never)).rejects.toMatchObject({
      code: "CATALOGUE_IMPORT_TEST_DATABASE_REQUIRED",
    });
  });

  it("looks up an existing exact manufacturer/reference/source tuple before creating a replay", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id_outil: 42 }] });
    await expect(outilCatalogueImportRepository.findExisting({ query } as never, 7, "REF-1", "source-r1")).resolves.toBe(42);
    expect(query.mock.calls[0][0]).toContain("source_selection_id = $3");
    expect(query.mock.calls[0][1]).toEqual([7, "REF-1", "source-r1"]);
  });

  it("qualifies a global geometry collision with its target family", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // lock
      .mockResolvedValueOnce({ rows: [{ id_fabricant: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id_famille: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id_geometrie: 7, id_famille: 9 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id_geometrie: 12 }] });
    await expect(outilCatalogueImportRepository.resolveTaxonomy({ query } as never, "HORN", "Plaquettes", "Filetage", null))
      .resolves.toMatchObject({ geometryId: 12 });
    expect(query.mock.calls.some((call) => JSON.stringify(call[1]).includes("Filetage (Plaquettes)"))).toBe(true);
  });

  it("qualifies a global coating collision with its target manufacturer", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // lock
      .mockResolvedValueOnce({ rows: [{ id_fabricant: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id_famille: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id_revetement: 4, id_fabricant: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id_revetement: 13 }] });
    await expect(outilCatalogueImportRepository.resolveTaxonomy({ query } as never, "HOFFMANN", "Forets", null, "TiAlN"))
      .resolves.toMatchObject({ revetementId: 13, geometryId: null });
    expect(query.mock.calls.some((call) => JSON.stringify(call[1]).includes("TiAlN (HOFFMANN)"))).toBe(true);
  });

});
