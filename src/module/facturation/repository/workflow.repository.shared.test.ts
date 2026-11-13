import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { HttpError } from "../../../utils/httpError";
import { assertFinancialCutoverEmissionAllowedTx } from "./financial-cutover-guard";
vi.mock("./financial-cutover-guard", () => ({
  assertFinancialCutoverEmissionAllowedTx: vi.fn().mockResolvedValue({ phase: "IDLE" }),
}));
import {
  acquireFinanceIdempotency,
  activateCutoverFinanceSharedSeriesTx,
  allocateLegalNumber,
  type DbQueryer,
  requireFinanceIssuerSnapshotAt,
} from "./workflow.repository.shared";

const COMPLETE_ISSUER = {
  entity_code: "b7c1e5a2-3f4d-4e8b-9a06-380569012000",
  company_name: "CROIX ROUSSE PRECISION",
  legal_mentions_version: 1,
  legal_form: "SARL",
  share_capital: "21000.00",
  share_capital_currency: "EUR",
  rcs_city: "Bourg-en-Bresse",
  rcs_number: "380 569 012",
  siret: "380 569 012 00020",
  vat_number: "FR73 380 569 012",
  late_penalty_rate: "12.500",
  late_penalty_basis: "ANNUEL",
  recovery_indemnity: "40.00",
};

function queryerReturning(snapshot: Record<string, unknown> | null): DbQueryer {
  return {
    query: vi.fn().mockResolvedValue({ rows: snapshot ? [{ snapshot }] : [] }),
  } as unknown as DbQueryer;
}

describe("requireFinanceIssuerSnapshotAt", () => {
  it("returns the complete legal snapshot used by the immutable document", async () => {
    await expect(
      requireFinanceIssuerSnapshotAt(
        queryerReturning(COMPLETE_ISSUER),
        COMPLETE_ISSUER.entity_code,
        "2026-07-29"
      )
    ).resolves.toEqual(COMPLETE_ISSUER);
  });

  it("fails explicitly when the legal entity does not exist", async () => {
    const error = await requireFinanceIssuerSnapshotAt(
      queryerReturning(null),
      COMPLETE_ISSUER.entity_code,
      "2026-07-29"
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 503,
      code: "FINANCE_ISSUER_NOT_CONFIGURED",
    });
  });

  it("fails before issuance when a mandatory legal field is missing", async () => {
    const { recovery_indemnity: _missing, ...incomplete } = COMPLETE_ISSUER;
    const error = await requireFinanceIssuerSnapshotAt(
      queryerReturning(incomplete),
      COMPLETE_ISSUER.entity_code,
      "2026-07-29"
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 503,
      code: "FINANCE_LEGAL_MENTIONS_NOT_CONFIGURED",
      details: { missing: ["recovery_indemnity"] },
    });
  });
});

describe("finance workflow idempotency race guard", () => {
  it("takes the transaction advisory lock before reading a competing receipt", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public.finance_command_receipts")) return { rows: [] };
      if (sql.includes("fn_lock_delivery_prepayment_write_1268")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query } as unknown as PoolClient;

    const result = await acquireFinanceIdempotency({
      client,
      actor: { userId: 7, requestId: "request-1", path: "/factures/workflow/drafts" },
      idempotencyKeyRaw: "facture-attempt-001",
      commandType: "FACTURE_DRAFT_CREATE",
      requestPayload: { preview_hash: "a".repeat(64) },
    });

    expect(result.replay).toBeNull();
    expect(String(query.mock.calls[0]?.[0])).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[0]?.[1]).toEqual(["finance:7:facture-attempt-001"]);
    expect(String(query.mock.calls[1]?.[0])).toContain("finance_command_receipts");
    expect(String(query.mock.calls[2]?.[0])).toContain("fn_lock_delivery_prepayment_write_1268");
  });

  it("rejects the same actor/key with a different command payload (409)", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public.finance_command_receipts")) {
        return { rows: [{ request_hash: "different", result_payload: { id: 42 } }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(acquireFinanceIdempotency({
      client: { query } as unknown as PoolClient,
      actor: { userId: 7, requestId: "request-2", path: "/factures/workflow/drafts" },
      idempotencyKeyRaw: "facture-attempt-001",
      commandType: "FACTURE_DRAFT_CREATE",
      requestPayload: { preview_hash: "b".repeat(64) },
    })).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
  });
});

