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
    mocks.query.mockResolvedValue({ rows: [{ client_id: "003", company_name: "CRP", client_color: "#FCE7F3" }] });
    expect(await repoListPlanningClientColors()).toEqual({ "id:003": "#FCE7F3" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0]).not.toContain("planning_user_preferences");
  });
  it("reads the legacy common color while the additive patch is still pending", async () => {
    mocks.query.mockResolvedValue({ rows: [{ client_id: "003", company_name: "CRP", client_color: "#288F9C" }] });
    expect(await repoListPlanningClientColors()).toEqual({ "id:003": "#CCE4E8" });
    expect(mocks.query.mock.calls[0][0]).toContain("to_jsonb(c) ? 'planning_color_hex'");
  });
  it("keeps an explicit shared-color reset distinct from the legacy fallback", async () => {
    mocks.query.mockResolvedValue({ rows: [{ client_id: "003", company_name: "CRP", client_color: null }] });
    expect(await repoListPlanningClientColors()).toEqual({ "id:003": "#CCFBF1" });
    expect(mocks.query.mock.calls[0][0]).toContain("THEN to_jsonb(c)->>'planning_color_hex'");
    expect(mocks.query.mock.calls[0][0]).toContain("ELSE COALESCE(to_jsonb(c)->>'color_hex', to_jsonb(c)->>'color')");
  });
  it("updates only the chosen client, audits the change, and supports resetting", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_attribute")) return { rows: [{ present: true }] };
      return { rows: sql.startsWith("SELECT") ? [{ company_name: "CRP", planning_color_hex: "#FCE7F3" }] : [] };
    });
    expect(await repoSetPlanningClientColor("003", null, audit)).toEqual({ client_id: "003", color: "#CCFBF1" });
    expect(mocks.query).toHaveBeenCalledWith("UPDATE public.clients SET planning_color_hex = $2 WHERE client_id = $1", ["003", null]);
    expect(mocks.audit.mock.calls[0][0].body.details).toEqual({ before: "#FCE7F3", after: null });
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT");
  });
  it("rolls back if the audit cannot be recorded", async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes("pg_attribute")
      ? { rows: [{ present: true }] }
      : { rows: [{ company_name: "CRP", planning_color_hex: null }] });
    mocks.audit.mockResolvedValue(null);
    await expect(repoSetPlanningClientColor("003", "#DCFCE7", audit)).rejects.toThrow("AUDIT_FAILED");
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("rejects an unknown client without updating or logging a success", async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes("pg_attribute")
      ? { rows: [{ present: true }] }
      : { rows: [] });
    await expect(repoSetPlanningClientColor("missing", "#DCFCE7", audit)).rejects.toMatchObject({ status: 404 });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("fails closed with a controlled error before the additive column exists", async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes("pg_attribute")
      ? { rows: [{ present: false }] }
      : { rows: [] });
    await expect(repoSetPlanningClientColor("003", "#DCFCE7", audit)).rejects.toMatchObject({ status: 503, code: "PLANNING_CLIENT_COLOR_SCHEMA_UNAVAILABLE" });
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});
