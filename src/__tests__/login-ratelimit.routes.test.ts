import request from "supertest";
import { describe, it, expect, vi } from "vitest";

const rateLimitState = vi.hoisted(() => ({ loginChecks: 0 }));

// Fichier isolé : les maps de rate-limit (module-level) sont fraîches dans ce worker vitest.
vi.mock("pg", () => {
  const pool = { on: vi.fn(), query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn() };
  return { Pool: vi.fn(() => pool) };
});
vi.mock("../utils/checkNetworkDrive", () => ({ checkNetworkDrive: vi.fn(() => Promise.resolve()) }));
vi.mock("../module/auth/services/auth.service", () => ({
  loginUser: vi.fn(async (username: string) => ({
    token: "test-token",
    user: { id: 1, username },
  })),
  registerUser: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPasswordWithToken: vi.fn(),
}));
vi.mock("../module/auth/services/auth-rate-limit.service", () => ({
  authRateLimiter: {
    check: vi.fn(async (endpoint: string) => {
      if (endpoint !== "login") return { status: "allowed", endpoint, disabled: false };
      rateLimitState.loginChecks += 1;
      return rateLimitState.loginChecks > 10
        ? { status: "blocked", endpoint, retryAfterSeconds: 60 }
        : { status: "allowed", endpoint, disabled: false };
    }),
  },
}));

import app from "../config/app";

describe("Login rate-limit anti-bruteforce (ISO/IEC 27001 A.8.5)", () => {
  it("renvoie 429 après trop de tentatives (limite = 10)", async () => {
    process.env.JWT_SECRET = "test-secret";
    let got429 = false;
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ username: "brute-force-user", password: "wrong-password-123" });
      lastStatus = res.status;
      if (res.status === 429) got429 = true;
    }
    expect(got429).toBe(true);
    expect(lastStatus).toBe(429);
  });
});
