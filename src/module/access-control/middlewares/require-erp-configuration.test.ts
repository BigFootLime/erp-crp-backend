import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock("../services/access-control.service", () => ({ resolveAccessProfile: mocks.profile }));
import { requireErpConfiguration } from "./require-erp-configuration";
import { getAccountModuleAccessContext } from "../context/account-module-access.context";
import { resolveModuleKeyForPath } from "../domain/module-catalog";
import { roleHasReferenceDataCapability } from "../../reference-data/domain/reference-data-policy";

const allowed = () => ({ is_superadmin: false, modules: [{ module_key: "parametrage-erp", allowed: true }] });
function app(user: Record<string, unknown> | null) {
  const server = express();
  server.use((req, _res, next) => { if (user) req.user = user as unknown as Express.Request["user"]; next(); });
  server.use(requireErpConfiguration);
  server.all("/", (_req, res) => res.json({ module: getAccountModuleAccessContext()?.moduleKey, canApply: roleHasReferenceDataCapability("Employee", "apply") }));
  server.use((_e: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.sendStatus(503));
  return server;
}
beforeEach(() => { mocks.profile.mockReset(); });
describe("delegated ERP configuration", () => {
  it("requires an authenticated account and rejects a business role without the live grant", async () => {
    await request(app(null)).get("/").expect(401);
    expect(mocks.profile).not.toHaveBeenCalled();
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [] });
    await request(app({ id: 9, role: "Directeur" })).get("/").expect(403);
  });
  it("opens configuration and reference-data actions through the trusted account context", async () => {
    mocks.profile.mockResolvedValue(allowed());
    const reply = await request(app({ id: 9, role: "Employee" })).get("/").expect(200);
    expect(reply.body).toEqual({ module: "parametrage-erp", canApply: true });
  });
  it.each([undefined, false])("requires MFA before mutations even when the old claim is %s", async mfa => {
    mocks.profile.mockResolvedValue(allowed());
    await request(app({ id: 9, mfa })).put("/").expect(428);
  });
  it("requires recent MFA and observes a later revocation", async () => {
    mocks.profile.mockResolvedValue(allowed());
    await request(app({ id: 9, mfa: true, mfa_verified_at: Math.floor(Date.now() / 1000) - 301 })).put("/").expect(428);
    const server = app({ id: 9, role: "Employee", mfa: true, mfa_verified_at: Math.floor(Date.now() / 1000) });
    await request(server).put("/").expect(200);
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: "parametrage-erp", allowed: false }] });
    await request(server).put("/").expect(403);
  });
  it("fails closed when the permission service is unavailable", async () => {
    mocks.profile.mockResolvedValue(null);
    await request(app({ id: 9 })).get("/").expect(503);
    mocks.profile.mockRejectedValue(new Error("offline"));
    await request(app({ id: 9 })).get("/").expect(503);
  });
  it("retains owner access and keeps account administration in its protected module", async () => {
    mocks.profile.mockResolvedValue({ is_superadmin: true, modules: [] });
    await request(app({ id: 1 })).get("/").expect(200);
    for (const path of ["/admin/onboarding/company", "/admin/erp-settings/stock.default_shipping_location", "/admin/reference-data/changes"]) {
      expect(resolveModuleKeyForPath(path)).toBe("parametrage-erp");
    }
    for (const path of ["/admin/users", "/admin/access/users/9/modules", "/admin/account-requests"]) {
      expect(resolveModuleKeyForPath(path)).toBe("administration");
    }
  });
});
