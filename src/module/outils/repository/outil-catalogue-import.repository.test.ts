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
});
