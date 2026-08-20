import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect, query: vi.fn() },
}));

vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: mocks.audit,
}));

import { repoCancelOrder } from "./commercial-reliability.repository";
import { commercialPayloadHash } from "../domain/commercial-reliability";

const actor = {
  user_id: 17,
  role: "Directeur",
  ip: "127.0.0.1",
  user_agent: "vitest",
  path: "/reporting/commercial/reliability/orders/9/cancel",
  page_key: "commercial-reliability",
  client_session_id: "sol17-session",
};

function createClient(options: {
  currentStatus?: string;
  downstreamBlocked?: boolean;
  receipt?: { request_hash: string; response_snapshot: Record<string, unknown> } | null;
} = {}) {
  const state = {
    currentStatus: options.currentStatus ?? "EN_ANALYSE",
    downstreamBlocked: options.downstreamBlocked ?? false,
    receipt: options.receipt ?? null,
  };
  const query = vi.fn(async (sql: unknown) => {
    const statement = String(sql);
    if (statement.includes("FROM public.commercial_command_receipts")) {
      return { rows: state.receipt ? [state.receipt] : [] };
    }
    if (statement.includes("FROM public.commande_client WHERE")) {
      return { rows: [{ id: "9", numero: "CMD-0009" }] };
    }
    if (statement.includes("FROM public.commande_historique")) {
      return { rows: [{ nouveau_statut: state.currentStatus }] };
    }
    if (statement.includes("FROM public.bon_livraison") && statement.includes("AS blocked")) {
      return { rows: [{ blocked: state.downstreamBlocked }] };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { client, query, state };
}

function cancel(idempotencyKey = "sol17-order-cancel-0001") {
  return repoCancelOrder({
    commandeId: 9,
    input: { reason_code: "CUSTOMER_CANCELLED", note: "Confirmation client" },
    actor,
    idempotencyKey,
  });
}

describe("SOL-17 order cancellation transaction", () => {
  beforeEach(() => {
    mocks.connect.mockReset();
    mocks.audit.mockReset();
    mocks.audit.mockResolvedValue({ id: "audit-sol17" });
  });

  it("records one cancellation, workflow event, audit and receipt in the same transaction", async () => {
    const { client, query } = createClient();
    mocks.connect.mockResolvedValue(client);

    await expect(cancel()).resolves.toEqual({ commande_id: 9, status: "ANNULE", idempotent_replay: false });

    expect(query.mock.calls.filter(([sql]) => String(sql).includes("pg_advisory_xact_lock"))).toHaveLength(1);
    const receiptRead = query.mock.calls.find(([sql]) => String(sql).includes("FROM public.commercial_command_receipts"));
    expect(String(receiptRead?.[0])).not.toContain("FOR SHARE");
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.commercial_order_cancellations"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.commande_historique"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.commande_client_event_log"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.commercial_command_receipts"))).toHaveLength(1);
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("replays the saved response without duplicating cancellation, event or audit", async () => {
    const { client, query, state } = createClient();
    mocks.connect.mockResolvedValue(client);

    const first = await cancel("sol17-order-cancel-replay");
    state.receipt = {
      request_hash: commercialPayloadHash({
        commande_id: 9,
        reason_code: "CUSTOMER_CANCELLED",
        note: "Confirmation client",
      }),
      response_snapshot: first,
    };

    await expect(cancel("sol17-order-cancel-replay")).resolves.toMatchObject({
      commande_id: 9,
      status: "ANNULE",
      idempotent_replay: true,
    });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.commercial_order_cancellations"))).toHaveLength(1);
    expect(mocks.audit).toHaveBeenCalledOnce();
  });

  it.each([
    ["une commande partiellement livrée", "SHIPPED"],
    ["une commande déjà facturée", "INVOICED"],
  ])("refuses %s when downstream evidence exists (%s)", async () => {
    const { client, query } = createClient({ downstreamBlocked: true });
    mocks.connect.mockResolvedValue(client);

    await expect(cancel()).rejects.toMatchObject({
      status: 409,
      code: "ORDER_CANCELLATION_HAS_DOWNSTREAM_EVIDENCE",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("commercial_order_cancellations"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it.each(["LIVRE", "FACTURE", "ARCHIVE", "ANNULE"])("refuses terminal status %s", async (currentStatus) => {
    const { client, query } = createClient({ currentStatus });
    mocks.connect.mockResolvedValue(client);

    await expect(cancel()).rejects.toMatchObject({ status: 409, code: "ORDER_CANCELLATION_TOO_LATE" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("commercial_order_cancellations"))).toBe(false);
  });
});
