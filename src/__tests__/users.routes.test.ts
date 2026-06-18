import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };

  return {
    Pool: vi.fn(() => pool),
    __emitter__: emitter,
  };
});
vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; role: string; username: string; email: string } },
    _res: unknown,
    next: () => void
  ) => {
    req.user = { id: 8, role: "Secretariat", username: "SEC", email: "sec@example.com" };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
});

describe("/api/v1/users", () => {
  it("GET /api/v1/users/assignees returns active staff for authenticated users", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 8,
          username: "SEC",
          name: "Ghislaine",
          surname: "CRP",
          role: "Secretariat",
          status: "Active",
        },
        {
          id: 12,
          username: "PLAN",
          name: "Planning",
          surname: "CRP",
          role: "Planning",
          status: "Active",
        },
      ],
    });

    const res = await request(app)
      .get("/api/v1/users/assignees?limit=50")
      .set("Authorization", "Bearer fake");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ id: 8, username: "SEC", role: "Secretariat" });

    const sql = String(mocks.poolQuery.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("FROM public.users");
    expect(sql).toContain("NOT IN ('inactive', 'blocked', 'suspended')");
  });
});
