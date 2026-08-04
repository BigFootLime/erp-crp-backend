import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: {
    connect: mocks.connect,
    query: vi.fn(),
  },
}));

import { repoSendChatMessage } from "./chat.repository";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

function makeClient(options: { failOutbox?: boolean; failCommit?: boolean } = {}) {
  const release = vi.fn();
  const query = vi.fn(async (sql: unknown, _params?: unknown[]) => {
    const text = String(sql);
    if (text.includes("SELECT 1 AS ok")) return { rows: [{ ok: 1 }] };
    if (text.includes("INSERT INTO public.chat_messages")) {
      return {
        rows: [{
          id: MESSAGE_ID,
          conversation_id: CONVERSATION_ID,
          sender_user_id: 1,
          message_type: "text",
          content: "Bonjour",
          created_at: "2026-08-04T12:00:00.000Z",
        }],
      };
    }
    if (text.includes("SELECT user_id::int AS user_id")) {
      return { rows: [{ user_id: 1 }, { user_id: 2 }] };
    }
    if (text.includes("FROM public.users")) {
      return {
        rows: [{
          id: 1,
          username: "sender",
          name: "Sender",
          surname: "User",
          email: "sender@example.test",
          role: "Atelier",
          status: "Active",
          profile_picture: null,
        }],
      };
    }
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (text.includes("correlation_id::text AS event_id") && text.includes("WHERE event_key = $1")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("INSERT INTO public.realtime_stream_enqueue_state")) {
      return { rows: [{ stream_ordinal: "1" }], rowCount: 1 };
    }
    if (text.includes("INSERT INTO public.erp_outbox_events")) {
      if (options.failOutbox) throw new Error("OUTBOX_UNAVAILABLE");
      return { rows: [{ event_id: "33333333-3333-4333-8333-333333333333" }] };
    }
    if (text === "COMMIT" && options.failCommit) throw new Error("COMMIT_ACK_LOST");
    return { rows: [] };
  });
  return { query, release };
}

function outboxKeys(client: ReturnType<typeof makeClient>): string[] {
  return client.query.mock.calls
    .filter(([sql]) => String(sql).includes("INSERT INTO public.erp_outbox_events"))
    .map(([, params]) => String((params as unknown[])[0]));
}

describe("chat realtime transaction outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues every recipient before COMMIT with stable retry keys", async () => {
    const firstClient = makeClient();
    const secondClient = makeClient();
    mocks.connect.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);

    const input = {
      conversation_id: CONVERSATION_ID,
      sender_user_id: 1,
      content: "Bonjour",
    };
    await repoSendChatMessage(input);
    await repoSendChatMessage(input);

    const expectedKeys = [
      `realtime:chat:message:${MESSAGE_ID}:recipient:1`,
      `realtime:chat:message:${MESSAGE_ID}:recipient:2`,
    ];
    expect(outboxKeys(firstClient)).toEqual(expectedKeys);
    expect(outboxKeys(secondClient)).toEqual(expectedKeys);

    const payloads = firstClient.query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO public.erp_outbox_events"))
      .map(([, params]) => JSON.parse(String((params as unknown[])[4])) as {
        input: { payload: { sender: Record<string, unknown> } };
      });
    expect(payloads.map((payload) => payload.input.payload.sender)).toEqual([
      { id: 1, username: "sender", name: "Sender", surname: "User" },
      { id: 1, username: "sender", name: "Sender", surname: "User" },
    ]);
    expect(JSON.stringify(payloads)).not.toMatch(/email|status|role|profile_picture/);

    const commitIndex = firstClient.query.mock.calls.findIndex(([sql]) => String(sql) === "COMMIT");
    const actualLastOutboxIndex = firstClient.query.mock.calls
      .map(([sql]) => String(sql).includes("INSERT INTO public.erp_outbox_events"))
      .lastIndexOf(true);
    expect(commitIndex).toBeGreaterThan(actualLastOutboxIndex);
  });

  it("rolls the business mutation back when enqueue fails", async () => {
    const client = makeClient({ failOutbox: true });
    mocks.connect.mockResolvedValueOnce(client);

    await expect(repoSendChatMessage({
      conversation_id: CONVERSATION_ID,
      sender_user_id: 1,
      content: "Bonjour",
    })).rejects.toThrow("OUTBOX_UNAVAILABLE");

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("resolves a lost COMMIT acknowledgement from durable event keys without ROLLBACK", async () => {
    const client = makeClient({ failCommit: true });
    const expectedKeys = [
      `realtime:chat:message:${MESSAGE_ID}:recipient:1`,
      `realtime:chat:message:${MESSAGE_ID}:recipient:2`,
    ];
    const verifier = {
      query: vi.fn().mockResolvedValue({ rows: expectedKeys.map((event_key) => ({ event_key })) }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(client).mockResolvedValueOnce(verifier);

    const result = await repoSendChatMessage({
      conversation_id: CONVERSATION_ID,
      sender_user_id: 1,
      content: "Bonjour",
    });

    expect(result?.message.id).toBe(MESSAGE_ID);
    expect(client.query.mock.calls.map(([sql]) => String(sql))).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(true);
    expect(verifier.release).toHaveBeenCalledOnce();
  });

});
