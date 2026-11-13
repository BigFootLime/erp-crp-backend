import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listOperators: vi.fn((_req: Request, res: Response) => res.json({ consumer: "production" })),
  qualiteDashboard: vi.fn((_req: Request, res: Response) => res.json({ consumer: "quality" })),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    if (req.get("x-fixture-auth") !== "authenticated") {
      res.status(401).json({ error: "Token manquant ou invalide" });
      return;
    }
    req.user = {
      id: 1515,
      username: "u12-fixture",
      email: "u12-fixture@example.test",
      role: req.get("x-fixture-role") ?? "Employé",
    };
    next();
  },
}));

vi.mock("../module/production/controllers/pointages.controller", async (importOriginal) => ({
  ...await importOriginal<typeof import("../module/production/controllers/pointages.controller")>(),
  listOperators: mocks.listOperators,
}));

vi.mock("../module/qualite/controllers/qualite.controller", async (importOriginal) => ({
  ...await importOriginal<typeof import("../module/qualite/controllers/qualite.controller")>(),
  qualiteDashboard: mocks.qualiteDashboard,
}));

import productionRoutes from "../module/production/routes/production.routes";
import qualityRoutes from "../module/qualite/routes/qualite.routes";
import { grantAccountModuleAccessToRequest } from "../module/access-control/context/account-module-access.context";

function appFor(moduleKey: "production" | "quality") {
  const app = express();
  app.use((req, _res, next) => {
    if (req.get("x-fixture-module-grant") !== "delegated") {
      next();
      return;
    }
    grantAccountModuleAccessToRequest(req, { userId: 1515, moduleKey, elevated: true }, next);
  });
  app.use(moduleKey === "production" ? "/production" : "/qualite", moduleKey === "production" ? productionRoutes : qualityRoutes);
  return app;
}

beforeEach(() => {
  mocks.listOperators.mockClear();
  mocks.qualiteDashboard.mockClear();
});

describe("U12 legacy-role consumers", () => {
  it.each([
    ["production", "/production/operators", "Production", "production"],
    ["quality", "/qualite/dashboard", "Responsable Qualité", "quality"],
  ] as const)("keeps %s anonymous, denied, role and delegated-account outcomes distinct", async (moduleKey, path, allowedRole, consumer) => {
    const app = appFor(moduleKey);

    await request(app).get(path).expect(401, { error: "Token manquant ou invalide" });
    await request(app)
      .get(path)
      .set("x-fixture-auth", "authenticated")
      .set("x-fixture-role", "Employé")
      .expect(403);
    await request(app)
      .get(path)
      .set("x-fixture-auth", "authenticated")
      .set("x-fixture-role", allowedRole)
      .expect(200, { consumer });
    await request(app)
      .get(path)
      .set("x-fixture-auth", "authenticated")
      .set("x-fixture-role", "Employé")
      .set("x-fixture-module-grant", "delegated")
      .expect(200, { consumer });
  });
});
