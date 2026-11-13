import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { enforceAuthenticatedCompany } from "./company-runtime.middleware";
import { companyRuntimeService } from "./company-runtime.service";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherCompany = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const company = {
  context: { company_id: companyId },
  summary: { id: companyId },
};
function app() {
  const server = express();
  server.use((req, _res, next) => {
    req.user = { id: 1 } as never;
    next();
  });
  server.use(enforceAuthenticatedCompany);
  server.get("/api/v1/entreprises/context", (req, res) =>
    res.json({ reached: true, company: req.businessCompanyAccess?.summary.id }),
  );
  server.post("/api/v1/commandes", (_req, res) => res.json({ changed: true }));
  server.use(
    (
      error: { status?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(error.status ?? 500).json({ code: error.code }),
  );
  return server;
}
beforeEach(() => vi.restoreAllMocks());
describe("authenticated company boundary", () => {
  it("preserves legacy routes without a company header", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: false,
    });
    expect((await request(app()).post("/api/v1/commandes")).status).toBe(200);
    expect(
      (
        await request(app())
          .post("/api/v1/commandes")
          .set("X-CERP-Company", companyId)
      ).status,
    ).toBe(503);
  });
  it("does not default to CRP for a business request without a selected company", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: true,
      company_id: companyId,
      environment: "cerp_test",
    });
    const load = vi
      .spyOn(companyRuntimeService, "access")
      .mockResolvedValue(company as never);
    const response = await request(app()).post("/api/v1/commandes");
    expect(response.status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });
  it("allows only context discovery without a header and validates its live membership", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: true,
      company_id: companyId,
      environment: "cerp_test",
    });
    vi.spyOn(companyRuntimeService, "access").mockResolvedValue(
      company as never,
    );
    expect(
      (
        await request(app())
          .get("/api/v1/entreprises/context")
          .set("X-CERP-Database", "cerp_test")
      ).body.company,
    ).toBe(companyId);
    expect(
      (
        await request(app())
          .post("/api/v1/commandes")
          .set("X-CERP-Company", companyId)
          .set("X-CERP-Database", "cerp_test")
      ).status,
    ).toBe(200);
  });
  it("refuses a foreign or malformed header before reaching a business handler", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: true,
      company_id: companyId,
      environment: "cerp_test",
    });
    const load = vi.spyOn(companyRuntimeService, "access");
    for (const value of [otherCompany, "cerp_prod", "invalid"])
      expect(
        (
          await request(app())
            .post("/api/v1/commandes")
            .set("X-CERP-Company", value)
        ).status,
      ).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });
  it("keeps an unavailable authority closed without erasing the authenticated session", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: true,
      company_id: companyId,
      environment: "cerp_test",
    });
    vi.spyOn(companyRuntimeService, "access").mockRejectedValue(
      Object.assign(new Error("outage"), {
        status: 503,
        code: "COMPANY_CONTEXT_UNAVAILABLE",
      }),
    );
    expect(
      (
        await request(app())
          .post("/api/v1/commandes")
          .set("X-CERP-Company", companyId)
          .set("X-CERP-Database", "cerp_test")
      ).status,
    ).toBe(503);
  });
  it("refuses absent, malformed and foreign environments before live access", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: true,
      company_id: companyId,
      environment: "cerp_test",
    });
    const load = vi.spyOn(companyRuntimeService, "access");
    for (const environment of [
      undefined,
      "cerp_prod",
      "cerp_test_opaque",
      "invalid",
    ]) {
      const req = request(app())
        .post("/api/v1/commandes")
        .set("X-CERP-Company", companyId);
      if (environment !== undefined) req.set("X-CERP-Database", environment);
      expect((await req).body.code).toBe("COMPANY_ENVIRONMENT_MISMATCH");
    }
    expect(load).not.toHaveBeenCalled();
  });
});
