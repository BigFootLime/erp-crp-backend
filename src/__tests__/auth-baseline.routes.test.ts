import request from "supertest";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";

// NOTE: on ne mocke PAS auth.middleware ici — on veut le vrai comportement default-deny.
vi.mock("pg", () => {
  const pool = { on: vi.fn(), query: vi.fn(), connect: vi.fn() };
  return { Pool: vi.fn(() => pool) };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

import app from "../config/app";

const TEST_JWT_SECRET = "project-office-auth-baseline-test-secret";
const previousJwtSecret = process.env.JWT_SECRET;

beforeAll(() => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
});

afterAll(() => {
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

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

  it("refuse un JWT invalide ou expiré avec 401 (pas 403)", async () => {
    const invalid = await request(app)
      .get("/api/v1/project-office/access")
      .set("Authorization", "Bearer jeton-invalide");
    expect(invalid.status).toBe(401);

    const expiredToken = jwt.sign(
      { id: 42, username: "pilote", email: "pilote@example.test", role: "Directeur" },
      TEST_JWT_SECRET,
      { expiresIn: -1 }
    );
    const expired = await request(app)
      .get("/api/v1/project-office/access")
      .set("Authorization", `Bearer ${expiredToken}`);
    expect(expired.status).toBe(401);
  });

  it("laisse les routes /auth publiques (pas derrière le socle)", async () => {
    // Corps vide => 400 de validation, PAS 401 : prouve que la route est atteignable sans token.
    const res = await request(app).post("/api/v1/auth/login").send({});
    expect(res.status).not.toBe(401);
  });
});
