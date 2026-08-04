import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolConnect: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.poolConnect },
}));

import { lockInvoiceSettlement } from "./invoice-settlement.repository";
import { repoAllocatePayment } from "./payment-workflow.repository";

describe("#469 direct legacy payment immutability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["sa facture d'origine", "1"],
    ["une autre facture", "2"],
  ])("refuse toute allocation vers %s avant insertion", async (_label, targetId) => {
    const sqlCalls: string[] = [];
    const query = vi.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      sqlCalls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM public.finance_command_receipts")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM public.paiement") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: 7,
            uuid: "77777777-7777-4777-8777-777777777777",
            code: "PAY-LEGACY-7",
            facture_id: 1,
            client_id: "001",
            montant: "100.00",
            currency: "EUR",
            status: "UNALLOCATED",
            row_version: 1,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM public.paiement_allocations")) {
        return {
          rows: [{ amount: "0.00", allocation_count: 0 }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const release = vi.fn();
    mocks.poolConnect.mockResolvedValue({ query, release });

    await expect(repoAllocatePayment({
      paymentId: 7,
      input: {
        expected_version: 1,
        allocations: [{ target_type: "FACTURE", target_id: targetId, amount: "20.00" }],
      },
      actor: { userId: 9, requestId: "req-legacy-469", path: "/payments/7/allocate" },
      idempotencyKey: `legacy-direct-${targetId}-immutable`,
    })).rejects.toMatchObject({
      status: 409,
      code: "PAYMENT_LEGACY_DIRECT_IMMUTABLE",
    });

    expect(sqlCalls).toContain("ROLLBACK");
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO public.paiement_allocations"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("FROM public.facture f"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("conserve les 100 EUR comme solde réglé de la facture d'origine", async () => {
    const query = vi.fn(async (_sqlValue: unknown) => ({
      rows: [{
        id: 1,
        uuid: null,
        client_id: "001",
        currency: "EUR",
        statut: "emise",
        document_status: "LEGACY",
        settlement_status: "PAID",
        total_ttc: "100.00",
        allocated_payment_ttc: "0.00",
        legacy_direct_payment_ttc: "100.00",
        consumed_credit_ttc: "0.00",
        legacy_direct_credit_ttc: "0.00",
      }],
      rowCount: 1,
    }));

    const invoice = await lockInvoiceSettlement(
      { query } as unknown as Pick<PoolClient, "query">,
      1
    );

    expect(invoice?.settledCents).toBe(10_000n);
    expect(invoice?.settledAmount).toBe("100.00");
    expect(String(query.mock.calls[1]?.[0])).toContain(
      "existing_payment_allocation.paiement_id = p.id"
    );
  });
});
