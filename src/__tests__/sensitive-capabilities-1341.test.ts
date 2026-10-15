import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock("../module/access-control/repository/sensitive-capabilities.repository", () => ({ repoAccountSensitiveCapabilities: mocks.state }));
import { requireSensitiveCapability } from "../module/access-control/middlewares/sensitive-capability.middleware";
import { accountHasSensitiveCapability, financeSensitiveCapability } from "../module/access-control/domain/sensitive-capabilities";
import { HttpError } from "../utils/httpError";
import { grantAccountModuleAccessToRequest } from "../module/access-control/context/account-module-access.context";
import { roleHasFinanceCapability } from "../module/facturation/domain/finance-policy";
import { requireFinanceCapability } from "../module/facturation/middlewares/finance-authorization.middleware";

function app(actor = true, assurance = true) {
  const server = express();
  server.use((req, _res, next) => {
    if (actor) {
      req.user = { id: 7, username: "fixture", email: "fixture@example.invalid", role: "Directeur", mfa: true, amr: ["pwd", "totp"], mfa_verified_at: Math.floor(Date.now()/1000) };
      if (!assurance) { req.user.mfa = false; req.user.amr = ["pwd"]; }
      grantAccountModuleAccessToRequest(req, { userId: 7, moduleKey: "facturation", elevated: true }, next);
      return;
    }
    next();
  });
  server.post("/issue", requireSensitiveCapability("finance.issue"), (_req, res) => res.json({ ok: true }));
  server.get("/overview", requireFinanceCapability("read"), (_req, res) => res.json({ financial: roleHasFinanceCapability("Secretaire", "reporting_financial"), issue: roleHasFinanceCapability("Secretaire", "issue") }));
  server.use((error: HttpError, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ code: error.code }));
  return server;
}
describe("nominative sensitive permissions", () => {
  beforeEach(() => mocks.state.mockReset());
  it("does not grant a privilege from a role or even an elevated module context", async () => {
    mocks.state.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: [] });
    await request(app()).post("/issue").expect(403);
  });
  it("allows the exact account grant, and rechecks revocation on the next call", async () => {
    mocks.state.mockResolvedValueOnce({ active: true, isSuperadmin: false, capabilities: ["finance.issue"] });
    await request(app()).post("/issue").expect(200);
    mocks.state.mockResolvedValueOnce({ active: true, isSuperadmin: false, capabilities: [] });
    await request(app()).post("/issue").expect(403);
  });
  it("rejects inactive, anonymous, and unavailable authorization infrastructure", async () => {
    await request(app(false)).post("/issue").expect(401);
    mocks.state.mockResolvedValueOnce({ active: false, isSuperadmin: true, capabilities: [] });
    await request(app()).post("/issue").expect(403);
    mocks.state.mockRejectedValueOnce(new HttpError(503, "SENSITIVE_ACCESS_NOT_READY", "Unavailable"));
    await request(app()).post("/issue").expect(503);
  });
  it("preserves the existing live superadmin recovery privilege", async () => {
    mocks.state.mockResolvedValue({ active: true, isSuperadmin: true, capabilities: ["finance.issue"] });
    await request(app()).post("/issue").expect(200);
  });
  it("requires MFA even for a nominated account", async () => {
    mocks.state.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: ["finance.issue"] });
    await request(app(true, false)).post("/issue").expect(401);
  });
  it("loads fine permissions in read models without granting every action of the module", async () => {
    mocks.state.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: ["finance.reporting_financial"] });
    const response = await request(app()).get("/overview").expect(200);
    expect(response.body).toEqual({ financial: true, issue: false });
  });
  it("distinguishes routine module actions from sensitive finance commands", () => {
    expect(financeSensitiveCapability("read")).toBeNull();
    expect(financeSensitiveCapability("draft_write")).toBeNull();
    expect(financeSensitiveCapability("issue")).toBe("finance.issue");
    expect(accountHasSensitiveCapability({ active: false, isSuperadmin: true, capabilities: [] }, "audit.read")).toBe(false);
  });
});
