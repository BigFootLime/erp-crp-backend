import request from "supertest";
import { describe, it, expect, vi } from "vitest";

// NOTE: on ne mocke PAS auth.middleware ici — on veut le vrai comportement default-deny.
vi.mock("pg", () => {
  const pool = { on: vi.fn(), query: vi.fn(), connect: vi.fn() };
  return { Pool: vi.fn(() => pool) };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

import app from "../config/app";

describe("Socle default-deny d'authentification (ISO/IEC 27001 A.5.15 / A.8.3)", () => {
  it("refuse les routes protégées sans token (401)", async () => {
    const protectedGets = [
      "/api/v1/clients",
      "/api/v1/banking-info",
      "/api/v1/devis",
      "/api/v1/paiements",
      "/api/v1/avoirs",
      "/api/v1/commandes",
    ];
    for (const path of protectedGets) {
      const res = await request(app).get(path);
      expect(res.status, `GET ${path} doit exiger un token`).toBe(401);
    }
  });

  it("refuse les mutations protégées sans token (401)", async () => {
    const res = await request(app).post("/api/v1/commandes").send({});
    expect(res.status).toBe(401);
  });

  it("laisse les routes /auth publiques (pas derrière le socle)", async () => {
    // Corps vide => 400 de validation, PAS 401 : prouve que la route est atteignable sans token.
    const res = await request(app).post("/api/v1/auth/login").send({});
    expect(res.status).not.toBe(401);
  });
});
