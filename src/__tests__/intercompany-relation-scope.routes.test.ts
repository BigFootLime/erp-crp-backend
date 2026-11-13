import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ids = { company: "11111111-1111-4111-8111-111111111111", peer: "22222222-2222-4222-8222-222222222222", relation: "33333333-3333-4333-8333-333333333333", approver: "44444444-4444-4444-8444-444444444444", supplier: "55555555-5555-4555-8555-555555555555" };
const mocks = vi.hoisted(() => ({ access: vi.fn(), view: vi.fn(), query: vi.fn(), tx: vi.fn(), release: vi.fn(), outbox: vi.fn() }));
vi.mock("../config/database", () => ({ default: { query: mocks.query, connect: async () => ({ query: mocks.tx, release: mocks.release }) } }));
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: ((req, res, next) => {
    if (!req.headers.authorization) { res.sendStatus(401); return; }
    req.user = { id: 42, username: "fixture", email: "fixture@example.test", role: "Administrateur" }; next();
  }) as RequestHandler,
  authorizeRole: () => ((_req, _res, next) => next()) as RequestHandler,
}));
vi.mock("../module/entreprises/runtime/company-runtime.service", () => ({ companyRuntimeService: { access: mocks.access, view: mocks.view } }));
vi.mock("../module/entreprises/runtime/company-runtime.config", () => ({ companyRuntimeConfiguration: () => ({ enabled: true, environment: "cerp_test" }) }));
vi.mock("../module/entreprises/intercompany/intercompany-outbox.repository", () => ({ enqueueIntercompanyMessageTx: mocks.outbox }));
import clientRoutes from "../module/client/routes/client.routes";
import supplierRoutes from "../module/fournisseurs/routes/fournisseurs.routes";

function context(profile = "INDUSTRIAL", modules = ["clients", "parametrage-erp"]) {
  mocks.access.mockResolvedValue({ context: { company_id: ids.company, profile, module_keys: modules } });
}
const app = express();
app.use(express.json());
app.use("/api/v1/clients", clientRoutes);
app.use("/api/v1/fournisseurs", supplierRoutes);
app.use(((error, _req, res, _next) => res.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ code: error.code })) as ErrorRequestHandler);
const auth = { Authorization: "Bearer disposable-fixture" };

beforeEach(() => {
  vi.resetAllMocks(); context();
  mocks.view.mockResolvedValue({ available_companies: [{ id: ids.peer, name: "Fixture", profile: "COMMERCIAL" }] });
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.tx.mockImplementation(async (sql: string) => ({ rows: sql.includes("FROM public.intercompany_relation_proposals")
    ? [{ buyer_company_id: ids.peer, supplier_company_id: ids.company, source_company_id: ids.peer, currency: "EUR", proposed_role: "SUPPLIER" }]
    : sql.includes("RETURNING id::text,status") ? [{ id: ids.relation, status: "PENDING_PEER" }] : [] }));
});

describe("Native company relation configuration routes", () => {
  it("requires authentication before exposing industrial options", async () => {
    expect((await request(app).get("/api/v1/clients/intercompany/relations/options")).status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([
    ["INDUSTRIAL", ["clients", "parametrage-erp"], "clients"],
    ["COMMERCIAL", ["fournisseurs", "parametrage-erp"], "fournisseurs"],
  ])("uses the native %s module without requiring the opposite module", async (profile, modules, route) => {
    context(profile as string, modules as string[]);
    const response = await request(app).get(`/api/v1/${route}/intercompany/relations/options`).set(auth);
    expect(response.status).toBe(200); expect(response.body.companies[0].id).toBe(ids.peer);
  });
  it.each([
    ["INDUSTRIAL", ["clients"]], ["INDUSTRIAL", ["parametrage-erp", "fournisseurs"]],
    ["COMMERCIAL", ["parametrage-erp", "fournisseurs"]],
  ])("denies missing or mismatched industrial module scope (%s, %j)", async (profile, modules) => {
    context(profile as string, modules as string[]);
    expect((await request(app).get("/api/v1/clients/intercompany/relations/options").set(auth)).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("lists proposals only for the current company and environment", async () => {
    expect((await request(app).get("/api/v1/clients/intercompany/relations/proposals").set(auth)).status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("destination_company_id=$1::uuid AND environment=$2"), [ids.company, "cerp_test"]);
  });
  it("accepts an industrial proposal atomically with the local client and approvers", async () => {
    const response = await request(app).post("/api/v1/clients/intercompany/relations/accept").set(auth)
      .send({ relation_id: ids.relation, local_customer_id: "CLI-42", approval_profile_ids: [ids.approver] });
    expect(response.status).toBe(200); expect(response.body.status).toBe("ACTIVE");
    expect(mocks.tx).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), [ids.relation, ids.company, "cerp_test"]);
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "RELATION_ACCEPTED", destination_company_id: ids.peer }));
    expect(mocks.tx).toHaveBeenLastCalledWith("COMMIT"); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("requires approvers before creating an industrial supplier relation", async () => {
    const response = await request(app).post("/api/v1/clients/intercompany/relations").set(auth)
      .send({ counterparty_company_id: ids.peer, local_customer_id: "CLI-42", approval_profile_ids: [] });
    expect(response.status).toBe(400); expect(mocks.outbox).not.toHaveBeenCalled();
    expect(mocks.tx).not.toHaveBeenCalledWith("BEGIN");
  });
  it("allows a commercial buyer to create its relation without supplier-side approvers", async () => {
    context("COMMERCIAL", ["fournisseurs", "parametrage-erp"]);
    const response = await request(app).post("/api/v1/fournisseurs/intercompany/relations").set(auth)
      .send({ counterparty_company_id: ids.peer, local_supplier_id: ids.supplier, approval_profile_ids: [] });
    expect(response.status).toBe(201); expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "RELATION_PROPOSED" }));
    expect(mocks.tx).toHaveBeenLastCalledWith("COMMIT");
  });
});
