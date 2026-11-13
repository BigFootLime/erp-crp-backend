import express, { Router } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { mountOrderedRouteGroup } from "../routes/route-mount-order";

describe("mountOrderedRouteGroup", () => {
  it("registers each collision-sensitive mount in its declared order", () => {
    const use = vi.fn();
    const first = {};
    const second = {};

    mountOrderedRouteGroup({ use } as never, [
      { prefix: "/shared", router: first as never },
      { prefix: "/shared", router: second as never },
    ]);

    expect(use.mock.calls).toEqual([
      ["/shared", first],
      ["/shared", second],
    ]);
  });

  it("keeps public routes before authentication and lets specialized routes win before a legacy guard", async () => {
    const app = express();
    const publicRoutes = Router();
    const specializedRoutes = Router();
    const legacyRoutes = Router();

    publicRoutes.get("/device", (_req, res) => res.json({ public: true }));
    specializedRoutes.get("/specialized", (_req, res) => res.json({ specialized: true }));
    legacyRoutes.use((_req, res) => res.status(403).json({ error: "legacy guard" }));

    app.use("/public", publicRoutes);
    app.use((req, res, next) => {
      if (req.get("x-fixture-auth") !== "authenticated") {
        res.status(401).json({ error: "authentication required" });
        return;
      }
      next();
    });
    app.use((req, res, next) => {
      if (req.get("x-fixture-module") !== "granted") {
        res.status(403).json({ error: "module denied" });
        return;
      }
      next();
    });
    mountOrderedRouteGroup(app, [
      { prefix: "/shared", router: specializedRoutes },
      { prefix: "/shared", router: legacyRoutes },
    ]);

    await request(app).get("/public/device").expect(200, { public: true });
    await request(app).get("/shared/specialized").expect(401, { error: "authentication required" });
    await request(app)
      .get("/shared/specialized")
      .set("x-fixture-auth", "authenticated")
      .expect(403, { error: "module denied" });
    await request(app)
      .get("/shared/specialized")
      .set("x-fixture-auth", "authenticated")
      .set("x-fixture-module", "granted")
      .expect(200, { specialized: true });
    await request(app)
      .get("/shared/legacy-only")
      .set("x-fixture-auth", "authenticated")
      .set("x-fixture-module", "granted")
      .expect(403, { error: "legacy guard" });
  });
});
