import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), release: vi.fn(), audit: vi.fn(), qualify: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { connect: mocks.connect, query: vi.fn() } }));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));
vi.mock("./electronic-invoice-issuer.repository", () => ({ qualifyIssuerElectronicAddress: mocks.qualify }));
import { persistDirectoryVerification } from "./electronic-invoice-directory.repository";
const params = { resourceType: "ISSUER" as const, resourceId: "issuer", siren: "999999998", identifier: "0225:999999998", expectedUpdatedAt: "2026-01-01T00:00:00Z", idempotencyKey: "issuer-1219-key", audit: { user_id: 7, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null } };
let current: { siren: string; updated_at: string; previous_address: object };
beforeEach(() => {
  vi.resetAllMocks();
  current = { siren: params.siren, updated_at: params.expectedUpdatedAt, previous_address: {} };
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FOR UPDATE") ? [current] : [] }));
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.qualify.mockResolvedValue({ rows: [{ verified_at: "2026-10-11T12:00:00Z" }] });
});
describe("issuer directory mutation atomicity", () => {
  it("qualifies, records the replay receipt and audits in the same transaction", async () => {
    const result = await persistDirectoryVerification(params);
    expect(result).toMatchObject({ resource_type: "ISSUER", idempotent_replay: false });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_xact_lock"), ["finance_legal_mentions:issuer"]);
    expect(mocks.qualify).toHaveBeenCalledWith(expect.objectContaining({ query: mocks.query }), expect.objectContaining({ actorId: 7, identifier: params.identifier }));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO public.einvoice_directory_verification_commands"), expect.arrayContaining(["ISSUER"]));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tx: expect.objectContaining({ query: mocks.query }), body: expect.objectContaining({ details: expect.objectContaining({ previous_address: {} }) }) }));
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each(["siren", "updated_at"] as const)("refuses a concurrent change to %s without qualification", async (field) => {
    current[field] = field === "siren" ? "111111111" : "2026-10-11T12:00:00Z";
    await expect(persistDirectoryVerification(params)).rejects.toMatchObject({ status: 409 });
    expect(mocks.qualify).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
  it("rolls back the routing and receipt when the audit fails", async () => {
    mocks.audit.mockRejectedValue(new Error("audit unavailable"));
    await expect(persistDirectoryVerification(params)).rejects.toThrow("audit unavailable");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});
