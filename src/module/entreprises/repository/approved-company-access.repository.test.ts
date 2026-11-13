import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ owner: vi.fn(), membership: vi.fn() }));
vi.mock("./company-directory.repository", () => ({ assertCurrentBusinessCompanyOwner: ports.owner, repoSetBusinessCompanyMembershipTx: ports.membership }));
import { approvedCompanyProposal, repoApplyApprovedCompanyAccess, repoReadApprovedSourceBinding } from "./approved-company-access.repository";
import { approvedCompanyAccessUpdateSchema } from "../domain/approved-company-access";

const profile = "11111111-1111-4111-8111-111111111111";
const first = "22222222-2222-4222-8222-222222222222";
const second = "33333333-3333-4333-8333-333333333333";
const binding = { profile_id: profile, site: "cerp_test" as const, membership_version: 4 };
const snapshot = { profile_id: profile, source_site: "cerp_test" as const, authority_id: second, source_epoch: "12", source_hash: "a".repeat(64), request_nonce: first, issued_at: 1, module_keys: ["clients", "stock", "production"] };
const actor = { profile_id: second, source_user_id: 71 } as any;
function row(id = first, overrides: Record<string, unknown> = {}) {
  return { company_id: id, code: "EC", name: "Commercial", profile: "COMMERCIAL", status: "ACTIVE", version: 2,
    enabled_module_keys: ["clients", "commandes-clients"], enabled_commercial_projection_capabilities: ["stock.projection.read"],
    membership_version: 3, membership_status: "ACTIVE", denied_module_keys: ["clients"], membership_capabilities: [], prod_ready: true, test_ready: true, ...overrides } as any;
}
function input(ids = [first, second]) {
  return { source_site: binding.site, source_membership_version: 4, source_hash: snapshot.source_hash,
    company_access: ids.map(company_id => ({ company_id, expected_company_version: 2, expected_membership_version: 3, enabled: true })) };
}
function database(rows = [row(), row(second)]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT m.version,m.status")) return { rows: [{ version: 4, status: "Active" }] };
    if (sql.includes("coalesce(m.version,0)")) return { rows };
    return { rows: [] };
  });
  const tx = { query, release: vi.fn() };
  return { db: { connect: vi.fn(async () => tx) }, tx, query };
}
describe("approved account company eligibility", () => {
  beforeEach(() => { vi.clearAllMocks(); ports.owner.mockResolvedValue(undefined); ports.membership.mockResolvedValue({}); });
  it("caps an effective Test source without copying industrial modules, denies or disabled projections", () => {
    const result = approvedCompanyProposal(row(), snapshot.module_keys);
    expect(result.allowed_module_keys).toEqual(["clients"]);
    expect(result.effective_module_keys).toEqual([]);
    expect(result.denied_module_keys).toEqual(["clients"]);
    expect(result.enabled_commercial_projection_capabilities).toEqual([]);
    expect(result).not.toHaveProperty("is_superadmin");
  });
  it("uses a Test-only approved binding without creating global Production access", async () => {
    const q = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [binding] }));
    expect(await repoReadApprovedSourceBinding({ query: q } as any, profile)).toEqual(binding);
    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0]?.[0]).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
  it("rejects a stale second company before any grant and rolls the whole transaction back", async () => {
    const d = database([row(), row(second, { membership_version: 5 })]);
    await expect(repoApplyApprovedCompanyAccess(d.db as any, binding, snapshot, input(), actor)).rejects.toMatchObject({ status: 409 });
    expect(ports.membership).not.toHaveBeenCalled();
    expect(d.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(d.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });
  it("uses one connection and the existing transactional writer for every company", async () => {
    const d = database();
    await repoApplyApprovedCompanyAccess(d.db as any, binding, snapshot, input(), actor);
    expect(d.db.connect).toHaveBeenCalledTimes(1);
    expect(ports.membership).toHaveBeenCalledTimes(2);
    for (const call of ports.membership.mock.calls) {
      expect(call[0]).toBe(d.tx);
      expect(call[1].denied_module_keys).toEqual(["clients"]);
      expect(call[1]).not.toHaveProperty("is_superadmin");
      expect(call[2].user_id).toBe(71);
    }
    expect(d.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
  });
  it("rolls back all earlier writes when a later projection fails", async () => {
    const d = database();
    ports.membership.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("projection failed"));
    await expect(repoApplyApprovedCompanyAccess(d.db as any, binding, snapshot, input(), actor)).rejects.toThrow("projection failed");
    expect(ports.membership.mock.calls.every(call => call[0] === d.tx)).toBe(true);
    expect(d.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
  });
  it("revokes an explicitly unchecked current membership", async () => {
    const d = database([row()]), request = input([first]); request.company_access[0]!.enabled = false;
    await repoApplyApprovedCompanyAccess(d.db as any, binding, snapshot, request, actor);
    expect(ports.membership.mock.calls[0]?.[1].status).toBe("REVOKED");
  });
  it("rejects changed source metadata and owner assurance before any membership write", async () => {
    const d = database();
    await expect(repoApplyApprovedCompanyAccess(d.db as any, binding, snapshot, { ...input(), source_hash: "b".repeat(64) }, actor)).rejects.toMatchObject({ status: 409 });
    expect(d.db.connect).not.toHaveBeenCalled();
    ports.owner.mockRejectedValueOnce(Object.assign(new Error("owner revoked"), { status: 403 }));
    await expect(repoApplyApprovedCompanyAccess(d.db as any, binding, snapshot, input(), actor)).rejects.toMatchObject({ status: 403 });
    expect(ports.membership).not.toHaveBeenCalled();
  });
  it("rejects duplicate companies and any second client-controlled module decision", () => {
    expect(approvedCompanyAccessUpdateSchema.safeParse({ ...input([first]), module_keys: ["production"] }).success).toBe(false);
    expect(approvedCompanyAccessUpdateSchema.safeParse(input([first, first])).success).toBe(false);
  });
  it("keeps the current central owner from locking themselves out of primary account administration", async () => {
    const d = database([row(first, { primary_company: true })]), request = input([first]);
    request.company_access[0]!.enabled = false;
    await expect(repoApplyApprovedCompanyAccess(d.db as any, binding, snapshot, request, { ...actor, profile_id: profile })).rejects.toMatchObject({ code: "BUSINESS_COMPANY_OWNER_SELF_ACCESS_REQUIRED" });
    expect(ports.membership).not.toHaveBeenCalled();
  });
});
