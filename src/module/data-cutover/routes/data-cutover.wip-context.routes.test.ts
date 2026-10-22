import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../../middlewares/errorHandler";

const mocks = vi.hoisted(() => ({ context: vi.fn() }));

vi.mock("../../auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const actor = req.get("X-Fixture-Actor");
    if (!actor) { res.status(401).json({ code: "UNAUTHORIZED" }); return; }
    req.user = { id: actor === "admin" ? 1 : 2, mfa: actor === "admin", mfa_verified_at: Math.floor(Date.now() / 1_000) } as Express.Request["user"];
    next();
  },
}));
vi.mock("../../access-control/services/access-control.service", () => ({ isSuperadmin: async (id: number) => id === 1 }));
vi.mock("../repository/data-cutover.repository", () => ({
  repoGetCutoverWipContext: mocks.context,
  repoIsCutoverInstalled: async () => true,
  repoIsCutoverApplicationInstalled: async () => true,
  repoCutoverFinancialStatus: async () => ({ status: "IDLE", emissions_suspended: false }),
  repoCutoverUnits: async () => [],
  repoCutoverArticleFamilies: async () => ({}),
  repoGetContributorDomains: async () => ["WIP"],
}));
vi.mock("../application/application.registry", () => ({ cutoverApplication: {} }));

import router from "./data-cutover.routes";

const batch = "10000000-0000-4000-8000-000000000001";
const row = "10000000-0000-4000-8000-000000000002";
const version = "10000000-0000-4000-8000-000000000003";
const app = express();
app.use("/api/v1/data-cutover", router);
app.use(errorHandler);
const endpoint = `/api/v1/data-cutover/batches/${batch}/rows/${row}/wip-context`;

describe("cutover WIP context route security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ article_ready: true, versions: [], selected_version: null, phases: [] });
  });

  it("requires an authenticated caller before it queries a WIP row", async () => {
    expect((await request(app).get(endpoint)).status).toBe(401);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("forwards only the server-derived contributor access and requested version", async () => {
    const response = await request(app).get(`${endpoint}?versionId=${version}`).set("X-Fixture-Actor", "contributor");
    expect(response.status).toBe(200);
    expect(mocks.context).toHaveBeenCalledWith(batch, row, version, { userId: 2, isSuperadmin: false }, undefined, undefined);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("rejects malformed IDs and unknown query keys without reaching the repository", async () => {
    for (const url of [
      `/api/v1/data-cutover/batches/not-a-uuid/rows/${row}/wip-context`,
      `${endpoint}?versionId=not-a-uuid`,
      `${endpoint}?versionId=${version}&isSuperadmin=true`,
      `${endpoint}?quantity=1e3`,
      `${endpoint}?quantity=10000000000`,
      `${endpoint}?orderId=0`,
    ]) {
      const response = await request(app).get(url).set("X-Fixture-Actor", "contributor");
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("CUTOVER_INVALID_INPUT");
    }
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("only accepts an explicit bounded decimal quantity for a contextual preview", async () => {
    const response = await request(app).get(`${endpoint}?quantity=12.500&orderId=42`).set("X-Fixture-Actor", "contributor");
    expect(response.status).toBe(200);
    expect(mocks.context).toHaveBeenCalledWith(batch, row, undefined, { userId: 2, isSuperadmin: false }, "12.500", "42");
  });

  it("keeps repository scope and mapping denials as ordinary errors, never as a session reset", async () => {
    const { HttpError } = await import("../../../utils/httpError");
    mocks.context.mockRejectedValueOnce(new HttpError(404, "CUTOVER_ROW_NOT_FOUND", "Fiche de reprise introuvable dans ce dossier."));
    const hidden = await request(app).get(endpoint).set("X-Fixture-Actor", "contributor");
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe("CUTOVER_ROW_NOT_FOUND");

    mocks.context.mockRejectedValueOnce(new HttpError(403, "CUTOVER_SUPERADMIN_MAPPING_REQUIRED", "Le SuperAdmin choisit la version technique rapprochée."));
    const forbidden = await request(app).get(`${endpoint}?versionId=${version}`).set("X-Fixture-Actor", "contributor");
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe("CUTOVER_SUPERADMIN_MAPPING_REQUIRED");
  });
});
