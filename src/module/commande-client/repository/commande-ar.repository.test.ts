import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  applyMilestone: vi.fn(),
  ensureStatus: vi.fn(),
  snapshotCurrent: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect, query: vi.fn() },
}));

vi.mock("./commande-client.repository", () => ({
  repoEnsureCommandeWorkflowCheckpoints: vi.fn(),
  repoApplyCommandeWorkflowMilestone: mocks.applyMilestone,
  repoEnsureCommandeWorkflowStatus: mocks.ensureStatus,
}));

vi.mock("../domain/commande-ar-fingerprint", () => ({
  buildCommandeArContentSnapshot: vi.fn(() => ({})),
  isCommandeArSnapshotCurrent: mocks.snapshotCurrent,
}));

import {
  buildCommandeArRecipientSuggestions,
  repoAuthorizeCommandeArGeneration,
  repoClaimCommandeArSend,
  repoFinalizeCommandeArSend,
} from "./commande-ar.repository";
import { withRealtimeOutboxDbMock } from "../../../__tests__/helpers/realtime-outbox-db-mock";

const AR_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const LOCK_TOKEN = "33333333-3333-4333-8333-333333333333";

const draftRow = {
  ar_id: AR_ID,
  commande_id: 123,
  document_id: DOCUMENT_ID,
  document_name: "AR-00000123-v1.pdf",
  reference: "AR-00000123-v1",
  series_number: 123,
  version_number: 1,
  subject: "AR commande 123",
  body_text: null,
  generated_at: "2026-08-04T08:00:00.000Z",
  generated_by: 7,
  status: "GENERATED",
  sent_at: null,
  send_started_at: null,
  recipient_emails: [],
  recipient_contact_ids: [],
  email_provider_id: null,
  content_fingerprint: "a".repeat(64),
  content_snapshot: { header: { numero: "CMD-123" } },
  pdf_sha256: "b".repeat(64),
  send_idempotency_key: null,
  send_payload_fingerprint: null,
};

const claimParams = {
  commande_id: 123,
  ar_id: AR_ID,
  user_id: 7,
  user_role: "Secretaire",
  recipient_emails: ["client@example.test"],
  recipient_contact_ids: [] as string[],
  idempotency_key: "commande-ar:test",
  payload_fingerprint: "c".repeat(64),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  mocks.applyMilestone.mockResolvedValue({ notifications: [] });
  mocks.snapshotCurrent.mockReturnValue(true);
});

describe("commande AR durable send claim", () => {
  it("commits SENDING before returning control to the email provider", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("SELECT client_id FROM public.commande_client")) return { rows: [{ client_id: null }] };
      if (q.includes("FROM public.commande_ar_log ar")) return { rows: [draftRow] };
      if (q.includes("checkpoint_status")) {
        return { rows: [{ raw_statut: "AR_PRET", checkpoint_status: "active", responsible_role: "secretariat", assigned_user_id: null }] };
      }
      if (q.includes("FROM public.commande_client cc")) return { rows: [{ commande_id: 123, client_id: null }] };
      if (q.includes("SET status = 'SENDING'")) return { rows: [{ send_attempt_count: 1 }] };
      return { rows: [] };
    });

    const claim = await repoClaimCommandeArSend(claimParams);

    expect(claim.kind).toBe("claimed");
    expect(mocks.clientQuery.mock.calls.map(([sql]) => String(sql))).toContain("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("does not reclaim a live SENDING attempt", async () => {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("SELECT client_id FROM public.commande_client")) return { rows: [{ client_id: null }] };
      if (q.includes("FROM public.commande_ar_log ar")) return { rows: [{ ...draftRow, status: "SENDING" }] };
      if (q.includes("checkpoint_status")) {
        return { rows: [{ raw_statut: "AR_PRET", checkpoint_status: "active", responsible_role: "secretariat", assigned_user_id: null }] };
      }
      if (q.includes("FROM public.commande_client cc")) return { rows: [{ commande_id: 123, client_id: null }] };
      return { rows: [] };
    });

    await expect(repoClaimCommandeArSend(claimParams)).rejects.toMatchObject({
      status: 409,
      code: "COMMANDE_AR_SEND_IN_PROGRESS",
    });
    expect(mocks.clientQuery.mock.calls.map(([sql]) => String(sql))).toContain("ROLLBACK");
  });

  it("rejects a draft whose customer-facing content changed", async () => {
    mocks.snapshotCurrent.mockReturnValueOnce(false);
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("SELECT client_id FROM public.commande_client")) return { rows: [{ client_id: null }] };
      if (q.includes("FROM public.commande_ar_log ar")) return { rows: [draftRow] };
      if (q.includes("FROM public.commande_client cc")) return { rows: [{ commande_id: 123, client_id: null }] };
      return { rows: [] };
    });

    await expect(repoClaimCommandeArSend(claimParams)).rejects.toMatchObject({
      status: 409,
      code: "COMMANDE_AR_OBSOLETE",
    });
    expect(mocks.clientQuery.mock.calls.map(([sql]) => String(sql))).toContain("ROLLBACK");
  });
});

