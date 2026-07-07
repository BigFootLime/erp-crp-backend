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
  const pool = { on: emitter.on.bind(emitter), query: mocks.poolQuery, connect: mocks.poolConnect };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    (req as { user?: unknown }).user = { id: 1, username: "t", email: "t@t.t", role: "administrateur" };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const CLIENT_ROW = {
  client_id: "001",
  bill_address_id: "b1",
  delivery_address_id: "d1",
  bank_info_id: null,
  primary_contact_id: null,
};

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.clientQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  mocks.clientQuery.mockImplementation((sql: unknown) => {
    if (typeof sql === "string" && sql.includes("FOR UPDATE")) return Promise.resolve({ rows: [CLIENT_ROW] });
    return Promise.resolve({ rows: [{ id: 1, created_at: "2026-07-07T00:00:00.000Z" }] });
  });
});

function sqls(): string[] {
  return mocks.clientQuery.mock.calls.map((c) => String(c[0]));
}

describe("PATCH /api/v1/clients/:id — vrai partiel", () => {
  it("PATCH téléphone seul: UPDATE clients ne touche que phone, ne supprime aucun contact", async () => {
    const res = await request(app).patch("/api/v1/clients/001").send({ phone: "+33612345678" });
    expect(res.status).toBe(204);
    const update = sqls().find((s) => s.includes("UPDATE clients SET"));
    expect(update).toBeTruthy();
    expect(update).toContain("phone");
    expect(update).not.toContain("company_name");
    expect(sqls().some((s) => s.includes("DELETE FROM contacts"))).toBe(false);
    expect(sqls().some((s) => s.includes("DELETE FROM client_payment_modes"))).toBe(false);
  });

  it("PATCH email invalide -> 400", async () => {
    const res = await request(app).patch("/api/v1/clients/001").send({ email: "pas-un-email" });
    expect(res.status).toBe(400);
  });

  it("PATCH vide -> 400 (aucun champ)", async () => {
    const res = await request(app).patch("/api/v1/clients/001").send({});
    expect(res.status).toBe(400);
  });

  it("PATCH adresse de facturation seule: UPDATE adresse_facturation, PAS UPDATE clients", async () => {
    const res = await request(app)
      .patch("/api/v1/clients/001")
      .send({
        bill_address: { name: "Siège", street: "1 rue X", postal_code: "69001", city: "Lyon", country: "France" },
      });
    expect(res.status).toBe(204);
    expect(sqls().some((s) => s.includes("UPDATE adresse_facturation"))).toBe(true);
    expect(sqls().some((s) => s.includes("UPDATE clients SET"))).toBe(false);
  });
});
