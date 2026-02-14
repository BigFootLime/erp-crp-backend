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
  authenticateToken: (req: { user?: { id: number; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 1, role: "Atelier" };
    next();
  },
  authorizeRole:
    (...roles: string[]) =>
    (req: { user?: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => unknown } }, next: () => void) => {
      if (req.user && roles.includes(req.user.role)) {
        next();
        return;
      }
      res.status(403).json({ error: "Accès interdit" });
    },
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

describe("/api/v1/planning", () => {
  it("GET /api/v1/planning/health returns ok", async () => {
    const res = await request(app).get("/api/v1/planning/health").set("Authorization", "Bearer fake");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("GET /api/v1/planning/resources returns machines + postes", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            code: "M01",
            name: "Machine 1",
            type: "MILLING",
            status: "ACTIVE",
            is_available: true,
            archived_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            code: "P01",
            label: "Poste 1",
            machine_id: "11111111-1111-1111-1111-111111111111",
            machine_code: "M01",
            machine_name: "Machine 1",
            is_active: true,
            archived_at: null,
          },
        ],
      });

    const res = await request(app).get("/api/v1/planning/resources").set("Authorization", "Bearer fake");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      machines: [{ resource_type: "MACHINE", code: "M01" }],
      postes: [{ resource_type: "POSTE", code: "P01" }],
    });

    const calls = mocks.poolQuery.mock.calls;
    expect(String(calls[0]?.[0])).toContain("FROM public.machines");
    expect(String(calls[1]?.[0])).toContain("FROM public.postes");
  });

  it("GET /api/v1/planning/events returns {items,total}", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "33333333-3333-3333-3333-333333333333",
            kind: "OF_OPERATION",
            status: "PLANNED",
            priority: "NORMAL",
            of_id: "7",
            of_operation_id: "44444444-4444-4444-4444-444444444444",
            machine_id: null,
            poste_id: "22222222-2222-2222-2222-222222222222",
            title: "P10 - Usinage",
            description: null,
            start_ts: "2026-02-14T08:00:00.000Z",
            end_ts: "2026-02-14T10:00:00.000Z",
            allow_overlap: false,
            created_at: "2026-02-14T07:00:00.000Z",
            updated_at: "2026-02-14T07:00:00.000Z",
            archived_at: null,
            of_numero: "OF-7",
            client_company_name: "ACME",
            piece_code: "P-001",
            piece_designation: "Piece",
            operation_phase: 10,
            operation_designation: "Usinage",
            machine_code: null,
            machine_name: null,
            poste_code: "P01",
            poste_label: "Poste 1",
          },
        ],
      });

    const res = await request(app)
      .get("/api/v1/planning/events")
      .set("Authorization", "Bearer fake")
      .query({
        from: "2026-02-14T00:00:00.000Z",
        to: "2026-02-15T00:00:00.000Z",
      });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: "33333333-3333-3333-3333-333333333333",
      of_id: 7,
      poste_id: "22222222-2222-2222-2222-222222222222",
    });
  });
});
