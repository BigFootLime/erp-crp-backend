import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { validate, create, read, list, lock } = vi.hoisted(() => ({
  validate: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  list: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("./session.repository", () => ({
  validateDirectorySession: validate,
  createDirectorySessionFromIdentity: create,
}));
vi.mock("./business-company-switch.repository", () => ({
  switchHash: (v: string) => `h:${v}`,
  readSwitchState: read,
  listAccessibleBusinessCompanies: list,
  lockSwitch: lock,
}));
import { mountDirectoryBusinessCompanies } from "./business-company.operations";

const source = {
  profile_id: "00000000-0000-4000-8000-000000000001",
  source_user_id: 7,
  global_session_epoch: 2,
  membership_version: 3,
  mfa_factor_id: "00000000-0000-4000-8000-000000000002",
  mfa_factor_version: 1,
  mfa_verified_at: new Date().toISOString(),
  mfa_method: "totp",
};
const state = {
  company_id: "00000000-0000-4000-8000-000000000010",
  code: "ACME",
  name: "Acme",
  profile: "COMMERCIAL",
  enabled_module_keys: ["commercial"],
  company_projection_capabilities: ["stock.projection.read"],
  denied_module_keys: [],
  membership_projection_capabilities: [],
  environment: "cerp_test",
  site_id: "cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_test",
  company_membership_version: 4,
  source_company_membership_version: 5,
  target_directory_membership_version: 8,
  source_membership_version: 3,
  global_session_epoch: 2,
  source_session_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  profile_id: source.profile_id,
  source_user_id: 7,
  mfa_factor_id: source.mfa_factor_id,
  mfa_factor_version: 1,
  mfa_verified_at: source.mfa_verified_at,
  mfa_method: "totp",
  tablet_device_id: null,
  tablet_pin_version: null,
};
const session = "dir_" + "a".repeat(64),
  key = "00000000-0000-4000-8000-000000000099";

function fixture() {
  const calls: string[] = [];
  let existing: any = null;
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    calls.push(sql);
    if (sql.includes("pg_advisory")) return { rows: [] };
    if (
      sql.includes(
        "SELECT company_id::text FROM public.cerp_business_company_instances",
      )
    )
      return { rows: [{ company_id: state.company_id }] };
    if (sql.includes("SELECT company_id::text,i.environment"))
      return {
        rows: [
          {
            company_id: state.company_id,
            environment: "cerp_test",
            site_id: state.site_id,
            active: true,
          },
        ],
      };
    if (sql.includes("WHERE source_session_hash") && sql.includes("FOR UPDATE"))
      return { rows: existing ? [existing] : [] };
    if (sql.includes("INSERT INTO public.cerp_business_company_switches")) {
      existing = {
        company_id: state.company_id,
        target_site: state.site_id,
        environment: "cerp_test",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
      return { rows: [{ expires_at: existing.expires_at }] };
    }
    return { rows: [] };
  });
  const db: any = { query, connect: async () => ({ query, release: vi.fn() }) };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.directoryCaller = state.site_id;
    next();
  });
  mountDirectoryBusinessCompanies(
    app,
    db,
    (work: any) => (req, res, next) => void work(req, res).catch(next),
    { enabled: true, sourceJwtSecret: "switch-test-secret" },
  );
  app.use((err: any, _req: any, res: any, _next: any) =>
    res
      .status(err.name === "ZodError" ? 400 : (err.status ?? 500))
      .json({ code: err.code ?? err.message }),
  );
  return {
    app,
    calls,
    setExisting: (v: any) => {
      existing = v;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  validate.mockResolvedValue(source);
  read.mockResolvedValue(state);
  list.mockResolvedValue([
    { id: state.company_id, code: "ACME", name: "Acme", profile: "COMMERCIAL" },
  ]);
});

describe("business company private operations", () => {
  it("does not mount when disabled", async () => {
    const app = express();
    app.use(express.json());
    mountDirectoryBusinessCompanies(app, {} as any, (w: any) => w, {
      enabled: false,
      sourceJwtSecret: "x",
    });
    expect(
      (
        await request(app)
          .post("/internal/directory/business-company-list")
          .send({})
      ).status,
    ).toBe(404);
  });
  it("returns the fixed internal context and ignores browser-selected company input", async () => {
    const { app } = fixture();
    const res = await request(app)
      .post("/internal/directory/business-company-context")
      .send({
        directory_session: session,
        input: { company_id: "00000000-0000-4000-8000-000000000099" },
      });
    expect(res.status).toBe(400);
    const ok = await request(app)
      .post("/internal/directory/business-company-context")
      .send({ directory_session: session, input: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.company).toMatchObject({
      id: state.company_id,
      code: "ACME",
    });
    expect(validate).toHaveBeenCalledWith(
      expect.anything(),
      state.site_id,
      session,
      { autoProvisionTestMembership: false },
    );
  });
  it("creates then replays the same opaque ticket and rejects a changed target for that key", async () => {
    const { app, setExisting } = fixture();
    const body = {
      directory_session: session,
      input: { company_id: state.company_id, key },
    };
    const first = await request(app)
      .post("/internal/directory/business-company-switch-create")
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      target_company_id: state.company_id,
      environment: "cerp_test",
    });
    expect(first.body.ticket).toMatch(/^[a-f0-9]{64}$/);
    setExisting({
      company_id: "00000000-0000-4000-8000-000000000011",
      target_site: state.site_id,
      environment: "cerp_test",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const conflict = await request(app)
      .post("/internal/directory/business-company-switch-create")
      .send(body);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe(
      "BUSINESS_COMPANY_SWITCH_IDEMPOTENCY_CONFLICT",
    );
  });
  it("rejects an expired replay before exposing a ticket", async () => {
    const { app, setExisting } = fixture();
    setExisting({
      company_id: state.company_id,
      target_site: state.site_id,
      environment: "cerp_test",
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    const res = await request(app)
      .post("/internal/directory/business-company-switch-create")
      .send({
        directory_session: session,
        input: { company_id: state.company_id, key },
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("BUSINESS_COMPANY_SWITCH_REJECTED");
  });
  it("redeem rejects a wrong signed target before creating a session", async () => {
    const { app } = fixture();
    lock.mockResolvedValue({
      ...state,
      ticket_hash: "h:t",
      request_key: key,
      source_session_hash: "h:" + session,
      source_site: state.site_id,
      target_site: "cerp_company_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_test",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await request(app)
      .post("/internal/directory/business-company-switch-redeem")
      .send({ input: { ticket: "b".repeat(64), key } });
    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("redeems deterministically and carries the original MFA and tablet assurance", async () => {
    const { app } = fixture();
    const ticket = "c".repeat(64);
    const tablet = "00000000-0000-4000-8000-000000000077";
    const assured = {
      ...state,
      tablet_device_id: tablet,
      tablet_pin_version: 6,
    };
    lock.mockResolvedValue({
      ...assured,
      ticket_hash: "h:t",
      request_key: key,
      source_session_hash: "h:" + session,
      source_site: state.site_id,
      target_site: state.site_id,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    read.mockResolvedValue(assured);
    create.mockResolvedValue({
      directory_session: "dir_" + "d".repeat(64),
      identity: { profile_id: source.profile_id },
    });
    const body = { input: { ticket, key } };
    const first = await request(app)
      .post("/internal/directory/business-company-switch-redeem")
      .send(body);
    const retry = await request(app)
      .post("/internal/directory/business-company-switch-redeem")
      .send(body);
    expect(first.status).toBe(200);
    expect(retry.body.directory_session).toBe(first.body.directory_session);
    expect(create).toHaveBeenLastCalledWith(
      expect.anything(),
      state.site_id,
      expect.objectContaining({
        mfa_verified_at: source.mfa_verified_at,
        tablet_device_id: tablet,
        tablet_pin_version: 6,
      }),
      expect.objectContaining({
        token: expect.stringMatching(/^dir_[a-f0-9]{64}$/),
      }),
    );
    expect(create.mock.calls.map((call) => call[3].token)).toEqual([
      create.mock.calls[0][3].token,
      create.mock.calls[0][3].token,
    ]);
    expect(JSON.stringify(first.body)).not.toContain("switch-test-secret");
  });

  it("rejects a different redemption key and a revoked source state", async () => {
    const { app } = fixture();
    lock.mockResolvedValue({
      ...state,
      ticket_hash: "h:t",
      request_key: key,
      source_session_hash: "h:" + session,
      source_site: state.site_id,
      target_site: state.site_id,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const wrong = await request(app)
      .post("/internal/directory/business-company-switch-redeem")
      .send({
        input: {
          ticket: "e".repeat(64),
          key: "00000000-0000-4000-8000-000000000098",
        },
      });
    expect(wrong.status).toBe(403);
    read.mockResolvedValue(null);
    const revoked = await request(app)
      .post("/internal/directory/business-company-switch-redeem")
      .send({ input: { ticket: "e".repeat(64), key } });
    expect(revoked.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
});
