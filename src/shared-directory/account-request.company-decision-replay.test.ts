import { describe, expect, it, vi } from "vitest";
import { approveDirectoryAccountRequest } from "./account-request.repository";
import { approvedCompanyDecision, sameApprovedCompanyDecision } from "./account-request-company-access";
const company = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const original = [{ company_id: company, expected_membership_version: 0 }];
const input = { expected_version: 1, primary_role: "USER", roles: ["USER"], administrative_kind: "STANDARD" as const, module_keys: ["clients"] };
function database() {
  const row = { id: other, status: "PROJECTION_PENDING", version: 1, profile_id: company, approved_username: "fixture", primary_role: "USER", roles: ["USER"], administrative_kind: "STANDARD", module_keys: ["clients"], email: "fixture@example.invalid", expires_at: "2099-01-01" };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM public.cerp_directory_account_requests WHERE")) return { rows: [row] };
    if (sql.includes("AS decision FROM")) return { rows: [{ decision: approvedCompanyDecision(original) }] };
    return { rows: [] };
  });
  return { query, db: { connect: async () => ({ query, release: vi.fn() }) } };
}
describe("account approval company decision replay", () => {
  it("keeps legacy omission distinct from an explicitly empty first decision", () => {
    expect(sameApprovedCompanyDecision([], approvedCompanyDecision(undefined))).toBe(false);
    expect(sameApprovedCompanyDecision([], approvedCompanyDecision([]))).toBe(true);
  });
  it("resumes a prepared company selection when the replay does not ask to change it", async () => {
    const d = database();
    const result = await approveDirectoryAccountRequest(d.db as any, {} as any, other, input, company);
    expect(result).toHaveProperty("company_access_decision", approvedCompanyDecision(original));
    expect(d.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
    expect(d.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO public.users"))).toBe(false);
  });
  it.each([{ company_access: [] }, { company_access: [{ company_id: other, expected_membership_version: 0 }] }])("rejects a divergent explicit selection under a new idempotency key", async ({ company_access }) => {
    const d = database();
    await expect(approveDirectoryAccountRequest(d.db as any, {} as any, other, { ...input, company_access }, company)).rejects.toMatchObject({ code: "ACCOUNT_REQUEST_DECISION_CONFLICT" });
    expect(d.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(d.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO public.cerp_directory_account_request_mutations"))).toBe(false);
  });
});
