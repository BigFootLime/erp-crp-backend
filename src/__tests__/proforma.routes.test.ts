import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), preview: vi.fn(), currentPreview: vi.fn(), create: vi.fn(), issue: vi.fn(), terms: vi.fn(), changes: vi.fn(), refresh: vi.fn(), cancel: vi.fn() }));
vi.mock("../module/facturation/services/proforma.service", () => ({
  svcListProformas: mocks.list, svcGetProforma: mocks.detail, svcPreviewProforma: mocks.preview,
  svcPreviewExistingProforma: mocks.currentPreview, svcCreateProforma: mocks.create, svcIssueProforma: mocks.issue,
  svcDecideDeliveryPrepaymentTerms: mocks.terms,
  svcPreviewProformaChanges: mocks.changes, svcRefreshProforma: mocks.refresh, svcCancelProforma: mocks.cancel,
}));
import router from "../module/facturation/routes/proforma.routes";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import { errorHandler } from "../middlewares/errorHandler";
import { HttpError } from "../utils/httpError";

const id = "10000000-0000-4000-8000-000000000001";
const body = { client_id: "CUSTOMER", affairs: [{ allocation_id: 12, billing_parts: [{ billed_client_id: "COMPANY-A", quantity: "100" }] }] };
function app(role = "Comptable", authenticated = true) {
  const application = express(); application.use(express.json());
  application.use(((req,_res,next) => { if(authenticated) req.user = { id: 7, username: "finance-recette", email: "recette@test.invalid", role }; req.requestId = "recipe-request"; next(); }) as RequestHandler);
  application.use("/proformas", router); application.use(validationErrorMiddleware); application.use(errorHandler); return application;
}
beforeEach(() => { for(const mock of Object.values(mocks)) mock.mockReset(); vi.spyOn(console,"error").mockImplementation(() => undefined); });

describe("proforma HTTP workflow permissions and typed boundaries", () => {
  it("requires authentication and Finance access", async () => {
    expect((await request(app("Employee",false)).get("/proformas")).status).toBe(401);
    expect((await request(app("Employee")).get("/proformas")).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("passes normalized filters to the read-only listing", async () => {
    mocks.list.mockResolvedValue({ items: [], total: 0 });
    expect((await request(app()).get("/proformas?client_id=CUSTOMER&page=2&pageSize=10")).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ q: "", client_id: "CUSTOMER", page: 2, pageSize: 10 });
  });
  it("does not allow unknown query properties or invalid source IDs", async () => {
    expect((await request(app()).get("/proformas?include_all_clients=true")).status).toBe(400);
    expect((await request(app()).post("/proformas/affaires/0/terms").send({ expected_version: 0, requirement: "NOT_REQUIRED", reason: "Conditions vérifiées", confirm: true })).status).toBe(400);
    expect(mocks.terms).not.toHaveBeenCalled();
  });
  it("prepares a preview using selected companies without receiving caller prices", async () => {
    mocks.preview.mockResolvedValue({ preview_hash: "a".repeat(64) });
    expect((await request(app()).post("/proformas/preview").send(body)).status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith({ ...body, currency: "EUR" });
    expect((await request(app()).post("/proformas/preview").send({ ...body, paid: true })).status).toBe(400);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });
  it("requires the confirmed preview hash before draft creation", async () => {
    expect((await request(app()).post("/proformas").send(body)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("preserves idempotency and actor context on creation/replay", async () => {
    mocks.create.mockResolvedValueOnce({ id, status: "DRAFT", idempotent_replay: false }).mockResolvedValueOnce({ id, status: "DRAFT", idempotent_replay: true });
    const first = await request(app()).post("/proformas").set("Idempotency-Key","recipe-proforma-create").send({ ...body, preview_hash: "a".repeat(64) });
    const replay = await request(app()).post("/proformas").set("Idempotency-Key","recipe-proforma-create").send({ ...body, preview_hash: "a".repeat(64) });
    expect(first.status).toBe(201); expect(replay.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "recipe-proforma-create", actor: { userId: 7, requestId: "recipe-request", path: "/proformas" } }));
  });
  it("keeps issuance on the existing qualified Finance capability", async () => {
    const confirmation = { expected_version: 1, preview_hash: "a".repeat(64), confirm: true };
    expect((await request(app("Secretaire")).post(`/proformas/${id}/issue`).send(confirmation)).status).toBe(403);
    mocks.issue.mockResolvedValue({ id, status: "ISSUED" });
    expect((await request(app()).post(`/proformas/${id}/issue`).set("Idempotency-Key","recipe-proforma-issue").send(confirmation)).status).toBe(200);
  });
  it("keeps conflicts actionable instead of hiding them as a server error", async () => {
    mocks.issue.mockRejectedValue(new HttpError(409,"PROFORMA_PREVIEW_CHANGED","Actualisez l'aperçu."));
    const reply = await request(app()).post(`/proformas/${id}/issue`).send({ expected_version: 1, preview_hash: "a".repeat(64), confirm: true });
    expect(reply.status).toBe(409); expect(reply.body.code).toBe("PROFORMA_PREVIEW_CHANGED");
  });
  it("historical terms start at version zero and need a confirmed reasoned decision", async () => {
    mocks.terms.mockResolvedValue({ allocation_id: 12, requirement: "NOT_REQUIRED", row_version: 1 });
    const result = await request(app()).post("/proformas/affaires/12/terms").set("Idempotency-Key","recipe-terms-decision").send({ expected_version: 0, requirement: "NOT_REQUIRED", reason: "Conditions client vérifiées", confirm: true });
    expect(result.status).toBe(200); expect(mocks.terms).toHaveBeenCalledWith(expect.objectContaining({ allocationId: 12, input: expect.objectContaining({ expected_version: 0 }) }));
  });
  it("previews a selected distribution for the existing draft without writing it", async () => {
    mocks.changes.mockResolvedValue({ preview_hash: "a".repeat(64) });
    expect((await request(app()).post(`/proformas/${id}/preview`).send(body)).status).toBe(200);
    expect(mocks.changes).toHaveBeenCalledWith(id, { ...body, currency: "EUR" });
  });
  it("preserves version, confirmed preview and idempotency during refresh", async () => {
    mocks.refresh.mockResolvedValue({ id, status: "DRAFT", row_version: 2 });
    const input = { ...body, expected_version: 1, preview_hash: "a".repeat(64), confirm: true };
    expect((await request(app()).post(`/proformas/${id}/refresh`).set("Idempotency-Key","qualification-refresh").send(input)).status).toBe(200);
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ id, idempotencyKey: "qualification-refresh", input: { ...input, currency: "EUR" } }));
    expect((await request(app()).post(`/proformas/${id}/refresh`).send({ ...input, confirm: false })).status).toBe(400);
  });
  it("keeps cancellation on qualified Finance rights and requires its reason", async () => {
    const input = { expected_version: 2, reason: "Commande annulée", confirm: true };
    expect((await request(app("Secretaire")).post(`/proformas/${id}/cancel`).send(input)).status).toBe(403);
    expect((await request(app()).post(`/proformas/${id}/cancel`).send({ ...input, reason: "" })).status).toBe(400);
    mocks.cancel.mockResolvedValue({ id, status: "CANCELLED", row_version: 3 });
    expect((await request(app()).post(`/proformas/${id}/cancel`).set("Idempotency-Key","qualification-cancel").send(input)).status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ id, idempotencyKey: "qualification-cancel", input }));
  });
});