describe("commande AR recipient suggestions", () => {
  it("deduplicates recipients by email and keeps the selected contact first", () => {
    const suggestions = buildCommandeArRecipientSuggestions({
      header: {
        selected_contact_id: "selected",
        client_email: "ACHATS@CLIENT.TEST",
        client_company_name: "Client Exemple",
      },
      contacts: [
        { contact_id: "other", first_name: "Autre", last_name: "Contact", email: "other@client.test", role: null, civility: null },
        { contact_id: "duplicate", first_name: "Doublon", last_name: "Client", email: "achats@client.test", role: null, civility: null },
        { contact_id: "selected", first_name: "Contact", last_name: "Choisi", email: "achats@client.test", role: "Achats", civility: null },
      ],
      lines: [],
      allocations: [],
    } as never);

    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toMatchObject({
      email: "achats@client.test",
      contact_id: "selected",
      is_default: true,
    });
    expect(suggestions.filter((item) => item.is_default)).toHaveLength(1);
  });
});

describe("commande AR generation authorization", () => {
  const accessRow = (assigned_user_id: number | null) => ({
    raw_statut: "AR_PRET",
    checkpoint_status: "active",
    responsible_role: "secretariat",
    assigned_user_id,
  });

  it("allows the explicitly assigned user", async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [accessRow(7)] }) };
    await expect(repoAuthorizeCommandeArGeneration({
      tx: tx as never,
      commande_id: 123,
      user_id: 7,
      user_role: "Employee",
    })).resolves.toBeUndefined();
  });

  it("rejects an unassigned user outside the responsible role", async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [accessRow(null)] }) };
    await expect(repoAuthorizeCommandeArGeneration({
      tx: tx as never,
      commande_id: 123,
      user_id: 7,
      user_role: "Employee",
    })).rejects.toMatchObject({ status: 403, code: "COMMAND_CHECKPOINT_FORBIDDEN" });
  });
});

describe("commande AR finalization", () => {
  it("atomically finalizes the matching send token and enqueues invalidation", async () => {
    const query = vi.fn(withRealtimeOutboxDbMock(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes("FROM public.commande_ar_log ar")) return { rows: [{ ...draftRow, status: "SENDING" }] };
      if (q.includes("SET status = 'SENT'")) return { rows: [{ sent_at: "2026-08-04T08:05:00.000Z" }] };
      if (q.includes("metadata->>'stock_only_flow'")) return { rows: [{ stock_only_flow: false }] };
      return { rows: [] };
    }));
    const client = { query, release: mocks.release };
    mocks.connect.mockResolvedValueOnce(client);

    const result = await repoFinalizeCommandeArSend({
      commande_id: 123,
      ar_id: AR_ID,
      send_lock_token: LOCK_TOKEN,
      sent_by: 7,
      recipient_emails: ["client@example.test"],
      recipient_contact_ids: [],
      email_provider_id: "provider-1",
      provider_name: "resend",
      sent_email_subject: "Sujet",
      sent_email_text: "Texte",
      sent_email_html: "<p>Texte</p>",
      commentaire: null,
    });

    expect(result.result).toMatchObject({ status: "AR_ENVOYE", reference: "AR-00000123-v1" });
    expect(String(query.mock.calls.find(([sql]) => String(sql).includes("SET status = 'SENT'"))?.[0])).toContain("send_lock_token");
    expect(query.mock.calls.map(([sql]) => String(sql))).toContain("COMMIT");
  });
});
