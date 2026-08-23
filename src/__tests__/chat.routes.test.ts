import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();

  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });

  return {
    Pool: vi.fn(() => pool),
    __emitter__: emitter,
  };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; role: string; username: string; email: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 1, role: "Atelier", username: "U1", email: "u1@example.com" };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";
import { withRealtimeOutboxDbMock } from "./helpers/realtime-outbox-db-mock";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolConnect.mockResolvedValue({
    query: withRealtimeOutboxDbMock(mocks.clientQuery),
    release: mocks.clientRelease,
  });
});

describe("/api/v1/chat", () => {
  it("GET /api/v1/chat/unread-count returns {total_unread}", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ total_unread: 3 }] });

    const res = await request(app).get("/api/v1/chat/unread-count").set("Authorization", "Bearer fake");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_unread: 3 });

    const sql = String(mocks.poolQuery.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("FROM public.chat_messages");
  });

  it("GET /api/v1/chat/users returns {items}", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 2,
          username: "B2",
          name: "Bob",
          surname: "Martin",
          email: "bob@example.com",
          role: "Atelier",
          status: "Active",
          profile_picture: "C:\\legacy\\uploads\\images\\avatars\\bob.png",
        },
      ],
    });
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [{ storage_key: "avatars/bob.png", id: "a0d03d99-4e43-4aa2-b4e1-f9dc6b411111" }],
    });

    const res = await request(app).get("/api/v1/chat/users").set("Authorization", "Bearer fake");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: 2,
      username: "B2",
      profile_picture: null,
      profile_picture_asset: { asset_id: "a0d03d99-4e43-4aa2-b4e1-f9dc6b411111", status: "AVAILABLE" },
    });
    expect(JSON.stringify(res.body)).not.toContain("uploads/images");
  });

  it("GET /api/v1/chat/conversations projects the other user's avatar without a legacy path", async () => {
    const conversationId = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [{
          conversation_id: conversationId,
          type: "direct",
          group_name: null,
          created_by: null,
          participant_count: 2,
          created_at: "2026-08-23T08:00:00.000Z",
          updated_at: "2026-08-23T08:00:00.000Z",
          last_message_at: null,
          last_read_at: null,
          other_user_id: 2,
          other_username: "B2",
          other_name: "Bob",
          other_surname: "Martin",
          other_email: "bob@example.test",
          other_role: "Atelier",
          other_status: "Active",
          other_profile_picture: "avatars/bob.png",
          last_message_id: null,
          last_message_sender_user_id: null,
          last_message_type: null,
          last_message_content: null,
          last_message_created_at: null,
          unread_count: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ storage_key: "avatars/bob.png", id: "b0d03d99-4e43-4aa2-b4e1-f9dc6b411111" }] });

    const res = await request(app).get("/api/v1/chat/conversations").set("Authorization", "Bearer fake");

    expect(res.status).toBe(200);
    expect(res.body.items[0].other_user).toMatchObject({
      profile_picture: null,
      profile_picture_asset: { asset_id: "b0d03d99-4e43-4aa2-b4e1-f9dc6b411111", status: "AVAILABLE" },
    });
    expect(JSON.stringify(res.body)).not.toContain("avatars/bob.png");
  });

  it("GET /api/v1/chat/conversations/:id/messages returns 404 when not participant", async () => {
    const convId = "11111111-1111-1111-1111-111111111111";
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] }) // message list
      .mockResolvedValueOnce({ rows: [] }); // membership check

    const res = await request(app)
      .get(`/api/v1/chat/conversations/${convId}/messages`)
      .set("Authorization", "Bearer fake");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "CONVERSATION_NOT_FOUND" });
  });

  it("POST /api/v1/chat/conversations/group creates a group conversation", async () => {
    const convId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    mocks.poolQuery
      // repoListChatUsersByIds
      .mockResolvedValueOnce({
        rows: [
          {
            id: 2,
            username: "U2",
            name: "Alice",
            surname: "Doe",
            email: "u2@example.com",
            role: "Atelier",
            status: "Active",
          },
          {
            id: 3,
            username: "U3",
            name: "Bob",
            surname: "Doe",
            email: "u3@example.com",
            role: "Atelier",
            status: "Active",
          },
        ],
      })
      // repoGetChatConversation (repoListConversationsForUser)
      .mockResolvedValueOnce({
        rows: [
          {
            conversation_id: convId,
            type: "group",
            group_name: "Equipe Atelier",
            created_by: 1,
            participant_count: 3,
            created_at: "2026-03-19T10:00:00.000Z",
            updated_at: "2026-03-19T10:00:00.000Z",
            last_message_at: null,
            last_read_at: null,

            other_user_id: null,
            other_username: null,
            other_name: null,
            other_surname: null,
            other_email: null,
            other_role: null,
            other_status: null,

            last_message_id: null,
            last_message_sender_user_id: null,
            last_message_type: null,
            last_message_content: null,
            last_message_created_at: null,

            unread_count: 0,
          },
        ],
      });

    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("INSERT INTO public.chat_conversations")) return { rows: [{ id: convId }] };
      if (text.includes("INSERT INTO public.erp_outbox_events")) {
        return { rows: [{ event_id: "11111111-1111-4111-8111-111111111111" }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post("/api/v1/chat/conversations/group")
      .set("Authorization", "Bearer fake")
      .send({ name: "Equipe Atelier", participant_user_ids: [2, 3] });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("conversation");
    expect(res.body.conversation).toMatchObject({ id: convId, type: "group" });
    expect(res.body.conversation.group).toMatchObject({ name: "Equipe Atelier", participant_count: 3 });
  });

  it("POST /api/v1/chat/conversations/:id/archive archives the conversation for me", async () => {
    const convId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ archived_at: "2026-03-20T10:00:00.000Z" }] });

    const res = await request(app)
      .post(`/api/v1/chat/conversations/${convId}/archive`)
      .set("Authorization", "Bearer fake");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ archived_at: "2026-03-20T10:00:00.000Z" });

    const sql = String(mocks.poolQuery.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("UPDATE public.chat_conversation_participants");
    expect(sql).toContain("SET");
    expect(sql).toContain("archived_at");
  });

  it("POST /api/v1/chat/conversations/:id/archive returns 404 when not participant", async () => {
    const convId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/v1/chat/conversations/${convId}/archive`)
      .set("Authorization", "Bearer fake");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "CONVERSATION_NOT_FOUND" });
  });

  it("GET /api/v1/chat/conversations/:id/participants returns {items}", async () => {
    const convId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          username: "U1",
          name: "Alice",
          surname: "Doe",
          email: "u1@example.com",
          role: "Atelier",
          status: "Active",
          profile_picture: null,
        },
        {
          id: 2,
          username: "U2",
          name: "Bob",
          surname: "Doe",
          email: "u2@example.com",
          role: "Atelier",
          status: "Active",
          profile_picture: "bob.png",
        },
      ],
    });
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/v1/chat/conversations/${convId}/participants`)
      .set("Authorization", "Bearer fake");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ id: 1, username: "U1" });
    expect(res.body.items[1]).toMatchObject({ profile_picture: null, profile_picture_asset: null });
    expect(JSON.stringify(res.body)).not.toContain("bob.png");
  });

  it("GET /api/v1/chat/conversations/:id/participants returns 404 when not participant", async () => {
    const convId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/v1/chat/conversations/${convId}/participants`)
      .set("Authorization", "Bearer fake");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "CONVERSATION_NOT_FOUND" });
  });

  it("PATCH /api/v1/chat/conversations/:id/group renames group conversation", async () => {
    const convId = "ffffffff-ffff-ffff-ffff-ffffffffffff";

    const baseRow = {
      conversation_id: convId,
      type: "group",
      group_name: "Equipe Atelier",
      created_by: 1,
      participant_count: 3,
      created_at: "2026-03-20T10:00:00.000Z",
      updated_at: "2026-03-20T10:00:00.000Z",
      last_message_at: null,
      last_read_at: null,
      archived_at: null,

      other_user_id: null,
      other_username: null,
      other_name: null,
      other_surname: null,
      other_email: null,
      other_role: null,
      other_status: null,
      other_profile_picture: null,

      last_message_id: null,
      last_message_sender_user_id: null,
      last_message_type: null,
      last_message_content: null,
      last_message_created_at: null,
      unread_count: 0,
    };

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [baseRow] })
      .mockResolvedValueOnce({ rows: [{ ...baseRow, group_name: "Nouveau nom" }] });
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("UPDATE public.chat_conversations")) {
        return { rows: [{ updated_at: "2026-03-20T10:01:00.000Z" }] };
      }
      if (text.includes("SELECT user_id::int AS user_id")) {
        return { rows: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }] };
      }
      if (text.includes("INSERT INTO public.erp_outbox_events")) {
        return { rows: [{ event_id: "22222222-2222-4222-8222-222222222222" }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .patch(`/api/v1/chat/conversations/${convId}/group`)
      .set("Authorization", "Bearer fake")
      .send({ name: "Nouveau nom" });

    expect(res.status).toBe(200);
    expect(res.body.conversation).toMatchObject({ id: convId, type: "group" });
    expect(res.body.conversation.group).toMatchObject({ name: "Nouveau nom" });
  });

  it("POST /api/v1/chat/conversations/:id/group/members adds members", async () => {
    const convId = "abababab-abab-abab-abab-abababababab";

    const baseRow = {
      conversation_id: convId,
      type: "group",
      group_name: "Equipe Atelier",
      created_by: 1,
      participant_count: 3,
      created_at: "2026-03-20T10:00:00.000Z",
      updated_at: "2026-03-20T10:00:00.000Z",
      last_message_at: null,
      last_read_at: null,
      archived_at: null,

      other_user_id: null,
      other_username: null,
      other_name: null,
      other_surname: null,
      other_email: null,
      other_role: null,
      other_status: null,
      other_profile_picture: null,

      last_message_id: null,
      last_message_sender_user_id: null,
      last_message_type: null,
      last_message_content: null,
      last_message_created_at: null,
      unread_count: 0,
    };

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [baseRow] })
      .mockResolvedValueOnce({
        rows: [
          { id: 4, username: "U4", name: "X", surname: "Y", email: "u4@example.com", role: "Atelier", status: "Active", profile_picture: null },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ ...baseRow, participant_count: 4 }] });
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("SELECT group_name")) return { rows: [{ group_name: "Equipe Atelier" }] };
      if (text.includes("INSERT INTO public.chat_conversation_participants")) {
        return { rows: [{ user_id: 4, joined_at: "2026-03-20T10:02:00.000Z" }] };
      }
      if (text.includes("SELECT user_id::int AS user_id")) {
        return { rows: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }, { user_id: 4 }] };
      }
      if (text.includes("INSERT INTO public.erp_outbox_events")) {
        return { rows: [{ event_id: "33333333-3333-4333-8333-333333333333" }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`/api/v1/chat/conversations/${convId}/group/members`)
      .set("Authorization", "Bearer fake")
      .send({ user_ids: [4] });

    expect(res.status).toBe(200);
    expect(res.body.conversation).toMatchObject({ id: convId, type: "group" });
    expect(res.body.conversation.group).toMatchObject({ participant_count: 4 });
  });

  it("DELETE /api/v1/chat/conversations/:id/group/members/:userId removes member", async () => {
    const convId = "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd";

    const baseRow = {
      conversation_id: convId,
      type: "group",
      group_name: "Equipe Atelier",
      created_by: 1,
      participant_count: 3,
      created_at: "2026-03-20T10:00:00.000Z",
      updated_at: "2026-03-20T10:00:00.000Z",
      last_message_at: null,
      last_read_at: null,
      archived_at: null,

      other_user_id: null,
      other_username: null,
      other_name: null,
      other_surname: null,
      other_email: null,
      other_role: null,
      other_status: null,
      other_profile_picture: null,

      last_message_id: null,
      last_message_sender_user_id: null,
      last_message_type: null,
      last_message_content: null,
      last_message_created_at: null,
      unread_count: 0,
    };

    mocks.poolQuery.mockResolvedValueOnce({ rows: [baseRow] });
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("SELECT group_name")) return { rows: [{ group_name: "Equipe Atelier" }] };
      if (text.includes("DELETE FROM public.chat_conversation_participants")) {
        return { rows: [{ joined_at: "2026-03-19T09:00:00.000Z" }] };
      }
      if (text.includes("SELECT user_id::int AS user_id")) {
        return { rows: [{ user_id: 1 }, { user_id: 3 }] };
      }
      if (text.includes("INSERT INTO public.erp_outbox_events")) {
        return { rows: [{ event_id: "44444444-4444-4444-8444-444444444444" }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .delete(`/api/v1/chat/conversations/${convId}/group/members/2`)
      .set("Authorization", "Bearer fake");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
