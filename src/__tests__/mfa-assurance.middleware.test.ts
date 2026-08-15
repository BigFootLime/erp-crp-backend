import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { requireRecentMfa, requireRecentMfaForMutations } from "../module/auth/middlewares/mfa-assurance.middleware";

function appWith(user: Record<string, unknown>, mutationsOnly = false) {
  const app = express();
  app.use((req, _res, next) => { req.user = user as Express.Request["user"]; next(); });
  app.all("/critical", mutationsOnly ? requireRecentMfaForMutations : requireRecentMfa(300), (_req, res) => res.json({ ok: true }));
  return app;
}

describe("SOL-32 recent MFA assurance", () => {
  it("requires a recent timestamp when a token carries MFA assurance", async () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    const response = await request(appWith({ id: 1, mfa: true, mfa_verified_at: old })).post("/critical");
    expect(response.status).toBe(428);
    expect(response.body.code).toBe("MFA_STEP_UP_REQUIRED");
  });

  it("accepts a recent assurance and leaves reads unchanged", async () => {
    const recent = Math.floor(Date.now() / 1000) - 10;
    await request(appWith({ id: 1, mfa: true, mfa_verified_at: recent })).post("/critical").expect(200);
    await request(appWith({ id: 1, mfa: true, mfa_verified_at: 0 }, true)).get("/critical").expect(200);
  });
});
