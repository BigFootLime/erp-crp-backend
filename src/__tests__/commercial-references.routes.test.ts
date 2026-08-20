import request from "supertest";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  return {
    Pool: vi.fn(() => ({ on: emitter.on.bind(emitter), query: vi.fn(), connect: vi.fn() })),
    __emitter__: emitter,
  };
});

vi.mock("../utils/checkNetworkDrive", () => ({ checkNetworkDrive: vi.fn(() => Promise.resolve()) }));
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; role: string }; headers: Record<string, unknown> },
    _res: unknown,
    next: () => void
  ) => {
    req.user = {
      id: 1,
      role: typeof req.headers["x-test-role"] === "string" ? String(req.headers["x-test-role"]) : "administrateur",
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

describe("commercial references compatibility routes", () => {
  it.each(["/api/v1/conditions-paiement", "/api/v1/compte-vente"])(
    "keeps %s authenticated and explicit until an approved financial model exists",
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        items: [],
        availability: "NOT_CONFIGURED",
        source: null,
        freshness_at: null,
        reliability: "UNAVAILABLE",
      });
      expect(typeof res.body.message).toBe("string");
    }
  );

  it("keeps the frontend's two historic item types distinct", async () => {
    const conditions = await request(app).get("/api/v1/conditions-paiement");
    const comptes = await request(app).get("/api/v1/compte-vente");
    expect(Object.keys(conditions.body)).toEqual([
      "items", "availability", "message", "source", "freshness_at", "reliability",
    ]);
    expect(Object.keys(comptes.body)).toEqual([
      "items", "availability", "message", "source", "freshness_at", "reliability",
    ]);
  });

  it("does not expose commercial reference state to a role without Devis read access", async () => {
    const res = await request(app).get("/api/v1/conditions-paiement").set("x-test-role", "Stagiaire");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });
});
