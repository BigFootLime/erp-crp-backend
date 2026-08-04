import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  ensureCheckpoints: vi.fn(),
  applyMilestone: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect, query: mocks.poolQuery },
}));

vi.mock("./commande-client.repository", () => ({
  repoEnsureCommandeWorkflowCheckpoints: mocks.ensureCheckpoints,
  repoApplyCommandeWorkflowMilestone: mocks.applyMilestone,
}));

import {
  repoAbortCommandeArSendClaim,
  repoAuthorizeCommandeArGeneration,
  repoClaimCommandeArSend,
  repoCreateCommandeArDraft,
  repoFinalizeCommandeArSend,
  repoMarkCommandeArFailed,
} from "./commande-ar.repository";
import { runWithAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { withRealtimeOutboxDbMock } from "../../../__tests__/helpers/realtime-outbox-db-mock";

const draftRow = {
  ar_id: "11111111-1111-4111-8111-111111111111",
  commande_id: 123,
  document_id: "22222222-2222-4222-8222-222222222222",
  document_name: "AR-123.pdf",
  subject: "AR commande 123",
  body_text: null,
  generated_at: "2026-08-04T08:00:00.000Z",
  generated_by: 7,
  status: "GENERATED",
  sent_at: null,
  recipient_emails: [],
  email_provider_id: null,
};

function withCommandesModuleAccess<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithAccountModuleAccess({ userId: 7, moduleKey: "commandes" }, () => {
      void operation().then(resolve, reject);
    });
  });
}

