import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";

import { grantAccountModuleAccessToRequest } from "../../access-control/context/account-module-access.context";
import { validationErrorMiddleware } from "../../auth/middlewares/validationError.middleware";
import { errorHandler } from "../../../middlewares/errorHandler";

const service = vi.hoisted(() => ({
  getWorkshopPage: vi.fn(),
  getAllFiltered: vi.fn(),
  inventaireSet: vi.fn(),
}));

vi.mock("../services/outil.service", () => ({ outilService: service, outilSupportService: {} }));
vi.mock("../../auth/middlewares/auth.middleware", () => ({
  authenticateToken: ((req, res, next) => {
    const role = req.get("x-fixture-role");
    if (!role) return res.status(401).json({ code: "UNAUTHORIZED" });
    req.user = { id: 17, username: "fixture", role } as NonNullable<typeof req.user>;
    if (req.get("x-fixture-module-access") === "granted") {
      return grantAccountModuleAccessToRequest(req, { userId: 17, moduleKey: "outillage", elevated: false }, next);
    }
    next();
  }) as RequestHandler,
}));

import outilRoutes from "./outil.routes";

const app = express();
app.use(express.json());
app.use("/outils", outilRoutes);
app.use(validationErrorMiddleware);
app.use(errorHandler);

const filterDefaults = {
  page: 1, pageSize: 20, q: "", familyIds: [], geometryIds: [], manufacturerIds: [],
  stockStatuses: [], segment: "all", sortBy: "stock", sortDir: "desc", qMode: "literal", onlyInStock: false, diameter: "",
};

beforeEach(() => {
  vi.resetAllMocks();
  service.getWorkshopPage.mockResolvedValue({
    items: [{ id_outil: 42 }], total: 57, page: 1, pageSize: 20, criticalCount: 8,
    facets: { families: [{ id: 1, label: "Fraises", count: 57 }], geometries: [], manufacturers: [] },
  });
  service.getAllFiltered.mockResolvedValue([{ id_outil: 42 }]);
  service.inventaireSet.mockResolvedValue(undefined);
});

it("uses the module and operating permissions independently", async () => {
  await request(app).get("/outils/workshop-page").expect(401);
  await request(app).get("/outils/workshop-page").set("x-fixture-role", "Atelier").expect(403);
  expect(service.getWorkshopPage).not.toHaveBeenCalled();

  const readOnly = await request(app).get("/outils/workshop-page")
    .set("x-fixture-role", "Employé").set("x-fixture-module-access", "granted").expect(200);
  expect(readOnly.body).toMatchObject({ total: 57, page: 1, pageSize: 20, criticalCount: 8, permissions: { canOperate: false } });
  expect(readOnly.headers["cache-control"]).toBe("private, no-store");
  expect(service.getWorkshopPage).toHaveBeenLastCalledWith(filterDefaults);

  const operate = await request(app).get("/outils/workshop-page")
    .set("x-fixture-role", "Atelier").set("x-fixture-module-access", "granted").expect(200);
  expect(operate.body.permissions).toEqual({ canOperate: true });

  await request(app).post("/outils/inventaire/set").set("x-fixture-role", "Employé")
    .set("x-fixture-module-access", "granted").send({ id_outil: 42, new_qty: 0 }).expect(403);
  await request(app).post("/outils/inventaire/set").set("x-fixture-role", "Atelier")
    .set("x-fixture-module-access", "granted").send({ id_outil: 42, new_qty: 0 }).expect(200);
  expect(service.inventaireSet).toHaveBeenCalledOnce();
  expect(service.inventaireSet).toHaveBeenCalledWith(expect.objectContaining({ id_outil: 42, new_qty: 0 }));
});

it("normalizes the exact server-side query without changing the legacy listing contract", async () => {
  await request(app)
    .get("/outils/workshop-page")
    .query({
      page: "12", pageSize: "40", q: " Ébauche ", familyIds: "1,2,1", geometryIds: "3", manufacturerIds: "6",
      stockStatuses: "available,to-count,available", segment: "critical", sortBy: "outil", sortDir: "asc",
      qMode: "terms", onlyInStock: "true", diameter: " 6,35 ",
    })
    .set("x-fixture-role", "Atelier").set("x-fixture-module-access", "granted").expect(200);
  expect(service.getWorkshopPage).toHaveBeenCalledWith({
    page: 12, pageSize: 40, q: "Ébauche", familyIds: [1, 2], geometryIds: [3], manufacturerIds: [6],
    stockStatuses: ["available", "to-count"], segment: "critical", sortBy: "outil", sortDir: "asc",
    qMode: "terms", onlyInStock: true, diameter: "6.35",
  });

  const legacy = await request(app).get("/outils").query({ limit: "1000", offset: "500", only_in_stock: "true" }).expect(200);
  expect(legacy.body).toEqual([{ id_outil: 42 }]);
  expect(service.getAllFiltered).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000, offset: 500, only_in_stock: true }));
});

it.each([
  "page=0", "page=1.5", "pageSize=50", "pageSize=10&pageSize=40", "familyIds=1%2C0", "geometryIds=1%2C",
  "manufacturerIds=2147483648", "stockStatuses=missing", "segment=unknown", "sortBy=quantity", "sortDir=sideways",
  "onlyInStock=1", "qMode=or",
])("rejects %s before reaching the repository", async (query) => {
  await request(app).get("/outils/workshop-page?" + query)
    .set("x-fixture-role", "Atelier").set("x-fixture-module-access", "granted").expect(400);
  expect(service.getWorkshopPage).not.toHaveBeenCalled();
});
