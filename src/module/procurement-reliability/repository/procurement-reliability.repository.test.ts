import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), audit: vi.fn() }));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect, query: vi.fn() },
}));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));

import { procurementPayloadHash } from "../domain/procurement-reliability";
import {
  repoRecordInitialPromiseEvent,
  repoRecordPromisedDate,
  repoUpsertAnomalyAction,
} from "./procurement-reliability.repository";

const actor = {
  user_id: 17,
  role: "Responsable Achats",
  ip: "127.0.0.1",
  user_agent: "vitest",
  path: "/procurement-reliability",
  page_key: "procurement-reliability",
  client_session_id: "sol18",
};

function promiseInput() {
  return {
    promised_date: "2026-08-25",
    reason_code: "SUPPLIER_DELAY" as const,
    note: "Retard matière confirmé",
    expected_updated_at: "2026-08-12T10:00:00.000Z",
  };
}

function createPromiseClient(receipt: { request_hash: string; response_snapshot: Record<string, unknown> } | null = null) {
  const query = vi.fn(async (sql: unknown) => {
    const statement = String(sql);
    if (statement.includes("AS installed")) return { rows: [{ installed: true }] };
    if (statement.includes("FROM public.procurement_command_receipts")) return { rows: receipt ? [receipt] : [] };
    if (statement.includes("FROM public.commande_fournisseur WHERE")) {
      return { rows: [{ statut: "ACCUSE_RECU", updated_at: "2026-08-12T10:00:00.000Z", date_promesse: "2026-08-20" }] };
    }
    if (statement.includes("INSERT INTO public.procurement_promised_date_events")) {
      return { rows: [{ id: "11111111-1111-4111-8111-111111111111", created_at: "2026-08-12T10:01:00.000Z" }] };
    }
    return { rows: [], rowCount: 1 };
  });
  return { query, release: vi.fn() } as unknown as PoolClient;
}

describe("SOL-18 procurement write transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audit.mockResolvedValue({ id: "audit-sol18" });
  });

  it("versions a changed supplier promise, audits it and saves an idempotency receipt", async () => {
    const client = createPromiseClient();
    mocks.connect.mockResolvedValue(client);
    await expect(repoRecordPromisedDate({
      orderId: "22222222-2222-4222-8222-222222222222",
      input: promiseInput(),
      actor,
      idempotencyKey: "sol18-promise-0001",
    })).resolves.toMatchObject({ promised_date: "2026-08-25", idempotent_replay: false });
    const query = client.query as ReturnType<typeof vi.fn>;
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE public.commande_fournisseur SET date_promesse"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.procurement_promised_date_events"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.procurement_command_receipts"))).toHaveLength(1);
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("records the initial supplier promise inside the acknowledgement transaction", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query } as unknown as PoolClient;

    await repoRecordInitialPromiseEvent(client, {
      orderId: "22222222-2222-4222-8222-222222222222",
      previousDate: null,
      promisedDate: "2026-08-20",
      actorUserId: 17,
    });

    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0][0])).toContain("SUPPLIER_ACKNOWLEDGEMENT");
    expect(query.mock.calls[0][1]).toEqual([
      "22222222-2222-4222-8222-222222222222",
      null,
      "2026-08-20",
      17,
    ]);
  });

  it("replays a promise command without a second update or event", async () => {
    const input = promiseInput();
    const orderId = "22222222-2222-4222-8222-222222222222";
    const client = createPromiseClient({
      request_hash: procurementPayloadHash({ order_id: orderId, ...input }),
      response_snapshot: { event_id: "evt", promised_date: input.promised_date, idempotent_replay: false },
    });
    mocks.connect.mockResolvedValue(client);
    await expect(repoRecordPromisedDate({ orderId, input, actor, idempotencyKey: "sol18-promise-replay" }))
      .resolves.toMatchObject({ idempotent_replay: true });
    const query = client.query as ReturnType<typeof vi.fn>;
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE public.commande_fournisseur"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rejects a concurrent anomaly edit before overwriting another buyer", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const statement = String(sql);
      if (statement.includes("AS installed")) return { rows: [{ installed: true }] };
      if (statement.includes("FROM public.procurement_command_receipts")) return { rows: [] };
      if (statement.includes("FROM public.procurement_anomaly_actions")) {
        return { rows: [{ updated_at: "2026-08-12T11:00:00.000Z" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    mocks.connect.mockResolvedValue(client);
    await expect(repoUpsertAnomalyAction({
      anomalyKey: "MISSING_QUANTITY:0123456789abcdef01234567",
      input: {
        owner_user_id: 17,
        next_action: "Relancer le fournisseur",
        due_date: "2026-08-13",
        status: "IN_PROGRESS",
        expected_updated_at: "2026-08-12T10:00:00.000Z",
      },
      actor,
      idempotencyKey: "sol18-action-concurrent",
    })).rejects.toMatchObject({ status: 409, code: "CONCURRENT_MODIFICATION" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.procurement_anomaly_actions"))).toBe(false);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("uses the line token when revising a line promise", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const statement = String(sql);
      if (statement.includes("AS installed")) return { rows: [{ installed: true }] };
      if (statement.includes("FROM public.procurement_command_receipts")) return { rows: [] };
      if (statement.includes("FROM public.commande_fournisseur WHERE")) {
        return { rows: [{ statut: "ACCUSE_RECU", updated_at: "2026-08-12T10:00:00.000Z", date_promesse: "2026-08-20" }] };
      }
      if (statement.includes("FROM public.commande_fournisseur_ligne")) {
        return { rows: [{ date_promesse: "2026-08-21", updated_at: "2026-08-12T10:05:00.000Z" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() } as unknown as PoolClient);

    await expect(repoRecordPromisedDate({
      orderId: "22222222-2222-4222-8222-222222222222",
      input: { ...promiseInput(), line_id: "33333333-3333-4333-8333-333333333333" },
      actor,
      idempotencyKey: "sol18-line-promise-concurrent",
    })).rejects.toMatchObject({ status: 409, code: "CONCURRENT_MODIFICATION" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE public.commande_fournisseur_ligne"))).toBe(false);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });
});
