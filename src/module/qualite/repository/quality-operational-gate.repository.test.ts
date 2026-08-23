import { describe, expect, it, vi } from "vitest";

import {
  assertOperationalLotQualityEligibility,
  recordDirectLotQualityConsumption,
} from "./quality-operational-gate.repository";

const LOT_ID = "00000000-0000-4000-8000-000000000616";

function queryClient(input: {
  status?: "LIBERE" | "EN_ATTENTE" | "QUARANTAINE" | "BLOQUE";
  released?: number;
  consumed?: number;
  pending?: boolean;
  openNc?: number;
  committed?: number;
  articleUnit?: string | null;
  controlUnit?: string | null;
  concession?: { status: string; valid_to: string | null } | null;
}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM public.lots")) return { rows: [{ lot_code: "LOT-616", lot_status: input.status ?? "LIBERE", article_unit: input.articleUnit ?? "PCS" }] };
    if (sql.includes("FROM public.quality_control qc")) {
      return {
        rows: [{ id: "00000000-0000-4000-8000-000000000001", qty_released: String(input.released ?? 10), qty_held: "0", qty_consumed: String(input.consumed ?? 0), unite: input.controlUnit ?? "PCS", pending: input.pending ?? false }],
      };
    }
    if (sql.includes("FROM public.stock_reservations")) return input.committed ? { rows: [{ qty: String(input.committed) }] } : { rows: [] };
    if (sql.includes("FROM public.non_conformity nc")) return { rows: [{ total: input.openNc ?? 0 }] };
    if (sql.includes("FROM public.quality_release_decision")) {
      return { rows: input.concession ? [{ decision_id: "00000000-0000-4000-8000-000000000002", derogation_id: "00000000-0000-4000-8000-000000000003" }] : [] };
    }
    if (sql.includes("FROM public.quality_derogation")) return { rows: input.concession ? [input.concession] : [] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { query };
}

describe("operational Quality 360 gate", () => {
  it("allows a released, controlled lot and retains immutable evidence ids", async () => {
    const client = queryClient({ released: 10 });
    const decision = await assertOperationalLotQualityEligibility({
      client: client as never,
      lotId: LOT_ID,
      qty: 5,
      purpose: "RESERVE",
    });
    expect(decision.target.qty_released).toBe(10);
    expect(decision.evidence.control_ids).toHaveLength(1);
    expect(decision.evidence.release_decision_ids).toEqual([]);
    const sql = client.query.mock.calls.map(([statement]) => String(statement));
    expect(sql.find((statement) => statement.includes("FROM public.lots"))).toContain("FOR UPDATE");
    const controlSql = sql.find((statement) => statement.includes("FROM public.quality_control qc"));
    expect(controlSql).toContain("LIMIT 1");
    expect(controlSql).toContain("FOR UPDATE");
  });

  it("keeps an approved, in-scope concession auditable without weakening the release ledger", async () => {
    const decision = await assertOperationalLotQualityEligibility({
      client: queryClient({ concession: { status: "APPROVED", valid_to: "2999-01-01T00:00:00.000Z" } }) as never,
      lotId: LOT_ID, qty: 5, purpose: "RESERVE",
    });
    expect(decision.evidence.derogation_ids).toEqual(["00000000-0000-4000-8000-000000000003"]);
  });

  it.each([
    [{ status: "QUARANTAINE" as const }, "LOT_QUARANTINE"],
    [{ status: "BLOQUE" as const }, "LOT_NOT_RELEASED"],
    [{ pending: true }, "MANDATORY_CONTROL_PENDING"],
    [{ openNc: 1 }, "OPEN_NON_CONFORMITY"],
    [{ released: 2 }, "QTY_NOT_RELEASED"],
  ])("fails closed for %o", async (input, expectedCode) => {
    await expect(assertOperationalLotQualityEligibility({
      client: queryClient(input) as never, lotId: LOT_ID, qty: 5, purpose: "RESERVE",
    })).rejects.toMatchObject({ code: "QUALITY_NOT_ELIGIBLE", details: { blocks: expect.arrayContaining([expect.objectContaining({ code: expectedCode })]) } });
  });

  it("fails an expired concession even when the quantity is released", async () => {
    await expect(assertOperationalLotQualityEligibility({
      client: queryClient({ concession: { status: "APPROVED", valid_to: "2000-01-01T00:00:00.000Z" } }) as never,
      lotId: LOT_ID, qty: 5, purpose: "RESERVE",
    })).rejects.toMatchObject({ code: "QUALITY_NOT_ELIGIBLE", details: { blocks: expect.arrayContaining([expect.objectContaining({ code: "DEROGATION_EXPIRED" })]) } });
  });

  it("treats active and already-consumed reservations as finite release commitments", async () => {
    await expect(assertOperationalLotQualityEligibility({
      client: queryClient({ released: 10, committed: 7 }) as never,
      lotId: LOT_ID, qty: 5, purpose: "RESERVE",
    })).rejects.toMatchObject({
      code: "QUALITY_NOT_ELIGIBLE",
      details: { blocks: expect.arrayContaining([expect.objectContaining({ code: "QTY_NOT_RELEASED" })]) },
    });
  });

  it("rejects a stock write whose unit is incompatible with the lot article", async () => {
    await expect(assertOperationalLotQualityEligibility({
      client: queryClient({ articleUnit: "KG" }) as never,
      lotId: LOT_ID, qty: 1, unit: "PCS", purpose: "RESERVE",
    })).rejects.toMatchObject({ code: "QUALITY_UNIT_MISMATCH" });
  });

  it("persists a direct OUT against the locked current control so later unreserved OUTs cannot reuse capacity", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "00000000-0000-4000-8000-000000000001" }] }));
    const decision = {
      purpose: "RESERVE" as const,
      target: { object_type: "LOT" as const, object_id: LOT_ID, label: "LOT-616", qty_requested: 4, lot_status: "LIBERE" as const, qty_released: 10, qty_held: 0, qty_consumed: 0, open_nc_without_disposition: 0, pending_mandatory_controls: 0, derogation: null },
      already_committed_qty: 0,
      evaluated_at: "2026-08-23T00:00:00.000Z",
      evidence: { control_ids: ["00000000-0000-4000-8000-000000000001"], release_decision_ids: [], derogation_ids: [] },
    };
    await recordDirectLotQualityConsumption({ client: { query } as never, decision, qty: 4 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET qty_consumed = qty_consumed + $2"), ["00000000-0000-4000-8000-000000000001", 4]);
  });

  it("fails closed rather than recording direct consumption without an evaluated control", async () => {
    await expect(recordDirectLotQualityConsumption({
      client: { query: vi.fn() } as never,
      decision: {
        purpose: "RESERVE", target: { object_type: "LOT", object_id: LOT_ID, label: "LOT-616", qty_requested: 1, lot_status: "LIBERE", qty_released: 1, qty_held: 0, qty_consumed: 0, open_nc_without_disposition: 0, pending_mandatory_controls: 0, derogation: null },
        already_committed_qty: 0, evaluated_at: "2026-08-23T00:00:00.000Z",
        evidence: { control_ids: [], release_decision_ids: [], derogation_ids: [] },
      },
      qty: 1,
    })).rejects.toMatchObject({ code: "QUALITY_CONTROL_MISSING" });
  });
});
