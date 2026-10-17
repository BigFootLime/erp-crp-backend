import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capabilities: vi.fn() }));
vi.mock("../module/access-control/repository/sensitive-capabilities.repository", () => ({
  repoAccountSensitiveCapabilities: mocks.capabilities,
}));

import {
  getHrSensitivePermissions,
  requireHrSensitiveRead,
  requireHrSensitiveWrite,
} from "../module/temps-deplacements/middlewares/hr-sensitive-authorization.middleware";

const now = Math.floor(Date.now() / 1000);

function appFor(user: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user as Express.Request["user"];
    next();
  });
  app.get("/read", requireHrSensitiveRead, (_req, res) => res.json({ ok: true }));
  app.patch("/write", requireHrSensitiveWrite, (_req, res) => res.json({ ok: true }));
  app.get("/permissions", async (req, res, next) => {
    try { res.json(await getHrSensitivePermissions(req)); } catch (error) { next(error); }
  });
  app.use((error: { status?: number; code?: string }, _req: unknown, res: express.Response, _next: unknown) => {
    res.status(error.status ?? 500).json({ code: error.code });
  });
  return app;
}

describe("Temps & Déplacements — habilitations RH sensibles", () => {
  it("refuse une lecture RH au module accordé sans capacité nominative", async () => {
    mocks.capabilities.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: [] });
    const response = await request(appFor({
      id: 17, role: "Directeur", mfa: true, amr: ["totp"], mfa_verified_at: now,
      accountModuleAccess: { granted: true, elevated: true },
    })).get("/read");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("SENSITIVE_CAPABILITY_REQUIRED");
  });

  it("demande un step-up 428 avant une mutation RH sensible", async () => {
    mocks.capabilities.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: ["hr.sensitive.write"] });
    const response = await request(appFor({ id: 17, role: "Employee", mfa: false, amr: [] })).patch("/write");
    expect(response.status).toBe(428);
    expect(response.body.code).toBe("MFA_STEP_UP_REQUIRED");
  });

  it("autorise le SuperAdmin DB MFA sans dépendre du rôle descriptif", async () => {
    mocks.capabilities.mockResolvedValue({ active: true, isSuperadmin: true, capabilities: [] });
    const app = appFor({ id: 1, role: "Employee", mfa: true, amr: ["totp"], mfa_verified_at: now });
    await request(app).get("/read").expect(200);
    await request(app).patch("/write").expect(200);
    await request(app).get("/permissions").expect(200, {
      can_read_sensitive: true,
      can_write_sensitive: true,
      mfa_required: false,
    });
  });
});
