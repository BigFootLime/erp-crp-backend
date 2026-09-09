import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { HttpError } from "../../utils/httpError";
const m = vi.hoisted(() => ({
  device: vi.fn(),
  session: vi.fn(),
  admin: vi.fn(),
  dossier: vi.fn(),
  scope: vi.fn(),
  documents: vi.fn(),
  start: vi.fn(),
  query: vi.fn(),
  revokePin: vi.fn(),
}));
vi.mock("../../config/database", () => ({
  default: { query: m.query, connect: vi.fn() },
}));
vi.mock("./repository/terminal-auth.repository", () => ({
  findTerminal: m.device,
  revokePin: m.revokePin,
}));
vi.mock("./services/terminal-auth.service", () => ({
  authenticateTerminalSession: m.session,
  assertTerminalAdmin: m.admin,
  requireModule: vi.fn(),
  identifyTerminal: vi.fn(),
}));
vi.mock("./services/terminal-operator.service", () => ({
  operatorDossier: m.dossier,
  assertStartAllowed: vi.fn(),
  assertPointageScope: vi.fn(),
  resolveOperatorScan: vi.fn(),
}));
vi.mock("./repository/terminal-dossier.repository", () => ({
  operationContext: m.scope,
  dossierDocuments: m.documents,
}));
vi.mock("../production/services/production-execution.service", () => ({
  svcStartExecution: m.start,
}));
vi.mock("../auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("Authorization") !== "Bearer erp-admin")
      return next(new HttpError(401, "JWT_REQUIRED", "ERP login required"));
    req.user = { id: 1, role: "Administrateur", username: "admin", email: "" };
    next();
  },
}));
vi.mock("../access-control/context/account-module-access.context", () => ({
  grantAccountModuleAccessToRequest: (
    _req: unknown,
    _scope: unknown,
    next: express.NextFunction,
  ) => next(),
}));
import router from "./routes/terminals.routes";
const app = express();
app.use(express.json());
app.use("/terminals", router);
app.use((_req, res) => res.status(200).json({ generalErpFallback: true }));
app.use(
  (
    err: Error & { status?: number; code?: string; issues?: unknown[] },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) =>
    res
      .status(err.status ?? (err.issues ? 422 : 500))
      .json({ code: err.code, message: err.message }),
);
const token = "a".repeat(43),
  operation = "11111111-1111-4111-8111-111111111111",
  machine = "22222222-2222-4222-8222-222222222222";
const endpoint = `/terminals/operator/ofs/12/operations/${operation}`;
const headers = {
  "X-Terminal-Device": token,
  "X-Station-Session": "operator-session",
};
beforeEach(() => {
  vi.clearAllMocks();
  m.admin.mockResolvedValue(undefined);
  vi.stubEnv("CERP_ANDROID_TERMINALS_ENABLED", "true");
  m.device.mockResolvedValue({
    id: "terminal",
    device_id: "device",
    kind: "OPERATOR",
    machine_id: machine,
  });
  m.session.mockResolvedValue({
    session_id: "session",
    user: { id: 7, role: "Opérateur", username: "op" },
    machine_id: machine,
  });
  m.dossier.mockResolvedValue({
    scope: { of_id: 12, operation_id: operation },
    autocontrols: [],
  });
  m.scope.mockResolvedValue({});
  m.documents.mockResolvedValue([]);
  m.start.mockResolvedValue({ id: "execution" });
});
afterEach(() => vi.unstubAllEnvs());
describe("native terminal HTTP boundary", () => {
  it("routes PIN revocation before the parameterized device revocation", async () => {
    const result = await request(app).post('/terminals/admin/pins/revoke')
      .set('Authorization', 'Bearer erp-admin').send({ site_code: 'QA', user_id: 7 });
    expect(result.status).toBe(200);
    expect(m.revokePin).toHaveBeenCalledWith('QA', 7, 1);
  });
  it("defaults to unavailable before enabling the pilot", async () => {
    vi.stubEnv("CERP_ANDROID_TERMINALS_ENABLED", "");
    expect((await request(app).get(endpoint).set(headers)).status).toBe(503);
    expect(m.device).not.toHaveBeenCalled();
  });
  it("rejects ERP JWT alone on a terminal dossier", async () => {
    expect(
      (
        await request(app)
          .get(endpoint)
          .set("Authorization", "Bearer erp-admin")
      ).status,
    ).toBe(401);
    expect(m.dossier).not.toHaveBeenCalled();
  });
  it("rejects an unknown or revoked terminal before reading any OF", async () => {
    m.device.mockRejectedValue(new HttpError(401, "REVOKED", "revoked"));
    expect((await request(app).get(endpoint).set(headers)).status).toBe(401);
    expect(m.session).not.toHaveBeenCalled();
    expect(m.dossier).not.toHaveBeenCalled();
  });
  it("requires a separate operator session after device pairing", async () => {
    expect(
      (await request(app).get(endpoint).set("X-Terminal-Device", token)).status,
    ).toBe(401);
    expect(m.dossier).not.toHaveBeenCalled();
  });
  it("rejects another tablet session before reading the dossier", async () => {
    m.session.mockRejectedValue(
      new HttpError(403, "TERMINAL_SESSION_DEVICE", "wrong device"),
    );
    expect((await request(app).get(endpoint).set(headers)).status).toBe(403);
    expect(m.dossier).not.toHaveBeenCalled();
  });
  it("isolates future stock terminal kinds", async () => {
    m.device.mockResolvedValue({ kind: "TOOLING" });
    expect((await request(app).get(endpoint).set(headers)).status).toBe(403);
    expect(m.dossier).not.toHaveBeenCalled();
  });
  it("never grants terminal credentials access to administration", async () => {
    expect(
      (await request(app).get("/terminals/admin").set(headers)).status,
    ).toBe(401);
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("does not fall through to general ERP routes", async () => {
    const r = await request(app)
      .post("/terminals/qualite/release")
      .set(headers)
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.generalErpFallback).toBeUndefined();
  });
  it("rejects a document absent from the OF manifest", async () => {
    const r = await request(app)
      .get(endpoint + "/documents/" + machine)
      .set(headers);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("TERMINAL_DOCUMENT_OUTSIDE_SCOPE");
  });
  it("derives the author and machine from verified context", async () => {
    const r = await request(app)
      .post(endpoint + "/start")
      .set(headers)
      .set("Idempotency-Key", operation)
      .send({ activity_code: "SETUP", planning_version: "version" });
    expect(r.status).toBe(200);
    expect(m.start.mock.calls[0][0]).toMatchObject({
      actor: { id: 7 },
      body: { machine_id: machine, of_id: 12, operation_id: operation },
    });
  });
  it("rejects injected operator or machine identifiers", async () => {
    const r = await request(app)
      .post(endpoint + "/start")
      .set(headers)
      .set("Idempotency-Key", operation)
      .send({
        activity_code: "SETUP",
        planning_version: "version",
        operator_user_id: 8,
        machine_id: operation,
      });
    expect(r.status).toBe(422);
    expect(m.start).not.toHaveBeenCalled();
  });
  it("marks OF responses as private to the active session", async () => {
    const r = await request(app).get(endpoint).set(headers);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
  });
});
