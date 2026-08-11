import { EventEmitter } from "events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  currentRole: { value: "Directeur" as string | null },
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; username: string; email: string; role: string } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    if (mocks.currentRole.value === null) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    req.user = {
      id: 7,
      username: "direction-test",
      email: "direction@test.invalid",
      role: mocks.currentRole.value,
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const ENDPOINT = "/api/v1/reporting/direction/overview";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.currentRole.value = "Directeur";
  mocks.poolQuery.mockResolvedValue({ rows: [] });
});

describe("SOL-16 cockpit Direction RBAC", () => {
  it("refuse un appel anonyme", async () => {
    mocks.currentRole.value = null;
    expect((await request(app).get(ENDPOINT)).status).toBe(401);
  });

  it("refuse un utilisateur standard et une secrétaire", async () => {
    for (const role of ["Operateur", "Secretaire"]) {
      mocks.currentRole.value = role;
      const response = await request(app).get(ENDPOINT);
      expect(response.status).toBe(403);
      expect(response.body?.code ?? response.body?.error).toBeTruthy();
    }
  });

  it("autorise la Direction et expose le contrat de preuve", async () => {
    const response = await request(app).get(ENDPOINT);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.contract_version).toBe("direction-dashboard/1.0");
    expect(response.body.timezone).toBe("Europe/Paris");
    expect(response.body.metrics).toHaveLength(4);
    expect(response.body.stock_shortage_7d).toMatchObject({
      status: "unavailable",
      value: null,
      reliability: "UNAVAILABLE",
    });
  });

  it("applique le filtre site dans la requête et refuse d'inventer une ventilation cash", async () => {
    const siteId = "11111111-1111-4111-8111-111111111111";
    const response = await request(app).get(ENDPOINT).query({ site_id: siteId });
    expect(response.status).toBe(200);
    expect(response.body.filters.site_id).toBe(siteId);
    expect(response.body.metrics.find((metric: { key: string }) => metric.key === "cash_30d")).toMatchObject({
      value: null,
      status: "unavailable",
      reliability: "UNAVAILABLE",
    });
    expect(
      mocks.poolQuery.mock.calls.some(
        ([sql, values]) => String(sql).includes("selected_site.site_id") && (values as unknown[]).includes(siteId)
      )
    ).toBe(true);
  });

  it("refuse un filtre site mal formé avant toute requête", async () => {
    const response = await request(app).get(ENDPOINT).query({ site_id: "tous" });
    expect(response.status).toBe(400);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
});
