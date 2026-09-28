import { describe, expect, it, vi } from "vitest";

// CommonJS keeps the operational seed independent from the Express app.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const seed = require("../../scripts/seed-demo-presentation.js") as {
  FIXTURES: Array<Record<string, unknown>>;
  REFERENCE: { calendarId: string; costCenterId: string; costCenterRateId: string };
  ensureDemoPrimaryRole: (client: { query: ReturnType<typeof vi.fn> }, userId: number) => Promise<void>;
  ensureQualifiedPresentationVersion: (client: { query: ReturnType<typeof vi.fn> }, fixture: Record<string, unknown>, userId: number) => Promise<void>;
  ensurePresentationReferenceData: (client: { query: ReturnType<typeof vi.fn> }, inputs: Array<Record<string, unknown>>, userId: number) => Promise<void>;
  ensureApplicableGamme: (client: { query: ReturnType<typeof vi.fn> }, input: Record<string, unknown>, userId: number) => Promise<void>;
  assertPresentationFixture: (client: { query: ReturnType<typeof vi.fn> }, inputs: Array<Record<string, unknown>>) => Promise<void>;
};

const input = {
  ...seed.FIXTURES[0],
  piece_id: "10000000-0000-4000-8000-000000000001",
  version_id: "20000000-0000-4000-8000-000000000001",
  article_id: "25000000-0000-4000-8000-000000000001",
  version_status: "BROUILLON",
  version_current: true,
  date_effet: null,
  machine_id: "30000000-0000-4000-8000-000000000001",
  poste_id: "40000000-0000-4000-8000-000000000001",
};

describe("presentation offline seed", () => {
  it("creates a new current qualified version without mutating the applicable source", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        piece_id: input.piece_id, matiere_prevue: "Aluminium", manufacturing_mode: "SIMPLE",
        assembly_supply_strategy: "MAKE_TO_ORDER", version_interne: 1,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await seed.ensureQualifiedPresentationVersion({ query }, input, 42);
    expect(String(query.mock.calls[2][0])).toContain("SET statut = 'OBSOLETE', is_current = false");
    expect(String(query.mock.calls[3][0])).toContain("'APPLICABLE',true");
    expect(query.mock.calls[3][1]).toContain(input.versionId);
  });

  it("repairs only the demo account primary role required by readiness", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await seed.ensureDemoPrimaryRole({ query }, 42);
    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[1][0])).toContain("INSERT INTO public.app_roles");
    expect(String(query.mock.calls[2][0])).toContain("user_role_assignments");
    expect(query.mock.calls[2][1]).toEqual([42]);
  });

  it("seeds reproducible canonical readiness data and schedules each fixture machine", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await seed.ensurePresentationReferenceData({ query }, [input], 42);
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(query).toHaveBeenCalledTimes(11);
    expect(statements.filter((sql) => sql.includes("INSERT INTO public.units"))).toHaveLength(4);
    expect(statements.some((sql) => sql.includes("programmation_calendars"))).toBe(true);
    expect(statements.some((sql) => sql.includes("production_machine_families"))).toBe(true);
    expect(statements.some((sql) => sql.includes("production_cost_center_rates"))).toBe(true);
    const activity = statements.find((sql) => sql.includes("production_activity_categories"));
    expect(activity).toContain("'USINAGE'");
    expect(activity).toContain("is_productive = true");
    expect(statements.some((sql) => sql.includes("planning_resource_calendars"))).toBe(true);
    expect(query.mock.calls[4][1]).toEqual([seed.REFERENCE.calendarId, 42]);
  });

  it("upserts a current applicable gamme and a positive machine operation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("LEFT JOIN public.pieces_techniques_operations")) return { rows: [] };
      if (sql.includes("SELECT id FROM public.pieces_techniques_operations")) return { rows: [] };
      if (sql.includes("SELECT id FROM public.gammes")) return { rows: [] };
      return { rows: [] };
    });
    await seed.ensureApplicableGamme({ query }, input, 42);
    expect(query).toHaveBeenCalledTimes(7);
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toContain("statut = 'APPLICABLE'");
    expect(statements[1]).toContain("LEFT JOIN public.pieces_techniques_operations");
    expect(statements[4]).toContain("INSERT INTO public.gammes");
    expect(statements[5]).toContain("INSERT INTO public.pieces_techniques_operations");
    expect(statements[6]).toContain("UPDATE public.stock_levels");
    const operationParams = query.mock.calls[5][1] as unknown[];
    expect(operationParams).toContain(input.machine_id);
    expect(operationParams).toContain(42);
  });

  it("does not update an already applicable immutable fixture", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("LEFT JOIN public.pieces_techniques_operations")) return { rowCount: 1, rows: [{
        piece_technique_version_id: input.version_id, gamme_status: "APPLICABLE", gamme_current: true,
        operation_id: input.operationId, operation_gamme_id: input.gammeId,
        phase: 10, machine_id: input.machine_id, cf_id: seed.REFERENCE.costCenterId, machine_family_code: "F", tf_unit: 0.25, temps_fabrication: 0.25, temps_total: 0.35,
      }] };
      return { rows: [] };
    });
    await seed.ensureApplicableGamme({ query }, { ...input, version_status: "APPLICABLE" }, 42);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toContain("LEFT JOIN public.pieces_techniques_operations");
  });

  it("rejects a fixture that would bypass production readiness", async () => {
    const query = vi.fn(async () => ({ rows: [{
      version_status: "BROUILLON", version_current: true, gamme_status: "APPLICABLE", gamme_current: true,
      phase: 10, machine_id: input.machine_id, cf_id: seed.REFERENCE.costCenterId, machine_family_code: "F", tf_unit: 0.25, temps_fabrication: 0.25, temps_total: 0.35,
    }] }));
    await expect(seed.assertPresentationFixture({ query }, [input])).rejects.toThrow(/readiness prerequisites invalid/);
  });

  it("requires zero finished stock and positive synthetic material stock", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        version_status: "APPLICABLE", version_current: true, gamme_status: "APPLICABLE", gamme_current: true,
        phase: 10, machine_id: input.machine_id, cf_id: seed.REFERENCE.costCenterId, machine_family_code: "F", tf_unit: 0.25, temps_fabrication: 0.25, temps_total: 0.35,
      }] })
      .mockResolvedValueOnce({ rows: [{ finished_qty: "0" }] })
      .mockResolvedValueOnce({ rows: [{ material_qty: "240" }] });
    await expect(seed.assertPresentationFixture({ query }, [input])).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3);
  });
});
