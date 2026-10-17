import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sensitive = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../module/access-control/repository/sensitive-capabilities.repository", () => ({
  repoAccountSensitiveCapabilities: (...args: unknown[]) => sensitive.read(...args),
}));

import factureRoutes from "../module/facturation/routes/factures.routes";
import { errorHandler } from "../middlewares/errorHandler";

function app(options: {
  authenticated?: boolean;
  moduleGranted?: boolean;
  mfa?: boolean;
  capabilities?: string[];
  isSuperadmin?: boolean;
  active?: boolean;
} = {}) {
  const server = express();
  server.use(((req, _res, next) => {
    if (options.authenticated !== false) {
      req.user = {
        id: 7,
        username: "finance-test",
        email: "finance@test.invalid",
        role: "Employee",
        ...(options.mfa ? { mfa: true, amr: ["pwd", "totp"] } : {}),
      };
    }
    if (options.moduleGranted !== false) {
      req.accountModuleAccess = { userId: 7, moduleKey: "facturation", granted: true, elevated: false };
    }
    next();
  }) as RequestHandler);
  server.use("/factures", factureRoutes);
  server.use(errorHandler);
  return server;
}

beforeEach(() => {
  sensitive.read.mockReset();
  sensitive.read.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: [] });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("Finance self permissions", () => {
  it("returns server-resolved routine capabilities but keeps sensitive grants false without MFA", async () => {
    sensitive.read.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: ["finance.validate"] });

    const response = await request(app()).get("/factures/permissions");

    expect(response.status).toBe(200);
    expect(response.body.capabilities.read).toBe(true);
    expect(response.body.capabilities.draft_write).toBe(true);
    expect(response.body.capabilities.validate).toBe(false);
    expect(response.body.capabilities.issue).toBe(false);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(sensitive.read).toHaveBeenCalledWith(7);
  });

  it("uses nominative sensitive grants and active MFA, never the descriptive role", async () => {
    sensitive.read.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: ["finance.validate"] });

    const response = await request(app({ mfa: true })).get("/factures/permissions");

    expect(response.status).toBe(200);
    expect(response.body.capabilities.validate).toBe(true);
    expect(response.body.capabilities.issue).toBe(false);
  });

  it("gives a SuperAdmin the same server-side sensitive resolution, still gated by MFA", async () => {
    sensitive.read.mockResolvedValue({ active: true, isSuperadmin: true, capabilities: [] });

    const withoutMfa = await request(app()).get("/factures/permissions");
    expect(withoutMfa.status).toBe(200);
    expect(withoutMfa.body.capabilities.settings_manage).toBe(false);

    const withMfa = await request(app({ mfa: true })).get("/factures/permissions");
    expect(withMfa.status).toBe(200);
    expect(withMfa.body.capabilities.settings_manage).toBe(true);
  });

  it("refuses the self-permission endpoint when the Finance module is not granted", async () => {
    const response = await request(app({ moduleGranted: false })).get("/factures/permissions");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FINANCE_MODULE_REQUIRED");
    expect(sensitive.read).not.toHaveBeenCalled();
  });
});
