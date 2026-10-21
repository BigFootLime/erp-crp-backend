import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), audit: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { query: mocks.query, connect: async () => ({ query: mocks.query, release: mocks.release }) } }));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));
import { repoListPlanningClientColors, repoSetPlanningClientColor } from "./planning-client-color.repository";
import type { AuditContext } from "./planning.repository";
const audit = { user_id: 1, role: "PLANIFICATEUR", ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null } satisfies AuditContext;
describe("Workshop-wide client colors", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.audit.mockResolvedValue({ id: "audit" }); });
  it("reads the common assignment, without querying any user's preferences", async () => {
    mocks.query.mockResolvedValue({ rows: [{ client_id: "003", company_name: "CRP", planning_color_hex: "#FCE7F3" }] });
    expect(await repoListPlanningClientColors()).toEqual({ "id:003": "#FCE7F3" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0]).not.toContain("planning_user_preferences");
  });
  it("updates only the chosen client, audits the change, and supports resetting", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [{ company_name: "CRP", planning_color_hex: "#FCE7F3" }] : [] }));
    expect(await repoSetPlanningClientColor("003", null, audit)).toEqual({ client_id: "003", color: "#CCFBF1" });
    expect(mocks.query).toHaveBeenCalledWith("UPDATE public.clients SET planning_color_hex = $2 WHERE client_id = $1", ["003", null]);
    expect(mocks.audit.mock.calls[0][0].body.details).toEqual({ before: "#FCE7F3", after: null });
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT");
  });
  it("rolls back if the audit cannot be recorded", async () => {
    mocks.query.mockResolvedValue({ rows: [{ company_name: "CRP", planning_color_hex: null }] });
    mocks.audit.mockResolvedValue(null);
    await expect(repoSetPlanningClientColor("003", "#DCFCE7", audit)).rejects.toThrow("AUDIT_FAILED");
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("rejects an unknown client without updating or logging a success", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(repoSetPlanningClientColor("missing", "#DCFCE7", audit)).rejects.toMatchObject({ status: 404 });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  });
});
