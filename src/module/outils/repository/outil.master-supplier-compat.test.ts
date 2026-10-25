import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../../config/database", () => ({ default: { query: mocks.query } }));
vi.mock("../../operational-media/repository/operational-media.repository", () => ({ findAssetIdsByStorageKeys: vi.fn(async () => new Map()) }));

import { outilRepository } from "./outil.repository";

describe("master supplier compatibility guards", () => {
  beforeEach(() => mocks.query.mockReset());

  it("refuses a UUID fabricant link before inserting a fabricant when the test-only table is absent", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ table_name: null }] });

    await expect(outilRepository.createFabricant("SECO", null, ["11111111-1111-1111-1111-111111111111"])).rejects.toMatchObject({
      status: 503,
      code: "OUTILLAGE_MASTER_SUPPLIER_SCHEMA_UNAVAILABLE",
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("to_regclass");
  });

  it("keeps legacy fabricant creation available when no master UUID is requested", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id_fabricant: 42 }] });

    await expect(outilRepository.createFabricant("SECO", null, [])).resolves.toBe(42);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("INSERT INTO gestion_outils_fabricant");
  });
});
