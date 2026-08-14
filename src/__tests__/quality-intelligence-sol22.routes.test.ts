import { EventEmitter } from "node:events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = { on: emitter.on.bind(emitter), query: mocks.poolQuery, connect: mocks.poolConnect };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({ checkNetworkDrive: vi.fn(() => Promise.resolve()) }));
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; role: string }; headers?: Record<string, string | string[] | undefined> },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    if (req.headers?.["x-test-anonymous"] === "1") {
      res.status(401).json({ success: false, code: "UNAUTHORIZED" });
      return;
    }
    const role = req.headers?.["x-test-role"];
    req.user = { id: 1, role: typeof role === "string" ? role : "Responsable Qualite" };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const BASE = "/api/v1/qualite/v2";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
});

describe("SOL-22 intelligence routes", () => {
  it("refuse l'anonyme avant toute lecture DB", async () => {
    const response = await request(app)
      .get(`${BASE}/intelligence?from=2026-08-01&to=2026-08-14`)
      .set("x-test-anonymous", "1");
    expect(response.status).toBe(401);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it.each(["Chef d'atelier", "Comptabilite"])("refuse le rôle sans analytics_read: %s", async (role) => {
    const response = await request(app)
      .get(`${BASE}/intelligence?from=2026-08-01&to=2026-08-14`)
      .set("x-test-role", role);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("QUALITY_CAPABILITY_REQUIRED");
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("valide strictement la période avant les requêtes", async () => {
    const response = await request(app)
      .get(`${BASE}/intelligence?from=2026-08-14&to=2026-08-01`)
      .set("x-test-role", "Responsable Qualite");
    expect(response.status).toBe(422);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("refuse une enquête avec un type de nœud inconnu", async () => {
    const response = await request(app)
      .get(`${BASE}/intelligence/investigation?type=secret&id=42`)
      .set("x-test-role", "Responsable Qualite");
    expect(response.status).toBe(422);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("exige une clé d'idempotence pour enregistrer un coût", async () => {
    const response = await request(app)
      .post(`${BASE}/intelligence/costs`)
      .set("x-test-role", "Responsable Qualite")
      .send({
        non_conformity_id: "11111111-1111-1111-1111-111111111111",
        category: "SCRAP",
        amount: 12.5,
        currency: "EUR",
        occurred_on: "2026-08-14",
        source_type: "MANUAL_EVIDENCE",
        source_id: "NC-2026-1-SCRAP",
        note: "Constat de rebut signé",
      });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });
});