describe("cutover finance common series", () => {
  it("uses one atomic series for invoices and credit notes only when it is active", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ relation: "public.cutover_finance_shared_sequences" }] };
      if (sql.includes("cutover_finance_shared_sequences")) {
        return { rows: [{ allocated_value: "5412", facture_prefix: "FV-26-", avoir_prefix: "AV-26-", padding: 5 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    await expect(allocateLegalNumber({ client: { query } as unknown as PoolClient, documentType: "FACTURE", entityCode: "CRP", issueDate: "2026-10-20" }))
      .resolves.toEqual({ legalNumber: "FV-26-05412", periodKey: "2026", sequenceValue: 5412 });
    await expect(allocateLegalNumber({ client: { query } as unknown as PoolClient, documentType: "AVOIR", entityCode: "CRP", issueDate: "2026-10-20" }))
      .resolves.toEqual({ legalNumber: "AV-26-05412", periodKey: "2026", sequenceValue: 5412 });
    expect(
      query.mock.calls
        .filter(([sql]) => String(sql).includes("cutover_finance_shared_sequences"))
        .every(([sql]) => String(sql).includes("SET next_value = next_value + 1")),
    ).toBe(true);
  });

  it("falls back to the existing independent finance configuration while the common series is inactive", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ relation: "public.cutover_finance_shared_sequences" }] };
      if (sql.includes("cutover_finance_shared_sequences")) return { rows: [] };
      if (sql.includes("FROM public.finance_legal_sequences")) return { rows: [{ id: "legacy", prefix: "FAC-", next_value: "9", padding: 4 }] };
      if (sql.includes("UPDATE public.finance_legal_sequences")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    await expect(allocateLegalNumber({ client: { query } as unknown as PoolClient, documentType: "FACTURE", entityCode: "CRP", issueDate: "2026-10-20" }))
      .resolves.toEqual({ legalNumber: "FAC-0009", periodKey: "2026", sequenceValue: 9 });
  });

  it("does not fall back to independent legal series after the shared cutover becomes active for another period", async () => {
    vi.mocked(assertFinancialCutoverEmissionAllowedTx).mockResolvedValueOnce({ phase: "ACTIVE" });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ relation: "public.cutover_finance_shared_sequences" }] };
      if (sql.includes("cutover_finance_shared_sequences")) return { rows: [] };
      if (sql.includes("finance_legal_sequences")) throw new Error("legacy fallback must not run after activation");
      throw new Error(`Unexpected query: ${sql}`);
    });
    await expect(allocateLegalNumber({ client: { query } as unknown as PoolClient, documentType: "FACTURE", entityCode: "CRP", issueDate: "2027-01-02" }))
      .rejects.toMatchObject({ status: 409, code: "FINANCIAL_CUTOVER_SHARED_SERIES_PERIOD_REQUIRED" });
  });

  it("refuses automatic activation when a legacy legal sequence must be reviewed", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.finance_legal_sequences")) return { rows: [{ document_type: "AVOIR" }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    await expect(activateCutoverFinanceSharedSeriesTx({
      client: { query } as unknown as PoolClient,
      entityCode: "CRP", periodKey: "2026", nextValue: 5412,
      facturePrefix: "FV-26-", avoirPrefix: "AV-26-", padding: 5,
      actorId: 7, evidenceReference: "balance-validated-2026-10-20",
    })).rejects.toMatchObject({ code: "CUTOVER_FINANCE_LEGACY_SEQUENCE_REVIEW_REQUIRED" });
  });
});