function mockClaimableDraft(assignedUserId: number | null) {
  mocks.clientQuery.mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    if (q.includes("FROM public.commande_client cc")) return { rows: [{ raw_statut: "AR_PRET" }] };
    if (q.includes("FROM public.commande_ar_log ar")) return { rows: [draftRow] };
    if (q.includes("checkpoint_code = 'ar_sent'")) {
      return { rows: [{ status: "active", responsible_role: "secretariat", assigned_user_id: assignedUserId }] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  mocks.ensureCheckpoints.mockResolvedValue(undefined);
});

describe("commande AR atomic send claim", () => {
  it("revalide sous verrou et refuse un brouillon rendu avant un envoi concurrent", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("SELECT id::int AS id FROM public.commande_client") && query.includes("FOR UPDATE")) {
        return { rows: [{ id: 123 }] };
      }
      if (query.includes("st.nouveau_statut AS raw_statut")) {
        return {
          rows: [{
            raw_statut: "AR_ENVOYE",
            checkpoint_status: "done",
            responsible_role: "secretariat",
            assigned_user_id: null,
          }],
        };
      }
      return { rows: [] };
    });

    await expect(repoCreateCommandeArDraft({
      commande_id: 123,
      user_id: 7,
      user_role: "Secretaire",
      document_name: "AR-123.pdf",
      pdf_buffer: Buffer.from("pdf"),
      subject: "AR commande 123",
      body_text: "Bonjour",
      recipient_suggestions: [],
    })).rejects.toMatchObject({ status: 409, code: "COMMAND_AR_GENERATION_NOT_ALLOWED" });

    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.commande_ar_log"))).toBe(false);
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("AR_GENERATED"))).toBe(false);
  });

  it("lets an explicitly assigned non-secretariat user claim the AR send", async () => {
    mockClaimableDraft(7);

    const claim = await repoClaimCommandeArSend({
      commande_id: 123,
      ar_id: draftRow.ar_id,
      user_id: 7,
      user_role: "Employee",
    });

    expect(claim.kind).toBe("claimed");
    if (claim.kind === "claimed") await repoAbortCommandeArSendClaim(claim);
  });

  it("does not let a module grant bypass the deep send role/assignment policy", async () => {
    mockClaimableDraft(null);

    await expect(withCommandesModuleAccess(() => repoClaimCommandeArSend({
      commande_id: 123,
      ar_id: draftRow.ar_id,
      user_id: 7,
      user_role: "Employee",
    }))).rejects.toMatchObject({ status: 403, code: "COMMAND_CHECKPOINT_FORBIDDEN" });
  });

  it("authorizes before returning a SENT replay", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("FROM public.commande_client cc")) return { rows: [{ raw_statut: "AR_ENVOYE" }] };
      if (q.includes("FROM public.commande_ar_log ar")) {
        return {
          rows: [{
            ...draftRow,
            status: "SENT",
            sent_at: "2026-08-04T08:05:00.000Z",
            recipient_emails: ["persisted@example.test"],
            email_provider_id: "provider-1",
          }],
        };
      }
      if (q.includes("checkpoint_code = 'ar_sent'")) {
        return { rows: [{ status: "done", responsible_role: "secretariat", assigned_user_id: null }] };
      }
      return { rows: [] };
    });

    await expect(repoClaimCommandeArSend({
      commande_id: 123,
      ar_id: draftRow.ar_id,
      user_id: 7,
      user_role: "Employee",
    })).rejects.toMatchObject({ status: 403, code: "COMMAND_CHECKPOINT_FORBIDDEN" });

    expect(mocks.clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("hands an authorized SENT replay to the transaction helper before COMMIT", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("FROM public.commande_client cc")) return { rows: [{ raw_statut: "AR_ENVOYE" }] };
      if (q.includes("FROM public.commande_ar_log ar")) {
        return {
          rows: [{
            ...draftRow,
            status: "SENT",
            sent_at: "2026-08-04T08:05:00.000Z",
            recipient_emails: ["persisted@example.test"],
            email_provider_id: "provider-1",
          }],
        };
      }
      if (q.includes("checkpoint_code = 'ar_sent'")) {
        return { rows: [{ status: "done", responsible_role: "secretariat", assigned_user_id: null }] };
      }
      if (q === "COMMIT") throw new Error("COMMIT_ACK_LOST");
      return { rows: [] };
    });

    await expect(repoClaimCommandeArSend({
      commande_id: 123,
      ar_id: draftRow.ar_id,
      user_id: 7,
      user_role: "Secretaire",
    })).rejects.toMatchObject({ code: "REALTIME_COMMIT_OUTCOME_UNKNOWN" });

    expect(mocks.clientQuery.mock.calls.map(([sql]) => String(sql))).not.toContain("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledWith(true);
  });

  it("rejects an unknown technical AR status before the provider can be invoked", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("FROM public.commande_client cc")) return { rows: [{ raw_statut: "AR_PRET" }] };
      if (q.includes("FROM public.commande_ar_log ar")) return { rows: [{ ...draftRow, status: "SENDING" }] };
      return { rows: [] };
    });

    await expect(repoClaimCommandeArSend({
      commande_id: 123,
      ar_id: draftRow.ar_id,
      user_id: 7,
      user_role: "Secretaire",
    })).rejects.toMatchObject({ status: 409, code: "COMMAND_AR_STATUS_INVALID" });
    expect(mocks.ensureCheckpoints).not.toHaveBeenCalled();
  });

  it("never lets a failed request overwrite a concurrently SENT AR", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });

    await repoMarkCommandeArFailed({
      commande_id: 123,
      ar_id: draftRow.ar_id,
      error_message: "provider timeout",
    });

    const [sql] = mocks.poolQuery.mock.calls[0];
    expect(String(sql)).toContain("AND status <> 'SENT'");
  });

  it("never issues ROLLBACK after a lost COMMIT acknowledgement on a claimed failure", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql) === "COMMIT") throw new Error("COMMIT_ACK_LOST");
      return { rows: [] };
    });

    await expect(repoMarkCommandeArFailed({
      commande_id: 123,
      ar_id: draftRow.ar_id,
      error_message: "provider timeout",
      claim: {
        kind: "claimed",
        client: { query: mocks.clientQuery, release: mocks.release },
        draft: draftRow,
      } as never,
    })).rejects.toMatchObject({ code: "REALTIME_COMMIT_OUTCOME_UNKNOWN" });

    expect(mocks.clientQuery.mock.calls.map(([sql]) => String(sql))).not.toContain("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledWith(true);
  });
});

describe("commande AR generation authorization", () => {
  const accessRow = (assigned_user_id: number | null) => ({
    raw_statut: "AR_PRET",
    checkpoint_status: "active",
    responsible_role: "secretariat",
    assigned_user_id,
  });

  it("allows an assigned Employee before artifact generation", async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [accessRow(7)] }) };
    await expect(repoAuthorizeCommandeArGeneration({
      tx: tx as never,
      commande_id: 123,
      user_id: 7,
      user_role: "Employee",
    })).resolves.toBeUndefined();
  });

  it("requires a business role even with module access and rejects an unassigned unauthorized role", async () => {
    const grantedTx = { query: vi.fn().mockResolvedValue({ rows: [accessRow(null)] }) };
    await expect(withCommandesModuleAccess(() => repoAuthorizeCommandeArGeneration({
      tx: grantedTx as never,
      commande_id: 123,
      user_id: 7,
      user_role: "Employee",
    }))).rejects.toMatchObject({ status: 403, code: "COMMAND_CHECKPOINT_FORBIDDEN" });

    const roleTx = { query: vi.fn().mockResolvedValue({ rows: [accessRow(null)] }) };
    await expect(withCommandesModuleAccess(() => repoAuthorizeCommandeArGeneration({
      tx: roleTx as never,
      commande_id: 123,
      user_id: 7,
      user_role: "Secretaire",
    }))).resolves.toBeUndefined();

    const deniedTx = { query: vi.fn().mockResolvedValue({ rows: [accessRow(null)] }) };
    await expect(repoAuthorizeCommandeArGeneration({
      tx: deniedTx as never,
      commande_id: 123,
      user_id: 7,
      user_role: "Employee",
    })).rejects.toMatchObject({ status: 403, code: "COMMAND_CHECKPOINT_FORBIDDEN" });
  });
});

