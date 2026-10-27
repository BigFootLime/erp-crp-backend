import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  validate: vi.fn(),
  requireOwner: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  membership: vi.fn(),
  instance: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  profiles: vi.fn(),
  siteLevelRead: vi.fn(),
  siteLevelSet: vi.fn(),
  query: vi.fn(),
}));

vi.mock("./session.repository", () => ({
  validateDirectorySession: ports.validate,
}));
vi.mock("./authority", () => ({ requireDirectoryOwner: ports.requireOwner }));
vi.mock(
  "../module/entreprises/repository/company-directory.repository",
  () => ({
    repoCreateBusinessCompany: ports.create,
    repoListBusinessCompanies: ports.list,
    repoSetBusinessCompanyInstance: ports.instance,
    repoSetBusinessCompanyMembership: ports.membership,
    repoUpdateBusinessCompany: ports.update,
    repoReadBusinessCompanyAdministration: ports.detail,
    repoSearchBusinessCompanyProfiles: ports.profiles,
    repoReadBusinessCompanySiteAdministrativeLevel: ports.siteLevelRead,
    repoSetBusinessCompanySiteAdministrativeLevel: ports.siteLevelSet,
  }),
);

import { mountDirectoryBusinessCompanyAdministration } from "./business-company-admin.operations";

const session = `dir_${"a".repeat(64)}`;
const companyId = "22222222-2222-4222-8222-222222222222";
const profileId = "33333333-3333-4333-8333-333333333333";
const owner = {
  profile_id: profileId,
  source_user_id: 91,
  database: "cerp_prod",
  is_superadmin: true,
  mfa_factor_id: "44444444-4444-4444-8444-444444444444",
  mfa_factor_version: 1,
  mfa_verified_at: new Date().toISOString(),
  mfa_method: "totp",
};

function companyInput(overrides: Record<string, unknown> = {}) {
  return {
    id: companyId,
    code: "EC",
    name: "Esprit Carabine",
    status: "ACTIVE",
    profile: "COMMERCIAL",
    enabled_module_keys: ["clients", "commandes-clients"],
    enabled_commercial_projection_capabilities: [],
    ...overrides,
  };
}

function fixture(enabled = true) {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    (req as express.Request & { directoryCaller?: string }).directoryCaller =
      "cerp_prod";
    next();
  });
  mountDirectoryBusinessCompanyAdministration(
    app,
    { query: ports.query } as never,
    (work) => (req, res, next) => void work(req, res).catch(next),
    enabled,
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const candidate = error as {
        name?: string;
        status?: number;
        code?: string;
        message?: string;
      };
      res
        .status(candidate.name === "ZodError" ? 400 : (candidate.status ?? 500))
        .json({ code: candidate.code ?? candidate.message });
    },
  );
  return app;
}

function body(input: unknown) {
  return { directory_session: session, input };
}

