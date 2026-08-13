import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), audit: vi.fn() }));

vi.mock("../../../config/database", () => ({
  default: { query: mocks.query, connect: mocks.connect },
}));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));

import {
  repoCreateStockIntelligencePolicy,
  repoSimulateStockIntelligence,
} from "./stock-intelligence.repository";

const ARTICLE = "11111111-1111-4111-8111-111111111111";
const MAGASIN = "22222222-2222-4222-8222-222222222222";

describe("SOL-19 stock intelligence repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audit.mockResolvedValue({ id: "audit-sol19" });
  });

  it("runs a replenishment simulation through SELECT-only evidence reads", async () => {
    const readQuery = vi.fn(async (sql: unknown) => {
      const statement = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(statement)) return { rows: [] };
      if (statement.includes("AS installed")) return { rows: [{ installed: true }] };
      if (statement.includes("FROM public.stock_intelligence_policy_versions")) return { rows: [] };
      if (statement.includes("FROM public.stock_levels sl") && statement.includes("qty_quarantine")) {
        return { rows: [{
          key: `${ARTICLE}:${MAGASIN}`,
          article_id: ARTICLE,
          article_code: "MAT-001",
          article_designation: "Acier test",
          magasin_id: MAGASIN,
          magasin_name: "Matières",
          stock_unit: "kg",
          qty_on_hand: 10,
          qty_reserved: 12,
          qty_quarantine: 0,
          qty_blocked: 0,
          qty_depreciated: 0,
          qty_available: 0,
          freshness_at: "2026-08-13T08:00:00.000Z",
        }] };
      }
      if (statement.includes("WITH movement_cost")) {
        return { rows: [{
          key: `${ARTICLE}:${MAGASIN}`,
          outbound_qty_abc: 40,
          outbound_value_abc: 400,
          outbound_qty_coverage: 20,
          last_outbound_at: "2026-08-10T08:00:00.000Z",
          latest_applied_unit_cost: 10,
          cost_currency: "EUR",
          unpriced_movement_count: 0,
          currency_count: 1,
          freshness_at: "2026-08-13T08:00:00.000Z",
        }] };
      }
      if (statement.includes("FROM public.stock_reservations reservation")) {
        return { rows: [{
          key: `${ARTICLE}:${MAGASIN}`,
          reservation_id: "33333333-3333-4333-8333-333333333333",
          qty: 12,
          need_date: "2026-08-20",
          of_id: "42",
          of_number: "OF-42",
          source_type: "OF",
          updated_at: "2026-08-13T08:00:00.000Z",
        }] };
      }
      if (statement.includes("FROM public.commande_fournisseur_ligne line")) return { rows: [] };
      if (statement.includes("WITH latest_count")) return { rows: [] };
      if (statement.includes("FROM public.replenishment_proposals proposal")) return { rows: [] };
      throw new Error(`Unexpected SQL in SOL-19 test: ${statement.slice(0, 100)}`);
    });
    const client = { query: readQuery, release: vi.fn() } as unknown as PoolClient;
    mocks.connect.mockResolvedValue(client);

    const result = await repoSimulateStockIntelligence({
      as_of: "2026-08-13",
      article_id: ARTICLE,
      magasin_id: MAGASIN,
      weeks: 13,
      proposed_stock_qty: 5,
      expected_receipt_date: "2026-08-19",
    });

    expect(result.write_performed).toBe(false);
    expect(result.projection.shortage_without_proposal).toBe("2026-08-20");
    expect(result.projection.shortage_with_proposal).toBeNull();
    expect(result.projection.points[0].simulated_receipt_qty).toBe(5);
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(readQuery).toHaveBeenCalledWith("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(readQuery).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
    for (const [sql] of readQuery.mock.calls) {
      expect(String(sql)).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
    }
  });

  it("persists one audited policy version and an idempotency receipt", async () => {
    mocks.query.mockResolvedValue({ rows: [{ installed: true }] });
    const clientQuery = vi.fn(async (sql: unknown) => {
      const statement = String(sql);
      if (statement.includes("FROM public.stock_intelligence_command_receipts")) return { rows: [] };
      if (statement.includes("INSERT INTO public.stock_intelligence_policy_versions")) {
        return { rows: [{ id: "44444444-4444-4444-8444-444444444444", created_at: "2026-08-13T09:00:00.000Z" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    mocks.connect.mockResolvedValue(client);
    const input = {
      valid_from: "2026-09-01",
      abc_lookback_days: 365,
      abc_a_cumulative_pct: 80,
      abc_b_cumulative_pct: 95,
      dormant_after_days: 180,
      consumption_lookback_days: 91,
      coverage_weeks: 13,
      inventory_tolerance_pct: 0.5,
      inventory_absolute_tolerance_qty: 0.001,
      reason: "Décision Direction SOL-19",
    };

    await expect(repoCreateStockIntelligencePolicy({
      input,
      actor: {
        user_id: 17,
        role: "Directeur",
        ip: "127.0.0.1",
        user_agent: "vitest",
        path: "/stock/intelligence/policies",
        page_key: "stock-replenishment",
        client_session_id: "sol19",
      },
      idempotencyKey: "sol19-policy-0001",
    })).resolves.toMatchObject({ ...input, idempotent_replay: false });

    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.stock_intelligence_policy_versions"))).toHaveLength(1);
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.stock_intelligence_command_receipts"))).toHaveLength(1);
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(clientQuery).toHaveBeenCalledWith("COMMIT");
  });
});
