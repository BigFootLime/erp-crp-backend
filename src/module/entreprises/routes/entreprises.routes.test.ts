import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ issue: vi.fn() }));
vi.mock("../../auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.user = {
      id: 42,
      directory_session: "dir_fixture",
      directory_profile_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    } as never;
    next();
  },
}));
vi.mock("../../auth/middlewares/auth-rate-limit.middleware", () => ({
  createAuthRateLimitMiddleware:
    () =>
    (
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) =>
      next(),
}));
vi.mock("../../../shared-directory/site-runtime", () => ({
  directoryAuthenticationResult: mocks.issue,
  sharedDirectoryClient: () => null,
  sharedDirectorySite: () => null,
}));
import router from "./entreprises.routes";
import { companyRuntimeService } from "../runtime/company-runtime.service";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherCompany = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ticket = "a".repeat(64);
function app() {
  const server = express();
  server.use(express.json());
  server.use("/api/v1/entreprises", router);
  server.use(
    (
      error: { status?: number; code?: string; name?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(error.name === "ZodError" ? 400 : (error.status ?? 500))
        .json({ code: error.code }),
  );
  return server;
}
beforeEach(() => {
  vi.restoreAllMocks();
  mocks.issue.mockReset();
});
describe("company HTTP contract", () => {
  it("relays only the user's own validated session when creating a switch", async () => {
    const create = vi
      .spyOn(companyRuntimeService, "createSwitch")
      .mockResolvedValue({
        ticket,
        target_company_id: otherCompany,
        environment: "cerp_test",
        expires_at: "2026-10-26T00:00:00Z",
      });
    const response = await request(app())
      .post("/api/v1/entreprises/switches")
      .send({ target_company_id: otherCompany, key });
    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, directory_session: "dir_fixture" }),
      otherCompany,
      key,
    );
    expect(
      (
        await request(app())
          .post("/api/v1/entreprises/switches")
          .send({ target_company_id: otherCompany, key, actor: 1 })
      ).status,
    ).toBe(400);
  });
  it("requires target scope and prevents sending a source bearer to the exchange", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: true,
      company_id: companyId,
      environment: "cerp_test",
    });
    const call = vi.fn();
    vi.spyOn(companyRuntimeService, "directory").mockReturnValue({
      call,
    } as never);
    for (const target of [otherCompany, "invalid"])
      expect(
        (
          await request(app())
            .post("/api/v1/entreprises/switches/exchange")
            .set("X-CERP-Company", target)
            .set("X-CERP-Database", "cerp_test")
            .send({ ticket, key })
        ).status,
      ).toBe(403);
    expect(
      (
        await request(app())
          .post("/api/v1/entreprises/switches/exchange")
          .set("X-CERP-Company", companyId)
          .set("X-CERP-Database", "cerp_test")
          .set("Authorization", "Bearer old-source")
          .send({ ticket, key })
      ).status,
    ).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });
  it("returns only the fixed active company sign-in context without a source session", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: true,
      company_id: companyId,
      environment: "cerp_test",
    });
    const call = vi.fn(async () => ({
      company: {
        id: companyId,
        code: "EC",
        name: "Esprit Carabine",
        profile: "COMMERCIAL",
      },
      environment: "cerp_test",
    }));
    vi.spyOn(companyRuntimeService, "directory").mockReturnValue({
      call,
    } as never);
    const defaultRuntime = await request(app()).get(
      "/api/v1/entreprises/sign-in-context",
    );
    expect(defaultRuntime.status).toBe(200);
    expect(defaultRuntime.body.company.id).toBe(companyId);
    const rejected = await request(app())
      .get("/api/v1/entreprises/sign-in-context")
      .set("X-CERP-Company", otherCompany)
      .set("X-CERP-Database", "cerp_test");
    expect(rejected.status).toBe(403);
    const response = await request(app())
      .get("/api/v1/entreprises/sign-in-context")
      .set("X-CERP-Company", companyId)
      .set("X-CERP-Database", "cerp_test");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      company: {
        id: companyId,
        code: "EC",
        name: "Esprit Carabine",
        profile: "COMMERCIAL",
      },
      environment: "cerp_test",
    });
    expect(call).toHaveBeenCalledWith("business-company-sign-in-context", {
      input: {},
    });
  });
  it("keeps bare legacy bootstrap compatible but rejects an explicit target when the feature is disabled", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({ enabled: false });
    expect((await request(app()).get("/api/v1/entreprises/sign-in-context")).status).toBe(404);
    const response = await request(app()).get("/api/v1/entreprises/sign-in-context").set("X-CERP-Company", companyId).set("X-CERP-Database", "cerp_test");
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("COMPANY_RUNTIME_NOT_ENABLED");
  });
  it("rejects wrong environments and malformed tickets before session creation", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: true,
      company_id: companyId,
      environment: "cerp_test",
    });
    expect(
      (
        await request(app())
          .post("/api/v1/entreprises/switches/exchange")
          .set("X-CERP-Company", companyId)
          .set("X-CERP-Database", "cerp_prod")
          .send({ ticket, key })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app())
          .post("/api/v1/entreprises/switches/exchange")
          .set("X-CERP-Company", companyId)
          .set("X-CERP-Database", "cerp_test")
          .send({ ticket: "bad", key })
      ).status,
    ).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("issues the target session only after Directory redemption and returns a matching company context", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: true,
      company_id: companyId,
      environment: "cerp_test",
    });
    const identity = {
      directory_session: "dir_target",
      identity: { profile_id: companyId },
    };
    const call = vi.fn(async () => identity);
    vi.spyOn(companyRuntimeService, "directory").mockReturnValue({
      call,
    } as never);
    mocks.issue.mockResolvedValue({ token: "target-token", user: { id: 81 } });
    const context = {
      contract_version: 1,
      mode: "COMPANY",
      active_company: { id: companyId },
      environment: "cerp_test",
    };
    vi.spyOn(companyRuntimeService, "view").mockResolvedValue(context as never);
    const response = await request(app())
      .post("/api/v1/entreprises/switches/exchange")
      .set("X-CERP-Company", companyId)
      .set("X-CERP-Database", "cerp_test")
      .send({ ticket, key });
    expect(response.status).toBe(200);
    expect(call).toHaveBeenCalledWith("business-company-switch-redeem", {
      input: { ticket, key },
    });
    expect(response.body).toMatchObject({
      token: "target-token",
      company_context: context,
    });
    expect(response.body).not.toHaveProperty("directory_session");
    expect(companyRuntimeService.view).toHaveBeenCalledWith({
      id: 81,
      directory_session: "dir_target",
      directory_profile_id: companyId,
    });
  });
  it("keeps a rejected ticket from creating any target session", async () => {
    vi.spyOn(companyRuntimeService, "configuration").mockReturnValue({
      enabled: true,
      company_id: companyId,
      environment: "cerp_test",
    });
    vi.spyOn(companyRuntimeService, "directory").mockReturnValue({
      call: vi.fn(async () => {
        throw { status: 403, code: "PRIVATE_DENIAL" };
      }),
    } as never);
    expect(
      (
        await request(app())
          .post("/api/v1/entreprises/switches/exchange")
          .set("X-CERP-Company", companyId)
          .set("X-CERP-Database", "cerp_test")
          .send({ ticket, key })
      ).status,
    ).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("relays the explicit tenant administrative level contract without using the legacy global endpoint", async () => {
    const call = vi.fn(async () => ({
      company_id: companyId,
      profile_id: otherCompany,
      environment: "cerp_prod",
      site_id: "cerp_company_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa_prod",
      is_superadmin: true,
      status: "Active",
      version: 4,
    }));
    vi.spyOn(companyRuntimeService, "directory").mockReturnValue({ call } as never);
    const path = `/api/v1/entreprises/admin/companies/${companyId}/instances/cerp_prod/memberships/${otherCompany}/administrative-level`;
    const get = await request(app()).get(path);
    expect(get.status).toBe(200);
    const put = await request(app())
      .put(path)
      .send({ is_superadmin: true, expected_version: 3 });
    expect(put.status).toBe(200);
    expect(call).toHaveBeenNthCalledWith(1, "business-companies-admin-site-superadmin-read", {
      directory_session: "dir_fixture",
      input: { company_id: companyId, environment: "cerp_prod", profile_id: otherCompany },
    });
    expect(call).toHaveBeenNthCalledWith(2, "business-companies-admin-site-superadmin-set", {
      directory_session: "dir_fixture",
      input: { company_id: companyId, environment: "cerp_prod", profile_id: otherCompany, is_superadmin: true, expected_version: 3 },
    });
  });
});
