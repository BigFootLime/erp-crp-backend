import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../../middlewares/errorHandler";

const mocks = vi.hoisted(() => ({
  patch: vi.fn(), create: vi.fn(), preview: vi.fn(), validate: vi.fn(), export: vi.fn(), lookup: vi.fn(),
  applicationPreview: vi.fn(), apply: vi.fn(), applications: vi.fn(), openings: vi.fn(), evidence: vi.fn(), linkEvidence: vi.fn(),
  prepareWipDeliveryTarget: vi.fn(),
}));
vi.mock("../application/application.registry", () => ({ cutoverApplication: { preview: mocks.applicationPreview, apply: mocks.apply, list: mocks.applications } }));
vi.mock("../../auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const actor = req.get("X-Fixture-Actor");
    if (!actor) { res.status(401).json({ code: "UNAUTHORIZED" }); return; }
    req.user = { id: actor.startsWith("contributor") ? 2 : 1, mfa: actor !== "admin-no-mfa" && actor !== "contributor-no-mfa", mfa_verified_at: Math.floor(Date.now() / 1000) - (actor === "admin-stale-mfa" ? 1000 : 0) } as Express.Request["user"];
    next();
  },
}));
vi.mock("../../access-control/services/access-control.service", () => ({ isSuperadmin: async (id: number) => id === 1 }));
vi.mock("../repository/data-cutover.repository", () => ({
  repoPatchCutoverRow: mocks.patch, repoCreateCutoverBatch: mocks.create,
  repoPreviewCutover: mocks.preview, repoValidateCutover: mocks.validate,
  repoExportCutover: mocks.export, repoCutoverLookup: mocks.lookup,
  repoIsCutoverInstalled: async () => true,
  repoIsCutoverApplicationInstalled: async () => true,
  repoCutoverFinancialStatus: async () => ({ status: "PREPARING", emissions_suspended: true }),
  repoCutoverUnits: async () => [{ code: "u", label: "Pièce" }, { code: "kg", label: "Kilogramme" }],
  repoCutoverArticleFamilies: async () => ({ fabrique: ["PT"], achat: ["ACH"] }),
  repoGetContributorDomains: async () => ["OPENING_STOCK"],
  repoListCutoverOpenings: mocks.openings, repoListCutoverEvidence: mocks.evidence, repoLinkCutoverEvidence: mocks.linkEvidence,
  repoPrepareCutoverWipDeliveryTarget: mocks.prepareWipDeliveryTarget,
}));
import router from "./data-cutover.routes";

const batch = "10000000-0000-4000-8000-000000000001";
const row = "10000000-0000-4000-8000-000000000002";
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/v1/data-cutover", router);
app.use(errorHandler);
const endpoint = `/api/v1/data-cutover/batches/${batch}`;
const patch = (actor = "admin") => request(app).patch(`${endpoint}/rows/${row}`).set("X-Fixture-Actor", actor).set("Idempotency-Key", "fixture-update-1");

