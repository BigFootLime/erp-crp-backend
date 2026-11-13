import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { query: mocks.query } }));

import { repoListGammeOperations } from "./gamme-operations.repository";

describe("operation preparation warnings returned to the methods UI (#1833)", () => {
  beforeEach(() => mocks.query.mockReset());

  function rows(operation: Record<string, unknown>) {
    mocks.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: "operation", piece_technique_id: "piece", gamme_id: "route", phase: 10,
      type_operation: "FRAISAGE", machine_family_code: "CNC", famille_programme_requis: true,
      ...operation,
    }], rowCount: 1 });
  }

  it("returns canonical preparation and family-program warnings without duplicates or losing the selected machine", async () => {
    rows({ designation: "", cf_id: null, tp: 0, tf_unit: 0, numero_programme: null,
      machine_id: "historical-machine", machine_status: "MAINTENANCE" });
    const [operation] = await repoListGammeOperations("route");
    expect(operation.preparation_issues).toEqual([
      "Désignation manquante", "Centre de frais manquant", "Temps de préparation ou de fabrication requis",
      "Phase 10 : le numéro de programme est obligatoire pour la famille CNC.",
    ]);
    expect(new Set(operation.preparation_issues).size).toBe(operation.preparation_issues?.length);
    expect(operation).toMatchObject({ machine_id: "historical-machine", machine_obsolete: true });
    expect(mocks.query.mock.calls.every(([sql]) => !/\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(true);
  });

  it("returns no warning for a complete operation and retains its original phase", async () => {
    rows({ designation: "Fraisage", cf_id: "cost-centre", tp: 0.5, tf_unit: 0.1, numero_programme: "P42" });
    const [operation] = await repoListGammeOperations("route");
    expect(operation).toMatchObject({ phase: 10, preparation_issues: [] });
  });
});
