import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ validate: vi.fn(), owner: vi.fn(), binding: vi.fn(), snapshot: vi.fn(), options: vi.fn(), apply: vi.fn() }));
vi.mock("./session.repository", () => ({ validateDirectorySession: ports.validate }));
vi.mock("./authority", () => ({ requireDirectoryOwner: ports.owner }));
vi.mock("./approved-account-access-source", () => ({ readApprovedAccountAccessSource: ports.snapshot }));
vi.mock("../module/entreprises/repository/approved-company-access.repository", () => ({ repoReadApprovedSourceBinding: ports.binding, repoReadApprovedCompanyOptions: ports.options, repoApplyApprovedCompanyAccess: ports.apply }));
import { mountDirectoryBusinessCompanyAdministration } from "./business-company-admin.operations";
const profile = "11111111-1111-4111-8111-111111111111", authority = "22222222-2222-4222-8222-222222222222";
const owner = { profile_id: authority, source_user_id: 91, database: "cerp_test" };
const binding = { profile_id: profile, site: "cerp_test", membership_version: 3 };
const snapshot = { profile_id: profile, source_site: "cerp_test", module_keys: ["clients"], source_epoch: "4", source_hash: "a".repeat(64) };
function fixture() {
  const app = express();app.use(express.json());
  app.use((req, _res, next) => { (req as any).directoryCaller = "cerp_test";next(); });
  mountDirectoryBusinessCompanyAdministration(app, {} as any, work => (req, res, next) => { void work(req, res).catch(next); }, true,
    { authorityId: authority, keys: async () => new Map([["cerp_test", "b".repeat(64)]]) });
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.name === "ZodError" ? 400 : error.status ?? 500).json({ code: error.code }));
  return app;
}
function call(operation: string, input: unknown) {
  return request(fixture()).post("/internal/directory/" + operation).send({ directory_session: "dir_" + "c".repeat(64), input });
}
describe("approved existing-account Directory operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();ports.validate.mockResolvedValue(owner);ports.owner.mockResolvedValue(undefined);
    ports.binding.mockResolvedValue(binding);ports.snapshot.mockResolvedValue(snapshot);ports.options.mockResolvedValue({ profile_id: profile, companies: [] });ports.apply.mockResolvedValue({ profile_id: profile, companies: [] });
  });
  it("supports a central owner connected in Test and reads only its server-chosen signed source", async () => {
    await call("business-companies-admin-approved-access-options", { profile_id: profile }).expect(200);
    expect(ports.owner).toHaveBeenCalledWith(expect.anything(), owner);
    expect(ports.snapshot).toHaveBeenCalledWith({ authority_id: authority, profile_id: profile, source_site: "cerp_test" }, "b".repeat(64), undefined);
    expect(ports.apply).not.toHaveBeenCalled();
  });
  it.each([403, 428])("blocks source reads and mutations when owner/MFA rejects with %s", async status => {
    ports.owner.mockRejectedValueOnce(Object.assign(new Error("denied"), { status }));
    await call("business-companies-admin-approved-access-options", { profile_id: profile }).expect(status);
    expect(ports.snapshot).not.toHaveBeenCalled();expect(ports.apply).not.toHaveBeenCalled();
  });
  it("fails closed when the signed native source is unavailable", async () => {
    ports.snapshot.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }));
    await call("business-companies-admin-approved-access-set", { profile_id: profile, source_site: "cerp_test", source_membership_version: 3, source_hash: snapshot.source_hash, company_access: [] }).expect(503);
    expect(ports.apply).not.toHaveBeenCalled();
  });
  it("accepts explicit revocation states but no client-controlled module set or site URL", async () => {
    const input = { profile_id: profile, source_site: "cerp_test", source_membership_version: 3, source_hash: snapshot.source_hash, company_access: [{ company_id: authority, expected_company_version: 1, expected_membership_version: 2, enabled: false }] };
    await call("business-companies-admin-approved-access-set", input).expect(200);
    const { profile_id: _profile, ...selection } = input;
    expect(ports.apply).toHaveBeenCalledWith(expect.anything(), binding, snapshot, selection, owner);
  });
  it("rejects additional module decisions before consulting the source", async () => {
    await call("business-companies-admin-approved-access-set", { profile_id: profile, source_site: "cerp_test", source_membership_version: 3, source_hash: snapshot.source_hash, company_access: [], module_keys: ["production"] }).expect(400);
    expect(ports.snapshot).not.toHaveBeenCalled();expect(ports.apply).not.toHaveBeenCalled();
  });
});
