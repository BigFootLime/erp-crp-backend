import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { resolveAndValidateAllocations } from "./payment-workflow.repository";

describe("#469 payment allocation lock ordering", () => {
  it("verrouille toutes les factures par id croissant avant les échéances", async () => {
    const lockOrder: string[] = [];
    const query = vi.fn(async (sqlValue: unknown, values?: unknown[]) => {
      const sql = String(sqlValue);
      if (sql.includes("FROM public.facture_echeance") && !sql.includes("amount_due")) {
        return {
          rows: [{ id: "11111111-1111-4111-8111-111111111111", facture_id: 1 }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM public.facture f") && sql.includes("FOR UPDATE")) {
        const factureId = Number(values?.[0]);
        lockOrder.push(`facture:${factureId}`);
        return {
          rows: [{
            id: factureId,
            uuid: null,
            client_id: "001",
            currency: "EUR",
            statut: "ISSUED",
            document_status: "ISSUED",
            settlement_status: "UNPAID",
            total_ttc: "100.00",
            allocated_payment_ttc: "0.00",
            legacy_direct_payment_ttc: "0.00",
            consumed_credit_ttc: "0.00",
            legacy_direct_credit_ttc: "0.00",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM public.facture f")) {
        return {
          rows: [{
            allocated_payment_ttc: "0.00",
            legacy_direct_payment_ttc: "0.00",
            consumed_credit_ttc: "0.00",
            legacy_direct_credit_ttc: "0.00",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM public.facture_echeance") && sql.includes("amount_due")) {
        lockOrder.push("echeance:1");
        return {
          rows: [{
            id: "11111111-1111-4111-8111-111111111111",
            facture_id: 1,
            amount_due: "100.00",
            amount_allocated: "0.00",
            status: "OPEN",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const resolved = await resolveAndValidateAllocations({
      client: { query } as unknown as PoolClient,
      clientId: "001",
      currency: "EUR",
      paymentAvailableCents: 2_000n,
      allocations: [
        { target_type: "FACTURE", target_id: "2", amount: "10.00" },
        {
          target_type: "ECHEANCE",
          target_id: "11111111-1111-4111-8111-111111111111",
          amount: "10.00",
        },
      ],
    });

    expect(resolved).toHaveLength(2);
    expect(lockOrder).toEqual(["facture:1", "facture:2", "echeance:1"]);
  });

  it("includes a direct pre-#227 payment in the invoice balance cap", async () => {
    const query = vi.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("FROM public.facture f") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: 1,
            uuid: null,
            client_id: "001",
            currency: "EUR",
            statut: "emise",
            document_status: "LEGACY",
            settlement_status: "UNPAID",
            total_ttc: "100.00",
            allocated_payment_ttc: "0.00",
            legacy_direct_payment_ttc: "90.00",
            consumed_credit_ttc: "0.00",
            legacy_direct_credit_ttc: "0.00",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM public.facture f")) {
        return {
          rows: [{
            allocated_payment_ttc: "0.00",
            legacy_direct_payment_ttc: "90.00",
            consumed_credit_ttc: "0.00",
            legacy_direct_credit_ttc: "0.00",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(resolveAndValidateAllocations({
      client: { query } as unknown as PoolClient,
      clientId: "001",
      currency: "EUR",
      paymentAvailableCents: 1_100n,
      allocations: [{ target_type: "FACTURE", target_id: "1", amount: "11.00" }],
    })).rejects.toMatchObject({
      status: 409,
      code: "PAYMENT_INVOICE_BALANCE_EXCEEDED",
    });
  });

  it("autorise un paiement de remplacement après exclusion des preuves rejetées ou inversées", async () => {
    const evidenceSql: string[] = [];
    const query = vi.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("FROM public.facture f") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: 1,
            uuid: null,
            client_id: "001",
            currency: "EUR",
            statut: "ISSUED",
            document_status: "ISSUED",
            settlement_status: "UNPAID",
            total_ttc: "100.00",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM public.facture f")) {
        evidenceSql.push(sql);
        return {
          rows: [{
            allocated_payment_ttc: "0.00",
            legacy_direct_payment_ttc: "0.00",
            consumed_credit_ttc: "0.00",
            legacy_direct_credit_ttc: "0.00",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(resolveAndValidateAllocations({
      client: { query } as unknown as PoolClient,
      clientId: "001",
      currency: "EUR",
      paymentAvailableCents: 10_000n,
      allocations: [{ target_type: "FACTURE", target_id: "1", amount: "100.00" }],
    })).resolves.toHaveLength(1);

    expect(evidenceSql[0]).toContain("allocated_payment.status NOT IN ('REJECTED','REVERSED')");
    expect(evidenceSql[0]).toContain("p.status NOT IN ('REJECTED','REVERSED')");
  });
});