describe("cutover HTTP security and error contract", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.patch.mockResolvedValue({ row: { id: row, status: "MISSING", issues: [] }, batch_version: 2 }); });
  it("requires authentication before any preparation route", async () => {
    expect((await request(app).get(`${endpoint}/rows`)).status).toBe(401);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("publishes the native remainder strategy and only the contributor's field catalog", async () => {
    const response = await request(app).get("/api/v1/data-cutover/capabilities").set("X-Fixture-Actor", "contributor");
    expect(response.status).toBe(200);
    expect(response.body.strategy).toBe("NEW_NATIVE_REMAINDER");
    expect(response.body.posting_available).toBe(false);
    expect(response.body.can_validate).toBe(false);
    expect(response.body.numbering).toMatchObject({ active: false, affair_next: null, delivery_next: null, proposed_affair_next: 24000, proposed_delivery_next: 15000 });
    expect(response.body.domains.map((domain: { key: string }) => domain.key)).toEqual(["OPENING_STOCK"]);
    expect(response.body.domains[0].fields.find((field: { key: string }) => field.key === "unit")).toMatchObject({ type: "select", options: ["u", "kg"] });
    const adminResponse = await request(app).get("/api/v1/data-cutover/capabilities").set("X-Fixture-Actor", "admin");
    expect(adminResponse.body.financial_cutover).toEqual({ status: "PREPARING", emissions_suspended: true });
    expect(response.body.financial_cutover).toBeUndefined();
    expect(adminResponse.body.domains.find((domain: { key: string }) => domain.key === "ARTICLE").fields.find((field: { key: string }) => field.key === "familyCode")).toMatchObject({ type: "select", options_by_category: { fabrique: ["PT"], achat: ["ACH"] } });
  });
  it("requires SuperAdmin and current MFA for sensitive actions", async () => {
    for (const action of ["preview", "validate", "contributors", "application-preview", "apply"]) {
      expect((await request(app).post(`${endpoint}/${action}`).set("X-Fixture-Actor", "contributor").send({})).status).toBe(403);
    }
    expect((await patch("admin-no-mfa").send({})).status).toBe(403);
    const stale = await patch("admin-stale-mfa").send({});
    expect(stale.status).toBe(428);
    expect(stale.body.code).toBe("MFA_STEP_UP_REQUIRED");
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("prepares a WIP delivery target only for a SuperAdmin with fresh MFA and a strict idempotent payload", async () => {
    const path = `${endpoint}/rows/${row}/wip/prepare-delivery-target`;
    for (const actor of ["contributor", "admin-no-mfa", "admin-stale-mfa"]) {
      const response = await request(app).post(path).set("X-Fixture-Actor", actor).set("Idempotency-Key", "fixture-wip-target-1").send({ expected_version: 1, commande_ligne_id: "12" });
      expect(response.status).toBe(actor === "admin-stale-mfa" ? 428 : 403);
    }
    expect(mocks.prepareWipDeliveryTarget).not.toHaveBeenCalled();
    const invalid = await request(app).post(path).set("X-Fixture-Actor", "admin").set("Idempotency-Key", "fixture-wip-target-1").send({ expected_version: 1, commande_ligne_id: "12", quantity: 6 });
    expect(invalid.status).toBe(422);
    mocks.prepareWipDeliveryTarget.mockResolvedValueOnce({ row: { id: row, version: 2 }, batch_version: 2, target: { commande_ligne_id: "12", livraison_affaire_id: "42", quantity: 6 } });
    const accepted = await request(app).post(path).set("X-Fixture-Actor", "admin").set("Idempotency-Key", "fixture-wip-target-1").send({ expected_version: 1, commande_ligne_id: "12" });
    expect(accepted.status).toBe(200);
    expect(mocks.prepareWipDeliveryTarget).toHaveBeenCalledWith(batch, row, { expected_version: 1, commande_ligne_id: "12" }, 1, "fixture-wip-target-1");
  });
  it("keeps applications, openings and evidence private and requires fresh assurance", async () => {
    for (const action of ["applications", "openings", "evidence"]) {
      expect((await request(app).get(`${endpoint}/${action}`).set("X-Fixture-Actor", "contributor")).status).toBe(403);
      expect((await request(app).get(`${endpoint}/${action}`).set("X-Fixture-Actor", "admin-stale-mfa")).status).toBe(428);
    }
    const apply = request(app).post(`${endpoint}/apply`).set("X-Fixture-Actor", "admin").set("Idempotency-Key", "fixture-application-1");
    expect((await apply.send({ expected_version: 1, expected_preview_hash: "a".repeat(64), confirm: true, checkpoint: { backup_reference: "verified", scope_stopped: true, signoffs_complete: false, no_external_emissions: true } })).status).toBe(422);
    expect(mocks.apply).not.toHaveBeenCalled();
    const proof = request(app).post(`${endpoint}/rows/${row}/evidence`).set("X-Fixture-Actor", "admin").set("Idempotency-Key", "fixture-evidence-1");
    expect((await proof.send({ expected_version: 1, field_key: "priceEvidence", ged_document_id: "Z:/private.xlsx" })).status).toBe(422);
    expect(mocks.linkEvidence).not.toHaveBeenCalled();
  });
  it("does not expose global matching searches or evidence exports to contributors", async () => {
    expect((await request(app).get("/api/v1/data-cutover/lookups/CUSTOMER?search=fixture").set("X-Fixture-Actor", "contributor")).status).toBe(403);
    expect((await request(app).get(`${endpoint}/export`).set("X-Fixture-Actor", "contributor")).status).toBe(403);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it("requires fresh MFA before a SuperAdmin can export the complete private package", async () => {
    expect((await request(app).get(`${endpoint}/export`).set("X-Fixture-Actor", "admin-no-mfa")).status).toBe(403);
    const stale = await request(app).get(`${endpoint}/export`).set("X-Fixture-Actor", "admin-stale-mfa");
    expect(stale.status).toBe(428);
    expect(stale.body.code).toBe("MFA_STEP_UP_REQUIRED");
    expect(mocks.export).not.toHaveBeenCalled();
    mocks.export.mockResolvedValueOnce({ purpose: "PREPARATION_ONLY" });
    expect((await request(app).get(`${endpoint}/export`).set("X-Fixture-Actor", "admin")).status).toBe(200);
    expect(mocks.export).toHaveBeenCalledWith(batch);
  });
  it("rejects malformed, additional or nested fields as actionable validation errors", async () => {
    for (const body of [
      { expected_version: 0, values: {}, decision: "INCLUDE" },
      { expected_version: 1, values: { quantity: { sql: "DROP" } }, decision: "INCLUDE" },
      { expected_version: 1, values: {}, decision: "INCLUDE", is_superadmin: true },
      { expected_version: 1, values: { constructor: "override" }, decision: "INCLUDE" },
    ]) {
      const response = await patch().send(body);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("CUTOVER_INVALID_INPUT");
      expect(response.body.details.issues.length).toBeGreaterThan(0);
    }
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("normalizes an empty note and forwards the authenticated actor rather than caller roles", async () => {
    const response = await patch("contributor").send({ expected_version: 1, values: { articleReference: "00042", quantityCounted: "0" }, decision: "PENDING", review_note: null });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(mocks.patch).toHaveBeenCalledWith(batch, row, expect.objectContaining({ review_note: "", values: { articleReference: "00042", quantityCounted: "0" } }), { userId: 2, isSuperadmin: false }, "fixture-update-1");
  });
  it("lets an assigned employee without optional MFA complete their scoped preparation", async () => {
    const response = await patch("contributor-no-mfa").send({ expected_version: 1, values: { articleReference: "00042", quantityCounted: "0" }, decision: "PENDING" });
    expect(response.status).toBe(200);
    expect(mocks.patch).toHaveBeenCalledWith(batch, row, expect.anything(), { userId: 2, isSuperadmin: false }, "fixture-update-1");
    expect((await request(app).post(`${endpoint}/apply`).set("X-Fixture-Actor", "contributor-no-mfa").send({})).status).toBe(403);
  });
  it("keeps a conflict or dependency failure separate from session expiration", async () => {
    const { HttpError } = await import("../../../utils/httpError");
    mocks.patch.mockRejectedValueOnce(new HttpError(409, "CUTOVER_STALE_ROW", "Rechargez cette fiche."));
    const conflict = await patch().send({ expected_version: 1, values: {}, decision: "PENDING" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.message).toBe("Rechargez cette fiche.");
    mocks.patch.mockRejectedValueOnce(new Error("private-database-detail"));
    const failure = await patch().send({ expected_version: 1, values: {}, decision: "PENDING" });
    expect(failure.status).toBe(500);
    expect(JSON.stringify(failure.body)).not.toContain("private-database-detail");
    expect(failure.body.code).toBe("INTERNAL_ERROR");
  });
});