describe("business company Directory administration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.validate.mockResolvedValue(owner);
    ports.requireOwner.mockResolvedValue(undefined);
    ports.query.mockResolvedValue({ rows: [] });
    ports.create.mockResolvedValue({ company_id: companyId, version: 1 });
    ports.membership.mockResolvedValue({
      company_id: companyId,
      profile_id: profileId,
      version: 1,
    });
    ports.instance.mockResolvedValue({
      company_id: companyId,
      environment: "cerp_prod",
      version: 1,
    });
  });

  it("does not mount when the company runtime is disabled", async () => {
    const response = await request(fixture(false))
      .post("/internal/directory/business-companies-admin-list")
      .send(body({}));
    expect(response.status).toBe(404);
    expect(ports.validate).not.toHaveBeenCalled();
  });
  it("loads versioned detail and explicit central identity choices behind the same owner boundary", async () => {
    ports.detail.mockResolvedValue({
      company_id: companyId,
      version: 2,
      memberships: [],
      instances: [],
    });
    ports.profiles.mockResolvedValue([
      { profile_id: profileId, username: "operator", status: "Active" },
    ]);
    const detail = await request(fixture())
      .post("/internal/directory/business-companies-admin-detail")
      .send(body({ company_id: companyId }));
    expect(detail.body).toMatchObject({ company_id: companyId, version: 2 });
    const options = await request(fixture())
      .post("/internal/directory/business-companies-admin-options")
      .send(body({ search: "operator" }));
    expect(options.body.profiles).toEqual([
      { profile_id: profileId, username: "operator", status: "Active" },
    ]);
    expect(ports.profiles).toHaveBeenCalledWith(expect.anything(), "operator");
    expect(options.body.modules).toContainEqual(
      expect.objectContaining({ key: "clients" }),
    );
    expect(ports.requireOwner).toHaveBeenCalledTimes(2);
  });
  it("does not let an owner lock out their current company context", async () => {
    ports.query.mockResolvedValue({ rows: [{ site_id: owner.database }] });
    expect(
      (
        await request(fixture())
          .post("/internal/directory/business-companies-admin-update")
          .send(
            body({
              ...companyInput(),
              status: "SUSPENDED",
              expected_version: 1,
            }),
          )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(fixture())
          .post("/internal/directory/business-companies-admin-membership")
          .send(
            body({
              company_id: companyId,
              profile_id: profileId,
              status: "REVOKED",
              allowed_module_keys: [],
              denied_module_keys: [],
              enabled_commercial_projection_capabilities: [],
              expected_version: 1,
            }),
          )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(fixture())
          .post("/internal/directory/business-companies-admin-instance")
          .send(
            body({
              company_id: companyId,
              environment: "cerp_prod",
              site_id: owner.database,
              active: false,
              expected_version: 1,
            }),
          )
      ).status,
    ).toBe(409);
    expect(ports.update).not.toHaveBeenCalled();
    expect(ports.membership).not.toHaveBeenCalled();
    expect(ports.instance).not.toHaveBeenCalled();
  });

  it("rejects an ordinary caller before a repository is reached", async () => {
    ports.requireOwner.mockRejectedValue({
      status: 403,
      code: "DIRECTORY_OWNER_REQUIRED",
    });
    const response = await request(fixture())
      .post("/internal/directory/business-companies-admin-create")
      .send(body(companyInput()));
    expect(response.status).toBe(403);
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("requires the owner step-up boundary before mutation", async () => {
    ports.requireOwner.mockRejectedValue({
      status: 428,
      code: "MFA_STEP_UP_REQUIRED",
    });
    const response = await request(fixture())
      .post("/internal/directory/business-companies-admin-create")
      .send(body(companyInput()));
    expect(response.status).toBe(428);
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("rejects malformed company profiles, unknown modules and forged actor data", async () => {
    const app = fixture();
    await expect(
      request(app)
        .post("/internal/directory/business-companies-admin-create")
        .send(body(companyInput({ profile: "UNKNOWN" })))
        .then((response) => response.status),
    ).resolves.toBe(400);
    await expect(
      request(app)
        .post("/internal/directory/business-companies-admin-create")
        .send(body(companyInput({ enabled_module_keys: ["not-a-module"] })))
        .then((response) => response.status),
    ).resolves.toBe(400);
    await expect(
      request(app)
        .post("/internal/directory/business-companies-admin-create")
        .send(body(companyInput({ source_user_id: 1 })))
        .then((response) => response.status),
    ).resolves.toBe(400);
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("creates a membership at expected version zero using only the central actor", async () => {
    const response = await request(fixture())
      .post("/internal/directory/business-companies-admin-membership")
      .send(
        body({
          company_id: companyId,
          profile_id: profileId,
          status: "ACTIVE",
          allowed_module_keys: [],
          denied_module_keys: [],
          enabled_commercial_projection_capabilities: [],
          expected_version: 0,
        }),
      );
    expect(response.status).toBe(200);
    expect(ports.membership).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expected_version: 0 }),
      expect.objectContaining({ user_id: owner.source_user_id }),
    );
  });

  it("maps optimistic conflicts and rejects invalid instance environment bindings", async () => {
    ports.membership.mockRejectedValue(
      new Error("BUSINESS_COMPANY_MEMBERSHIP_VERSION_CONFLICT"),
    );
    const conflict = await request(fixture())
      .post("/internal/directory/business-companies-admin-membership")
      .send(
        body({
          company_id: companyId,
          profile_id: profileId,
          status: "ACTIVE",
          allowed_module_keys: [],
          denied_module_keys: [],
          enabled_commercial_projection_capabilities: [],
          expected_version: 1,
        }),
      );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("BUSINESS_COMPANY_CONFIGURATION_CONFLICT");

    const invalid = await request(fixture())
      .post("/internal/directory/business-companies-admin-instance")
      .send(
        body({
          company_id: companyId,
          environment: "cerp_test",
          site_id: "cerp_prod",
          active: true,
          expected_version: 0,
        }),
      );
    expect(invalid.status).toBe(400);
    expect(ports.instance).not.toHaveBeenCalled();
  });
  it("requires the same live owner and MFA boundary for a site-scoped superadmin grant", async () => {
    ports.siteLevelSet.mockResolvedValue({
      company_id: companyId,
      profile_id: profileId,
      environment: "cerp_prod",
      site_id: "cerp_company_22222222222242228222222222222222_prod",
      is_superadmin: true,
      status: "Active",
      version: 8,
    });
    const response = await request(fixture())
      .post("/internal/directory/business-companies-admin-site-superadmin-set")
      .send(body({
        company_id: companyId,
        profile_id: profileId,
        environment: "cerp_prod",
        is_superadmin: true,
        expected_version: 7,
      }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ is_superadmin: true, version: 8 });
    expect(ports.requireOwner).toHaveBeenCalled();
    expect(ports.siteLevelSet).toHaveBeenCalledWith(
      expect.anything(),
      owner,
      expect.objectContaining({ expected_version: 7 }),
    );
  });
  it("rejects a global CRP reference before a tenant repository is reached", async () => {
    const response = await request(fixture())
      .post("/internal/directory/business-companies-admin-site-superadmin-set")
      .send(body({
        company_id: companyId,
        profile_id: profileId,
        environment: "cerp_prod",
        site_id: "cerp_prod",
        is_superadmin: true,
        expected_version: 0,
      }));
    expect(response.status).toBe(400);
    expect(ports.siteLevelSet).not.toHaveBeenCalled();
  });
});
