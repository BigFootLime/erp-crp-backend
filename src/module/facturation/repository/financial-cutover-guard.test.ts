import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import {
  activateFinancialCutoverEmissionTx,
  assertFinancialCutoverEmissionAllowedTx,
  getFinancialCutoverStatusTx,
  startFinancialCutoverPreparationTx,
} from "./financial-cutover-guard";

function clientFor(phase: "IDLE" | "PREPARING" | "ACTIVE", extras: { common?: boolean; collision?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("to_regclass")) return { rows: [{ relation: "financial_cutover_gate" }] };
    if (sql.includes("FROM public.financial_cutover_gate")) return { rows: [{ phase }] };
    if (sql.includes("to_char(CURRENT_DATE")) return { rows: [{ year: "2026" }] };
    if (sql.includes("cutover_finance_shared_sequences")) return { rows: extras.common === false ? [] : [{ "?column?": 1 }] };
    if (sql.includes("FROM public.proforma_client_reference_seq")) return { rows: [{ next_value: extras.collision ? "48" : "1", max_consumed: extras.collision ? "47" : null }] };
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, query };
}

describe("financial cutover gate", () => {
  it("keeps normal issuance unchanged while the durable gate is IDLE", async () => {
    const { client, query } = clientFor("IDLE");
    await expect(assertFinancialCutoverEmissionAllowedTx(client)).resolves.toEqual({ phase: "IDLE" });
    expect(String(query.mock.calls[1]?.[0])).toContain("FOR SHARE");
  });

  it("suspends every financial emission during preparation without a generic server failure", async () => {
    const { client } = clientFor("PREPARING");
    await expect(assertFinancialCutoverEmissionAllowedTx(client)).rejects.toMatchObject({
      status: 409,
      code: "FINANCIAL_CUTOVER_SUSPENDED",
    });
  });

  it("fails closed if the deployment did not install the guard", async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ relation: null }] })) } as unknown as PoolClient;
    await expect(assertFinancialCutoverEmissionAllowedTx(client)).rejects.toMatchObject({
      status: 503,
      code: "FINANCIAL_CUTOVER_GUARD_NOT_INSTALLED",
    });
  });

  it("serializes the first preparation transition and never moves an active cutover backwards", async () => {
    const first = clientFor("IDLE");
    await expect(startFinancialCutoverPreparationTx(first.client, { actorId: 7, batchId: "11111111-1111-4111-8111-111111111111" }))
      .resolves.toEqual({ phase: "PREPARING" });
    expect(first.query.mock.calls.some(([sql]) => String(sql).includes("FOR UPDATE"))).toBe(true);
    expect(first.query.mock.calls.some(([sql]) => String(sql).includes("PREPARATION_STARTED"))).toBe(true);

    const active = clientFor("ACTIVE");
    await expect(startFinancialCutoverPreparationTx(active.client, { actorId: 7, batchId: "11111111-1111-4111-8111-111111111111" }))
      .resolves.toEqual({ phase: "ACTIVE" });
    expect(active.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE public.financial_cutover_gate"))).toBe(false);
  });

  it("activates only after the common series exists and the proforma sequence cannot go backward", async () => {
    const { client, query } = clientFor("PREPARING", { common: true });
    await expect(activateFinancialCutoverEmissionTx(client, {
      actorId: 7, entityCode: "CRP", periodKey: "2026", proformaNextValue: 47, evidenceReference: "controle-veille",
    })).resolves.toBeUndefined();
    expect(query.mock.calls.some((call) => String(call[0]).includes("setval") && (call as unknown as [string, unknown[]])[1]?.[0] === 47)).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("'ACTIVE'"))).toBe(true);

    const collision = clientFor("PREPARING", { common: true, collision: true });
    await expect(activateFinancialCutoverEmissionTx(collision.client, {
      actorId: 7, entityCode: "CRP", periodKey: "2026", proformaNextValue: 47, evidenceReference: "controle-veille",
    })).rejects.toMatchObject({ status: 409, code: "FINANCIAL_CUTOVER_PROFORMA_SEQUENCE_BACKWARD" });
    expect(collision.query.mock.calls.some(([sql]) => String(sql).includes("setval"))).toBe(false);
  });

  it("exposes the durable status for capabilities without changing it", async () => {
    const { client } = clientFor("ACTIVE");
    await expect(getFinancialCutoverStatusTx(client)).resolves.toEqual({ phase: "ACTIVE" });
  });
});
