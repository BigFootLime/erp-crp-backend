import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCatalogue: vi.fn<RequestHandler>((_req, res) => { res.json({ schemaVersion: 1 }); }),
  getCatalogueAsset: vi.fn<RequestHandler>((_req, res) => { res.type("image/jpeg").send("asset"); }),
}));

vi.mock("../../auth/middlewares/auth.middleware", () => ({
  authenticateToken: ((req, res, next) => req.get("x-test-auth") === "yes"
    ? next()
    : res.status(401).json({ code: "UNAUTHORIZED" })) as RequestHandler,
}));
vi.mock("../controllers/outillage-lifecycle.controller", () => ({
  requireOutillageCapability: (capability: string): RequestHandler => (req, res, next) => req.get(`x-test-${capability}`) === "yes"
    ? next()
    : res.status(403).json({ code: "OUTILLAGE_CAPABILITY_FORBIDDEN" }),
  createToolParameterVersion: vi.fn(),
  getToolLifecycle: vi.fn(),
  listAllocations: vi.fn(),
  reserveTool: vi.fn(),
  transitionAllocation: vi.fn(),
}));
vi.mock("../controllers/outil-catalogue.controller", () => mocks);
vi.mock("../controllers/outil.controller", () => ({
  outilController: new Proxy({}, { get: () => (_req: unknown, res: { json: (value: unknown) => void }) => res.json({}) }),
  outilSupportController: new Proxy({}, { get: () => (_req: unknown, res: { json: (value: unknown) => void }) => res.json({}) }),
}));
vi.mock("../utils/outillage-upload", () => {
  const pass = (): RequestHandler => (_req, _res, next) => next();
  return {
    outillageFabricantUpload: { single: pass }, outillageFamilleUpload: { single: pass },
    outillageGeometrieUpload: { single: pass }, outillageToolUpload: { fields: pass },
  };
});

import outilRoutes from "./outil.routes";

describe("private tool catalogue routes", () => {
  const app = express();
  app.use("/outils", outilRoutes);

  beforeEach(() => vi.clearAllMocks());

  it("requires authentication and Outillage read capability before returning a bundle", async () => {
    await request(app).get("/outils/catalogue").expect(401);
    await request(app).get("/outils/catalogue").set("x-test-auth", "yes").expect(403);
    await request(app).get("/outils/catalogue").set("x-test-auth", "yes").set("x-test-read", "yes").expect(200);
    expect(mocks.getCatalogue).toHaveBeenCalledOnce();
  });

  it.each([
    ["post", "/outils"],
    ["patch", "/outils/1"],
    ["delete", "/outils/1"],
    ["post", "/outils/familles"],
    ["patch", "/outils/familles/1"],
    ["post", "/outils/fabricants"],
    ["patch", "/outils/fabricants/1"],
    ["post", "/outils/fournisseurs"],
    ["patch", "/outils/fournisseurs/1"],
    ["post", "/outils/geometries"],
    ["patch", "/outils/geometries/1"],
    ["post", "/outils/revetements"],
  ] as const)("keeps a read-only user from configure mutation %s %s", async (method, url) => {
    await request(app)[method](url)
      .set("x-test-auth", "yes")
      .set("x-test-read", "yes")
      .send({})
      .expect(403);

    await request(app)[method](url)
      .set("x-test-auth", "yes")
      .set("x-test-configure", "yes")
      .send({})
      .expect(200);
  });

  it("protects private asset bytes with the same read capability", async () => {
    await request(app).get("/outils/catalogue/assets/page.jpg").set("x-test-auth", "yes").expect(403);
    await request(app).get("/outils/catalogue/assets/page.jpg").set("x-test-auth", "yes").set("x-test-read", "yes").expect(200);
    expect(mocks.getCatalogueAsset).toHaveBeenCalledOnce();
  });

  it.each([
    "/outils/sortie",
    "/outils/retour",
    "/outils/reapprovisionner",
    "/outils/scan/sortie",
    "/outils/scan/entree",
    "/outils/inventaire/set",
  ])("requires operate capability for stock mutation %s", async (url) => {
    await request(app).post(url).set("x-test-auth", "yes").set("x-test-read", "yes").send({}).expect(403);
    await request(app).post(url).set("x-test-auth", "yes").set("x-test-operate", "yes").send({}).expect(200);
  });
});
