import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  assertInvoiceCreditWithinBalance,
  lockInvoiceSettlement,
  refreshInvoiceSettlementStates,
} from "./invoice-settlement.repository";

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    client_id: "001",
    currency: "EUR",
    statut: "emise",
    document_status: "ISSUED",
    settlement_status: "UNPAID",
    total_ttc: "100.00",
    allocated_payment_ttc: "20.00",
    legacy_direct_payment_ttc: "30.00",
    consumed_credit_ttc: "10.00",
    legacy_direct_credit_ttc: "5.00",
    ...overrides,
  };
}

describe("#469 invoice settlement repository", () => {
  it("additionne allocations modernes et preuves directes historiques sans changer de source", async () => {
    const query = vi.fn(async (_sqlValue: unknown) => ({ rows: [invoiceRow()], rowCount: 1 }));
    const invoice = await lockInvoiceSettlement(
      { query } as unknown as Pick<PoolClient, "query">,
      42
    );

    expect(invoice?.settledCents).toBe(6_500n);
    expect(invoice?.settledAmount).toBe("65.00");
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("legacy_direct_payment_ttc");
    expect(sql).toContain("legacy_direct_credit_ttc");
    expect(sql.match(/NOT EXISTS/g)).toHaveLength(2);
  });

  it("refuse un avoir qui dépasserait le solde économique unifié", async () => {
    const query = vi.fn(async () => ({
      rows: [invoiceRow({
        allocated_payment_ttc: "20.00",
        legacy_direct_payment_ttc: "70.00",
        consumed_credit_ttc: "0.00",
        legacy_direct_credit_ttc: "0.00",
      })],
      rowCount: 1,
    }));
    const invoice = await lockInvoiceSettlement(
      { query } as unknown as Pick<PoolClient, "query">,
      42
    );

    expect(() => assertInvoiceCreditWithinBalance(invoice!, 1_100n)).toThrowError(
      expect.objectContaining({
        status: 409,
        code: "AVOIR_INVOICE_BALANCE_EXCEEDED",
      })
    );
  });

  it("projette et audite une facture historique émise avec la même transaction", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const query = vi.fn(async (sqlValue: unknown, values?: unknown[]) => {
      const sql = String(sqlValue);
      calls.push({ sql, values });
      if (sql.includes("FROM public.facture f")) {
        return {
          rows: [invoiceRow({
            allocated_payment_ttc: "0.00",
            legacy_direct_payment_ttc: "25.00",
            consumed_credit_ttc: "0.00",
            legacy_direct_credit_ttc: "0.00",
          })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await refreshInvoiceSettlementStates({
      client: { query } as unknown as PoolClient,
      factureIds: [42],
      actor: { userId: 7, requestId: "req-469", path: "/facturation/avoirs/1/issue" },
      correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: "idempotency-469",
    });

    const update = calls.find((call) => call.sql.includes("UPDATE public.facture"));
    expect(update?.values).toEqual([
      42,
      "PARTIALLY_PAID",
      "PARTIALLY_PAID",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(calls.some((call) => call.sql.includes("public.finance_event_log"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("INSERT INTO erp_audit_logs"))).toBe(true);
  });
});
