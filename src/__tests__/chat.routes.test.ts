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

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; role: string; username: string; email: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 1, role: "Atelier", username: "U1", email: "u1@example.com" };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
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
        },
      ],
    });

    const res = await request(app).get("/api/v1/chat/users").set("Authorization", "Bearer fake");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: 2, username: "B2" });
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
});