describe("commande AR realtime transaction outbox", () => {
  const notification = {
    id: "33333333-3333-4333-8333-333333333333",
    user_id: 9,
    kind: "commande_status",
    title: "Commande mise à jour",
    message: "L'accusé de réception a été envoyé.",
    severity: "success" as const,
    action_url: "/commandes/123",
    action_label: "Voir la commande",
    payload: { commande_id: 123 },
    created_at: "2026-08-04T08:05:00.000Z",
    read_at: null,
  };

  function makeFinalizeClient(options: { failOutbox?: boolean; failCommit?: boolean } = {}) {
    const release = vi.fn();
    const query = vi.fn(withRealtimeOutboxDbMock(async (sql: unknown) => {
      const statement = String(sql);
      if (statement.includes("UPDATE public.commande_ar_log")) {
        return { rows: [{ sent_at: "2026-08-04T08:05:00.000Z" }] };
      }
      if (statement === "COMMIT" && options.failCommit) throw new Error("COMMIT_ACK_LOST");
      return { rows: [] };
    }, {
      onOutboxInsert: (_sql, params) => {
        if (options.failOutbox) throw new Error("OUTBOX_UNAVAILABLE");
        return { rows: [{ event_id: String(params?.[5]) }] };
      },
    }));
    return { query, release };
  }

  function outboxKeys(client: ReturnType<typeof makeFinalizeClient>): string[] {
    return client.query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO public.erp_outbox_events"))
      .map(([, params]) => String(params?.[0]));
  }

  async function finalizeWith(client: ReturnType<typeof makeFinalizeClient>) {
    return repoFinalizeCommandeArSend({
      claim: { kind: "claimed", client, draft: draftRow } as never,
      commande_id: 123,
      ar_id: draftRow.ar_id,
      sent_by: 7,
      recipient_emails: ["client@example.test"],
      recipient_contact_ids: [],
      email_provider_id: "provider-1",
      commentaire: null,
    });
  }

  it("enqueues notifications and entity invalidation before COMMIT with stable retry keys", async () => {
    const firstClient = makeFinalizeClient();
    const secondClient = makeFinalizeClient();
    mocks.applyMilestone.mockResolvedValue({ notifications: [notification] });

    await finalizeWith(firstClient);
    await finalizeWith(secondClient);

    const expectedKeys = [
      `realtime:notification:${notification.id}`,
      `realtime:commande-ar:${draftRow.ar_id}:sent`,
    ];
    expect(outboxKeys(firstClient)).toEqual(expectedKeys);
    expect(outboxKeys(secondClient)).toEqual(expectedKeys);

    const commitIndex = firstClient.query.mock.calls.findIndex(([sql]) => String(sql) === "COMMIT");
    const lastOutboxIndex = firstClient.query.mock.calls
      .map(([sql]) => String(sql).includes("INSERT INTO public.erp_outbox_events"))
      .lastIndexOf(true);
    expect(commitIndex).toBeGreaterThan(lastOutboxIndex);
    expect(firstClient.release).toHaveBeenCalledOnce();
  });

  it("rolls back the AR mutation when enqueue fails", async () => {
    const client = makeFinalizeClient({ failOutbox: true });
    mocks.applyMilestone.mockResolvedValue({ notifications: [notification] });

    await expect(finalizeWith(client)).rejects.toThrow("OUTBOX_UNAVAILABLE");

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("adopts the claim transaction and resolves a lost COMMIT acknowledgement without ROLLBACK", async () => {
    const client = makeFinalizeClient({ failCommit: true });
    const expectedKeys = [
      `realtime:notification:${notification.id}`,
      `realtime:commande-ar:${draftRow.ar_id}:sent`,
    ];
    const verifier = {
      query: vi.fn().mockResolvedValue({ rows: expectedKeys.map((event_key) => ({ event_key })) }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(verifier);
    mocks.applyMilestone.mockResolvedValue({ notifications: [notification] });

    const result = await finalizeWith(client);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(result.result.status).toBe("AR_ENVOYE");
    expect(statements).not.toContain("BEGIN");
    expect(statements).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(true);
    expect(verifier.release).toHaveBeenCalledOnce();
  });
});
