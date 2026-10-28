import { describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock("../module/entreprises/repository/company-directory.repository", () => ({ assertCurrentBusinessCompanyOwner: ports.owner }));
import { approveDirectoryAccountRequest } from "./account-request.repository";
describe("account approval live owner recheck", () => {
  it("rolls back before account or company creation when ownership changed after HTTP authorization", async () => {
    ports.owner.mockRejectedValueOnce(Object.assign(new Error("owner revoked"), { status: 403 }));
    const query = vi.fn(async (sql: string) => sql.includes("FROM public.cerp_directory_account_requests WHERE")
      ? { rows: [{ id: "11111111-1111-4111-8111-111111111111", status: "PENDING", version: 0, password_hash: "private-test-fixture-only", expires_at: "2099-01-01" }] }
      : { rows: [] });
    const db = { connect: async () => ({ query, release: vi.fn() }) };
    await expect(approveDirectoryAccountRequest(db as any, {} as any, "11111111-1111-4111-8111-111111111111", { expected_version: 0, primary_role: "USER", roles: ["USER"], administrative_kind: "STANDARD", module_keys: ["clients"], company_access: [] }, "22222222-2222-4222-8222-222222222222")).rejects.toMatchObject({ status: 403 });
    expect(ports.owner).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO public\.(users|cerp_business_company_memberships|cerp_directory_memberships)/.test(sql))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
  });
});
