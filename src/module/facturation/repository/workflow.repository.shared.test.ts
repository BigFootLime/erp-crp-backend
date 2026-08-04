import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { HttpError } from "../../../utils/httpError";
import {
  acquireFinanceIdempotency,
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
