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

describe("/api/v1/quick-commande", () => {
  it("GET /api/v1/quick-commande/health returns ok", async () => {
    const res = await request(app).get("/api/v1/quick-commande/health").set("Authorization", "Bearer fake");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("POST /api/v1/quick-commande/preview returns a preview plan", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            code_piece: "P-001",
            designation: "Piece",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { phase: 10, designation: "Usinage", duration_hours: 2 },
          { phase: 20, designation: "Controle", duration_hours: 1 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "22222222-2222-2222-2222-222222222222" }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "33333333-3333-3333-3333-333333333333", expires_at: "2026-02-14T08:30:00.000Z" }],
      });

    const res = await request(app)
      .post("/api/v1/quick-commande/preview")
      .set("Authorization", "Bearer fake")
      .send({
        client_id: "C01",
        piece_technique_id: "11111111-1111-1111-1111-111111111111",
        quantity: 1,
        deadline_ts: "2026-02-20T00:00:00.000Z",
        start_ts: "2026-02-14T08:00:00.000Z",
        step_minutes: 15,
      });

    expect(res.status).toBe(200);
    expect(res.body.preview_id).toBe("33333333-3333-3333-3333-333333333333");
    expect(res.body.plan.operations).toHaveLength(2);
    expect(res.body.plan.operations[0]).toMatchObject({
      phase: 10,
      designation: "Usinage",
      resource_type: "POSTE",
      poste_id: "22222222-2222-2222-2222-222222222222",
      start_ts: "2026-02-14T08:00:00.000Z",
      end_ts: "2026-02-14T10:00:00.000Z",
    });
    expect(res.body.plan.operations[1]).toMatchObject({
      phase: 20,
      designation: "Controle",
      resource_type: "POSTE",
      poste_id: "22222222-2222-2222-2222-222222222222",
      start_ts: "2026-02-14T10:00:00.000Z",
      end_ts: "2026-02-14T11:00:00.000Z",
    });
  });

  it("POST /api/v1/quick-commande/confirm replays response by Idempotency-Key", async () => {
    const replay = {
      preview_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      commande: { id: 123, numero: "CC-123" },
      affaires: { livraison_affaire_id: 1, production_affaire_id: 2 },
      of: { id: 7, numero: "OF-7" },
      planning_event_ids: ["e1"],
    };

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce({ code: "23505" }) // insert confirmation unique violation
      .mockResolvedValueOnce({ rows: [{ status: "CONFIRMED", response_json: replay }] }) // select existing
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app)
      .post("/api/v1/quick-commande/confirm")
      .set("Authorization", "Bearer fake")
      .set("Idempotency-Key", "idem-1")
      .send({
        preview_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        overrides: [],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(replay);
  });
});
