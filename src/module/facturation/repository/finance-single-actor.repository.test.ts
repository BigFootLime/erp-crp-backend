import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), query: vi.fn(), connect: vi.fn(), release: vi.fn(), audit: vi.fn(), event: vi.fn(), receipt: vi.fn(), acquire: vi.fn() }));
vi.mock("../../access-control/repository/sensitive-capabilities.repository", () => ({ repoAccountSensitiveCapabilities: mocks.capabilities }));
vi.mock("../../../config/database", () => ({ default: { connect: mocks.connect } }));
vi.mock("./workflow.repository.shared", async () => ({
  ...await vi.importActual<typeof import("./workflow.repository.shared")>("./workflow.repository.shared"),
  acquireFinanceIdempotency: mocks.acquire, insertFinanceEvent: mocks.event,
  insertGlobalFinanceAudit: mocks.audit, saveFinanceReceipt: mocks.receipt,
}));
import { repoValidateFacture } from "./facture-workflow.repository";
import { repoValidateAvoir } from "./avoir-workflow.repository";
import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";

const actor = { userId: 7, requestId: "same-actor-1227", path: "/factures/workflow/1/validate" };
let current: { id: number; uuid: string; created_by: number; statut: string; row_version: number; draft_reference: string };
beforeEach(() => {
  vi.resetAllMocks();
  current = { id: 1, uuid: "11111111-1111-4111-8111-111111111111", created_by: 7, statut: "PENDING_VALIDATION", row_version: 2, draft_reference: "DFT-TEST" };
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.acquire.mockResolvedValue({ replay: null, idempotencyKey: "single-actor-test-1227" });
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FOR UPDATE") ? [current] : sql.trim().startsWith("UPDATE") ? [{ row_version: 3 }] : [] }));
});

describe.each(["facture", "avoir"] as const)("%s: explicit approval by the authorized creator", kind => {
  const validate = () => kind === "facture"
    ? repoValidateFacture({ factureId: 1, input: { decision: "APPROVE", expected_version: 2 }, actor, idempotencyKey: "single-actor-test-1227" })
    : repoValidateAvoir({ avoirId: 1, input: { decision: "APPROVE", expected_version: 2 }, actor, idempotencyKey: "single-actor-test-1227" });
  it("records the creator as approver with an audit and an idempotent receipt", async () => {
    await expect(validate()).resolves.toMatchObject({ status: "APPROVED", row_version: 3 });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("approved_by = CASE"), expect.arrayContaining(["APPROVED", 7]));
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ actor, eventType: kind === "facture" ? "FACTURE_APPROVE" : "AVOIR_APPROVE" }));
    expect(mocks.audit).toHaveBeenCalledOnce(); expect(mocks.receipt).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT");
  });
  it.each(["status", "version"])("does not bypass a conflicting %s", async conflict => {
    if (conflict === "status") current.statut = "DRAFT"; else current.row_version = 3;
    await expect(validate()).rejects.toMatchObject({ status: 409 });
    expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.receipt).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
  it("rolls back when the audit cannot be written", async () => {
    mocks.audit.mockRejectedValue(new Error("audit unavailable"));
    await expect(validate()).rejects.toThrow("audit unavailable");
    expect(mocks.receipt).not.toHaveBeenCalled(); expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
  it("returns the existing approval on replay without reapplying it", async () => {
    mocks.acquire.mockResolvedValue({ replay: { status: "APPROVED", row_version: 3 }, idempotencyKey: "single-actor-test-1227" });
    await expect(validate()).resolves.toMatchObject({ status: "APPROVED", idempotent_replay: true });
    expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
});

describe("Finance capabilities remain required", () => {
  it.each(["validate", "issue", "credit_issue"] as const)("refuses an unqualified operator for %s", async capability => {
    mocks.capabilities.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: [] });
    const next = vi.fn();
    requireFinanceCapability(capability)({ user: { id: 7, role: "Operateur" } } as Request, {} as Response, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403, code: "SENSITIVE_CAPABILITY_REQUIRED" })));
  });
});
